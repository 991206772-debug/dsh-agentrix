/** Host policy, native task orchestration, and the panel's HTTP API. */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createOrchestrator, OPTION_RANGES, orchestrationOptions, validateModelRoute } from './orchestrator.js'

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
  '## DSH Agentrix：主控职责',
  '结合前文、实际文件和执行步骤判断工作量。评分只是起点，短句和低分不能作为不委派的理由；范围明确的小修改直接完成，中等或复杂工作主动拆分，不等用户提醒。',
  '- 先读相关文件，调用 delegation_plan 提交任务卡：目标、说明、边界、交付物、可修改路径、依赖、验收标准和主控验证步骤。',
  '- 准备阶段用 read/grep/glob 读取；目录和 Git 基线用 delegation_inspect。计划、发现、进度用 delegation_note 保存，不占业务修改额度；不要用 shell 或 write 绕写业务文件。',
  '- 主控使用对话框选择的模型做规划与最终验收；先确定复杂需求的方案、接口和验收标准，再拆为执行者能完成的任务。普通任务选 complexity=routine，复杂任务选 complex，并用 complexityReason 说明依据；复杂度不决定执行模型。',
  '- 所有执行者固定使用用户配置的 worker 模型，独立审查固定使用 reviewer 模型（未指定审查模型时明确跟随主控）。执行模型未选则暂停，不静默继承；不根据模型名称或价格猜测强弱。执行者报告缺上下文或能力不足时，主控补方案或重新拆分，不让它反复猜测或自动升级模型。',
  '- 自动派单只用 delegation_plan/run；直接调用 subagent、subagent_fork、spawn_teammate 会绕过执行/审查角色的模型配置，因此主控不可走这些入口。',
  '- 调用 delegation_run 后独立任务按全局并发上限自动派单；依赖任务必须等前置任务验收。若状态返回 dispatchWait，表示正在等待其他会话释放名额或写入冲突结束，等待即可，不要反复调用 delegation_run，也不要绕过闸门直接修改。',
  '- 插件在重复失败、阶段停滞、预算预警或正式报告返回时通知原主控。收到 delegation-supervision 后立即读取 delegation_status，核对证据和阶段结论，用 delegation_control(action:steer) 向原子代理给出具体纠正；失败或超时后不要无原因调用 delegation_cancel，插件会沿用原计划恢复可重试任务；只有用户明确取消时才传 reason 终止计划。监督每任务最多两次，不能靠重复 run、重载或新建代理刷新预算。等待用事件，不轮询模型，不代做执行者实现。',
  '- 主控可依据状态里的 route / reasons 判断是否应 direct、delegate 或 delegate_parallel；路由依据必须在任务卡中落地，不能只凭感觉开子 Agent。',
  '- 计划显示“已派发 / 上限 / 剩余”预算；达到上限或失败熔断后不要重复调用 delegation_run，先处理原因或新建计划。',
  '- 模型配置失效时，说明哪个模型不可用，提示用户在“DSH Agentrix”重新选择并保存；配置未更新前暂停派单，不重试，也不猜测磁盘或权限问题。',
  '- 子任务通过 delegation_report 提交 DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED 及完整报告，工具确认后自动结束；不通过 send_message 交成果，提交后不能继续修改。缺上下文先补资料，阻塞先处理原因，不原样重试；有疑点先说明处理意见。',
  '- complex 任务自动安排一个独立只读审查者，同时检查需求与代码质量；启动计入同一预算和并发，固定使用审查模型。普通任务由主控实际验证、验收，也可按风险调用 delegation_audit 使用审查模型，不固定增加代理。审查失败不自动重开，处理原因后用 delegation_audit({taskId,message}) 只重试审查。',
  '- 主控调用 delegation_verify 运行任务卡中的验证（严格模式也允许），再逐条读取证据用 delegation_review 验收。测试通过不能替代需求达标；页面还原需原稿与同尺寸实际截图，运行问题需原场景证据。',
  '- 返工只提交明确问题：引用已有 issueIds，或用 issues 给出 criterion、severity、finding 和本次验证 callId。minor 仅记录，不开新代理；复查只判断原问题及修复引入的回归，达到上限即停止。routine 返工后用 resolutions 逐条引用新验证证据确认解决。',
  '- stop 仅表示取消，必须提供 reason，不能用来成功收尾。报告返回后插件自动释放资源；已验收任务重复清理保持原结果。',
  '- 完成结论以插件回执为准；最后一次 delegation_review 验收通过后自动生成交付回执并结束回合，无需另写完成总结。测试有结果但未验收不能称为完成。提前结束时插件最多两次在原代理补齐缺失流程，不新开代理；用户取消优先。',
  '- 聊天、任务验收页和导出读取同一份程序回执，包含交付文件、真实验证证据和未完成原因；协作过程看 Fleet，完整记录通过“分享会话”导出。',
  '- 完整任务卡示例见 delegation-first skill。',
].join('\n')

