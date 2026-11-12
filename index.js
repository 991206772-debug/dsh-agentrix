/** Host policy, native task orchestration, and the panel's HTTP API. */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createOrchestrator, OPTION_RANGES, orchestrationOptions, REVIEWER_MODEL_POLICY, COORDINATION_POLICY_VERSION, validateModelRoute } from './orchestrator.js'

export const inject = ['tools']

const ROUTE_PREFIX = '/dsh-delegation-first'
/**
 * Base of the plugin routes.
 *
 * The config path is composed from this base rather than spelled out twice, so
 * a route rename touches one constant. The two handlers below still name their
 * full path in prose, which is the only place it is written out.
 */
const API_BASE = `${ROUTE_PREFIX}/api`

/** What the panel owns. Everything else in the config stays derived. */
const CONFIG_VERSION = 3
const CONFIG_MODES = ['auto', 'strict', 'off', 'fixed']
const DEFAULT_THRESHOLD = 2
const MIN_THRESHOLD = 0
const MAX_THRESHOLD = 20
/** A config body is three short fields; anything larger is not ours. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * The short discipline, injected into a **coordinator's** prompt every turn.
 *
 * Short on purpose: it is re-sent on every step, so each line must earn its
 * tokens by changing a decision. The long-form manual lives in the
 * `delegation-first` skill and is loaded only when the task calls for it.
 */
const DISCIPLINE = [
  "## Agentrix",
  "auto比较委派收益与准备、汇报、验收开销；小改/共享上下文优先direct，有独立执行量、隔离或并行价值才delegate；普通也可委派。",
  "先读；direct用delegation_decide，委派用delegation_plan({start:true,...})；要求分必需/建议，说明取舍，合批。",
  "委派后主控规划验收、worker执行。complexity看未决难点；显式填reviewPolicy/reviewReason按风险审查。审查用分发者模型，delegation_models查模型。",
  "delegation_verify后delegation_review按criterionId/ref验收。标准限用户要求及必要验证；重要问题返工，minor记录，复查不扩围。",
  "relation:new/continue/update/question。补充先答复；变更用inputIds/additionalCriteria steer原代理，答复acknowledge。报进度，修改失败须修复并核对原产物。",
  "有进展不停、不换代理；按nextAction用delegation_wait等通知。交report，长调查/阻塞记checkpoint。",
  "stop取消须原因。验收delivery填summary/inlineFiles，正文限outputs；交付后结束。",
].join('\n')

/** Automatic routing is advisory; explicit modes retain their operation gates. */
function policyFor(config) {
  if (config.mode === 'strict') return { requireFirst: true, budget: 0 }
  if (config.mode === 'fixed') return { requireFirst: false, budget: config.threshold }
  return { requireFirst: false, budget: null }
}

/** Hands-on work: things a coordinator should have handed to someone else. */
const GATED_TOOLS = [
  'write',
  'edit',
  'apply_patch',
  'multi_edit',
  'notebook_edit',
  'pwsh',
  'bash',
]

/** A call of one of these means work left this context. */
const DELEGATION_TOOLS = ['spawn_teammate', 'subagent', 'subagent_fork']
const MANAGED_ENTRY_POINTS = ['delegation_decide', 'delegation_plan', 'delegation_run', 'delegation_status', 'delegation_verify', 'delegation_review']
const CHANGE_TOOLS = ['write', 'edit', 'apply_patch', 'multi_edit', 'notebook_edit']

/**
 * Tunables.
 *
 * `DSH_DELEGATION_FIRST`:
 *   unset / `auto` → judge the turn and follow the judgement (the default)
 *   `off`          → the gate is inert
 *   `strict`       → no hands-on execution at all in a turn that has not
 *                    delegated (the pre-difficulty behaviour)
 *   `<n>`          → a fixed per-turn budget of n, no delegation required first
 *
 * A JSON `Config` would be the harness-idiomatic home for these, but the profile
 * does not resolve `@deepseek-ai/schemastery`, and a plugin that fails to import
 * is worse than one configured by environment.
 */
function readConfig() {
  const config = {
    enabled: true,
    mode: 'auto',
    threshold: 2,
    requireDelegateFirst: false,
    gatedTools: GATED_TOOLS,
    delegationTools: DELEGATION_TOOLS,
    ...orchestrationOptions(),
  }
  const raw = String(process.env.DSH_DELEGATION_FIRST ?? '').trim().toLowerCase()
  if (!raw) return config
  if (raw === 'auto') return config
  if (raw === 'off' || raw === 'false' || raw === '0') {
    return { ...config, enabled: false, mode: 'off' }
  }
  if (raw === 'strict') return { ...config, mode: 'strict', threshold: 0, requireDelegateFirst: true }
  const budget = Number(raw)
  if (Number.isFinite(budget) && budget >= 0) {
    return { ...config, mode: 'fixed', threshold: budget, requireDelegateFirst: false }
  }
  return config
}

// ---------------------------------------------------------------------------
// Persisted configuration
//
// `DSH_DELEGATION_FIRST` is the operator's channel — a launcher, a service
// definition, CI — and the JSON file is the person's channel, i.e. the panel.
// When the environment variable is set it wins and the file becomes read-only,
// so an operator who pinned the gate cannot be unpinned by a click.
// ---------------------------------------------------------------------------

/** The Harness home that owns profiles and their plugin data. */
function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  if (process.env.DSH_PROFILE_DIR) return path.resolve(process.env.DSH_PROFILE_DIR, '..', '..')
  return path.join(os.homedir(), '.dsh')
}

/** One config file per profile, so two profiles never fight over one setting. */
function configFile() {
  const profile = String(process.env.DSH_PROFILE || 'default').replace(/[^\w.-]+/g, '_')
  return path.join(dshHome(), 'delegation-first', `${profile}.json`)
}

/**
 * Whether the environment pinned the configuration.
 *
 * Any non-empty value counts, including one `readConfig()` cannot parse: the
 * value's meaning is `readConfig()`'s problem, while "an operator set it" is
 * already enough for the panel to be read-only.
 */
function envPinned() {
  return String(process.env.DSH_DELEGATION_FIRST ?? '').trim().length > 0
}

/** A budget is a whole number of direct calls per turn, 0..20. */
function normalizeThreshold(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  const number = Number(value)
  if (!Number.isInteger(number)) return undefined
  if (number < MIN_THRESHOLD || number > MAX_THRESHOLD) return undefined
  return number
}

