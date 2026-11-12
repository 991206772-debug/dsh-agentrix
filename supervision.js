import { createHash } from 'node:crypto'

// Observed execution facts only. The coordinator decides whether the work is correct.
export const SUPERVISION_LIMIT = 2
export const REPEATED_ERROR_LIMIT = 3
export const EXECUTION_BUDGET = Object.freeze({ requests: null, requestNotice: 80, outputTokens: null, contextTokens: null, maxOutputTokens: null })
const OBSERVATION_WINDOW = 8
const REPEATED_OBSERVATION_NOTICE = 3
export const SUPERVISION_POLICY = Object.freeze({ correctionLimit: SUPERVISION_LIMIT, repeatedErrorLimit: REPEATED_ERROR_LIMIT, version: 4, timeMode: 'notice', progressMode: 'evidence', ...EXECUTION_BUDGET })

export function startSupervision(task, now, timeoutMs) {
  const previous = task.supervision
  task.supervision = { used: 0, attempt: task.attempts, limit: SUPERVISION_LIMIT, pending: null,
    lastCorrection: previous?.lastCorrection ?? null, startedAt: now, deadlineAt: null, remindAt: now + timeoutMs, lastActivityAt: now,
    idleMs: 10 * 60_000,
    lastProgressAt: now, failure: null, checkpoint: null, recentObservations: [], activity: { kind: 'waiting_model', at: now },
    limits: { ...EXECUTION_BUDGET }, notices: {},
    metrics: { requests: 0, inputTokens: 0, outputTokens: 0, contextTokens: 0 }, evidence: [], evidenceIndex: {} }
  return task.supervision
}

function once(state, code, reason, now) {
  if (state.notices[code]) return null
  state.notices[code] = now
  return { code, reason, evidence: [] }
}

function stableArguments(value) {
  if (Array.isArray(value)) return value.map(stableArguments)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableArguments(value[key])]))
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
  const index = state.evidenceIndex ??= Object.fromEntries((state.evidence ?? []).map(item => [item.callId, item]))
  if (typeof exec.callId === 'string' && Object.hasOwn(index, exec.callId)) return null
  const text = (result.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
  const exitCode = result.value?.exitCode ?? Number(text.match(/\[exit code: (\d+)\]/)?.[1] ?? 0)
  const failed = Boolean(result.isError || exitCode !== 0)
  state.lastActivityAt = now
  state.activity = { kind: 'waiting_model', at: now, tool: exec.name }
  const evidence = { callId: exec.callId, tool: exec.name, at: now, failed }
  if (typeof exec.callId === 'string') {
    Object.defineProperty(index, exec.callId, { value: evidence, enumerable: true, configurable: true, writable: true })
    state.evidence = [...state.evidence, evidence].slice(-16)
  }
  if (!failed) {
    state.failure = null
    const mutation = ['write', 'edit', 'apply_patch'].includes(exec.name)
    const signature = exec.arguments == null ? null : createHash('sha256').update(JSON.stringify([exec.name, stableArguments(exec.arguments),
      text || result.value || null])).digest('hex')
    if (mutation) state.recentObservations = []
    const previous = state.recentObservations ?? []
    const matches = signature ? previous.filter(item => item.signature === signature) : []
    if (signature) state.recentObservations = [...previous, { signature, callId: exec.callId }].slice(-OBSERVATION_WINDOW)
    if (mutation || signature && !matches.length) {
      state.lastProgressAt = now
      state.lastProgress = { ...evidence, kind: mutation ? 'file_change' : 'new_observation',
        summary: mutation ? '文件修改工具已返回，尚待验证' : '工具返回新信息，是否推进需求由主控核对' }
    }
    if (matches.length + 1 >= REPEATED_OBSERVATION_NOTICE) {
      const alert = once(state, 'REPEATED_OBSERVATION', `${exec.name} 在最近 ${OBSERVATION_WINDOW} 次活动中至少 ${REPEATED_OBSERVATION_NOTICE} 次执行相同参数并返回相同结果；请核对是否仍有必要，已有进展可继续。`, now)
      if (alert) return { ...alert, advisory: true, evidence: [...matches.map(item => item.callId), exec.callId].filter(Boolean) }
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
