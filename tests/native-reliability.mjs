// Installed AgentLoop/ToolRuntime/SubagentRuntime, real isolated files, scripted model only.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const { apply, RUNTIME_BUILD } = await import(process.env.AGENTRIX_PACKAGE_ROOT
  ? pathToFileURL(path.join(process.env.AGENTRIX_PACKAGE_ROOT, 'index.js')).href : new URL('../index.js', import.meta.url).href)

const scenario = process.argv[2] ?? 'direct'
assert.ok(['direct', 'separate-error', 'acceptance-save', 'cancel-cleanup', 'delivery-persistence'].includes(scenario))
if (!process.env.DSH_MODULE_ROOT) throw new Error('DSH_MODULE_ROOT is required')
const native = name => import(pathToFileURL(path.join(process.env.DSH_MODULE_ROOT, name, 'lib/index.js')).href)
const { Context } = await native('cordis')
const { LlmAdapter, createUserMessage } = await native('dsh-llm')
const { ToolRuntime, defineTool } = await native('dsh-tools')
const { NativeToolExecutor } = await native('dsh-tool-executor-native')
const directory = await mkdtemp(path.join(os.tmpdir(), 'agentrix-reliability-'))
process.env.DSH_HOME = directory
delete process.env.DSH_DELEGATION_FIRST
const ctx = new Context(), routes = new Map(), phases = new Map(), events = [], releases = new Map(), edits = []
const workerGate = Promise.withResolvers()
const activations = new Map()
let cleanupFixed = false
const output = path.join(directory, 'owned.txt'), independent = path.join(directory, 'independent.txt')
let parent, handle, sequence = 0, requestCount = 0, fault = false, runsFile, closing = false
ctx.provide('webServer', { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } })
ctx.provide('workingDirectory', { get: () => directory, async set() {} })
for (const [module, name] of [['dsh-session-projection', 'SessionProjectionRegistry'], ['dsh-session', 'SessionStore'],
  ['dsh-agent', 'AgentRegistry'], ['dsh-system-prompt', 'SystemPrompt'], ['dsh-llm', 'LlmRuntime'],
  ['dsh-agent-loop', 'AgentLoop'], ['dsh-subagent', 'SubagentRuntime']]) ctx.plugin((await native(module))[name])