/** Whatever the file happens to hold, reduced to what this plugin understands. */
function sanitizeStored(input) {
  const stored = { mode: 'auto', threshold: DEFAULT_THRESHOLD, ...orchestrationOptions(input) }
  if (!input || typeof input !== 'object') return stored
  if (CONFIG_MODES.includes(input.mode)) stored.mode = input.mode
  const threshold = normalizeThreshold(input.threshold)
  if (threshold !== undefined) stored.threshold = threshold
  return stored
}

/**
 * The persisted setting, or the defaults when it cannot be read.
 *
 * Never throws: a missing, empty or corrupt file must leave the gate working,
 * so every failure path lands on the same values `readConfig()` defaults to.
 */
async function loadStored(file) {
  try {
    return sanitizeStored(JSON.parse(await readFile(file, 'utf8')))
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn('[dsh-delegation-first] 配置文件读取失败，回退默认值：%s（%s）', file, error?.message ?? error)
    }
    return sanitizeStored(undefined)
  }
}

/**
 * Write the setting atomically: a temporary file plus a rename.
 *
 * A reader — a second Harness starting at the same moment, or this one right
 * after the save — sees either the old complete file or the new complete file,
 * never a half-written one. A failed write leaves the old setting in place.
 */
async function persistStored(file, stored) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  const body = { version: CONFIG_VERSION, ...stored }
  await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

/**
 * The persisted setting laid over the base configuration.
 *
 * The base is what the environment produced (`readConfig()`); the file only
 * replaces the two fields the panel owns. `enabled` and `requireDelegateFirst`
 * are derived here so the gate keeps reading one config shape.
 */
