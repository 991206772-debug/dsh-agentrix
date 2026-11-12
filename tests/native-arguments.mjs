// Installed AgentLoop/ToolRuntime/SubagentRuntime; scripted adapter reproduces the
// provider's MALFORMED_RESPONSE before a tool call is admitted. No live model calls.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply } from '../index.js'

if (!process.env.DSH_MODULE_ROOT) throw new Error('DSH_MODULE_ROOT is required')
const native = name => import(pathToFileURL(path.join(process.env.DSH_MODULE_ROOT, name, 'lib/index.js')).href)
const { Context } = await native('cordis')
const { LlmAdapter, createUserMessage, resolveRetryPolicy } = await native('dsh-llm')
const { defineTool, ToolRuntime } = await native('dsh-tools')
const { NativeToolExecutor } = await native('dsh-tool-executor-native')
const directory = await mkdtemp(path.join(os.tmpdir(), 'agentrix-arguments-'))
process.env.DSH_HOME = directory
delete process.env.DSH_DELEGATION_FIRST
const providerRetry = process.argv.includes('--provider-retry')
const persistent = process.argv.includes('--persistent') || providerRetry
const workerFailure = process.argv.includes('--worker')
const afterAccepted = process.argv.includes('--after-accepted')
const serviceError = process.argv.includes('--service-error')
const cancel = process.argv.includes('--cancel')
const ctx = new Context(), routes = new Map(), requests = [], events = [], failures = new Map(), releases = new Map()
let parent, handle, nextCall = 0, second = false, originalRequest
ctx.provide('webServer', { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } })
ctx.provide('workingDirectory', { get: () => directory, async set() {} })
for (const [module, name] of [['dsh-session-projection', 'SessionProjectionRegistry'], ['dsh-session', 'SessionStore'],
  ['dsh-agent', 'AgentRegistry'], ['dsh-system-prompt', 'SystemPrompt'], ['dsh-llm', 'LlmRuntime'],
  ['dsh-agent-loop', 'AgentLoop'], ['dsh-subagent', 'SubagentRuntime']]) ctx.plugin((await native(module))[name])
