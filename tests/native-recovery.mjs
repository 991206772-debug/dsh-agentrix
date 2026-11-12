// Installed AgentLoop, ToolRuntime and SubagentRuntime; isolated scripted adapter.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply } from '../index.js'

if (!process.env.DSH_MODULE_ROOT) throw new Error('DSH_MODULE_ROOT is required')
const native = name => import(pathToFileURL(path.join(process.env.DSH_MODULE_ROOT, name, 'lib/index.js')).href)
const { Context } = await native('cordis')
const { LlmAdapter, createUserMessage } = await native('dsh-llm')
const { defineTool, ToolRuntime } = await native('dsh-tools')
const { NativeToolExecutor } = await native('dsh-tool-executor-native')
const directory = await mkdtemp(path.join(os.tmpdir(), 'agentrix-native-recovery-'))
process.env.DSH_HOME = directory
delete process.env.DSH_DELEGATION_FIRST
const ctx = new Context(), routes = new Map(), releases = new Map(), events = []
const gate = Promise.withResolvers(), phases = new Map()
let parent, handle, stopped = false, waiting = false, calls = 0
ctx.provide('webServer', { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } })
ctx.provide('workingDirectory', { get: () => directory, async set() {} })
for (const [module, name] of [['dsh-session-projection', 'SessionProjectionRegistry'], ['dsh-session', 'SessionStore'],
  ['dsh-agent', 'AgentRegistry'], ['dsh-system-prompt', 'SystemPrompt'], ['dsh-llm', 'LlmRuntime'],
  ['dsh-agent-loop', 'AgentLoop'], ['dsh-subagent', 'SubagentRuntime']]) ctx.plugin((await native(module))[name])
ctx.plugin(ToolRuntime)
ctx.plugin(await native('dsh-subagent-spawn-in-process'))
const tick = () => new Promise(resolve => setTimeout(resolve, 10))
async function until(test, label) {
  for (let i = 0; i < 1000; i++) { if (await test()) return; await tick() }
  throw new Error('Timed out: ' + label)
}
async function state() {
  let value
  await routes.get('/dsh-delegation-first/api/state')({ method: 'GET', url: '/dsh-delegation-first/api/state?sessionId=root' },
    { writeHead() {}, end(body) { value = JSON.parse(body) } })
  return value
}
const tool = (name, args = {}) => ({ type: 'tool-call', id: 'recovery-' + ++calls, name, arguments: JSON.stringify(args) })
const file = path.join(directory, 'result.txt')
class Adapter extends LlmAdapter {
  async *stream(request) {
    const phase = phases.get(request.sessionId) ?? 0
    phases.set(request.sessionId, phase + 1)
    let block
    if (request.sessionId !== parent.id) block = phase === 0 ? tool('read', { path: file })
      : tool('delegation_report', { status: 'DONE', summary: '保留原需求完成检查', report: '已核对隔离文件包含 verified，等待主控验证。' })
    else {
      const snapshot = await state(), plan = snapshot.plans[0], task = plan?.tasks[0]
      if (!plan) block = tool('delegation_plan', { goal: '中断后继续同一计划', start: true, decisionReason: '执行者检查文件，主控读取真实结果后验收。', tasks: [{
        id: 'a', title: '检查隔离文件', instructions: '读取隔离文件后正式报告', scope: '隔离目录', outputs: [file], writes: [],
        complexity: 'routine', criteria: ['文件包含 verified'], checks: [{ tool: 'read', arguments: { path: file } }],
      }] })
      else if (plan.interruption && !plan.interruption.resumedAt) block = tool('delegation_decide', {
        relation: 'continue', messageId: snapshot.sessions[0].pendingMessages[0].messageId,
      })
      else if (task.status === 'running') block = tool('delegation_wait')
      else if (task.status === 'review' && !task.checks[0].result) block = tool('delegation_verify', { taskId: 'a' })
      else if (task.status === 'review') block = tool('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{
        criterionId: 'C1', finding: '原计划中的文件已实际核对', evidence: [task.checks[0].result.ref],
      }] })
      else throw new Error('Unexpected task state: ' + task.status)
    }
    yield { type: 'block-start', index: 0, blockType: block.type }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
