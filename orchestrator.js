import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createTaskRecords } from './task-records.js'
import { buildCompletion, completionText, incompleteReason, RECOVERY_LIMIT } from './completion.js'
import { startSupervision, observeTool, observeUsage, observeRequest, SUPERVISION_POLICY } from './supervision.js'
import { createUsageLedger } from './usage.js'

export const DEFAULT_OPTIONS = Object.freeze({
  maxParallel: 4, maxAttempts: 5, maxActivations: 64, taskTimeoutMinutes: 120,
  models: { worker: null, reviewer: null },
})
export const REVIEWER_MODEL_POLICY = 'dispatcher-snapshot'
const MAX_PLANS = 12
const MAX_TASKS = 16
const MIN_ACTIVATIONS = 1
const MAX_ACTIVATIONS = 256
export const OPTION_RANGES = Object.freeze({
  maxParallel: Object.freeze({ min: 1, max: 8 }), maxAttempts: Object.freeze({ min: 1, max: 10 }),
  maxActivations: Object.freeze({ min: MIN_ACTIVATIONS, max: MAX_ACTIVATIONS }), taskTimeoutMinutes: Object.freeze({ min: 1, max: 240 }),
})
const CHECK_TOOLS = ['read', 'grep', 'glob', 'pwsh', 'bash']
const LIVE = ['starting', 'running']
const STATUSES = ['queued', ...LIVE, 'review', 'accepted', 'failed', 'blocked', 'cancelled']
const targetsOf = plan => plan.tasks.flatMap(task => task.audit ? [task, task.audit] : [task])
const modelRole = task => task.role === 'reviewer' ? 'reviewer' : 'worker'
const targetKey = (plan, task) => `${plan.sessionId}:${task.id}${task.role === 'reviewer' ? ':reviewer' : ''}`
const clone = value => JSON.parse(JSON.stringify(value))
const brief = (value, limit = 3000) => String(value ?? '').slice(0, limit)
const textOf = content => (content ?? []).filter(block => block?.type === 'text').map(block => block.text).join('\n')
const messageOf = error => brief(error?.message ?? error)
const isServiceIssue = issue => ['MODEL_SERVICE_QUOTA', 'MODEL_SERVICE_RATE_LIMIT'].includes(issue?.code)
function modelServiceIssue(error, role, route = {}) {
  const details = messageOf(error), quota = error?.code === 'QUOTA' || /(?:exceed|insufficient)[^\n]*quota|quota[^\n]*(?:exceed|limit)/i.test(details)
  if (!quota && !['RATE_LIMIT', 'RATE_LIMITED'].includes(error?.code) && Number(error?.status ?? error?.statusCode) !== 429 && !/\b429\b|rate_limit_error/.test(details)) return null
  const label = { coordinator: '主控', worker: '执行者', reviewer: '独立审查' }[role]
  return { code: quota ? 'MODEL_SERVICE_QUOTA' : 'MODEL_SERVICE_RATE_LIMIT', retryable: false, role,
    provider: route.provider, model: route.model, originalCode: error?.code, details, at: Date.now(),
    message: `${label}模型服务${quota ? '额度不足' : '请求受限（429）'}；已保留现有交付物、报告和验证证据`,
    action: `${quota ? '恢复服务商额度' : '等待服务商解除限流'}${role === 'reviewer' ? '，然后明确重试独立审查；审查沿用分发者模型记录' : `，或手动调整${role === 'coordinator' ? '主控模型' : '执行模型配置'}后明确继续${role === 'coordinator' ? '验证验收' : '并重试该任务'}`}；不会自动切换模型或反复新开代理。` }
}

// Model output is intentionally separate from the full persisted/UI snapshot.
function compactTask(task) {
  return { id: task.id, title: task.title, status: task.status, attempts: task.attempts,
    model: task.modelRoute?.actual ?? task.modelRoute?.requested ?? task.model, issue: task.issue,
    summary: brief(task.execution?.summary, 300), reportPath: task.execution?.reportPath,
    error: task.error ? brief(task.error, 500) : null,
    checks: (task.checks ?? []).map((check, index) => ({ index, passed: check.result?.passed ?? null, callId: check.result?.callId })),
    issues: (task.issues ?? []).filter(issue => issue.status === 'open').map(issue => ({ id: issue.id, severity: issue.severity, finding: brief(issue.finding, 300) })),
    evidence: (task.evidence ?? []).map(item => item.callId),
    ...(task.audit ? { audit: { status: task.audit.status, summary: brief(task.audit.execution?.summary, 300),
      reportPath: task.audit.execution?.reportPath, specVerdict: task.audit.specVerdict, qualityVerdict: task.audit.qualityVerdict } } : {}) }
}
function compactResult(value) {
  const result = { ...value }
  if (value.plan) result.plan = { sessionId: value.plan.sessionId, goal: brief(value.plan.goal, 300), status: value.plan.status,
    decision: value.plan.decision,
    activationBudget: value.plan.activationBudget, dispatchWait: value.plan.dispatchWait,
    coordinatorIssue: value.plan.coordinatorIssue, messageResolution: value.plan.messageResolution,
    inputs: (value.plan.inputs ?? []).filter(input => ['queued', 'received'].includes(input.status)).map(input => ({ id: input.id, text: brief(input.text, 400), status: input.status })),
    tasks: value.plan.tasks.map(compactTask) }
  if (value.task) result.task = compactTask(value.task)
  if (value.audit) result.audit = compactTask(value.audit)
  return result
}

export async function validateModelRoute(llm, route, tier, signal) {
  if (!llm?.resolveCallConfig) throw new Error('DSH llm 服务不可用，不能校验子模型')
  try {
    const resolved = await llm.resolveCallConfig(route, signal
      ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000))
    // Current DSH returns { config, modelInfo }; retain compatibility with older adapters.
    const config = resolved?.config ?? resolved
    if (!config?.provider || !config?.model) throw new Error('DSH 未返回有效的模型请求配置')
    return clone(config)
  } catch (error) {
    const details = messageOf(error)
    const noAdapter = error.code === 'NO_ADAPTER' || /^no adapter registered for provider /.test(details)
    if (!noAdapter && error.code !== 'UNSUPPORTED_REASONING_EFFORT') throw error
    const label = tier === 'worker' || tier === 'routine' ? '执行模型' : '审查模型'
    const message = noAdapter
      ? `${label}配置已失效：${route.provider} / ${route.model}。当前 DSH 未注册服务“${route.provider}”`
      : `${label}的思考强度“${route.reasoningEffort}”不可用：${route.provider} / ${route.model}`
    const action = tier === 'worker' || tier === 'routine'
      ? '请打开“DSH Agentrix → 子任务模型 → 执行模型”，从当前列表重新选择并保存；配置未更新前不要重试'
      : '审查沿用分发时的主控模型；请恢复该模型服务及思考强度支持后明确重试审查。新执行可在切换主控后重新派发'
    const issue = { code: 'MODEL_CONFIG_INVALID', retryable: false, tier, role: tier, provider: route.provider, model: route.model, message, action, details }
    throw Object.assign(new Error(`${message}。${action}。`), { issue })
  }
}

export function orchestrationOptions(input = {}, strict = false) {
  const result = clone(DEFAULT_OPTIONS)
  for (const [key, { min, max }] of Object.entries(OPTION_RANGES)) {
    const value = input[key]
    if (value === undefined) continue
    if (!Number.isInteger(value) || value < min || value > max) {
      if (strict) throw new Error(`${key} 必须是 ${min}~${max} 的整数`)
    } else result[key] = value
  }
  for (const tier of ['worker']) {
    const legacy = 'routine'
    const route = input.models && Object.hasOwn(input.models, tier) ? input.models[tier] : input.models?.[legacy]
    if (route == null) continue
    if (typeof route.provider !== 'string' || !route.provider.trim() || route.provider.length > 160 ||
        typeof route.model !== 'string' || !route.model.trim() || route.model.length > 160 ||
        (route.reasoningEffort !== undefined && (typeof route.reasoningEffort !== 'string' || !route.reasoningEffort.trim() || route.reasoningEffort.length > 80))) {
      if (strict) throw new Error(`${tier} 模型需要同时填写 provider 和 model；思考强度可留空`)
      continue
    }
    result.models[tier] = { provider: route.provider.trim(), model: route.model.trim(),
      ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort.trim() } : {}) }
  }
  return result
}

