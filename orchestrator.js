import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createTaskRecords } from './task-records.js'
import { buildCompletion, completionText, incompleteReason, RECOVERY_LIMIT, deliveryOptions, buildDelivery, deliveryText } from './completion.js'
import { startSupervision, observeTool, observeUsage, observeRequest, SUPERVISION_POLICY } from './supervision.js'
import { createUsageLedger } from './usage.js'
import { createRuntimeStore } from './runtime-store.js'

export const DEFAULT_OPTIONS = Object.freeze({
  maxParallel: 4, maxAttempts: 5, maxActivations: 64, taskTimeoutMinutes: 120,
  models: { worker: null, reviewer: null },
})
export const REVIEWER_MODEL_POLICY = 'dispatcher-snapshot'
export const COORDINATION_POLICY_VERSION = 7
const COORDINATION_CONFLICT_TOOLS = new Set(['team_task_create', 'team_task_update', 'wait_agent', 'spawn_teammate', 'subagent', 'subagent_fork'])
const COORDINATOR_TOOLS = new Set(['delegation_models', 'delegation_decide', 'delegation_plan', 'delegation_run', 'delegation_wait', 'delegation_status', 'delegation_inspect', 'delegation_note', 'delegation_verify', 'delegation_review', 'delegation_audit', 'delegation_control', 'delegation_cancel'])
const EXECUTOR_TOOLS = new Set(['delegation_checkpoint', 'delegation_report'])
const ARGUMENT_RECOVERY_LIMIT = 2
const REVIEW_TOOLS = new Set(['read', 'grep', 'glob', ...EXECUTOR_TOOLS])
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
const isServiceIssue = issue => ['MODEL_SERVICE_QUOTA', 'MODEL_SERVICE_RATE_LIMIT', 'MODEL_SERVICE_REQUEST_REFUSED'].includes(issue?.code)
const criteriaOf = task => task.criteria.map((text, criterion) => ({ id: 'C' + (criterion + 1), criterion, text }))
const requiresAudit = task => task.reviewPolicy === undefined ? task.complexity === 'complex' : task.reviewPolicy === 'independent'
function taskPromptScope(task) {
  const fixes = Boolean(task.reworkContext?.reportPath && !task.reworkContext.expanded && task.reworkIds?.length)
  const issues = (task.issues ?? []).filter(issue => task.reworkIds?.includes(issue.id))
  return { fixes, criteria: criteriaOf(task).filter(item => !fixes || issues.some(issue => issue.criterion === item.criterion)) }
}
const evidenceChoices = task => task.checks.map(check => check.result).filter(result => result?.attempt === task.attempts)
  .map(result => result.ref ?? result.callId).join('、') || '无，请先运行 delegation_verify'
function malformedToolArguments(failure) {
  if (failure?.code !== 'MALFORMED_RESPONSE' || typeof failure.message !== 'string') return null
  const match = failure.message.match(/^Tool call "([^"]+)": [^\n]+\n\nReceived arguments:\n([\s\S]+)$/)
  if (!match || !COORDINATOR_TOOLS.has(match[1]) && !EXECUTOR_TOOLS.has(match[1])) return null
  try { JSON.parse(match[2]); return null }
  catch (error) {
    const offset = Number(error.message.match(/position (\d+)/)?.[1] ?? 0)
    return { tool: match[1], error: error.message, offset,
      excerpt: match[2].slice(Math.max(0, offset - 180), offset + 420), characters: match[2].length }
  }
}
function reviewEvidence(task, values) {
  if (!Array.isArray(values)) return values
  return values.map(value => {
    const result = task.checks.map(check => check.result).find(result => result &&
      (result.ref === value || result.callId === value) && result.attempt === task.attempts)
    if (!result) throw new Error('验收证据必须引用本次主控验证实际返回的编号；当前可用：' + evidenceChoices(task))
    return result.callId
  })
}
function reviewFindings(task, findings) {
  if (!Array.isArray(findings)) return findings
  return findings.map(({ criterionId, ...finding }) => {
    if (criterionId !== undefined) {
      const item = criteriaOf(task).find(item => item.id === criterionId)
      if (!item || finding.criterion !== undefined && finding.criterion !== item.criterion) throw new Error('验收标准编号无效或冲突；当前可用：' + criteriaOf(task).map(item => item.id + '=' + item.text).join('；'))
      finding.criterion = item.criterion
    }
    return { ...finding, evidence: reviewEvidence(task, finding.evidence) }
  })
}
function modelServiceIssue(error, role, route = {}) {
  const details = messageOf(error), quota = error?.code === 'QUOTA' || /(?:exceed|insufficient)[^\n]*quota|quota[^\n]*(?:exceed|limit)/i.test(details)
  const label = { coordinator: '主控', worker: '执行者', reviewer: '独立审查' }[role]
  if (/Illegal API invocation from an unapproved channel/i.test(details)) return {
    code: 'MODEL_SERVICE_REQUEST_REFUSED', retryable: false, role,
    provider: route.provider, model: route.model, originalCode: error?.code, details, at: Date.now(),
    message: `${label}模型的本次请求被服务商拒绝；已保留现有交付物、报告和验证证据`,
    action: '请核对服务商支持的调用方式与相关限制；处理后' + (role === 'coordinator' ? '明确继续主控验证验收'
      : role === 'reviewer' ? '仅明确重试失败的独立审查，沿用分发者模型记录' : '仅明确重试失败任务') + '；不会自动切换模型或反复新开代理。',
  }
  if (!quota && !['RATE_LIMIT', 'RATE_LIMITED'].includes(error?.code) && Number(error?.status ?? error?.statusCode) !== 429 && !/\b429\b|rate_limit_error/.test(details)) return null
  return { code: quota ? 'MODEL_SERVICE_QUOTA' : 'MODEL_SERVICE_RATE_LIMIT', retryable: false, role,
    provider: route.provider, model: route.model, originalCode: error?.code, details, at: Date.now(),
    message: `${label}模型服务${quota ? '额度不足' : '请求受限（429）'}；已保留现有交付物、报告和验证证据`,
    action: `${quota ? '恢复服务商额度' : '等待服务商解除限流'}${role === 'reviewer' ? '，然后明确重试独立审查；审查沿用分发者模型记录' : `，或手动调整${role === 'coordinator' ? '主控模型' : '执行模型配置'}后明确继续${role === 'coordinator' ? '验证验收' : '并重试该任务'}`}；不会自动切换模型或反复新开代理。` }
}