// ---------------------------------------------------------------------------
// Difficulty assessment
// ---------------------------------------------------------------------------

/**
 * The buckets the scorer looks for, all taken from the person's own words.
 *
 * Plain substring lists rather than clever patterns on purpose: a Chinese
 * phrase match is readable, and the cost of a false positive here is one point,
 * not a denial.
 */
const CONNECTIVES = ['并且', '同时', '另外', '然后', '还要', '以及', '分别', '顺便']
const HEAVY_WORDS = ['重构', '审计', '调研', '迁移', '全量', '所有', '批量', '多文件', '测试套件', '性能优化', '逐个']
const LIGHT_WORDS = ['看看', '这是啥', '解释一下', '为什么', '是什么']
const TASK_ACTION = /实现|开发|新增|增加|补充|修复|修改|改成|调整|替换|评审|审核|排查|优化|重构|迁移|对接|集成|结合|推送|上传|部署|打包|自动生成/
const CONTINUE_ONLY = /^(?:继续(?:呢|吧)?|接着(?:做|吧)?|下一步|continue|go on|可以|好的?|行|开始吧)[。.!！\s]*$/i
const FOLLOWUP = /^(?:(?:可以|好的?|行)[，,]|还有|另外|而且|然后|那就|再把|这个|这里|这处|它|他|发给)/
const LEVEL_RANK = { simple: 0, medium: 1, complex: 2 }

/** A numbered or bulleted requirement line. */
const BULLET_LINE = /^\s*(?:\d+\.|[-*])\s+/
/** A drive-rooted path, or a bare file name with an extension. */
const DRIVE_PATH = /[A-Za-z]:[\\/]/g
const FILE_NAME = /\.\w{1,5}\b/g

/**
 * The conservative reading of "this turn has no input to judge": medium.
 *
 * Not `simple` on purpose — an unscored turn must never unlock the gate. The
 * score stays 0 because nothing was actually counted; only the level is a
 * deliberate default.
 */
const DEFAULT_DIFFICULTY = { score: 0, level: 'medium', signals: [] }

/**
 * Score one turn's human input.
 *
 * Pure and total: non-string input scores as empty text, nothing here throws,
 * and anything unexpected is still caught by the caller — a scorer that throws
 * would turn the gate into an open one. Buckets are capped on purpose: no single
 * signal may decide the level, and the score is a reading aid, not a metric.
 */