ctx.plugin(ToolRuntime)
if (scenario === 'delivery-persistence') ctx.plugin(await native('dsh-session-persistence-jsonl'), { root: path.join(directory, 'sessions'), compression: 'none' })
ctx.plugin(await native('dsh-subagent-spawn-in-process'))
async function until(predicate, label) {
  for (let index = 0; index < 800; index++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error('Timed out: ' + label)
}
async function request(endpoint, body) {
  let value
  const route = '/dsh-delegation-first/api/' + endpoint
  await routes.get(route)({ method: body ? 'POST' : 'GET', url: route + '?sessionId=root',
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } },
  { writeHead(code) { assert.equal(code, 200) }, end(text) { value = JSON.parse(text) } })
  return value
}
const tool = (name, args = {}) => ({ type: 'tool-call', id: 'reliability-' + ++sequence, name, arguments: JSON.stringify(args) })
class Adapter extends LlmAdapter {
  async *stream(request) {
    if (closing) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
    requestCount++
    const phase = phases.get(request.sessionId) ?? 0
    phases.set(request.sessionId, phase + 1)
    assert.ok(phase < 12, 'unexpected model recovery loop')
    const state = await requestState(), plan = state.plans[0], task = plan?.tasks[0]
    let block
    if (request.sessionId !== 'root') {
      assert.equal(request.model, 'worker')
      if (phase === 0) block = tool('read', { file_path: output })
      else {
        if (scenario === 'separate-error') await workerGate.promise
        if (closing) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
        block = tool('delegation_report', { status: 'DONE', summary: '隔离产物已读取', report: 'owned.txt 含 verified，等待主控验证。' })
      }
    } else if (scenario === 'direct') {
      if (phase === 0) block = tool('edit', { file_path: independent, old_string: 'verified', new_string: 'updated' })
      else if (phase === 1) block = tool('read', { file_path: independent })
      else block = { type: 'text', text: '已修改并核对独立文件。' }
    } else if (scenario === 'cancel-cleanup' && plan?.cancelled) {
      assert.ok([...activations.values()].every(spec => spec.signal.aborted), 'all native children receive cancellation before cleanup recovery')
      if (plan.cancellation.cleanup.status === 'failed') {
        assert.ok(plan.cancellation.cleanup.remaining.length > 0)
        cleanupFixed = true
        block = tool('delegation_cancel')
      } else {
        assert.equal(plan.cancellation.cleanup.status, 'completed')
        block = { type: 'text', text: '已取消，原子任务均已确认清理。' }
      }
    } else if (scenario === 'cancel-cleanup' && state.sessions[0]?.pendingMessages?.some(message => message.text === '取消全部隔离任务')) {
      block = tool('delegation_cancel', { reason: '用户明确取消所有隔离任务',
        messageId: state.sessions[0].pendingMessages.find(message => message.text === '取消全部隔离任务').messageId })
    } else if (scenario === 'separate-error' && state.sessions[0]?.pendingMessages?.some(message => message.text === '核对另一份独立文档')) {
      block = tool('delegation_decide', { relation: 'new', mode: 'direct', reason: '另一份文档独立处理，原子任务继续。' })
    } else if (scenario === 'separate-error' && state.sessions[0]?.source?.text === '核对另一份独立文档') {
      if (!edits.length) block = tool('edit', { file_path: independent, old_string: 'verified', new_string: 'updated' })
      else {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: 'independent request failed' } } }
        return
      }
    } else if (!plan) {
      const task = {
      id: 'a', title: '核对文件', instructions: '读取 owned.txt 并提交报告', scope: directory, outputs: [output], writes: [output],
      complexity: 'routine', reviewPolicy: 'coordinator', reviewReason: '仅核对隔离文件，由主控实际验证。', criteria: ['内容包含 verified'],
      checks: [{ tool: 'read', arguments: { file_path: output } }],
      }
      block = tool('delegation_plan', { relation: 'new', start: true, goal: '核对隔离文件', decisionReason: '执行者读取独立文件，主控验证验收。',
        tasks: scenario === 'cancel-cleanup' ? [{ ...task, writes: [] }, { ...task, id: 'b', writes: [] }] : [task] })
    }
    else if (task.status === 'running') block = tool('delegation_wait')
    else if (task.status === 'review' && !task.checks[0].result) block = tool('delegation_verify', { taskId: 'a' })
    else if (task.status === 'review') {
      if (scenario === 'acceptance-save') {
        if (!fault) {
          assert.ok(path.resolve(runsFile).startsWith(path.resolve(directory) + path.sep))
          await rename(runsFile, runsFile + '.held'); await mkdir(runsFile); fault = true
        } else {
          assert.equal(task.pendingAcceptance, undefined, 'failed preparation must release the lock before the next model call')
          await rm(runsFile, { recursive: true }); await rename(runsFile + '.held', runsFile)
        }
      }
      block = tool('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterionId: 'C1', finding: '实际读取符合要求', evidence: [task.checks[0].result.ref] }] })
    } else throw new Error('Unexpected task state: ' + task.status)
    yield { type: 'block-start', index: 0, blockType: block.type }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
  }
}
const requestState = () => request('state')
try {
  await until(() => ctx.get('agentLoop') && ctx.get('subagents'), 'native services')
  ctx.tools.setExecutor(new NativeToolExecutor(ctx))
  ctx.llm.registerAdapter(['scripted'], new Adapter())
  for (const name of ['read', 'edit']) ctx.tools.register(defineTool({ name, description: 'Isolated reliability fixture',
    parameters: { file_path: { type: 'string', required: true }, ...name === 'edit' ? { old_string: { type: 'string' }, new_string: { type: 'string' } } : {} },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args, exec) {
      assert.ok([output, independent].includes(args.file_path))
      if (scenario === 'cancel-cleanup' && exec.agent.id !== 'root') await new Promise((_, reject) => {
        if (exec.signal.aborted) return reject(exec.signal.reason)
        exec.signal.addEventListener('abort', () => reject(exec.signal.reason), { once: true })
      })
      let text = await readFile(args.file_path, 'utf8')
      if (name === 'edit') { text = text.replace(args.old_string, args.new_string); await writeFile(args.file_path, text); edits.push(args.file_path) }
      return { text }
    } }))
  const start = ctx.subagents.startActivation.bind(ctx.subagents)
  const drain = ctx.subagents.drainChildren.bind(ctx.subagents)
  ctx.subagents.drainChildren = async (agent, ids) => {
    if (scenario === 'cancel-cleanup' && !cleanupFixed && ids.includes([...activations.keys()][0])) throw new Error('scripted native drain failure')
    return drain(agent, ids)
  }
  ctx.subagents.startActivation = async (...args) => {
    const receipt = await start(...args), dispose = receipt.dispose.bind(receipt)
    activations.set(receipt.childId, args[0])
    receipt.dispose = async () => {
      releases.set(receipt.childId, (releases.get(receipt.childId) ?? 0) + 1)
      if (scenario === 'cancel-cleanup' && receipt.childId === [...activations.keys()][0]) throw new Error('scripted native dispose failure')
      return dispose()
    }
    return receipt
  }
  ctx.on('session/event', (session, event) => events.push({ sessionId: session.id, ...event }), { global: true })
  await writeFile(output, 'verified'); await writeFile(independent, 'verified')
  apply(ctx)
  await until(() => routes.has('/dsh-delegation-first/api/state'), 'plugin routes')
  const config = await request('config', { models: { worker: { provider: 'scripted', model: 'worker' } } })
  runsFile = config.file.replace(/\.json$/, '.runs.json')
  handle = await ctx.agents.create({ sessionId: 'root', meta: { cwd: directory }, agentOptions: { provider: 'scripted', model: 'coordinator' } })
  parent = handle.agent
  parent.followup(createUserMessage({ content: [{ type: 'text', text: '核对隔离文件' }], source: { kind: 'user' } }))
  if (scenario === 'separate-error') {
    await until(async () => (await requestState()).plans[0]?.tasks[0].status === 'running', 'old worker started')
    parent.steer(createUserMessage({ content: [{ type: 'text', text: '核对另一份独立文档' }], source: { kind: 'user' } }))
  }
  if (scenario === 'cancel-cleanup') {
    await until(async () => (await requestState()).plans[0]?.tasks.every(task => task.status === 'running'), 'two native workers running')
    parent.steer(createUserMessage({ content: [{ type: 'text', text: '取消全部隔离任务' }], source: { kind: 'user' } }))
  }
  await until(() => events.some(event => event.sessionId === 'root' && event.type === 'turn/end') && parent.status === 'idle', 'coordinator settled')
  const result = await requestState()
  assert.equal(result.runtimeBuild, RUNTIME_BUILD)
  assert.equal(result.executionPolicyVersion, 1)
  if (scenario === 'direct') {
    assert.equal(result.plans.length, 0); assert.equal(result.sessions[0].decision, null)
    assert.equal(requestCount, 3); assert.equal(edits.length, 1)
    assert.equal(result.sessions[0].turnStats.denied, 0)
    assert.equal(await readFile(independent, 'utf8'), 'updated')
  } else if (scenario === 'separate-error') {
    assert.equal(events.filter(event => event.sessionId === 'root' && event.type === 'turn/end').at(-1).data.reason.kind, 'error')
    assert.equal(result.plans[0].tasks[0].status, 'running')
    assert.equal(result.plans[0].completion, null); assert.equal(releases.size, 0)
    assert.equal(await readFile(independent, 'utf8'), 'updated')
  } else if (scenario === 'cancel-cleanup') {
    assert.equal(cleanupFixed, true)
    assert.equal(result.plans[0].completion.outcome, 'cancelled')
    assert.equal(result.plans[0].cancellation.cleanup.status, 'completed')
    assert.equal(result.plans[0].cancellation.cleanup.failures.length, 1)
    assert.equal(activations.size, 2)
    assert.ok([...releases.values()].every(count => count === 1))
    assert.ok([...activations.keys()].every(id => !ctx.agents.get(id)), 'native child registries are empty after drain retry')
  } else if (scenario === 'delivery-persistence') {
    assert.equal(result.plans[0].completion.outcome, 'completed')
    assert.equal(await ctx.sessions.flush(parent.session), true)
    const delivery = result.plans[0].delivery
    const messages = parent.session.snapshotEvents().filter(event => event.type === 'deliverables/presented' && event.data.source?.kind === 'delegation-delivery')
    assert.equal(messages.length, 1, JSON.stringify({ delivery, events: parent.session.snapshotEvents().slice(-12).map(event => ({ type: event.type, turn: event.data?.turn, step: event.data?.step })) }))
    assert.equal(messages[0].data.messageId, delivery.messageId)
    assert.ok(messages[0].data.turn > 0)
    assert.ok(parent.session.snapshotEvents().some(event => event.type === 'tool/call' && event.data.callId === messages[0].data.callId && event.data.name === 'delegation_review'))
    const calls = requestCount
    await handle.dispose(); handle = null; await ctx.fiber.dispose()
    while (ctx.fiber.inertia) await ctx.fiber.inertia
    const resumed = new Context(), resumedRoutes = new Map()
    let resumedHandle
    try {
      resumed.provide('webServer', { register(route) { resumedRoutes.set(route.path, route.handler); return () => resumedRoutes.delete(route.path) } })
      resumed.provide('workingDirectory', { get: () => directory, async set() {} })
      for (const [module, name] of [['dsh-session-projection', 'SessionProjectionRegistry'], ['dsh-session', 'SessionStore'],
        ['dsh-agent', 'AgentRegistry'], ['dsh-system-prompt', 'SystemPrompt'], ['dsh-llm', 'LlmRuntime'], ['dsh-agent-loop', 'AgentLoop']]) resumed.plugin((await native(module))[name])
      resumed.plugin(ToolRuntime)
      resumed.plugin(await native('dsh-session-persistence-jsonl'), { root: path.join(directory, 'sessions'), compression: 'none' })
      await until(() => resumed.get('agentLoop') && resumed.get('sessionPersistence'), 'resumed persistence ready')
      resumed.tools.setExecutor(new NativeToolExecutor(resumed))
      resumed.llm.registerAdapter(['scripted'], new Adapter())
      // Reopen the same plugin state and session directory. Force replay of a pending marker
      // to test native journal deduplication, without requesting another model response.
      const stored = JSON.parse(await readFile(runsFile, 'utf8'))
      stored.plans[0].delivery.status = 'pending'
      await writeFile(runsFile, JSON.stringify(stored))
      apply(resumed)
      await until(() => resumedRoutes.has('/dsh-delegation-first/api/state'), 'resumed plugin ready')
      resumedHandle = await resumed.agents.resume({ resumeSessionId: 'root', agentOptions: { provider: 'scripted', model: 'coordinator' } })
      const session = resumedHandle.agent.session
      assert.equal(session.snapshotEvents().filter(event => event.data?.messageId === delivery.messageId).length, 1)
      await resumed.serial('agent/turn-stopping', { agent: resumedHandle.agent, turn: messages[0].data.turn, signal: new AbortController().signal })
      assert.equal(await resumed.sessions.flush(session), true)
      assert.equal(session.snapshotEvents().filter(event => event.data?.messageId === delivery.messageId).length, 1)
      assert.equal(JSON.parse(await readFile(runsFile, 'utf8')).plans[0].delivery.status, 'delivered')
      assert.equal(requestCount, calls)
      console.log('PASS: native JSONL flush and same-directory resume retain one delivery without another model request')
    } finally {
      await resumedHandle?.dispose(); await resumed.fiber.dispose()
      while (resumed.fiber.inertia) await resumed.fiber.inertia
    }
  } else {
    assert.equal(fault, true); assert.equal(result.plans[0].completion.outcome, 'completed')
    assert.equal(result.plans[0].tasks[0].attempts, 1)
    assert.ok([...releases.values()].every(count => count === 1))
    assert.equal(events.filter(event => event.sessionId === 'root' && event.type === 'tool/call' && event.data.name === 'delegation_review').length, 2)
  }
  console.log('PASS: installed native reliability ' + scenario + '; requests=' + requestCount)
} finally {
  closing = true; workerGate.resolve()
  await handle?.dispose(); await ctx.fiber.dispose()
  while (ctx.fiber.inertia) await ctx.fiber.inertia
  await rm(directory, { recursive: true, force: true })
}
