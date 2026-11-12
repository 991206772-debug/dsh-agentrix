// Installed AgentLoop, ToolRuntime, SubagentRuntime and filesystem; no provider requests.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply } from '../index.js'

const scenario = process.argv[2] ?? 'long-output'
assert.ok(['efficient-dispatch', 'long-output', 'stale-evidence', 'concerns', 'queue-parallel', 'queue-write', 'queue-stop', 'queue-cancel'].includes(scenario))
if (!process.env.DSH_MODULE_ROOT) throw new Error('DSH_MODULE_ROOT is required')
const native = name => import(pathToFileURL(path.join(process.env.DSH_MODULE_ROOT, name, 'lib/index.js')).href)
const { Context } = await native('cordis')
const { SessionStore } = await native('dsh-session')
const { SessionProjectionRegistry } = await native('dsh-session-projection')
const { AgentRegistry } = await native('dsh-agent')
const { AgentLoop } = await native('dsh-agent-loop')
const { SystemPrompt } = await native('dsh-system-prompt')
const { ToolRuntime } = await native('dsh-tools')
const { NativeToolExecutor } = await native('dsh-tool-executor-native')
const { LlmRuntime, LlmAdapter, createUserMessage } = await native('dsh-llm')
const { SubagentRuntime } = await native('dsh-subagent')
const Spawn = await native('dsh-subagent-spawn-in-process')
const { default: LocalFileSystem } = await native('dsh-fs-local')
const { default: WorkingDirectory } = await native('dsh-working-directory')
const FsTools = await native('dsh-tool-fs')
const directory = await mkdtemp(path.join(os.tmpdir(), 'agentrix-native-boundaries-'))
process.env.DSH_HOME = directory
delete process.env.DSH_DELEGATION_FIRST
const ctx = new Context(), routes = new Map(), requests = [], results = [], events = [], handles = [], releases = new Map()
const phases = new Map(), observed = {}, gate = Promise.withResolvers()
const queue = scenario.startsWith('queue-'), parents = new Set(['root', ...(queue ? ['holder'] : [])])
const efficient = scenario === 'efficient-dispatch'
const target = path.join(directory, 'result.txt'), tail = 'TAIL: pending real database verification', concern = 'Database behavior remains unverified'
const text = 'verified fixture content\n'.repeat(scenario === 'long-output' ? 400 : 1) + (scenario === 'long-output' ? tail : '')
await writeFile(target, text)
const batchTargets = [target, ...efficient ? [path.join(directory, 'second.txt'), path.join(directory, 'third.txt')] : []]
for (const file of batchTargets.slice(1)) await writeFile(file, 'independently checked: ' + path.basename(file))
ctx.provide('webServer', { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } })
for (const service of [SessionProjectionRegistry, SessionStore, AgentRegistry, SystemPrompt, LlmRuntime, ToolRuntime, AgentLoop, SubagentRuntime, Spawn]) ctx.plugin(service)
ctx.plugin(LocalFileSystem, { cwd: directory })
ctx.plugin(WorkingDirectory, { defaultDirectory: directory })
ctx.plugin(FsTools, { readImage: false })
const tick = () => new Promise(resolve => setTimeout(resolve, 10))
async function until(predicate, label) {
  for (let i = 0; i < 1000; i++) { if (await predicate()) return; await tick() }
  throw new Error('Timed out: ' + label)
}
async function state() {
  let value
  await routes.get('/dsh-delegation-first/api/state')({ method: 'GET' }, { writeHead() {}, end(body) { value = JSON.parse(body) } })
  return value
}
const planOf = (value, id = 'root') => value.plans.find(plan => plan.sessionId === id)
const lastResult = name => results.filter(item => item.agentId === 'root' && item.name === name).at(-1)
let call = 0, waiting = false
const tool = (name, args) => ({ type: 'tool-call', id: 'boundary-' + ++call, name, arguments: JSON.stringify(args) })
class ScriptedAdapter extends LlmAdapter {
  async *stream(request) {
    const phase = phases.get(request.sessionId) ?? 0
    phases.set(request.sessionId, phase + 1)
    assert.ok(phase < 20, 'unexpected model polling loop')
    requests.push({ id: request.sessionId, model: request.model, phase })
    const snapshot = await state(), plan = planOf(snapshot, request.sessionId), task = plan?.tasks[0]
    let block
    if (parents.has(request.sessionId)) {
      if (!plan) block = tool('delegation_plan', { goal: '隔离回归：' + scenario, decisionReason: '执行者读取隔离文件，主控实际验证验收。', ...(efficient ? { start: true } : {}), tasks: [{
        id: 'a', title: '检查隔离产物', instructions: '读取 result.txt 并提交正式报告', scope: directory, outputs: [target],
        writes: scenario === 'queue-write' ? [target] : [], complexity: 'routine', criteria: ['文件内容符合本次要求'],
        checks: batchTargets.map(file => ({ tool: 'read', arguments: { file_path: file } })),
      }] })
      else if (phase === 1 && !efficient) block = tool('delegation_run', {})
      else if (queue && request.sessionId === 'root' && phase === 2 && scenario === 'queue-stop') block = { type: 'text', text: '等待现有任务释放并发名额。' }
      else if (task.status !== 'review') block = tool('delegation_wait', {})
      else if (!task.checks.every(check => check.result)) block = tool('delegation_verify', { taskId: 'a', ...(efficient ? {} : { checkIndex: 0 }) })
      else if (scenario === 'long-output' && !observed.readFull) {
        const result = lastResult('delegation_verify')
        assert.match(JSON.stringify(result.content), /truncated/)
        assert.ok(!JSON.stringify(request.messages).includes(tail), 'the initial response is a bounded preview')
        assert.equal(await readFile(task.checks[0].result.outputPath, 'utf8'), observed.originalRead)
        observed.readFull = true
        block = tool('delegation_status', { taskId: 'a', detail: 'full', checkIndex: 0, offset: task.checks[0].result.outputCharacters - 100, limit: 100 })
      }
      else if (scenario === 'stale-evidence' && !observed.reverified) {
        observed.old = task.checks[0].result; observed.reverified = true
        await writeFile(target, 'the file changed after the previous verification')
        block = tool('delegation_verify', { taskId: 'a', checkIndex: 0 })
      }
      else if (scenario === 'stale-evidence' && !observed.oldShort) {
        observed.oldShort = true
        block = tool('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterionId: 'C1', finding: '旧短证据不能验收', evidence: [observed.old.ref] }] })
      }
      else if (scenario === 'stale-evidence' && !observed.oldRaw) {
        assert.equal(lastResult('delegation_review').isError, true)
        observed.oldRaw = true
        block = tool('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterion: 0, finding: '旧原始编号也不能验收', evidence: [observed.old.callId] }] })
      }
      else {
        if (scenario === 'long-output') assert.ok(JSON.stringify(request.messages).includes(tail), 'the same coordinator can inspect the saved tail')
        if (scenario === 'stale-evidence') assert.equal(lastResult('delegation_review').isError, true)
        if (scenario === 'concerns') {
          assert.ok(JSON.stringify(request.messages).includes(concern), 'the coordinator receives concerns without an extra full-status call')
          assert.ok(JSON.stringify(request.messages).includes('DONE_WITH_CONCERNS'))
          assert.match(JSON.stringify(lastResult('delegation_verify').content), /concernsResolution/)
        }
        block = tool('delegation_review', { taskId: 'a', verdict: 'accept',
          ...(scenario === 'concerns' ? { concernsResolution: '本次验收静态文件，真实数据库验证仍为明确限制。' } : {}),
          findings: [{ criterionId: 'C1', finding: '已读取实际产物及验证结果', evidence: task.checks.map(check => check.result.ref) }] })
      }
    } else {
      const owner = snapshot.plans.find(plan => plan.tasks.some(task => task.childId === request.sessionId))
      if (queue && owner?.sessionId === 'holder' && phase === 0) await gate.promise
      block = phase === 0 ? tool('read', { file_path: target }) : tool('delegation_report', {
        status: scenario === 'concerns' ? 'DONE_WITH_CONCERNS' : 'DONE', summary: '隔离文件已读取', report: '已核对 result.txt，等待主控验证。',
        ...(scenario === 'concerns' ? { concerns: [concern] } : {}),
      })
    }
    yield { type: 'block-start', index: 0, blockType: block.type }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } }
    yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
  }
}
try {
  await until(() => ctx.get('subagents') && ctx.get('workingDirectory') && ctx.tools?.get('read'), 'native services')
  ctx.tools.setExecutor(new NativeToolExecutor(ctx))
  ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter())
  const resolve = ctx.fs.resolve.bind(ctx.fs)
  ctx.fs.resolve = async (name, options) => {
    const target = await resolve(name, options), absolute = ctx.fs.processPath(target)
    assert.ok(absolute === directory || absolute.startsWith(directory + path.sep), 'test must stay in its temporary directory')
    return target
  }
  const start = ctx.subagents.startActivation.bind(ctx.subagents)
  ctx.subagents.startActivation = async (...args) => {
    const activation = await start(...args), dispose = activation.dispose.bind(activation)
    activation.dispose = async () => { releases.set(activation.childId, (releases.get(activation.childId) ?? 0) + 1); return dispose() }
    return activation
  }
  ctx.on('tools/result', (exec, result) => {
    results.push({ agentId: exec.agent?.id, name: exec.name, isError: Boolean(result.isError), content: result.content })
    if (scenario === 'long-output' && exec.name === 'read' && exec.agent?.id === 'root') observed.originalRead = result.content.map(block => block.text ?? '').join('\n')
  }, { global: true })
  ctx.on('agent/turn-stopping', ({ agent }) => { if (agent.id === 'root') waiting = true }, { global: true })
  ctx.on('session/event', (session, event) => {
    events.push({ id: session.id, type: event.type })
    if (session.id === 'root' && event.type === 'tool/call' && event.data.name === 'delegation_wait') waiting = true
  }, { global: true })
  apply(ctx)
  await until(() => routes.has('/dsh-delegation-first/api/state'), 'plugin routes')
  await state()
  await routes.get('/dsh-delegation-first/api/config')({ method: 'POST', async *[Symbol.asyncIterator]() {
    yield Buffer.from(JSON.stringify({ maxParallel: scenario === 'queue-write' ? 4 : 1, models: { worker: { provider: 'scripted', model: 'low-worker' } } }))
  } }, { writeHead(code) { assert.equal(code, 200) }, end() {} })
  async function create(id) {
    const handle = await ctx.agents.create({ sessionId: id, meta: { cwd: directory }, agentOptions: { provider: 'scripted', model: 'coordinator' } })
    handles.push(handle)
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '执行隔离回归 ' + scenario }], source: { kind: 'user' } }))
    return handle
  }
  if (queue) {
    await create('holder')
    await until(async () => planOf(await state(), 'holder')?.tasks[0].status === 'running', 'holder occupies the slot or write range')
  }
  const rootHandle = await create('root')
  if (queue) {
    await until(() => waiting, 'coordinator suspends')
    await new Promise(resolve => setTimeout(resolve, 100))
    const queued = planOf(await state())
    assert.equal(queued.tasks[0].status, 'queued')
    assert.equal(queued.completion, null)
    assert.equal(queued.recovery.used, 0)
    assert.equal(requests.filter(item => item.id === 'root').length, 3, 'waiting causes no extra model requests')
    assert.ok(!events.some(event => event.id === 'root' && event.type === 'turn/end'))
    if (scenario === 'queue-cancel') {
      rootHandle.agent.cancel({ kind: 'user' })
      await until(async () => planOf(await state())?.completion?.outcome === 'cancelled', 'queued user cancellation')
    }
    gate.resolve()
    await until(async () => planOf(await state(), 'holder')?.completion?.outcome === 'completed', 'holder acceptance releases the lock')
  }
  await until(async () => Boolean(planOf(await state())?.completion), 'formal receipt')
  const plan = planOf(await state())
  assert.equal((await state()).coordinationPolicyVersion, 5)
  assert.equal(plan.completion.outcome, scenario === 'queue-cancel' ? 'cancelled' : 'completed')
  assert.equal(plan.recovery.used, 0)
  assert.equal(plan.activationBudget.used, scenario === 'queue-cancel' ? 0 : 1)
  if (scenario !== 'queue-cancel') {
    assert.equal(releases.get(plan.tasks[0].childId), 1)
    assert.equal(plan.tasks[0].release.status, 'released')
    assert.equal(plan.tasks[0].modelRoute.actual.model, 'low-worker')
    assert.equal(plan.tasks[0].review.findings[0].evidence[0], plan.tasks[0].checks[0].result.callId)
  }
  if (scenario === 'stale-evidence') assert.ok(plan.tasks[0].evidence.some(item => item.callId === observed.old.callId), 'obsolete evidence is retained only as history')
  if (efficient) {
    assert.equal(requests.filter(item => item.id === 'root').length, 4, 'one combined dispatch, wait, batch verification and acceptance')
    assert.equal(requests.length, 6, 'the worker retains its two real AgentLoop steps')
    assert.equal(results.filter(item => item.agentId === 'root' && item.name === 'delegation_verify').length, 1)
    assert.equal(results.filter(item => item.agentId === 'root' && item.name === 'read').length, 3)
    assert.equal(new Set(plan.tasks[0].checks.map(check => check.result.ref)).size, 3)
  }
  console.log('PASS: installed native boundary ' + scenario + ' ' + JSON.stringify({ requests: requests.length, releases: [...releases.values()] }))
} finally {
  gate.resolve()
  for (const handle of handles.reverse()) await handle.dispose()
  await ctx.fiber.dispose()
  while (ctx.fiber.inertia) await ctx.fiber.inertia
  await rm(directory, { recursive: true, force: true })
}
