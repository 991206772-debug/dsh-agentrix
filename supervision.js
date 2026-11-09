// Observed execution facts only. The coordinator decides whether the work is correct.
export const SUPERVISION_LIMIT = 2
export const REPEATED_ERROR_LIMIT = 3
export const EXECUTION_BUDGET = Object.freeze({ requests: null, requestNotice: 80, outputTokens: null, contextTokens: null, maxOutputTokens: null })
export const SUPERVISION_POLICY = Object.freeze({ correctionLimit: SUPERVISION_LIMIT, repeatedErrorLimit: REPEATED_ERROR_LIMIT, version: 2, timeMode: 'notice', ...EXECUTION_BUDGET })

export function startSupervision(task, now, timeoutMs) {
  const previous = task.supervision
  task.supervision = { used: 0, attempt: task.attempts, limit: SUPERVISION_LIMIT, pending: null,
    lastCorrection: previous?.lastCorrection ?? null, startedAt: now, deadlineAt: null, remindAt: now + timeoutMs, lastActivityAt: now,
    idleMs: 10 * 60_000,
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
  state.lastActivityAt = now
  state.activity = { kind: 'waiting_tool', at: now }
  return null
}

export function observeRequest(task, now) {
  const state = task.supervision
  if (!state) return null
  state.metrics.requests++
  state.lastActivityAt = now
  state.activity = { kind: 'waiting_model_response', at: now }
  return state.metrics.requests >= state.limits.requestNotice
    ? once(state, 'REQUEST_VOLUME', '模型调用已达到 80 次；仅提醒，原代理继续执行。', now) : null
}


export function observeTool(task, exec, result, now) {
  const state = task.supervision
  if (!state || exec.name.startsWith('delegation_')) return null
  if (typeof exec.callId === 'string' && state.evidence.some(item => item.callId === exec.callId)) return null
  const text = (result.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
  const exitCode = result.value?.exitCode ?? Number(text.match(/\[exit code: (\d+)\]/)?.[1] ?? 0)
  const failed = Boolean(result.isError || exitCode !== 0)
  state.lastActivityAt = now
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
