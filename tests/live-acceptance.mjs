// Explicit, billable acceptance against configured models and the installed DSH runtime.
// Credentials stay in memory. All model-visible file access is restricted to synthetic fixtures.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { apply, RUNTIME_BUILD } from '../index.js'

const scenario = process.argv[2] ?? 'direct'
assert.ok(['direct', 'auto-simple', 'auto-followup', 'auto-readonly', 'parallel-supplement', 'failure-recovery', 'rework', 'cancel-resume'].includes(scenario))
const simple = ['direct', 'auto-simple', 'auto-followup', 'auto-readonly'].includes(scenario)
const providerName = process.env.AGENTRIX_PROVIDER, coordinatorModel = process.env.AGENTRIX_COORDINATOR_MODEL, workerModel = process.env.AGENTRIX_WORKER_MODEL
assert.ok(providerName && coordinatorModel && workerModel, 'Explicit provider, coordinator and worker model selections are required')
const moduleRoot = process.env.DSH_MODULE_ROOT
assert.ok(moduleRoot, 'DSH_MODULE_ROOT must point to the reviewed installed runtime')
const installedRoot = path.resolve(moduleRoot, '../..')
const installedRequire = createRequire(path.join(installedRoot, 'package.json'))
const yaml = installedRequire('js-yaml')
const native = name => import(pathToFileURL(path.join(moduleRoot, name, 'lib/index.js')).href)
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runFile = promisify(execFile)
const realHome = process.env.AGENTRIX_SOURCE_HOME ?? path.join(os.homedir(), '.dsh')
let rows, credentials
try {
  rows = yaml.load(await readFile(path.join(realHome, 'profiles/desktop/cordis.patch.yml'), 'utf8'))
  credentials = yaml.load(await readFile(path.join(realHome, '.credentials.yaml'), 'utf8'))
} catch { throw new Error('Cannot read configured provider/credential; raw configuration is withheld') }
const provider = structuredClone(rows.find(row => row.id === 'llm-pi-ai')?.config?.providers?.[providerName])
assert.ok(provider && Array.isArray(provider.models), 'The explicitly selected configured provider is required')
provider.baseURL = process.env.AGENTRIX_LIVE_BASE_URL ?? provider.baseURL
provider.models = provider.models.filter(model => [coordinatorModel, workerModel].includes(model.id))
assert.equal(provider.models.length, 2, 'Both explicitly selected models must be configured')
const reference = provider.apiKeyEnv, secret = credentials.refs?.[reference]
assert.ok(typeof reference === 'string' && typeof secret === 'string' && secret, 'Configured credential reference is required')
credentials = null; rows = null
const redact = text => String(text).replaceAll(secret, '[redacted]')
const { Context } = await native('cordis')
const { createLaunchEnvironmentSnapshot } = await native('dsh-launch-environment')
const { createUserMessage, LlmError } = await native('dsh-llm')
const { ToolRuntime, defineTool } = await native('dsh-tools')
const { NativeToolExecutor } = await native('dsh-tool-executor-native')
const temporary = await mkdtemp(path.join(os.tmpdir(), 'agentrix-live-'))
const resolvedTemporary = await realpath(temporary)
const workspace = path.join(temporary, 'workspace'), home = path.join(temporary, 'home')
await mkdir(workspace); await mkdir(home)
process.env.DSH_HOME = home
delete process.env.DSH_DELEGATION_FIRST
let ctx
const routes = new Map(), requests = [], events = [], activities = [], activations = [], releases = []
const gate = Promise.withResolvers()
let handle, parent, closing = false, gateEntered = false, supplementSent = false, faultInjected = false, corrupted = false, minimumTurnEnds = 1
let corruptedAttempt, corruptedTaskId, corruptionEventIndex
const started = Date.now(), deadline = started + Number(process.env.AGENTRIX_LIVE_TIMEOUT_MS ?? 12 * 60_000)
const result = { scenario, runtimeBuild: RUNTIME_BUILD, coordinator: providerName + '/' + coordinatorModel, worker: providerName + '/' + workerModel,
  layer: 'installed AgentLoop/ToolRuntime/SubagentRuntime and real pi-ai provider; restricted synthetic filesystem',
  scriptedModel: false, passed: false, assertions: [] }