function scoreTask(text) {
  const raw = typeof text === 'string' ? text : ''
  const signals = []
  let score = 0

  // Volume: a long text is almost always several goals stapled together.
  if (raw.length >= 120) {
    score += 1
    if (raw.length >= 400) score += 1
    signals.push('体量较大')
  }

  // Parallel structure: numbered/bulleted lines are a checklist, not one ask.
  const bullets = raw.split(/\r?\n/).filter((line) => BULLET_LINE.test(line)).length
  if (bullets >= 2) {
    score += 2
    signals.push('多条并列要求')
  }

  // Connectives: one sentence chaining several actions.
  const connectives = CONNECTIVES.filter((word) => raw.includes(word)).length
  if (connectives > 0) {
    score += Math.min(connectives, 2)
    signals.push('多目标')
  }

  // Short feature lists can describe substantial work without any heavy keywords.
  const features = ['登录', '注册', '短信', '密码重置', '权限', '导入', '导出', '支付', '审批', '通知'].filter(word => raw.includes(word)).length
  if (features >= 3 && /实现|开发|新增|支持|完成/.test(raw)) {
    score += Math.min(features, 6)
    signals.push('多个功能点')
  }

  // Heavy words: weighed 2 each — a lone "重构" can still be a small fix, but
  // "重构" plus "所有" is real work. The cap keeps this bucket from deciding
  // the level on its own.
  const heavy = HEAVY_WORDS.filter((word) => raw.includes(word)).length
  if (heavy > 0) {
    score += Math.min(heavy * 2, 3)
    signals.push('重任务关键词')
  }

  // File mentions: two or more paths/names means the change crosses files.
  const mentions = (raw.match(DRIVE_PATH) ?? []).length + (raw.match(FILE_NAME) ?? []).length
  if (mentions >= 2) {
    score += 1
    signals.push('涉及多个文件')
  }

  // Light question: short and purely interrogative, so it earns a discount.
  // Floored at zero — a negative score has no meaning here.
  if (raw.length < 80 && !TASK_ACTION.test(raw) && LIGHT_WORDS.some((word) => raw.includes(word))) {
    score = Math.max(0, score - 1)
    signals.push('轻量提问')
  }

  // Short implementation requests are not evidence of a small change. Only an
  // explicitly local wording/style edit keeps the inexpensive direct path.
  const localEdit = raw.length < 80 && /标题|文案|错别字|拼写|字号|颜色/.test(raw) &&
    !/模块|功能|接口|配置|同时|另外|还有|然后|以及|并且/.test(raw)
  if (TASK_ACTION.test(raw) && !localEdit) {
    score = Math.max(score, 3)
    signals.push('需要实施或评审')
  }

  const level = score >= 6 ? 'complex' : score >= 3 ? 'medium' : 'simple'
  return { score, level, signals }
}

const LEVEL_LABEL = { simple: '简单', medium: '中等', complex: '复杂' }
const LEVEL_ADVICE = {
  simple: '可先处理范围明确的小事；发现多文件或多步骤时重新判断并委派。',
  medium: '可先做 1 步试探，随后必须派单。',
  complex: '先拆解、先派单，再动手。',
}

const ROUTE_LABEL = { direct: 'direct', delegate: 'delegate', delegate_parallel: 'delegate_parallel' }
const ROUTE_REASON_LABEL = {
  scope_small: '范围明确且规模较小',
  medium_complexity: '复杂度达到中等',
  high_complexity: '复杂度达到高位',
  multiple_goals: '存在多个目标或并列要求',
  multiple_files: '涉及多个文件',
  heavy_work: '包含重任务关键词',
  multiple_features: '包含多个功能点',
  implementation: '需要实施或评审',
  parallel_candidates: '任务之间可能独立，可并行派发',
  context_only: '当前只有轻量提问或未形成实施目标',
}

/**
 * Turn the score into an explicit routing decision the coordinator can see.
 * This remains a recommendation: the task card and actual dependencies are
 * authoritative once the coordinator calls delegation_plan.
 */