// Model output is intentionally separate from the full persisted/UI snapshot.
function compactSupervision(state) {
  return { pending: state.pending ? { ...state.pending, reason: brief(state.pending.reason, 600) } : null,
    checkpoint: state.checkpoint ? { ...state.checkpoint, summary: brief(state.checkpoint.summary, 300), nextStep: brief(state.checkpoint.nextStep, 300) } : null,
    lastProgress: state.lastProgress ?? null }
}
function compactTask(task) {
  return { id: task.id, title: task.title, status: task.status, attempts: task.attempts,
    reviewPolicy: task.reviewPolicy ?? null, reviewReason: task.reviewReason ?? null,
    ...(task.criteria ? { criteria: criteriaOf(task) } : {}),
    model: task.modelRoute?.actual ?? task.modelRoute?.requested ?? task.model, authorization: task.modelRoute?.authorization ?? null, issue: task.issue,
    summary: brief(task.execution?.summary, 300), reportPath: task.execution?.reportPath,
    execution: task.execution ? { status: task.execution.status, reason: task.execution.reason, concerns: task.execution.concerns ?? [] } : null,
    error: task.error ? brief(task.error, 500) : null,
    ...(task.resultNotification ? { resultNotification: task.resultNotification } : {}),
    checks: (task.checks ?? []).map((check, index) => ({ index, passed: check.result?.passed ?? null, ref: check.result?.ref, callId: check.result?.callId,
      ...(check.result?.truncated ? { truncated: true, outputPath: check.result.outputPath, readOutput: check.result.readOutput } : {}) })),
    issues: (task.issues ?? []).filter(issue => issue.status === 'open').map(issue => ({ id: issue.id, severity: issue.severity, finding: brief(issue.finding, 300) })),
    ...(task.supervision ? { supervision: compactSupervision(task.supervision) } : {}),
    evidence: (task.checks ?? []).map(check => check.result).filter(result => result?.attempt === task.attempts).map(item => item.callId),
    ...(task.audit ? { audit: { status: task.audit.status, summary: brief(task.audit.execution?.summary, 300),
      ...(task.audit.supervision ? { supervision: compactSupervision(task.audit.supervision) } : {}),
      reportPath: task.audit.execution?.reportPath, concerns: task.audit.execution?.concerns ?? [], specVerdict: task.audit.specVerdict, qualityVerdict: task.audit.qualityVerdict } } : {}) }
}
function compactResult(value) {
  const result = { ...value }
  if (value.context) result.context = compactContext(value.context)
  if (value.source) result.source = compactMessage(value.source)
  if (value.pendingMessages) result.pendingMessages = value.pendingMessages.map(compactMessage)
  if (value.plan) result.plan = { sessionId: value.plan.sessionId, goal: brief(value.plan.goal, 300), status: value.plan.status,
    decision: value.plan.decision, nextAction: value.plan.nextAction, pendingMessages: value.plan.pendingMessages?.map(compactMessage),
    activationBudget: value.plan.activationBudget, dispatchWait: value.plan.dispatchWait,
    interruption: value.plan.interruption,
    ...(value.plan.cancellation ? { cancellation: { reason: value.plan.cancellation.reason, at: value.plan.cancellation.at, cleanup: value.plan.cancellation.cleanup } } : {}),
    coordinatorIssue: value.plan.coordinatorIssue, coordinationIssue: value.plan.coordinationIssue, messageResolution: value.plan.messageResolution,
    ...(value.plan.delivery ? { delivery: { status: value.plan.delivery.status, messageId: value.plan.delivery.messageId, error: value.plan.delivery.error } } : {}),
    inputs: (value.plan.inputs ?? []).filter(input => ['queued', 'received'].includes(input.status)).map(input => ({ id: input.id, text: brief(input.text, 400), status: input.status })),
    tasks: value.plan.tasks.map(compactTask) }
  if (value.task) result.task = compactTask(value.task)
  if (value.audit) result.audit = compactTask(value.audit)
  return result
}
function compactMessage(message) {
  return message && typeof message.text === 'string' && message.text.length > 400
    ? { ...message, text: message.text.slice(0, 400), truncated: true,
      readOriginal: `delegation_status({messageId:"${message.messageId}",detail:"full"})` } : message
}
function compactContext(context) {
  return { ...context, source: compactMessage(context.source), revision: compactMessage(context.revision),
    pendingMessages: (context.pendingMessages ?? []).map(compactMessage) }
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
  for (const issue of issues) {
    if (task.issues.some(existing => existing.attempt === task.attempts && existing.criterion === issue.criterion &&
        existing.severity === issue.severity && existing.finding.trim() === issue.finding.trim() &&
        JSON.stringify([...existing.evidence].sort()) === JSON.stringify([...issue.evidence].sort()))) continue
    task.issues.push({ ...issue, id: `${task.id}-${task.attempts}-${task.issues.length + 1}`,
      attempt: task.attempts, source, status: issue.severity === 'minor' ? 'deferred' : 'open' })
  }
}
function validatePlan(args, stored = false) {
  if (!stored && JSON.stringify(args).length > 64 * 1024) throw new Error('任务计划超过 64 KiB，请缩小任务说明和输入范围')
  const goal = requireText(args.goal, '目标')
  if (!Array.isArray(args.tasks) || args.tasks.length === 0 || args.tasks.length > MAX_TASKS) throw new Error(`计划需要 1~${MAX_TASKS} 个任务`)
  const tasks = args.tasks.map(input => {
    const id = requireText(input.id, '任务编号', 64)
    if (!/^[\w-]+$/.test(id)) throw new Error('任务编号只能包含字母、数字、下划线和短横线')
    if (!['routine', 'complex'].includes(input.complexity)) throw new Error('complexity 只能是 routine 或 complex')
    if (input.reviewPolicy !== undefined && !['coordinator', 'independent'].includes(input.reviewPolicy)) throw new Error('reviewPolicy 只能是 coordinator 或 independent')
    if (input.reviewPolicy === undefined && input.reviewReason !== undefined) throw new Error('审查依据必须同时提供 reviewPolicy')
    const review = input.reviewPolicy === undefined ? {} : { reviewPolicy: input.reviewPolicy,
      reviewReason: requireText(input.reviewReason, '审查依据', 1000) }
    if (!Array.isArray(input.checks) || !input.checks.length || input.checks.length > 4) throw new Error('每个任务需要 1~4 个主控验证步骤')
    const checks = input.checks.map(check => {
      if (!CHECK_TOOLS.includes(check.tool)) throw new Error(`验证工具只能是 ${CHECK_TOOLS.join(' / ')}`)
      if (!check.arguments || typeof check.arguments !== 'object' || Array.isArray(check.arguments) || JSON.stringify(check.arguments).length > 8000) throw new Error('验证工具 arguments 必须是 JSON 对象，最多 8000 字')
      if (['pwsh', 'bash'].includes(check.tool) && check.arguments.run_in_background) throw new Error('验收命令必须前台完成，不能提交后台任务')
      return { tool: check.tool, arguments: clone(check.arguments), result: null }
    })
    return { id, title: requireText(input.title, '任务标题', 160), instructions: requireText(input.instructions, '任务说明'),
      scope: requireText(input.scope, '边界'), outputs: strings(input.outputs, '交付物'), writes: strings(input.writes, '可修改路径', true),
      dependsOn: strings(input.dependsOn ?? [], '依赖', true), complexity: input.complexity, ...review,
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
  const runtimeStore = createRuntimeStore(file)
  const decisions = new Map(), decisionWrites = new Set()
  const coordinatorUsage = new Map()
  const plans = new Map(), live = new Map(), permits = new Map(), expectedRoutes = new Map(), disposers = []
  const interrupting = new Map()
  const modelPolicies = new WeakMap()
  const noteRequests = new Map(), noteWrites = new Map()
  const stagedResults = new Map(), pendingTransports = new Map(), committing = new Set()
  const waitingParents = new Map()
  const verifyingTasks = new WeakSet()
  const coordinationFailures = new Set(), coordinationCalls = new Map(), coordinationRestrictions = new Map()
  const toolDefinitions = new Map(), reportSchemas = new Map()
  const inboxes = new Map()
  const cancellingPlans = new Map(), stopCleanups = new WeakMap(), notificationTimers = new Map(), notifying = new WeakMap(), notificationOperations = new Set()
  const records = createTaskRecords(file), pendingRecords = new Map()
  let activityTimer
  let closed = false, dirty = false, writing, pumping = Promise.resolve(), storageError = null, recoveryFailed = false
  let archiveFailure = null
  const service = name => ctx.get(name)
  const sourceOf = id => decisions.get(id)?.messages ? decisions.get(id).source : getSource(id) ?? decisions.get(id)?.source ?? null
  const revisionOf = id => decisions.get(id)?.messages ? decisions.get(id).revision : getRevision(id) ?? decisions.get(id)?.revision ?? null
  const pendingMessages = id => (decisions.get(id)?.messages ?? []).filter(message => !message.resolution && !message.withdrawn && !message.cancellation)
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
    entry.messages.push({ messageId: String(message.id), text, at: Date.now(), target })
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
  function updateCancellationCleanup(plan) {
    if (!plan.cancellation) return
    const previous = plan.cancellation.cleanup
    const remaining = plan.tasks.flatMap(task => (task.audit ? [task, task.audit] : [task])
      .filter(target => task.status !== 'accepted' && (target.recovered || LIVE.includes(target.status) || target.release?.status === 'failed'))
      .map(target => ({ taskId: task.id, role: modelRole(target), childId: target.childId ?? null,
        ...(target.release?.error ? { error: target.release.error } : {}) })))
    const failures = [...(previous?.failures ?? [])]
    for (const item of remaining.filter(item => item.error)) if (!failures.some(old => old.childId === item.childId && old.error === item.error)) failures.push({ ...item, at: Date.now() })
    const status = remaining.length ? remaining.some(item => item.error) ? 'failed' : 'pending' : 'completed'
    if (previous?.status === status && JSON.stringify(previous.remaining) === JSON.stringify(remaining)) return
    plan.cancellation.cleanup = { status,
      remaining, failures, updatedAt: Date.now(), ...(!remaining.length ? { completedAt: previous?.completedAt ?? Date.now() } : {}) }
  }
  function requestTaskStop(plan, task, reason) {
    if (task.status === 'accepted') return
    if (task.status !== 'cancelled' || !task.stop) task.stop = { reason, source: 'coordinator', at: Date.now(), previousStatus: task.status }
    task.status = 'cancelled'; plan.dispatchWait = null
    for (const target of task.audit ? [task, task.audit] : [task]) {
      target.status = 'cancelled'
      const handle = live.get(targetKey(plan, target))
      if (handle) { target.recovered = true; clearTaskTimers(handle); handle.controller.abort(new Error('任务已取消：' + reason)) }
    }
    waitingParents.get(plan.sessionId)?.wake.resolve()
  }
  async function cleanupStoppedTask(plan, task, parent) {
    if (stopCleanups.has(task)) return stopCleanups.get(task)
    const operation = (async () => {
      await pumping
      const errors = await Promise.all((task.audit ? [task, task.audit] : [task]).map(async target => {
        const key = targetKey(plan, target), handle = live.get(key)
        try {
          if (handle) {
            const error = await releaseChild(handle, target)
            if (error) throw error
            if (live.get(key) === handle) live.delete(key)
            expectedRoutes.delete(target.childId); handle.done.resolve()
          } else if (target.recovered && target.childId && !['released', 'drained'].includes(target.release?.status)) {
            await service('subagents').drainChildren(parent, [target.childId])
            target.release = { status: 'drained', at: Date.now() }
          }
          target.recovered = false
          return null
        } catch (error) {
          target.recovered = true
          target.release = { status: 'failed', at: Date.now(), error: messageOf(error) }
          remember(plan, 'task.cleanup_failed', '取消已请求，资源清理未完成：' + messageOf(error), target, { release: clone(target.release) })
          return error
        }
      }))
      return errors.find(Boolean)
    })()
    stopCleanups.set(task, operation)
    try { return await operation } finally { stopCleanups.delete(task) }
  }
  function runtimeMessage(plan, text, kind = 'delegation-recovery') {
    return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind, planId: plan.archive.id } }
  }
  function deliveryAnchor(session, turn) {
    return session.snapshotEvents?.().findLast(event => event.type === 'assistant/message' && event.data?.turn === turn &&
      event.data.message?.content?.some(block => block.type === 'text' && block.text.trim()))?.seq ?? null
  }
  async function publishDelivery(plan, agent, signal) {
    const delivery = plan.delivery
    if (!delivery || delivery.receiptId !== plan.completion?.id || delivery.status === 'delivered' || signal?.aborted) return
    try {
      const events = agent.session.snapshotEvents?.() ?? []
      const existing = events.find(event => (event.type === 'deliverables/presented' && event.data?.messageId === delivery.messageId &&
        event.data.source?.kind === 'delegation-delivery') || (event.type === 'developer/message' && event.data?.message?.id === delivery.messageId &&
        event.data.message.source?.kind === 'delegation-delivery'))
      let event = existing
      if (!event) {
        const call = events.findLast(event => event.type === 'tool/call' && event.data?.turn === delivery.turn && event.data.name === 'delegation_review' &&
          (!delivery.callId || event.data.callId === delivery.callId))
        if (!Number.isSafeInteger(delivery.turn) || delivery.turn < 1 || !call?.data.callId) throw new Error('交付所属回合或实际验收调用未记录，保留验收结果，不能伪造原生交付来源')
        // Native delivery records may follow step/end. Developer messages require an open step.
        event = agent.session.append('deliverables/presented', { turn: delivery.turn, callId: call.data.callId, messageId: delivery.messageId,
          source: { kind: 'delegation-delivery', receiptId: delivery.receiptId, requestId: delivery.requestId, archiveId: plan.archive.id },
          files: delivery.files.map(file => ({ path: file.path, description: file.label })), summary: deliveryText(delivery) })
      }
      const sessions = service('sessions')
      if (typeof sessions?.flush === 'function') await sessions.flush(agent.session)
      delivery.messageSeq = event.seq; delivery.status = 'delivered'; delivery.deliveredAt = Date.now(); delete delivery.error
      remember(plan, 'plan.delivered', '已向聊天交付验收结果及文件入口', undefined, { receiptId: delivery.receiptId, messageId: delivery.messageId })
    } catch (error) {
      delivery.status = 'failed'; delivery.error = messageOf(error)
      remember(plan, 'plan.delivery_failed', '任务验收已保留，交付消息写入失败：' + delivery.error)
    }
    await save()
  }
  const queuedInputs = plan => [...(plan.inputs ?? []).filter(input => input.status === 'queued'), ...pendingMessages(plan.sessionId)]
  const unresolvedInputs = plan => [...(plan.inputs ?? []).filter(input => ['queued', 'received'].includes(input.status)), ...pendingMessages(plan.sessionId).map(message => ({ id: message.messageId, text: message.text, status: 'unclassified' }))]
  const interruptedPlan = plan => Boolean(plan && (!plan.cancelled && plan.interruption && !plan.interruption.resumedAt || plan.cancelled && plan.cancelledBy === 'host' && !plan.cancellation))
  function messageContext(sessionId) {
    const entry = decisions.get(sessionId), plan = plans.get(sessionId)
    return { sessionId, source: clone(sourceOf(sessionId)), revision: clone(revisionOf(sessionId)),
      decision: decisionFor(sessionId), decisionCurrent: decisionCurrent(sessionId),
      messageResolution: clone(entry?.messageResolution ?? null), pendingMessages: clone(pendingMessages(sessionId)),
      planMatchesRequest: Boolean(plan && isCurrentPlan(plan)) }
  }
  function nextAction(plan, sessionId = plan?.sessionId, completion = plan?.completion) {
    const pending = pendingMessages(sessionId)
    if (pending.length) return { type: 'resolve_message', messageIds: pending.map(message => message.messageId),
      message: decisionGuidance(sessionId) }
    if (!plan || !isCurrentPlan(plan) && (completion?.outcome === 'completed' || ['accepted', 'cancelled'].includes(planStatus(plan)) || decisionFor(sessionId)?.mode !== 'delegate')) {
      const decision = decisionFor(sessionId), current = decisionCurrent(sessionId)
      return { type: current ? 'handle_request' : 'decide', requestId: sourceOf(sessionId)?.messageId ?? null, mode: decision?.mode ?? null,
        message: !current ? decisionGuidance(sessionId)
          : decision.mode === 'delegate' ? '为当前需求调用 delegation_plan({decisionReason,start:true,...}) 建立并启动计划；旧计划回执不代表当前需求已完成。'
            : '按已确认的当前需求直接处理并验证；旧计划回执不代表当前需求已完成。' }
    }
    if (interruptedPlan(plan) && !pendingMessages(plan.sessionId).length && (!decisionCurrent(plan.sessionId) || decisionFor(plan.sessionId)?.mode !== 'delegate')) return { type: 'decide', message: '继续消息已关联，但旧判断不是委派。请用 delegation_decide(relation:continue,mode:delegate,reason:监督原托管任务的具体理由) 确认继续原计划，无需改成 update 或重建任务卡。' }
    if (!plan.cancelled && plan.interruption && !plan.interruption.resumedAt) return { type: 'run', message: '执行已中断，进度保留。用户明确继续后调用 delegation_run，沿用原计划恢复未完成任务；已返回报告继续验证验收，不必新建计划。' }
    if (plan.cancelled && plan.cancellation?.cleanup?.status !== 'completed' && plan.cancellation?.cleanup) return {
      type: 'handle_failure', message: '用户取消已记录，资源清理未完成。处理清理错误后再次调用 delegation_cancel 重试清理；无需新增取消消息，不启动新代理。' }
    if (completion || plan.cancelled) return { type: 'finished', message: '以程序交付回执为准；不要重复启动或清理。' }
    if (unresolvedInputs(plan).length) return { type: 'handle_input', message: '先处理用户补充，沿用原代理同步要求。' }
    const returned = plan.tasks.filter(task => task.status === 'review' && !task.pendingAcceptance)
    const verify = returned.filter(task => task.checks.some(check => !check.result || check.result.attempt !== task.attempts))
    if (verify.length) return { type: 'verify', taskIds: verify.map(task => task.id), message: '对已返回任务运行 delegation_verify；其他执行者继续工作。' }
    const review = returned.filter(task => !task.audit || !['queued', ...LIVE].includes(task.audit.status))
    if (review.length) return { type: 'review', taskIds: review.map(task => task.id), message: review.some(task => task.checks.some(check => !check.result.passed))
      ? '验证已有失败结果，请核对原因并用具体证据决定返工；不能验收或原样反复验证。'
      : '按给出的 criterionId 和证据 ref 逐条 delegation_review。' + (review.some(task => task.execution?.status === 'DONE_WITH_CONCERNS')
        ? '报告含疑点，先核对 execution.concerns，并填写 concernsResolution 说明处理结论。' : '') }
    const supervision = targetsOf(plan).filter(task => LIVE.includes(task.status) && !task.execution && task.supervision?.pending)
    if (supervision.length) return { type: 'supervise', taskIds: [...new Set(supervision.map(task => task.id))],
      message: '核对阶段结论、工具证据与剩余要求，用 delegation_control steer 向原代理明确继续、纠偏或达标后提交报告；提醒不是验收，不停止或新开代理。' }
    if (plan.tasks.some(task => ['failed', 'blocked'].includes(task.status) || ['failed', 'blocked'].includes(task.audit?.status))) return { type: 'handle_failure', message: '核对真实失败原因，处理后再明确重试；不新开代理掩盖错误。' }
    if (targetsOf(plan).some(task => LIVE.includes(task.status)) || plan.autoDispatch && plan.tasks.some(task => task.status === 'queued' || task.pendingAcceptance || task.audit?.status === 'queued')) return {
      type: 'wait', message: '计划正在执行或自动推进，下一阶段会自动启动，无需再次 run。简短告知用户后调用 delegation_wait，或结束当前回复等待自动通知；不要轮询 status。',
    }
    return { type: 'run', message: '用 delegation_run 启动当前已建立的计划。' }
  }
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
  function argumentOwner(agent, tool) {
    const expected = expectedRoutes.get(agent?.id)
    if (expected) return EXECUTOR_TOOLS.has(tool) && !expected.plan.cancelled && !expected.plan.wakeSuppressed &&
      !expected.handle.controller.signal.aborted && !expected.task.execution
      ? { owner: expected.task, requestId: String(expected.task.attempts) } : null
    if (!COORDINATOR_TOOLS.has(tool) || service('agents')?.get(agent?.id) !== agent) return null
    const header = agent.session?.header
    if (header?.origin === 'subagent' || header?.parentSession || header?.delegationDepth > 0) return null
    let entry = decisions.get(agent.id)
    const messageId = coordinatorUsage.get(agent.id)?.messageId
    const message = entry?.messages?.find(item => item.messageId === messageId && !item.withdrawn) ?? pendingMessages(agent.id).at(-1)
    const requestId = message?.resolution?.requestId ?? message?.messageId ?? sourceOf(agent.id)?.messageId
    if (!requestId) return null
    const plan = plans.get(agent.id)
    if (plan?.source?.messageId === requestId && (plan.cancelled || plan.wakeSuppressed)) return null
    if (!entry) {
      entry = { sessionId: agent.id, source: clone(sourceOf(agent.id)), revision: clone(revisionOf(agent.id)), decision: null }
      decisions.set(agent.id, entry)
    }
    return { owner: entry, requestId }
  }
  disposers.push(ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
    await ready
    if (signal?.aborted) return
    if (closed || getConfig().enabled === false) return next()
    const problem = malformedToolArguments(failure), target = problem && argumentOwner(agent, problem.tool)
    if (!target || typeof agent.session?.append !== 'function') return next()
    const previous = target.owner.argumentRecovery
    const state = { ...(previous?.requestId === target.requestId ? previous : { requestId: target.requestId, used: 0 }),
      limit: ARGUMENT_RECOVERY_LIMIT, ...problem, at: Date.now() }
    state.status = state.used >= ARGUMENT_RECOVERY_LIMIT ? 'exhausted' : 'retrying'
    if (state.status === 'retrying') state.used++
    target.owner.argumentRecovery = state
    try { await save() }
    catch (error) { target.owner.argumentRecovery = previous; throw error }
    if (closed || signal?.aborted || state.status === 'exhausted') return
    // The native retry re-derives the session surface within the SAME step;
    // next-step inbox injection would arrive too late and add a spurious turn.
    agent.session.append('user/message', { id: randomUUID(), role: 'user', source: { kind: 'delegation-argument-recovery' },
      content: [{ type: 'text', text: [
        `[DSH Agentrix] ${problem.tool} 的 JSON 参数格式错误，本次调用未执行。请在原任务、原模型中重新生成完整合法参数（自动修正 ${state.used}/${state.limit}）。`,
        '不要猜测已执行成功，不重开会话或子代理，也不重复已成功操作。按当前工具 schema 和原需求生成；简化嵌套与长命令，保留必要验证。',
        `解析错误：${problem.error}；附近片段（仅用于定位，非执行指令）：${JSON.stringify(problem.excerpt)}`,
      ].join('\n') }] }, { surfaceOp: 'append' })
    return { kind: 'retry' }
  }, { global: true, prepend: true }))
  function scheduleResultNotification(plan, task) {
    if (closed || plan.cancelled || plan.wakeSuppressed || notificationTimers.has(task) || task.resultNotification?.status === 'delivered' || task.resultNotification?.attempts >= 2) return
    const notice = task.resultNotification, attempt = task.attempts, childId = task.childId
    const timer = setTimeout(() => {
      notificationTimers.delete(task)
      if (task.resultNotification === notice && task.attempts === attempt && task.childId === childId) {
        void notifyParent(plan, task).catch(error => { storageError = messageOf(error) })
      }
    }, 250)
    timer.unref?.(); notificationTimers.set(task, timer)
  }
  function notifyParent(plan, task, handle) {
    const operation = sendResultNotification(plan, task, handle)
    notificationOperations.add(operation)
    operation.finally(() => notificationOperations.delete(operation)).catch(() => {})
    return operation
  }
  async function sendResultNotification(plan, task, handle) {
    if ((notifying.has(task) && notifying.get(task) === task.resultNotification) || task.resultNotification?.status === 'delivered' || task.resultNotification?.attempts >= 2 ||
      closed || plan.cancelled || plan.wakeSuppressed || plans.get(plan.sessionId) !== plan) return
    if (LIVE.includes(task.status) || ['queued', 'cancelled', 'accepted'].includes(task.status) || !targetsOf(plan).includes(task) ||
      plan.tasks.some(owner => owner.id === task.id && owner.status === 'accepted')) return
    const parent = service('agents')?.get(plan.sessionId)
    if (!parent || handle && parent !== handle.parent) return
    const notice = task.resultNotification ??= { messageId: randomUUID(), status: 'pending', attempts: 0, attempt: task.attempts, childId: task.childId }
    const current = () => !closed && !plan.cancelled && !plan.wakeSuppressed && plans.get(plan.sessionId) === plan &&
      service('agents')?.get(plan.sessionId) === parent && task.resultNotification === notice && task.attempts === notice.attempt &&
      task.childId === notice.childId && targetsOf(plan).includes(task) && !['queued', ...LIVE, 'accepted', 'cancelled'].includes(task.status) &&
      !plan.tasks.some(owner => owner.id === task.id && owner.status === 'accepted')
    let preparing = false
    const releasePreparation = () => {
      if (preparing && task.resultNotification === notice) { notice.attempts--; notice.status = 'pending'; preparing = false }
    }
    notifying.set(task, notice)
    try {
      if ((parent.session?.snapshotEvents?.() ?? []).some(event => event.data?.message?.id === notice.messageId || event.data?.id === notice.messageId)) {
        notice.status = 'delivered'; delete notice.error; await save(); return
      }
      const owner = plan.tasks.find(item => item.id === task.id) ?? task
      const text = `托管任务 ${task.id}${task.role === 'reviewer' ? ' 的独立审查' : ''} 已返回：${task.status}。${task.error || task.execution?.summary || ''}。无需 stop 清理。\n` +
        JSON.stringify({ task: compactTask(owner), nextAction: nextAction(plan) })
      notice.attempts++; notice.status = 'pending'
      preparing = true
      await save()
      if (!current()) { releasePreparation(); if (!closed) await save(); return }
      preparing = false
      const waiter = waitingParents.get(plan.sessionId)
      if (waiter) {
        waiter.results.push(text); waiter.wake.resolve()
      } else {
        const message = { ...runtimeMessage(plan, text, 'delegation-result'), id: notice.messageId }
        const send = parent.status === 'running' ? parent.inject : parent.steer
        if (typeof send !== 'function') throw new Error('主控通知入口不可用')
        await send.call(parent, message)
      }
      notice.status = 'delivered'; notice.deliveredAt = Date.now(); delete notice.error
      await save()
    } catch (error) {
      if (!current()) releasePreparation()
      if (current() && notice.status !== 'delivered') {
        notice.status = 'failed'; notice.error = messageOf(error)
        remember(plan, 'task.notification_failed', '任务结果已保存，通知主控失败：' + notice.error, task)
        await save().catch(() => {})
        scheduleResultNotification(plan, task)
      }
    } finally { if (notifying.get(task) === notice) notifying.delete(task) }
  }
  const pendingSupervision = plan => targetsOf(plan).filter(task => LIVE.includes(task.status) && !task.execution && task.supervision?.pending && !task.supervision.pending.deliveredAt)
  function deliverSupervision(plan, agent) {
    const tasks = pendingSupervision(plan)
    if (!tasks.length || closed || plan.cancelled || plan.wakeSuppressed) return false
    const now = Date.now()
    for (const task of tasks) task.supervision.pending.deliveredAt = now
    const instruction = tasks.every(task => task.supervision.pending.advisory)
      ? '请按 delegation_status 的阶段结论与工具证据核对：原用户要求是否已满足、是否有新成果、是否重复检查。用 delegation_control steer 向原代理说明实际判断与下一步；有进展继续，达标后提交报告，有偏离则定向纠正。提醒不是验收，不因提醒停止或新开代理。\n'
      : '执行中的任务出现重复故障，请读取 delegation_status 核对证据，并向原子代理给出具体纠正，不重复派发或代做实现。\n'
    agent.inject(runtimeMessage(plan, instruction +
      tasks.map(task => `${task.id}（子会话 ${task.childId}）：${task.supervision.pending.reason}`).join('\n'), 'delegation-supervision'))
    return true
  }
  function requestSupervision(plan, task, handle, alert) {
    const state = task.supervision
    if (!state || !handle || state.pending && (!state.pending.advisory || alert.advisory) || getConfig().enabled === false || closed || plan.cancelled || plan.wakeSuppressed || handle.settling) return
    const reviewKey = alert.reviewKey ? 'PROGRESS_REVIEW_' + alert.reviewKey : null
    if (reviewKey && state.notices?.[reviewKey]) return
    if (!alert.advisory && state.used >= state.limit) {
      const issue = { code: 'SUPERVISION_EXHAUSTED', retryable: false,
        message: `已用尽 ${state.limit} 次自动纠偏，任务仍需处理：${alert.reason}。已有产物和证据保留，不自动重开。` }
      const failure = Object.assign(new Error(issue.message), { issue })
      handle.failure = failure; handle.controller.abort(failure)
      void settle(plan, task, handle, undefined, failure).catch(error => { storageError = messageOf(error) })
      return
    }
    state.pending = { id: randomUUID(), at: Date.now(), ...alert }
    if (reviewKey) (state.notices ??= {})[reviewKey] = state.pending.at
    remember(plan, 'task.supervision_requested', alert.reason, task, { supervision: clone(state.pending) })
    void save().then(async () => {
      if (closed || plan.cancelled || plan.wakeSuppressed || task.execution || !LIVE.includes(task.status)) return
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
    const progressAt = state.notices.NO_NEW_EVIDENCE || state.notices.NO_ACTIVITY || state.pending || state.activity?.kind === 'tool'
      ? Infinity : (state.lastProgressAt ?? state.startedAt) + state.idleMs
    const nextAt = Math.min(state.notices.ELAPSED_TIME ? Infinity : state.remindAt,
      state.notices.NO_ACTIVITY || state.pending ? Infinity : idleAt, progressAt)
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
      } else if (!state.notices.NO_NEW_EVIDENCE && !state.notices.NO_ACTIVITY && !state.pending && state.activity?.kind !== 'tool' &&
        now >= (state.lastProgressAt ?? state.startedAt) + state.idleMs) {
        state.notices.NO_NEW_EVIDENCE = now
        requestSupervision(plan, task, handle, { code: 'NO_NEW_EVIDENCE', advisory: true,
          reason: '已有十分钟没有新的工具证据或阶段结论，模型仍有活动也不能确认需求在推进。请核对当前成果与剩余问题，必要时向原代理缩小当前步骤；不因提醒停止或新开代理。',
          evidence: state.lastProgress?.callId ? [state.lastProgress.callId] : [] })
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
    try { await Promise.race([...handles.map(handle => handle.done.promise), cancelled, wake]) }
    finally { signal?.removeEventListener('abort', abort) }
  }
  async function waitForResults(plan, agent, signal) {
    if (waitingParents.has(agent.id)) throw new Error('当前主控已经在等待任务事件，不要并行重复等待。')
    const waiter = { signal, wake: Promise.withResolvers(), results: [] }
    waitingParents.set(agent.id, waiter)
    try {
      while (!closed && !signal?.aborted && !plan.cancelled && !plan.wakeSuppressed) {
        if (waiter.results.length || nextAction(plan).type !== 'wait' || pendingSupervision(plan).length) break
        const handles = [...live.values()].filter(handle => handle.planSessionId === agent.id)
        waiter.awaitingDispatch = !handles.length
        const wake = waiter.wake
        await waitForWork(handles, signal, plan, wake.promise)
        if (waiter.wake === wake) waiter.wake = Promise.withResolvers()
      }
    } finally { waitingParents.delete(agent.id) }
    return waiter.results
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
    // tools/result is an unawaited observer; finish its storage commit before publishing.
    if (plan && committing.size) await Promise.all(committing)
    if (plan?.delivery) await publishDelivery(plan, agent, signal)
    if (!plan || !(plan.protocolVersion >= 2) || !isCurrentPlan(plan) || plan.wakeSuppressed || plan.cancelled && plan.completion) { truncatedOutputs.delete(agent.id); return }
    if (pendingMessages(agent.id).length && await recoverDecision(agent.id)) {
      agent.inject(runtimeMessage(plan, decisionGuidance(agent.id), 'delegation-decision-recovery'))
      return
    }
    if (!plan.completion && continueOutput(plan, agent)) { await save(); return }
    const results = await waitForResults(plan, agent, signal)
    if (closed || signal?.aborted || plan.wakeSuppressed) return
    if (results.length) {
      agent.inject(runtimeMessage(plan, results.join('\n'), 'delegation-result'))
      await save(); return
    }
    if (queuedInputs(plan).length) { await save(); return }
    if (deliverSupervision(plan, agent)) { await save(); return }
    if (nextAction(plan).type === 'supervise') return
    if (finishPlan(plan)) { await save(); return }
    plan.recovery ??= { used: 0, limit: RECOVERY_LIMIT }
    const stage = completionStage(plan)
    if (plan.recovery.stage && plan.recovery.stage !== stage) plan.recovery.used = 0
    plan.recovery.stage = stage
    if (plan.recovery.used >= RECOVERY_LIMIT) {
      finishPlan(plan, '当前阶段两次自动补流程后仍未完成验收，已停止自动续跑；交付物和证据保留。')
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
    observeCoordinationResult(exec, result)
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
  const snapshotPlan = (plan, persist = false) => {
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
    if (!persist) for (const task of targetsOf(copy)) if (task.supervision) {
      delete task.supervision.evidenceIndex; delete task.supervision.recentObservations
    }
    copy.activationBudget = budget
    delete copy.pendingMessages
    if (!persist && pendingMessages(plan.sessionId).length) copy.pendingMessages = clone(pendingMessages(plan.sessionId))
    if (copy.decision) copy.decisionCurrent = ['accepted', 'cancelled'].includes(planStatus(plan)) || decisionCurrent(plan.sessionId)
    if (['accepted', 'cancelled'].includes(planStatus(plan))) copy.dispatchWait = null
    return { ...copy, status: planStatus(plan), ...(!persist ? { nextAction: nextAction(plan) } : {}) }
  }
  const snapshot = () => [...plans.values()].map(plan => snapshotPlan(plan))
  const completionStage = plan => JSON.stringify(targetsOf(plan).map(task =>
    [task.id, task.role, task.attempts, task.status, task.checks?.map(check => Boolean(check.result?.passed))]))
  const coordinationStage = (plan, taskId) => JSON.stringify(targetsOf(plan).filter(task => !taskId || task.id === taskId).map(task =>
    [task.id, task.role, task.attempts, task.status, task.execution?.commitState, task.checks?.map(check => [check.result?.callId, check.result?.passed])]))
  const pendingPlan = sessionId => {
    const plan = plans.get(sessionId)
    return plan && !['accepted', 'cancelled'].includes(planStatus(plan)) ? plan : null
  }
  function isCurrentPlan(plan) {
    const source = sourceOf(plan.sessionId)
    return !source?.messageId || source.messageId === plan.source?.messageId
  }
  function coordinatorEventMatchesPlan(plan, event) {
    return isCurrentPlan(plan) && (!pendingMessages(plan.sessionId).length || event.type === 'turn/end' && event.data?.reason?.kind === 'aborted')
  }
  function coordinatorWriteBlock(exec) {
    const plan = pendingPlan(exec.agent.id)
    if (!plan) return
    const target = exec.arguments?.file_path ?? exec.arguments?.path ?? exec.arguments?.notebook_path
    const protectedTasks = plan.tasks.filter(task => !['accepted', 'cancelled'].includes(task.status) && task.writes.length)
    if (isCurrentPlan(plan) && protectedTasks.length && ['pwsh', 'bash'].includes(exec.name)) return '[DSH Agentrix] 当前托管产物仍受写入保护，不能确认任意命令的写入范围。主控验证用 delegation_verify，目录与 Git 检查用 delegation_inspect；无重叠文件可直接修改。'
    if (typeof target !== 'string' || !target.trim()) return
    const writes = [path.resolve(exec.agent.session?.header?.cwd ?? plan.cwd ?? process.cwd(), target)]
    const conflict = protectedTasks.find(task => overlaps({ writes }, task))
    if (conflict) return `[DSH Agentrix] ${isCurrentPlan(plan) ? '当前需求' : '另一项需求'}的任务 ${conflict.id} 尚未验收，当前写入与原需求产物重叠：${target}。请同步给原执行者，或等待原任务验收后修改。`
  }
  function coordinationContext(sessionId) {
    if (closed || getConfig().enabled === false) return null
    const expected = expectedRoutes.get(sessionId)
    if (expected && !expected.plan.cancelled && !expected.plan.completion) return expected
    const plan = plans.get(sessionId)
    return plan && !plan.cancelled && !plan.completion && isCurrentPlan(plan)
      ? { plan, task: null } : null
  }
  function coordinationNext(plan, task, worker = false) {
    if (worker) return '继续原任务；读取使用 read/grep/glob，阶段记录用 delegation_checkpoint，正式报告用 delegation_report。不要另建团队任务或再次委派。'
    const tasks = task ? [task] : plan.tasks
    if (tasks.some(item => LIVE.includes(item.status) || LIVE.includes(item.audit?.status))) return '等待原执行者或独立审查提交正式报告，收到通知后用 delegation_verify 和 delegation_review 验收；不要重试运行中的任务，也不需要原生 wait_agent。'
    if (tasks.some(item => item.status === 'review')) return '对已返回任务使用 delegation_verify 实际验证，再用 delegation_review 逐项验收；主控不能代交 delegation_report。'
    if (tasks.some(item => item.status === 'queued')) return '用 delegation_run 启动已有任务；查看真实执行状态用 delegation_status，纠偏用 delegation_control。'
    if (tasks.some(item => ['failed', 'blocked', 'cancelled'].includes(item.status))) return '用 delegation_status 核对失败原因，处理后通过 delegation_control 明确重试；不要另建同名团队任务。'
    return '等待程序确认验收并生成交付回执；团队看板的完成标记不能代替正式验收。'
  }
  function resolveCoordinationIssue(plan, exec) {
    const issue = plan.coordinationIssue
    if (!issue || issue.resolvedAt) return
    const matchingSuccess = exec && exec.name === issue.tool && (exec.arguments?.taskId ?? null) === (issue.taskId ?? null)
    if (!matchingSuccess && issue.stage === coordinationStage(plan, issue.taskId)) return
    issue.resolvedAt = Date.now()
    remember(plan, 'plan.coordination_resolved', '协作操作问题已随正确操作或任务进展解决', undefined, { callId: issue.callId, resolvedAt: issue.resolvedAt })
  }
  function recordCoordinationFailure(exec, message, code = 'COORDINATION_OPERATION_FAILED') {
    const context = coordinationContext(exec.agent?.id)
    if (!context) return
    const { plan } = context, worker = plan.sessionId !== exec.agent.id
    const key = `${exec.agent.id}:${exec.callId}`
    if (exec.callId && (coordinationFailures.has(key) || plan.coordinationIssue?.callId === exec.callId && plan.coordinationIssue.agentId === exec.agent.id)) return
    if (exec.callId) coordinationFailures.add(key)
    if (coordinationFailures.size > 1024) coordinationFailures.delete(coordinationFailures.values().next().value)
    const task = context.task ?? plan.tasks.find(item => item.id === exec.arguments?.taskId) ?? (plan.tasks.length === 1 ? plan.tasks[0] : null)
    plan.coordinationIssue = { code, tool: exec.name, callId: exec.callId ?? null, agentId: exec.agent.id, role: worker ? modelRole(task) : 'coordinator',
      ...(task ? { taskId: task.id } : {}), message: brief(message, 1000), nextAction: coordinationNext(plan, task, worker), at: Date.now(),
      stage: coordinationStage(plan, task?.id) }
    remember(plan, 'plan.coordination_failed', (worker ? '执行者操作未执行：' : '主控操作未执行：') + exec.name + '；' + brief(message, 500),
      undefined, { coordinationIssue: clone(plan.coordinationIssue) })
    backgroundSave()
  }
  const conflictingTool = name => COORDINATION_CONFLICT_TOOLS.has(name) || (getConfig().delegationTools ?? []).includes(name)
  function unavailableTool(agent, name) {
    if (getConfig().enabled === false) return false
    const expected = expectedRoutes.get(agent.id)
    if (expected) return expected.task.role === 'reviewer' ? !REVIEW_TOOLS.has(name) : COORDINATOR_TOOLS.has(name) || conflictingTool(name) || name === 'list_subagent_models'
    const header = agent.session?.header ?? service('sessions')?.get(agent.id)?.header ?? {}
    if (header.origin === 'subagent' || header.parentSession || header.delegationDepth > 0) return false
    const entry = decisions.get(agent.id)
    if (getConfig().mode !== 'auto' && !decisionCurrent(agent.id) && entry?.recoveryUsed >= 1 && entry.recoveryKey === decisionRecoveryKey(agent.id) &&
      (getConfig().gatedTools ?? []).includes(name)) return true
    if (name === 'list_subagent_models') return true
    const plan = plans.get(agent.id)
    if (name === 'delegation_wait') return !plan || !isCurrentPlan(plan) || Boolean(plan.completion)
    if (plan && isCurrentPlan(plan) && !plan.completion) {
      if (name === 'delegation_verify') return !plan.tasks.some(task => task.status === 'review' && !task.pendingAcceptance)
      if (name === 'delegation_review') return !plan.tasks.some(task => task.status === 'review' && !task.pendingAcceptance && task.checks.some(check => check.result))
    }
    return EXECUTOR_TOOLS.has(name) || Boolean(coordinationContext(agent.id) && conflictingTool(name))
  }
  function refreshCoordinationTools(agent) {
    for (const target of agent ? [agent] : service('agents')?.list?.() ?? []) {
      const role = getConfig().enabled === false ? null : expectedRoutes.get(target.id)?.task.role === 'reviewer' ? 'reviewer'
        : expectedRoutes.has(target.id) ? 'worker' : null
      const schema = reportSchemas.get(target.id), definition = toolDefinitions.get('delegation_report')
      if (schema?.agent !== target || schema?.role !== role) {
        schema?.dispose(); reportSchemas.delete(target.id)
        if (role && definition && target.ctx?.tools?.register) {
          const properties = { ...definition.parameters.properties }
          if (role === 'worker') for (const field of ['specVerdict', 'qualityVerdict', 'issues', 'resolutions']) delete properties[field]
          else {
            for (const field of ['specVerdict', 'qualityVerdict']) properties[field] = { ...properties[field], description: 'status 为 DONE 或 DONE_WITH_CONCERNS 时必填；无法核查时报告 BLOCKED/NEEDS_CONTEXT 和 reason，不编造通过。' }
            properties.issues = { ...properties.issues, description: '审查完成时必填；没有问题也必须传 []，不能省略。阻塞或缺资料时可省略。' }
          }
          reportSchemas.set(target.id, { agent: target, role, dispose: target.ctx.tools.register({ ...definition,
            description: role === 'worker' ? '执行者提交正式报告。只填写执行结果、疑点或阻塞原因；不填写独立审查结论。成功后自动结束。'
              : '独立审查者提交只读核查报告。完成时必须填写 specVerdict、qualityVerdict 和 issues；成功后自动结束。',
            parameters: { ...definition.parameters, properties } }) })
        }
      }
      const previous = coordinationRestrictions.get(target.id)
      const names = target.ctx?.tools?.restrict
        ? [...(ctx.tools.view?.(target)?.restrictableNames ?? [])].filter(name => unavailableTool(target, name)).sort() : []
      const key = JSON.stringify(names)
      if (previous?.agent === target && previous.key === key) continue
      previous?.dispose(); coordinationRestrictions.delete(target.id)
      if (names.length) coordinationRestrictions.set(target.id, { agent: target, key, names, dispose: target.ctx.tools.restrict({ deny: names }) })
    }
  }
  disposers.push(ctx.on('agent/created', async ({ agent }) => {
    await ready; refreshCoordinationTools(agent)
    const plan = plans.get(agent.id)
    if (plan) for (const task of targetsOf(plan)) if (task.resultNotification && task.resultNotification.status !== 'delivered') scheduleResultNotification(plan, task)
  }, { global: true }))
  disposers.push(ctx.on('agent/disposed', ({ agent }) => {
    coordinationRestrictions.get(agent.id)?.dispose(); coordinationRestrictions.delete(agent.id)
    reportSchemas.get(agent.id)?.dispose(); reportSchemas.delete(agent.id)
  }, { global: true }))
  function guardCoordination(exec) {
    if (getConfig().enabled !== false && exec.name === 'list_subagent_models' && exec.agent &&
      !exec.agent.session?.header?.parentSession && exec.agent.session?.header?.origin !== 'subagent') return '[DSH Agentrix] 托管任务的模型查询使用 delegation_models，与实际派发共用检查。原生 list_subagent_models 只描述原生派单授权，不能据此判断托管配置模型失效。'
    const context = coordinationContext(exec.agent?.id)
    if (!context || !conflictingTool(exec.name)) return
    const message = `[DSH Agentrix] 当前任务由 Agentrix 托管，不能使用 ${exec.name} 另建、完成或等待另一套任务。真实状态以 delegation_status 为准。` +
      coordinationNext(context.plan, context.task, context.plan.sessionId !== exec.agent.id)
    recordCoordinationFailure(exec, message, 'COORDINATION_TOOL_CONFLICT')
    return message
  }
  function observeCoordinationResult(exec, result) {
    const context = coordinationContext(exec.agent?.id)
    if (!context || context.plan.sessionId !== exec.agent.id ||
      !([...CHECK_TOOLS, 'write', 'edit', 'apply_patch', 'multi_edit', 'notebook_edit'].includes(exec.name) || exec.name?.startsWith('delegation_') || conflictingTool(exec.name))) return
    if (result.isError || result.value?.passed === false) recordCoordinationFailure(exec, textOf(result.content) || result.value?.summary || '工具没有成功执行')
    else if (context.plan.coordinationIssue?.callId !== exec.callId && !coordinationFailures.has(`${exec.agent.id}:${exec.callId}`) &&
      !['delegation_status', 'delegation_inspect', 'delegation_note', 'delegation_decide'].includes(exec.name)) resolveCoordinationIssue(context.plan, exec)
  }
  function remember(plan, type, message, task, details = {}) {
    records.attach(plan)
    const event = { id: randomUUID(), type, at: Date.now(), message: brief(message, 1000),
      ...(task ? { taskId: task.id, attempt: task.attempts, ...(task.role ? { role: task.role } : {}) } : {}), ...details }
    plan.updatedAt = event.at
    const { id, at, taskId } = event
    plan.recentEvents = [...(plan.recentEvents || []), { id, type, at, message: event.message, ...(taskId ? { taskId } : {}) }].slice(-8)
    if (!pendingRecords.has(plan.archive.id)) pendingRecords.set(plan.archive.id, { plan, events: [] })
    pendingRecords.get(plan.archive.id).events.push(event)
    if (!type.startsWith('plan.coordination_')) resolveCoordinationIssue(plan)
    refreshCoordinationTools()
  }
  const save = () => {
    if (recoveryFailed) return Promise.reject(new Error(`任务文件恢复失败，保留原文件：${storageError}`))
    dirty = true
    if (!writing) writing = (async () => {
      try {
        while (dirty) {
          dirty = false
          const batch = [...pendingRecords.entries()].map(([id, entry]) =>
            ({ id, entry, plan: snapshotPlan(entry.plan, true), events: entry.events.slice() }))
          await runtimeStore.write({ version: 1, plans: [...plans.values()].map(plan => snapshotPlan(plan, true)), requestUsage: usageLedger.snapshot(), decisions: [...decisions.values()] })
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
      const stored = await runtimeStore.read()
      if (stored.version !== 1 || !Array.isArray(stored.plans) || stored.plans.length > MAX_PLANS) throw new Error('任务文件格式不支持')
      usageLedger.restore(stored.requestUsage)
      for (const entry of stored.decisions ?? []) {
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
          task.interruption = { source: 'reload', at: Date.now(), previousStatus: task.status }
          plan.interruption ??= { source: 'reload', at: Date.now(), reason: 'DSH 或插件重新加载，执行已中断；明确继续后沿用原计划恢复。' }
          task.status = 'blocked'; task.recovered = true
          task.error = plan.interruption.reason
          remember(plan, 'task.interrupted', task.error, task)
        }
        for (const task of plan.tasks) {
          delete task.pendingAcceptance
          for (const check of task.checks) delete check.verifying
        }
        if (plan.cancelled && plan.cancellation) {
          for (const task of plan.tasks) if (task.status !== 'accepted') requestTaskStop(plan, task, plan.cancellation.reason)
          updateCancellationCleanup(plan)
          if (plan.completion) plan.completion.cleanup = clone(plan.cancellation.cleanup)
        }
      }
      for (const plan of stored.plans) plans.set(plan.sessionId, plan)
      if (plans.size) await save()
      for (const plan of plans.values()) for (const task of targetsOf(plan)) if (task.resultNotification && task.resultNotification.status !== 'delivered') scheduleResultNotification(plan, task)
    } catch (error) {
      if (error.code !== 'ENOENT') { recoveryFailed = true; storageError = messageOf(error); console.warn('[dsh-delegation-first] 任务恢复失败：%s', storageError) }
    }
    refreshCoordinationTools()
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
  function decisionGuidance(sessionId) {
    const pending = pendingMessages(sessionId), source = sourceOf(sessionId)
    return [
      source ? '当前需求已确认；请由主控判断新消息属于 new/continue/update/question，继续或提问沿用原决定，范围改变须更新实际方式和理由。'
        : '尚无已确认需求：首次确认实际需求用 relation:"new"，不能用 continue/update。',
      pending.length ? '本会话待关联消息（仅事实，不代替主控判断）：' + JSON.stringify(pending.map(message => ({ messageId: message.messageId, text: brief(message.text, 180) }))) : '',
      '直接执行或逐条关联消息用 delegation_decide({messageId,relation,mode,reason})；新需求/方案变化由主控选择 direct/delegate 并填写真实取舍理由。新委派也可 delegation_plan({messageId,relation,decisionReason,start:true,...}) 一次确认并派发。多条消息逐条确认，不能默认选最后一条。',
      '判断保存成功后继续当前需求，仅重试仍需执行且尚未成功的操作；若补充改变范围，按新范围执行。不要查插件源码或历史会话寻找原因，不新开分类代理，不要求用户确认。read/grep/glob、delegation_inspect/note 仍可准备。',
    ].filter(Boolean).join('\n')
  }
  function decisionRecoveryKey(sessionId) {
    return pendingMessages(sessionId).at(-1)?.messageId ?? revisionOf(sessionId)?.messageId
  }
  async function recoverDecision(sessionId) {
    if (decisionCurrent(sessionId) || decisionWrites.has(sessionId)) return false
    const entry = decisions.get(sessionId), source = sourceOf(sessionId), revision = revisionOf(sessionId)
    if (!pendingMessages(sessionId).length && entry?.messageResolution?.relation === 'question') return false
    const key = decisionRecoveryKey(sessionId)
    if (!key) return false
    if (entry?.recoveryKey === key && entry.recoveryUsed >= 1) return false
    const previous = clone(entry ?? null)
    decisions.set(sessionId, { ...entry, sessionId, source: clone(source), revision: clone(revision), recoveryKey: key, recoveryUsed: 1 })
    try { await save() }
    catch (error) { if (previous) decisions.set(sessionId, previous); else decisions.delete(sessionId); throw error }
    refreshCoordinationTools(service('agents')?.get(sessionId))
    return true
  }
  async function recordDecision(args, exec) {
    const parent = own(exec), previous = clone(decisions.get(parent.id) ?? null)
    if (decisionWrites.has(parent.id)) throw new Error('判断正在保存，请等待本次工具返回')
    const entry = decisions.get(parent.id) ?? { sessionId: parent.id, source: clone(getSource(parent.id)), revision: clone(getRevision(parent.id)) }
    const pending = pendingMessages(parent.id)
    const messageHelp = () => '。本会话待关联消息：' + JSON.stringify(pending.map(message => ({ messageId: message.messageId, text: brief(message.text, 400) }))) +
      '。请用 delegation_decide({messageId,relation,...}) 逐条确认；delegation_status 的 context.pendingMessages 提供消息内容，无需搜索其他会话文件。'
    if (!args.messageId && pending.length > 1) throw new Error('存在多条待关联消息，请提供真实 messageId 分别确认，不能自动选最后一条' + messageHelp())
    const binding = coordinatorUsage.get(parent.id)
    const message = args.messageId ? entry.messages?.find(item => item.messageId === args.messageId && !item.withdrawn)
      : binding ? entry.messages?.find(item => item.messageId === binding.messageId && !item.resolution && !item.withdrawn) : pending[0]
    if (args.messageId && !message) throw new Error('消息编号不存在于本会话的真实用户消息，不能伪造关联' + messageHelp())
    const relation = args.relation ?? (!entry.source ? 'new' : !message ? 'update' : null)
    if (!['new', 'continue', 'update', 'question'].includes(relation)) throw new Error('请用 relation 明确 new/continue/update/question；程序不根据措辞猜需求归属')
    if (['continue', 'update'].includes(relation) && !entry.source) throw new Error(decisionGuidance(parent.id))
    const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
    const plan = plans.get(parent.id)
    const continuationRepair = relation === 'continue' && interruptedPlan(plan) && args.mode === 'delegate' && reason.length > 0
    const changes = ['new', 'update'].includes(relation) || !entry.decision && relation !== 'question' || continuationRepair
    if (changes && (!['direct', 'delegate'].includes(args.mode) || !reason || reason.length > 500)) throw new Error('新需求、范围或方案变化须提供 direct/delegate 和非空的具体理由，最多 500 字')
    if (!changes && args.mode && args.mode !== entry.decision?.mode) throw new Error('执行方式变化请使用 update 并说明理由')
    const source = relation === 'new' || !entry.source ? message ? { messageId: message.messageId, text: message.text } : getSource(parent.id) : entry.source
    if (!source?.messageId) throw new Error('尚未取得当前需求编号，请先接收用户需求后记录判断')
    const revision = ['new', 'update'].includes(relation) ? message ? { messageId: message.messageId, text: message.text } : source : entry.revision ?? source
    if (changes && relation !== 'new' && args.mode === 'direct' && plan && !['accepted', 'cancelled'].includes(planStatus(plan))) throw new Error('托管计划尚未结束，请监督、返工或明确取消，不能同时改为主控重复实现')
    const model = coordinatorModel(parent, 0, 'decision'), at = Date.now()
    const decision = changes ? { mode: args.mode, reason, requestId: source.messageId, revisionId: revision.messageId, at, model } : entry.decision ?? null
    const resolution = { messageId: message?.messageId ?? revision.messageId, requestId: source.messageId, relation, at, model, ...(reason ? { reason } : {}) }
    const next = { ...entry, source: clone(source), revision: clone(revision), decision, messageResolution: resolution }
    if (message && next.argumentRecovery?.requestId === message.messageId) next.argumentRecovery = { ...next.argumentRecovery, requestId: source.messageId }
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
    if (message && relation === 'continue' && plan?.source?.messageId === source.messageId && interruptedPlan(plan) &&
      decisionCurrent(parent.id) && decisionFor(parent.id)?.mode === 'delegate') await runPlan({}, exec)
    return { decision: clone(decision), source: clone(source), messageResolution: clone(resolution), pendingMessages: clone(pendingMessages(parent.id)) }
  }
  function taskOf(plan, id) {
    const task = plan.tasks.find(item => item.id === id)
    if (!task) throw new Error(`任务 ${id} 不存在`)
    return task
  }
  function workerPrompt(plan, task) {
    const { fixes, criteria } = taskPromptScope(task)
    return [
      '你是执行者，使用配置的执行模型，按主控确定的目标、接口和边界完成任务，不再委派。可自行决定不改变接口、范围和验收要求的局部实现细节；影响需求含义、接口、数据或权限的不确定性，以及缺资料或能力不足，通过 delegation_report 报告 NEEDS_CONTEXT/BLOCKED 交回主控，不自行换模型或扩大范围。',
      '区分用户硬要求与主控建议。优先读取给定必读材料、使用已核实事实，参考材料按具体疑问读取，不重新全面调查。任务卡存在冲突或需要新增硬指标时把具体问题交主控裁决，不自行删减验收要求。',
      `总目标：${plan.goal}`, `任务：${task.title}`, fixes ? `本次仅修复原问题。前次执行报告：${task.reworkContext.reportPath}；先按需读取已有结论和实际交付物，不重新全面调查。修复报告须说明修改位置及针对性验证结果。` : task.instructions, `边界：${task.scope}`,
      `只允许修改：${task.writes.join('、') || '无（只读）'}`, `交付物：${task.outputs.join('、')}`,
      fixes ? '本次修复相关标准（最终验收仍覆盖全部原标准）：' : '验收标准：', ...criteria.map(item => `${item.id}：${item.text}`),
      '自测步骤（与主控验证使用同一份任务卡；自测结果不代表已验收）：',
      ...task.checks.map((check, i) => `${i + 1}. ${check.tool} ${JSON.stringify(check.arguments)}`),
      '可计算检查尽量合并执行并复用成功结果；只在相关产物或要求变化、检查失败时重验。满足本次验收标准后立即提交报告，有顾虑列入 concerns；不为润色偏好或反推旧稿统计口径反复自审。',
      ...plan.tasks.filter(item => task.dependsOn.includes(item.id)).map(item => `已验收前置任务 ${item.id}：${item.execution ? item.execution.summary + '；完整报告：' + item.execution.reportPath : brief(item.report)}`),
      task.feedback ? `主控返工要求：${task.feedback}` : '',
      task.reworkIds?.length ? '只修复以下问题及其直接回归，不扩展任务：\n' + JSON.stringify(task.issues.filter(issue => task.reworkIds.includes(issue.id))) : '',
      '短任务只提交最终报告。较长任务在调查转实现、自检结束或需要主控裁决时，用 delegation_checkpoint({requestReview:true,...}) 记录当前成果、剩余问题、下一步和成功工具 callId；主控核对不要求你另开代理或等待用户点击继续。记录不代表验收。读取用 read/grep/glob，read 参数使用 file_path；管理入口仅供主控。',
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
  function applyAuditResult(owner, task) {
    for (const resolution of task.resolutions ?? []) {
      const issue = owner.issues.find(item => item.id === resolution.id)
      issue.status = resolution.status === 'ADDRESSED' ? 'addressed' : 'open'
      issue.resolutionEvidence = resolution.evidence; issue.reviewedAttempt = owner.attempts
    }
    appendIssues(owner, task.issues ?? [], 'reviewer')
  }
  function auditPrompt(plan, task) {
    const { fixes, criteria } = taskPromptScope(task)
    return [
      '你是独立的只读审查者，同时核对需求符合性和代码质量。不要修改文件、执行命令或继续委派；主控负责实际运行验证。',
      `总目标：${plan.goal}`, `任务：${task.title}`, fixes ? `本次为原问题复审。前次执行报告：${task.reworkContext.reportPath}；从本次修复报告定位修改，只按需读取原问题与修改附近的实际交付物，不重新全面调查。` : task.instructions, `边界：${task.scope}`,
      `可修改范围（仅用于核查越界）：${task.writes.join('、') || '无'}`, `交付物：${task.outputs.join('、')}`,
      fixes ? '本次复查相关要求：' : '逐条验收要求：', ...criteria.map(item => `${item.id}（criterion=${item.criterion}）：${item.text}`),
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
    if (task.issue?.code !== 'MODEL_ROUTE_MISMATCH') {
      remember(plan, 'task.failure_isolated', `任务 ${task.id} 的故障仅影响本任务；依赖任务等待，无关任务继续，不自动重试故障任务`, task)
      return
    }
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
  async function resumeInterrupted(plan, parent, signal) {
    const interrupted = targetsOf(plan).filter(task => task.interruption && task.status === 'blocked' && (!task.issue || task.issue.code === 'HOST_INTERRUPTED'))
    for (const task of interrupted) {
      signal?.throwIfAborted()
      if (task.childId && !['released', 'drained', 'none'].includes(task.release?.status)) {
        await service('subagents').drainChildren(parent, [task.childId])
        signal?.throwIfAborted()
        task.release = { status: 'drained', at: Date.now() }
      }
      task.recovered = false
      if (closed || plan.cancelled) throw new Error('当前计划已停止，不能恢复执行')
      if (live.has(targetKey(plan, task))) throw new Error('旧执行仍在释放，请等待本次中断清理完成后继续原计划')
      if (task.execution?.commitState === 'committed') {
        task.issue = null; task.error = task.execution.reason ?? null
        task.status = ['DONE', 'DONE_WITH_CONCERNS'].includes(task.execution.status) ? task.role === 'reviewer' ? 'completed' : 'review' : 'blocked'
        if (task.status === 'completed') applyAuditResult(taskOf(plan, task.id), task)
        else if (task.status === 'review' && requiresAudit(task) && task.audit?.forAttempt !== task.attempts) queueAudit(task)
        delete task.interruption
        remember(plan, 'task.report_restored', '正式报告已确认，保留原结果继续验证验收，不重复执行', task)
        continue
      }
      if (task.attempts >= getConfig().maxAttempts) continue
      task.status = 'queued'; task.error = null; task.issue = null
      task.feedback = '沿用原需求继续中断的任务。先核对已有文件、阶段记录和工具结果，只完成未完成部分；不要重复已经成功的操作。' + (task.feedback ? '\n' + task.feedback : '')
      remember(plan, 'task.resumed', '已核对旧执行释放状态，沿用原任务继续未完成部分', task, { interruption: clone(task.interruption) })
      delete task.interruption
    }
    if (plan.interruption) {
      plan.interruption.resumedAt = Date.now()
      remember(plan, 'plan.resumed', '用户明确继续，保留原任务、报告与验收证据，恢复未完成部分')
    }
    invalidateCompletion(plan)
    plan.wakeSuppressed = false
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
    if (handle.releasePromise && handle.releasedReceipt === handle.receipt && !handle.releaseFailed) return handle.releasePromise
    const retryDrain = handle.releaseFailed && handle.releasedReceipt === handle.receipt
    handle.releasedReceipt = handle.receipt
    handle.releaseFailed = false
    handle.releasePromise = (async () => {
      if (!handle.receipt) {
        task.release = { status: 'none', at: Date.now() }
        return null
      }
      const drain = async () => {
        const parent = handle.parent ?? service('agents')?.get(handle.planSessionId)
        if (!parent || !task.childId || typeof service('subagents')?.drainChildren !== 'function') throw new Error('无法确认旧子任务已释放')
        await service('subagents').drainChildren(parent, [task.childId])
      }
      try {
        if (retryDrain) await drain()
        else await handle.receipt.dispose()
        task.release = { status: retryDrain ? 'drained' : 'released', at: Date.now() }
        return null
      } catch (error) {
        if (!retryDrain) try {
          await drain(); task.release = { status: 'drained', at: Date.now() }; return null
        } catch (drainError) { error = drainError }
        handle.releaseFailed = true
        task.recovered = true
        task.release = { status: 'failed', at: Date.now(), error: messageOf(error) }
        return error
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
    if (task.execution?.commitState === 'committed' && task.supervision?.pending?.advisory) task.supervision.pending = null
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
      if (task.status === 'completed') applyAuditResult(handle.owner, task)
      if (task.status === 'review' && task.protocolVersion && requiresAudit(task)) queueAudit(task)
      task.finishedAt = Date.now()
      remember(plan, ['review', 'completed'].includes(task.status) ? 'task.returned' : task.status === 'blocked' ? 'task.blocked' : 'task.failed',
          task.status === 'completed' ? '独立审查已返回，等待主控核对结论' : task.status === 'review' ? '子 Agent 已返回，等待主 Agent 验证与评审' : task.error,
          task, { report: task.report, error: task.error })
      if (['failed', 'blocked'].includes(task.status)) pauseAfterFailure(plan, task)
    }
    try {
      await save()
      if (!closed) await pump()
      if (task.protocolVersion >= 2) await notifyParent(plan, task, handle)
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
  function modelAuthorization(parent, selected) {
    const session = parent?.session
    if (!session?.snapshotEvents) return { status: 'unknown', source: 'unavailable', message: '当前宿主没有提供会话授权读取接口，不能确认托管模型授权' }
    let policy
    try {
      if (!modelPolicies.has(session)) {
        const event = session.snapshotEvents().find(event => event.type === 'subagent/model-selection-policy')
        modelPolicies.set(session, event ? clone(event.data?.allowedModels ?? false) : null)
      }
      policy = modelPolicies.get(session)
    } catch (error) { return { status: 'unknown', source: 'unavailable', message: '读取会话模型授权失败：' + messageOf(error) } }
    if (policy === null) return { status: 'allowed', source: 'agentrix-config', message: '托管任务使用用户保存的 Agentrix 模型配置；本会话没有原生模型白名单，原生模型查询的父模型范围不用于托管派发' }
    if (!Array.isArray(policy) || !policy.length || policy.some(route => !route?.provider || !route?.model)) return { status: 'unknown', source: 'session-policy', message: '当前会话模型授权记录无效，未启动子任务' }
    const allowed = policy.some(route => route.provider === selected.provider && route.model === selected.model)
    return { status: allowed ? 'allowed' : 'blocked', source: 'session-policy', message: allowed ? '配置模型符合当前会话已记录的授权' : '配置模型不在当前会话已记录的授权范围内；这不表示模型服务不可用' }
  }
  async function resolveManagedRoute(parent, selected, role, signal) {
    const authorization = modelAuthorization(parent, selected)
    if (authorization.status !== 'allowed') {
      const issue = { code: authorization.status === 'blocked' ? 'MODEL_ROUTE_UNAUTHORIZED' : 'MODEL_AUTHORIZATION_UNAVAILABLE', retryable: false,
        role, provider: selected.provider, model: selected.model, message: authorization.message,
        action: '请核对 DSH 当前会话授权；保存模型配置不代表旧会话授权已刷新。通过宿主支持的授权入口处理后继续原计划，不切换入口绕过授权。' }
      throw Object.assign(new Error(issue.message + '。' + issue.action), { issue, authorization })
    }
    return { resolved: await validateModelRoute(service('llm'), selected, role, signal), authorization }
  }
  function recordModelSelection(task, selected, source, resolved = null, authorization = null) {
    task.modelRoute = { role: modelRole(task), source, requested: clone(selected), resolved: resolved ? clone(resolved) : null, actual: null, authorization }
    task.model = { ...(resolved ?? selected), source }
  }
  function modelRoutingState(sessionId) {
    const parent = service('agents')?.get(sessionId)
    if (!parent || parent.session?.header?.origin === 'subagent') return null
    try {
      const { selected } = modelSelection({ role: 'worker' }, parent)
      return { requested: selected, authorization: modelAuthorization(parent, selected), validation: 'not-checked', checkTool: 'delegation_models' }
    } catch (error) { return { requested: null, authorization: null, validation: 'blocked', issue: error.issue ?? { message: messageOf(error) }, checkTool: 'delegation_models' } }
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
      if (task !== retryTask && task.status !== 'queued' && !(task.status === 'blocked' && ['MODEL_CONFIG_INVALID', 'MODEL_ROUTE_UNAUTHORIZED', 'MODEL_AUTHORIZATION_UNAVAILABLE'].includes(task.issue?.code))) continue
      try {
        const { selected, source } = modelSelection(task, parent)
        recordModelSelection(task, selected, source)
        const key = JSON.stringify([modelRole(task), selected])
        if (!checked.has(key)) checked.set(key, resolveManagedRoute(parent, selected, modelRole(task), signal))
        const { resolved, authorization } = await checked.get(key)
        recordModelSelection(task, selected, source, resolved, authorization)
        if (task.protocolVersion && requiresAudit(task)) {
          const review = modelSelection({ role: 'reviewer', dispatcherModel: coordinatorModel(parent, task.attempts + 1) }, parent).selected
          const reviewKey = JSON.stringify(['reviewer', review])
          if (!checked.has(reviewKey)) checked.set(reviewKey, resolveManagedRoute(parent, review, 'reviewer', signal))
          await checked.get(reviewKey)
        }
        if (['MODEL_CONFIG_INVALID', 'MODEL_ROUTE_UNAUTHORIZED', 'MODEL_AUTHORIZATION_UNAVAILABLE'].includes(task.issue?.code)) {
          task.status = 'queued'; task.error = null; task.issue = null
          remember(plan, 'task.unblocked', '模型配置与会话授权检查通过，任务可继续派发', task)
        }
      } catch (error) {
        if (error.authorization && error.issue?.role === modelRole(task) && task.modelRoute) task.modelRoute.authorization = error.authorization
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
    clearTimeout(notificationTimers.get(task)); notificationTimers.delete(task); delete task.resultNotification
    const key = targetKey(plan, task)
    const handle = { key, planSessionId: plan.sessionId, parent, task, owner, done: Promise.withResolvers(), controller: new AbortController(), receipt: null, settling: false }
    live.set(key, handle)
    task.status = 'starting'; task.error = null; task.issue = null
    const waiter = waitingParents.get(plan.sessionId)
    if (waiter?.awaitingDispatch) waiter.wake.resolve()
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
      const { resolved, authorization } = await resolveManagedRoute(parent, selected, modelRole(task), handle.controller.signal)
      handle.controller.signal.throwIfAborted()
      recordModelSelection(task, selected, source, resolved, authorization)
      if (!reviewer && requiresAudit(task)) {
        await resolveManagedRoute(parent, modelSelection({ role: 'reviewer', dispatcherModel: dispatcher }, parent).selected, 'reviewer', handle.controller.signal)
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
      delete task.release
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
      if (error.authorization && error.issue?.role === modelRole(task) && task.modelRoute) task.modelRoute.authorization = error.authorization
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
        if (!plan.autoDispatch || plan.cancelled || targetsOf(plan).some(task => task.recovered) || getConfig().enabled === false) continue
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
            waitingParents.get(plan.sessionId)?.wake.resolve()
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
    observeCoordinationResult(exec, result)
    const childPlan = [...plans.values()].find(plan => targetsOf(plan).some(task => task.childId === exec.agent?.id && LIVE.includes(task.status)))
    if (childPlan) {
      const task = targetsOf(childPlan).find(task => task.childId === exec.agent.id)
      task.progress = { tool: exec.name, at: Date.now(), failed: Boolean(result.isError) }
      if (result.isError) remember(childPlan, 'task.tool_failed', '执行工具失败：' + brief(exec.name, 100), task)
      const handle = live.get(targetKey(childPlan, task))
      const alert = observeTool(task, exec, result, Date.now())
      if (alert) requestSupervision(childPlan, task, handle, alert)
      if (typeof exec.callId === 'string' && task.supervision?.lastProgress?.callId === exec.callId && task.supervision.lastProgress.kind === 'file_change') {
        const target = exec.arguments?.file_path ?? exec.arguments?.path
        const base = exec.agent.session?.header?.cwd ?? childPlan.cwd
        const cwd = typeof base === 'string' && base.trim() ? base : null
        const targetPath = typeof target === 'string' && (cwd || path.isAbsolute(target)) ? path.resolve(cwd ?? '', target) : null
        const output = targetPath && task.outputs?.find(value => (cwd || path.isAbsolute(value)) &&
          normalizedPath(path.resolve(cwd ?? '', value)) === normalizedPath(targetPath))
        if (output) {
          task.supervision.lastProgress.summary = '已修改声明的交付文件，内容尚待验证：' + brief(output, 300)
          requestSupervision(childPlan, task, handle, { code: 'PROGRESS_REVIEW', advisory: true, reviewKey: 'implementation',
            reason: task.supervision.lastProgress.summary + '。请核对当前成果与剩余要求，必要检查达标后及时提交报告；这不代表任务已完成。', evidence: [exec.callId] })
        }
      }
      if (handle) scheduleSupervision(childPlan, task, handle)
      backgroundSave()
    }
  }
  // Native local activations return only output + stopReason. Capture the
  // committed error before native cleanup releases the child Agent.
  disposers.push(ctx.on('session/event', (session, event) => {
    observeInput(session, event)
    if (event?.type === 'tool/call') {
      const owner = expectedRoutes.get(session?.id)?.task ?? decisions.get(session?.id)
      if (owner?.argumentRecovery?.status === 'retrying' && owner.argumentRecovery.tool === event.data?.name) {
        owner.argumentRecovery.status = 'parsed'; owner.argumentRecovery.parsedAt = Date.now(); backgroundSave()
      }
    }
    if (event?.type === 'subagent/model-selection-policy') {
      const target = service('agents')?.get(session?.id)?.session
      if (target && modelPolicies.get(target) === null) modelPolicies.set(target, clone(event.data?.allowedModels ?? false))
    }
    if (coordinationContext(session?.id) && plans.has(session.id)) {
      if (event?.type === 'tool/call') {
        const call = event.data
        let args = call.arguments
        try { if (typeof args === 'string') args = JSON.parse(args) } catch { args = {} }
        coordinationCalls.set(`${session.id}:${call.callId}`, { name: call.name, callId: call.callId,
          arguments: { taskId: args?.taskId }, agent: { id: session.id } })
        if (coordinationCalls.size > 256) coordinationCalls.delete(coordinationCalls.keys().next().value)
      } else if (event?.type === 'tool/result') {
        const message = event.data?.message, key = `${session.id}:${message?.toolCallId}`, exec = coordinationCalls.get(key)
        coordinationCalls.delete(key)
        if (exec) observeCoordinationResult(exec, message)
      }
    }
    const parentPlan = plans.get(session?.id)
    if (event?.type === 'turn/end' && Number.isSafeInteger(parentPlan?.delivery?.turn) && parentPlan.delivery.turn === event.data?.turn && !closed) {
      parentPlan.delivery.anchorSeq = deliveryAnchor(session, event.data.turn) ?? event.seq
      if (!pendingRecords.has(parentPlan.archive.id)) pendingRecords.set(parentPlan.archive.id, { plan: parentPlan, events: [] })
      backgroundSave()
    }
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
      if (!closed && !parentPlan?.cancelled && parentPlan?.coordinatorIssue && !parentPlan.coordinatorIssue.resolvedAt && coordinatorEventMatchesPlan(parentPlan, event)) {
        parentPlan.coordinatorIssue.resolvedAt = Date.now()
        parentPlan.wakeSuppressed = false
        invalidateCompletion(parentPlan)
        remember(parentPlan, 'plan.coordinator_resumed', '主控模型已返回响应，继续核对原交付物并验证验收')
        backgroundSave()
      }
    }
    if (!closed && parentPlan?.protocolVersion >= 2 && !parentPlan.cancelled && coordinatorEventMatchesPlan(parentPlan, event) && planStatus(parentPlan) !== 'accepted' && event?.type === 'turn/end' && ['aborted', 'error'].includes(event.data?.reason?.kind)) {
      const aborted = event.data.reason.kind === 'aborted'
      const issue = !aborted && modelServiceIssue(event.data.reason.error, 'coordinator', usageTarget(session.id))
      if (issue) parentPlan.coordinatorIssue = issue
      const reason = aborted ? '宿主中断当前执行，尚未完成验收' : issue ? issue.message + '。' + issue.details : '主控执行失败：' + messageOf(event.data.reason.error)
      parentPlan.wakeSuppressed = true; parentPlan.autoDispatch = false
      invalidateCompletion(parentPlan)
      if (aborted) parentPlan.interruption = { source: 'host', at: Date.now(), reason }
      for (const task of targetsOf(parentPlan)) if (['queued', ...LIVE].includes(task.status)) {
        if (aborted) {
          task.interruption = { source: 'host', at: Date.now(), previousStatus: task.status }
          task.error = reason
          task.issue = { code: 'HOST_INTERRUPTED', retryable: false, message: reason }
        }
        else {
          task.error ||= reason
          task.issue ||= issue || { code: 'COORDINATOR_FAILED', retryable: false, message: reason }
        }
        task.status = 'blocked'
      }
      const handles = [...live.values()].filter(handle => handle.planSessionId === parentPlan.sessionId)
      for (const handle of handles) { clearTaskTimers(handle); handle.controller.abort(new Error(reason)) }
      const operation = (async () => {
        await Promise.all(handles.map(async handle => {
          const failure = await releaseChild(handle, handle.task)
          if (failure) {
            handle.task.recovered = true
            remember(parentPlan, 'task.cleanup_failed', '旧执行清理失败，恢复前必须先完成清理：' + messageOf(failure), handle.task)
          }
          if (live.get(handle.key) === handle) live.delete(handle.key)
          expectedRoutes.delete(handle.task.childId); handle.done.resolve()
        }))
        remember(parentPlan, aborted ? 'plan.host_interrupted' : 'plan.host_failed', reason)
        finishPlan(parentPlan, reason)
        await save()
      })()
      interrupting.set(parentPlan.sessionId, operation)
      return operation.catch(error => { storageError = messageOf(error) }).finally(() => {
        if (interrupting.get(parentPlan.sessionId) === operation) interrupting.delete(parentPlan.sessionId)
      })
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
    const { plan } = ownPlan(exec), task = taskOf(plan, args.taskId)
    if (verifyingTasks.has(task)) throw new Error('该任务的批量验证正在执行，请等待结果')
    if (args.checkIndex !== undefined) return verifyCheck(args, exec)
    if (task.checks.some(check => check.verifying)) throw new Error('请等待正在执行的验证完成')
    verifyingTasks.add(task)
    try {
      const results = []
      for (let checkIndex = 0; checkIndex < task.checks.length; checkIndex++) {
        if (exec.signal?.aborted) throw exec.signal.reason ?? new Error('验证已取消')
        if (plan.cancelled || task.status === 'cancelled') throw new Error('任务已取消，停止后续验证')
        const { criteria: _criteria, nextAction: _nextAction, ...evidence } = await verifyCheck({ ...args, checkIndex }, exec)
        results.push({ checkIndex, ...evidence })
      }
      return { taskId: task.id, passed: results.every(result => result.passed), results, criteria: criteriaOf(task) }
    } finally { verifyingTasks.delete(task) }
  }
  async function verifyCheck(args, exec) {
    const { plan, parent } = ownPlan(exec), task = taskOf(plan, args.taskId)
    if (task.status !== 'review') throw new Error('只有待评审任务可以运行主控验证')
    if (!Number.isInteger(args.checkIndex) || !task.checks[args.checkIndex]) throw new Error('验证步骤编号无效（从 0 开始）')
    const check = task.checks[args.checkIndex]
    if (check.verifying) throw new Error('该验证步骤正在执行')
    if (task.pendingAcceptance) throw new Error('验收结果正在确认，不能同时更换验证证据')
    invalidateCompletion(plan)
    check.verifying = true
    check.result = null; task.review = null
    try {
      await save()
      const { result, callId } = await executePermitted(parent, check.tool, check.arguments, exec)
      if (exec.signal?.aborted) throw exec.signal.reason ?? new Error('验证已取消')
      if (plan.cancelled || task.status === 'cancelled') throw new Error('任务已取消，本次验证不登记为成功')
      const value = result.value, exitCode = value?.exitCode
      const shell = ['pwsh', 'bash'].includes(check.tool)
      // Shell success requires an actual exit code. A background job or missing status is inconclusive.
      const passed = !result.isError && (!shell || exitCode === 0)
      const output = textOf(result.content) || JSON.stringify(value) || ''
      const evidence = { callId, ref: 'E' + randomUUID().replaceAll('-', '').slice(0, 12), tool: check.tool, passed, at: Date.now(), attempt: task.attempts,
        summary: brief(output, 2000), truncated: output.length > 2000, outputCharacters: output.length, ...(shell ? { exitCode: exitCode ?? null } : {}) }
      if (evidence.truncated) {
        try { evidence.outputPath = await records.writeVerification(plan, task, callId, output) }
        catch (error) { throw new Error('完整验证输出保存失败，本次验证未登记；处理存储问题后重新验证：' + messageOf(error)) }
        evidence.readOutput = `摘要已截断。用 delegation_status({taskId:"${task.id}",detail:"full",checkIndex:${args.checkIndex},offset:0,limit:4000}) 分段读取完整结果；offset 从 0 开始，按返回的 nextOffset 继续。读取成功不等于内容符合要求。`
      }
      check.result = evidence
      task.evidence = [...task.evidence, evidence].slice(-12)
      task.review = null
      remember(plan, 'task.verified', '主 Agent 验证' + (passed ? '通过：' : '未通过：') + check.tool,
        task, { evidence })
      await save()
      return { ...evidence, criteria: criteriaOf(task), nextAction: '按 C1、C2 等 criterionId 逐条填写 finding，在 evidence 中直接引用 ref；不要拼接 callId 或更改编号。' }
    } finally { delete check.verifying }
  }
  async function review(args, exec) {
    const { plan, parent } = ownPlan(exec), task = taskOf(plan, args.taskId)
    const presentation = args.delivery === undefined ? null : deliveryOptions(plan, args.delivery)
    if (task.status !== 'review') throw new Error('只能评审已经返回结果的任务')
    args = { ...args, findings: reviewFindings(task, args.findings), issues: reviewFindings(task, args.issues),
      resolutions: Array.isArray(args.resolutions) ? args.resolutions.map(item => ({ ...item, evidence: reviewEvidence(task, item.evidence) })) : args.resolutions }
    if (task.pendingAcceptance) throw new Error('当前验收正在通过工具管线确认，不能重复提交')
    if (verifyingTasks.has(task) || task.checks.some(check => check.verifying)) throw new Error('请等待正在执行的验证完成')
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
      task.reworkContext = { fromAttempt: task.attempts, reportPath: task.execution?.reportPath ?? null, expanded: criteria.length > 0 }
      forwardInputs(plan, task, inputs, criteria, feedback)
      invalidateCompletion(plan)
      task.feedback = feedback; task.status = 'queued'; task.evidence = []; task.review = null
      task.audit = null
      task.checks.forEach(check => { check.result = null })
      remember(plan, 'task.rework', '主 Agent 要求返工：' + feedback, task)
    } else if (args.verdict === 'accept') {
      if (unresolvedInputs(plan).length) throw new Error('还有未处理的用户补充消息；先同步新增要求或用 acknowledge 说明纯答复，再验收')
      const auditPassed = task.audit?.status === 'completed' && task.audit.forAttempt === task.attempts && task.audit.specVerdict === 'pass' && task.audit.qualityVerdict === 'pass'
      if (task.protocolVersion && (requiresAudit(task) || task.audit) && !auditPassed) throw new Error('本次执行的独立审查尚未通过，不能验收；请核对审查状态和具体问题')
      const resolutions = args.resolutions ?? [], openIssues = (task.issues ?? []).filter(issue => issue.status === 'open' && issue.severity !== 'minor')
      if (!Array.isArray(resolutions) || new Set(resolutions.map(item => item.id)).size !== resolutions.length) throw new Error('resolutions 必须是问题确认数组，问题编号不能重复')
      for (const resolution of resolutions) {
        const issue = (task.issues ?? []).find(issue => issue.id === resolution.id)
        if (!issue) throw new Error('resolutions 包含未知问题编号：' + resolution.id + '；请使用当前任务 issues 中的真实编号')
        if (resolution.status !== 'ADDRESSED' || !Array.isArray(resolution.evidence) || !resolution.evidence.length ||
          !resolution.evidence.every(id => task.evidence.some(evidence => evidence.callId === id && evidence.passed && evidence.attempt === task.attempts))) throw new Error('原问题只能标为 ADDRESSED，并引用本次实际验证通过的证据')
        if (task.audit) {
          if (!auditPassed || issue.status !== 'addressed' || issue.reviewedAttempt !== task.attempts ||
            !task.audit.resolutions?.some(item => item.id === issue.id && item.status === 'ADDRESSED')) throw new Error('本次独立审查尚未确认问题 ' + issue.id + ' 已解决；主控不能代替审查者关闭问题。请核对 audit.resolutions 与 issues；已经由本次独审确认的条目可省略重复 resolutions')
        } else if (!openIssues.includes(issue)) throw new Error('主控只能用本次实际验证证据确认当前未解决的重要问题')
      }
      if (openIssues.some(issue => !resolutions.some(item => item.id === issue.id))) throw new Error('仍有未解决的重要问题，必须逐条提交本次验证证据')
      if (task.execution?.status === 'DONE_WITH_CONCERNS') requireText(args.concernsResolution, '主控对执行疑点的处理说明', 2000)
      if (!task.checks.every(check => check.result?.passed && check.result.attempt === task.attempts)) throw new Error('主控验证尚未全部通过，不能验收')
      if (!Array.isArray(args.findings) || args.findings.length !== task.criteria.length) throw new Error('必须逐条提交验收标准的结论和证据')
      const seen = new Set()
      for (const finding of args.findings) {
        if (!Number.isInteger(finding.criterion) || !task.criteria[finding.criterion] || seen.has(finding.criterion)) throw new Error('验收标准编号缺失或重复；请直接使用 criterionId：' + criteriaOf(task).map(item => item.id).join('、'))
        seen.add(finding.criterion)
        requireText(finding.finding, '验收结论', 1000)
        if (!Array.isArray(finding.evidence) || !finding.evidence.length || !finding.evidence.every(id => task.evidence.some(item => item.callId === id && item.passed && item.attempt === task.attempts))) throw new Error('验收证据必须引用本次主控验证实际返回的 callId 或 ref，不能附带说明；当前可用：' + evidenceChoices(task))
      }
      const closeIssues = () => { if (task.audit) return; for (const resolution of resolutions) {
        const issue = task.issues.find(item => item.id === resolution.id)
        issue.status = 'addressed'; issue.resolutionEvidence = clone(resolution.evidence); issue.reviewedAttempt = task.attempts
      } }
      const acceptedReview = { findings: clone(args.findings), ...(args.concernsResolution ? { concernsResolution: args.concernsResolution } : {}), at: Date.now() }
      if (plan.protocolVersion >= 2) {
        if (typeof exec.concludeTurn !== 'function') throw new Error('DSH 未提供 concludeTurn，不能保证验收后自动结束')
        invalidateCompletion(plan)
        task.pendingAcceptance = acceptedReview
        try { await save() }
        catch (error) { if (task.pendingAcceptance === acceptedReview) delete task.pendingAcceptance; throw error }
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
            if (presentation) plan.deliveryOptions = presentation
            remember(plan, 'task.accepted', '主 Agent 已逐条验收通过', task, { findings: task.review.findings })
            if (planStatus(plan) === 'accepted') {
              remember(plan, 'plan.completed', '所有子任务已验收，计划完成')
              if (completion && !plan.completion) {
                plan.completion = completion
                remember(plan, 'plan.receipt', completionText(completion), undefined, { completion })
              } else finishPlan(plan)
            }
            if (plan.completion?.outcome === 'completed' && !plan.delivery) {
              plan.delivery = await buildDelivery(plan, plan.completion)
              plan.delivery.callId = exec.callId
              const events = parent.session.snapshotEvents?.() ?? []
              const anchor = events.findLast(event => event.type === 'assistant/message' &&
                event.data?.message?.content?.some(block => block.type === 'tool-call' && block.id === exec.callId))
                ?? events.findLast(event => event.type === 'assistant/message')
              plan.delivery.turn = anchor?.data?.turn ?? null
              plan.delivery.anchorSeq = deliveryAnchor(parent.session, plan.delivery.turn)
            }
            try { await save() } catch (error) { task.status = 'review'; task.review = null; plan.completion = null; delete plan.delivery; throw error }
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
      if (target.execution || task.pendingAcceptance || verifyingTasks.has(task) || task.checks.some(check => check.verifying)) throw new Error('报告或验证正在确认；请等待结果，核对补充要求后再决定返工')
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
      requestTaskStop(plan, task, reason)
      const releaseError = await cleanupStoppedTask(plan, task, parent)
      updateCancellationCleanup(plan)
      remember(plan, 'task.stopped', '主 Agent 已取消子任务：' + reason, task, { stop: task.stop })
      if (!cancellingPlans.has(plan)) finishPlan(plan)
      if (releaseError) { await save(); throw releaseError }
    } else if (args.action === 'retry') {
      if (task.recovered || task.audit?.recovered) throw new Error('请先 stop 旧子任务，再 retry')
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
      output: { schema: { type: 'object', additionalProperties: true }, render: (args, value) => [{ type: 'text', text: value.completion
        ? [completionText(value.completion), value.continuation, ...(value.nextAction?.type !== 'finished' ? [JSON.stringify({ context: value.context && compactContext(value.context), nextAction: value.nextAction })] : [])].filter(Boolean).join('\n')
        : JSON.stringify(args.detail === 'full' ? { ...value, ...(value.context ? { context: compactContext(value.context) } : {}) } : compactResult(value)) }] },
      async execute(args, exec) {
        try {
          await ready; if (committing.size) await Promise.all(committing); if (!child) own(exec)
          const value = await execute(args, exec), plan = plans.get(exec.agent?.id)
          if (child || !value || typeof value !== 'object') return value
          const action = nextAction(plan, exec.agent.id, value.completion ?? plan?.completion)
          if (value.completion && action.type === 'finished') action.message = completionText(value.completion)
          return { ...value, context: messageContext(exec.agent.id), nextAction: action }
        }
        catch (error) { recordCoordinationFailure(exec, messageOf(error)); throw error }
        finally { refreshCoordinationTools(exec.agent) }
      } }
    toolDefinitions.set(name, definition)
    disposers.push(ctx.tools.register(definition))
  }
  routeTool('delegation_models', '查询 Agentrix 托管模型，使用与派发相同的授权和模型解析检查。默认检查后续执行者配置；role=reviewer 查看审查模型。taskId 读取该任务已启动时的快照，配置改变不覆盖运行任务。与原生 list_subagent_models 范围不同；检查通过不等于服务商已成功响应。', {
    taskId: string, role: { type: 'string', enum: ['worker', 'reviewer'] },
  }, [], async (args, exec) => {
    const parent = own(exec), role = args.role ?? 'worker'
    if (!['worker', 'reviewer'].includes(role)) throw new Error('role 只能是 worker 或 reviewer')
    const owner = args.taskId ? taskOf(ownPlan(exec).plan, args.taskId) : null
    const target = role === 'reviewer' ? owner?.audit ?? { role, dispatcherModel: owner?.dispatcherModel } : owner ?? { role }
    if (owner && target.attempts > 0 && target.modelRoute) return { role, source: 'launch-snapshot', passed: target.modelRoute.authorization ? Boolean(target.modelRoute.resolved && !target.modelRoute.rejected && target.modelRoute.authorization.status === 'allowed') : null,
      requested: clone(target.modelRoute.requested), resolved: clone(target.modelRoute.resolved), actual: clone(target.modelRoute.actual),
      authorization: clone(target.modelRoute.authorization ?? { status: 'unknown', source: 'historical', message: '历史任务没有记录授权检查，未补造结果' }),
      validation: target.modelRoute.actual ? 'observed' : target.modelRoute.resolved ? 'resolved' : 'blocked', issue: clone(target.issue ?? null) }
    let selected, source, authorization
    try {
      ({ selected, source } = modelSelection(target, parent))
      authorization = modelAuthorization(parent, selected)
      const result = await resolveManagedRoute(parent, selected, role, exec.signal)
      return { role, source, passed: true, requested: selected, resolved: result.resolved, authorization: result.authorization, actual: null, validation: 'resolved' }
    } catch (error) {
      return { role, source, passed: false, requested: selected ?? null, resolved: null, authorization: error.authorization ?? authorization ?? null, actual: null, validation: 'blocked',
        issue: error.issue ?? { code: 'MODEL_ROUTE_CHECK_FAILED', source: 'model-resolution', message: messageOf(error) } }
    }
  })
  routeTool('delegation_decide', '主控确认消息关联：new 新需求、continue 继续、update 调整、question 提问。新需求/方案变化给出 direct/delegate 和理由；继续沿用原决定。恢复原托管计划时如旧判断为 direct，可在 continue 中提供 mode:delegate 和具体 reason 修正，无需 update 或重建任务卡。多条真实消息须逐条用 messageId 关联，全部处理后才自动接续。', {
    relation: { type: 'string', enum: ['new', 'continue', 'update', 'question'] }, messageId: string,
    mode: { type: 'string', enum: ['direct', 'delegate'] }, reason: { type: 'string', description: '新需求或方案变化时说明已有上下文、委派收益与准备、汇报、验收开销的取舍，不能只复述角色分工；最多 500 字。继续和进度询问沿用原判断。' },
  }, [], recordDecision)
  routeTool('delegation_checkpoint', '长调查、阶段转换或阻塞时记录结论、下一步和本次成功工具证据。需主控判断是否继续、纠偏或收尾时用 requestReview:true，同一阶段只通知一次。短任务直接交报告；阶段结论待核实，不能代替验收。', {
    phase: { type: 'string', enum: ['investigation', 'implementation', 'verification'] }, summary: string, nextStep: string, evidence: array(string),
    requestReview: { type: 'boolean', description: '可选；true 请求原主控核对本阶段的成果与剩余问题，不停止子代理、不代表验收。' },
  }, ['phase', 'summary', 'nextStep', 'evidence'], async (args, exec) => {
    const expected = expectedRoutes.get(exec.agent?.id)
    if (!expected) throw new Error('只有当前托管子代理可以提交阶段记录')
    const { plan, task, handle } = expected
    if (handle.controller.signal.aborted || task.execution || !LIVE.includes(task.status)) throw new Error('任务已结束或正在提交最终报告')
    if (!['investigation', 'implementation', 'verification'].includes(args.phase)) throw new Error('阶段无效')
    if (args.requestReview !== undefined && typeof args.requestReview !== 'boolean') throw new Error('requestReview 必须为布尔值')
    const summary = requireText(args.summary, '阶段结论', 2000), nextStep = requireText(args.nextStep, '下一步', 1000)
    const evidence = strings(args.evidence, '阶段证据')
    if (evidence.length > 8 || evidence.some(id => {
      const item = Object.hasOwn(task.supervision.evidenceIndex ?? {}, id) ? task.supervision.evidenceIndex[id]
        : task.supervision.evidence.find(item => item.callId === id)
      return !item || item.failed
    })) throw new Error('阶段证据必须来自当前子任务本次执行成功返回的工具')
    task.supervision.checkpoint = { phase: args.phase, summary, nextStep, evidence, at: Date.now(), verified: false }
    task.supervision.lastProgressAt = task.supervision.checkpoint.at
    task.supervision.lastActivityAt = task.supervision.checkpoint.at
    task.supervision.activity = { kind: 'waiting_model', at: task.supervision.checkpoint.at }
    scheduleSupervision(plan, task, handle)
    remember(plan, 'task.checkpoint', summary, task, { checkpoint: clone(task.supervision.checkpoint) })
    if (args.requestReview) requestSupervision(plan, task, handle, { code: 'PROGRESS_REVIEW', advisory: true, reviewKey: args.phase,
      reason: '执行者请求核对阶段成果（尚未验收）：' + brief(summary, 300) + '；下一步：' + brief(nextStep, 200), evidence })
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
  routeTool('delegation_plan', '主控提交可验证的任务拆分。通常一并提供 decisionReason 和 start:true，保存决定、计划并直接按配置派发。同类工作合批，有独立价值才拆分；审查按风险用 reviewPolicy/reviewReason 单独说明，不按执行复杂度增加流程。省略审查方式仍沿用 complex 独立审查的旧约定；省略 start 或 false 仅保存。', {
    goal: string, relation: { type: 'string', enum: ['new', 'continue', 'update', 'question'] }, messageId: string,
    start: { type: 'boolean', description: 'true 表示建计划后立即校验模型、权限与预算并派发；省略或 false 仅建立计划。' },
    decisionReason: { type: 'string', description: '说明相对主控直接完成的委派收益与准备、汇报、验收开销，写清独立执行量、隔离或并行价值，不能只复述角色分工。非空，最多 500 字；可一并记录 relation，不填写时需在 run 前记录。' }, tasks: array({ ...object({ id: string, title: string,
      instructions: { type: 'string', description: '明确目标、已定方案与已核实事实，区分必读和按需参考资料、用户硬要求和可调整建议；不把主控偏好升级为篇幅、格式或问题数量门槛。' }, scope: string,
      outputs: array(string), writes: array(string), dependsOn: array(string), complexity: { type: 'string', enum: ['routine', 'complex'], description: '只说明执行难度，不决定是否委派或执行模型。routine：方案明确，可沿既有材料执行；complex：仍有跨资料推理或设计取舍的未决难点。' },
      complexityReason: { type: 'string', description: '说明实际未决难点或普通执行依据；篇幅长、要发布或重要不足以单独判为复杂；主控已解决的判断不重复算执行难度。' },
      reviewPolicy: { type: 'string', enum: ['coordinator', 'independent'], description: '新任务显式填写，并提供 reviewReason。coordinator：主控实际验证并验收；independent：额外独立审查。按错误后果选择，权限、数据破坏、并发等高风险用 independent；复杂度或发布要求本身不代表高风险。' },
      reviewReason: { type: 'string', description: '指定 reviewPolicy 时必填，说明风险和所选审查方式的必要性；最多 1000 字。' },
      criteria: { ...array(string), description: '只包含用户要求和必要的正确性验证；主控的实施或写作建议不自动成为硬性验收标准。' },
      checks: { ...array({ ...object({ tool: { type: 'string', enum: CHECK_TOOLS }, arguments: { type: 'object', additionalProperties: true } }), required: ['tool', 'arguments'] }),
        description: '合并可一起执行的固定检查；相关产物与要求未变化且已成功时复用结果，不重复校准同一指标。' } }),
      required: ['id', 'title', 'instructions', 'scope', 'outputs', 'writes', 'complexity', 'criteria', 'checks'] }),
  }, ['goal', 'tasks'], async (args, exec) => {
    const parent = own(exec), previous = plans.get(parent.id)
    if (args.start !== undefined && typeof args.start !== 'boolean') throw new Error('start 必须为 true 或 false')
    if (storageError) throw new Error(`任务保存或恢复异常，请先处理：${storageError}`)
    if (args.relation === 'continue' && previous && planStatus(previous) !== 'accepted' && (!previous.cancelled || previous.cancelledBy === 'host' && !previous.cancellation)) {
      if (args.decisionReason !== undefined) await recordDecision({ mode: 'delegate', reason: args.decisionReason, relation: 'continue', messageId: args.messageId }, exec)
      if (args.start && !previous.autoDispatch && decisionCurrent(parent.id) && decisionFor(parent.id)?.mode === 'delegate') return runPlan({}, exec)
      return { plan: snapshotPlan(previous) }
    }
    if (previous?.cancellation?.cleanup && previous.cancellation.cleanup.status !== 'completed') throw new Error('原计划资源清理未完成；处理原因后再次 delegation_cancel 清理，不能覆盖原计划')
    if (previous && !['accepted', 'cancelled'].includes(planStatus(previous))) throw new Error('当前计划尚未验收；请监督、返工或取消后再建新计划')
    if (pendingMessages(parent.id).length && args.decisionReason === undefined) throw new Error('建立计划前须明确消息关联；可在本次 delegation_plan 一并提供 relation/messageId/decisionReason，或先用 delegation_decide 确认')
    const validated = validatePlan(args)
    validateChecks(validated.tasks, parent, exec.toolSet)
    if (args.decisionReason !== undefined) await recordDecision({ mode: 'delegate', reason: args.decisionReason, relation: args.relation, messageId: args.messageId }, exec)
    if (!previous && plans.size >= MAX_PLANS) {
      const oldest = [...plans.values()].filter(plan => ['accepted', 'cancelled'].includes(planStatus(plan)) &&
        (!plan.cancellation?.cleanup || plan.cancellation.cleanup.status === 'completed')).sort((a, b) => a.updatedAt - b.updatedAt)[0]
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
    plans.set(parent.id, plan); await save()
    return args.start ? runPlan({}, exec) : { plan: snapshot().find(plan => plan.sessionId === parent.id) }
  })
  async function runPlan(_args, exec) {
    const { plan, parent } = ownPlan(exec)
    await interrupting.get(plan.sessionId)
    exec.signal?.throwIfAborted()
    if (getConfig().enabled && plan.decisionProtocolVersion >= 1 && (!decisionCurrent(parent.id) || decisionFor(parent.id).mode !== 'delegate')) throw new Error('启动前请用 delegation_decide 记录 delegate 和具体理由，再自动继续 delegation_run；建计划时可用 decisionReason 一并记录')
    if (plan.cancelled && plan.cancelledBy === 'host' && !plan.cancellation) {
      plan.cancelled = false; plan.cancelledBy = null
      plan.interruption = { source: 'host', at: Date.now(), reason: '沿用原计划恢复旧版本记录的宿主中断' }
      for (const task of targetsOf(plan)) if (task.status === 'cancelled' && task.stop?.source === 'host') {
        remember(plan, 'task.legacy_interruption', '用户明确继续原计划，保留旧宿主停止记录', task, { stop: clone(task.stop) })
        task.status = 'blocked'
        if (!task.issue || task.issue.code === 'HOST_INTERRUPTED') task.interruption = { source: 'host', at: Date.now(), previousStatus: task.stop.previousStatus }
        delete task.stop
      }
    }
    if (plan.cancelled) {
      const recoverable = recoverableTasks(plan, true)
      if (!recoverable.length) throw new Error('计划已明确取消，不会自动重开。用户决定继续时，处理真实原因后用 delegation_control retry 恢复原任务；无需新建需求或会话')
      queuePlanRecovery(plan, recoverable, '上一轮计划被无原因取消；沿用原任务继续，先核对已有产物和失败原因，再完成本次任务。')
      await save()
    }
    if (plan.interruption && !plan.interruption.resumedAt || targetsOf(plan).some(task => task.interruption)) await resumeInterrupted(plan, parent, exec.signal)
    if (targetsOf(plan).some(task => task.recovered)) throw new Error('请先用 delegation_control stop 清理恢复前的子任务，再继续执行')
    if (activationBudget(plan, getConfig().maxActivations).remaining <= 0 && plan.tasks.some(task => task.status === 'queued')) {
      const message = pauseAtActivationLimit(plan); await save(); throw new Error(message)
    }
    await preflight(plan, parent, exec.signal)
    plan.wakeSuppressed = false
    plan.autoDispatch = true; remember(plan, 'plan.started', '开始按依赖与并发限制执行计划')
    await save(); const failure = await pump(); if (failure) throw failure
    return { plan: snapshot().find(item => item.sessionId === plan.sessionId) }
  }
  routeTool('delegation_run', '启动已经建立但未启动的计划，或在明确处理问题后继续原计划。新委派优先用 delegation_plan 的 start:true 一次完成。按依赖和全局并发限制派单；dispatchWait 时等通知，不反复调用。失败不自动重试，仍执行原模型、预算和恢复校验。', {}, [], runPlan)
  routeTool('delegation_status', '查询当前会话消息与计划摘要，无计划也可调用。context 返回消息摘要和真实 messageId；长消息以 messageId、detail:full 读取本会话完整原文，不能混用任务参数。旧计划回执仅作历史背景，按顶层 nextAction 继续。taskId、detail:full 读取一个任务详情；checkIndex 可分段读取验证原文，offset 从 0 开始，limit 默认 4000、最多 8000，按 nextOffset 继续。', {
    taskId: string, messageId: string, detail: { type: 'string', enum: ['summary', 'full'] }, checkIndex: { type: 'integer' }, offset: { type: 'integer' }, limit: { type: 'integer' },
  }, [], async (args, exec) => {
    const parent = own(exec), plan = plans.get(parent.id)
    if (args.detail !== undefined && !['summary', 'full'].includes(args.detail)) throw new Error('detail 只能是 summary 或 full')
    if (args.messageId) {
      if (args.taskId || args.checkIndex !== undefined || args.offset !== undefined || args.limit !== undefined) throw new Error('消息原文查询不能混用任务或验证输出参数')
      const message = decisions.get(parent.id)?.messages?.find(message => message.messageId === args.messageId && !message.withdrawn)
      if (!message) throw new Error('消息编号不存在于当前会话，不能读取其他会话消息')
      return { message: args.detail === 'full' ? clone(message) : compactMessage(clone(message)) }
    }
    if (args.detail === 'full' && !args.taskId) throw new Error('完整详情必须指定 taskId 或 messageId，只读取一个任务或消息')
    if (!plan) {
      if (args.taskId || args.checkIndex !== undefined) throw new Error('请先调用 delegation_plan 创建任务计划，消息关联可直接查看 delegation_status({})')
      if (args.offset !== undefined || args.limit !== undefined) throw new Error('offset 和 limit 必须与 checkIndex 一起使用')
      return { plan: null, storageError }
    }
    if (args.checkIndex !== undefined) {
      if (!args.taskId || args.detail !== 'full') throw new Error('读取验证输出必须指定 taskId 和 detail:full')
      const task = taskOf(plan, args.taskId), check = task.checks[args.checkIndex]
      if (!Number.isInteger(args.checkIndex) || !check?.result) throw new Error('checkIndex 无效或该检查尚未返回验证结果')
      const offset = args.offset ?? 0, limit = args.limit ?? 4000
      if (!Number.isInteger(offset) || offset < 0) throw new Error('offset 必须为从 0 开始的字符位置')
      if (!Number.isInteger(limit) || limit < 1 || limit > 8000) throw new Error('limit 必须为 1~8000 的整数')
      const output = await records.readVerification(plan, task, check.result)
      if (offset > output.length) throw new Error('offset 超过验证输出长度')
      const content = output.slice(offset, offset + limit), end = offset + content.length
      return { taskId: task.id, checkIndex: args.checkIndex, ref: check.result.ref, callId: check.result.callId,
        available: check.result.outputPath || check.result.truncated === false ? 'full' : 'summary',
        content, offset, nextOffset: end < output.length ? end : null, totalCharacters: output.length, outputPath: check.result.outputPath }
    }
    if (args.offset !== undefined || args.limit !== undefined) throw new Error('offset 和 limit 必须与 checkIndex 一起使用')
    if (args.taskId) {
      const task = clone(taskOf(plan, args.taskId))
      for (const target of task.audit ? [task, task.audit] : [task]) if (target.supervision) delete target.supervision.evidenceIndex
      return { status: planStatus(plan), task, coordinationIssue: clone(plan.coordinationIssue ?? null), storageError }
    }
    return { plan: snapshot().find(item => item.sessionId === plan.sessionId), storageError }
  })
  routeTool('delegation_wait', '无其他可验证任务时等待现有子代理的报告或故障事件，不调用模型轮询。第一项结果或用户新消息到达即返回；原代理继续工作，不消耗纠偏次数。用户取消优先。', {}, [], async (_args, exec) => {
    const { plan, parent } = ownPlan(exec)
    const notifications = await waitForResults(plan, parent, exec.signal)
    exec.signal?.throwIfAborted()
    deliverSupervision(plan, parent)
    return { plan: snapshotPlan(plan), notifications }
  })
  routeTool('delegation_verify', '主控验证已返回任务。默认顺序执行该任务全部检查，一次返回逐项结果、证据 ref 和标准 C1、C2；指定 checkIndex（从 0 开始）只重验该项。验证后仍须由主控判断内容并逐条验收，不消耗动手预算。', { taskId: string, checkIndex: { type: 'integer', description: '省略时执行全部检查；指定时仅执行该步骤，从 0 开始。' } }, ['taskId'], verify)
  routeTool('delegation_audit', '对已返回任务安排一个独立只读审查。reviewPolicy 为 independent 时自动安排，coordinator 由主控验证验收；未填写时兼容 complex 自动审查。重复请求不重复开启；失败重试须说明已处理的原因，受启动预算与次数限制。', {
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
    await resolveManagedRoute(parent, selected, 'reviewer', exec.signal)
    if (closed || plan.cancelled || task.status !== 'review' || task.attempts !== originalAttempt) throw new Error('模型检查期间任务状态已改变，审查未启动')
    if (task.audit !== originalAudit || task.audit?.status !== originalStatus) return { audit: clone(task.audit) }
    if (!task.audit || task.audit.forAttempt !== task.attempts) queueAudit(task)
    task.audit.status = 'queued'; task.audit.error = null; task.audit.issue = null
    plan.autoDispatch = true
    remember(plan, 'task.audit_requested', '主控请求独立审查' + (args.message ? '：' + args.message : ''), task)
    await save(); const failure = await pump(); if (failure) throw failure
    return { audit: clone(task.audit) }
  })
  routeTool('delegation_review', '主控逐条评审。findings 填验证给出的 criterionId、finding 和 evidence ref。accept 需要验证与独立审查通过；最后验收生成回执，向聊天交付结果后结束。delivery.summary 填简短说明；用户要求直接看正文时，用 delivery.inlineFiles 指定本计划 outputs 中的文件，由程序展示已验收内容。rework 须给具体问题及证据。', {
    taskId: string, verdict: { type: 'string', enum: ['accept', 'rework'] }, feedback: string, concernsResolution: string, issueIds: array(string),
    inputIds: array(string), additionalCriteria: array(string),
    delivery: object({ summary: { type: 'string', description: '面向用户的简短交付说明，最多 2000 字。' },
      inlineFiles: array({ type: 'string', description: '用户要求直接阅读的正文文件，只能引用本计划 outputs。' }) }),
    issues: array({ ...object({ criterion: { type: 'integer', description: '旧格式，从 0 开始；优先使用 criterionId。' }, criterionId: { type: 'string', description: '验证结果提供的标准编号，例如 C1。' }, severity: { type: 'string', enum: ['critical', 'important', 'minor'] }, finding: string, evidence: array(string) }), required: ['severity', 'finding', 'evidence'] }),
    resolutions: { ...array({ ...object({ id: string, status: { type: 'string', enum: ['ADDRESSED'] }, evidence: array(string) }), required: ['id', 'status', 'evidence'] }),
      description: '无独立审查时，引用本次验证证据确认原问题。独立审查通过后通常省略；重复提供仅能确认本次独审已明确 ADDRESSED 的同一问题，不覆盖审查证据。' },
    findings: array({ ...object({ criterion: { type: 'integer', description: '旧格式，从 0 开始；优先使用 criterionId。' }, criterionId: { type: 'string', description: '直接复制 C1、C2 等标准编号，不能自行重新编号。' }, finding: { type: 'string', description: '主控根据实际验证给出的逐条结论；程序不会代填通过。' }, evidence: array({ type: 'string', description: '直接复制本任务本次 delegation_verify 返回的 ref，不添加前缀、文件说明或引号。' }) }), required: ['finding', 'evidence'] }),
  }, ['taskId', 'verdict'], review)
  routeTool('delegation_control', 'steer 同步给原代理；用户补充须关联 inputIds 并提供 additionalCriteria。纯答复用 acknowledge(inputIds,message)，无需 taskId。stop 仅取消；retry 须处理真实原因。', {
    taskId: string, action: { type: 'string', enum: ['steer', 'stop', 'retry', 'acknowledge'] }, message: string, reason: string,
    inputIds: array(string), additionalCriteria: array(string),
  }, ['action'], control)
  routeTool('delegation_cancel', '用户明确取消整计划时提供 reason 和本会话新增真实用户消息的 messageId；自己推测模型不可用不能代替用户取消。已取消计划资源清理未完成时，可空参数重试清理，保留原取消来源，不启动新代理。单任务失败只处理该任务；中断后用 delegation_run 继续原计划。', { reason: string, messageId: string }, [], async (args, exec) => {
    const { plan, parent } = ownPlan(exec)
    if (planStatus(plan) === 'accepted') return { status: 'accepted', completion: plan.completion ?? null }
    if (cancellingPlans.has(plan)) return cancellingPlans.get(plan)
    if (plan.cancelled && (!plan.cancellation || plan.cancellation.cleanup?.status === 'completed')) {
      await save(); return { status: 'cancelled', completion: plan.completion ?? null }
    }
    const serviceIssue = pendingServiceIssue(plan)
    const hasLive = targetsOf(plan).some(task => LIVE.includes(task.status))
    const retryCleanup = plan.cancelled && plan.cancellation
    if (!args.reason && !retryCleanup) {
      const message = serviceIssue ? serviceIssue.message + '。' + serviceIssue.action
        : '计划未取消。整计划取消须关联真实用户消息；已有任务继续，失败项处理原因后明确 retry，中断用 delegation_run 恢复原计划。'
      remember(plan, 'plan.cancellation_rejected', message)
      const completion = plan.completion ?? (!hasLive && targetsOf(plan).some(task => ['failed', 'blocked'].includes(task.status)) ? finishPlan(plan, message) : null)
      await save()
      return { status: serviceIssue ? 'blocked' : planStatus(plan), ...(serviceIssue ? { issue: clone(serviceIssue) } : {}), message, completion }
    }
    if (!retryCleanup) {
      const reason = requireText(args.reason, '取消原因', 2000)
      const messages = (decisions.get(parent.id)?.messages ?? []).filter(message => !message.withdrawn)
      const message = messages.at(-1)
      if (!args.messageId || message?.messageId !== args.messageId || message.messageId === plan.source?.messageId ||
        message.at < plan.createdAt || message.cancellation) throw new Error('整计划取消必须关联本会话新增的真实用户消息 messageId；主控推测故障或自行填写 reason 不能代替用户取消。单任务失败只处理该任务，中断后用 delegation_run 沿用原计划继续')
      plan.cancellation = { source: 'user-message', messageId: message.messageId, text: message.text, reason, at: Date.now() }
      message.cancellation = clone(plan.cancellation)
    }
    const reason = plan.cancellation.reason
    invalidateCompletion(plan)
    plan.cancelled = true; plan.cancelledBy = 'explicit'; plan.autoDispatch = false; plan.wakeSuppressed = true
    // Abort all activations before awaiting cleanup or storage; one failure cannot skip a sibling.
    for (const task of plan.tasks) requestTaskStop(plan, task, reason)
    updateCancellationCleanup(plan)
    const operation = Promise.resolve().then(async () => {
      let saveError
      try { await save() } catch (error) { saveError = error }
      await Promise.all(plan.tasks.filter(task => task.status !== 'accepted').map(task => cleanupStoppedTask(plan, task, parent)))
      updateCancellationCleanup(plan)
      remember(plan, 'plan.cancelled', '用户取消已记录：' + reason, undefined, { cancellation: clone(plan.cancellation) })
      finishPlan(plan)
      try { await save(); saveError = null } catch (error) { saveError = error }
      if (saveError) throw saveError
      return { status: 'cancelled', completion: plan.completion ?? null }
    }).finally(() => cancellingPlans.delete(plan))
    cancellingPlans.set(plan, operation)
    return operation
  })
  return {
    ready, snapshot, observe, allowsVerification, decisionFor, decisionCurrent, decisionGuidance, recoverDecision, sourceOf, revisionOf,
    refreshCoordinationTools, guardCoordination, coordinatorWriteBlock, recordCoordinationFailure, modelRoutingState,
    isToolHiddenByPolicy(sessionId, name) {
      return ['delegation_verify', 'delegation_review'].includes(name) && Boolean(coordinationRestrictions.get(sessionId)?.names.includes(name))
    },
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
      if (exec.name === 'list_subagent_models') return '[DSH Agentrix] 执行者沿用已校验的启动模型，不用原生模型查询重新判断或切换；模型问题通过 delegation_report 报告主控。'
      if (task.protocolVersion >= 2 && exec.name === 'send_message') return '[DSH Agentrix] 托管任务必须通过 delegation_report 提交正式报告；普通消息不能代替报告。'
      if (COORDINATOR_TOOLS.has(exec.name)) return '[DSH Agentrix] 此入口仅供主控。子代理读取使用 read/grep/glob，阶段进度使用 delegation_checkpoint，最终结果使用 delegation_report。'
      if (['subagent', 'subagent_fork', 'spawn_teammate', ...(getConfig().delegationTools ?? [])].includes(exec.name)) return '[DSH Agentrix] 执行者和审查者不能继续委派。'
      if (expected.task.role === 'reviewer' && !REVIEW_TOOLS.has(exec.name)) return '[DSH Agentrix] 独立审查只允许只读检索、阶段记录和最终报告；命令与实际验证由主控执行。'
      if (task.supervision) { task.supervision.lastActivityAt = Date.now(); task.supervision.activity = { kind: 'tool', tool: exec.name, at: Date.now() }; backgroundSave() }
    },
    async history(before) { await ready; if (writing) await writing; return records.history(before) },
    async readDelivery(sessionId, seq) {
      await ready; if (writing) await writing
      const delivery = plans.get(sessionId)?.delivery
      if (typeof sessionId === 'string' && Number.isSafeInteger(seq) && seq >= 0 && delivery?.anchorSeq === seq) return clone(delivery)
      return records.readDelivery(sessionId, seq)
    },
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
      const coordination = plan.coordinationIssue && !plan.coordinationIssue.resolvedAt
        ? `协作操作未成功：${plan.coordinationIssue.tool}；${plan.coordinationIssue.message}\n下一步：${plan.coordinationIssue.nextAction}` : ''
      const interruption = plan.interruption && !plan.interruption.resumedAt
        ? '执行已中断，原任务和证据保留；用户明确继续后用 delegation_run 恢复，不必新建计划。已返回报告继续验证验收，服务错误仍需单独处理后重试。' : ''
      return [`当前计划：${brief(plan.goal, 200)}\n状态：${planStatus(plan)}；${plan.tasks.map(task => `${task.id}=${task.status}${task.audit ? '（独立审查=' + task.audit.status + '）' : ''}`).join('，')}。启动预算：${budget.used}/${budget.limit}，剩余 ${budget.remaining}（含独立审查）。调用 delegation_status 获取证据并继续监督；最终交付结论以程序回执为准，最后一次验收后自动结束，不用 stop 清理。`, plan.completion ? completionText(plan.completion) : '尚未完成。报告由原执行者提交，主控等待通知后验证验收；团队看板和 list_agents 不是托管任务的完成依据。', coordination, issue ? issue.message + '。' + issue.action : '', pending, waiting, paused,
        interruption, association, failures.length ? `失败原因：\n${failures.join('\n')}` : ''].filter(Boolean).join('\n')
    },
    hasPending: sessionId => { const plan = pendingPlan(sessionId); return Boolean(plan && isCurrentPlan(plan)) },
    async dispose() {
      if (closed) return
      closed = true
      for (const waiter of waitingParents.values()) waiter.wake.resolve()
      truncatedOutputs.clear()
      clearTimeout(activityTimer)
      for (const timer of notificationTimers.values()) clearTimeout(timer)
      notificationTimers.clear()
      // Do not let an old notification writer outlive disposal and overwrite a resumed state.
      await Promise.allSettled([...notificationOperations])
      for (const plan of plans.values()) {
        plan.autoDispatch = false
        for (const task of targetsOf(plan)) if (LIVE.includes(task.status)) {
          task.interruption = { source: 'reload', at: Date.now(), previousStatus: task.status }
          plan.interruption ??= { source: 'reload', at: Date.now(), reason: '插件停止，执行已中断；明确继续后清理旧执行并沿用原任务恢复。' }
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
      for (const restriction of coordinationRestrictions.values()) restriction.dispose()
      coordinationRestrictions.clear()
      for (const schema of reportSchemas.values()) schema.dispose()
      reportSchemas.clear()
      live.clear(); expectedRoutes.clear(); permits.clear(); waitingParents.clear(); inboxes.clear(); if (!recoveryFailed) await save()
    },
  }
}