try {
  await until(() => ctx.get('agentLoop') && ctx.get('subagents'), 'native services')
  ctx.tools.setExecutor(new NativeToolExecutor(ctx))
  ctx.llm.registerAdapter(['scripted'], new Adapter())
  ctx.tools.register(defineTool({ name: 'read', description: 'Read isolated file', parameters: { path: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args, exec) {
      assert.equal(args.path, file)
      if (exec.agent.id !== 'root' && !stopped) await Promise.race([gate.promise, new Promise((_, reject) => {
        exec.signal.addEventListener('abort', () => reject(exec.signal.reason), { once: true })
      })])
      return { text: await readFile(file, 'utf8') }
    } }))
  const start = ctx.subagents.startActivation.bind(ctx.subagents)
  ctx.subagents.startActivation = async (...args) => {
    const receipt = await start(...args), dispose = receipt.dispose.bind(receipt)
    receipt.dispose = async () => { releases.set(receipt.childId, (releases.get(receipt.childId) ?? 0) + 1); return dispose() }
    return receipt
  }
  ctx.on('session/event', (session, event) => {
    events.push({ id: session.id, type: event.type })
    if (session.id === 'root' && event.type === 'tool/call' && event.data.name === 'delegation_wait') waiting = true
  }, { global: true })
  await writeFile(file, 'verified')
  apply(ctx)
  await until(() => routes.has('/dsh-delegation-first/api/state'), 'plugin ready')
  await state()
  await routes.get('/dsh-delegation-first/api/config')({ method: 'POST', async *[Symbol.asyncIterator]() {
    yield Buffer.from(JSON.stringify({ models: { worker: { provider: 'scripted', model: 'worker' } } }))
  } }, { writeHead(code) { assert.equal(code, 200) }, end() {} })
  handle = await ctx.agents.create({ sessionId: 'root', meta: { cwd: directory }, agentOptions: { provider: 'scripted', model: 'coordinator' } })
  parent = handle.agent
  parent.followup(createUserMessage({ content: [{ type: 'text', text: '执行隔离任务并验收' }], source: { kind: 'user' } }))
  await until(() => waiting, 'parent event wait')
  const before = (await state()).plans[0], oldChild = before.tasks[0].childId
  parent.cancel({ kind: 'user' })
  await until(async () => parent.status === 'idle' && (await state()).plans[0].tasks[0].release?.status === 'released', 'host interruption cleanup')
  const paused = (await state()).plans[0]
  assert.equal(paused.cancelled, false)
  assert.equal(paused.tasks[0].status, 'blocked')
  assert.equal(paused.completion.outcome, 'blocked')
  assert.equal(releases.get(oldChild), 1)
  stopped = true; gate.resolve()
  parent.followup(createUserMessage({ content: [{ type: 'text', text: '继续原任务' }], source: { kind: 'user' } }))
  await until(async () => (await state()).plans[0].completion?.outcome === 'completed', 'resumed acceptance')
  const result = (await state()).plans[0]
  assert.equal(result.archive.id, before.archive.id)
  assert.equal(result.source.messageId, before.source.messageId)
  assert.equal(result.tasks[0].attempts, 2)
  assert.equal(result.activationBudget.used, 2)
  assert.equal(result.tasks[0].status, 'accepted')
  assert.equal(result.tasks[0].modelRoute.actual.model, 'worker')
  assert.equal(releases.size, 2)
  assert.ok([...releases.values()].every(count => count === 1))
  assert.ok(events.filter(event => event.id === 'root' && event.type === 'turn/end').length >= 1)
  console.log('PASS: native host interruption releases once; real continue resumes the same request and plan, verifies and accepts without creating a new demand')
} finally {
  gate.resolve()
  await handle?.dispose()
  await ctx.fiber.dispose()
  while (ctx.fiber.inertia) await ctx.fiber.inertia
  await rm(directory, { recursive: true, force: true })
}