function requireText(value, name, max = 6000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} 必须是 1~${max} 字的文字`)
  return value.trim()
}
function strings(value, name, allowEmpty = false) {
  if (!Array.isArray(value) || value.length > 20 || (!allowEmpty && value.length === 0)) throw new Error(`${name} 必须是${allowEmpty ? '可为空的' : '非空的'}数组，最多 20 项`)
  return value.map(item => requireText(item, name, 1000))
}
function validateIssues(value, task) {
  if (!Array.isArray(value) || value.length > 20) throw new Error('issues 必须是最多 20 项的问题数组')
  return value.map(issue => {
    if (!Number.isInteger(issue.criterion) || !task.criteria[issue.criterion] || !['critical', 'important', 'minor'].includes(issue.severity)) throw new Error('问题的标准编号或严重度无效')
    return { criterion: issue.criterion, severity: issue.severity, finding: requireText(issue.finding, '问题说明', 2000), evidence: strings(issue.evidence, '问题证据'),
      ...(issue.introducedByFix === true ? { introducedByFix: true } : {}) }
  })
}
function appendIssues(task, issues, source) {
  task.issues ??= []
  for (const issue of issues) task.issues.push({ ...issue, id: `${task.id}-${task.attempts}-${task.issues.length + 1}`,
    attempt: task.attempts, source, status: issue.severity === 'minor' ? 'deferred' : 'open' })
}
function validatePlan(args, stored = false) {
  if (!stored && JSON.stringify(args).length > 64 * 1024) throw new Error('任务计划超过 64 KiB，请缩小任务说明和输入范围')
  const goal = requireText(args.goal, '目标')
  if (!Array.isArray(args.tasks) || args.tasks.length === 0 || args.tasks.length > MAX_TASKS) throw new Error(`计划需要 1~${MAX_TASKS} 个任务`)
  const tasks = args.tasks.map(input => {
    const id = requireText(input.id, '任务编号', 64)
    if (!/^[\w-]+$/.test(id)) throw new Error('任务编号只能包含字母、数字、下划线和短横线')
    if (!['routine', 'complex'].includes(input.complexity)) throw new Error('complexity 只能是 routine 或 complex')
    if (!Array.isArray(input.checks) || !input.checks.length || input.checks.length > 4) throw new Error('每个任务需要 1~4 个主控验证步骤')
    const checks = input.checks.map(check => {
      if (!CHECK_TOOLS.includes(check.tool)) throw new Error(`验证工具只能是 ${CHECK_TOOLS.join(' / ')}`)
      if (!check.arguments || typeof check.arguments !== 'object' || Array.isArray(check.arguments) || JSON.stringify(check.arguments).length > 8000) throw new Error('验证工具 arguments 必须是 JSON 对象，最多 8000 字')
      if (['pwsh', 'bash'].includes(check.tool) && check.arguments.run_in_background) throw new Error('验收命令必须前台完成，不能提交后台任务')
      return { tool: check.tool, arguments: clone(check.arguments), result: null }
    })
    return { id, title: requireText(input.title, '任务标题', 160), instructions: requireText(input.instructions, '任务说明'),
      scope: requireText(input.scope, '边界'), outputs: strings(input.outputs, '交付物'), writes: strings(input.writes, '可修改路径', true),
      dependsOn: strings(input.dependsOn ?? [], '依赖', true), complexity: input.complexity,
      complexityReason: input.complexityReason == null ? null : requireText(input.complexityReason, '档位依据', 1000), modelRoute: null,
      criteria: strings(input.criteria, '验收标准'), checks, status: 'queued', attempts: 0,
      protocolVersion: 2, execution: null, issues: [], reworkIds: [], report: '', error: null, feedback: '', evidence: [], review: null, childId: null, model: null, progress: null }
  })
  const ids = new Set(tasks.map(task => task.id))
  if (ids.size !== tasks.length) throw new Error('任务编号重复')
  const visited = new Set(), stack = new Set()
  const visit = task => {
    if (stack.has(task.id)) throw new Error('任务依赖存在循环')
    if (visited.has(task.id)) return
    stack.add(task.id)
    for (const id of task.dependsOn) {
      if (!ids.has(id)) throw new Error(`依赖 ${id} 不存在`)
      visit(tasks.find(item => item.id === id))
    }
    stack.delete(task.id); visited.add(task.id)
  }
  tasks.forEach(visit)
  return { goal, tasks }
}

const normalizedPath = value => path.resolve(value).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
const writeScope = value => {
  const normalized = normalizedPath(value), wildcard = normalized.search(/[*?]/)
  return wildcard < 0 ? normalized : normalized.slice(0, normalized.lastIndexOf('/', wildcard))
}
function overlaps(left, right) {
  return left.writes.some(a => right.writes.some(b => {
    a = writeScope(a); b = writeScope(b)
    return !a || !b || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
  }))
}
function planStatus(plan) {
  if (plan.cancelled) return 'cancelled'
  if (plan.tasks.every(task => task.status === 'accepted')) return 'accepted'
  if (plan.coordinatorIssue && !plan.coordinatorIssue.resolvedAt) return 'blocked'
  if (targetsOf(plan).some(task => LIVE.includes(task.status))) return 'running'
  if (targetsOf(plan).some(task => ['failed', 'blocked'].includes(task.status))) return 'blocked'
  if (plan.tasks.some(task => task.status === 'review')) return 'review'
  if (plan.tasks.some(task => task.status === 'queued')) return 'planned'
  if (plan.tasks.some(task => task.status === 'cancelled')) return 'cancelled'
  return 'planned'
}

function activationBudget(plan, fallbackLimit) {
  const stored = plan.activationBudget && typeof plan.activationBudget === 'object' ? plan.activationBudget : {}
  const configured = Number.isInteger(fallbackLimit) ? fallbackLimit : DEFAULT_OPTIONS.maxActivations
  const limit = Number.isInteger(stored.limit) && stored.limit >= MIN_ACTIVATIONS && stored.limit <= MAX_ACTIVATIONS
    ? stored.limit : configured
  const attempts = targetsOf(plan).reduce((sum, task) => sum + (Number.isInteger(task.attempts) && task.attempts > 0 ? task.attempts : 0), 0)
  const used = Math.max(Number.isInteger(stored.used) && stored.used >= 0 ? stored.used : 0, attempts)
  plan.activationBudget = { limit, used }
  return { limit, used, remaining: Math.max(0, limit - used) }
}

function routeWarnings(route, tasks) {
  if (!route) return []
  const warnings = []
  const complex = tasks.filter(task => task.complexity === 'complex').length
  if (route.route === 'delegate_parallel' && tasks.length < 2) warnings.push('路由建议并行，但任务卡只有 1 个任务；请确认是否遗漏可独立工作')
  if (route.route !== 'direct' && complex === 0 && route.reasons?.includes('high_complexity')) warnings.push('路由判断为复杂，但所有任务都标为 routine；请核对任务拆分和独立审查需求')
  return warnings
}

/** DSH owns Agent lifetimes and tool execution. This module owns task state and acceptance. */
export function createOrchestrator({ ctx, file, getConfig, getSource = () => null, getRevision = getSource, getRoute = () => null, onRequestResolved = () => {}, onDelegated = () => {} }) {
  const usageLedger = createUsageLedger()
  const decisions = new Map(), decisionWrites = new Set()
  const coordinatorUsage = new Map()
  const plans = new Map(), live = new Map(), permits = new Map(), expectedRoutes = new Map(), disposers = []
  const noteRequests = new Map(), noteWrites = new Map()
  const stagedResults = new Map(), pendingTransports = new Map(), committing = new Set()
  const waitingParents = new Map()
  const inboxes = new Map()
  const cancellingPlans = new Set()
  const records = createTaskRecords(file), pendingRecords = new Map()
  let activityTimer
  let closed = false, dirty = false, writing, pumping = Promise.resolve(), storageError = null, recoveryFailed = false
  let archiveFailure = null
  const service = name => ctx.get(name)
  const sourceOf = id => decisions.get(id)?.messages ? decisions.get(id).source : getSource(id) ?? decisions.get(id)?.source ?? null
  const revisionOf = id => decisions.get(id)?.messages ? decisions.get(id).revision : getRevision(id) ?? decisions.get(id)?.revision ?? null
  const pendingMessages = id => (decisions.get(id)?.messages ?? []).filter(message => !message.resolution && !message.withdrawn)
  function receiveHuman(sessionId, message, target = 'next-turn') {
    if (!message?.id || message.source?.kind !== 'user') return
    const header = service('sessions')?.get(sessionId)?.header ?? service('agents')?.get(sessionId)?.session?.header ?? {}
    if (header.origin === 'subagent' || header.parentSession || header.delegationDepth > 0) return
    const text = (typeof message.content === 'string' ? message.content : textOf(message.content)).trim()
    if (!text) return
    let entry = decisions.get(sessionId)
    if (!entry) {
      const source = sourceOf(sessionId) ?? plans.get(sessionId)?.source ?? null
      entry = { sessionId, source: clone(source), revision: clone(getRevision(sessionId) ?? source), decision: null, recoveryUsed: 0 }
      decisions.set(sessionId, entry)
    }
    entry.messages ??= []
    const existing = entry.messages.find(item => item.messageId === String(message.id))
    if (existing) {
      if (existing.withdrawn && !existing.resolution) { existing.withdrawn = false; existing.target = target; waitingParents.get(sessionId)?.wake.resolve(); backgroundSave() }
      return
    }
    entry.messages.push({ messageId: String(message.id), text: text.slice(0, 4000), at: Date.now(), target })
    waitingParents.get(sessionId)?.wake.resolve()
    backgroundSave()
  }
  function usageTarget(sessionId, expected, model = {}) {
    const task = expected?.task
    const config = task?.modelRoute?.actual ?? task?.modelRoute?.resolved ?? service('agents')?.get(sessionId)?.session?.requestHeader?.()?.config
      ?? service('agents')?.get(sessionId)?.options ?? {}
    return { sessionId, role: task ? modelRole(task) : 'coordinator', provider: model.provider ?? config.provider,
      model: model.model ?? config.model, attempt: task?.attempts ?? 0, ...(task ? { taskId: task.id } : {}) }
  }
  function usageFor(sessionId, expected) {
    if (expected) return expected.plan.usage ?? null
    const header = service('agents')?.get(sessionId)?.session?.header
    if (header?.origin === 'subagent' || header?.parentSession || header?.delegationDepth > 0) return null
    const entry = usageLedger.request(sessionId, sourceOf(sessionId))
    const plan = plans.get(sessionId)
    if (entry && plan?.source?.messageId === entry.requestId) {
      plan.usage = entry
      if (!pendingRecords.has(plan.archive.id)) pendingRecords.set(plan.archive.id, { plan, events: [] })
    }
    return entry
  }
  function observeCoordinatorUsage(sessionId, kind, target, event) {
    let binding = coordinatorUsage.get(sessionId)
    if (kind === 'request') {
      const message = pendingMessages(sessionId).at(-1)
      binding = message ? { messageId: message.messageId } : { entry: usageFor(sessionId) }
      coordinatorUsage.set(sessionId, binding)
    }
    if (binding?.messageId) {
      const context = decisions.get(sessionId)
      context.pendingUsage ??= []
      context.pendingUsage.push({ messageId: binding.messageId, kind, target: clone(target), ...(event ? { event: { id: event.id, seq: event.seq, data: { id: event.data?.id, usage: event.data?.usage } } } : {}) })
      return
    }
    const entry = binding?.entry ?? usageFor(sessionId)
    if (kind === 'request') usageLedger.observeRequest(entry, target)
    else usageLedger.observeMessage(entry, target, event)
  }
  function clearTaskTimers(handle) {
    clearTimeout(handle.watchdog)
    handle.reportConfirmed?.resolve(false)
  }
  function invalidateCompletion(plan) {
    if (!plan.completion) return
    const previous = plan.completion
    plan.completion = null
    remember(plan, 'plan.completion_invalidated', '任务继续处理，当前回执已失效；旧回执保留在历史中', undefined, { completion: previous })
  }
  function finishPlan(plan, reason) {
    if (!(plan.protocolVersion >= 2) || plan.completion) return plan.completion ?? null
    if (!reason && !plan.cancelled && unresolvedInputs(plan).length) return null
    const receipt = buildCompletion(plan, reason)
    if (receipt) {
      plan.completion = receipt
      remember(plan, 'plan.receipt', completionText(receipt), undefined, { completion: receipt })
    }
    return receipt
  }
  function runtimeMessage(plan, text, kind = 'delegation-recovery') {
    return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind, planId: plan.archive.id } }
  }
  const queuedInputs = plan => [...(plan.inputs ?? []).filter(input => input.status === 'queued'), ...pendingMessages(plan.sessionId)]
  const unresolvedInputs = plan => [...(plan.inputs ?? []).filter(input => ['queued', 'received'].includes(input.status)), ...pendingMessages(plan.sessionId).map(message => ({ id: message.messageId, text: message.text, status: 'unclassified' }))]
  function selectInputs(plan, ids = []) {
    const selected = strings(ids, '补充消息编号', true)
    if (new Set(selected).size !== selected.length) throw new Error('补充消息编号重复')
    return selected.map(id => {
      const input = (plan.inputs ?? []).find(input => input.id === id && ['queued', 'received'].includes(input.status))
      if (!input && pendingMessages(plan.sessionId).some(message => message.messageId === id)) throw new Error('请先用 delegation_decide 确认 relation，再同步补充或处理消息')
      if (!input) throw new Error(`补充消息 ${id} 不存在、已处理或已撤回`)
      return input
    })
  }
  function additionalCriteria(task, args, inputs) {
    const criteria = strings(args.additionalCriteria ?? [], '新增验收标准', true)
    if (inputs.length && !criteria.length) throw new Error('同步补充要求必须通过 additionalCriteria 提供新增验收标准；纯答复使用 acknowledge')
    if (task.criteria.length + criteria.length > 20) throw new Error('验收标准超过 20 项，请收敛重复要求')
    return criteria
  }
  function forwardInputs(plan, task, inputs, criteria, message, messageId) {
    task.criteria.push(...criteria.filter(criterion => !task.criteria.includes(criterion)))
    if (criteria.length) { task.evidence = []; task.review = null; task.checks.forEach(check => { check.result = null }) }
    for (const input of inputs) Object.assign(input, { status: 'forwarded', taskId: task.id, handledAt: Date.now(), resolution: message, messageId, additionalCriteria: criteria })
    if (inputs.length) remember(plan, 'plan.input_forwarded', '用户补充已同步至任务 ' + task.id, task, { inputIds: inputs.map(input => input.id) })
  }
  function observeInput(session, event) {
    if (!session?.id || getConfig().enabled === false) return
    if (event.type === 'user/message') {
      receiveHuman(session.id, event.data?.message ?? event.data)
      return
    }
    if (event.type !== 'agent/inbox/spliced') return
    const data = event.data, target = data?.target ?? 'next-turn'
    if (!['next-turn', 'next-step'].includes(target)) return
    if (!inboxes.has(session.id)) inboxes.set(session.id, { 'next-turn': [], 'next-step': [] })
    const queue = inboxes.get(session.id)[target], start = data.start ?? queue.length
    const removed = queue.splice(start, data.removedCount ?? 0, ...(data.inserted ?? []).map(message => message.id))
    if (data.outcome === 'canceled') for (const id of removed) {
      const message = pendingMessages(session.id).find(item => item.messageId === id)
      if (message) message.withdrawn = true
      const input = plans.get(session.id)?.inputs?.find(item => item.id === id)
      if (input?.status === 'queued') input.status = 'withdrawn'
    }
    for (const message of data.inserted ?? []) receiveHuman(session.id, message, target)
    backgroundSave()
  }
  function notifyParent(plan, task, handle) {
    if (handle.notified || closed || plan.cancelled || plan.wakeSuppressed || plans.get(plan.sessionId) !== plan) return
    handle.notified = true
    if (waitingParents.has(plan.sessionId)) return
    const parent = service('agents')?.get(plan.sessionId)
    if (parent !== handle.parent) return
    const text = `托管任务 ${task.id}${task.role === 'reviewer' ? ' 的独立审查' : ''} 已返回：${task.status}。${task.error || task.execution?.summary || ''}。请读取 delegation_status，并通过 delegation_verify/review 完成验收；无需 stop 清理。`
    const message = runtimeMessage(plan, text, 'delegation-result')
    if (parent.status === 'running') parent.inject?.(message)
    else parent.steer?.(message)
  }
  const pendingSupervision = plan => targetsOf(plan).filter(task => LIVE.includes(task.status) && task.supervision?.pending && !task.supervision.pending.deliveredAt)
  function deliverSupervision(plan, agent) {
    const tasks = pendingSupervision(plan)
    if (!tasks.length || closed || plan.cancelled || plan.wakeSuppressed) return false
    const now = Date.now()
    for (const task of tasks) task.supervision.pending.deliveredAt = now
    const instruction = tasks.every(task => task.supervision.pending.advisory)
      ? '执行中的任务长时间没有新活动，请读取 delegation_status 核对是否仍在运行；正常等待无需纠偏或停止。\n'
      : '执行中的任务出现重复故障，请读取 delegation_status 核对证据，并向原子代理给出具体纠正，不重复派发或代做实现。\n'
    agent.inject(runtimeMessage(plan, instruction +
      tasks.map(task => `${task.id}（子会话 ${task.childId}）：${task.supervision.pending.reason}`).join('\n'), 'delegation-supervision'))
    return true
  }
  function requestSupervision(plan, task, handle, alert) {
    const state = task.supervision
    if (!state || !handle || state.pending && (!state.pending.advisory || alert.advisory) || getConfig().enabled === false || closed || plan.cancelled || plan.wakeSuppressed || handle.settling) return
    if (!alert.advisory && state.used >= state.limit) {
      const issue = { code: 'SUPERVISION_EXHAUSTED', retryable: false,
        message: `已用尽 ${state.limit} 次自动纠偏，任务仍需处理：${alert.reason}。已有产物和证据保留，不自动重开。` }
      const failure = Object.assign(new Error(issue.message), { issue })
      handle.failure = failure; handle.controller.abort(failure)
      void settle(plan, task, handle, undefined, failure).catch(error => { storageError = messageOf(error) })
      return
    }
    state.pending = { id: randomUUID(), at: Date.now(), ...alert }
    remember(plan, 'task.supervision_requested', alert.reason, task, { supervision: clone(state.pending) })
    void save().then(async () => {
      if (closed || plan.cancelled || plan.wakeSuppressed || !LIVE.includes(task.status)) return
      const waiter = waitingParents.get(plan.sessionId)
      if (waiter) waiter.wake.resolve()
      else if (service('agents')?.get(plan.sessionId) === handle.parent && deliverSupervision(plan, handle.parent)) await save()
    }).catch(error => { storageError = messageOf(error) })
  }
  function scheduleSupervision(plan, task, handle) {
    if (!handle) return
    clearTimeout(handle.watchdog)
    const state = task.supervision
    if (!state || task.execution || getConfig().enabled === false || closed || handle.settling || handle.controller.signal.aborted || !LIVE.includes(task.status)) return
    const idleAt = (state.lastActivityAt ?? state.startedAt) + state.idleMs
    const nextAt = Math.min(state.notices.ELAPSED_TIME ? Infinity : state.remindAt,
      state.notices.NO_ACTIVITY || state.pending ? Infinity : idleAt)
    if (!Number.isFinite(nextAt)) return
    handle.watchdog = setTimeout(() => {
      if (task.execution || closed || handle.settling || handle.controller.signal.aborted || !LIVE.includes(task.status)) return
      const now = Date.now()
      if (!state.notices.ELAPSED_TIME && now >= state.remindAt) {
        state.notices.ELAPSED_TIME = now
        remember(plan, 'task.reminder', '已达到运行时间提醒；不停止、不换代理，原任务继续。', task)
        backgroundSave()
      }
      if (!state.notices.NO_ACTIVITY && !state.pending && now >= (state.lastActivityAt ?? state.startedAt) + state.idleMs) {
        state.notices.NO_ACTIVITY = now
        requestSupervision(plan, task, handle, { code: 'NO_ACTIVITY', advisory: true,
          reason: '长时间没有新的活动，请核对模型或工具是否仍在执行；此提醒不会停止任务或消耗纠偏次数。', evidence: [] })
      }
      scheduleSupervision(plan, task, handle)
    }, Math.max(1, nextAt - Date.now()))
    handle.watchdog.unref?.()
  }
  async function waitForWork(handles, signal, plan, wake) {
    let abort
    const cancelled = new Promise(resolve => {
      abort = () => { plan.wakeSuppressed = true; resolve() }
      signal?.addEventListener('abort', abort, { once: true })
    })
    try { await Promise.race([Promise.all(handles.map(handle => handle.done.promise)), cancelled, wake]) }
    finally { signal?.removeEventListener('abort', abort) }
  }
  const truncatedOutputs = new Set()
  function trackOutput(sessionId, stream) {
    truncatedOutputs.delete(sessionId)
    if (!stream?.[Symbol.asyncIterator]) return stream
    return (async function* () {
      for await (const chunk of stream) {
        if (chunk.type === 'finish' && chunk.reason?.kind === 'max-tokens') truncatedOutputs.add(sessionId)
        yield chunk
      }
    })()
  }
  function continueOutput(plan, agent, task) {
    if (!truncatedOutputs.delete(agent.id)) return false
    remember(plan, 'task.output_continued', '模型单次输出被截断，原代理自动续接；不消耗补报告或验收次数', task)
    agent.inject(runtimeMessage(plan, '上一段输出达到模型单次生成上限，已有内容已保留。继续原任务尚未完成的部分，先核对已有工具结果，不重复已完成操作。需要写文件时分段写入，保持原模型与任务范围；完成后按原流程提交报告、验证和验收。', 'delegation-output-continuation'))
    return true
  }
  disposers.push(ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    await ready
    if (closed || getConfig().enabled === false || signal?.aborted) { truncatedOutputs.delete(agent.id); return }
    if (committing.size) await Promise.all(committing)
    const expected = expectedRoutes.get(agent.id)
    if (expected && expected.task.protocolVersion >= 2) {
      const { plan, task, handle } = expected
      if (task.execution?.commitState === 'committed' || handle.controller.signal.aborted) { truncatedOutputs.delete(agent.id); return }
      if (continueOutput(plan, agent, task)) { await save(); return }
      task.recovery ??= { used: 0, limit: RECOVERY_LIMIT }
      if (task.recovery.used < RECOVERY_LIMIT) {
        task.recovery.used++
        remember(plan, 'task.completion_recovery', `第 ${task.recovery.used}/${RECOVERY_LIMIT} 次提醒原子代理提交正式报告`, task)
        await save()
        if (!signal?.aborted && !handle.controller.signal.aborted) agent.inject(runtimeMessage(plan, '尚未提交正式报告，当前回合暂不结束。请立即调用 delegation_report；普通文字和 send_message 不算报告。不要新开代理，也不要继续扩大实现范围。'))
      } else {
        const issue = { code: 'REPORT_REQUIRED', retryable: false, message: '两次补流程后仍未提交正式报告，已暂停任务；不自动新开代理。' }
        const failure = Object.assign(new Error(issue.message), { issue })
        handle.failure = failure; handle.controller.abort(failure)
        void settle(plan, task, handle, undefined, failure).catch(error => { storageError = messageOf(error) })
      }
      return
    }
    const plan = plans.get(agent.id)
    if (!plan || !(plan.protocolVersion >= 2) || plan.wakeSuppressed || plan.cancelled && plan.completion) { truncatedOutputs.delete(agent.id); return }
    if (pendingMessages(agent.id).length && await recoverDecision(agent.id)) {
      agent.inject(runtimeMessage(plan, '有尚未关联的真实用户消息。请先用 delegation_decide 的 relation 确认 new/continue/update/question；不要按前缀或字数归类，不新开分类代理，然后继续相应任务。', 'delegation-decision-recovery'))
      return
    }
    if (!plan.completion && continueOutput(plan, agent)) { await save(); return }
    const waiter = { signal, wake: Promise.withResolvers() }
    waitingParents.set(agent.id, waiter)
    try {
      while (!signal?.aborted) {
        if (queuedInputs(plan).length) break
        const handles = [...live.values()].filter(handle => handle.planSessionId === agent.id)
        if (!handles.length) break
        if (pendingSupervision(plan).length) break
        const wake = waiter.wake
        await waitForWork(handles, signal, plan, wake.promise)
        if (waiter.wake === wake) waiter.wake = Promise.withResolvers()
        if (pendingSupervision(plan).length) break
      }
    } finally { waitingParents.delete(agent.id) }
    if (closed || signal?.aborted || plan.wakeSuppressed) return
    if (queuedInputs(plan).length) { await save(); return }
    if (deliverSupervision(plan, agent)) { await save(); return }
    if (finishPlan(plan)) { await save(); return }
    plan.recovery ??= { used: 0, limit: RECOVERY_LIMIT }
    if (plan.recovery.used >= RECOVERY_LIMIT) {
      finishPlan(plan, '两次自动补流程后仍未完成验收，已停止自动续跑；交付物和证据保留。')
      plan.autoDispatch = false
      await save(); return
    }
    plan.recovery.used++
    const missing = plan.tasks.filter(task => task.status !== 'accepted').map(task => `${task.id}：${incompleteReason(task)}`)
    remember(plan, 'plan.completion_recovery', `第 ${plan.recovery.used}/${RECOVERY_LIMIT} 次提醒原主控补齐验证和验收`)
    await save()
    if (!signal?.aborted && !plan.wakeSuppressed) agent.inject(runtimeMessage(plan,
      '当前任务尚未验收，不能作为已完成交付。请继续原计划，不新开代理、不用 stop 代替完成。\n' + missing.join('\n') +
      '\n读取 delegation_status，对 review 任务调用 delegation_verify 并逐条 delegation_review；最后一次验收会自动生成交付回执，无需另写完成总结。'))
  }, { global: true }))
  function commitToolResult(transaction, success) {
    const operation = (async () => {
      try { await (success ? transaction.commit() : transaction.rollback()) }
      catch (error) { storageError = messageOf(error); throw error }
    })()
    committing.add(operation)
    if (transaction.handle) transaction.handle.reportCommit = operation
    operation.finally(() => committing.delete(operation)).catch(() => {})
    return operation
  }
  disposers.push(ctx.on('tools/result', (exec, result) => {
    const transactions = pendingTransports.get(exec.token) ?? []
    pendingTransports.delete(exec.token)
    const staged = stagedResults.get(exec)
    if (staged) { stagedResults.delete(exec); transactions.push(staged) }
    if (!transactions.length) return
    if (!result.isError && exec.parent !== undefined) {
      pendingTransports.set(exec.parent, [...(pendingTransports.get(exec.parent) ?? []), ...transactions])
      return
    }
    return Promise.all(transactions.map(transaction => commitToolResult(transaction, !result.isError)))
  }, { global: true }))
  const snapshotPlan = plan => {
    const budget = activationBudget(plan, getConfig().maxActivations)
    const copy = clone(plan)
    const parent = service('agents')?.get(plan.sessionId)
    for (const task of copy.tasks) if (task.status === 'queued' && Object.hasOwn(task, 'modelRoute')) {
      try {
        const { selected, source } = modelSelection(task, parent ?? {})
        task.modelRoute = { role: modelRole(task), source, requested: selected, resolved: null, actual: null }
      } catch { /* No live parent or usable configuration: leave unknown information explicit. */ }
    }
    for (const task of copy.tasks) for (const check of task.checks) delete check.verifying
    copy.activationBudget = budget
    delete copy.pendingMessages
    if (plan.source?.messageId === sourceOf(plan.sessionId)?.messageId && pendingMessages(plan.sessionId).length) copy.pendingMessages = clone(pendingMessages(plan.sessionId))
    if (copy.decision) copy.decisionCurrent = ['accepted', 'cancelled'].includes(planStatus(plan)) || decisionCurrent(plan.sessionId)
    if (['accepted', 'cancelled'].includes(planStatus(plan))) copy.dispatchWait = null
    return { ...copy, status: planStatus(plan) }
  }
  const snapshot = () => [...plans.values()].map(snapshotPlan)
  function remember(plan, type, message, task, details = {}) {
    records.attach(plan)
    const event = { id: randomUUID(), type, at: Date.now(), message: brief(message, 1000),
      ...(task ? { taskId: task.id, attempt: task.attempts, ...(task.role ? { role: task.role } : {}) } : {}), ...details }
    plan.updatedAt = event.at
    const { id, at, taskId } = event
    plan.recentEvents = [...(plan.recentEvents || []), { id, type, at, message: event.message, ...(taskId ? { taskId } : {}) }].slice(-8)
    if (!pendingRecords.has(plan.archive.id)) pendingRecords.set(plan.archive.id, { plan, events: [] })
    pendingRecords.get(plan.archive.id).events.push(event)
  }
  const save = () => {
    if (recoveryFailed) return Promise.reject(new Error(`任务文件恢复失败，保留原文件：${storageError}`))
    dirty = true
    if (!writing) writing = (async () => {
      try {
        while (dirty) {
          dirty = false
          const batch = [...pendingRecords.entries()].map(([id, entry]) =>
            ({ id, entry, plan: snapshotPlan(entry.plan), events: entry.events.slice() }))
          await mkdir(path.dirname(file), { recursive: true })
          const temporary = `${file}.tmp`
          await writeFile(temporary, JSON.stringify({ version: 1, plans: snapshot(), requestUsage: usageLedger.snapshot(), decisions: [...decisions.values()] }), 'utf8')
          await rename(temporary, file)
          for (const item of batch) {
            try {
              await records.write(item.plan, item.events)
              if (archiveFailure?.id === item.id) archiveFailure = null
            }
            catch (error) {
              archiveFailure = { id: item.id, sessionId: item.plan.sessionId, message: '辅助档案写入失败：' + messageOf(error) +
                '。当前任务状态和验收证据已保存，执行可继续；完整历史档案可能不全。' }
            }
            item.entry.events.splice(0, item.events.length)
            if (!item.entry.events.length) pendingRecords.delete(item.id)
          }
        }
        storageError = null
      } catch (error) { storageError = messageOf(error); throw error }
      finally { writing = undefined }
    })()
    return writing
  }
  const backgroundSave = () => {
    if (activityTimer || closed) return
    activityTimer = setTimeout(() => {
      activityTimer = null
      save().catch(error => console.warn('[dsh-delegation-first] 任务保存失败：%s', messageOf(error)))
    }, 1000)
    activityTimer.unref?.()
  }
  const ready = (async () => {
    try {
      const info = await stat(file)
      if (info.size > 16 * 1024 * 1024) throw new Error('任务文件超过 16 MiB，请检查备份')
      const stored = JSON.parse(await readFile(file, 'utf8'))
      if (stored.version !== 1 || !Array.isArray(stored.plans) || stored.plans.length > MAX_PLANS) throw new Error('任务文件格式不支持')
      usageLedger.restore(stored.requestUsage)
      for (const entry of (stored.decisions ?? []).slice(-100)) {
        if (typeof entry.sessionId === 'string' && (entry.source?.messageId || Array.isArray(entry.messages)) &&
          (!entry.decision || ['direct', 'delegate'].includes(entry.decision.mode) && typeof entry.decision.reason === 'string')) decisions.set(entry.sessionId, entry)
      }
      for (const plan of stored.plans) {
        const usage = usageLedger.request(plan.sessionId)
        if (usage?.requestId === plan.usage?.requestId) plan.usage = usage
        validatePlan(plan, true)
        if (typeof plan.sessionId !== 'string' || !plan.tasks.every(task => STATUSES.includes(task.status))) throw new Error('任务文件状态无效')
        plan.autoDispatch = false
        plan.dispatchWait ??= null
        activationBudget(plan, getConfig().maxActivations)
        plan.routingWarnings ??= routeWarnings(plan.routing, plan.tasks)
        if (!plan.archive) remember(plan, 'plan.imported', '从已有任务快照首次建档；更早的执行过程未记录')
        else {
          records.attach(plan)
          pendingRecords.set(plan.archive.id, { plan, events: [] })
        }
        for (const task of targetsOf(plan)) if (LIVE.includes(task.status)) {
          task.status = 'blocked'; task.recovered = true
          task.error = 'DSH 或插件已重新加载。先停止旧子任务，再重试，避免重复执行。'
          remember(plan, 'task.interrupted', task.error, task)
        }
        for (const task of plan.tasks) {
          delete task.pendingAcceptance
          for (const check of task.checks) delete check.verifying
        }
      }
      for (const plan of stored.plans) plans.set(plan.sessionId, plan)
      if (plans.size) await save()
    } catch (error) {
      if (error.code !== 'ENOENT') { recoveryFailed = true; storageError = messageOf(error); console.warn('[dsh-delegation-first] 任务恢复失败：%s', storageError) }
    }
  })()
  function own(exec) {
    if (closed) throw new Error('插件已停止')
    const parent = exec.agent
    if (!parent || service('agents')?.get(parent.id) !== parent) throw new Error('需要当前主控 Agent 调用')
    const header = parent.session?.header ?? service('sessions')?.get(parent.id)?.header ?? {}
    if (header.origin === 'subagent' || header.parentSession || Number(header.delegationDepth) > 0) throw new Error('子 Agent 只能执行任务，不能创建或验收计划')
    return parent
  }
  function ownPlan(exec) {
    const parent = own(exec), plan = plans.get(parent.id)
    if (!plan) throw new Error('请先调用 delegation_plan 创建任务计划')
    return { parent, plan }
  }
  function decisionFor(sessionId) {
    const entry = decisions.get(sessionId), source = sourceOf(sessionId)
    if (decisionWrites.has(sessionId) || !entry || source?.messageId !== entry.source?.messageId) return null
    return clone(entry.decision ?? null)
  }
  function decisionCurrent(sessionId) {
    const decision = decisionFor(sessionId)
    return Boolean(decision && !pendingMessages(sessionId).length && decision.revisionId === revisionOf(sessionId)?.messageId)
  }
  async function recoverDecision(sessionId) {
    if (decisionCurrent(sessionId) || decisionWrites.has(sessionId)) return false
    const entry = decisions.get(sessionId), source = sourceOf(sessionId), revision = revisionOf(sessionId)
    if (!pendingMessages(sessionId).length && entry?.messageResolution?.relation === 'question') return false
    const key = pendingMessages(sessionId).at(-1)?.messageId ?? revision?.messageId
    if (!key) return false
    if (entry?.recoveryKey === key && entry.recoveryUsed >= 1) return false
    const previous = clone(entry ?? null)
    decisions.set(sessionId, { ...entry, sessionId, source: clone(source), revision: clone(revision), recoveryKey: key, recoveryUsed: 1 })
    try { await save() }
    catch (error) { if (previous) decisions.set(sessionId, previous); else decisions.delete(sessionId); throw error }
    return true
  }
  async function recordDecision(args, exec) {
    const parent = own(exec), previous = clone(decisions.get(parent.id) ?? null)
    if (decisionWrites.has(parent.id)) throw new Error('判断正在保存，请等待本次工具返回')
    const entry = decisions.get(parent.id) ?? { sessionId: parent.id, source: clone(getSource(parent.id)), revision: clone(getRevision(parent.id)) }
    const pending = pendingMessages(parent.id)
    if (!args.messageId && pending.length > 1) throw new Error('存在多条待关联消息，请提供真实 messageId 分别确认，不能自动选最后一条')
    const binding = coordinatorUsage.get(parent.id)
    const message = args.messageId ? entry.messages?.find(item => item.messageId === args.messageId && !item.withdrawn)
      : binding ? entry.messages?.find(item => item.messageId === binding.messageId && !item.resolution && !item.withdrawn) : pending[0]
    if (args.messageId && !message) throw new Error('消息编号不存在于本会话的真实用户消息，不能伪造关联')
    const relation = args.relation ?? (!entry.source ? 'new' : !message ? 'update' : null)
    if (!['new', 'continue', 'update', 'question'].includes(relation)) throw new Error('请用 relation 明确 new/continue/update/question；程序不根据措辞猜需求归属')
    if (['continue', 'update'].includes(relation) && !entry.source) throw new Error('尚无已确认需求，请先用 new 记录')
    const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
    const changes = ['new', 'update'].includes(relation) || !entry.decision && relation !== 'question'
    if (changes && (!['direct', 'delegate'].includes(args.mode) || !reason || reason.length > 500)) throw new Error('新需求、范围或方案变化须提供 direct/delegate 和非空的具体理由，最多 500 字')
    if (!changes && args.mode && args.mode !== entry.decision?.mode) throw new Error('执行方式变化请使用 update 并说明理由')
    const source = relation === 'new' || !entry.source ? message ? { messageId: message.messageId, text: message.text } : getSource(parent.id) : entry.source
    if (!source?.messageId) throw new Error('尚未取得当前需求编号，请先接收用户需求后记录判断')
    const revision = ['new', 'update'].includes(relation) ? message ? { messageId: message.messageId, text: message.text } : source : entry.revision ?? source
    const plan = plans.get(parent.id)
    if (changes && relation !== 'new' && args.mode === 'direct' && plan && !['accepted', 'cancelled'].includes(planStatus(plan))) throw new Error('托管计划尚未结束，请监督、返工或明确取消，不能同时改为主控重复实现')
    const model = coordinatorModel(parent, 0, 'decision'), at = Date.now()
    const decision = changes ? { mode: args.mode, reason, requestId: source.messageId, revisionId: revision.messageId, at, model } : entry.decision ?? null
    const resolution = { messageId: message?.messageId ?? revision.messageId, requestId: source.messageId, relation, at, model, ...(reason ? { reason } : {}) }
    const next = { ...entry, source: clone(source), revision: clone(revision), decision, messageResolution: resolution }
    if (message) {
      next.messages = entry.messages.map(item => item.messageId === message.messageId ? { ...item, resolution } : item)
    }
    decisions.set(parent.id, next); decisionWrites.add(parent.id)
    const previousPlanDecision = plan?.decision, previousResolution = plan?.messageResolution, previousInputs = clone(plan?.inputs ?? null), previousUsage = usageLedger.snapshot()
    if (plan?.source?.messageId === source.messageId) {
      if (changes) plan.decision = clone(decision)
      plan.messageResolution = clone(resolution)
      if (message && relation === 'update' && message.messageId !== plan.source.messageId) {
        plan.inputs ??= []
        if (!plan.inputs.some(input => input.id === message.messageId)) plan.inputs.push({ id: message.messageId, text: message.text, at: message.at, status: 'received', target: message.target })
      }
      remember(plan, 'decision.recorded', '主控确认消息关联：' + relation + (reason ? '；' + reason : ''))
    }
    if (message) {
      const usage = usageLedger.request(parent.id, source)
      for (const item of next.pendingUsage ?? []) if (item.messageId === message.messageId) {
        if (item.kind === 'request') usageLedger.observeRequest(usage, item.target)
        else usageLedger.observeMessage(usage, item.target, item.event)
      }
      next.pendingUsage = (next.pendingUsage ?? []).filter(item => item.messageId !== message.messageId)
      if (plan?.source?.messageId === source.messageId) plan.usage = usage
    }
    try { await save() }
    catch (error) {
      if (previous) decisions.set(parent.id, previous); else decisions.delete(parent.id)
      usageLedger.restore(previousUsage, true)
      if (plan) { plan.decision = previousPlanDecision; plan.messageResolution = previousResolution; if (previousInputs) plan.inputs = previousInputs; else delete plan.inputs; plan.usage = usageLedger.request(parent.id) }
      throw error
    } finally { decisionWrites.delete(parent.id) }
    if (message && coordinatorUsage.get(parent.id)?.messageId === message.messageId) coordinatorUsage.set(parent.id, { entry: usageFor(parent.id) })
    onRequestResolved(parent.id, clone(next))
    return { decision: clone(decision), source: clone(source), messageResolution: clone(resolution), pendingMessages: clone(pendingMessages(parent.id)) }
  }
  function taskOf(plan, id) {
    const task = plan.tasks.find(item => item.id === id)
    if (!task) throw new Error(`任务 ${id} 不存在`)
    return task
  }
  function workerPrompt(plan, task) {
    return [
      '你是执行者，使用配置的执行模型，只按主控已确定的方案完成以下任务；不要再委派。遇到未决定的设计问题、缺资料或能力不足时，通过 delegation_report 报告 NEEDS_CONTEXT/BLOCKED 交回主控，不猜测、不自行换模型或扩大范围。',
      `总目标：${plan.goal}`, `任务：${task.title}`, task.instructions, `边界：${task.scope}`,
      `只允许修改：${task.writes.join('、') || '无（只读）'}`, `交付物：${task.outputs.join('、')}`,
      '验收标准：', ...task.criteria.map((item, i) => `${i + 1}. ${item}`),
      ...plan.tasks.filter(item => task.dependsOn.includes(item.id)).map(item => `已验收前置任务 ${item.id}：${item.execution ? item.execution.summary + '；完整报告：' + item.execution.reportPath : brief(item.report)}`),
      task.feedback ? `主控返工要求：${task.feedback}` : '',
      task.reworkIds?.length ? '只修复以下问题及其直接回归，不扩展任务：\n' + JSON.stringify(task.issues.filter(issue => task.reworkIds.includes(issue.id))) : '',
      '短任务只提交最终报告。较长调查、阶段转换或阻塞时，可用 delegation_checkpoint 记录结论、下一步和成功工具 callId；记录不代表验收。读取用 read/grep/glob，read 参数使用 file_path；管理入口仅供主控。',
      '同类工具错误重复时按主控纠正继续。调用次数、运行时间和 Token 仅提醒或统计，不停止、不换代理；输出截断在原代理续接。使用已有产物和上下文完成任务，避免重复调查和重复执行。',
      '结束前必须调用 delegation_report：status 为 DONE、DONE_WITH_CONCERNS、NEEDS_CONTEXT 或 BLOCKED；summary 为短结论，report 保存完整交付路径、逐条证据、测试命令及结果。后两种状态必须提供 reason，说明缺什么或为什么阻塞；有疑点须列 concerns。报告由插件归档，不要自行创建档案目录。工具确认后自动结束，不用 send_message 交成果，不再修改交付物或另写总结。不要把自称完成当成验收。',
    ].filter(Boolean).join('\n')
  }
  function queueAudit(task) {
    task.audit = { id: task.id, role: 'reviewer', title: '独立审查：' + task.title, complexity: task.complexity,
      forAttempt: task.attempts, status: 'queued', attempts: 0, writes: [], checks: [], evidence: [], report: '', execution: null,
      protocolVersion: task.protocolVersion, dispatcherModel: task.dispatcherModel ? clone(task.dispatcherModel) : null,
      model: null, modelRoute: null, childId: null, error: null, progress: null }
  }
  function auditPrompt(plan, task) {
    return [
      '你是独立的只读审查者，同时核对需求符合性和代码质量。不要修改文件、执行命令或继续委派；主控负责实际运行验证。',
      `总目标：${plan.goal}`, `任务：${task.title}`, task.instructions, `边界：${task.scope}`,
      `可修改范围（仅用于核查越界）：${task.writes.join('、') || '无'}`, `交付物：${task.outputs.join('、')}`,
      '逐条验收要求：', ...task.criteria.map((item, i) => `${i}. ${item}`),
      `执行报告文件：${task.execution.reportPath}。报告是待核实的主张，必须读实际交付物核对；不要全库漫游。`,
      '测试通过不能代替需求满足；界面还原需核对原稿与同尺寸实际截图，缺少无法核实的证据必须报告问题，不能默认通过。',
      '结束前调用 delegation_report，提交 status、summary、完整 report，以及 specVerdict/qualityVerdict（pass 或 fail）和 issues。',
      '正式报告通过工具管线确认后自动结束；不使用 send_message 提交成果，也不再执行其他工具。',
      'issues 每项包含 criterion（标准编号从 0 开始）、severity（critical/important/minor）、finding 和 evidence（具体文件行号或可读证据路径数组）。minor 建议不阻止通过。',
      '必须核实正确性及漏做、超做、误解需求；无法验证的要求按实际缺口报告，不能相信执行者的成功声明。',
      ...(task.reworkIds?.length ? [
        '本次只复查原问题是否解决及修复新引入的问题。禁止把范围外新发现升级为阻塞；可作为 minor 记录。',
        '必须在 resolutions 中逐条返回原问题 id、status（ADDRESSED 或 NOT_ADDRESSED）、evidence 数组。新重要问题必须标 introducedByFix:true，并用证据说明本次修复如何引入。',
        JSON.stringify(task.issues.filter(issue => task.reworkIds.includes(issue.id))),
      ] : []),
    ].join('\n')
  }
  function pauseAfterFailure(plan, task) {
    if (!plan.autoDispatch) return
    plan.autoDispatch = false
    remember(plan, 'plan.paused', `子任务 ${task.id} 失败，已暂停后续自动派单；处理失败原因后由主 Agent 按具体任务 retry`)
    for (const queued of targetsOf(plan)) if (queued.status === 'queued') {
      queued.status = 'blocked'
      queued.error = `计划因子任务 ${task.id} 失败而暂停；本任务尚未启动，请处理原因后用 delegation_control retry 明确重试`
      remember(plan, 'task.blocked', queued.error, queued)
    }
  }
  function recoverableTasks(plan, includeLegacyCancelled = false) {
    if (pendingServiceIssue(plan)) return []
    const resumableCancellation = !Object.hasOwn(plan, 'cancelledBy') || plan.cancelledBy === 'implicit'
    return plan.tasks.filter(task => {
      const failed = ['failed', 'blocked'].includes(task.status)
      const legacyCancelled = includeLegacyCancelled && task.status === 'cancelled'
        && resumableCancellation && task.stop?.reason === '主控明确取消整个计划'
      return (failed || legacyCancelled) && !task.recovered && task.attempts < getConfig().maxAttempts
    })
  }
  function pendingServiceIssue(plan) {
    return plan.coordinatorIssue && !plan.coordinatorIssue.resolvedAt ? plan.coordinatorIssue : targetsOf(plan).find(task => isServiceIssue(task.issue))?.issue
  }
  function queuePlanRecovery(plan, tasks, message) {
    invalidateCompletion(plan)
    plan.cancelled = false; plan.cancelledBy = null; plan.wakeSuppressed = false; plan.autoDispatch = true; plan.dispatchWait = null
    for (const task of tasks) {
      task.feedback = message
      task.status = 'queued'; task.error = null; task.issue = null; delete task.stop
      remember(plan, 'task.auto_recovery_queued', message, task)
    }
    remember(plan, 'plan.auto_recovery', `沿用原计划自动恢复 ${tasks.length} 个任务`)
  }
  function pauseAtActivationLimit(plan) {
    const budget = activationBudget(plan, getConfig().maxActivations)
    const message = `计划派发预算已用尽（${budget.used}/${budget.limit} 次）；为避免失败后无限开启子 Agent，请建立新计划或先处理已有任务`
    plan.autoDispatch = false
    plan.dispatchWait = { reason: 'activation-limit', message, used: budget.used, limit: budget.limit, at: plan.dispatchWait?.at ?? Date.now() }
    if (!plan.recentEvents?.some(event => event.type === 'plan.activation_limit')) remember(plan, 'plan.activation_limit', message)
    for (const queued of targetsOf(plan)) if (queued.status === 'queued') {
      queued.status = 'blocked'
      queued.error = message
      remember(plan, 'task.blocked', message, queued)
    }
    return message
  }
  function requireActivationBudget(plan) {
    const budget = activationBudget(plan, getConfig().maxActivations)
    if (budget.remaining > 0) return budget
    throw new Error(pauseAtActivationLimit(plan))
  }
  async function releaseChild(handle, task) {
    truncatedOutputs.delete(task.childId)
    if (handle.releasePromise && handle.releasedReceipt === handle.receipt) return handle.releasePromise
    handle.releasedReceipt = handle.receipt
    handle.releasePromise = (async () => {
      if (!handle.receipt) {
        task.release = { status: 'none', at: Date.now() }
        return null
      }
      try {
        await handle.receipt?.dispose()
        task.release = { status: 'released', at: Date.now() }
        return null
      } catch (error) {
        const parent = handle.parent ?? service('agents')?.get(handle.planSessionId)
        try {
          if (!parent || !task.childId || typeof service('subagents')?.drainChildren !== 'function') throw error
          await service('subagents').drainChildren(parent, [task.childId])
          task.release = { status: 'drained', at: Date.now() }
          return null
        } catch (drainError) {
          task.release = { status: 'failed', at: Date.now(), error: messageOf(drainError) }
          return drainError
        }
      }
    })()
    return handle.releasePromise
  }
  async function settle(plan, task, handle, result, error) {
    if (handle.settling) return
    handle.settling = true
    clearTaskTimers(handle)
    try { await handle.reportCommit } catch (failure) {
      error = Object.assign(new Error('报告确认保存失败：' + messageOf(failure)), { issue: { code: 'REPORT_COMMIT_FAILED', retryable: false } })
    }
    if (handle.failure?.issue || (!error && result?.stopReason === 'error')) error = handle.failure
    const issue = error && !error.issue && modelServiceIssue(error, modelRole(task), task.modelRoute?.actual ?? task.modelRoute?.resolved)
    if (issue) error = Object.assign(new Error(messageOf(error)), { issue })
    const releaseError = await releaseChild(handle, task)
    error ??= releaseError
    if (live.get(handle.key) !== handle) { handle.done?.resolve(); return }
    live.delete(handle.key)
    expectedRoutes.delete(task.childId)
    if (LIVE.includes(task.status)) {
      if (!task.execution) task.report = textOf(result?.output).slice(0, 24000)
      const reported = result?.stopReason === 'completed' || result?.stopReason === 'max-tokens' && task.execution?.commitState === 'committed'
      task.status = !error && reported ? 'review' : error?.issue ? 'blocked' : 'failed'
      task.issue = error?.issue ?? null
      task.error = error ? messageOf(error) : task.status === 'failed' ? `子任务停止原因：${result?.stopReason ?? 'unknown'}` : null
      if (task.status === 'review' && task.protocolVersion && (!task.execution || (task.protocolVersion >= 2 && task.execution.commitState !== 'committed'))) {
        task.status = 'blocked'; task.error = '执行者没有提交结构化报告，不能验收。请核对交付物和缺失原因后明确重试，不会自动重开。'
      } else if (task.status === 'review' && ['NEEDS_CONTEXT', 'BLOCKED'].includes(task.execution?.status)) {
        task.status = 'blocked'; task.error = task.execution.reason
      }
      if (task.status === 'review' && task.role === 'reviewer') task.status = 'completed'
      if (task.status === 'completed') {
        const owner = handle.owner
        for (const resolution of task.resolutions ?? []) {
          const issue = owner.issues.find(item => item.id === resolution.id)
          issue.status = resolution.status === 'ADDRESSED' ? 'addressed' : 'open'
          issue.resolutionEvidence = resolution.evidence; issue.reviewedAttempt = owner.attempts
        }
        appendIssues(owner, task.issues ?? [], 'reviewer')
      }
      if (task.status === 'review' && task.protocolVersion && task.complexity === 'complex') queueAudit(task)
      task.finishedAt = Date.now()
      remember(plan, ['review', 'completed'].includes(task.status) ? 'task.returned' : task.status === 'blocked' ? 'task.blocked' : 'task.failed',
          task.status === 'completed' ? '独立审查已返回，等待主控核对结论' : task.status === 'review' ? '子 Agent 已返回，等待主 Agent 验证与评审' : task.error,
          task, { report: task.report, error: task.error })
      if (['failed', 'blocked'].includes(task.status)) pauseAfterFailure(plan, task)
    }
    try {
      await save()
      if (!closed) await pump()
      if (task.protocolVersion >= 2) notifyParent(plan, task, handle)
    } finally { handle.done?.resolve() }
  }
  function coordinatorModel(parent, attempt, source = 'dispatch') {
    const config = parent.session?.requestHeader?.()?.config ?? parent.options ?? {}
    if (!config.provider || !config.model) throw new Error('无法确定分发者模型，请检查主控当前模型后继续')
    return { provider: config.provider, model: config.model, ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
      sessionId: parent.id, attempt, at: Date.now(), source }
  }
  function modelSelection(task, parent) {
    const role = modelRole(task), route = role === 'reviewer' ? task.dispatcherModel ?? coordinatorModel(parent, task.forAttempt ?? task.attempts, 'legacy-review')
      : orchestrationOptions(getConfig()).models.worker
    if (!route && role === 'worker') {
      const message = '执行模型尚未配置，任务未启动；不会自动继承主控模型'
      const action = '请打开“DSH Agentrix → 子任务模型 → 执行模型”，选择用于做事的模型并保存，然后继续原计划'
      throw Object.assign(new Error(message + '。' + action), { issue: { code: 'MODEL_CONFIG_INVALID', retryable: false, tier: role, role, message, action } })
    }
    const selected = { provider: route.provider, model: route.model, ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {}) }
    if (!selected.provider || !selected.model) throw new Error('无法确定子任务模型，请在“DSH Agentrix”中选择模型或检查主 Agent 模型')
    return { selected, source: role === 'reviewer' ? 'dispatcher' : 'configured' }
  }
  function recordModelSelection(task, selected, source, resolved = null) {
    task.modelRoute = { role: modelRole(task), source, requested: clone(selected), resolved: resolved ? clone(resolved) : null, actual: null }
    task.model = { ...(resolved ?? selected), source }
  }
  function validateChecks(tasks, parent, toolSet) {
    if (typeof ctx.tools.schemas !== 'function') return
    const schemas = ctx.tools.schemas(parent, toolSet)
    for (const task of tasks) for (const check of task.checks) {
      const schema = schemas.find(item => item.name === check.tool)?.parameters
      if (!schemas.some(item => item.name === check.tool)) throw new Error(`任务 ${task.id} 的验证工具 ${check.tool} 当前不可用，请先核对实际工具定义`)
      if (!schema) continue
      const required = schema.required ?? Object.entries(schema.properties ?? {}).filter(([, field]) => field?.required === true).map(([name]) => name)
      for (const name of required) if (!Object.hasOwn(check.arguments, name)) throw new Error(`任务 ${task.id} 的 ${check.tool} 验证参数缺少必填字段 ${name}；请按当前工具 schema 修正任务卡`)
      for (const [name, value] of Object.entries(check.arguments)) {
        const field = schema.properties?.[name]
        if (!field && schema.additionalProperties === false) throw new Error(`任务 ${task.id} 的 ${check.tool} 不接受参数 ${name}`)
        if (field && typeof field.type === 'string') {
          const valid = field.type === 'integer' ? Number.isInteger(value) : field.type === 'array' ? Array.isArray(value)
            : field.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === field.type
          if (!valid) throw new Error(`任务 ${task.id} 的 ${check.tool} 参数 ${name} 应为 ${field.type}`)
        }
      }
    }
  }
  async function preflight(plan, parent, signal, retryTask) {
    validateChecks(plan.tasks.filter(task => task === retryTask || task.status === 'queued'), parent)
    let failure
    const checked = new Map()
    for (const task of plan.tasks) {
      if (task !== retryTask && task.status !== 'queued' && !(task.status === 'blocked' && task.issue?.code === 'MODEL_CONFIG_INVALID')) continue
      try {
        const { selected, source } = modelSelection(task, parent)
        recordModelSelection(task, selected, source)
        const key = JSON.stringify([modelRole(task), selected])
        if (!checked.has(key)) checked.set(key, validateModelRoute(service('llm'), selected, modelRole(task), signal))
        const resolved = await checked.get(key)
        recordModelSelection(task, selected, source, resolved)
        if (task.protocolVersion && task.complexity === 'complex') {
          const review = modelSelection({ role: 'reviewer', dispatcherModel: coordinatorModel(parent, task.attempts + 1) }, parent).selected
          const reviewKey = JSON.stringify(['reviewer', review])
          if (!checked.has(reviewKey)) checked.set(reviewKey, validateModelRoute(service('llm'), review, 'reviewer', signal))
          await checked.get(reviewKey)
        }
        if (task.issue?.code === 'MODEL_CONFIG_INVALID') {
          task.status = 'queued'; task.error = null; task.issue = null
          remember(plan, 'task.unblocked', '模型配置检查通过，任务可继续派发', task)
        }
      } catch (error) {
        task.status = error.issue ? 'blocked' : 'failed'; task.error = messageOf(error); task.issue = error.issue ?? null
        failure ??= error
        remember(plan, task.status === 'blocked' ? 'task.blocked' : 'task.failed', task.error, task)
      }
    }
    if (failure) { plan.autoDispatch = false; await save(); throw failure }
  }
  async function launch(plan, owner, parent, reviewer = false) {
    invalidateCompletion(plan)
    const task = reviewer ? owner.audit : owner
    const key = targetKey(plan, task)
    const handle = { key, planSessionId: plan.sessionId, parent, task, owner, done: Promise.withResolvers(), controller: new AbortController(), receipt: null, settling: false }
    live.set(key, handle)
    task.status = 'starting'; task.error = null; task.issue = null
    delete task.stop
    task.execution = null; task.report = ''
    task.recovery = { used: 0, limit: RECOVERY_LIMIT }
    task.evidence = []; task.review = null; task.checks.forEach(check => { check.result = null })
    remember(plan, 'task.starting', '正在派发子任务', task)
    let modelChecked = false
    try {
      const dispatcher = reviewer ? owner.dispatcherModel ?? coordinatorModel(parent, owner.attempts, 'legacy-review') : coordinatorModel(parent, task.attempts + 1)
      if (reviewer) { owner.dispatcherModel ??= dispatcher; task.dispatcherModel ??= clone(owner.dispatcherModel) }
      await save()
      const subagents = service('subagents')
      if (!subagents?.startActivation) throw new Error('DSH subagents 服务不可用；请确认原生子 Agent provider 已加载')
      const { selected, source } = modelSelection(task, parent)
      recordModelSelection(task, selected, source)
      const resolved = await validateModelRoute(service('llm'), selected, modelRole(task), handle.controller.signal)
      handle.controller.signal.throwIfAborted()
      recordModelSelection(task, selected, source, resolved)
      if (!reviewer && task.complexity === 'complex') {
        await validateModelRoute(service('llm'), modelSelection({ role: 'reviewer', dispatcherModel: dispatcher }, parent).selected, 'reviewer', handle.controller.signal)
        handle.controller.signal.throwIfAborted()
      }
      modelChecked = true
      const budget = requireActivationBudget(plan)
      budget.used++
      plan.activationBudget.used = budget.used
      const timeoutMinutes = getConfig().taskTimeoutMinutes
      task.attempts++
      if (!reviewer) {
        task.dispatcherModel = dispatcher
        remember(plan, 'task.dispatcher_model', '已记录分发者模型，后续独立审查沿用：' + dispatcher.provider + ' / ' + dispatcher.model, task,
          { dispatcherModel: clone(dispatcher) })
      }
      task.startedAt = Date.now(); task.childId = randomUUID()
      startSupervision(task, task.startedAt, timeoutMinutes * 60_000)
      expectedRoutes.set(task.childId, { plan, task, handle, config: clone(resolved) })
      await save()
      handle.receipt = await subagents.startActivation({
        provider: 'spawn', childId: task.childId, label: task.title, delivery: task.protocolVersion >= 2 ? 'caller' : 'parent', signal: handle.controller.signal,
        request: { parent, ...(plan.cwd ? { cwd: plan.cwd } : {}), prompt: [{ type: 'text', text: reviewer ? auditPrompt(plan, owner) : workerPrompt(plan, task) }], agentOptions: clone(resolved),
          maxDepth: subagents.resolveMaxDepth?.() ?? 1 },
      })
      // Cancellation during admission must dispose the newly accepted child as well.
      if (handle.controller.signal.aborted || closed) {
        throw handle.controller.signal.reason ?? new Error('插件已停止')
      }
      if (handle.receipt.childId !== task.childId) throw new Error('DSH 返回的子会话编号与预留编号不一致，已停止该次派发')
      task.status = 'running'
      scheduleSupervision(plan, task, handle)
      onDelegated(plan.sessionId)
      remember(plan, 'task.dispatched', '已派发给子 Agent ' + task.childId + '；模型 ' +
        task.model.provider + ' / ' + task.model.model, task, { childId: task.childId, model: task.model, modelRoute: clone(task.modelRoute) })
      handle.receipt.result.then(result => settle(plan, task, handle, result), error => settle(plan, task, handle, undefined, error))
        .catch(error => { storageError = messageOf(error) })
      await save()
    } catch (error) {
      clearTaskTimers(handle)
      const issue = !error.issue && modelServiceIssue(error, modelRole(task), task.modelRoute?.actual ?? task.modelRoute?.resolved)
      if (issue) error = Object.assign(new Error(messageOf(error)), { issue })
      const releaseError = await releaseChild(handle, task)
      if (releaseError) error = new Error(`${messageOf(error)}；子 Agent 清理失败：${messageOf(releaseError)}`, { cause: error })
      if (live.get(key) === handle) live.delete(key)
      expectedRoutes.delete(task.childId)
      if (LIVE.includes(task.status)) { task.status = error.issue ? 'blocked' : 'failed'; task.error = messageOf(error); task.issue = error.issue ?? null }
      if (!modelChecked) plan.autoDispatch = false
      else if (['failed', 'blocked'].includes(task.status)) pauseAfterFailure(plan, task)
      task.finishedAt = Date.now()
      remember(plan, task.status === 'blocked' ? 'task.blocked' : 'task.failed', task.error, task)
      await save()
      handle.done.resolve()
      if (!modelChecked) return error
    }
  }
  function pump() {
    const operation = pumping.then(async () => {
      if (closed) return
      let failure
      let waitChanged = false
      const setWait = (plan, reason, message, details = {}) => {
        const next = { reason, message, ...details, at: plan.dispatchWait?.at ?? Date.now() }
        const previous = plan.dispatchWait
        if (previous?.reason === next.reason && previous?.message === next.message && previous?.active === next.active && previous?.limit === next.limit) return
        plan.dispatchWait = next
        remember(plan, 'plan.waiting', message)
        waitChanged = true
      }
      const clearWait = plan => {
        if (plan.dispatchWait === null || plan.dispatchWait === undefined) return
        plan.dispatchWait = null
        waitChanged = true
      }
      for (const plan of plans.values()) {
        if (!plan.autoDispatch || plan.cancelled || plan.tasks.some(task => task.recovered) || getConfig().enabled === false) continue
        const parent = service('agents')?.get(plan.sessionId)
        if (!parent) { plan.autoDispatch = false; continue }
        for (const owner of plan.tasks) {
          if (!plan.autoDispatch) break
          const reviewer = owner.status === 'review' && owner.audit?.status === 'queued'
          const task = reviewer ? owner.audit : owner
          if (task.status !== 'queued' || (!reviewer && !task.dependsOn.every(id => taskOf(plan, id).status === 'accepted'))) continue
          if (live.size >= getConfig().maxParallel) {
            setWait(plan, 'parallel', `正在等待并发名额：当前 ${live.size}/${getConfig().maxParallel} 个子任务在执行`, { active: live.size, limit: getConfig().maxParallel })
            break
          }
          if (activationBudget(plan, getConfig().maxActivations).remaining <= 0) {
            pauseAtActivationLimit(plan)
            waitChanged = true
            break
          }
          const active = [...plans.values()].flatMap(plan => plan.tasks).filter(item => [...LIVE, 'review'].includes(item.status))
          if (active.some(item => overlaps(task, item))) {
            const blocker = active.find(item => overlaps(task, item))
            setWait(plan, 'write-conflict', `正在等待写入冲突任务结束：${blocker.title}`, { taskId: blocker.id })
            continue
          }
          clearWait(plan)
          const error = await launch(plan, owner, parent, reviewer)
          failure ??= error
        }
      }
      if (waitChanged) await save()
      return failure
    })
    pumping = operation.catch(error => { storageError = messageOf(error) })
    return operation
  }
  function observe(exec, result) {
    const childPlan = [...plans.values()].find(plan => targetsOf(plan).some(task => task.childId === exec.agent?.id && LIVE.includes(task.status)))
    if (childPlan) {
      const task = targetsOf(childPlan).find(task => task.childId === exec.agent.id)
      task.progress = { tool: exec.name, at: Date.now(), failed: Boolean(result.isError) }
      if (result.isError) remember(childPlan, 'task.tool_failed', '执行工具失败：' + brief(exec.name, 100), task)
      const handle = live.get(targetKey(childPlan, task))
      const alert = observeTool(task, exec, result, Date.now())
      if (alert) requestSupervision(childPlan, task, handle, alert)
      if (handle) scheduleSupervision(childPlan, task, handle)
      backgroundSave()
    }
  }
  // Native local activations return only output + stopReason. Capture the
  // committed error before native cleanup releases the child Agent.
  disposers.push(ctx.on('session/event', (session, event) => {
    observeInput(session, event)
    const parentPlan = plans.get(session?.id)
    if (event?.type === 'assistant/message') {
      const expected = expectedRoutes.get(session?.id)
      if (!closed && getConfig().enabled !== false && (expected || service('agents')?.get(session?.id))) {
        if (expected) usageLedger.observeMessage(usageFor(session.id, expected), usageTarget(session.id, expected), event)
        else observeCoordinatorUsage(session.id, 'message', usageTarget(session.id), event)
        backgroundSave()
      }
      if (expected && !closed && !expected.plan.cancelled && !expected.handle.settling) {
        const alert = observeUsage(expected.task, event, Date.now())
        if (alert) requestSupervision(expected.plan, expected.task, expected.handle, alert)
        backgroundSave()
      }
      if (!closed && !parentPlan?.cancelled && parentPlan?.coordinatorIssue && !parentPlan.coordinatorIssue.resolvedAt) {
        parentPlan.coordinatorIssue.resolvedAt = Date.now()
        parentPlan.wakeSuppressed = false
        invalidateCompletion(parentPlan)
        remember(parentPlan, 'plan.coordinator_resumed', '主控模型已返回响应，继续核对原交付物并验证验收')
        backgroundSave()
      }
    }
    if (!closed && parentPlan?.protocolVersion >= 2 && planStatus(parentPlan) !== 'accepted' && event?.type === 'turn/end' && ['aborted', 'error'].includes(event.data?.reason?.kind)) {
      const aborted = event.data.reason.kind === 'aborted'
      const issue = !aborted && modelServiceIssue(event.data.reason.error, 'coordinator', usageTarget(session.id))
      if (issue) parentPlan.coordinatorIssue = issue
      const reason = aborted ? '宿主中断当前执行，尚未完成验收' : issue ? issue.message + '。' + issue.details : '主控执行失败：' + messageOf(event.data.reason.error)
      parentPlan.wakeSuppressed = true; parentPlan.autoDispatch = false
      invalidateCompletion(parentPlan)
      if (aborted) { parentPlan.cancelled = true; parentPlan.cancelledBy = 'host' }
      for (const task of targetsOf(parentPlan)) if (task.status !== 'accepted' && task.status !== 'completed' && (aborted || ['queued', ...LIVE].includes(task.status))) {
        if (aborted) task.stop = { reason, source: 'host', at: Date.now(), previousStatus: task.status }
        else {
          task.error ||= reason
          task.issue ||= issue || { code: 'COORDINATOR_FAILED', retryable: false, message: reason }
        }
        task.status = aborted ? 'cancelled' : 'blocked'
      }
      const handles = [...live.values()].filter(handle => handle.planSessionId === parentPlan.sessionId)
      for (const handle of handles) { clearTaskTimers(handle); handle.controller.abort(new Error(reason)) }
      return (async () => {
        await Promise.all(handles.map(async handle => {
          await releaseChild(handle, handle.task)
          if (live.get(handle.key) === handle) live.delete(handle.key)
          expectedRoutes.delete(handle.task.childId); handle.done.resolve()
        }))
        remember(parentPlan, aborted ? 'plan.host_cancelled' : 'plan.host_failed', reason)
        finishPlan(parentPlan, aborted ? null : reason)
        await save()
      })().catch(error => { storageError = messageOf(error) })
    }
    if (event?.type !== 'turn/end' || event.data?.reason?.kind !== 'error') return
    for (const plan of plans.values()) {
      const task = targetsOf(plan).find(task => task.childId === session?.id && LIVE.includes(task.status))
      const handle = task && live.get(targetKey(plan, task))
      if (handle && !handle.failure?.issue) handle.failure = event.data.reason.error
    }
  }, { global: true }))
  disposers.push(ctx.on('llm/stream', (request, next) => {
    const expected = expectedRoutes.get(request.sessionId)
    if (!expected) {
      const parentPlan = plans.get(request.sessionId)
      if (!closed && getConfig().enabled !== false && service('agents')?.get(request.sessionId)) {
        observeCoordinatorUsage(request.sessionId, 'request', usageTarget(request.sessionId, null, request))
        backgroundSave()
      }
      return parentPlan && !parentPlan.cancelled && !parentPlan.completion
        ? trackOutput(request.sessionId, next()) : next()
    }
    const { plan, task, handle, config } = expected
    const actual = { provider: request.provider, model: request.model,
      ...(request.reasoningEffort !== undefined ? { reasoningEffort: request.reasoningEffort } : {}) }
    if (closed || handle.controller.signal.aborted) throw handle.controller.signal.reason ?? new Error('插件已停止')
    const header = service('agents')?.get(request.sessionId)?.session?.requestHeader?.()
    if (!task.modelRoute.actual && config.reasoningEffort === undefined && task.modelRoute.requested.reasoningEffort === undefined &&
      header?.config?.provider === config.provider && header.config?.model === config.model &&
      actual.provider === config.provider && actual.model === config.model && actual.reasoningEffort !== undefined && header.config.reasoningEffort === actual.reasoningEffort) {
      config.reasoningEffort = actual.reasoningEffort
      task.modelRoute.resolved.reasoningEffort = actual.reasoningEffort
      task.modelRoute.defaultSource = 'native-request-header'
    }
    if (actual.provider !== config.provider || actual.model !== config.model || actual.reasoningEffort !== config.reasoningEffort) {
      const issue = { code: 'MODEL_ROUTE_MISMATCH', retryable: false, tier: modelRole(task), role: modelRole(task), expected: clone(config), received: actual,
        message: `模型请求与任务配置不一致，已在发送前阻止：预期 ${config.provider} / ${config.model}（思考强度 ${config.reasoningEffort ?? '未设置'}），收到 ${actual.provider} / ${actual.model}（思考强度 ${actual.reasoningEffort ?? '未设置'}）。请检查子任务配置后再明确重试` }
      const error = Object.assign(new Error(issue.message), { issue })
      handle.failure = error; task.issue = issue; task.error = issue.message
      task.modelRoute.rejected = actual
      remember(plan, 'task.model_mismatch', issue.message, task, { issue })
      pauseAfterFailure(plan, task)
      backgroundSave()
      throw error
    }
    const alert = observeRequest(task, Date.now())
    usageLedger.observeRequest(usageFor(request.sessionId, expected), usageTarget(request.sessionId, expected, request))
    if (alert) remember(plan, 'task.reminder', alert.reason, task)
    scheduleSupervision(plan, task, handle)
    if (JSON.stringify(task.modelRoute.actual) !== JSON.stringify(actual)) {
      task.modelRoute.actual = actual; task.modelRoute.checkedAt = Date.now()
      task.model = { ...actual, source: 'observed' }
      remember(plan, 'task.model_verified', '实际请求模型已核对：' + actual.provider + ' / ' + actual.model, task,
        { modelRoute: clone(task.modelRoute) })
    }
    backgroundSave()
    const stream = trackOutput(request.sessionId, next())
    if (!stream?.[Symbol.asyncIterator]) return stream
    return (async function* () {
      let received = false
      for await (const chunk of stream) {
        task.supervision.lastActivityAt = Date.now()
        if (!received && ['block-start', 'block-delta'].includes(chunk.type)) {
          received = true
          task.supervision.activity = { kind: 'model', at: Date.now() }
          backgroundSave()
        }
        yield chunk
      }
    })()
  }, { global: true }))
  const allowsVerification = exec => {
    const permit = permits.get(exec.callId)
    return Boolean(permit && permit.agent === exec.agent && permit.tool === exec.name && permit.arguments === JSON.stringify(exec.arguments))
  }
  async function executePermitted(parent, tool, args, exec) {
    const callId = `delegation-check-${randomUUID()}`
    permits.set(callId, { agent: parent, tool, arguments: JSON.stringify(args) })
    try {
      const invocation = { name: tool, arguments: clone(args), callId,
        rootCallId: exec.rootCallId ?? exec.callId, parent: exec.token, agent: parent,
        ...(exec.toolSet ? { toolSet: exec.toolSet } : {}),
        signal: exec.signal }
      // Current DSH dispatches complete batches, including a single verification call.
      const result = typeof ctx.tools.selectExecutor === 'function'
        ? (await ctx.tools.execute({ calls: [{ id: callId, name: tool, arguments: JSON.stringify(args) }],
          agent: parent, ...(exec.toolSet ? { toolSet: exec.toolSet } : {}), signal: invocation.signal })).results.find(item => item.callId === callId)?.result
        : await ctx.tools.execute(invocation)
      if (!result) throw new Error('DSH 未返回本次工具执行结果，不能据此判断成功')
      return { result, callId }
    } finally { permits.delete(callId) }
  }
  async function verify(args, exec) {
    const { plan, parent } = ownPlan(exec), task = taskOf(plan, args.taskId)
    if (task.status !== 'review') throw new Error('只有待评审任务可以运行主控验证')
    if (!Number.isInteger(args.checkIndex) || !task.checks[args.checkIndex]) throw new Error('验证步骤编号无效（从 0 开始）')
    const check = task.checks[args.checkIndex]
    if (check.verifying) throw new Error('该验证步骤正在执行')
    if (task.pendingAcceptance) throw new Error('验收结果正在确认，不能同时更换验证证据')
    invalidateCompletion(plan)
    check.verifying = true
    try {
      const { result, callId } = await executePermitted(parent, check.tool, check.arguments, exec)
      const value = result.value, exitCode = value?.exitCode
      const shell = ['pwsh', 'bash'].includes(check.tool)
      // Shell success requires an actual exit code. A background job or missing status is inconclusive.
      const passed = !result.isError && (!shell || exitCode === 0)
      const evidence = { callId, tool: check.tool, passed, at: Date.now(), attempt: task.attempts,
        summary: brief(textOf(result.content) || JSON.stringify(value), 2000), ...(shell ? { exitCode: exitCode ?? null } : {}) }
      check.result = evidence
      task.evidence = [...task.evidence, evidence].slice(-12)
      task.review = null
      remember(plan, 'task.verified', '主 Agent 验证' + (passed ? '通过：' : '未通过：') + check.tool,
        task, { evidence })
      await save()
      return evidence
    } finally { delete check.verifying }
  }
  async function review(args, exec) {
    const { plan } = ownPlan(exec), task = taskOf(plan, args.taskId)
    if (task.status !== 'review') throw new Error('只能评审已经返回结果的任务')
    if (task.pendingAcceptance) throw new Error('当前验收正在通过工具管线确认，不能重复提交')
    if (task.checks.some(check => check.verifying)) throw new Error('请等待正在执行的验证完成')
    if (args.verdict === 'rework') {
      const inputs = selectInputs(plan, args.inputIds), criteria = additionalCriteria(task, args, inputs)
      if (task.audit && ['queued', ...LIVE].includes(task.audit.status)) throw new Error('独立审查尚未结束，请等待结果，避免修改审查中的交付物')
      const issues = validateIssues(args.issues ?? [], task)
      if (!issues.every(issue => issue.evidence.every(id => task.evidence.some(item => item.callId === id && item.attempt === task.attempts)))) throw new Error('主控提出的问题必须引用本次实际验证的 callId；验证失败的证据也可引用')
      const selected = args.issueIds === undefined ? (task.issues ?? []).filter(issue => issue.status === 'open' && issue.severity !== 'minor').map(issue => issue.id) : strings(args.issueIds, '原问题编号', true)
      if (new Set(selected).size !== selected.length || selected.some(id => !(task.issues ?? []).some(issue => issue.id === id && issue.status === 'open' && issue.severity !== 'minor'))) throw new Error('返工问题编号不存在、重复或已解决')
      if ((task.issues ?? []).some(issue => issue.status === 'open' && issue.severity !== 'minor' && !selected.includes(issue.id))) throw new Error('不能遗漏仍未解决的重要问题')
      if (!inputs.length && !selected.length && !issues.some(issue => issue.severity !== 'minor')) {
        if (issues.length) {
          appendIssues(task, issues, 'coordinator'); remember(plan, 'task.suggestions', '仅记录可选建议，不开启返工', task)
          await save(); return { status: planStatus(plan), task: clone(task) }
        }
        if (task.protocolVersion) throw new Error('返工必须提供具体重要问题和实际证据，不能只要求继续优化')
      }
      if (task.attempts >= getConfig().maxAttempts) throw new Error('已达到执行次数上限，请报告失败原因，停止反复返工')
      if (activationBudget(plan, getConfig().maxActivations).remaining <= 0) {
        const message = pauseAtActivationLimit(plan); await save(); throw new Error(message)
      }
      appendIssues(task, issues, 'coordinator')
      task.reworkIds = [...selected, ...task.issues.filter(issue => issue.attempt === task.attempts && issue.source === 'coordinator' && issue.status === 'open').map(issue => issue.id)].filter((id, i, all) => all.indexOf(id) === i)
      const feedback = [task.reworkIds.length ? task.issues.filter(issue => task.reworkIds.includes(issue.id)).map(issue => `${issue.id}：${issue.finding}；证据：${issue.evidence.join('、')}`).join('\n') : requireText(args.feedback, '返工原因'),
        ...inputs.map(input => '用户补充：' + input.text)].join('\n')
      forwardInputs(plan, task, inputs, criteria, feedback)
      invalidateCompletion(plan)
      task.feedback = feedback; task.status = 'queued'; task.evidence = []; task.review = null
      task.audit = null
      task.checks.forEach(check => { check.result = null })
      remember(plan, 'task.rework', '主 Agent 要求返工：' + feedback, task)
    } else if (args.verdict === 'accept') {
      if (unresolvedInputs(plan).length) throw new Error('还有未处理的用户补充消息；先同步新增要求或用 acknowledge 说明纯答复，再验收')
      if (task.protocolVersion && (task.complexity === 'complex' || task.audit) &&
          (task.audit?.forAttempt !== task.attempts || task.audit.status !== 'completed' || task.audit.specVerdict !== 'pass' || task.audit.qualityVerdict !== 'pass')) throw new Error('本次执行的独立审查尚未通过，不能验收；请核对审查状态和具体问题')
      const resolutions = args.resolutions ?? [], openIssues = (task.issues ?? []).filter(issue => issue.status === 'open' && issue.severity !== 'minor')
      if (!Array.isArray(resolutions) || new Set(resolutions.map(item => item.id)).size !== resolutions.length ||
          resolutions.some(item => task.audit || item.status !== 'ADDRESSED' || !openIssues.some(issue => issue.id === item.id) || !Array.isArray(item.evidence) || !item.evidence.length ||
            !item.evidence.every(id => task.evidence.some(evidence => evidence.callId === id && evidence.passed && evidence.attempt === task.attempts)))) throw new Error('原问题只能用本次实际验证的证据逐条确认解决，独立审查的问题须由审查者复查')
      if (openIssues.some(issue => !resolutions.some(item => item.id === issue.id))) throw new Error('仍有未解决的重要问题，必须逐条提交本次验证证据')
      if (task.execution?.status === 'DONE_WITH_CONCERNS') requireText(args.concernsResolution, '主控对执行疑点的处理说明', 2000)
      if (!task.checks.every(check => check.result?.passed && check.result.attempt === task.attempts)) throw new Error('主控验证尚未全部通过，不能验收')
      if (!Array.isArray(args.findings) || args.findings.length !== task.criteria.length) throw new Error('必须逐条提交验收标准的结论和证据')
      const seen = new Set()
      for (const finding of args.findings) {
        if (!Number.isInteger(finding.criterion) || !task.criteria[finding.criterion] || seen.has(finding.criterion)) throw new Error('验收标准编号缺失或重复')
        seen.add(finding.criterion)
        requireText(finding.finding, '验收结论', 1000)
        if (!Array.isArray(finding.evidence) || !finding.evidence.length || !finding.evidence.every(id => task.evidence.some(item => item.callId === id && item.passed && item.attempt === task.attempts))) throw new Error('验收证据必须引用本次主控验证实际返回的 callId')
      }
      const closeIssues = () => { for (const resolution of resolutions) {
        const issue = task.issues.find(item => item.id === resolution.id)
        issue.status = 'addressed'; issue.resolutionEvidence = clone(resolution.evidence); issue.reviewedAttempt = task.attempts
      } }
      const acceptedReview = { findings: clone(args.findings), ...(args.concernsResolution ? { concernsResolution: args.concernsResolution } : {}), at: Date.now() }
      if (plan.protocolVersion >= 2) {
        if (typeof exec.concludeTurn !== 'function') throw new Error('DSH 未提供 concludeTurn，不能保证验收后自动结束')
        invalidateCompletion(plan)
        task.pendingAcceptance = acceptedReview
        await save()
        const proposed = { ...plan, tasks: plan.tasks.map(item => item.pendingAcceptance ? { ...item, status: 'accepted', review: item.pendingAcceptance } : item) }
        const completion = buildCompletion(proposed)
        stagedResults.set(exec, {
          async commit() {
            if (task.status !== 'review' || task.pendingAcceptance !== acceptedReview || plan.cancelled) return
            if (unresolvedInputs(plan).length) {
              delete task.pendingAcceptance
              remember(plan, 'task.acceptance_deferred', '验收期间收到用户补充，原结果尚未验收', task)
              await save(); return
            }
            closeIssues(); task.review = acceptedReview; task.status = 'accepted'; delete task.pendingAcceptance
            remember(plan, 'task.accepted', '主 Agent 已逐条验收通过', task, { findings: task.review.findings })
            if (planStatus(plan) === 'accepted') {
              remember(plan, 'plan.completed', '所有子任务已验收，计划完成')
              if (completion && !plan.completion) {
                plan.completion = completion
                remember(plan, 'plan.receipt', completionText(completion), undefined, { completion })
              } else finishPlan(plan)
            }
            try { await save() } catch (error) { task.status = 'review'; task.review = null; plan.completion = null; throw error }
            await pump()
          },
          async rollback() {
            delete task.pendingAcceptance
            remember(plan, 'task.acceptance_rejected', '验收未通过实际工具管线确认，尚未生成完成回执', task)
            await save()
          } })
        const continuation = completion && sourceOf(plan.sessionId)?.messageId && sourceOf(plan.sessionId).messageId !== plan.source?.messageId
          ? '旧需求计划已验收；当前还有另一项已确认需求：' + sourceOf(plan.sessionId).text + '。请继续处理当前需求，旧回执不代表新需求已完成。' : null
        if (completion && !continuation && !pendingMessages(plan.sessionId).length) exec.concludeTurn()
        return { status: planStatus(proposed), task: clone(proposed.tasks.find(item => item.id === task.id)), completion, ...(continuation ? { continuation } : {}) }
      }
      closeIssues(); task.review = acceptedReview; task.status = 'accepted'
      remember(plan, 'task.accepted', '主 Agent 已逐条验收通过', task, { findings: task.review.findings })
      if (planStatus(plan) === 'accepted') remember(plan, 'plan.completed', '所有子任务已验收，计划完成')
    } else throw new Error('verdict 只能是 accept 或 rework')
    plan.updatedAt = Date.now()
    await save(); await pump()
    return { status: planStatus(plan), task: clone(task) }
  }
  async function control(args, exec) {
    const { plan, parent } = ownPlan(exec)
    if (args.action === 'acknowledge') {
      const inputs = selectInputs(plan, args.inputIds), message = requireText(args.message, '补充消息处理说明')
      if (!inputs.length) throw new Error('acknowledge 必须指定 inputIds')
      for (const input of inputs) Object.assign(input, { status: 'resolved', handledAt: Date.now(), resolution: message })
      remember(plan, 'plan.input_resolved', message, undefined, { inputIds: inputs.map(input => input.id) })
      await save(); return { status: planStatus(plan), inputIds: inputs.map(input => input.id) }
    }
    const task = taskOf(plan, args.taskId)
    if (task.status === 'accepted') {
      if (args.action === 'stop') return { task: clone(task), status: planStatus(plan) }
      throw new Error('已验收的任务不能重试；后续需求请建立新计划')
    }
    if (args.action === 'steer') {
      const target = task.audit?.status === 'running' ? task.audit : task
      if (target.status !== 'running') throw new Error('只能向正在执行的子任务发送纠偏消息')
      if (target.execution || task.pendingAcceptance || task.checks.some(check => check.verifying)) throw new Error('报告或验证正在确认；请等待结果，核对补充要求后再决定返工')
      const inputs = selectInputs(plan, args.inputIds), criteria = additionalCriteria(task, args, inputs)
      const message = [requireText(args.message, '纠偏内容'), ...inputs.map(input => '用户补充：' + input.text),
        ...(criteria.length ? ['新增验收标准：', ...criteria] : [])].join('\n')
      const messageId = await service('subagents').sendMessage(parent, target.childId, [{ type: 'text', text: message }], { signal: exec.signal })
      forwardInputs(plan, task, inputs, criteria, message, messageId)
      target.progress = { tool: '主控纠偏', at: Date.now(), message: brief(message, 500) }
      if (target.supervision?.pending) {
        const state = target.supervision
        if (!state.pending.advisory) state.used++
        state.lastCorrection = { at: Date.now(), message, messageId, alert: state.pending }
        state.pending = null; state.failure = null
        scheduleSupervision(plan, target, live.get(targetKey(plan, target)))
      }
      remember(plan, 'task.steered', '主 Agent 纠偏：' + message, task)
      await save(); return { messageId }
    }
    if (args.action === 'stop') {
      const reason = task.protocolVersion >= 2 ? requireText(args.reason, '取消原因；完成后无需 stop，请提交报告并验收', 2000) : args.reason || '主控已停止任务'
      invalidateCompletion(plan)
      task.stop = { reason, source: 'coordinator', at: Date.now(), previousStatus: task.status }
      task.status = 'cancelled'; plan.autoDispatch = false; plan.dispatchWait = null
      for (const target of task.audit ? [task, task.audit] : [task]) {
        const targetId = targetKey(plan, target), handle = live.get(targetId)
        target.status = 'cancelled'
        if (handle) {
          handle.controller.abort(new Error('任务已取消：' + reason))
          clearTaskTimers(handle)
          const releaseError = await releaseChild(handle, target)
          if (releaseError) throw releaseError
          await pumping
          if (live.get(targetId) === handle) live.delete(targetId)
          expectedRoutes.delete(target.childId)
          handle.done.resolve()
        } else if (target.recovered && target.childId) {
          await service('subagents').drainChildren(parent, [target.childId])
        }
        target.recovered = false
      }
      task.recovered = false
      remember(plan, 'task.stopped', '主 Agent 已取消子任务：' + reason, task, { stop: task.stop })
      if (!cancellingPlans.has(plan)) finishPlan(plan)
    } else if (args.action === 'retry') {
      if (task.recovered) throw new Error('请先 stop 旧子任务，再 retry')
      if (!['failed', 'blocked', 'cancelled'].includes(task.status)) throw new Error('只能重试失败、阻塞或已停止的任务')
      if (task.attempts >= getConfig().maxAttempts) throw new Error('已达到执行次数上限')
      if (activationBudget(plan, getConfig().maxActivations).remaining <= 0) {
        const message = pauseAtActivationLimit(plan); await save(); throw new Error(message)
      }
      const feedback = requireText(args.message, '重试依据：说明已解决哪个问题')
      await preflight(plan, parent, exec.signal, task)
      invalidateCompletion(plan)
      plan.wakeSuppressed = false; plan.cancelled = false
      task.feedback = feedback; task.status = 'queued'; task.error = null; task.issue = null; plan.autoDispatch = true
      remember(plan, 'task.retry', '主 Agent 决定重试：' + feedback, task, { ...(task.stop ? { stop: clone(task.stop) } : {}) })
    } else throw new Error('action 只能是 steer、stop、retry 或 acknowledge')
    await save(); const failure = await pump(); if (failure) throw failure
    return { task: clone(task), status: planStatus(plan) }
  }

  const string = { type: 'string' }
  const array = items => ({ type: 'array', items })
  const object = properties => ({ type: 'object', properties, additionalProperties: false })
  const routeTool = (name, description, properties, required, execute, child = false) => {
    const definition = { name, description, parameters: { ...object(properties), required },
      output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => [{ type: 'text', text: value.completion ? [completionText(value.completion), value.continuation].filter(Boolean).join('\n') : JSON.stringify(args.detail === 'full' ? value : compactResult(value)) }] },
      async execute(args, exec) { await ready; if (committing.size) await Promise.all(committing); if (!child) own(exec); return execute(args, exec) } }
    disposers.push(ctx.tools.register(definition))
  }
  routeTool('delegation_decide', '主控结合上下文确认消息关联：new 新需求、continue 继续、update 补充或调整、question 询问进度或提问。新需求/方案变化同时提供 direct/delegate 和理由；继续/询问沿用原决定。messageId 只能引用本会话真实消息，多条待关联时必填。先读文件准备，普通正文不能代替记录。', {
    relation: { type: 'string', enum: ['new', 'continue', 'update', 'question'] }, messageId: string,
    mode: { type: 'string', enum: ['direct', 'delegate'] }, reason: { type: 'string', description: '新需求或方案变化时给出具体理由，最多 500 字；继续和进度询问沿用原判断。' },
  }, [], recordDecision)
  routeTool('delegation_checkpoint', '托管执行者或只读审查者在长调查、阶段转换或阻塞时记录结论、下一步和成功工具证据。短任务只交最终报告；阶段记录不能代替验收或其他任务的记录。', {
    phase: { type: 'string', enum: ['investigation', 'implementation', 'verification'] }, summary: string, nextStep: string, evidence: array(string),
  }, ['phase', 'summary', 'nextStep', 'evidence'], async (args, exec) => {
    const expected = expectedRoutes.get(exec.agent?.id)
    if (!expected) throw new Error('只有当前托管子代理可以提交阶段记录')
    const { plan, task, handle } = expected
    if (handle.controller.signal.aborted || task.execution || !LIVE.includes(task.status)) throw new Error('任务已结束或正在提交最终报告')
    if (!['investigation', 'implementation', 'verification'].includes(args.phase)) throw new Error('阶段无效')
    const summary = requireText(args.summary, '阶段结论', 2000), nextStep = requireText(args.nextStep, '下一步', 1000)
    const evidence = strings(args.evidence, '阶段证据')
    if (evidence.length > 8 || evidence.some(id => !task.supervision.evidence.some(item => item.callId === id && !item.failed))) throw new Error('阶段证据必须来自当前子任务本次执行成功返回的工具')
    task.supervision.checkpoint = { phase: args.phase, summary, nextStep, evidence, at: Date.now(), verified: false }
    task.supervision.lastProgressAt = task.supervision.checkpoint.at
    task.supervision.lastActivityAt = task.supervision.checkpoint.at
    task.supervision.activity = { kind: 'waiting_model', at: task.supervision.checkpoint.at }
    scheduleSupervision(plan, task, handle)
    remember(plan, 'task.checkpoint', summary, task, { checkpoint: clone(task.supervision.checkpoint) })
    await save()
    return { taskId: task.id, checkpoint: clone(task.supervision.checkpoint), deadlineAt: task.supervision.deadlineAt }
  }, true)
  routeTool('delegation_report', '提交当前子任务的正式报告，通过实际工具管线确认后自动结束回合。身份、任务和执行次数由插件绑定，不能替他人报告。缺上下文或阻塞会暂停派单，不自动重试。', {
    status: { type: 'string', enum: ['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED'] },
    summary: string, report: string, reason: string, concerns: array(string),
    specVerdict: { type: 'string', enum: ['pass', 'fail'] }, qualityVerdict: { type: 'string', enum: ['pass', 'fail'] },
    issues: array({ ...object({ criterion: { type: 'integer' }, severity: { type: 'string', enum: ['critical', 'important', 'minor'] }, finding: string, evidence: array(string), introducedByFix: { type: 'boolean' } }), required: ['criterion', 'severity', 'finding', 'evidence'] }),
    resolutions: array({ ...object({ id: string, status: { type: 'string', enum: ['ADDRESSED', 'NOT_ADDRESSED'] }, evidence: array(string) }), required: ['id', 'status', 'evidence'] }),
  }, ['status', 'summary', 'report'], async (args, exec) => {
    const expected = expectedRoutes.get(exec.agent?.id)
    if (!expected || service('agents')?.get(exec.agent.id) !== exec.agent || expected.handle.settling || expected.handle.controller.signal.aborted) throw new Error('只有当前执行者的子会话身份可以提交报告；任务已结束时不能覆盖')
    const { plan, task } = expected
    if (task.execution) throw new Error('当前执行者已经提交最终报告，不能重复覆盖')
    if (!['DONE', 'DONE_WITH_CONCERNS', 'NEEDS_CONTEXT', 'BLOCKED'].includes(args.status)) throw new Error('报告状态无效')
    const summary = requireText(args.summary, '报告摘要', 1000), report = requireText(args.report, '完整报告', 24000)
    const reason = ['NEEDS_CONTEXT', 'BLOCKED'].includes(args.status) ? requireText(args.reason, '阻塞或缺上下文的原因', 2000) : null
    const concerns = strings(args.concerns ?? [], '疑点', true)
    if (args.status === 'DONE_WITH_CONCERNS' && !concerns.length) throw new Error('完成但有疑点时必须说明 concerns')
    if (task.role === 'reviewer' && ['DONE', 'DONE_WITH_CONCERNS'].includes(args.status)) {
      if (!['pass', 'fail'].includes(args.specVerdict) || !['pass', 'fail'].includes(args.qualityVerdict) || !Array.isArray(args.issues) || args.issues.length > 20) throw new Error('独立审查必须同时提供需求与质量结论，以及 issues 数组')
      const owner = expected.handle.owner, issues = validateIssues(args.issues, owner), ids = owner.reworkIds ?? []
      const resolutions = args.resolutions ?? []
      if (!Array.isArray(resolutions) || resolutions.length !== ids.length || new Set(resolutions.map(item => item.id)).size !== ids.length || resolutions.some(item => !ids.includes(item.id))) throw new Error('复查必须逐条回答全部原问题，不能新增或遗漏编号')
      for (const item of resolutions) {
        if (!['ADDRESSED', 'NOT_ADDRESSED'].includes(item.status)) throw new Error('原问题处理状态无效')
        strings(item.evidence, '复查证据')
      }
      if (ids.length && issues.some(issue => issue.severity !== 'minor' && !issue.introducedByFix)) throw new Error('复查范围外的新发现不能阻止验收；重要新问题必须证明由本次修复引入')
      const blocking = issues.some(issue => issue.severity !== 'minor') || resolutions.some(item => item.status === 'NOT_ADDRESSED')
      if ((args.specVerdict === 'fail' || args.qualityVerdict === 'fail') && !blocking) throw new Error('审查未通过必须指出具体重要问题')
      if (blocking && args.specVerdict === 'pass' && args.qualityVerdict === 'pass') throw new Error('存在重要问题时不能声明审查通过')
      task.specVerdict = args.specVerdict; task.qualityVerdict = args.qualityVerdict; task.issues = issues; task.resolutions = clone(resolutions)
    } else if (task.role !== 'reviewer' && (args.specVerdict || args.qualityVerdict || args.issues)) throw new Error('执行者不能提交独立审查结论')
    expected.handle.reportConfirmed = Promise.withResolvers()
    task.report = report
    task.execution = { status: args.status, summary, reason, concerns, attempt: task.attempts, at: Date.now(), reportPath: records.reportPath(plan, task),
      ...(task.protocolVersion >= 2 ? { commitState: 'prepared' } : {}) }
    const reportEvent = () => remember(plan, 'task.reported', summary, task, { execution: clone(task.execution), report,
      ...(task.role === 'reviewer' ? { forAttempt: task.forAttempt, specVerdict: task.specVerdict, qualityVerdict: task.qualityVerdict, issues: task.issues ?? [], resolutions: task.resolutions ?? [] } : {}) })
    if (task.protocolVersion >= 2) {
      if (typeof exec.concludeTurn !== 'function') { task.execution = null; expected.handle.reportConfirmed.resolve(false); throw new Error('DSH 未提供 concludeTurn，不能保证报告提交后自动结束') }
      try { await save() } catch (error) { task.execution = null; expected.handle.reportConfirmed.resolve(false); throw error }
      stagedResults.set(exec, { handle: expected.handle,
        async commit() {
          if (expected.handle.controller.signal.aborted || task.childId !== exec.agent.id) { expected.handle.reportConfirmed.resolve(false); return }
          try { task.execution.commitState = 'committed'; reportEvent(); await save(); expected.handle.reportConfirmed.resolve(true) }
          catch (error) { expected.handle.reportConfirmed.resolve(false); throw error }
        },
        async rollback() {
          task.execution = null
          expected.handle.reportConfirmed.resolve(false)
          remember(plan, 'task.report_rejected', '报告未通过实际工具管线确认，尚不能验收', task)
          await save()
        } })
      exec.concludeTurn()
    } else { reportEvent(); await save() }
    return { status: args.status, taskId: task.id, attempt: task.attempts, reportPath: task.execution.reportPath }
  }, true)
  routeTool('delegation_inspect', '准备阶段只读检查：list 列出当前目录前 200 项（不递归）；git_status 查看 Git 基线。只接受操作类型与目录，不接受脚本，不占业务操作额度。深层检索使用 glob/grep。', {
    operation: { type: 'string', enum: ['list', 'git_status'] }, directory: string,
  }, ['operation'], async (args, exec) => {
    if (Object.keys(args).some(key => !['operation', 'directory'].includes(key))) throw new Error('检查参数只接受 operation 和 directory，不接受命令脚本')
    if (!['list', 'git_status'].includes(args.operation)) throw new Error('检查操作只能是 list 或 git_status')
    const parent = own(exec), cwd = parent.session?.header?.cwd
    if (args.directory !== undefined) requireText(args.directory, '检查目录', 4000)
    if (!args.directory && !cwd) throw new Error('当前会话未提供目录，请指定 directory')
    const directory = path.resolve(cwd ?? process.cwd(), args.directory ?? '.')
    const literal = "'" + directory.replaceAll("'", "''") + "'"
    const command = args.operation === 'list'
      ? `Microsoft.PowerShell.Management\\Get-ChildItem -LiteralPath ${literal} -Force | Microsoft.PowerShell.Utility\\Select-Object -First 200 Name,Mode,Length`
      : `& (Microsoft.PowerShell.Core\\Get-Command git -CommandType Application | Microsoft.PowerShell.Utility\\Select-Object -First 1).Source --no-optional-locks -c core.fsmonitor=false --no-pager -C ${literal} status --short --branch --untracked-files=normal | Microsoft.PowerShell.Utility\\Select-Object -First 200`
    const parameters = ctx.tools.schemas?.(parent)?.find(tool => tool.name === 'pwsh')?.parameters
    const nativeArgs = { command, ...(!parameters || parameters.properties?.description ? { description: '读取目录或 Git 状态，记录任务基线' } : {}) }
    const { result, callId } = await executePermitted(parent, 'pwsh', nativeArgs, exec)
    return { operation: args.operation, directory, limit: 200, callId, passed: !result.isError && result.value?.exitCode === 0,
      exitCode: result.value?.exitCode ?? null, output: brief(textOf(result.content), 16000) }
  })
  routeTool('delegation_note', '保存当前会话、本次需求的准备记录：task_plan、findings、progress。插件确定专用目录并返回路径；不接受业务路径，不占业务操作额度。content 替换该份记录，最多 64 KiB。', {
    kind: { type: 'string', enum: ['task_plan', 'findings', 'progress'] }, content: string,
  }, ['kind', 'content'], async (args, exec) => {
    if (Object.keys(args).some(key => !['kind', 'content'].includes(key))) throw new Error('记录参数只接受 kind 和 content，文件路径由插件确定')
    if (!['task_plan', 'findings', 'progress'].includes(args.kind)) throw new Error('记录文件 kind 只能是 task_plan、findings 或 progress')
    if (typeof args.content !== 'string' || Buffer.byteLength(args.content, 'utf8') > 64 * 1024) throw new Error('记录内容必须是最多 64 KiB 的文字')
    const parent = own(exec), source = sourceOf(parent.id)
    if (!noteRequests.has(parent.id)) noteRequests.set(parent.id, randomUUID())
    const requestId = source?.messageId ?? source?.text ?? noteRequests.get(parent.id)
    const hash = value => createHash('sha256').update(String(value)).digest('hex')
    await mkdir(path.dirname(file), { recursive: true })
    const base = await realpath(path.dirname(file))
    const segments = [path.basename(file) + '.notes', hash(parent.id), hash(requestId)]
    const target = path.join(base, ...segments, args.kind + '.md')
    const write = (noteWrites.get(target) ?? Promise.resolve()).catch(() => {}).then(async () => {
      let directory = base
      for (const segment of segments) {
        directory = path.join(directory, segment)
        try { await mkdir(directory) } catch (error) { if (error.code !== 'EEXIST') throw error }
        const info = await lstat(directory)
        if (!info.isDirectory() || info.isSymbolicLink() || normalizedPath(await realpath(directory)) !== normalizedPath(directory)) throw new Error('准备记录目录不能包含链接或跳转')
      }
      const existing = await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error })
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('准备记录文件不能是链接或目录')
      const temporary = target + '.' + randomUUID() + '.tmp'
      try {
        const output = await open(temporary, 'wx')
        try { await output.writeFile(args.content, 'utf8') } finally { await output.close() }
        await rename(temporary, target)
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    })
    noteWrites.set(target, write)
    try { await write } finally { if (noteWrites.get(target) === write) noteWrites.delete(target) }
    return { path: target, sessionId: parent.id, requestId: source?.messageId ?? null, kind: args.kind }
  })
  routeTool('delegation_plan', '主控提交可验证的任务拆分。包含依赖、可修改路径、验收标准和主控验证工具参数；不开始执行。', {
    goal: string, relation: { type: 'string', enum: ['new', 'continue', 'update', 'question'] }, messageId: string,
    decisionReason: { type: 'string', description: '非空，最多 500 字；可在建计划时一并记录委派理由及 relation；不填写时需在 run 前记录。' }, tasks: array({ ...object({ id: string, title: string, instructions: string, scope: string,
      outputs: array(string), writes: array(string), dependsOn: array(string), complexity: { type: 'string', enum: ['routine', 'complex'] }, complexityReason: string,
      criteria: array(string), checks: array({ ...object({ tool: { type: 'string', enum: CHECK_TOOLS }, arguments: { type: 'object', additionalProperties: true } }), required: ['tool', 'arguments'] }) }),
      required: ['id', 'title', 'instructions', 'scope', 'outputs', 'writes', 'complexity', 'criteria', 'checks'] }),
  }, ['goal', 'tasks'], async (args, exec) => {
    const parent = own(exec), previous = plans.get(parent.id)
    if (storageError) throw new Error(`任务保存或恢复异常，请先处理：${storageError}`)
    if (previous && !['accepted', 'cancelled'].includes(planStatus(previous))) throw new Error('当前计划尚未验收；请监督、返工或取消后再建新计划')
    if (pendingMessages(parent.id).length && args.decisionReason === undefined) throw new Error('建立计划前须明确消息关联；可在本次 delegation_plan 一并提供 relation/messageId/decisionReason，或先用 delegation_decide 确认')
    const validated = validatePlan(args)
    validateChecks(validated.tasks, parent, exec.toolSet)
    if (args.decisionReason !== undefined) await recordDecision({ mode: 'delegate', reason: args.decisionReason, relation: args.relation, messageId: args.messageId }, exec)
    if (!previous && plans.size >= MAX_PLANS) {
      const oldest = [...plans.values()].filter(plan => ['accepted', 'cancelled'].includes(planStatus(plan))).sort((a, b) => a.updatedAt - b.updatedAt)[0]
      if (!oldest) throw new Error(`已有 ${MAX_PLANS} 个未完成计划，请先完成或取消`)
      plans.delete(oldest.sessionId)
    }
    const cwd = parent.session?.header?.cwd
    if (cwd) for (const task of validated.tasks) task.writes = task.writes.map(value => path.resolve(cwd, value))
    const source = sourceOf(parent.id)
    const routing = getRoute(parent.id)
    const sessionTitle = service('sessionTitle')?.get(parent.session)?.title
    const plan = { ...validated, protocolVersion: 2, decisionProtocolVersion: 2, messageResolution: clone(decisions.get(parent.id)?.messageResolution ?? null), decision: decisionCurrent(parent.id) ? decisionFor(parent.id) : null,
      completion: null, recovery: { used: 0, limit: RECOVERY_LIMIT }, source: source ? clone(source) : null,
      usage: usageLedger.request(parent.id, source),
      ...(routing ? { routing: clone(routing), routingWarnings: routeWarnings(routing, validated.tasks) } : {}),
      activationBudget: { limit: getConfig().maxActivations, used: 0 },
      ...(typeof sessionTitle === 'string' ? { sessionTitle } : {}), ...(cwd ? { cwd } : {}), sessionId: parent.id,
      createdAt: Date.now(), updatedAt: Date.now(), autoDispatch: false, cancelled: false, cancelledBy: null, dispatchWait: null }
    remember(plan, 'plan.created', '计划已建立，共 ' + plan.tasks.length + ' 个子任务')
    plans.set(parent.id, plan); await save(); return { plan: snapshot().find(plan => plan.sessionId === parent.id) }
  })
  routeTool('delegation_run', '按依赖和全局并发上限执行当前计划。无依赖任务自动派单；前置任务须主控验收后才继续。若返回 dispatchWait，说明正在等待其他会话释放名额或写入冲突结束，等待即可，不要反复调用。失败不自动重试；历史无原因取消在明确继续且仍有执行额度时沿用原计划恢复。', {}, [], async (_args, exec) => {
    const { plan, parent } = ownPlan(exec)
    if (getConfig().enabled && plan.decisionProtocolVersion >= 1 && (!decisionCurrent(parent.id) || decisionFor(parent.id).mode !== 'delegate')) throw new Error('启动前请用 delegation_decide 记录 delegate 和具体理由，再自动继续 delegation_run；建计划时可用 decisionReason 一并记录')
    if (plan.cancelled) {
      const recoverable = recoverableTasks(plan, true)
      if (!recoverable.length) throw new Error('计划已取消，请提高 maxAttempts 后明确 retry，或创建新计划')
      queuePlanRecovery(plan, recoverable, '上一轮计划被无原因取消；沿用原任务继续，先核对已有产物和失败原因，再完成本次任务。')
      await save()
    }
    if (plan.tasks.some(task => task.recovered)) throw new Error('请先用 delegation_control stop 清理恢复前的子任务，再继续执行')
    if (activationBudget(plan, getConfig().maxActivations).remaining <= 0 && plan.tasks.some(task => task.status === 'queued')) {
      const message = pauseAtActivationLimit(plan); await save(); throw new Error(message)
    }
    await preflight(plan, parent, exec.signal)
    plan.wakeSuppressed = false
    plan.autoDispatch = true; remember(plan, 'plan.started', '开始按依赖与并发限制执行计划')
    await save(); const failure = await pump(); if (failure) throw failure
    return { plan: snapshot().find(item => item.sessionId === plan.sessionId) }
  })
  routeTool('delegation_status', '默认返回当前计划摘要及报告路径。detail=full 必须指定 taskId，仅读取该任务完整报告和证据；不要反复读取全量详情。', {
    taskId: string, detail: { type: 'string', enum: ['summary', 'full'] },
  }, [], async (args, exec) => {
    const { plan } = ownPlan(exec)
    if (args.detail !== undefined && !['summary', 'full'].includes(args.detail)) throw new Error('detail 只能是 summary 或 full')
    if (args.detail === 'full' && !args.taskId) throw new Error('完整详情必须指定 taskId，只读取一个任务')
    if (args.taskId) return { status: planStatus(plan), task: clone(taskOf(plan, args.taskId)), storageError }
    return { plan: snapshot().find(item => item.sessionId === plan.sessionId), storageError }
  })
  routeTool('delegation_verify', '主控执行任务卡上指定的验证步骤（checkIndex 从 0 开始）。通过 DSH 工具管线，返回真实证据 callId；不消耗动手预算。', { taskId: string, checkIndex: { type: 'integer' } }, ['taskId', 'checkIndex'], verify)
  routeTool('delegation_audit', '对已返回任务安排一个独立只读审查，复杂任务会自动安排。重复请求不会重复开启；失败后的重试必须说明已处理的原因，同样受启动预算与次数限制。', {
    taskId: string, message: string,
  }, ['taskId'], async (args, exec) => {
    const { plan, parent } = ownPlan(exec), task = taskOf(plan, args.taskId)
    if (plan.cancelled || task.status !== 'review' || !task.execution || !['DONE', 'DONE_WITH_CONCERNS'].includes(task.execution.status)) throw new Error('只有已提交完整报告的待验收任务才能独立审查')
    const originalAudit = task.audit, originalStatus = task.audit?.status, originalAttempt = task.attempts
    if (task.audit?.forAttempt === task.attempts) {
      if (task.audit.recovered) throw new Error('重载中断的旧审查须先 stop 清理，不能直接重开')
      if (['completed', ...LIVE].includes(task.audit.status)) return { audit: clone(task.audit) }
      if (task.audit.status !== 'queued') {
        requireText(args.message, '审查重试依据：说明已处理的原因', 2000)
        if (task.audit.attempts >= getConfig().maxAttempts) throw new Error('独立审查已达到次数上限，停止反复重开')
      }
    }
    if (activationBudget(plan, getConfig().maxActivations).remaining <= 0) {
      const message = pauseAtActivationLimit(plan); await save(); throw new Error(message)
    }
    task.dispatcherModel ??= coordinatorModel(parent, task.attempts, 'legacy-review')
    if (task.audit) task.audit.dispatcherModel ??= clone(task.dispatcherModel)
    const target = task.audit ?? { ...task, role: 'reviewer' }
    const { selected } = modelSelection(target, parent)
    await validateModelRoute(service('llm'), selected, 'reviewer', exec.signal)
    if (closed || plan.cancelled || task.status !== 'review' || task.attempts !== originalAttempt) throw new Error('模型检查期间任务状态已改变，审查未启动')
    if (task.audit !== originalAudit || task.audit?.status !== originalStatus) return { audit: clone(task.audit) }
    if (!task.audit || task.audit.forAttempt !== task.attempts) queueAudit(task)
    task.audit.status = 'queued'; task.audit.error = null; task.audit.issue = null
    plan.autoDispatch = true
    remember(plan, 'task.audit_requested', '主控请求独立审查' + (args.message ? '：' + args.message : ''), task)
    await save(); const failure = await pump(); if (failure) throw failure
    return { audit: clone(task.audit) }
  })
  routeTool('delegation_review', '主控逐条评审。accept 需要验证通过、补充消息已处理且逐条引用证据；最后一项验收后自动生成回执并结束。rework 须提供具体问题及证据，或关联新用户 inputIds、additionalCriteria、feedback；受次数上限约束。', {
    taskId: string, verdict: { type: 'string', enum: ['accept', 'rework'] }, feedback: string, concernsResolution: string, issueIds: array(string),
    inputIds: array(string), additionalCriteria: array(string),
    issues: array({ ...object({ criterion: { type: 'integer' }, severity: { type: 'string', enum: ['critical', 'important', 'minor'] }, finding: string, evidence: array(string) }), required: ['criterion', 'severity', 'finding', 'evidence'] }),
    resolutions: array({ ...object({ id: string, status: { type: 'string', enum: ['ADDRESSED'] }, evidence: array(string) }), required: ['id', 'status', 'evidence'] }),
    findings: array({ ...object({ criterion: { type: 'integer' }, finding: string, evidence: array(string) }), required: ['criterion', 'finding', 'evidence'] }),
  }, ['taskId', 'verdict'], review)
  routeTool('delegation_control', 'steer 同步给原代理；用户补充须关联 inputIds 并提供 additionalCriteria。纯答复用 acknowledge(inputIds,message)，无需 taskId。stop 仅取消；retry 须处理真实原因。', {
    taskId: string, action: { type: 'string', enum: ['steer', 'stop', 'retry', 'acknowledge'] }, message: string, reason: string,
    inputIds: array(string), additionalCriteria: array(string),
  }, ['action'], control)
  routeTool('delegation_cancel', '取消整个计划，停止并清理其活动子任务。明确用户取消时传 reason；失败或超时后无原因调用会沿用原计划自动恢复可重试任务，不会把计划误标为已停止。', { reason: string }, [], async (args, exec) => {
    const { plan, parent } = ownPlan(exec)
    if (planStatus(plan) === 'accepted') return { status: 'accepted', completion: plan.completion ?? null }
    const serviceIssue = pendingServiceIssue(plan)
    if (!args.reason && serviceIssue) {
      const message = serviceIssue.message + '。' + serviceIssue.action
      remember(plan, 'plan.service_recovery_required', message)
      const completion = plan.completion ?? finishPlan(plan, message)
      await save(); return { status: 'blocked', issue: clone(serviceIssue), completion }
    }
    const hasLive = targetsOf(plan).some(task => LIVE.includes(task.status))
    const recoverable = !args.reason && !hasLive && plan.tasks.filter(task => ['failed', 'blocked'].includes(task.status)
      && !task.recovered && task.attempts < getConfig().maxAttempts)
    if (recoverable.length) {
      queuePlanRecovery(plan, recoverable, '上一轮执行失败或超时；沿用原计划继续，先核对已有产物和失败原因，再完成本次任务。')
      remember(plan, 'plan.auto_recovery', `无原因取消未终止计划，自动恢复 ${recoverable.length} 个可重试任务`)
      await save(); const failure = await pump(); if (failure) throw failure
      if (service('agents')?.get(parent.id) === parent) parent.inject?.(runtimeMessage(plan,
        `系统已拦截无原因的整计划取消，沿用原计划自动恢复：${recoverable.map(task => task.id).join('、')}。请读取 delegation_status，继续监督并完成验证验收；若用户确实要取消，必须再次提供明确 reason。`, 'delegation-recovery'))
      await save()
      return { status: 'recovering', taskIds: recoverable.map(task => task.id), completion: null }
    }
    if (!args.reason && !hasLive && plan.tasks.some(task => ['failed', 'blocked'].includes(task.status))) {
      const limit = getConfig().maxAttempts
      const message = `计划未取消：失败任务已达到每任务执行次数上限（${limit}）。请提高 maxAttempts 后明确 retry，或提供 reason 取消。`
      remember(plan, 'plan.auto_recovery_blocked', message)
      await save()
      return { status: 'blocked', completion: plan.completion ?? finishPlan(plan, message) }
    }
    invalidateCompletion(plan)
    plan.cancelled = true; plan.cancelledBy = args.reason ? 'explicit' : 'implicit'; plan.autoDispatch = false; plan.wakeSuppressed = true
    cancellingPlans.add(plan)
    try { for (const task of plan.tasks) if (task.status !== 'accepted') {
      await control({ taskId: task.id, action: 'stop', reason: '主控明确取消整个计划' }, exec)
    } } finally { cancellingPlans.delete(plan) }
    remember(plan, 'plan.cancelled', args.reason ? '主 Agent 已停止计划：' + args.reason : '主 Agent 已停止计划，历史记录保留')
    finishPlan(plan)
    await save(); return { status: 'cancelled', completion: plan.completion ?? null }
  })
  return {
    ready, snapshot, observe, allowsVerification, decisionFor, decisionCurrent, recoverDecision, sourceOf, revisionOf,
    pendingMessages: id => clone(pendingMessages(id)),
    requestContext: sessionId => clone(decisions.get(sessionId) ?? null), supervisionPolicy: SUPERVISION_POLICY,
    requestUsage(sessionId) { const entry = usageFor(sessionId); return entry ? clone(entry) : null },
    requestUsages(sessionId = null) { return usageLedger.snapshot().filter(entry => sessionId === null || entry.sessionId === sessionId) },
    guardChild(exec) {
      const expected = expectedRoutes.get(exec.agent?.id)
      const task = expected?.task ?? [...plans.values()].flatMap(targetsOf).find(item => item.childId === exec.agent?.id)
      if (task?.protocolVersion >= 2 && task.execution) return task.execution.commitState === 'committed'
        ? '[DSH Agentrix] 报告已提交，子回合正在结束，不能继续执行工具。' : '[DSH Agentrix] 报告正在确认，不能继续执行工具。'
      if (!expected) return undefined
      if (task.protocolVersion >= 2 && exec.name === 'send_message') return '[DSH Agentrix] 托管任务必须通过 delegation_report 提交正式报告；普通消息不能代替报告。'
      if (['delegation_decide', 'delegation_plan', 'delegation_run', 'delegation_status', 'delegation_inspect', 'delegation_note', 'delegation_verify', 'delegation_review', 'delegation_audit', 'delegation_control', 'delegation_cancel'].includes(exec.name)) return '[DSH Agentrix] 此入口仅供主控。子代理读取使用 read/grep/glob，阶段进度使用 delegation_checkpoint，最终结果使用 delegation_report。'
      if (['subagent', 'subagent_fork', 'spawn_teammate', ...(getConfig().delegationTools ?? [])].includes(exec.name)) return '[DSH Agentrix] 执行者和审查者不能继续委派。'
      if (expected.task.role === 'reviewer' && !['read', 'grep', 'glob', 'delegation_checkpoint', 'delegation_report'].includes(exec.name)) return '[DSH Agentrix] 独立审查只允许只读检索、阶段记录和最终报告；命令与实际验证由主控执行。'
      if (task.supervision) { task.supervision.lastActivityAt = Date.now(); task.supervision.activity = { kind: 'tool', tool: exec.name, at: Date.now() }; backgroundSave() }
    },
    async history(before) { await ready; if (writing) await writing; return records.history(before) },
    async readArchive(id) {
      await ready
      const plan = [...plans.values()].find(plan => plan.archive?.id === id)
      if (plan) {
        if (!pendingRecords.has(id)) pendingRecords.set(id, { plan, events: [] })
        await save()
      }
      return records.read(id)
    },
    get storageError() { return storageError },
    get archiveWarning() { return archiveFailure?.message ?? null },
    archiveWarningFor(sessionId) { return sessionId === null || archiveFailure?.sessionId === sessionId ? archiveFailure?.message ?? null : null },
    summary(sessionId) {
      const plan = plans.get(sessionId)
      const source = sourceOf(sessionId)
      if (!plan || source?.messageId && source.messageId !== plan.source?.messageId) return ''
      const failures = targetsOf(plan).filter(task => task.error).map(task => `${task.id}${task.role === 'reviewer' ? '（独立审查）' : ''}：${brief(task.error, 600)}`)
      const paused = !plan.cancelled && !plan.autoDispatch && targetsOf(plan).some(task => ['failed', 'blocked'].includes(task.status))
        ? '自动派单已暂停；处理失败原因后，执行任务用 delegation_control retry，独立审查用 delegation_audit({taskId,message}) 明确重试。' : ''
      const waiting = plan.dispatchWait ? `正在等待：${plan.dispatchWait.message}` : ''
      const budget = activationBudget(plan, getConfig().maxActivations)
      const issue = pendingServiceIssue(plan)
      const inputs = (plan.inputs ?? []).filter(input => ['queued', 'received'].includes(input.status))
      const unclassified = pendingMessages(sessionId)
      const association = unclassified.length ? '尚未归属需求的真实用户消息：\n' + unclassified.map(message => `${message.messageId}：${brief(message.text, 180)}`).join('\n') +
        '\n先用 delegation_decide(relation,messageId) 确认 new/continue/update/question；多条消息分别确认，不按措辞归属，也不自动取消旧任务。' : ''
      const pending = inputs.length ? '待处理用户补充：\n' + inputs.map(input => `${input.id}（${input.status}）：${brief(input.text, 400)}`).join('\n') +
        '\n先说明理解与影响；执行变更用 delegation_control steer(inputIds,additionalCriteria,message) 同步原代理；结果已返回则核对后 delegation_review rework。纯答复用 acknowledge(inputIds,message) 记录，不改变交付标准。未处理前不能验收。' : ''
      return [`当前计划：${brief(plan.goal, 200)}\n状态：${planStatus(plan)}；${plan.tasks.map(task => `${task.id}=${task.status}${task.audit ? '（独立审查=' + task.audit.status + '）' : ''}`).join('，')}。启动预算：${budget.used}/${budget.limit}，剩余 ${budget.remaining}（含独立审查）。调用 delegation_status 获取证据并继续监督；最终交付结论以程序回执为准，最后一次验收后自动结束，不用 stop 清理。`, plan.completion ? completionText(plan.completion) : '', issue ? issue.message + '。' + issue.action : '', pending, waiting, paused,
        association, failures.length ? `失败原因：\n${failures.join('\n')}` : ''].filter(Boolean).join('\n')
    },
    hasPending: sessionId => { const plan = plans.get(sessionId); return Boolean(plan && !['accepted', 'cancelled'].includes(planStatus(plan))) },
    async dispose() {
      if (closed) return
      closed = true
      truncatedOutputs.clear()
      clearTimeout(activityTimer)
      for (const plan of plans.values()) {
        plan.autoDispatch = false
        for (const task of targetsOf(plan)) if (LIVE.includes(task.status)) {
          task.status = 'blocked'; task.recovered = true; task.error = '插件停止，旧子任务需要先清理再重试'
          remember(plan, 'task.interrupted', task.error, task)
        }
      }
      for (const handle of live.values()) { clearTaskTimers(handle); handle.controller.abort(new Error('插件停止')) }
      await Promise.allSettled([...committing])
      const unconfirmed = new Set([...stagedResults.values(), ...[...pendingTransports.values()].flat()])
      stagedResults.clear(); pendingTransports.clear()
      await Promise.allSettled([...unconfirmed].map(transaction => commitToolResult(transaction, false)))
      await Promise.allSettled([...live.values()].map(async handle => {
        try { await releaseChild(handle, handle.task) } finally { handle.done.resolve() }
      }))
      await pumping
      await Promise.allSettled([...noteWrites.values()])
      for (const dispose of disposers.reverse()) dispose?.()
      live.clear(); expectedRoutes.clear(); permits.clear(); waitingParents.clear(); inboxes.clear(); if (!recoveryFailed) await save()
    },
  }
}