function applyStored(base, stored) {
  const mode = CONFIG_MODES.includes(stored.mode) ? stored.mode : 'auto'
  const threshold = normalizeThreshold(stored.threshold)
  return {
    ...base,
    mode,
    threshold: threshold === undefined ? base.threshold : threshold,
    enabled: mode !== 'off',
    requireDelegateFirst: mode === 'strict',
    ...orchestrationOptions(stored),
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * The refusal the model reads instead of the tool result.
 *
 * The budget quoted is the one this turn's judgement produced, not the raw
 * config value: after a `medium` turn the model must not read "2 more calls"
 * when it actually has one.
 */
function denialMessage(tool, state, config, kind, policy) {
  const budget = Number.isFinite(policy?.budget) ? policy.budget : config.threshold
  const head =
    kind === 'delegate-first'
      ? `已阻止业务操作 \`${tool}\`：当前工作需要先建立任务卡并委派。`
      : `已阻止业务操作 \`${tool}\`：本轮业务操作已执行 ${state.direct} 次，上限 ${budget} 次。`
  return [
    `[DSH Agentrix] ${head}`,
    state.route ? routingLine(state.route) : '',
    '',
    '请调用 delegation_plan，提供验收标准、decisionReason 和 start:true，一次建立并派发任务。',
    '查看进度用 delegation_status，纠偏/停止用 delegation_control。',
    '',
    '派单前把任务卡写全（缺一项对方就会跑偏）：',
    '  目标（一句话可验证）/ 输出格式（具体路径+结构）/ 边界（不许改什么）/',
    '  验收标准（3~5 条，每条都能用命令或读取核对）/ 停止条件',
    '',
    '准备工作仍可继续：read/grep/glob 读取，delegation_inspect 检查目录或 Git 状态，delegation_note 保存计划记录；验收使用 delegation_verify。未知 shell 不会被猜测为只读。',
    budget > 0
      ? `派出一单之后，本轮还可以自己动手 ${budget} 次。`
      : '本轮不留直接修改额度；主控验收命令通过 delegation_verify 执行，不占预算。',
  ].join('\n')
}

/**
 * Decide one gated call.
 *
 * Pure on purpose: the policy is the part worth testing, and it must not depend
 * on when the guard happens to run. The per-turn policy is derived from the
 * explicit user-selected mode and stored on `state`, so this
 * function stays a pure reading of `{ state, config }` — a missing policy falls
 * back to the pre-difficulty behaviour.
 *
 * @returns `{ allow: true }` to let the call through, or
 *          `{ allow: false, kind, message }` to deny it.
 */
function evaluate(name, state, config) {
  if (!config.enabled) return { allow: true }
  if (!state.isCoordinator) return { allow: true }
  if (config.delegationTools.includes(name)) return { allow: true, countsAsDelegation: true }
  if (!config.gatedTools.includes(name)) return { allow: true }
  const policy = state.policy ?? policyFor(config)
  if (policy.requireFirst && state.delegated === 0) {
    return {
      allow: false,
      kind: 'delegate-first',
      message: denialMessage(name, state, config, 'delegate-first', policy),
    }
  }
  if (Number.isFinite(policy.budget) && state.direct >= policy.budget) {
    return {
      allow: false,
      kind: 'threshold',
      message: denialMessage(name, state, config, 'threshold', policy),
    }
  }
  return { allow: true, countsAsDirect: true }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx) {
  const file = configFile()
  /** An environment value pins the file; the panel then shows it as locked. */
  const pinned = envPinned()
  const environmentValue = String(process.env.DSH_DELEGATION_FIRST ?? '').trim()
  const environmentConfig = readConfig()
  let fileMetadata = { revision: null, updatedAt: null, exists: false }
  let configWrites = Promise.resolve()

  /**
   * The live configuration.
   *
   * Deliberately not a constant: saving in the panel replaces this binding, and
   * every decision below — the guard, the per-turn policy, the routes — reads
   * it, so a save applies to the next tool call and the next turn without a
   * reload. The initial value comes from the environment (or the defaults); the
   * persisted file is laid over it as soon as that fast read resolves.
   */
  let current = readConfig()
  const configReady = loadStored(file).then((stored) => {
    // The environment pins gate mode/budget; model routes and resource limits remain persisted.
    current = pinned ? { ...current, ...orchestrationOptions(stored) } : applyStored(readConfig(), stored)
    orchestration?.refreshCoordinationTools()
    return current
  })

  const sessions = () => {
    try {
      return ctx.get('sessions')
    } catch {
      return undefined
    }
  }

  const sessionTitleOf = sessionId => {
    try {
      const session = sessions()?.get?.(sessionId)
      const title = ctx.get('sessionTitle')?.get?.(session)?.title
      return typeof title === 'string' && title.trim() ? title.trim() : null
    } catch {
      return null
    }
  }

  /** sessionId → the counters and the judgement a turn is governed by. */
  const states = new Map()
  let orchestration
  const stateOf = (sessionId) => {
    let state = states.get(sessionId)
    if (!state) {
      const restored = orchestration?.requestContext(sessionId)
      state = {
        turn: 0,
        direct: 0,
        delegated: 0,
        denied: 0,
        turnDenied: 0,
        observedSince: Date.now(),
        isCoordinator: true,
        last: null,
        // This turn's judgement. `null` until a turn starts: the prompt section
        // and the status route both treat null as "no judgement yet".
        difficulty: null,
        route: null,
        policy: null,
        source: restored?.source ?? null,
        revision: restored?.revision ?? restored?.source ?? null,
        sessionId,
        delegationPending: new Map(),
        execution: null,
        activeCalls: new Map(),
        delegationAvailability: null,
      }
      states.set(sessionId, state)
    }
    return state
  }

  orchestration = createOrchestrator({ ctx, file: file.replace(/\.json$/, '.runs.json'),
    getConfig: () => current, getSource: id => states.get(id)?.source ?? null, getRevision: id => states.get(id)?.revision ?? null,
    onRequestResolved: (id, context) => {
      const state = stateOf(id), previousId = state.source?.messageId
      state.source = context.source; state.revision = context.revision
      if (state.execution) {
        state.execution.requestId = context.source?.messageId ?? null
        if (previousId !== context.source?.messageId) { state.execution.unresolvedChanges = []; state.execution.repairUsed = 0 }
      }
    },
    onDelegated: id => { stateOf(id).delegated++ } })
  const ready = Promise.all([configReady, orchestration.ready])

  /**
   * Whether this call comes from a coordinator or from a worker.
   *
   * A worker is any session created for someone else: `origin: 'subagent'`,
   * a `parentSession`, or a non-zero delegation depth. Teammates carry the same
   * markers, which is what keeps the gate from disarming the very agents it is
   * supposed to be feeding.
   */
  const roleOf = (exec) => {
    const agentId = exec?.agent?.id ? String(exec.agent.id) : ''
    if (!agentId) return undefined
    let session
    try {
      session = sessions()?.get?.(agentId)
    } catch {
      session = undefined
    }
    if (!session) return undefined
    const header = session.header ?? {}
    const depth = Number(header.delegationDepth) || 0
    const worker = header.origin === 'subagent' || Boolean(header.parentSession) || depth > 0
    return { agentId, worker }
  }

  /**
   * Whether this agent can actually delegate.
   *
   * The lookup must be scoped to the calling agent: `spawn_teammate` and the
   * other delegation tools are registered *in the agent's own scope*, so the
   * global view does not see them and a global check would conclude "there is
   * nothing to delegate to" in exactly the deployment that has teammates. That
   * mistake would silently disarm the whole gate, so the scope is the agent
   * object the execution carries — the same key the registry uses.
   */
  const canDelegate = (exec) => {
    const native = ctx.get('subagents')
    if (native?.startActivation && (typeof native.getProvider !== 'function' || native.getProvider('spawn'))) return true
    const scope = exec?.agent
    for (const name of current.delegationTools) {
      try {
        if (ctx.tools.get(name, scope)) return true
      } catch {
        /* treat as absent */
      }
    }
    // A scope lookup that finds nothing is not proof of absence: a preset may
    // expose the tool through a name this list does not know. Fall back to the
    // global view, and never disarm the gate on a lookup failure.
    try {
      return ctx.tools.schemas(scope).some((schema) => current.delegationTools.includes(schema.name))
    } catch {
      return true
    }
  }

  const delegationAvailability = (agent, tools) => {
    if (!current.enabled) return { status: 'disabled', missingTools: [] }
    try {
      const names = new Set((tools ?? ctx.tools.schemas(agent)).map(tool => tool.name))
      const missingTools = MANAGED_ENTRY_POINTS.filter(name => !names.has(name) &&
        !(orchestration?.isToolHiddenByPolicy?.(agent?.id, name) && ctx.tools.get(name)))
      if (!ctx.tools.get('delegation_report')) missingTools.push('delegation_report')
      const nativeAvailable = canDelegate({ agent })
      return { status: missingTools.length || !nativeAvailable ? 'unavailable' : 'available', missingTools, nativeAvailable }
    } catch { return { status: 'unknown', missingTools: [] } }
  }
  const ensureExecution = state => state.execution ??= {
    running: true, startedAt: Date.now(), lastActivityAt: Date.now(), toolCalls: 0,
    activity: { kind: 'waiting_model_response' }, lastResult: null, unresolvedChanges: [], repairUsed: 0,
  }
  const toolTarget = exec => {
    const args = exec.arguments ?? {}
    return String(args.file_path ?? args.path ?? args.notebook_path ?? '').slice(0, 1000)
  }
  const changeKey = (exec, target) => {
    if (!target) return exec.name + ':' + exec.callId
    const cwd = sessions()?.get?.(exec.agent.id)?.header?.cwd ?? process.cwd()
    return path.resolve(cwd, target).replaceAll('\\', '/').toLowerCase()
  }
  const observeCoordinatorCall = (exec, state) => {
    if (!current.enabled || exec.name.startsWith('delegation_')) return
    const execution = ensureExecution(state), now = Date.now(), target = toolTarget(exec)
    state.activeCalls.set(exec.callId, { tool: exec.name, target, key: changeKey(exec, target), turn: state.turn })
    if (state.activeCalls.size > 100) state.activeCalls.delete(state.activeCalls.keys().next().value)
    execution.toolCalls++
    execution.running = true; execution.lastActivityAt = now
    execution.activity = { kind: 'tool', tool: exec.name, target, at: now }
  }

  const missingDecisionCalls = new WeakSet()
  const disposeGuard = ctx.tools.guard((exec) => {
    const coordinationBlock = orchestration.guardCoordination(exec)
    if (coordinationBlock) {
      const state = stateOf(exec.agent.id)
      state.denied++; state.turnDenied++
      state.last = { tool: exec.name, kind: 'coordination', message: coordinationBlock, at: Date.now() }
      return coordinationBlock
    }
    const childBlock = orchestration.guardChild(exec)
    if (childBlock) return childBlock
    const role = roleOf(exec)
    if (!role) return undefined
    const state = stateOf(role.agentId)
    state.isCoordinator = !role.worker
    if (!state.isCoordinator) return undefined
    const name = String(exec?.name ?? '')
    if (orchestration.allowsVerification(exec)) return undefined
    if (current.enabled && current.delegationTools.includes(name)) {
      state.denied++; state.turnDenied++
      const message = '[DSH Agentrix] 请用 delegation_plan({decisionReason,start:true,...}) 一次建卡并派发，应用角色模型、并发限制和验收流程。已有未启动计划才用 delegation_run。读取与准备工具仍可继续使用。'
      state.last = { tool: name, kind: 'managed-dispatch', message, at: Date.now() }
      return message
    }
    const managedBlock = current.enabled && current.gatedTools.includes(name) && orchestration.coordinatorWriteBlock(exec)
    if (managedBlock) {
      state.denied++; state.turnDenied++
      state.last = { tool: name, kind: 'managed-plan', message: managedBlock, at: Date.now() }
      orchestration.recordCoordinationFailure(exec, managedBlock)
      return managedBlock
    }
    const verdict = canDelegate(exec) ? evaluate(name, state, current) : { allow: true }
    if (verdict.countsAsDelegation) {
      state.delegationPending.set(exec.callId, state.turn)
      if (state.delegationPending.size > 100) state.delegationPending.delete(state.delegationPending.keys().next().value)
      return undefined
    }
    if (verdict.allow) {
      if (current.enabled && current.gatedTools.includes(name)) {
        const decision = orchestration.decisionFor(role.agentId)
        if (!orchestration.decisionCurrent(role.agentId) || decision.mode !== 'direct') {
          state.denied++; state.turnDenied++
          const missing = !orchestration.decisionCurrent(role.agentId)
          if (missing) missingDecisionCalls.add(exec)
          const message = missing
            ? `[DSH Agentrix] ${name} 未执行：请先用 delegation_decide 确认当前消息和执行方式；新委派也可用 delegation_plan({relation,decisionReason,start:true,...})。这是执行判断未补齐，不是目录或文件错误。` +
              (orchestration.sourceOf(role.agentId) ? '已有需求时由主控判断消息关系。' : '尚无已确认需求，首次用 relation:"new"。')
            : '[DSH Agentrix] 主控已决定委派。新计划用 delegation_plan({decisionReason,start:true,...})；已有计划按 nextAction 继续。范围改变才更新方式和理由。'
          state.last = { tool: name, kind: 'decision', message, at: Date.now() }
          return message
        }
      }
      observeCoordinatorCall(exec, state)
      if (verdict.countsAsDirect) state.direct += 1
      return undefined
    }
    state.denied += 1
    state.turnDenied += 1
    state.last = { tool: name, kind: verdict.kind, at: Date.now() }
    return verdict.message
  })

  const offDecisionRecovery = ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (!missingDecisionCalls.delete(exec) || !result.isError || decision.kind !== 'accept' || !current.enabled || exec.signal?.aborted) return decision
    try {
      await ready
      if (!current.enabled || exec.signal?.aborted || !await orchestration.recoverDecision(exec.agent.id) || exec.signal?.aborted) return decision
    } catch (error) {
      return { ...decision, content: [...(decision.content ?? result.content), { type: 'text',
        text: '自动纠正记录未能保存，本次操作仍未执行：' + (error instanceof Error ? error.message : String(error)) }] }
    }
    return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), {
      id: randomUUID(), role: 'user', source: { kind: 'delegation-decision-recovery' }, content: [{ type: 'text', text:
        `[DSH Agentrix] 刚才的 ${exec.name} 未执行。下一步先补需求关联和执行判断，不能把策略拦截当作路径错误继续扩大搜索范围。\n` +
        orchestration.decisionGuidance(exec.agent.id) }],
    }] }
  }, { global: true })

  const offResult = ctx.on('tools/result', (exec, result) => {
    orchestration.observe(exec, result)
    const state = states.get(String(exec.agent?.id ?? ''))
    const call = state?.activeCalls.get(exec.callId)
    state?.activeCalls.delete(exec.callId)
    if (call && call.turn === state.turn && current.enabled) {
      const execution = ensureExecution(state), now = Date.now()
      const text = (result.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
      const failed = Boolean(result.isError || Number(result.value?.exitCode ?? 0) !== 0 || /\[exit code: [1-9]\d*\]/.test(text))
      execution.lastActivityAt = now
      execution.activity = { kind: 'waiting_model', at: now }
      execution.lastResult = { tool: call.tool, target: call.target, at: now, failed }
      if (CHANGE_TOOLS.includes(exec.name)) {
        if (failed) {
          const failure = { key: call.key, tool: call.tool, target: call.target, callId: exec.callId,
            reason: (text.trim().split('\n')[0] || '文件修改工具返回错误').slice(0, 600), at: now }
          execution.unresolvedChanges = [...execution.unresolvedChanges.filter(item => item.key !== call.key), failure].slice(-16)
        } else if (call.target) execution.unresolvedChanges = execution.unresolvedChanges.filter(item => item.key !== call.key)
      }
    }
    if (!state || !state.delegationPending.has(exec.callId)) return
    const turn = state.delegationPending.get(exec.callId)
    state.delegationPending.delete(exec.callId)
    if (turn === state.turn && result.isError === false) state.delegated++
  }, { global: true })

  const offCoordinatorStream = ctx.on('llm/stream', (request, next) => {
    const agent = ctx.get('agents')?.get?.(request.sessionId), role = roleOf({ agent })
    if (!current.enabled || !role || role.worker) return next()
    const state = stateOf(role.agentId), execution = ensureExecution(state)
    execution.running = true
    execution.model = { provider: request.provider, model: request.model }
    execution.activity = { kind: 'waiting_model_response', at: Date.now() }
    const stream = next()
    if (!stream?.[Symbol.asyncIterator]) return stream
    return (async function* () {
      let received = false
      for await (const chunk of stream) {
        execution.lastActivityAt = Date.now()
        if (!received && ['block-start', 'block-delta'].includes(chunk.type)) {
          received = true; execution.activity = { kind: 'model', at: execution.lastActivityAt }
        }
        yield chunk
      }
    })()
  }, { global: true })

  const offDirectStopping = ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    await ready
    if (!current.enabled || signal?.aborted || roleOf({ agent })?.worker !== false || orchestration.hasPending(agent.id)) return
    const state = states.get(agent.id), execution = state?.execution
    if ((execution?.toolCalls > 0 || state?.last?.kind === 'decision') && typeof agent.inject === 'function' && await orchestration.recoverDecision(agent.id)) {
      agent.inject({ id: randomUUID(), role: 'user', source: { kind: 'delegation-decision-recovery' }, content: [{ type: 'text', text:
        orchestration.decisionGuidance(agent.id) }] })
      return
    }
    if (!execution?.unresolvedChanges.length || execution.repairUsed >= 1 || typeof agent.inject !== 'function') return
    execution.repairUsed++
    agent.inject({ id: randomUUID(), role: 'user', source: { kind: 'delegation-direct-recovery' }, content: [{ type: 'text', text:
      '本次文件修改仍有失败记录，不能作为已完成交付。请在原任务中核对并修复以下文件，不新开代理、不扩大范围；成功读取或生成另一份文件不能代替原修改成功。若确实无法完成，明确说明未完成项和原因。本次只自动提醒一次。\n' +
      execution.unresolvedChanges.map(item => `${item.target || item.tool}：${item.reason}`).join('\n') }] })
  }, { global: true })

  // A turn is the unit of judgement: a new turn starts with a clean slate, so a
  // delegation in turn 1 does not license hands-on work in turn 5. The same
  // handler collects the human input the judgement needs and consumes it when
  // the turn it belongs to starts.
  const offEvent = ctx.on('session/event', (session, event) => {
    const id = String(session?.id ?? '')
    if (!id) return
    const type = event?.type

    // Orchestrator records factual human messages; no lexical classification occurs here.
    if (type === 'agent/inbox/spliced') {
      const inserted = Array.isArray(event.data?.inserted) ? event.data.inserted : []
      if (inserted.length === 0) return
      const state = stateOf(id)
      state.source = orchestration.sourceOf(id); state.revision = orchestration.revisionOf(id)
      return
    }

    // Human input, source 2 of 2: the committed surface message. Arrives after
    // `turn/start` in this harness, so it mostly serves the dedupe of source 1 —
    // and it is what a deployment that injects `user/message` directly relies
    // on. Harness-injected kinds are not human input.
    if (type === 'user/message') {
      if (event.data?.source?.kind !== 'user') return
      stateOf(id)
      return
    }

    if (['request/header', 'assistant/message', 'turn/end'].includes(type)) {
      const state = states.get(id)
      if (!state) return
      if (type === 'request/header') state.delegationAvailability = delegationAvailability(ctx.get('agents')?.get?.(id), event.data?.header?.tools)
      if (type === 'turn/end' && state.execution) {
        state.execution.running = false; state.execution.endedAt = Date.now()
      }
      return
    }
    if (type !== 'turn/start') return
    const state = stateOf(id)
    state.sessionId = id
    state.turn = Number(event.data?.turn) || state.turn + 1
    state.direct = 0
    state.delegated = 0
    state.turnDenied = 0
    state.last = null
    state.delegationPending.clear()
    const previous = state.execution
    state.execution = null
    const execution = ensureExecution(state)
    execution.requestId = state.source?.messageId ?? null
    if (previous?.requestId && previous.requestId === execution.requestId) {
      execution.unresolvedChanges = previous.unresolvedChanges; execution.repairUsed = previous.repairUsed
    }
    state.activeCalls.clear()
    state.delegationAvailability = delegationAvailability(ctx.get('agents')?.get?.(id))
    state.policy = policyFor(current)
  })

  const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
    if (agent?.id) states.delete(String(agent.id))
  })

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  /**
   * The panel's view of the configuration, in one shape used by all three
   * responses (GET, POST and the `config` field of the state route), so the
   * page never has to reconcile two spellings of the same setting.
   */
  const refreshConfiguration = async () => {
    let raw = null, updatedAt = null
    try {
      const info = await stat(file)
      if (info.size > MAX_BODY_BYTES) throw new Error('配置文件超过 64 KiB')
      raw = await readFile(file, 'utf8'); updatedAt = info.mtimeMs
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    const revision = createHash('sha256').update(raw ?? 'missing').digest('hex')
    if (revision !== fileMetadata.revision) {
      const stored = sanitizeStored(raw === null ? undefined : JSON.parse(raw))
      current = pinned ? { ...environmentConfig, ...orchestrationOptions(stored) } : applyStored(environmentConfig, stored)
      orchestration.refreshCoordinationTools()
      for (const state of states.values()) {
        state.policy = policyFor(current)
      }
    }
    fileMetadata = { revision, updatedAt, exists: raw !== null }
  }
  const configPayload = () => ({
    ok: true,
    modelRouting: 'roles',
    reviewerModelPolicy: REVIEWER_MODEL_POLICY,
    mode: current.mode,
    threshold: current.threshold,
    locked: pinned,
    lockedBy: pinned ? 'env' : null,
    modes: CONFIG_MODES,
    file,
    revision: fileMetadata.revision,
    updatedAt: fileMetadata.updatedAt,
    defaults: sanitizeStored(undefined),
    ranges: { threshold: { min: MIN_THRESHOLD, max: MAX_THRESHOLD }, ...OPTION_RANGES },
    source: { kind: pinned ? 'env' : fileMetadata.exists ? 'file' : 'defaults', profile: path.basename(file, '.json'), environmentValue: pinned ? environmentValue : null },
    ...orchestrationOptions(current),
  })

  /** A read-only view of the counters, so the gate can be checked without logs. */
  const stateRoute = async (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' })
      response.end()
      return
    }
    await ready
    const selectedId = new URL(request.url || `${API_BASE}/state`, 'http://localhost').searchParams.get('sessionId')
    if (selectedId && orchestration.requestContext(selectedId)) stateOf(selectedId)
    const body = {
      ok: true,
      sessionId: selectedId,
      enabled: current.enabled,
      mode: current.mode,
      threshold: current.threshold,
      requireDelegateFirst: current.requireDelegateFirst,
      gatedTools: current.gatedTools,
      delegationTools: current.delegationTools,
      // The same three fields the config route serves, so a page that polls
      // only the state route still sees the setting it is editing.
      config: { mode: current.mode, threshold: current.threshold, locked: pinned },
      plans: orchestration.snapshot().filter(plan => selectedId === null || plan.sessionId === selectedId),
      storageError: orchestration.storageError,
      archiveWarning: orchestration.archiveWarningFor(selectedId),
      limits: orchestrationOptions(current),
      supervisionPolicy: orchestration.supervisionPolicy,
      runtimePolicyVersion: orchestration.supervisionPolicy.version,
      coordinatorProgressVersion: 1,
      decisionProtocolVersion: 2,
      coordinationPolicyVersion: COORDINATION_POLICY_VERSION,
      modelRoutingPolicyVersion: 1,
      requestBindingVersion: 2,
      deliveryProtocolVersion: 1,
      reviewerModelPolicy: REVIEWER_MODEL_POLICY,
      requestUsage: orchestration.requestUsages(selectedId),
      // No execution here, so this is the global view only — a status probe, not
      // the gate's own decision.
      canDelegate: (() => {
        try {
          const native = ctx.get('subagents')
          if (native?.startActivation && (typeof native.getProvider !== 'function' || native.getProvider('spawn'))) return true
          return ctx.tools.schemas().some((schema) => current.delegationTools.includes(schema.name))
        } catch {
          return false
        }
      })(),
      sessions: [...states.entries()].filter(([id]) => selectedId === null || id === selectedId).map(([id, state]) => ({
        sessionId: id,
        sessionTitle: sessionTitleOf(id),
        source: orchestration.sourceOf(id),
        requestBindingVersion: 2,
        pendingMessages: orchestration.pendingMessages(id),
        messageResolution: orchestration.requestContext(id)?.messageResolution ?? null,
        argumentRecovery: orchestration.requestContext(id)?.argumentRecovery ?? null,
        role: state.isCoordinator ? 'coordinator' : 'worker',
        turn: state.turn,
        direct: state.direct,
        delegated: state.delegated,
        denied: state.denied,
        turnStats: { direct: state.direct, delegated: state.delegated, denied: state.turnDenied },
        sessionStats: { denied: state.denied, since: state.observedSince },
        execution: state.execution,
        decision: orchestration.decisionFor(id),
        decisionCurrent: orchestration.decisionCurrent(id),
        modelRouting: orchestration.modelRoutingState(id),
        delegationAvailability: state.delegationAvailability ?? delegationAvailability(ctx.get('agents')?.get?.(id)),
        last: state.last,
        // The judgement that governs this turn, and the policy it produced.
        // `null` means no turn has started since the plugin activated.
        difficulty: state.difficulty
          ? {
              score: state.difficulty.score,
              level: state.difficulty.level,
              signals: state.difficulty.signals,
            }
          : null,
        route: state.route ? {
          route: state.route.route,
          reasons: state.route.reasons,
          reasonLabels: state.route.reasonLabels,
          estimatedSteps: state.route.estimatedSteps,
          parallelTasks: state.route.parallelTasks,
          confidence: state.route.confidence,
        } : null,
        policy: state.policy
          ? { requireFirst: state.policy.requireFirst, budget: state.policy.budget }
          : null,
      })),
    }
    sendJson(response, 200, body)
  }

  /**
   * `GET /dsh-delegation-first/api/config` — read the setting.
   *
   * Awaiting `ready` matters here: the file is read asynchronously at
   * activation, and a panel that opens in that first moment must not be told
   * the defaults while the file already says something else.
   */
  const readConfigRoute = async (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' })
      response.end()
      return
    }
    await ready
    try { await refreshConfiguration() }
    catch (error) { sendJson(response, 503, { ok: false, error: `配置读取失败（${file}）：${error.message}` }); return }
    sendJson(response, 200, configPayload())
  }

  /**
   * Validate one save request against the current setting.
   *
   * @returns `{ stored }` on success, or `{ error }` with the Chinese text the
   *          panel shows as-is — the message is the user-facing explanation of
   *          why nothing was saved, so it must name the actual problem.
   */
  const validateSave = (body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { error: '请求体必须是 JSON 对象，例如 { "mode": "auto", "threshold": 2 }' }
    }
    const next = { mode: current.mode, threshold: current.threshold, ...orchestrationOptions(current) }
    try { Object.assign(next, orchestrationOptions({ ...next, ...body }, true)) }
    catch (error) { return { error: error.message } }

    if (body.mode !== undefined) {
      if (typeof body.mode !== 'string' || !CONFIG_MODES.includes(body.mode)) {
        return { error: `mode 只能是 ${CONFIG_MODES.join(' / ')}，收到 ${JSON.stringify(body.mode)}` }
      }
      next.mode = body.mode
    }

    if (body.threshold !== undefined && body.threshold !== null) {
      const threshold = normalizeThreshold(body.threshold)
      if (threshold === undefined) {
        return {
          error: `threshold 必须是 ${MIN_THRESHOLD}~${MAX_THRESHOLD} 的整数，收到 ${JSON.stringify(body.threshold)}`,
        }
      }
      next.threshold = threshold
    }

    // Switching to a fixed budget must carry the number it is a budget *of*.
    // Inheriting whatever was saved before would make the panel's own rule
    // ("required in fixed mode") disagree with the Host's.
    if (next.mode === 'fixed' && (body.threshold === undefined || body.threshold === null)) {
      return { error: '固定预算模式下必须带 threshold（0~20 的整数）' }
    }
    return { stored: next }
  }

  /**
   * `POST /dsh-delegation-first/api/config` — save the setting.
   *
   * Order of the checks is deliberate: a locked deployment answers 409 before
   * it looks at the body, because "you cannot change this" is the useful
   * answer, not "your number was odd".
   */
  const writeConfigRoute = async (request, response) => {
    await ready
    if (pinned) {
      sendJson(response, 409, {
        // `ok: false` last: the payload carries `ok: true` for the panel's own
        // success path, and a rejected save must not read as a saved one.
        ...configPayload(),
        ok: false,
        error: '配置由环境变量 DSH_DELEGATION_FIRST 锁定，面板不能修改；请改环境变量后重启 Harness。',
      })
      return
    }
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, 400, { ok: false, error: `请求体无法解析：${error?.message ?? error}` })
      return
    }
    const checkRevision = async () => {
      try { await refreshConfiguration() }
      catch (error) { sendJson(response, 503, { ok: false, error: `配置读取失败（${file}）：${error.message}` }); return false }
      if (body?.revision !== undefined && body.revision !== fileMetadata.revision) {
        sendJson(response, 409, { ...configPayload(), ok: false, code: 'CONFIG_CONFLICT', error: '配置已在别处更新，请先核对差异，再选择使用最新配置或保留自己的修改。' })
        return false
      }
      return true
    }
    if (!await checkRevision()) return
    const verdict = validateSave(body)
    if (verdict.error) {
      sendJson(response, 400, { ok: false, error: verdict.error })
      return
    }
    if (verdict.stored.mode !== 'off') {
      try {
        for (const tier of ['worker']) {
          const route = verdict.stored.models[tier]
          if (route) await validateModelRoute(ctx.get('llm'), route, tier)
        }
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message, ...(error.issue ? { issue: error.issue } : {}) })
        return
      }
    }
    if (!await checkRevision()) return
    try {
      await persistStored(file, verdict.stored)
    } catch (error) {
      // The old setting is still live and still on disk: a failed write is
      // reported, not applied.
      sendJson(response, 500, { ok: false, error: `配置写入失败（${file}）：${error?.message ?? error}` })
      return
    }
    await refreshConfiguration()
    sendJson(response, 200, configPayload())
  }

  /**
   * The one handler registered at the config path.
   *
   * One route, two methods. `webServer.register` throws on a duplicate
   * `(kind, path)`, so two handlers at one exact path would make the second
   * registration fail and silently drop a method. Splitting by `request.method`
   * inside one handler is the only shape this service supports — and it is what
   * every other route in this profile does.
   */
  const configRoute = (request, response) => {
    const method = String(request?.method ?? 'GET').toUpperCase()
    if (method === 'GET') return readConfigRoute(request, response)
    if (method === 'POST') {
      const writing = configWrites.then(() => writeConfigRoute(request, response))
      configWrites = writing.catch(() => {})
      return writing
    }
    response.writeHead(405, { allow: 'GET, POST' })
    response.end()
    return undefined
  }

  const archiveRoute = kind => async (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' }); response.end(); return
    }
    await ready
    try {
      const query = new URL(request.url || '', 'http://localhost').searchParams
      if (kind === 'history') {
        const page = await orchestration.history(query.get('before') ?? undefined)
        sendJson(response, 200, { ok: true, ...page }); return
      }
      if (kind === 'delivery') {
        const seq = query.get('seq')
        if (seq === null || !/^\d+$/.test(seq)) { sendJson(response, 400, { ok: false, error: '交付查询需要非负消息序号 seq' }); return }
        const delivery = await orchestration.readDelivery(query.get('sessionId'), Number(seq))
        sendJson(response, 200, { ok: true, delivery }); return
      }
      const id = query.get('id')
      const archive = await orchestration.readArchive(id)
      if (query.get('format') === 'markdown') {
        response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store',
          'x-content-type-options': 'nosniff', 'content-disposition': 'attachment; filename="' + id + '.md"' })
        response.end(archive.markdown); return
      }
      sendJson(response, 200, { ok: true, ...archive })
    } catch (error) {
      const status = error.statusCode === 400 ? 400 : error.code === 'ENOENT' ? 404 : 500
      sendJson(response, status, { ok: false, error: status === 404
        ? '任务档案不存在，或档案文件已被移动。请核对任务显示的保存位置。'
        : '读取任务档案失败：' + (error.message || String(error)) })
    }
  }

  const disposeRoutes = []

  /** A route failure is always reported: a silent 404 is what this bug was. */
  const warnRoute = (reason) => {
    console.warn(`[dsh-delegation-first] 面板路由不可用：${reason}`)
  }

  /**
   * Register both routes on a context that *has* the service.
   *
   * `ctx.get('webServer')` is a point-in-time probe, not a wait. This plugin
   * declares `tools`, not `webServer`, so the Loader is free to run this
   * activation before the web server's fiber reaches `ACTIVE` — and the strict
   * `get` then answers `undefined`. The old code hid that behind `?.` plus an
   * empty `catch`, so "not up yet" became a no-op: the gate loaded and worked,
   * the two routes were never registered, and the fallback handler answered
   * them with 404 for the life of the process.
   *
   * Hence the child fiber below: its body runs once the service is ACTIVE
   * (immediately when it already is, later when it appears, again when it is
   * replaced). `webServer` stays optional, so a profile without a web server
   * keeps the gate and loses only the panel — which is the intent the old
   * optional-chained read was reaching for.
   */
  const registerRoutes = (scope) => {
    let webServer
    try {
      // `get` works from any context and does not need this scope to declare
      // the dependency; the injected scope also exposes it as a property.
      webServer = typeof scope.get === 'function' ? scope.get('webServer') : scope.webServer
    } catch (error) {
      warnRoute(`读取 webServer 失败（${error instanceof Error ? error.message : String(error)}）`)
      return
    }
    if (!webServer || typeof webServer.register !== 'function') {
      warnRoute('webServer.register 不存在，面板路由未注册（页面会显示 404）')
      return
    }
    const register = (pathname, handler) => {
      try {
        const route = { kind: 'exact', path: pathname, handler }
        // Tied to this scope: the child fiber's teardown releases the route,
        // and the plugin's own effect below is the second owner.
        if (typeof scope.effect === 'function') {
          scope.effect(() => webServer.register(route), `dsh-delegation-first: ${pathname}`)
          return
        }
        const dispose = webServer.register(route)
        if (typeof dispose === 'function') disposeRoutes.push(dispose)
      } catch (error) {
        warnRoute(`${pathname} 注册失败（${error instanceof Error ? error.message : String(error)}）`)
      }
    }
    register(`${API_BASE}/state`, stateRoute)
    register(`${API_BASE}/config`, configRoute)
    register(`${API_BASE}/history`, archiveRoute('history'))
    register(`${API_BASE}/archive`, archiveRoute('archive'))
    register(`${API_BASE}/delivery`, archiveRoute('delivery'))
  }

  try {
    if (typeof ctx.inject === 'function') {
      // Optional dependency: the child fiber waits for `webServer` instead of
      // racing it, and is disposed together with this plugin.
      ctx.inject(['webServer'], registerRoutes)
    } else {
      // Non-Cordis host: best effort, still loud on failure.
      registerRoutes(ctx)
    }
  } catch (error) {
    warnRoute(`webServer 注入失败（${error instanceof Error ? error.message : String(error)}）`)
  }

  // -------------------------------------------------------------------------
  // Per-agent discipline section
  // -------------------------------------------------------------------------

  /**
   * Register the short section on the **agent's own context**, and only on a
   * coordinator's.
   *
   * Why not the plugin's `ctx`: a section registered there is global, so it
   * would reach subagents too. A worker that reads "本会话是主控，把活派出去"
   * starts coordinating over its own work — the exact role flip this bundle
   * exists to prevent. Scope the section to the agent whose role it describes.
   *
   * Why the map: an `agent.ctx` registration is disposed with that agent, but
   * unloading this plugin does not dispose `agent.ctx` registrations on its own.
   * Keeping the disposer in both owners is the harness practice — either
   * teardown removes it, and a second dispose is harmless.
   */
  const sectionDisposers = new Map()
  let warnedNoSystemPrompt = false

  const warnOnce = (reason) => {
    if (warnedNoSystemPrompt) return
    warnedNoSystemPrompt = true
    console.warn(`[dsh-delegation-first] 系统提示段未注入：${reason}`)
  }

  /** The session header is the role record: a worker carries one of its marks. */
  const headerOf = (agentId) => {
    try {
      return sessions()?.get?.(agentId)?.header
    } catch {
      return undefined
    }
  }

  /**
   * Attach the section to one live agent, if it is a coordinator.
   *
   * Idempotent: `agent/created` and the catch-up sweep below can both reach the
   * same agent, and a second section with the same name would throw.
   */
  const attachDiscipline = (agent) => {
    const agentId = String(agent?.id ?? '')
    if (!agentId || sectionDisposers.has(agentId)) return

    const header = headerOf(agentId)
    if (!header) {
      // Role unknown. Staying silent is the safe side: a coordinator missing the
      // section only loses a reminder, while a worker given it loses its role.
      warnOnce('读不到会话 header（sessions 服务不可用或会话尚未注册）')
      return
    }
    const worker =
      header.origin === 'subagent' ||
      Boolean(header.parentSession) ||
      (Number(header.delegationDepth) || 0) > 0
    if (worker) return

    let prompt
    try {
      prompt = agent.ctx?.systemPrompt
    } catch {
      prompt = undefined
    }
    if (typeof prompt?.section !== 'function') {
      warnOnce('agent.ctx.systemPrompt 不可用')
      return
    }

    try {
      const dispose = agent.ctx.systemPrompt.section({
        name: 'dsh-delegation-first: discipline',
        order: 700,
        // Called on every prompt assembly, so it reads the judgement of the turn
        // being assembled: the section follows the turn without being
        // re-registered. No judgement (plugin activated mid-turn, scoring
        // failed) simply means the plain discipline.
        text: () => {
          try {
            if (!current.enabled) return ''
            const summary = orchestration.summary(agentId)
            const state = states.get(agentId), missing = state?.delegationAvailability?.status === 'unavailable'
              ? '当前会话的委派入口不可用。请明确告知用户并检查插件启用状态，不要宣称已派发子代理。' : ''
            const failures = state?.execution?.unresolvedChanges ?? []
            const unresolved = failures.length ? '尚未成功修改：' + failures.map(item => `${item.target || item.tool}（${item.reason}）`).join('；') : ''
            const decision = orchestration.decisionFor(agentId)
            const messages = orchestration.pendingMessages(agentId)
            const pending = messages.length && !summary ? '待关联用户消息（仅事实，尚未归属需求）：' + messages.map(message => message.messageId + '：' + message.text.slice(0, 180)).join('；') + '。新委派用 delegation_plan({relation,decisionReason,start:true,...}) 同时关联并派发；直接执行或多条消息分别关联才用 delegation_decide，不能按字数猜测。' : ''
            const choice = orchestration.decisionCurrent(agentId) ? '本需求已记录执行方式：' + decision.mode + '。范围未变无需重复记录。'
              : '本需求尚未记录判断或范围已补充；新委派用 delegation_plan({relation,decisionReason,start:true,...})，无需单独 decide/run；直接执行先记录 direct。'
            return [DISCIPLINE, pending, choice, missing, unresolved, summary].filter(Boolean).join('\n\n')
          } catch {
            return DISCIPLINE
          }
        },
      })
      if (typeof dispose === 'function') sectionDisposers.set(agentId, dispose)
    } catch (error) {
      warnOnce(`注册失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const offAgentCreated = ctx.on('agent/created', ({ agent }) => attachDiscipline(agent))

  /**
   * Agents that were already live when this plugin activated — including the
   * session the person is looking at right now — never fire `agent/created`
   * again, so without this sweep the discipline would only appear in sessions
   * created after the reload. That is exactly the case a plugin install or an
   * HMR reload produces, so the sweep is not an edge case.
   */
  try {
    const live = ctx.get('agents')?.list?.() ?? []
    for (const agent of live) attachDiscipline(agent)
  } catch {
    /* the registry is optional; a missing one only costs the catch-up */
  }

  const offAgentSectionDisposed = ctx.on('agent/disposed', ({ agent }) => {
    const agentId = String(agent?.id ?? '')
    if (!agentId) return
    const dispose = sectionDisposers.get(agentId)
    sectionDisposers.delete(agentId)
    try {
      dispose?.()
    } catch {
      /* already released with the agent context */
    }
  })

  ctx.effect(() => () => {
    for (const dispose of [
      disposeGuard,
      offEvent,
      offDisposed,
      offAgentCreated,
      offAgentSectionDisposed,
      offResult,
      offDecisionRecovery,
      offCoordinatorStream,
      offDirectStopping,
    ]) {
      try {
        dispose?.()
      } catch {
        /* already gone */
      }
    }
    for (const dispose of disposeRoutes) {
      try {
        dispose?.()
      } catch {
        /* already released with the web server */
      }
    }
    disposeRoutes.length = 0
    for (const dispose of sectionDisposers.values()) {
      try {
        dispose?.()
      } catch {
        /* already released with its agent */
      }
    }
    sectionDisposers.clear()
    states.clear()
    return orchestration.dispose()
  }, 'dsh-delegation-first: gate')
}
