// Real installed AgentLoop, ToolRuntime and SubagentRuntime; scripted local adapter only.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply } from '../index.js'

const moduleRoot = process.env.DSH_MODULE_ROOT
if (!moduleRoot) throw new Error('DSH_MODULE_ROOT is required')
const native = async name => import(pathToFileURL(path.join(moduleRoot, name, 'lib/index.js')).href)
const { Context } = await native('cordis')
const { SessionStore } = await native('dsh-session')
const { SessionProjectionRegistry } = await native('dsh-session-projection')
const { AgentRegistry } = await native('dsh-agent')
const { AgentLoop } = await native('dsh-agent-loop')
const { SystemPrompt } = await native('dsh-system-prompt')
const { ToolRuntime, defineTool } = await native('dsh-tools')
const { NativeToolExecutor } = await native('dsh-tool-executor-native')
const { LlmRuntime, LlmAdapter, LlmError, createUserMessage } = await native('dsh-llm')
const { SubagentRuntime } = await native('dsh-subagent')
const Spawn = await native('dsh-subagent-spawn-in-process')
const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-completion-native-'))
const truncateOutput = process.argv.includes('--truncate-output')
const continuous = process.argv.includes('--continuous')
const benchmark = process.argv.includes('--benchmark')
const baseline = process.argv.includes('--benchmark-baseline')
const supplement = process.argv.includes('--supplement') || process.argv.includes('--supplement-cancel')
const cancelSupplement = process.argv.includes('--supplement-cancel')
const nativeDefault = process.argv.includes('--native-default')
const switchCoordinator = process.argv.includes('--switch-coordinator')
const coordinatorQuota = process.argv.includes('--coordinator-quota')
const nextRequest = process.argv.includes('--next-request')
let followingRequest = false
const workerGate = Promise.withResolvers()
let parentWaiting = false
const supplementText = '交付操作员不懂技术，需要页面操作引导。'
const workerReport = '读取 result.txt 可验证 verified，等待主控实际验收。' + (benchmark ? '\n证据：result.txt 包含 verified。'.repeat(500) : '')
process.env.DSH_HOME = directory
delete process.env.DSH_DELEGATION_FIRST
const ctx = new Context(), routes = new Map(), requests = [], events = [], phases = new Map()
ctx.provide('webServer', { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } })
ctx.provide('workingDirectory', { get: () => directory, async set() {} })
ctx.plugin(SessionProjectionRegistry)
ctx.plugin(SessionStore)
ctx.plugin(AgentRegistry)
ctx.plugin(SystemPrompt)
ctx.plugin(LlmRuntime)
ctx.plugin(ToolRuntime)
ctx.plugin(AgentLoop)
ctx.plugin(SubagentRuntime)
ctx.plugin(Spawn)
const tick = () => new Promise(resolve => setTimeout(resolve, 10))
async function until(predicate, label) {
  for (let i = 0; i < 500; i++) { if (await predicate()) return; await tick() }
  throw new Error('Timed out: ' + label)
}
let parent, handle, nextCall = 0
class ScriptedAdapter extends LlmAdapter {
  async resolveModel(provider, model, signal) {
    const info = await super.resolveModel(provider, model, signal)
    return (nativeDefault || switchCoordinator) && ['coordinator', 'changed-coordinator'].includes(model) ? { ...info,
      reasoning: { efforts: [{ id: 'max', name: 'Max' }, { id: 'high', name: 'High' }, { id: 'low', name: 'Low' }], defaultEffort: nativeDefault ? 'max' : 'high' } } : info
  }
  async *stream(request) {
    const role = request.sessionId === parent?.id ? 'coordinator' : request.model === 'low-worker' ? 'worker' : 'reviewer'
    requests.push({ sessionId: request.sessionId, role, model: request.model, reasoningEffort: request.reasoningEffort, inputCharacters: JSON.stringify(request.messages ?? []).length })
    const phase = phases.get(request.sessionId) ?? 0
    phases.set(request.sessionId, phase + 1)
    let block
    if (request.sessionId === parent?.id) {
      if (followingRequest) {
        const system = JSON.stringify(request.messages.filter(message => message.role === 'system'))
        assert.ok(system.includes('DSH Agentrix'), 'the native coordinator discipline is present')
        assert.ok(!system.includes('当前计划：高模型规划、低模型执行、高模型审查与验收'), 'the previous plan must not be injected into the new request')
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '已核对第二项需求，无需委派。' } }
        yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 5 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const plan = (await state())?.plans?.[0], task = plan?.tasks?.[0]
      if (!task) block = tool('delegation_plan', { goal: '高模型规划、低模型执行、高模型审查与验收', tasks: [{ id: 'a', title: '检查隔离产物', instructions: '只读取隔离文件并正式报告', scope: '隔离目录', outputs: [path.join(directory, 'result.txt')], writes: [], complexity: 'complex', criteria: ['文件包含 verified'], checks: [{ tool: 'read', arguments: { path: path.join(directory, 'result.txt') } }] }] })
      else if (phase === 1) block = tool('delegation_run', {})
      else if (supplement && plan.inputs?.some(input => ['queued', 'received'].includes(input.status))) block = tool('delegation_control', {
        taskId: 'a', action: 'steer', message: '将交付人员的操作引导纳入任务', inputIds: plan.inputs.filter(input => ['queued', 'received'].includes(input.status)).map(input => input.id),
        additionalCriteria: ['提供面向交付操作员的页面引导'],
      })
      else if (phase === 2 || truncateOutput && phase < 5) block = { type: 'text', text: '保留当前输出，继续原计划。' }
      else if (coordinatorQuota) throw new LlmError('429: exceed quota limit', 'QUOTA')
      else if (task.status === 'review' && !task.checks[0].result) block = tool('delegation_verify', { taskId: 'a', checkIndex: 0 })
      else if (task.status === 'review') block = tool('delegation_review', { taskId: 'a', verdict: 'accept', findings: task.criteria.map((_criterion, criterion) => ({ criterion, finding: '已读取隔离文件并核对要求', evidence: [task.checks[0].result.callId] })) })
      else if ((truncateOutput || supplement) && task.status === 'running') block = { type: 'text', text: '等待原子代理报告和独立审查返回。' }
      else throw new Error('Unexpected coordinator request after terminal tool: ' + task.status)
    } else if ((supplement || switchCoordinator) && request.model === 'low-worker' && phase === 0) block = tool('read', { path: path.join(directory, 'result.txt') })
    else if (supplement && request.model === 'low-worker') {
      assert.ok(JSON.stringify(request.messages).includes(supplementText), 'the original native worker must receive the human supplement')
      block = tool('delegation_report', { status: 'DONE', summary: '已核对补充要求', report: workerReport })
    } else if (continuous && request.model === 'low-worker' && phase < 85) block = tool('read', { path: path.join(directory, 'result.txt') })
    else if (continuous && request.model === 'low-worker') block = tool('delegation_report', { status: 'DONE', summary: '隔离产物已检查', report: workerReport })
    else if (truncateOutput && phase < 3) block = { type: 'text', text: '本段输出被模型截断，继续检查已有产物。' }
    else if (role === 'reviewer' && phase === (truncateOutput ? 3 : 0)) block = tool('delegation_report', { status: 'DONE', summary: '需求与质量均通过', report: '已核对隔离产物与任务要求，等待主控实际验证。', specVerdict: 'pass', qualityVerdict: 'pass', issues: [] })
    else if (request.model === 'low-worker' && phase === 0) block = { type: 'text', text: '工作已完成，但这次故意漏交正式报告。' }
    else if (phase === (truncateOutput ? 3 : 1)) block = tool('delegation_report', { status: 'DONE', summary: '隔离产物已检查', report: workerReport })
    else throw new Error('Unexpected child request after report')
    yield { type: 'block-start', index: 0, blockType: block.type }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 200, outputTokens: 10 } }
    const truncated = truncateOutput && (request.sessionId === parent?.id ? phase >= 2 && phase < 5 : phase < 3)
    yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : truncated ? 'max-tokens' : 'stop' } }
  }
}
function tool(name, args) { return { type: 'tool-call', id: 'scripted-' + ++nextCall, name, arguments: JSON.stringify(args) } }
async function state() {
  let body
  await routes.get('/dsh-delegation-first/api/state')({ method: 'GET', url: '/dsh-delegation-first/api/state?sessionId=root' }, { writeHead() {}, end(value) { body = JSON.parse(value) } })
  return body
}
try {
  await until(() => ctx.get('agentLoop') && ctx.get('subagents'), 'native services')
  ctx.tools.setExecutor(new NativeToolExecutor(ctx))
  ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter())
  ctx.tools.register(defineTool({ name: 'read', description: 'Read isolated fixture', parameters: { path: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args, exec) {
      assert.equal(args.path, path.join(directory, 'result.txt'))
      if ((supplement || switchCoordinator) && exec.agent.id !== 'root' && requests.some(request => request.sessionId === exec.agent.id && request.model === 'low-worker')) await workerGate.promise
      return { text: await readFile(args.path, 'utf8') }
    } }))
  await writeFile(path.join(directory, 'result.txt'), 'verified')
  ctx.on('agent/turn-stopping', ({ agent }) => { if (agent.id === 'root') parentWaiting = true }, { global: true })
  apply(ctx)
  await until(() => routes.has('/dsh-delegation-first/api/state'), 'plugin routes')
  await state()
  let configStatus
  await routes.get('/dsh-delegation-first/api/config')({ method: 'POST', async *[Symbol.asyncIterator]() {
    yield Buffer.from(JSON.stringify({ models: { worker: { provider: 'scripted', model: 'low-worker' }, reviewer: { provider: 'scripted', model: 'high-reviewer' } } }))
  } }, { writeHead(status) { configStatus = status }, end() {} })
  assert.equal(configStatus, 200)
  ctx.on('session/event', (session, event) => events.push({ id: session.id, type: event.type, reason: event.data?.reason,
    ...(event.type === 'request/header' ? { header: event.data.header } : {}) }), { global: true })
  handle = await ctx.agents.create({ sessionId: 'root', meta: { cwd: directory }, agentOptions: { provider: 'scripted', model: 'coordinator' } })
  parent = handle.agent
  parent.followup(createUserMessage({ content: [{ type: 'text', text: '执行隔离任务并验证' }], source: { kind: 'user' } }))
  if (switchCoordinator) {
    await until(() => parentWaiting, 'coordinator awaiting original worker')
    const dispatched = (await state()).plans[0].tasks[0]
    assert.equal(dispatched.dispatcherModel.model, 'coordinator')
    assert.equal(dispatched.dispatcherModel.reasoningEffort, 'high')
    parent.model.select({ provider: 'scripted', model: 'changed-coordinator', reasoningEffort: 'low' })
    workerGate.resolve()
  }
  if (supplement) {
    await until(() => parentWaiting, 'coordinator waiting hook')
    await tick()
    assert.equal((await state()).plans[0].tasks[0].status, 'running')
    parent.steer(createUserMessage({ content: [{ type: 'text', text: supplementText }], source: { kind: 'user' } }))
    if (cancelSupplement) parent.cancel({ kind: 'user' })
    else {
      await until(async () => (await state()).plans[0].inputs?.[0]?.status === 'forwarded', 'original coordinator forwarding supplement')
      const changed = (await state()).plans[0]
      assert.equal(changed.inputs.length, 1)
      assert.equal(changed.recovery.used, 0, 'human input must not consume completion-recovery allowance')
      assert.equal(changed.activationBudget.used, 1, 'the original worker is reused')
    }
    workerGate.resolve()
  }
  await until(() => events.some(event => event.id === 'root' && event.type === 'turn/end'), 'coordinator completion')
  const plan = (await state()).plans[0]
  if (cancelSupplement) {
    await until(() => parent.status === 'idle', 'cancelled coordinator cleanup')
    assert.equal(plan.cancelled, true)
    assert.equal(plan.completion.outcome, 'cancelled')
    assert.equal(plan.tasks[0].release.status, 'released')
    assert.equal(plan.activationBudget.used, 1)
    assert.equal(new Set(requests.filter(request => request.sessionId !== 'root').map(request => request.sessionId)).size, 1)
    console.log('PASS: real native user cancellation wins queued supplement, releases the original child once and does not reopen work')
  } else if (coordinatorQuota) {
    assert.equal(plan.coordinatorIssue.code, 'MODEL_SERVICE_QUOTA')
    assert.equal(plan.coordinatorIssue.model, 'coordinator')
    assert.equal(plan.completion.outcome, 'blocked')
    assert.equal(plan.tasks[0].status, 'review')
    assert.equal(plan.tasks[0].execution.commitState, 'committed')
    assert.equal(plan.tasks[0].audit.status, 'completed')
    assert.match(await readFile(plan.tasks[0].execution.reportPath, 'utf8'), /verified/)
    assert.equal(plan.activationBudget.used, 2)
    assert.equal(new Set(requests.filter(request => request.sessionId !== 'root').map(request => request.sessionId)).size, 2)
    console.log('PASS: native coordinator QUOTA error preserves returned worker and review reports without automatic redispatch or fabricated acceptance')
  } else {
  assert.equal(plan.completion?.outcome, 'completed', JSON.stringify(plan))
  assert.equal(plan.tasks[0].execution.commitState, 'committed')
  assert.equal(plan.tasks[0].recovery?.used ?? 0, truncateOutput || continuous || supplement || switchCoordinator ? 0 : 1)
  assert.equal(plan.tasks[0].release.status, 'released')
  assert.equal(plan.tasks[0].modelRoute.role, 'worker')
  assert.equal(plan.tasks[0].modelRoute.actual.model, 'low-worker')
  assert.equal(plan.tasks[0].audit.modelRoute.role, 'reviewer')
  assert.equal(plan.tasks[0].audit.modelRoute.actual.model, 'coordinator')
  assert.equal(plan.tasks[0].audit.modelRoute.source, 'dispatcher')
  assert.equal(plan.tasks[0].audit.release.status, 'released')
  assert.equal(new Set(requests.filter(request => request.sessionId !== 'root').map(request => request.sessionId)).size, 2)
  assert.equal(requests.filter(request => request.model === 'low-worker').length, continuous ? 86 : truncateOutput ? 4 : 2)
  assert.equal(requests.filter(request => request.role === 'reviewer').length, truncateOutput ? 4 : 1)
  if (!switchCoordinator) assert.ok(requests.filter(request => request.sessionId === 'root').every(request => request.model === 'coordinator'))
  else {
    assert.ok(requests.some(request => request.role === 'coordinator' && request.model === 'changed-coordinator' && request.reasoningEffort === 'low'))
    assert.ok(requests.filter(request => request.role === 'reviewer').every(request => request.model === 'coordinator' && request.reasoningEffort === 'high'))
    console.log('PASS: native chat model changed during execution; review keeps the dispatcher model and high effort while coordinator continues on the new selection')
  }
  if (!baseline) {
    assert.equal((await state()).runtimePolicyVersion, 2)
    assert.equal(plan.usage.roles.reduce((sum, row) => sum + row.requests, 0), requests.length)
    for (const row of plan.usage.roles) {
      assert.equal(row.inputTokens, row.responses * 100)
      assert.equal(row.cacheReadTokens, row.responses * 200)
      assert.equal(row.outputTokens, row.responses * 10)
    }
  }
  console.log('METRICS ' + JSON.stringify({ requests: requests.length,
    byModel: Object.fromEntries([...new Set(requests.map(request => request.model))].map(model => [model, requests.filter(request => request.model === model).length])),
    inputCharacters: requests.reduce((sum, request) => sum + request.inputCharacters, 0) }))
  const coordinatorCalls = requests.filter(request => request.sessionId === 'root').length
  if (truncateOutput) assert.ok(coordinatorCalls >= 7 && coordinatorCalls <= 8, 'the original coordinator resumes each truncated output and may wait once for the child')
  else assert.equal(coordinatorCalls, supplement ? 7 : 5)
  if (supplement) {
    assert.equal(plan.inputs[0].status, 'forwarded')
    assert.equal(plan.tasks[0].criteria.length, 2)
    console.log('PASS: native queued user input wakes the waiting coordinator, is forwarded to the same running worker, updates criteria and is verified and accepted')
  }
  if (nativeDefault) {
    assert.equal(plan.tasks[0].audit.modelRoute.requested.reasoningEffort, 'max')
    assert.equal(plan.tasks[0].audit.modelRoute.actual.reasoningEffort, 'max')
    const header = events.find(event => event.id === plan.tasks[0].audit.childId && event.type === 'request/header').header
    assert.equal(header.config.reasoningEffort, 'max')
    console.log('PASS: native adapter default reasoning max is accepted from the logged request header; adapterDefaults present=' + Object.hasOwn(header, 'adapterDefaults'))
  }
  if (truncateOutput) assert.equal(plan.tasks[0].audit.recovery.used, 0)
  if (truncateOutput) console.log('PASS: three max-tokens responses per role continue on the same coordinator, worker and reviewer; accepted receipt generated with no replacement child or report-recovery consumption')
  if (continuous) {
    assert.ok(plan.tasks[0].supervision.notices.REQUEST_VOLUME)
    assert.equal(plan.tasks[0].attempts, 1)
    assert.equal(plan.activationBudget.used, 2)
    console.log('PASS: 86 worker requests on one native child; request reminder adds no coordinator call, replacement agent or correction')
  }
  assert.ok(events.some(event => event.id !== 'root' && event.type === 'turn/end'))
  console.log('PASS: real AgentLoop + ToolRuntime + SubagentRuntime: configured worker, review with dispatcher model, same-child report recovery, caller delivery, verification, acceptance, receipt and cleanup')
  if (nextRequest) {
    await until(() => parent.status === 'idle', 'first request settled')
    followingRequest = true
    const firstRequest = plan.source.messageId, receipt = plan.completion.id, calls = requests.length
    const newMessage = createUserMessage({ content: [{ type: 'text', text: '核对另一份代码用了哪些接口' }], source: { kind: 'user' } })
    parent.followup(newMessage)
    await until(() => events.filter(event => event.id === 'root' && event.type === 'turn/end').length === 2, 'second request completed')
    const following = await state()
    assert.equal(following.sessions[0].source.messageId, newMessage.id)
    assert.notEqual(following.sessions[0].source.messageId, firstRequest)
    assert.equal(following.plans[0].source.messageId, firstRequest)
    assert.equal(following.plans[0].completion.id, receipt)
    assert.equal(following.requestUsage[0].requestId, newMessage.id)
    assert.equal(requests.length, calls + 1, 'direct follow-up needs no old-task recovery or replacement child')
    assert.ok(events.filter(event => event.id === 'root' && event.type === 'turn/end').every(event => event.reason.kind === 'completed'))
    console.log('PASS: native second request gets its own source and usage, excludes the previous plan from system context, and preserves the original accepted receipt')
  }
  }
} finally {
  workerGate.resolve()
  await handle?.dispose()
  await ctx.fiber.dispose()
  while (ctx.fiber.inertia) await ctx.fiber.inertia
  await rm(directory, { recursive: true, force: true })
}
