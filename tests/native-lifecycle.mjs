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
const { LlmRuntime, LlmAdapter, createUserMessage } = await native('dsh-llm')
const { SubagentRuntime } = await native('dsh-subagent')
const Spawn = await native('dsh-subagent-spawn-in-process')
const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-completion-native-'))
const truncateOutput = process.argv.includes('--truncate-output')
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
  for (let i = 0; i < 500; i++) { if (predicate()) return; await tick() }
  throw new Error('Timed out: ' + label)
}
let parent, handle, nextCall = 0
class ScriptedAdapter extends LlmAdapter {
  async *stream(request) {
    requests.push({ sessionId: request.sessionId, model: request.model })
    const phase = phases.get(request.sessionId) ?? 0
    phases.set(request.sessionId, phase + 1)
    let block
    if (request.sessionId === parent?.id) {
      const task = (await state())?.plans?.[0]?.tasks?.[0]
      if (!task) block = tool('delegation_plan', { goal: '高模型规划、低模型执行、高模型审查与验收', tasks: [{ id: 'a', title: '检查隔离产物', instructions: '只读取隔离文件并正式报告', scope: '隔离目录', outputs: [path.join(directory, 'result.txt')], writes: [], complexity: 'complex', criteria: ['文件包含 verified'], checks: [{ tool: 'read', arguments: { path: path.join(directory, 'result.txt') } }] }] })
      else if (phase === 1) block = tool('delegation_run', {})
      else if (phase === 2 || truncateOutput && phase < 5) block = { type: 'text', text: '保留当前输出，继续原计划。' }
      else if (task.status === 'review' && !task.checks[0].result) block = tool('delegation_verify', { taskId: 'a', checkIndex: 0 })
      else if (task.status === 'review') block = tool('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterion: 0, finding: '实际文件包含 verified', evidence: [task.checks[0].result.callId] }] })
      else if (truncateOutput && task.status === 'running') block = { type: 'text', text: '等待原子代理报告和独立审查返回。' }
      else throw new Error('Unexpected coordinator request after terminal tool: ' + task.status)
    } else if (truncateOutput && phase < 3) block = { type: 'text', text: '本段输出被模型截断，继续检查已有产物。' }
    else if (request.model === 'high-reviewer' && phase === (truncateOutput ? 3 : 0)) block = tool('delegation_report', { status: 'DONE', summary: '需求与质量均通过', report: '已核对隔离产物与任务要求，等待主控实际验证。', specVerdict: 'pass', qualityVerdict: 'pass', issues: [] })
    else if (request.model === 'low-worker' && phase === 0) block = { type: 'text', text: '工作已完成，但这次故意漏交正式报告。' }
    else if (phase === (truncateOutput ? 3 : 1)) block = tool('delegation_report', { status: 'DONE', summary: '隔离产物已检查', report: '读取 result.txt 可验证 verified，等待主控实际验收。' })
    else throw new Error('Unexpected child request after report')
    yield { type: 'block-start', index: 0, blockType: block.type }
    yield { type: 'block-end', index: 0, block }
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
    async execute(args) { assert.equal(args.path, path.join(directory, 'result.txt')); return { text: await readFile(args.path, 'utf8') } } }))
  await writeFile(path.join(directory, 'result.txt'), 'verified')
  apply(ctx)
  await until(() => routes.has('/dsh-delegation-first/api/state'), 'plugin routes')
  await state()
  let configStatus
  await routes.get('/dsh-delegation-first/api/config')({ method: 'POST', async *[Symbol.asyncIterator]() {
    yield Buffer.from(JSON.stringify({ models: { worker: { provider: 'scripted', model: 'low-worker' }, reviewer: { provider: 'scripted', model: 'high-reviewer' } } }))
  } }, { writeHead(status) { configStatus = status }, end() {} })
  assert.equal(configStatus, 200)
  ctx.on('session/event', (session, event) => events.push({ id: session.id, type: event.type, reason: event.data?.reason }), { global: true })
  handle = await ctx.agents.create({ sessionId: 'root', meta: { cwd: directory }, agentOptions: { provider: 'scripted', model: 'coordinator' } })
  parent = handle.agent
  parent.followup(createUserMessage({ content: [{ type: 'text', text: '执行隔离任务并验证' }], source: { kind: 'user' } }))
  await until(() => events.some(event => event.id === 'root' && event.type === 'turn/end'), 'coordinator completion')
  const plan = (await state()).plans[0]
  assert.equal(plan.completion?.outcome, 'completed', JSON.stringify(plan))
  assert.equal(plan.tasks[0].execution.commitState, 'committed')
  assert.equal(plan.tasks[0].recovery.used, truncateOutput ? 0 : 1)
  assert.equal(plan.tasks[0].release.status, 'released')
  assert.equal(plan.tasks[0].modelRoute.role, 'worker')
  assert.equal(plan.tasks[0].modelRoute.actual.model, 'low-worker')
  assert.equal(plan.tasks[0].audit.modelRoute.role, 'reviewer')
  assert.equal(plan.tasks[0].audit.modelRoute.actual.model, 'high-reviewer')
  assert.equal(plan.tasks[0].audit.release.status, 'released')
  assert.equal(new Set(requests.filter(request => request.sessionId !== 'root').map(request => request.sessionId)).size, 2)
  assert.equal(requests.filter(request => request.model === 'low-worker').length, truncateOutput ? 4 : 2)
  assert.equal(requests.filter(request => request.model === 'high-reviewer').length, truncateOutput ? 4 : 1)
  assert.ok(requests.filter(request => request.sessionId === 'root').every(request => request.model === 'coordinator'))
  const coordinatorCalls = requests.filter(request => request.sessionId === 'root').length
  if (truncateOutput) assert.ok(coordinatorCalls >= 7 && coordinatorCalls <= 8, 'the original coordinator resumes each truncated output and may wait once for the child')
  else assert.equal(coordinatorCalls, 5)
  if (truncateOutput) assert.equal(plan.tasks[0].audit.recovery.used, 0)
  if (truncateOutput) console.log('PASS: three max-tokens responses per role continue on the same coordinator, worker and reviewer; accepted receipt generated with no replacement child or report-recovery consumption')
  assert.ok(events.some(event => event.id !== 'root' && event.type === 'turn/end'))
  console.log('PASS: real AgentLoop + ToolRuntime + SubagentRuntime: distinct coordinator / execution / review models, same-child report recovery, caller delivery, actual verification, acceptance, generated receipt and exact cleanup without an extra model summary')
} finally {
  await handle?.dispose()
  await ctx.fiber.dispose()
  while (ctx.fiber.inertia) await ctx.fiber.inertia
  await rm(directory, { recursive: true, force: true })
}
