// Observed execution facts only. The coordinator decides whether the work is correct.
export const SUPERVISION_LIMIT = 2
export const REPEATED_ERROR_LIMIT = 3
export const EXECUTION_BUDGET = Object.freeze({ requests: 80, outputTokens: 40000, contextTokens: 100000, maxOutputTokens: 8192 })
export const SUPERVISION_POLICY = Object.freeze({ correctionLimit: SUPERVISION_LIMIT, repeatedErrorLimit: REPEATED_ERROR_LIMIT, ...EXECUTION_BUDGET })

export function startSupervision(task, now, timeoutMs) {
  const previous = task.supervision
  task.supervision = { used: 0, attempt: task.attempts, limit: SUPERVISION_LIMIT, pending: null,
    lastCorrection: previous?.lastCorrection ?? null, startedAt: now, deadlineAt: now + timeoutMs,
    idleMs: Math.min(10 * 60_000, timeoutMs / 2), wrapUpAt: now + timeoutMs - Math.min(5 * 60_000, timeoutMs / 5),
    wrapUpRequestedAt: null,
    lastProgressAt: now, failure: null, checkpoint: null, activity: { kind: 'waiting_model', at: now },
    limits: { ...EXECUTION_BUDGET }, notices: {},
    metrics: { requests: 0, inputTokens: 0, outputTokens: 0, contextTokens: 0 }, evidence: [] }
  return task.supervision
}

function once(state, code, reason, now) {
  if (state.notices[code]) return null
  state.notices[code] = now
  return { code, reason, evidence: [] }
}

export function observeUsage(task, event, now) {
  const state = task.supervision, usage = event.data?.usage
  if (!state || !usage || event.seq !== undefined && event.seq === state.lastUsageSeq) return null
  if (event.seq !== undefined) state.lastUsageSeq = event.seq
  const tokens = value => Number.isFinite(value) && value > 0 ? value : 0
  const input = tokens(usage.inputTokens) + tokens(usage.cacheReadTokens)
  state.metrics.inputTokens += input
  state.metrics.outputTokens += tokens(usage.outputTokens)
  state.metrics.contextTokens = input
  state.activity = { kind: 'waiting_tool', at: now }
  if (state.metrics.outputTokens >= state.limits.outputTokens * 0.8) return once(state, 'OUTPUT_BUDGET', '输出 Token 即将达到本次执行预算，请收敛调查、检查阶段成果并准备正式报告。', now)
  if (input >= state.limits.contextTokens) return once(state, 'CONTEXT_BUDGET', `当前请求上下文约 ${input} Token，已达到预警线。请核对阶段结论，缩小后续读取范围，必要时提交未完成项。`, now)
  return null
}

export function observeRequest(task, now) {
  const state = task.supervision
  if (!state) return null
  state.metrics.requests++
  state.activity = { kind: 'waiting_model_response', at: now }
  return state.metrics.requests >= state.limits.requests * 0.75
    ? once(state, 'REQUEST_BUDGET', '模型调用次数即将达到本次执行预算，请检查有效成果，纠正方向或准备正式报告。', now) : null
}

export function budgetExceeded(task) {
  const state = task.supervision
  if (!state) return false
  return state.metrics.requests >= state.limits.requests || state.metrics.outputTokens >= state.limits.outputTokens
}

export function observeTool(task, exec, result, now) {
  const state = task.supervision
  if (!state || exec.name.startsWith('delegation_')) return null
  if (typeof exec.callId === 'string' && state.evidence.some(item => item.callId === exec.callId)) return null
  const text = (result.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
  const exitCode = result.value?.exitCode ?? Number(text.match(/\[exit code: (\d+)\]/)?.[1] ?? 0)
  const failed = Boolean(result.isError || exitCode !== 0)
  state.activity = { kind: 'waiting_model', at: now, tool: exec.name }
  const evidence = { callId: exec.callId, tool: exec.name, at: now, failed }
  if (typeof exec.callId === 'string') state.evidence = [...state.evidence, evidence].slice(-16)
  if (!failed) {
    state.failure = null
    if (['write', 'edit', 'apply_patch'].includes(exec.name) || ['pwsh', 'bash'].includes(exec.name) && result.value?.exitCode === 0) {
      state.lastProgressAt = now
      state.lastProgress = { ...evidence, kind: ['pwsh', 'bash'].includes(exec.name) ? 'command_result' : 'file_change',
        summary: ['pwsh', 'bash'].includes(exec.name) ? '前台命令已返回退出码 0，正确性尚待核实' : '文件修改工具已返回，尚待验证' }
    }
    return null
  }
  const reason = (text.trim().split('\n')[0] || `工具返回错误${exitCode ? '，退出码 ' + exitCode : ''}`).slice(0, 600)
  const key = exec.name + '\n' + reason
  const count = state.failure?.key === key ? state.failure.count + 1 : 1
  state.failure = { key, count, tool: exec.name, reason, at: now, callId: exec.callId }
  return count >= REPEATED_ERROR_LIMIT
    ? { code: 'REPEATED_TOOL_ERROR', reason: `${exec.name} 同类错误已出现 ${count} 次：${reason}`, evidence: exec.callId ? [exec.callId] : [] } : null
}