function routeFor(difficulty, text = '') {
  const level = LEVEL_LABEL[difficulty?.level] ? difficulty.level : 'medium'
  const signals = new Set(difficulty?.signals ?? [])
  const reasons = []
  if (level === 'simple') reasons.push('scope_small')
  else reasons.push(level === 'complex' ? 'high_complexity' : 'medium_complexity')
  if (signals.has('多目标') || signals.has('多条并列要求')) reasons.push('multiple_goals')
  if (signals.has('涉及多个文件')) reasons.push('multiple_files')
  if (signals.has('重任务关键词')) reasons.push('heavy_work')
  if (signals.has('多个功能点')) reasons.push('multiple_features')
  if (signals.has('需要实施或评审')) reasons.push('implementation')
  if (signals.has('轻量提问') || (!text && level === 'medium')) reasons.push('context_only')
  const parallel = level !== 'simple' && (signals.has('多目标') || signals.has('多条并列要求') || signals.has('多个功能点') || signals.has('涉及多个文件'))
  if (parallel) reasons.push('parallel_candidates')
  const score = Number.isFinite(difficulty?.score) ? difficulty.score : 0
  const route = level === 'simple' ? 'direct' : parallel ? 'delegate_parallel' : 'delegate'
  const estimatedSteps = route === 'direct' ? 1 : Math.min(12, Math.max(2, 2 + score))
  const parallelTasks = route === 'delegate_parallel' ? Math.min(4, Math.max(2, 1 + (signals.has('多目标') ? 1 : 0) + (signals.has('涉及多个文件') ? 1 : 0))) : 1
  const confidence = score === 0 ? 0.4 : level === 'complex' ? 0.9 : level === 'medium' ? 0.75 : 0.7
  const uniqueReasons = [...new Set(reasons)]
  return { route: ROUTE_LABEL[route], reasons: uniqueReasons,
    reasonLabels: uniqueReasons.map(reason => ROUTE_REASON_LABEL[reason] ?? reason), estimatedSteps, parallelTasks, confidence }
}

/** The one line that surfaces this turn's judgement to the coordinator's model. */
function difficultyLine(difficulty) {
  const level = LEVEL_LABEL[difficulty?.level] ? difficulty.level : 'medium'
  const signals =
    Array.isArray(difficulty?.signals) && difficulty.signals.length > 0
      ? difficulty.signals.join('、')
      : '无'
  const score = Number.isFinite(difficulty?.score) ? difficulty.score : 0
  return `> 本轮任务复杂度：${LEVEL_LABEL[level]}（评分 ${score}；信号：${signals}）→ ${LEVEL_ADVICE[level]}`
}

function routingLine(route) {
  if (!route?.route) return ''
  const reasons = (route.reasons ?? []).map(reason => ROUTE_REASON_LABEL[reason] ?? reason).join('、') || '未记录'
  return `> 自动路由建议：${route.route}；依据：${reasons}；预计 ${route.estimatedSteps ?? '—'} 步，${route.parallelTasks ?? 1} 个并行任务，置信度 ${Math.round((route.confidence ?? 0) * 100)}%。`
}

/**
 * How tight the gate is for one difficulty level.
 *
 * `simple` keeps the post-delegation budget and asks for no delegation up front;
 * `medium` buys exactly one probing step; `complex` keeps the "delegate first"
 * rule, so the hardest turns are gated as before. Explicit environment modes
 * override the judgement: `strict` never allows hands-on work in an undelegated
 * turn, and a bare number always allows n calls without delegating.
 */
function policyFor(level, config) {
  if (config.mode === 'strict') return { requireFirst: true, budget: 0 }
  if (config.mode === 'fixed') return { requireFirst: false, budget: config.threshold }
  switch (level) {
    case 'simple':
      return { requireFirst: false, budget: null }
    case 'complex':
      return { requireFirst: true, budget: config.threshold }
    case 'medium':
    default:
      return { requireFirst: false, budget: 1 }
  }
}

/**
 * The gate as it behaved before difficulty existed.
 *
 * Used when no judgement exists yet (the plugin activated mid-turn) or when
 * scoring failed: requiring delegation first is the safe side of an unknown
 * turn, which is also what "do not let a scoring failure disarm the gate" means.
 */
function legacyPolicy(config) {
  if (config.mode === 'strict') return { requireFirst: true, budget: 0 }
  if (config.mode === 'fixed') return { requireFirst: false, budget: config.threshold }
  return { requireFirst: config.requireDelegateFirst, budget: config.threshold }
}

