// Installed AgentLoop/ToolRuntime/SubagentRuntime, real isolated files, scripted model only.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const { apply, RUNTIME_BUILD } = await import(process.env.AGENTRIX_PACKAGE_ROOT
  ? pathToFileURL(path.join(process.env.AGENTRIX_PACKAGE_ROOT, 'index.js')).href : new URL('../index.js', import.meta.url).href)

const scenario = process.argv[2] ?? 'direct'
assert.ok(['direct', 'separate-error', 'acceptance-save', 'cancel-cleanup', 'delivery-persistence', 'audited-resolutions', 'project-directory'].includes(scenario))
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
let projectInspected = false, projectVersionsInspected = false, projectWorkerReadEntered = false, projectCoordinatorRead = false, projectWorkerSawSupplement = false
let projectMisrouteGuarded = false, nativeTeamMessages = 0
const projectSupplement = '补充要求：继续原任务，并读取 independent.txt 确认内容仍为 verified。'
const projectDirectory = scenario === 'project-directory' ? path.join(directory, 'project') : directory
const output = path.join(projectDirectory, 'owned.txt'), independent = path.join(directory, 'independent.txt')
let parent, handle, sequence = 0, requestCount = 0, fault = false, runsFile, closing = false
ctx.provide('webServer', { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } })
if (scenario !== 'project-directory') ctx.provide('workingDirectory', { get: () => directory, async ensure() { return directory }, async set() {} })
for (const [module, name] of [['dsh-session-projection', 'SessionProjectionRegistry'], ['dsh-session', 'SessionStore'],
  ['dsh-agent', 'AgentRegistry'], ['dsh-system-prompt', 'SystemPrompt'], ['dsh-llm', 'LlmRuntime'],
  ['dsh-agent-loop', 'AgentLoop'], ['dsh-subagent', 'SubagentRuntime']]) ctx.plugin((await native(module))[name])
