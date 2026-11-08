// Run with DSH's Electron in Node mode and DSH_MODULE_ROOT pointing at its bundled modules.
// Uses the installed Cordis, ToolRuntime and LlmRuntime. No model call or real child Agent is started.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { apply } from '../index.js'

const moduleRoot = process.env.DSH_MODULE_ROOT
if (!moduleRoot) throw new Error('DSH_MODULE_ROOT is required')
const native = async name => import(pathToFileURL(path.join(moduleRoot, name, 'lib/index.js')).href)
const { Context } = await native('cordis')
const { ToolRuntime, defineTool, assertSupportedJsonSchema } = await native('dsh-tools')
const { LlmRuntime, LlmAdapter } = await native('dsh-llm')
const { NativeToolExecutor } = await native('dsh-tool-executor-native')
const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-native-contract-'))
process.env.DSH_HOME = directory
delete process.env.DSH_DELEGATION_FIRST
const ctx = new Context(), routes = new Map(), children = [], outputs = [], sections = [], childAgents = new Map()
const parent = { id: 'root', options: { provider: 'test', model: 'parent' }, session: { header: {}, requestHeader: () => undefined }, ctx }
ctx.provide('systemPrompt', { tools() {}, section(section) { sections.push(section); return () => {} } })
ctx.provide('sessions', { get: id => id === 'root' ? parent.session : childAgents.get(id)?.session })
ctx.provide('agents', { get: id => id === 'root' ? parent : childAgents.get(id), list: () => [parent, ...childAgents.values()] })
ctx.provide('webServer', { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } })
const llm = new LlmRuntime(ctx)
let adapterDispatches = 0, probeMismatch = false
const disposed = new Map()
class MetadataOnlyAdapter extends LlmAdapter {
  async *stream() { adapterDispatches++ }
}
let releaseAdapter = llm.registerAdapter(['test'], new MetadataOnlyAdapter())
ctx.provide('subagents', {
  resolveMaxDepth: () => 1,
  async startActivation(spec) {
    assert.equal(spec.request.parent, parent)
    assert.equal(spec.request.agentOptions.provider, 'test')
    assert.ok(['parent', 'routine', 'complex'].includes(spec.request.agentOptions.model))
    assert.equal(spec.provider, 'spawn')
    assert.ok(spec.childId)
    children.push(spec)
    childAgents.set(spec.childId, { id: spec.childId, options: spec.request.agentOptions, session: { header: { origin: 'subagent', parentSession: parent.id } }, ctx })
    const output = Promise.withResolvers()
    outputs.push(output)
    if (probeMismatch) {
      try {
        for await (const chunk of llm.stream({ sessionId: spec.childId, provider: 'test', model: 'parent', messages: [], signal: spec.signal })) {}
      } catch (error) { output.reject(error) }
    }
    return { childId: spec.childId, result: output.promise, async dispose() {
      disposed.set(spec.childId, (disposed.get(spec.childId) ?? 0) + 1)
      output.resolve({ stopReason: 'aborted', output: [] })
    } }
  },
})
const runtime = new ToolRuntime(ctx)
runtime.setExecutor(new NativeToolExecutor(ctx))
for (const name of ['pwsh', 'read', 'edit']) runtime.register(defineTool({
  name, description: 'Isolated contract fixture', parameters: name === 'pwsh' ? { command: { type: 'string' }, description: { type: 'string' } } : {},
  output: { schema: { type: 'object', additionalProperties: false, properties: { exitCode: { type: 'integer', required: true }, output: { type: 'string' } } },
    render: (_args, value) => [{ type: 'text', text: value.output ?? 'verified fixture output' }] },
  async execute(args) {
    if (name === 'pwsh' && args.command) {
      const child = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', args.command], { encoding: 'utf8', timeout: 15000, windowsHide: true })
      return { exitCode: child.status ?? -1, output: child.stdout + child.stderr }
    }
    return { exitCode: 0 }
  },
}))
apply(ctx)
try {
  for (let i = 0; i < 50 && !routes.has('/dsh-delegation-first/api/state'); i++) await new Promise(resolve => setTimeout(resolve, 10))
  let response
  await routes.get('/dsh-delegation-first/api/state')({ method: 'GET' }, { writeHead() {}, end(body) { response = JSON.parse(body) } })
  assert.equal(response.ok, true)
  const saveConfig = async body => {
    let status, payload
    await routes.get('/dsh-delegation-first/api/config')({ method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } },
      { writeHead(code) { status = code }, end(body) { payload = JSON.parse(body) } })
    return { status, payload }
  }
  assert.equal((await saveConfig({ mode: 'strict', models: { worker: { provider: 'test', model: 'parent' }, reviewer: null } })).status, 200)
  const rejected = await saveConfig({ models: { routine: { provider: 'retired', model: 'parent' }, complex: null } })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.payload.issue.retryable, false)
  assert.match(rejected.payload.issue.details, /no adapter registered for provider "retired"/)
  for (const tool of runtime.schemas(parent)) assertSupportedJsonSchema(tool.parameters)
  let sequence = 0
  const call = async (name, args = {}, agent = parent) => {
    const callId = `native-${++sequence}`
    const batch = await runtime.execute({ calls: [{ id: callId, name, arguments: JSON.stringify(args) }], agent,
      signal: new AbortController().signal })
    return batch.results.find(item => item.callId === callId).result
  }
  const checked = async (name, args, agent) => {
    const result = await call(name, args, agent)
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(result)}`)
    return result.value
  }
  assert.equal((await call('pwsh')).isError, true)
  assert.equal((await call('subagent')).isError, true)
  const quotedDirectory = path.join(directory, "quoted '$literal")
  await mkdir(quotedDirectory)
  const listed = await checked('delegation_inspect', { operation: 'list', directory: quotedDirectory })
  assert.equal(listed.passed, true, JSON.stringify(listed))
  for (const kind of ['task_plan', 'findings', 'progress']) {
    const note = await checked('delegation_note', { kind, content: kind })
    assert.equal(await readFile(note.path, 'utf8'), kind)
  }
  assert.equal(spawnSync('git', ['init', '--quiet', directory], { encoding: 'utf8', windowsHide: true }).status, 0)
  const baseline = await checked('delegation_inspect', { operation: 'git_status', directory })
  assert.equal(baseline.passed, true, JSON.stringify(baseline))
  await checked('delegation_plan', { goal: '验证原生工具管线兼容性', tasks: [{
    id: 'a', title: '检查隔离产物', instructions: '只检查测试数据', scope: '隔离环境', outputs: ['fixture'], writes: [],
    complexity: 'routine', criteria: ['实际运行的主控验证通过'], checks: [{ tool: 'pwsh', arguments: {} }],
  }] })
  await checked('delegation_run')
  assert.equal(children.length, 1)
  await checked('delegation_report', { status: 'DONE', summary: '隔离产物已返回', report: 'fixture done' }, childAgents.get(children[0].childId))
  outputs[0].resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'fixture done' }] })
  for (let i = 0; i < 100; i++) {
    const result = await checked('delegation_status')
    if (result.plan.tasks[0].status === 'review') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal((await call('pwsh')).isError, true)
  const evidence = await checked('delegation_verify', { taskId: 'a', checkIndex: 0 })
  assert.equal(evidence.passed, true)
  const review = await checked('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterion: 0, finding: '原生工具执行管线返回退出码 0', evidence: [evidence.callId] }] })
  assert.equal(review.status, 'accepted')
  const acceptedArchive = (await checked('delegation_status')).plan.archive.id
  await checked('delegation_plan', { goal: '验证子任务原生错误进入状态和主控提示', tasks: [{
    id: 'failure', title: '隔离错误事件', instructions: '只处理测试数据', scope: '隔离环境', outputs: ['fixture'], writes: [],
    complexity: 'routine', criteria: ['真实原因可见'], checks: [{ tool: 'read', arguments: {} }],
  }] })
  await checked('delegation_run')
  const failure = '403 Forbidden: This account only allows Codex official clients'
  await routes.get('/dsh-delegation-first/api/archive')(
    { method: 'GET', url: '/dsh-delegation-first/api/archive?id=' + acceptedArchive },
    { writeHead(code) { assert.equal(code, 200) }, end(body) { response = JSON.parse(body) } })
  assert.equal(response.plan.status, 'accepted')
  assert.ok(response.markdown.includes(evidence.callId))
  await routes.get('/dsh-delegation-first/api/history')(
    { method: 'GET', url: '/dsh-delegation-first/api/history' },
    { writeHead(code) { assert.equal(code, 200) }, end(body) { response = JSON.parse(body) } })
  assert.equal(response.items.length, 2)
  ctx.emit('session/event', { id: children[1].childId }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'AUTH', message: failure } } } })
  outputs[1].resolve({ stopReason: 'error', output: [] })
  let failed
  for (let i = 0; i < 100; i++) {
    failed = await checked('delegation_status')
    if (failed.plan.tasks[0].status === 'failed') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(failed.plan.tasks[0].status, 'failed')
  assert.equal(failed.plan.tasks[0].error, failure)
  assert.ok(sections.some(section => section.text().includes(failure)))
  await routes.get('/dsh-delegation-first/api/state')({ method: 'GET' }, { writeHead() {}, end(body) { response = JSON.parse(body) } })
  assert.equal(response.plans[0].tasks[0].error, failure)
  assert.equal(children.length, 2)
  await checked('delegation_cancel')
  await checked('delegation_plan', { goal: '验证原生 NO_ADAPTER 在派单前返回工具错误', tasks: [{
    id: 'stale', title: '模型已被移除', instructions: '只处理测试数据', scope: '隔离环境', outputs: ['fixture'], writes: [],
    complexity: 'routine', criteria: ['未启动子任务'], checks: [{ tool: 'read', arguments: {} }],
  }] })
  releaseAdapter()
  const blocked = await call('delegation_run')
  assert.equal(blocked.isError, true)
  const current = await checked('delegation_status')
  assert.equal(current.plan.tasks[0].status, 'blocked')
  assert.equal(current.plan.tasks[0].attempts, 0)
  assert.equal(current.plan.tasks[0].childId, null)
  assert.equal(current.plan.tasks[0].issue.retryable, false)
  assert.match(current.plan.tasks[0].issue.details, /no adapter registered for provider "test"/)
  assert.ok(sections.some(section => section.text().includes('配置未更新前不要重试')))
  assert.equal(children.length, 2)
  releaseAdapter = llm.registerAdapter(['test'], new MetadataOnlyAdapter())
  await checked('delegation_run')
  assert.equal(children.length, 3)
  assert.equal((await checked('delegation_status')).plan.tasks[0].attempts, 1)
  await checked('delegation_cancel')
  const savedModels = await saveConfig({ models: { worker: { provider: 'test', model: 'routine' }, reviewer: { provider: 'test', model: 'complex' } } })
  assert.equal(savedModels.status, 200)
  const modelCard = (id, complexity) => ({ id, title: id, instructions: '只检查隔离数据', scope: '本地测试', outputs: ['fixture'], writes: [],
    complexity, complexityReason: '验证角色路由不受复杂度影响', criteria: ['模型正确'], checks: [{ tool: 'read', arguments: {} }] })
  await checked('delegation_plan', { goal: '首个模型请求错配必须在发送前阻止', tasks: [modelCard('mismatch', 'routine'), modelCard('queued', 'routine')] })
  probeMismatch = true
  await checked('delegation_run')
  for (let i = 0; i < 100; i++) {
    const state = await checked('delegation_status')
    if (state.plan.tasks[0].status === 'blocked') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const mismatch = (await checked('delegation_status')).plan
  assert.equal(mismatch.tasks[0].issue.code, 'MODEL_ROUTE_MISMATCH')
  assert.equal(adapterDispatches, 0)
  assert.equal(children.length, 4)
  assert.equal(disposed.get(children[3].childId), 1)
  assert.equal(mismatch.autoDispatch, false)
  probeMismatch = false
  await checked('delegation_cancel')
  await checked('delegation_plan', { goal: '父子模型独立且实际请求可核对', tasks: [modelCard('routine', 'routine'), modelCard('complex', 'complex')] })
  await checked('delegation_run')
  assert.deepEqual(children.slice(-2).map(child => child.request.agentOptions.model), ['routine', 'routine'])
  parent.options.model = 'changed-parent'
  for (const child of children.slice(-2)) {
    for await (const chunk of llm.stream({ ...child.request.agentOptions, sessionId: child.childId, messages: [], signal: child.signal })) {}
  }
  const verified = (await checked('delegation_status')).plan
  assert.deepEqual(verified.tasks.map(task => task.modelRoute.actual.model), ['routine', 'routine'])
  assert.deepEqual(verified.tasks.map(task => task.modelRoute.role), ['worker', 'worker'])
  assert.equal(adapterDispatches, 2)
  await checked('delegation_cancel')
  await checked('delegation_plan', { goal: '复杂任务独立审查与身份约束', tasks: [modelCard('audit', 'complex')] })
  await checked('delegation_run')
  const worker = children.at(-1), workerIndex = children.length - 1
  assert.equal((await call('delegation_report', { status: 'DONE', summary: '冒领', report: '不能由主控代报' })).isError, true)
  await checked('delegation_report', { status: 'DONE', summary: '交付物已完成', report: '完整报告\n' + '实际证据\n'.repeat(700) }, childAgents.get(worker.childId))
  outputs[workerIndex].resolve({ stopReason: 'completed', output: [] })
  let audited
  for (let i = 0; i < 150; i++) {
    audited = (await checked('delegation_status')).plan
    if (audited.tasks[0].audit?.status === 'running') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const reviewer = children.at(-1), reviewerAgent = childAgents.get(reviewer.childId)
  assert.notEqual(reviewer.childId, worker.childId)
  assert.equal(audited.activationBudget.used, 2)
  assert.equal(reviewer.request.agentOptions.model, 'complex')
  assert.equal(worker.request.agentOptions.model, 'routine')
  assert.equal(audited.tasks[0].audit.modelRoute.role, 'reviewer')
  assert.equal((await call('edit', {}, reviewerAgent)).isError, true)
  assert.equal((await call('pwsh', {}, reviewerAgent)).isError, true)
  await checked('read', {}, reviewerAgent)
  const auditEvidence = await checked('delegation_verify', { taskId: 'audit', checkIndex: 0 })
  const acceptance = { taskId: 'audit', verdict: 'accept', findings: [{ criterion: 0, finding: '主控实际读取已核对', evidence: [auditEvidence.callId] }] }
  assert.equal((await call('delegation_review', acceptance)).isError, true)
  await checked('delegation_report', { status: 'DONE', summary: '两个结论均通过', report: '已读取实际产物，符合需求与质量要求。', specVerdict: 'pass', qualityVerdict: 'pass', issues: [] }, reviewerAgent)
  outputs.at(-1).resolve({ stopReason: 'completed', output: [] })
  for (let i = 0; i < 150; i++) {
    audited = (await checked('delegation_status')).plan
    if (audited.tasks[0].audit?.status === 'completed') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal((await checked('delegation_review', acceptance)).status, 'accepted')
  assert.equal(disposed.get(worker.childId), 1)
  assert.equal(disposed.get(reviewer.childId), 1)
  assert.match(await readFile(audited.tasks[0].execution.reportPath, 'utf8'), /实际证据/)
  assert.equal((await call('delegation_report', { status: 'DONE', summary: '过期覆盖', report: '拒绝' }, reviewerAgent)).isError, true)
  console.log('PASS: structured full reports, child identity, complex-task independent review, native read-only guards, shared activation budget, acceptance gate and exact-once reviewer cleanup')
  console.log('PASS: installed Cordis + ToolRuntime + LlmRuntime: schemas, strict gate, preparation, scoped notes, verification, acceptance, child errors, invalid-model recovery, reserved IDs, first-request mismatch blocked with zero dispatches, exact-once cleanup, per-role actual requests')
} finally {
  await ctx.fiber.dispose()
  while (ctx.fiber.inertia) await ctx.fiber.inertia
  await rm(directory, { recursive: true, force: true })
}