const contained = (root, target) => { const relative = path.relative(root, target); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) }
const targetPath = value => {
  assert.ok(typeof value === 'string' && value, 'file_path is required')
  return path.resolve(workspace, value)
}
const writable = value => { const target = targetPath(value); assert.ok(contained(workspace, target), 'Writes must stay in the synthetic workspace'); return target }
const readable = value => {
  const target = targetPath(value)
  assert.ok(contained(workspace, target) || contained(path.join(repository, 'skills'), target) || contained(path.join(home, 'delegation-first'), target),
    'Read is outside the synthetic workspace, its plugin reports and the bundled skills')
  return target
}
const check = (description, assertion) => { assertion(); result.assertions.push(description) }
async function until(predicate, description) {
  while (!closing && Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Acceptance timed out: ' + description)
}
async function request(endpoint, body) {
  let value
  const route = '/dsh-delegation-first/api/' + endpoint
  await routes.get(route)({ method: body ? 'POST' : 'GET', url: route + '?sessionId=root',
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } },
  { writeHead(code) { assert.equal(code, 200, 'Isolated API ' + endpoint) }, end(text) { value = JSON.parse(text) } })
  return value
}
const state = () => request('state')
const send = text => {
  minimumTurnEnds = events.filter(event => event.sessionId === 'root' && event.type === 'turn/end').length + 1
  return parent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}
const planTask = async file => (await state()).plans[0]?.tasks.find(task => task.outputs.some(output => path.basename(output) === file))
async function settled() {
  await until(() => events.filter(event => event.sessionId === 'root' && event.type === 'turn/end').length >= minimumTurnEnds && parent.status === 'idle', 'the current coordinator turn becomes idle')
  const last = events.filter(event => event.sessionId === 'root' && event.type === 'turn/end').at(-1)
  if (last.reason?.kind === 'error') throw new Error('Native coordinator failed: ' + JSON.stringify(last.reason.error ?? last.reason))
  return state()
}
async function launchRuntime(resume = false) {
ctx = new Context(); routes.clear()
ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: { [reference]: secret } }]))
ctx.provide('webServer', { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } })
ctx.provide('workingDirectory', { get: () => workspace, async ensure() { return workspace }, async set() {} })
for (const [module, name] of [['dsh-session-projection', 'SessionProjectionRegistry'], ['dsh-session', 'SessionStore'],
  ['dsh-agent', 'AgentRegistry'], ['dsh-system-prompt', 'SystemPrompt'], ['dsh-llm', 'LlmRuntime'],
  ['dsh-agent-loop', 'AgentLoop'], ['dsh-subagent', 'SubagentRuntime']]) ctx.plugin((await native(module))[name])