ctx.plugin(ToolRuntime)
ctx.plugin(await native('dsh-subagent-spawn-in-process'))
if (providerRetry) ctx.plugin(await native('dsh-llm-retry'))
const tick = () => new Promise(resolve => setTimeout(resolve, 10))
async function until(predicate, label) {
  for (let i = 0; i < 800; i++) { if (await predicate()) return; await tick() }
  throw new Error('Timed out: ' + label)
}
async function state() {
  let value
  await routes.get('/dsh-delegation-first/api/state')({ method: 'GET', url: '/dsh-delegation-first/api/state?sessionId=root' },
    { writeHead() {}, end(body) { value = JSON.parse(body) } })
  return value
}
const tool = (name, args = {}) => ({ type: 'tool-call', id: 'arguments-' + ++nextCall, name, arguments: JSON.stringify(args) })
const file = path.join(directory, 'result.txt')
const invalid = '{"checks":[{"arguments":{"command":"Write-Output 1","tool":"pwsh"}]}'
let syntax
try { JSON.parse(invalid) } catch (error) { syntax = error.message }
class Adapter extends LlmAdapter {
  providerRetryPolicy() { return providerRetry ? resolveRetryPolicy({ mode: 'always', backoff: { initialDelayMs: 1, maxDelayMs: 1 } }, 'isolated') : undefined }
  async *stream(request) {
    const snapshot = await state(), plan = snapshot.plans[0], task = plan?.tasks[0]
    const root = request.sessionId === 'root', previous = failures.get(request.sessionId) ?? 0
    requests.push({ id: request.sessionId, model: request.model })
    const failingPhase = root ? !workerFailure && (!afterAccepted || second) && (!plan || plan.source.messageId === originalRequest)
      : workerFailure && !events.some(event => event.id === request.sessionId && event.type === 'tool/call' && event.name === 'delegation_report')
    if (failingPhase && (persistent || previous === 0)) {
      failures.set(request.sessionId, previous + 1)
      const name = root ? 'delegation_plan' : 'delegation_report'
      yield { type: 'finish', reason: { kind: 'error', failure: { code: serviceError ? 'AUTH' : 'MALFORMED_RESPONSE',
        message: `Tool call "${name}": ${syntax}\n\nReceived arguments:\n${invalid}` } } }
      return
    }
    if (previous) {
      assert.match(JSON.stringify(request.messages), /JSON.*未执行|未执行.*JSON/, 'the same model receives repair feedback before retry')
      if (root && failingPhase) assert.ok(!plan || plan.source.messageId === originalRequest, 'malformed parameters never dispatch a task')
    }
    let block
    if (!root) block = !events.some(event => event.id === request.sessionId && event.type === 'tool/call' && event.name === 'read')
      ? tool('read', { path: file }) : tool('delegation_report', { status: 'DONE', summary: '隔离文件已核对', report: '文件包含 verified，等待主控验证验收。' })
    else if (!plan || second && plan.source.messageId === originalRequest) block = tool('delegation_plan', {
      relation: 'new', goal: '核对隔离文件', start: true, decisionReason: '执行者读取隔离文件，主控验证验收。', tasks: [{
        id: 'a', title: '检查文件', instructions: '读取指定文件后提交正式报告', scope: '隔离目录', outputs: [file], writes: [],
        complexity: 'routine', criteria: ['文件包含 verified'], checks: [{ tool: 'read', arguments: { path: file } }],
      }] })
    else if (task.status === 'running') block = tool('delegation_wait')
    else if (task.status === 'review' && !task.checks[0].result) block = tool('delegation_verify', { taskId: 'a' })
    else if (task.status === 'review') block = tool('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{
      criterionId: 'C1', finding: '实际读取结果符合要求', evidence: [task.checks[0].result.ref],
    }] })
    else throw new Error('Unexpected task status: ' + task.status)
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
    async execute(args) { assert.equal(args.path, file); return { text: await readFile(file, 'utf8') } } }))
  const start = ctx.subagents.startActivation.bind(ctx.subagents)
  ctx.subagents.startActivation = async (...args) => {
    const receipt = await start(...args), dispose = receipt.dispose.bind(receipt)
    receipt.dispose = async () => { releases.set(receipt.childId, (releases.get(receipt.childId) ?? 0) + 1); return dispose() }
    return receipt
  }
  ctx.on('session/event', (session, event) => events.push({ id: session.id, type: event.type,
    name: event.data?.name, reason: event.data?.reason }), { global: true })
  await writeFile(file, 'verified')
  apply(ctx)
  if (cancel) ctx.on('agent/request-error', async (payload, next) => { payload.agent.cancel({ kind: 'user' }); return next() }, { global: true, prepend: true })
  await until(() => routes.has('/dsh-delegation-first/api/state'), 'plugin ready')
  await state()
  await routes.get('/dsh-delegation-first/api/config')({ method: 'POST', async *[Symbol.asyncIterator]() {
    yield Buffer.from(JSON.stringify({ models: { worker: { provider: 'scripted', model: 'worker' } } }))
  } }, { writeHead(code) { assert.equal(code, 200) }, end() {} })
  handle = await ctx.agents.create({ sessionId: 'root', meta: { cwd: directory }, agentOptions: { provider: 'scripted', model: 'coordinator' } })
  parent = handle.agent
  const followup = () => parent.followup(createUserMessage({ content: [{ type: 'text', text: '核对文件并验收' }], source: { kind: 'user' } }))
  followup()
  await until(() => events.some(event => event.id === 'root' && event.type === 'turn/end') && parent.status === 'idle', 'first turn settled')
  if (afterAccepted) {
    originalRequest = (await state()).plans[0].source.messageId
    assert.equal((await state()).plans[0].completion.outcome, 'completed')
    second = true
    followup()
    await until(() => events.filter(event => event.id === 'root' && event.type === 'turn/end').length === 2 && parent.status === 'idle', 'second turn settled')
  }
  const snapshot = await state(), plan = snapshot.plans[0], last = events.filter(event => event.id === 'root' && event.type === 'turn/end').at(-1)
  if (persistent || serviceError || cancel) {
    assert.equal(last.reason.kind, cancel ? 'aborted' : 'error')
    assert.equal(requests.length, persistent ? 3 : 1, 'two correction requests maximum; service failure and cancellation never retry')
    assert.equal(plan, undefined)
    if (persistent) assert.equal(snapshot.sessions[0].argumentRecovery.used, 2)
  } else {
    assert.equal(last.reason.kind, 'completed', JSON.stringify(last.reason))
    assert.equal(plan.completion.outcome, 'completed')
    assert.equal(plan.tasks[0].attempts, 1)
    assert.equal(plan.activationBudget.used, 1)
    assert.equal(releases.size, afterAccepted ? 2 : 1)
    assert.ok([...releases.values()].every(count => count === 1))
    const recovery = workerFailure ? plan.tasks[0].argumentRecovery : snapshot.sessions[0].argumentRecovery
    assert.equal(recovery.used, 1)
    assert.equal(recovery.status, 'parsed')
    assert.equal(events.filter(event => event.id === 'root' && event.type === 'turn/end').length, afterAccepted ? 2 : 1)
  }
  console.log('PASS: native argument recovery ' + (cancel ? 'respects cancellation' : serviceError ? 'does not retry service errors'
    : persistent ? 'stops after two corrections' : workerFailure ? 'keeps the same worker through report correction'
      : afterAccepted ? 'handles a new request after an accepted plan without changing the old receipt' : 'corrects on the same coordinator before dispatch and preserves actual acceptance'))
} finally {
  await handle?.dispose()
  await ctx.fiber.dispose()
  while (ctx.fiber.inertia) await ctx.fiber.inertia
  await rm(directory, { recursive: true, force: true })
}