/**
 * Concatenate the text blocks of one message payload.
 *
 * A plain string is accepted too: the exact shape of an injected message is not
 * this plugin's contract, and a cheap fallback beats dropping the input.
 */
function messageText(data) {
  const content = data?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
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
const WORK_TOOLS = [...GATED_TOOLS, 'read', 'grep', 'glob']
const READ_ONLY_TOOLS = ['read', 'grep', 'glob']
const newWorkload = () => ({ direct: 0, calls: 0, files: new Set(), exhausted: false })

/** A call of one of these means work left this context. */
const DELEGATION_TOOLS = ['spawn_teammate', 'subagent', 'subagent_fork']

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
    // Only the fallback used before a turn is judged (and by `strict`): the gate
    // still asks for delegation first when no judgement is available.
    requireDelegateFirst: true,
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
  if (raw === 'strict') return { ...config, mode: 'strict', threshold: 0 }
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
    // The pre-difficulty fallback: `strict` asks for delegation first, a fixed
    // budget never does, and `auto` keeps the conservative default.
    requireDelegateFirst:
      mode === 'strict' ? true : mode === 'fixed' ? false : base.requireDelegateFirst,
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
    '请调用 delegation_plan 建立有验收标准的任务卡，再调用 delegation_run。',
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
 * difficulty assessment and stored on `state` by `assessTurn()`, so this
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
  const policy = state.policy ?? legacyPolicy(config)
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
    return current
  })

  const sessions = () => {
    try {
      return ctx.get('sessions')
    } catch {
      return undefined
    }
  }

  /** sessionId → the counters and the judgement a turn is governed by. */
  const states = new Map()
  const stateOf = (sessionId) => {
    let state = states.get(sessionId)
    if (!state) {
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
        // Human text collected for the turn that has not started yet.
        pendingText: '',
        taskText: '',
        source: null,
        sessionId,
        workload: newWorkload(),
        // Message ids already counted. The harness commits the same human input
        // twice (see `rememberHumanText`), so ids are the only safe dedupe key.
        humanIds: new Set(),
        delegationPending: new Map(),
      }
      states.set(sessionId, state)
    }
    return state
  }

  const orchestration = createOrchestrator({ ctx, file: file.replace(/\.json$/, '.runs.json'),
    getConfig: () => current, getSource: id => states.get(id)?.source ?? null, getRoute: id => states.get(id)?.route ?? null,
    onDelegated: id => { stateOf(id).delegated++ } })
  const ready = Promise.all([configReady, orchestration.ready])

  /**
   * Collect one human message's text for scoring.
   *
   * The harness delivers the same message twice: an `agent/inbox/spliced`
   * commit **before** `turn/start`, and the `user/message` that carries it onto
   * the surface **after** it. Only the first is in time to be scored when the
   * turn starts, so both are read and deduped by message id — without the
   * splice source the judgement would never see a human sentence at all.
   */
  const rememberHumanText = (state, data) => {
    const text = messageText(data)
    if (!text) return
    const id = data?.id ? String(data.id) : `text:${text}`
    if (state.humanIds.has(id)) return
    state.humanIds.add(id)
    // Bound the dedupe set: one session can run for thousands of turns.
    if (state.humanIds.size > 500) {
      const oldest = state.humanIds.values().next().value
      if (oldest !== undefined) state.humanIds.delete(oldest)
    }
    const followup = CONTINUE_ONLY.test(text.trim()) || (text.length < 120 && FOLLOWUP.test(text.trim()))
    if (!state.pendingText && !followup && !orchestration.hasPending(state.sessionId)) {
      state.source = { messageId: data?.id ? String(data.id) : null, text: text.slice(0, 4000) }
    }
    state.pendingText = state.pendingText ? `${state.pendingText}\n${text}` : text
  }

  /**
   * Score the text collected for the turn that is starting, and derive the
   * policy the guard will follow until the next turn.
   *
   * Keep a bounded task description across explicit follow-ups. A new request
   * resets it; a short approval must not erase the work already discovered.
   */
  const assessTurn = (state) => {
    const text = state.pendingText
    state.pendingText = ''
    try {
      const continuing = !text || CONTINUE_ONLY.test(text.trim()) ||
        (text.length < 120 && FOLLOWUP.test(text.trim())) || orchestration.hasPending(state.sessionId)
      const previous = continuing ? state.difficulty : null
      if (!continuing) { state.taskText = ''; state.workload = newWorkload() }
      if (text && !CONTINUE_ONLY.test(text.trim())) state.taskText = `${state.taskText}\n${text}`.trim().slice(-4000)
      let difficulty = state.taskText ? scoreTask(state.taskText) : { ...DEFAULT_DIFFICULTY }
      if (previous && LEVEL_RANK[previous.level] >= LEVEL_RANK[difficulty.level]) {
        difficulty = { ...previous, signals: [...previous.signals] }
      }
      if (previous && !difficulty.signals.includes('承接前文任务')) difficulty.signals.push('承接前文任务')
      const policy = policyFor(difficulty.level, current)
      state.difficulty = difficulty
      state.route = routeFor(difficulty, state.taskText)
      state.policy = policy
    } catch {
      state.difficulty = null
      state.route = null
      state.policy = legacyPolicy(current)
    }
  }

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

  const disposeGuard = ctx.tools.guard((exec) => {
    const childBlock = orchestration.guardChild(exec)
    if (childBlock) return childBlock
    const role = roleOf(exec)
    if (!role) return undefined
    const state = stateOf(role.agentId)
    state.isCoordinator = !role.worker
    if (!state.isCoordinator) return undefined
    if (!canDelegate(exec)) return undefined

    const name = String(exec?.name ?? '')
    if (orchestration.allowsVerification(exec)) return undefined
    if (current.enabled && current.delegationTools.includes(name)) {
      state.denied++; state.turnDenied++
      const message = '[DSH Agentrix] 请通过 delegation_plan 建立任务卡，再用 delegation_run 派发；这样才能应用执行/审查角色的模型配置、并发限制和验收流程。读取与准备工具仍可继续使用。'
      state.last = { tool: name, kind: 'managed-dispatch', message, at: Date.now() }
      return message
    }
    if (current.enabled && orchestration.hasPending(role.agentId) && current.gatedTools.includes(name)) {
      state.denied++; state.turnDenied++
      state.last = { tool: name, kind: 'managed-plan', at: Date.now() }
      return '[DSH Agentrix] 当前计划尚未验收。请监督或返工任务；主控验证通过 delegation_verify 执行，避免与子 Agent 重复修改。'
    }
    if (current.enabled && current.mode === 'auto' && WORK_TOOLS.includes(name) && !orchestration.hasPending(role.agentId)) {
      const work = state.workload
      const reason = work.files.size >= 3 ? '已涉及 3 个修改文件' :
        work.direct >= 6 ? '直接执行已达 6 次' : work.calls >= 12 ? '上下文读取与执行已达 12 次' : null
      if (reason) {
        work.exhausted = true
        state.difficulty = { score: Math.max(6, state.difficulty?.score ?? 0), level: 'complex',
          signals: [...new Set([...(state.difficulty?.signals ?? []), reason])] }
        state.route = routeFor(state.difficulty, state.taskText)
        state.policy = policyFor('complex', current)
      }
      if (work.exhausted && state.delegated === 0 && !READ_ONLY_TOOLS.includes(name)) {
        state.denied++; state.turnDenied++
        state.last = { tool: name, kind: 'delegate-first', at: Date.now() }
        return denialMessage(name, state, current, 'delegate-first', state.policy)
      }
    }
    const verdict = evaluate(name, state, current)
    if (verdict.countsAsDelegation) {
      state.delegationPending.set(exec.callId, state.turn)
      if (state.delegationPending.size > 100) state.delegationPending.delete(state.delegationPending.keys().next().value)
      return undefined
    }
    if (verdict.allow) {
      if (verdict.countsAsDirect) state.direct += 1
      if (current.enabled && current.mode === 'auto' && WORK_TOOLS.includes(name)) {
        const work = state.workload
        work.calls = Math.min(12, work.calls + 1)
        if (verdict.countsAsDirect) {
          work.direct = Math.min(6, work.direct + 1)
          const target = exec.arguments?.file_path ?? exec.arguments?.path
          if (typeof target === 'string' && !['pwsh', 'bash'].includes(name) && work.files.size < 3) {
            const file = path.resolve(sessions()?.get?.(role.agentId)?.header?.cwd ?? process.cwd(), target)
            work.files.add(process.platform === 'win32' ? file.toLowerCase() : file)
          }
        }
      }
      return undefined
    }
    state.denied += 1
    state.turnDenied += 1
    state.last = { tool: name, kind: verdict.kind, at: Date.now() }
    return verdict.message
  })

  const offResult = ctx.on('tools/result', (exec, result) => {
    orchestration.observe(exec, result)
    const state = states.get(String(exec.agent?.id ?? ''))
    if (!state || !state.delegationPending.has(exec.callId)) return
    const turn = state.delegationPending.get(exec.callId)
    state.delegationPending.delete(exec.callId)
    if (turn === state.turn && result.isError === false) state.delegated++
  }, { global: true })

  // A turn is the unit of judgement: a new turn starts with a clean slate, so a
  // delegation in turn 1 does not license hands-on work in turn 5. The same
  // handler collects the human input the judgement needs and consumes it when
  // the turn it belongs to starts.
  const offEvent = ctx.on('session/event', (session, event) => {
    const id = String(session?.id ?? '')
    if (!id) return
    const type = event?.type

    // Human input, source 1 of 2: queued before the turn starts, which is the
    // only moment the judgement can still be made for this turn.
    if (type === 'agent/inbox/spliced') {
      const inserted = Array.isArray(event.data?.inserted) ? event.data.inserted : []
      if (inserted.length === 0) return
      const state = stateOf(id)
      for (const message of inserted) {
        if (message?.source?.kind === 'user') rememberHumanText(state, message)
      }
      return
    }

    // Human input, source 2 of 2: the committed surface message. Arrives after
    // `turn/start` in this harness, so it mostly serves the dedupe of source 1 —
    // and it is what a deployment that injects `user/message` directly relies
    // on. Harness-injected kinds (`runtime-context`, `agent-message`, …) are not
    // the person speaking and must not influence the score.
    if (type === 'user/message') {
      if (event.data?.source?.kind !== 'user') return
      rememberHumanText(stateOf(id), event.data)
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
    assessTurn(state)
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
      for (const state of states.values()) {
        state.policy = policyFor(state.difficulty?.level ?? 'medium', current)
        if (state.difficulty) state.route = routeFor(state.difficulty, state.taskText)
      }
    }
    fileMetadata = { revision, updatedAt, exists: raw !== null }
  }
  const configPayload = () => ({
    ok: true,
    modelRouting: 'roles',
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
        source: state.source,
        role: state.isCoordinator ? 'coordinator' : 'worker',
        turn: state.turn,
        direct: state.direct,
        delegated: state.delegated,
        denied: state.denied,
        turnStats: { direct: state.direct, delegated: state.delegated, denied: state.turnDenied },
        sessionStats: { denied: state.denied, since: state.observedSince },
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
        for (const tier of ['worker', 'reviewer']) {
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
            const difficulty = states.get(agentId)?.difficulty
            if (!current.enabled) return ''
            const summary = orchestration.summary(agentId)
            const route = states.get(agentId)?.route
            return [DISCIPLINE, difficulty ? difficultyLine(difficulty) : '', route ? routingLine(route) : '', summary].filter(Boolean).join('\n\n')
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