ctx.plugin(ToolRuntime)
ctx.plugin(await native('dsh-session-persistence-jsonl'), { root: path.join(home, 'sessions'), compression: 'none' })
// Match the installed base/SDK runtime's provider-owned, bounded request recovery.
ctx.plugin(await native('dsh-llm-retry'))
ctx.plugin(await native('dsh-subagent-spawn-in-process'))
ctx.plugin(await native('dsh-llm-pi-ai'), { providers: { [providerName]: provider } })
ctx.plugin((await native('dsh-skill')).default)
ctx.plugin(await native('dsh-skill-filesystem'), { providerName: 'delegation-first-plugin', includeDefaultRoots: false, bundledSkillDir: path.join(repository, 'skills') })
ctx.plugin(await native('dsh-tool-skill'))
  await until(() => ctx.get('agentLoop') && ctx.get('subagents') && ctx.get('llm') && ctx.get('skills') && ctx.get('sessionPersistence'), 'installed native services')
  ctx.tools.setExecutor(new NativeToolExecutor(ctx))
  ctx.systemPrompt.section({ name: 'acceptance-workspace', order: 10, text: () =>
    `你是软件工程助手。当前工作目录：${workspace}。根据用户目标自行选择工具并完成验证。文件工具只允许访问当前隔离工作目录和插件自带技能。按实际工具schema调用。需要帮助或遇到无法解决的错误时如实报告。` })
  const register = (name, description, parameters, execute) => ctx.tools.register(defineTool({ name, description, parameters,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      activities.push({ at: Date.now(), sessionId: exec.agent.id, tool: name, arguments: structuredClone(args), callId: exec.callId })
      const gatedFiles = scenario === 'parallel-supplement' ? ['fruit.json', 'fruit.txt'] : scenario === 'cancel-resume' ? ['a.json', 'a.txt'] : []
      if (gatedFiles.includes(path.basename(args.file_path ?? '')) && exec.agent.id !== 'root' && !supplementSent && !gateEntered) {
        gateEntered = true
        await Promise.race([gate.promise, new Promise((_, reject) => {
          if (exec.signal.aborted) reject(exec.signal.reason)
          else exec.signal.addEventListener('abort', () => reject(exec.signal.reason), { once: true })
        })])
      }
      return execute(args, exec)
    } }))
  register('read', '读取UTF-8文本文件，file_path可为当前目录相对路径或绝对路径。', {
    file_path: { type: 'string', required: true }, offset: { type: 'integer' }, limit: { type: 'integer' } }, async (args, exec) => {
    const target = readable(args.file_path)
    const text = await readFile(target, 'utf8'), lines = text.split('\n')
    return { file_path: target, text: lines.slice(args.offset ?? 0, args.limit ? (args.offset ?? 0) + args.limit : undefined).join('\n') }
  })
  register('write', '写入UTF-8文本文件，只能写当前任务目录。', {
    file_path: { type: 'string', required: true }, content: { type: 'string', required: true } }, async args => {
    const target = writable(args.file_path); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, args.content)
    return { file_path: target, written: true }
  })
  register('edit', '精确替换文本文件中的一处内容，找不到old_string时报错。', {
    file_path: { type: 'string', required: true }, old_string: { type: 'string', required: true }, new_string: { type: 'string', required: true } }, async args => {
    const target = writable(args.file_path), text = await readFile(target, 'utf8')
    assert.ok(text.includes(args.old_string), 'old_string was not found')
    await writeFile(target, text.replace(args.old_string, args.new_string)); return { file_path: target, edited: true }
  })
  register('glob', '列出当前任务目录中的文件。', { pattern: { type: 'string' } }, async () => ({ files: await readdir(workspace) }))
  register('grep', '在指定UTF-8文件中按正则表达式逐行查找文本。', { file_path: { type: 'string', required: true }, pattern: { type: 'string', required: true } },
    async args => { const pattern = new RegExp(args.pattern); return { matches: (await readFile(readable(args.file_path), 'utf8')).split('\n').filter(line => pattern.test(line)) } })
  const literalWorkspace = "'" + workspace.replaceAll("'", "''") + "'"
  const allowedCommands = new Set([
    `Microsoft.PowerShell.Management\\Get-ChildItem -LiteralPath ${literalWorkspace} -Force | Microsoft.PowerShell.Utility\\Select-Object -First 200 Name,Mode,Length`,
    `& (Microsoft.PowerShell.Core\\Get-Command git -CommandType Application | Microsoft.PowerShell.Utility\\Select-Object -First 1).Source --no-optional-locks -c core.fsmonitor=false --no-pager -C ${literalWorkspace} status --short --branch --untracked-files=normal | Microsoft.PowerShell.Utility\\Select-Object -First 200`,
  ])
  // These two read-only fixture checks are exact literals; do not allow arbitrary shell prefixes.
  const sumComparison = "$c=[System.IO.File]::ReadAllText((Join-Path (Get-Location) '__fixture__.txt')); $s=((Get-Content (Join-Path (Get-Location) '__fixture__.json') -Raw | ConvertFrom-Json) | Measure-Object -Sum).Sum; Write-Output (\"expected_sum=\" + $s); Write-Output (\"content=[\" + $c + \"]\"); Write-Output (\"length=\" + $c.Length); Write-Output (\"format_match=\" + ($c -eq (\"sum=\" + $s + \"`n\") -or $c -eq (\"sum=\" + $s + \"`r`n\")))"
  for (const fixture of ['a', 'b']) allowedCommands.add(sumComparison.replaceAll('__fixture__', fixture))
  register('pwsh', '仅支持 delegation_inspect 的固定只读命令，以及已审核的固定 a/b JSON 求和与全文比对命令；其他文件验证使用 read/grep。', {
    command: { type: 'string', required: true }, description: { type: 'string' } }, async args => {
    assert.ok(allowedCommands.has(args.command), 'The test shell only admits reviewed fixed read-only commands; use read/grep for other file checks')
    try {
      const output = await runFile('pwsh', ['-NoProfile', '-NonInteractive', '-Command', args.command], { cwd: workspace, windowsHide: true, timeout: 15000 })
      return { exitCode: 0, output: output.stdout + output.stderr }
    } catch (error) { return { exitCode: typeof error.code === 'number' ? error.code : 1, output: redact((error.stdout ?? '') + (error.stderr ?? '') || error.message) } }
  })
  const nativeStart = ctx.subagents.startActivation.bind(ctx.subagents)
  ctx.subagents.startActivation = async (...args) => {
    const receipt = await nativeStart(...args), dispose = receipt.dispose.bind(receipt)
    activations.push({ at: Date.now(), childId: receipt.childId, options: args[0].request.agentOptions, signal: args[0].signal })
    receipt.dispose = async () => { releases.push(receipt.childId); return dispose() }
    return receipt
  }
  ctx.on('llm/stream', (req, next) => {
    const record = { at: Date.now(), sessionId: req.sessionId, provider: req.provider, model: req.model, tools: req.tools?.map(tool => tool.name),
      agentrixPrompt: JSON.stringify(req.messages.filter(message => message.role === 'system')).includes('Agentrix') }
    requests.push(record)
    console.log(JSON.stringify({ event: 'request', count: requests.length, role: req.sessionId === 'root' ? 'coordinator' : 'worker/reviewer', model: req.model }))
    return (async function* () {
      if (scenario === 'failure-recovery' && req.sessionId !== 'root' && !faultInjected) {
        const task = (await state()).plans[0]?.tasks.find(task => task.childId === req.sessionId)
        if (task?.outputs.some(output => path.basename(output) === 'a.txt')) {
          faultInjected = true; record.injectedFault = true
          throw new LlmError('Acceptance injected refusal: Illegal API invocation from an unapproved channel', 'UNKNOWN')
        }
      }
      for await (const chunk of next()) yield chunk
    })()
  }, { global: true })
  ctx.on('session/event', async (session, event) => {
    events.push({ at: Date.now(), sessionId: session.id, type: event.type,
      ...(event.type === 'tool/call' ? { name: event.data.name, arguments: event.data.arguments } : {}),
      ...(event.type === 'tool/result' ? { result: structuredClone(event.data) } : {}),
      ...(event.type === 'turn/end' ? { reason: event.data.reason } : {}) })
    if (event.type === 'turn/end') console.log(JSON.stringify({ event: 'turn/end', role: session.id === 'root' ? 'coordinator' : 'child', reason: event.data.reason?.kind }))
    if (event.type === 'tool/call' && event.data.name.startsWith('delegation_')) console.log(JSON.stringify({ event: 'tool', name: event.data.name }))
  }, { global: true })
  if (scenario === 'rework') ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'delegation_verify' && !corrupted) {
      const task = (await state()).plans[0]?.tasks.find(task => task.id === exec.arguments.taskId)
      if (task?.outputs.some(output => path.basename(output) === 'a.txt')) {
        corruptedAttempt = task.attempts; corruptedTaskId = task.id; corruptionEventIndex = events.length
        await writeFile(path.join(workspace, 'a.txt'), 'sum=4\n'); corrupted = true
      }
    }
    return next()
  }, { global: true })
  apply(ctx)
  await until(() => routes.has('/dsh-delegation-first/api/state'), 'plugin state route')
  if (!resume) await request('config', { mode: 'auto', models: { worker: { provider: providerName, model: workerModel,
    ...(process.env.AGENTRIX_WORKER_EFFORT ? { reasoningEffort: process.env.AGENTRIX_WORKER_EFFORT } : {}) } } })
  handle = resume ? await ctx.agents.resume({ resumeSessionId: 'root', agentOptions: { provider: providerName, model: coordinatorModel } })
    : await ctx.agents.create({ sessionId: 'root', meta: { cwd: workspace }, agentOptions: { provider: providerName, model: coordinatorModel } })
  parent = handle.agent
}
try {
  await launchRuntime()
  let prompt
  if (simple) {
    await writeFile(path.join(workspace, 'notice.txt'), '状态：待确认\n备注：保持原样\n')
    prompt = scenario === 'direct' ? '把 notice.txt 中的“待确认”直接改为“已确认”，其他内容不要动，核对后告诉我结果。'
      : scenario === 'auto-readonly' ? '看一下 notice.txt，告诉我当前状态和备注，文件不要修改。'
        : '把 notice.txt 中的“待确认”改为“已确认”，其他内容不要动，核对后告诉我结果。'
  } else if (scenario === 'parallel-supplement') {
    await writeFile(path.join(workspace, 'fruit.json'), '{"apple":3,"banana":2,"cherry":1}\n')
    await writeFile(path.join(workspace, 'colors.json'), '{"blue":"#0000ff","red":"#ff0000"}\n')
    prompt = '两份数据互不依赖，请分别交给执行模型并行处理。把 fruit.json 转成 fruit.txt，把 colors.json 转成 colors.txt，按键名升序排列，每行写成 key=value，并在最后保留换行。核对两份结果后交付。'
  } else {
    await writeFile(path.join(workspace, 'a.json'), '[1,2]\n'); await writeFile(path.join(workspace, 'b.json'), '[3,4]\n')
    prompt = '请分别交给执行模型计算 a.json 和 b.json 两份数组的总和，生成 a.txt 和 b.txt，文件只写“sum=总数”并换行。两项独立并行处理，逐项核对后交付。' +
      (scenario === 'rework' ? 'a.txt 交付前还需要由独立审查者核对计算和格式，b.txt 由主控核对即可。' : '')
  }
  parent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
  if (scenario === 'parallel-supplement') {
    await until(() => activations.length >= 2 && gateEntered, 'parallel workers start before supplement')
    send('补充一下：fruit.txt 最后一行再加 total=6；colors.txt 保持刚才的要求。')
    supplementSent = true
    await until(async () => (await state()).plans[0]?.inputs?.some(input => input.text.includes('total=6') && input.status === 'forwarded'), 'supplement is associated and forwarded to its original worker')
    gate.resolve()
  } else if (scenario === 'failure-recovery') {
    await until(async () => faultInjected && (await planTask('b.txt'))?.status === 'accepted' && parent.status === 'idle', 'unrelated task is accepted while a is blocked')
    const before = await planTask('b.txt')
    assert.equal(before.attempts, 1, 'the service failure must not restart the unaffected sibling')
    result.preserved = { taskId: before.id, attempts: before.attempts, review: before.review, content: await readFile(path.join(workspace, 'b.txt'), 'utf8') }
    if ((await planTask('a.txt'))?.status !== 'accepted') send('失败原因已经处理，请继续失败的那项，已经验收的不要重做。')
    else result.assertions.push('The coordinator explicitly recovered the transient single-request failure without repeating the accepted sibling')
  } else if (scenario === 'cancel-resume') {
    await until(async () => gateEntered && (await planTask('b.txt'))?.status === 'accepted', 'b accepted while a remains active')
    const before = await planTask('b.txt')
    result.preserved = { taskId: before.id, attempts: before.attempts, review: before.review }
    send('先取消剩余工作，已经完成的保留。')
    await until(async () => {
      const plan = (await state()).plans[0]
      return parent.status === 'idle' && plan?.tasks.every(task => task.status === 'accepted' ||
        task.status === 'cancelled' && ['released', 'drained', 'none'].includes(task.release?.status))
    }, 'the requested remaining work is cancelled and its native resources are released')
    const stopped = await planTask('a.txt'), originalActivation = activations.find(item => item.childId === stopped.childId)
    assert.ok(originalActivation?.signal.aborted, 'user cancellation must abort the original activation before test teardown')
    assert.equal(releases.filter(childId => childId === stopped.childId).length, 1, 'cancellation itself releases the original activation once')
    result.assertions.push('Cancellation stopped native activations and confirmed resource cleanup')
    supplementSent = true; gate.resolve()
    const activationCount = activations.length
    await handle.dispose(); handle = null
    await ctx.fiber.dispose(); while (ctx.fiber.inertia) await ctx.fiber.inertia
    await launchRuntime(true)
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(activations.length, activationCount, 'reloading a cancelled plan must not restart work')
    const reloaded = await state(), reloadedPlan = reloaded.plans[0]
    assert.equal(reloadedPlan.tasks.find(task => task.id === stopped.id).status, 'cancelled')
    assert.ok(reloadedPlan.tasks.every(task => task.status === 'accepted' || task.status === 'cancelled' && !task.recovered))
    if (reloadedPlan.cancellation) assert.equal(reloadedPlan.cancellation.cleanup.status, 'completed')
    result.assertions.push('The native session and plugin state reloaded from the same profile without automatic dispatch')
    send('现在恢复刚才取消的那项，已经验收的不要重做。')
  }
  if (scenario === 'auto-followup') {
    await settled()
    send('再把备注改为“已复核”，状态保持“已确认”，其他内容不变。')
  }
  const final = await settled()
  await ctx.sessions.flush(parent.session)
  check('Loaded runtime matches the tested source', () => assert.equal(final.runtimeBuild, RUNTIME_BUILD))
  check('All actual requests use the selected provider and role models', () => {
    assert.ok(requests.length > 0)
    assert.ok(requests.every(req => req.provider === providerName && req.model === (req.sessionId === 'root' ? coordinatorModel : activations.find(item => item.childId === req.sessionId)?.options.model)))
    assert.ok(activations.every(item => [workerModel, coordinatorModel].includes(item.options.model)))
  })
  if (simple) {
    const content = await readFile(path.join(workspace, 'notice.txt'), 'utf8')
    const expected = scenario === 'auto-readonly' ? '状态：待确认\n备注：保持原样\n' : scenario === 'auto-followup' ? '状态：已确认\n备注：已复核\n' : '状态：已确认\n备注：保持原样\n'
    check('The file exactly matches the user request', () => assert.equal(content, expected))
    check('The small task stays with the coordinator without a child activation', () => assert.equal(activations.length, 0))
    if (scenario === 'auto-readonly') check('The read-only request reads the file, answers its fields and performs no mutations', () => {
      assert.ok(activities.some(item => item.tool === 'read' && path.basename(item.arguments.file_path) === 'notice.txt'))
      assert.ok(!activities.some(item => ['edit', 'write'].includes(item.tool)))
      const answer = parent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
        .flatMap(event => event.data.message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')
      assert.ok(answer.includes('待确认') && answer.includes('保持原样'))
    })
    else check('The coordinator read the edited file after its mutation', () => {
        const mutation = activities.findLastIndex(item => ['edit', 'write'].includes(item.tool))
        assert.ok(mutation >= 0 && activities.slice(mutation + 1).some(item => item.tool === 'read' && path.basename(item.arguments.file_path) === 'notice.txt'))
      })
    assert.deepEqual(await readdir(workspace), ['notice.txt'])
  } else {
    const plan = final.plans[0]
    check('All managed tasks are accepted with a completed receipt', () => assert.equal(plan?.completion?.outcome, 'completed', JSON.stringify(plan?.completion ?? null)))
    check('The delivery is committed once in the native journal', () => {
      assert.equal(plan.delivery?.status, 'delivered')
      assert.equal(parent.session.snapshotEvents().filter(event =>
        event.type === 'deliverables/presented' && event.data?.messageId === plan.delivery.messageId ||
        event.type === 'developer/message' && event.data?.message?.id === plan.delivery.messageId).length, 1)
    })
    check('Every task has this-attempt verification evidence', () => {
      for (const task of plan.tasks) {
        assert.equal(task.status, 'accepted'); assert.ok(task.review?.findings?.length)
        const evidence = new Set(task.checks.filter(check => check.result?.passed === true && check.result.attempt === task.attempts)
          .flatMap(check => [check.result.callId, check.result.ref]))
        for (const finding of task.review.findings) assert.ok(finding.evidence.length && finding.evidence.every(ref => evidence.has(ref)))
      }
    })
    if (scenario === 'parallel-supplement') {
      assert.equal(await readFile(path.join(workspace, 'fruit.txt'), 'utf8'), 'apple=3\nbanana=2\ncherry=1\ntotal=6\n')
      assert.equal(await readFile(path.join(workspace, 'colors.txt'), 'utf8'), 'blue=#0000ff\nred=#ff0000\n')
      check('Supplement reused the original plan and workers', () => assert.equal(activations.filter(item => item.options.model === workerModel).length, 2))
    } else {
      assert.equal(await readFile(path.join(workspace, 'a.txt'), 'utf8'), 'sum=3\n')
      assert.equal(await readFile(path.join(workspace, 'b.txt'), 'utf8'), 'sum=7\n')
      if (scenario === 'rework') check('Injected wrong artifact was detected and reworked', () => {
        assert.ok(corrupted)
        const repaired = plan.tasks.find(task => task.id === corruptedTaskId)
        assert.ok(repaired.attempts > corruptedAttempt)
        assert.equal(repaired.audit?.status, 'completed')
        assert.equal(repaired.audit.modelRoute.actual.model, coordinatorModel)
        assert.equal(plan.tasks.find(task => task.outputs.some(output => path.basename(output) === 'b.txt')).attempts, 1)
        assert.ok(events.slice(corruptionEventIndex).some(event => {
          if (event.name !== 'delegation_review') return false
          const args = typeof event.arguments === 'string' ? JSON.parse(event.arguments) : event.arguments
          return args.taskId === corruptedTaskId && args.verdict === 'rework'
        }))
      })
      if (result.preserved) check('The accepted sibling was not redone', () => {
        const sibling = plan.tasks.find(task => task.id === result.preserved.taskId)
        assert.equal(sibling.attempts, result.preserved.attempts); assert.deepEqual(sibling.review, result.preserved.review)
      })
    }
  }
  result.passed = true; result.finalState = final
} catch (error) {
  result.error = redact(error.stack ?? error)
  try { result.finalState = await state() } catch {}
  process.exitCode = 1
} finally {
  closing = true; gate.resolve()
  const teardownErrors = []
  try { await handle?.dispose() } catch (error) { teardownErrors.push(redact(error.stack ?? error)) }
  try { await ctx?.fiber.dispose(); while (ctx?.fiber.inertia) await ctx.fiber.inertia } catch (error) { teardownErrors.push(redact(error.stack ?? error)) }
  if (teardownErrors.length) {
    result.passed = false; result.teardownErrors = teardownErrors; process.exitCode = 1
  }
  result.durationMs = Date.now() - started
  result.requests = requests; result.activations = activations.map(({ signal, ...item }) => ({ ...item, aborted: signal.aborted }))
  result.releases = releases; result.activities = activities; result.events = events
  result.usage = result.finalState?.requestUsage
  const evidence = process.env.AGENTRIX_LIVE_RESULT
  if (evidence) { await mkdir(path.dirname(evidence), { recursive: true }); await writeFile(evidence, redact(JSON.stringify(result, null, 2))) }
  console.log(JSON.stringify({ scenario, passed: result.passed, durationMs: result.durationMs, requests: requests.length, activations: activations.length,
    assertions: result.assertions, ...(result.error ? { error: result.error } : {}),
    ...(result.teardownErrors ? { teardownErrors: result.teardownErrors } : {}), ...(evidence ? { evidence } : {}) }))
  const resolved = await realpath(temporary)
  assert.ok(resolved === resolvedTemporary && contained(await realpath(os.tmpdir()), resolved), 'Cleanup must target the task-created temporary directory')
  await rm(temporary, { recursive: true, force: true })
}