ctx.plugin(ToolRuntime)
if (['delivery-persistence', 'project-directory'].includes(scenario)) ctx.plugin(await native('dsh-session-persistence-jsonl'), { root: path.join(directory, 'sessions'), compression: 'none' })
ctx.plugin(await native('dsh-subagent-spawn-in-process'))
if (scenario === 'project-directory') {
  ctx.plugin((await native('dsh-experimental-agent-team')).TeamService)
  ctx.plugin(await native('dsh-experimental-tool-agent-team'))
  ctx.plugin((await native('dsh-fs-local')).default, { cwd: directory })
  ctx.plugin((await native('dsh-working-directory')).default, { defaultDirectory: directory })
  ctx.plugin((await native('dsh-subprocess-local')).default)
  ctx.plugin((await native('dsh-pwsh-local')).default, { cwd: directory })
  ctx.plugin(await native('dsh-shell-env'))
  ctx.plugin(await native('dsh-tool-pwsh'), { enableRunInBackground: false })
}
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
    if (scenario === 'project-directory' && request.sessionId === 'root') {
      const messages = JSON.stringify(request.messages)
      assert.ok(messages.includes('You are the Team Lead named'), 'the installed native Team identity guidance is active')
      assert.ok(request.tools.some(item => item.name === 'send_message'), 'installed native Team scope-local tools remain visible under the host restriction contract')
      if (plan && !plan.completion) {
        const managed = messages.lastIndexOf('当前任务由 Agentrix 托管，taskId 不是原生 Team 成员名')
        assert.ok(managed > messages.lastIndexOf('To message another teammate'), 'the current managed communication contract follows native Team identity')
        assert.match(messages.slice(managed), /delegation_control[\s\S]*steer/)
      } else assert.ok(!messages.includes('当前任务由 Agentrix 托管，taskId 不是原生 Team 成员名'))
    }
    let block
    if (scenario === 'audited-resolutions' && task?.audit?.childId === request.sessionId) {
      assert.equal(request.model, 'coordinator', 'independent review uses the dispatcher model')
      block = phase === 0 ? tool('read', { file_path: output }) : tool('delegation_report', { status: 'DONE', summary: '独立审查实际结果',
        report: '已实际读取隔离文件', specVerdict: task.attempts === 1 ? 'fail' : 'pass', qualityVerdict: 'pass',
        issues: task.attempts === 1 ? [{ criterion: 0, severity: 'important', finding: '测试要求一次定向返工', evidence: ['owned.txt:1'] }] : [],
        ...(task.attempts > 1 ? { resolutions: task.reworkIds.map(id => ({ id, status: 'ADDRESSED', evidence: ['owned.txt:1 独审复核通过'] })) } : {}) })
    } else if (request.sessionId !== 'root') {
      assert.equal(request.model, 'worker')
      if (scenario === 'project-directory') {
        assert.ok(!request.tools.some(item => item.name === 'send_message'), 'a managed worker cannot see its prohibited messaging tool')
        assert.ok(request.tools.some(item => item.name === 'delegation_checkpoint'))
        assert.ok(request.tools.some(item => item.name === 'delegation_report'))
        if (phase === 1) {
          assert.ok(JSON.stringify(request.messages).includes(projectSupplement), 'the original worker receives the real mid-flight supplement')
          projectWorkerSawSupplement = true
        }
      }
      if (phase === 0) block = tool('read', { file_path: output })
      else if (scenario === 'project-directory' && phase === 1) block = tool('read', { file_path: independent })
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
      complexity: 'routine', reviewPolicy: scenario === 'audited-resolutions' ? 'independent' : 'coordinator',
      reviewReason: scenario === 'audited-resolutions' ? '原生回放核对独立复查与重复确认的边界。' : '仅核对隔离文件，由主控实际验证。', criteria: ['内容包含 verified'],
      checks: [{ tool: 'read', arguments: { file_path: output } }],
      }
      if (scenario === 'project-directory') Object.assign(task, { writes: ['owned.txt'], outputs: ['owned.txt'],
        checks: [{ tool: 'read', arguments: { file_path: 'owned.txt' } }, { tool: 'pwsh', arguments: { command: "Get-Content -LiteralPath './owned.txt' -Raw", description: '读取工程目录中的实际交付物' } },
          { tool: 'read', arguments: { file_path: independent } }] })
      block = tool('delegation_plan', { relation: 'new', start: true, goal: '核对隔离文件', decisionReason: '执行者读取独立文件，主控验证验收。',
        ...(scenario === 'project-directory' ? { directory: projectDirectory } : {}),
        tasks: scenario === 'cancel-cleanup' ? [{ ...task, writes: [] }, { ...task, id: 'b', writes: [] }] : [task] })
    }
    else if (scenario === 'project-directory' && !projectInspected) {
      projectInspected = true
      block = tool('delegation_inspect', { operation: 'list', directory: projectDirectory })
    } else if (scenario === 'project-directory' && !projectVersionsInspected) {
      projectVersionsInspected = true
      block = tool('delegation_inspect', { operation: 'runtime_versions', directory: projectDirectory })
    } else if (scenario === 'project-directory' && state.sessions[0]?.pendingMessages?.some(message => message.text === projectSupplement)) {
      const message = state.sessions[0].pendingMessages.find(message => message.text === projectSupplement)
      block = tool('delegation_decide', { relation: 'update', messageId: message.messageId, mode: 'delegate', reason: '补充沿用原执行者核对另一份只读文件，不增加任务或代理。' })
    } else if (scenario === 'project-directory' && plan.inputs?.some(input => input.text === projectSupplement && input.status === 'received')) {
      const input = plan.inputs.find(input => input.text === projectSupplement && input.status === 'received')
      block = tool('delegation_control', { action: 'steer', taskId: 'a', inputIds: [input.id], message: '按补充继续原任务，不重新开始。',
        additionalCriteria: ['补充要求已交原执行者；independent.txt 实际读取仍包含 verified。'] })
    } else if (scenario === 'project-directory' && plan.inputs?.some(input => input.status === 'forwarded') && !projectCoordinatorRead) {
      projectCoordinatorRead = true
      block = tool('read', { file_path: independent })
    } else if (task.status === 'running') block = tool('delegation_wait')
    else if (task.status === 'review' && !task.checks[0].result) block = tool('delegation_verify', { taskId: 'a' })
    else if (task.status === 'review') {
      if (scenario === 'project-directory') assert.ok(task.checks.every(check => check.result?.passed), JSON.stringify(task.checks))
      if (scenario === 'audited-resolutions' && task.audit?.status !== 'completed') block = tool('delegation_wait')
      else if (scenario === 'audited-resolutions' && task.audit.specVerdict === 'fail') block = tool('delegation_review', {
        taskId: 'a', verdict: 'rework', issueIds: task.issues.filter(issue => issue.status === 'open').map(issue => issue.id) })
      else {
      if (scenario === 'acceptance-save') {
        if (!fault) {
          assert.ok(path.resolve(runsFile).startsWith(path.resolve(directory) + path.sep))
          await rename(runsFile, runsFile + '.held'); await mkdir(runsFile); fault = true
        } else {
          assert.equal(task.pendingAcceptance, undefined, 'failed preparation must release the lock before the next model call')
          await rm(runsFile, { recursive: true }); await rename(runsFile + '.held', runsFile)
        }
      }
      block = tool('delegation_review', { taskId: 'a', verdict: 'accept', findings: scenario === 'project-directory'
        ? task.criteria.map((_, index) => ({ criterionId: 'C' + (index + 1), finding: '实际读取及原执行者补充报告符合要求', evidence: [task.checks[index ? 2 : 0].result.ref] }))
        : [{ criterionId: 'C1', finding: '实际读取符合要求', evidence: [task.checks[0].result.ref] }],
        ...(scenario === 'audited-resolutions' ? { resolutions: task.reworkIds.map(id => ({ id, status: 'ADDRESSED', evidence: [task.checks[0].result.ref] })) } : {}) })
      }
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
  if (scenario === 'project-directory') {
    await until(() => ctx.get('agentTeams'), 'native Team service')
    const sendMessage = ctx.agentTeams.sendMessage.bind(ctx.agentTeams)
    ctx.agentTeams.sendMessage = (...args) => { nativeTeamMessages++; return sendMessage(...args) }
  }
  ctx.tools.setExecutor(new NativeToolExecutor(ctx))
  if (scenario === 'project-directory') ctx.tools.register(defineTool({ name: 'send_message', description: 'Native messaging visibility probe', parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
    async execute() { throw new Error('managed workers must not call ordinary messaging') } }))
  ctx.llm.registerAdapter(['scripted'], new Adapter())
  for (const name of ['read', 'edit']) ctx.tools.register(defineTool({ name, description: 'Isolated reliability fixture',
    parameters: { file_path: { type: 'string', required: true }, ...name === 'edit' ? { old_string: { type: 'string' }, new_string: { type: 'string' } } : {} },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args, exec) {
      assert.ok([output, independent].includes(args.file_path))
      if (scenario === 'project-directory' && exec.agent.id !== 'root' && args.file_path === output) {
        projectWorkerReadEntered = true
        await workerGate.promise
      }
      if (scenario === 'cancel-cleanup' && exec.agent.id !== 'root') await new Promise((_, reject) => {
        if (exec.signal.aborted) return reject(exec.signal.reason)
        exec.signal.addEventListener('abort', () => reject(exec.signal.reason), { once: true })
      })
      let text = await readFile(args.file_path, 'utf8')
      if (scenario === 'project-directory' && exec.agent.id === 'root' && args.file_path === independent) workerGate.resolve()
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
    if (scenario === 'project-directory') {
      const session = ctx.sessions.get(receipt.childId)
      assert.equal(session.header.cwd, directory)
      assert.equal(ctx.workingDirectory.get(session), projectDirectory)
      assert.ok(session.snapshotEvents().some(event => event.type === 'working-directory/change' && event.data.cwd === projectDirectory))
    }
    activations.set(receipt.childId, args[0])
    receipt.dispose = async () => {
      releases.set(receipt.childId, (releases.get(receipt.childId) ?? 0) + 1)
      if (scenario === 'cancel-cleanup' && receipt.childId === [...activations.keys()][0]) throw new Error('scripted native dispose failure')
      return dispose()
    }
    return receipt
  }
  ctx.on('session/event', (session, event) => events.push({ sessionId: session.id, ...event }), { global: true })
  await mkdir(projectDirectory, { recursive: true })
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
  if (scenario === 'project-directory') {
    await until(() => {
      const failure = events.find(event => event.sessionId === 'root' && event.type === 'turn/end' && event.data.reason?.kind === 'error')
      assert.ok(!failure, JSON.stringify(failure?.data.reason))
      return projectWorkerReadEntered && events.some(event => event.sessionId === 'root' && event.type === 'tool/call' && event.data.name === 'delegation_inspect')
    }, 'inspection while the original worker is active')
    const denied = await ctx.tools.execute({ agent: parent, signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: 'native-team-misroute-probe', name: 'send_message', arguments: JSON.stringify({ target: 'a', message: '补充原任务' }) }] })
    assert.equal(denied.results.length, 1)
    assert.equal(denied.results[0].result.isError, true)
    assert.match(JSON.stringify(denied.results[0].result.content), /DSH Agentrix[\s\S]*delegation_control[\s\S]*steer/)
    assert.equal(nativeTeamMessages, 0, 'the plugin rejects taskId messaging before the native Team roster lookup')
    projectMisrouteGuarded = true
    parent.steer(createUserMessage({ content: [{ type: 'text', text: projectSupplement }], source: { kind: 'user' } }))
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
  } else if (scenario === 'project-directory') {
    const plan = result.plans[0]
    assert.ok(plan, JSON.stringify(events.filter(event => ['tool/result', 'turn/end'].includes(event.type))))
    assert.equal(plan.cwd, projectDirectory)
    assert.equal(parent.session.header.cwd, directory)
    assert.deepEqual(plan.tasks[0].writes, [output])
    assert.equal([...activations.values()][0].request.cwd, projectDirectory)
    assert.equal(plan.completion.outcome, 'completed', JSON.stringify({ checks: plan.tasks[0].checks, task: plan.tasks[0].error, issue: plan.tasks[0].issue,
      errors: events.filter(event => event.type === 'tool/result' && event.data.message?.isError).map(event => event.data.message.content) }))
    assert.equal(plan.delivery.files[0].path, output)
    assert.equal(plan.tasks[0].checks[0].arguments.file_path, output)
    assert.equal(plan.tasks[0].checks[1].arguments.workdir, projectDirectory)
    assert.equal(plan.tasks[0].checks[1].result.exitCode, 0)
    assert.match(plan.tasks[0].checks[1].result.summary, /verified/)
    assert.ok(projectCoordinatorRead && projectWorkerSawSupplement && projectMisrouteGuarded)
    assert.equal(plan.inputs.length, 1)
    assert.equal(plan.inputs[0].status, 'forwarded')
    assert.equal(plan.inputs[0].taskId, 'a')
    assert.equal(plan.tasks[0].attempts, 1)
    assert.ok(ctx.tools.schemas(parent).some(tool => tool.name === 'send_message'), 'completion restores the native Team messaging entry point')
    const completedPrompt = await ctx.systemPrompt.assemble({ agent: parent, scope: parent,
      modelSelection: parent.model.current(), signal: new AbortController().signal })
    assert.match(completedPrompt.contexts.find(context => context.name === 'team:identity').text, /You are the Team Lead named/)
    assert.equal(completedPrompt.contexts.find(context => context.name === 'dsh-delegation-first:coordination').text, '',
      'the completed plan no longer adds managed communication guidance to native prompt assembly')
    const inspection = events.find(event => event.sessionId === 'root' && event.type === 'tool/call' && event.data.name === 'delegation_inspect')
    const inspectionResult = events.find(event => event.sessionId === 'root' && event.type === 'tool/result' && event.data.message?.toolCallId === inspection.data.callId)
    assert.ok(inspectionResult && !inspectionResult.data.message.isError, 'dedicated inspection executes through the protected plan')
    const inspectionValue = JSON.parse(inspectionResult.data.message.content.find(block => block.type === 'text').text)
    assert.equal(inspectionValue.passed, true)
    assert.equal(inspectionValue.exitCode, 0)
    assert.match(inspectionValue.output, /owned\.txt/)
    const versionInspection = events.find(event => event.sessionId === 'root' && event.type === 'tool/call' && event.data.name === 'delegation_inspect' && JSON.parse(event.data.arguments).operation === 'runtime_versions')
    assert.ok(versionInspection, 'the coordinator uses the dedicated runtime version operation during protected execution')
    const versionResult = events.find(event => event.sessionId === 'root' && event.type === 'tool/result' && event.data.message?.toolCallId === versionInspection.data.callId)
    assert.ok(versionResult && !versionResult.data.message.isError)
    const versionValue = JSON.parse(versionResult.data.message.content.find(block => block.type === 'text').text)
    assert.equal(versionValue.passed, true)
    assert.equal(versionValue.exitCode, 0)
    const versions = JSON.parse(versionValue.output)
    assert.deepEqual(versions.map(item => item.runtime), ['node', 'python', 'docker'])
    assert.ok(versions.every(item => typeof item.available === 'boolean'))
    assert.ok(versions.find(item => item.runtime === 'node').available, 'the installed environment supplies Node for the native replay')
    assert.equal(activations.size, 1)
    assert.ok([...releases.values()].every(count => count === 1))
    assert.ok(!events.some(event => event.type === 'tool/result' && event.data.message?.isError))
  } else if (scenario === 'audited-resolutions') {
    const task = result.plans[0].tasks[0]
    assert.equal(result.plans[0].completion.outcome, 'completed')
    assert.equal(task.attempts, 2)
    assert.equal(task.audit.forAttempt, 2)
    assert.equal(task.issues[0].status, 'addressed')
    assert.deepEqual(task.issues[0].resolutionEvidence, ['owned.txt:1 独审复核通过'], 'coordinator confirmation preserves reviewer proof')
    assert.equal(activations.size, 4)
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
