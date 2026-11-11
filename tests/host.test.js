import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-delegation-test-'))
const previous = { home: process.env.DSH_HOME, mode: process.env.DSH_DELEGATION_FIRST }
let homeSequence = 0
beforeEach(() => { process.env.DSH_HOME = path.join(home, 'host-' + ++homeSequence); process.env.DSH_DELEGATION_FIRST = 'auto' })
after(async () => {
  for (const [key, value] of [['DSH_HOME', previous.home], ['DSH_DELEGATION_FIRST', previous.mode]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
  await rm(home, { recursive: true, force: true })
})

export async function host() {
  const listeners = new Map(), routes = new Map(), definitions = new Map(), cleanups = []
  let guard
  const injections = [], agent = { id: 'root', options: { provider: 'local', model: 'coordinator' }, inject: message => injections.push(message) }
  const sessions = { get: id => ({ header: id === 'worker' ? { origin: 'subagent', parentSession: 'root' } : { title: '便签保存内容丢失排查' } }) }
  const sessionTitle = { get: session => ({ title: session?.header?.title }) }
  const emit = (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn(...args) }
  const ctx = {
    tools: {
      guard(fn) { guard = fn; return () => {} },
      get: name => definitions.get(name) ?? (name === 'subagent' ? {} : undefined),
      schemas: () => ['subagent', 'read', 'grep', 'glob', 'pwsh'].map(name => ({ name })).concat([...definitions.keys()].map(name => ({ name }))),
      register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) },
    },
    get(name) { return { sessions, sessionTitle, agents: { list: () => [], get: id => id === 'root' ? agent : undefined }, webServer: ctx.webServer,
      llm: { async resolveCallConfig(route) {
        if (route.provider === 'retired') throw Object.assign(new Error('no adapter registered for provider "retired"'), { code: 'NO_ADAPTER' })
        return { config: { ...route }, modelInfo: { id: route.model } }
      } } }[name] },
    webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn) },
    inject(deps, fn) { fn(ctx) },
    effect(fn) { const dispose = fn(); if (dispose) cleanups.push(dispose); return dispose },
  }
  apply(ctx)
  const state = async (sessionId = null) => {
    let body
    await routes.get('/dsh-delegation-first/api/state')({ method: 'GET', ...(sessionId ? { url: '/dsh-delegation-first/api/state?sessionId=' + sessionId } : {}) }, { writeHead() {}, end(text) { body = JSON.parse(text) } })
    return body.sessions.find(row => row.sessionId === 'root')
  }
  let turn = 0
  return {
    ctx, agent, definitions, emit, state, routes, injections,
    decide(reason = '本次范围已明确，主控直接完成后核对实际产物和验证结果。', relation = 'new') {
      return definitions.get('delegation_decide').execute({ relation, mode: 'direct', reason }, { agent, callId: 'decide-direct', signal: new AbortController().signal })
    },
    async stopping(signal = new AbortController().signal, who = agent) {
      for (const fn of listeners.get('agent/turn-stopping') ?? []) await fn({ agent: who, signal })
    },
    turn(text, messageId = String(++turn)) {
      emit('session/event', { id: 'root' }, { type: 'agent/inbox/spliced', data: { inserted: [{ id: messageId, source: { kind: 'user' }, content: [{ type: 'text', text }] }] } })
      emit('session/event', { id: 'root' }, { type: 'turn/start', data: { turn } })
    },
    call(name, id = 'call', who = agent, args = {}) { return guard({ name, callId: id, agent: who, arguments: args, signal: new AbortController().signal }) },
    stream(request, next) {
      const hooks = [...(listeners.get('llm/stream') ?? [])]
      const run = index => index < hooks.length ? hooks[index](request, () => run(index + 1)) : next()
      return run(0)
    },
    result(name, result, id = 'call') { emit('tools/result', { name, callId: id, agent }, result) },
    async request(method, body) {
      let status, payload
      await routes.get('/dsh-delegation-first/api/config')({ method, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } },
        { writeHead(code) { status = code }, end(text) { payload = JSON.parse(text) } })
      return { status, payload }
    },
    async close() { for (const fn of cleanups.reverse()) await fn() },
  }
}

const complex = '1. 重构所有模块并且迁移数据\n2. 批量修复接口同时补充测试套件'

test('a new direct request can write unrelated files while the previous plan keeps its deliverables protected', async () => {
  const h = await host(); await h.state()
  try {
    h.turn('生成原需求产物', 'old-demand')
    await h.definitions.get('delegation_plan').execute({ goal: '生成原需求产物', relation: 'new', decisionReason: '原任务交给执行模型。',
      tasks: [{ id: 'old', title: '原任务', instructions: '生成 old.js', scope: 'old.js', outputs: ['old.js'], writes: ['old.js'],
        complexity: 'routine', criteria: ['文件存在'], checks: [{ tool: 'read', arguments: { file_path: 'old.js' } }] }] }, { agent: h.agent, callId: 'plan-old' })
    h.turn('另外修改独立便签', 'new-demand')
    await h.decide('新需求仅修改另一份便签，主控直接处理。', 'new')
    assert.equal(h.call('write', 'new-write', h.agent, { file_path: 'new-note.md' }), undefined)
    assert.match(h.call('edit', 'overlapping-write', h.agent, { file_path: 'old.js' }), /原需求|另一项需求/)
    h.result('write', { isError: true, content: [{ type: 'text', text: 'new-note.md write failed' }] }, 'new-write')
    await h.stopping()
    assert.ok(h.injections.some(message => message.source.kind === 'delegation-direct-recovery'), 'the new request retains direct-write recovery')
    assert.equal(h.injections.filter(message => message.source.kind === 'delegation-recovery').length, 0, 'finishing the new request must not force recovery of the previous plan')
    const result = await new Promise(resolve => h.routes.get('/dsh-delegation-first/api/state')({ method: 'GET', url: '/dsh-delegation-first/api/state?sessionId=root' },
      { writeHead() {}, end(text) { resolve(JSON.parse(text)) } }))
    assert.equal(result.plans[0].source.messageId, 'old-demand')
    assert.equal(result.plans[0].tasks[0].status, 'queued')
    assert.equal(result.sessions[0].source.messageId, 'new-demand')
  } finally { await h.close() }
})

test('host guards and request tools share managed coordination policy, including denied writes', async () => {
  const h = await host(); await h.state()
  const tools = ['read', 'list_agents', 'team_task_list', 'team_task_create', 'team_task_update', 'wait_agent'].map(name => ({ name }))
  let denied = new Set()
  h.ctx.tools.view = () => ({ restrictableNames: new Set(tools.map(tool => tool.name)) })
  h.agent.ctx = { tools: { restrict({ deny }) { denied = new Set(deny); return () => { denied.clear() } } } }
  try {
    h.turn('开发独立接口调试工具')
    await h.definitions.get('delegation_plan').execute({ goal: '交付可验证的独立工具', relation: 'new', decisionReason: '实现交给执行模型，主控检查交付物。',
      tasks: [{ id: 'a', title: '实现页面', instructions: '只修改工具文件', scope: '隔离工具', outputs: ['tool.html'], writes: ['tool.html'],
        dependsOn: [], complexity: 'routine', criteria: ['文件可读取'], checks: [{ tool: 'read', arguments: { file_path: 'tool.html' } }] }] },
    { agent: h.agent, callId: 'plan-coordination' })
    assert.deepEqual([...denied], ['team_task_create', 'team_task_update', 'wait_agent'])
    const request = Object.freeze({ sessionId: 'root', provider: 'local', model: 'coordinator', tools: Object.freeze(tools.filter(tool => !denied.has(tool.name))) })
    let dispatched
    h.stream(request, () => { dispatched = request.tools })
    assert.deepEqual(dispatched.map(tool => tool.name), ['read', 'list_agents', 'team_task_list'])
    assert.equal(tools.length, 6, 'scoped restrictions do not mutate the host tool registry')
    assert.match(h.call('team_task_update', 'board-complete', h.agent, { action: 'complete' }), /Agentrix/)
    assert.match(h.call('write', 'denied-write', h.agent, { file_path: 'tool.html' }), /尚未验收/)
    const response = await new Promise(resolve => h.routes.get('/dsh-delegation-first/api/state')({ method: 'GET', url: '/dsh-delegation-first/api/state?sessionId=root' },
      { writeHead() {}, end(text) { resolve(JSON.parse(text)) } }))
    assert.equal(response.coordinationPolicyVersion, 2)
    assert.equal(response.plans[0].coordinationIssue.callId, 'denied-write')
    assert.equal(response.plans[0].completion, null)
    assert.equal(h.call('team_task_list'), undefined)
    assert.equal(h.call('team_task_create', 'unrelated', { id: 'other' }), undefined)
  } finally { await h.close() }
})

test('the coordinator classifies message relationships without prefix or length guesses', async () => {
  const h = await host(); await h.state()
  const decide = args => h.definitions.get('delegation_decide').execute(args,
    { agent: h.agent, callId: 'classify', signal: new AbortController().signal })
  try {
    h.turn('修复页面标题')
    assert.equal((await h.state()).source, null, 'a received message is not yet an assigned request')
    await decide({ relation: 'new', mode: 'direct', reason: '仅一处标题，修改后读取核对。' })
    const first = (await h.state()).decision
    h.turn('继续完善这个任务')
    assert.equal((await h.state()).source.messageId, '1')
    assert.equal((await h.state()).pendingMessages[0].messageId, '2')
    await decide({ relation: 'continue' })
    assert.deepEqual((await h.state()).decision, first)
    assert.equal(h.call('edit'), undefined)
    h.turn('另外开一个新任务：排查数据库慢查询')
    assert.equal((await h.state()).source.messageId, '1', 'prefixes cannot silently assign or switch requests')
    await decide({ relation: 'new', mode: 'direct', reason: '先读取查询与执行计划，定位后再决定是否委派。' })
    assert.equal((await h.state()).source.messageId, '3')
    const next = (await h.state()).decision
    h.turn('现在进度怎么样')
    await decide({ relation: 'question' })
    assert.deepEqual((await h.state()).decision, next)
    assert.equal((await h.state()).messageResolution.relation, 'question')
    assert.equal((await h.state()).route, null)
    assert.equal((await h.state()).difficulty, null)
  } finally { await h.close() }
})

test('usage before classification stays unassigned, survives reload and follows the model-confirmed request', async () => {
  let h = await host(); await h.state()
  const decide = args => h.definitions.get('delegation_decide').execute(args, { agent: h.agent, callId: 'decide', signal: new AbortController().signal })
  const usage = async () => {
    let body
    await h.routes.get('/dsh-delegation-first/api/state')({ method: 'GET', url: '/dsh-delegation-first/api/state?sessionId=root' }, { writeHead() {}, end(text) { body = JSON.parse(text) } })
    return body.requestUsage[0]
  }
  const event = (seq, tokens) => {
    h.emit('llm/stream', { sessionId: 'root', provider: 'local', model: 'coordinator' }, () => {})
    h.emit('session/event', { id: 'root' }, { type: 'assistant/message', seq, data: { usage: { inputTokens: tokens, outputTokens: 5 } } })
  }
  try {
    h.turn('修复标题'); event(1, 100)
    assert.equal(await usage(), undefined)
    await h.close(); h = await host(); await h.state('root')
    await decide({ relation: 'new', mode: 'direct', reason: '定位标题后修改并验证。' })
    assert.equal((await usage()).roles[0].inputTokens, 100)
    h.turn('进度如何', '2'); event(2, 20)
    assert.equal((await usage()).roles[0].inputTokens, 100)
    await decide({ relation: 'question' })
    assert.equal((await usage()).roles[0].inputTokens, 120)
    h.turn('另外做一个新需求', '3'); event(3, 200)
    await decide({ relation: 'new', mode: 'direct', reason: '先读取新需求涉及文件，再执行和核对。' })
    assert.equal((await usage()).requestId, '3')
    assert.equal((await usage()).roles[0].inputTokens, 200)
    assert.equal((await usage()).roles[0].requests, 1)
  } finally { await h.close() }
})

test('multiple pending messages require an actual message id rather than silently choosing the latest', async () => {
  const h = await host(); await h.state(); h.turn('修复接口'); h.turn('可以开始')
  const decide = args => h.definitions.get('delegation_decide').execute(args, { agent: h.agent })
  try {
    await assert.rejects(decide({ relation: 'new', mode: 'direct', reason: '读取接口后修复并验证。' }), /messageId/)
    await decide({ messageId: '1', relation: 'new', mode: 'direct', reason: '读取接口后修复并验证。' })
    assert.equal((await h.state()).source.messageId, '1')
    await decide({ messageId: '2', relation: 'continue' })
    assert.equal((await h.state()).decisionCurrent, true)
  } finally { await h.close() }
})

test('a new plan must bind the actual request before it is saved, with inline confirmation supported', async () => {
  const h = await host(); await h.state(); h.turn('核对指定文件')
  const args = { goal: '核对文件', tasks: [{ id: 'check', title: '核对文件', instructions: '读取指定文件', scope: '仅当前文件', outputs: ['fixture.txt'], writes: [], complexity: 'routine', criteria: ['文件存在'], checks: [{ tool: 'read', arguments: { path: 'fixture.txt' } }] }] }
  const execute = values => h.definitions.get('delegation_plan').execute(values, { agent: h.agent })
  try {
    await assert.rejects(execute(args), /关联/)
    const result = await execute({ ...args, relation: 'new', decisionReason: '执行者核对文件，主控验证和验收。' })
    assert.equal(result.plan.source.messageId, '1')
    assert.equal(result.plan.decision.requestId, '1')
  } finally { await h.close() }
})

test('business execution requires an explicit decision; ordinary assistant text never supplies the reason', async () => {
  process.env.DSH_HOME = path.join(home, 'explicit-decision')
  const h = await host(); await h.state()
  h.agent.options = { provider: 'local', model: 'coordinator-high' }
  try {
    h.turn('修复文章中的错别字')
    assert.equal(h.call('read', 'prepare'), undefined)
    h.emit('session/event', { id: 'root' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '文档已全部修改完成。' }] } } })
    assert.match(h.call('edit', 'before-decision'), /delegation_decide/)
    assert.equal((await h.state()).decision, null)
    const recorded = await h.definitions.get('delegation_decide').execute({ mode: 'direct', reason: '仅修改已定位的一处错字，主控改完读取核对即可。' },
      { agent: h.agent, callId: 'decide', signal: new AbortController().signal })
    assert.equal(recorded.decision.mode, 'direct')
    assert.equal(h.call('edit', 'after-decision'), undefined)
    const state = await h.state()
    assert.equal(state.decision.reason, '仅修改已定位的一处错字，主控改完读取核对即可。')
    assert.equal(state.decision.requestId, '1')
    assert.equal(state.decision.model.model, 'coordinator-high')
    assert.equal(state.turnStats.delegated, 0)
  } finally { await h.close() }
})

test('model-confirmed relationships survive reload and only an explicit new request clears old scope', async () => {
  process.env.DSH_HOME = path.join(home, 'decision-scope')
  let h = await host(); await h.state()
  const decide = args => h.definitions.get('delegation_decide').execute(args, { agent: h.agent, callId: 'decision', signal: new AbortController().signal })
  try {
    h.turn('修改文章中的一处错字')
    await h.decide('已定位一处错字，直接修改并读取验证即可。')
    const original = (await h.state()).decision
    h.turn('可以，开始执行')
    await decide({ relation: 'continue' })
    assert.equal(h.call('edit'), undefined)
    assert.deepEqual((await h.state()).decision, original)
    await h.close(); h = await host(); await h.state('root')
    h.agent.options.model = 'another-high'
    assert.deepEqual((await h.state()).decision, original)
    h.turn('还要同步调整另一个文档', '3')
    assert.equal((await h.state()).source.messageId, original.requestId)
    assert.match(h.call('edit'), /delegation_decide/)
    await decide({ relation: 'update', mode: 'direct', reason: '补充后共两处对应文字，直接修改后逐一读取核对。' })
    assert.equal((await h.state()).decision.model.model, 'another-high')
    assert.equal(h.call('edit'), undefined)
    h.turn('排查另一个项目的登录错误', '4')
    assert.equal((await h.state()).source.messageId, original.requestId)
    await decide({ relation: 'new', mode: 'direct', reason: '新项目先读取登录实现再定位错误。' })
    assert.equal((await h.state()).source.messageId, '4')
  } finally { await h.close() }
})

test('a missing decision resumes the original coordinator once, with the limit surviving reload and cancellation', async () => {
  process.env.DSH_HOME = path.join(home, 'decision-recovery')
  let h = await host(); await h.state()
  try {
    h.turn('只读核对当前文档')
    h.call('read', 'inspection')
    await h.stopping()
    assert.equal(h.injections.length, 1)
    assert.match(h.injections[0].content[0].text, /delegation_decide/)
    assert.equal(h.injections[0].source.kind, 'delegation-decision-recovery')
    await h.stopping()
    assert.equal(h.injections.length, 1)
    await h.close(); h = await host(); await h.state()
    h.turn('继续'); h.call('read', 'inspection-again')
    await h.stopping()
    assert.equal(h.injections.length, 0, 'reload must not reset the automatic recovery limit')
    h.turn('检查另一份文件')
    h.call('read')
    const abort = new AbortController(); abort.abort()
    await h.stopping(abort.signal)
    assert.equal(h.injections.length, 0)
  } finally { await h.close() }
})

test('a pending or failed decision save never permits business execution, even without native delegation tools', async () => {
  const h = await host(); await h.state(); h.turn('修复指定文档的错字')
  const configuration = (await h.request('GET')).payload
  const runsFile = configuration.file.replace(/\.json$/, '.runs.json')
  try {
    const nativeGet = h.ctx.tools.get
    h.ctx.tools.get = name => name === 'subagent' ? undefined : nativeGet(name)
    const schemas = h.ctx.tools.schemas
    h.ctx.tools.schemas = () => schemas().filter(tool => tool.name !== 'subagent')
    assert.match(h.call('edit'), /delegation_decide/)
    await mkdir(runsFile, { recursive: true })
    await assert.rejects(h.decide())
    assert.equal((await h.state()).decision, null)
    assert.match(h.call('edit'), /delegation_decide/)
    await rmdir(runsFile)
    const saving = h.decide()
    assert.match(h.call('edit', 'while-saving'), /delegation_decide/)
    await saving
    assert.equal(h.call('edit', 'saved'), undefined)
  } finally { await h.close() }
})

test('direct execution exposes current activity without creating a managed plan or changing routing', async () => {
  const h = await host(); await h.state()
  try {
    h.turn('评审文章并改写后生成分享文档')
    const route = (await h.state()).route
    h.call('read', 'read-article', h.agent, { file_path: 'article.md' })
    let state = await h.state()
    assert.equal(state.execution.running, true)
    assert.equal(state.execution.toolCalls, 1)
    assert.equal(state.execution.activity.kind, 'tool')
    assert.equal(state.execution.activity.target, 'article.md')
    h.result('read', { isError: false, content: [] }, 'read-article')
    state = await h.state()
    assert.equal(state.execution.activity.kind, 'waiting_model')
    assert.equal(state.execution.lastResult.tool, 'read')
    assert.equal(state.route, route)
    assert.equal(state.turnStats.delegated, 0)
    h.emit('session/event', { id: 'root' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    assert.equal((await h.state()).execution.running, false)
  } finally { await h.close() }
})

test('actual request tool removal and restoration are visible without blocking direct work', async () => {
  const h = await host(); await h.state(); h.turn('生成分享文档')
  await h.decide('当前委派入口不可用，主控生成文档并核对交付内容。')
  const tools = [...h.definitions.keys()].map(name => ({ name }))
  const header = tools => h.emit('session/event', { id: 'root' }, { type: 'request/header', data: { header: { tools } } })
  try {
    header([{ name: 'read' }])
    let state = await h.state()
    assert.equal(state.delegationAvailability.status, 'unavailable')
    assert.ok(state.delegationAvailability.missingTools.includes('delegation_plan'))
    assert.equal(h.call('edit', 'direct-allowed', h.agent, { file_path: 'article.md' }), undefined)
    header(tools)
    state = await h.state()
    assert.equal(state.delegationAvailability.status, 'available')
    assert.deepEqual(state.delegationAvailability.missingTools, [])
  } finally { await h.close() }
})

test('failed edits survive unrelated success and a completion claim, then prompt the same coordinator once', async () => {
  const h = await host(); await h.state(); h.turn('修改文章案例')
  await h.decide()
  try {
    h.call('edit', 'failed-edit', h.agent, { file_path: 'article.md' })
    h.result('edit', { isError: true, content: [{ type: 'text', text: 'Error: old_string was not found in article.md' }] }, 'failed-edit')
    h.call('read', 'read-back', h.agent, { file_path: 'article.md' })
    h.result('read', { isError: false, content: [] }, 'read-back')
    h.call('write', 'other-document', h.agent, { file_path: 'other.md' })
    h.result('write', { isError: false, content: [] }, 'other-document')
    h.emit('session/event', { id: 'root' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已全部修改完成。' }] } } })
    await h.stopping()
    assert.equal(h.injections.length, 1)
    assert.match(JSON.stringify(h.injections[0]), /article\.md.*old_string|old_string.*article\.md/)
    await h.stopping()
    assert.equal(h.injections.length, 1, 'never repeatedly wake the coordinator')
    assert.equal((await h.state()).execution.unresolvedChanges.length, 1)
    h.call('edit', 'correct-edit', h.agent, { file_path: 'ARTICLE.md' })
    h.result('edit', { isError: false, content: [] }, 'correct-edit')
    assert.deepEqual((await h.state()).execution.unresolvedChanges, [])
    await h.stopping()
    assert.equal(h.injections.length, 1)
  } finally { await h.close() }
})

test('cancellation and worker turns never trigger direct-edit recovery', async () => {
  const h = await host(); await h.state(); h.turn('修改文章案例')
  await h.decide()
  try {
    h.call('edit', 'failed-edit', h.agent, { file_path: 'article.md' })
    h.result('edit', { isError: true, content: [{ type: 'text', text: 'missing old string' }] }, 'failed-edit')
    const controller = new AbortController(); controller.abort()
    await h.stopping(controller.signal)
    await h.stopping(undefined, { id: 'worker' })
    assert.equal(h.injections.length, 0)
  } finally { await h.close() }
})

test('direct failures and the repair allowance follow continuations but never leak into a new request', async () => {
  const h = await host(); await h.state(); h.turn('修改文章案例')
  await h.decide()
  try {
    h.call('edit', 'failed-edit', h.agent, { file_path: 'article.md' })
    h.result('edit', { isError: true, content: [{ type: 'text', text: 'old_string was not found' }] }, 'failed-edit')
    await h.stopping()
    h.turn('继续')
    await h.decide(undefined, 'continue')
    let state = await h.state()
    assert.equal(state.execution.unresolvedChanges.length, 1)
    assert.equal(state.execution.repairUsed, 1)
    await h.stopping()
    assert.equal(h.injections.length, 1)
    h.turn('请核对另一份采购合同')
    await h.decide()
    state = await h.state()
    assert.deepEqual(state.execution.unresolvedChanges, [])
    assert.equal(state.execution.repairUsed, 0)
  } finally { await h.close() }
})

test('policy denials are not recorded as attempted file changes or direct execution failures', async () => {
  process.env.DSH_DELEGATION_FIRST = 'strict'
  const h = await host(); await h.state(); h.turn('修改文章案例')
  try {
    const denial = h.call('edit', 'policy-denied', h.agent, { file_path: 'article.md' })
    assert.match(denial, /先建立任务卡/)
    h.result('edit', { isError: true, content: [{ type: 'text', text: denial }] }, 'policy-denied')
    assert.equal((await h.state()).execution.toolCalls, 0)
    assert.deepEqual((await h.state()).execution.unresolvedChanges, [])
    await h.stopping()
    assert.equal(h.injections.length, 0)
  } finally { await h.close() }
})

test('state includes the current DSH conversation title', async () => {
  const h = await host(); h.turn('修改页面标题')
  assert.equal((await h.state()).sessionTitle, '便签保存内容丢失排查')
  await h.close()
})

test('obsolete reviewer settings are inert and config saves expose the dispatcher-snapshot policy', async () => {
  delete process.env.DSH_DELEGATION_FIRST
  process.env.DSH_HOME = path.join(home, 'automatic-review-model')
  const h = await host()
  try {
    const initial = (await h.request('GET')).payload
    assert.equal(initial.reviewerModelPolicy, 'dispatcher-snapshot')
    const saved = await h.request('POST', { models: { worker: { provider: 'local', model: 'worker' },
      reviewer: { provider: 'retired', model: 'unavailable' }, complex: { invalid: true } } })
    assert.equal(saved.status, 200, saved.payload.error)
    assert.deepEqual(saved.payload.models, { worker: { provider: 'local', model: 'worker' }, reviewer: null })
    const stored = JSON.parse(await readFile(saved.payload.file, 'utf8'))
    assert.equal(stored.models.reviewer, null)
    assert.equal(stored.models.complex, undefined)
  } finally { await h.close() }
})

test('auto routing is advice and never forces a handoff from keywords or operation counts', async () => {
  const h = await host(); await h.state()
  try {
    for (const text of ['修复这一行的空指针', complex]) {
      h.turn(text)
      await h.decide()
      for (let i = 0; i < 20; i++) {
        assert.equal(h.call('read', `read-${i}`), undefined)
        assert.equal(h.call('edit', `edit-${i}`, h.agent, { file_path: `src/${i}.js` }), undefined)
        assert.equal(h.call('pwsh', `verify-${i}`), undefined)
      }
      assert.equal((await h.state()).turnStats.denied, 0)
    }
    assert.match(h.call('subagent'), /delegation_plan/)
  } finally { await h.close() }
})

test('expanded execution limits are authoritative, persist, and reject values above their ranges', async () => {
  delete process.env.DSH_DELEGATION_FIRST
  process.env.DSH_HOME = path.join(home, 'expanded-limits')
  const h = await host()
  try {
    const defaults = { maxParallel: 4, maxAttempts: 5, maxActivations: 64, taskTimeoutMinutes: 120 }
    const maxima = { maxParallel: 8, maxAttempts: 10, maxActivations: 256, taskTimeoutMinutes: 240 }
    const initial = (await h.request('GET')).payload
    for (const [key, value] of Object.entries(defaults)) {
      assert.equal(initial[key], value, key)
      assert.equal(initial.defaults[key], value, key + ' default')
      assert.deepEqual(initial.ranges[key], { min: 1, max: maxima[key] }, key + ' range')
    }
    const limits = { maxParallel: 6, maxAttempts: 6, maxActivations: 128, taskTimeoutMinutes: 180 }
    const saved = await h.request('POST', limits)
    assert.equal(saved.status, 200)
    const stored = JSON.parse(await readFile(saved.payload.file, 'utf8'))
    for (const [key, value] of Object.entries(limits)) {
      assert.equal(saved.payload[key], value, key)
      assert.equal(stored[key], value, key + ' persisted')
      assert.equal((await h.request('POST', { [key]: maxima[key] + 1 })).status, 400, key + ' upper bound')
    }
  } finally { await h.close() }
})

test('new defaults preserve explicitly saved lower execution limits without rewriting them', async () => {
  delete process.env.DSH_DELEGATION_FIRST
  process.env.DSH_HOME = path.join(home, 'saved-limits')
  const h = await host()
  try {
    const file = (await h.request('GET')).payload.file
    const limits = { maxParallel: 2, maxAttempts: 3, maxActivations: 8, taskTimeoutMinutes: 60 }
    const original = JSON.stringify({ version: 3, mode: 'auto', ...limits })
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, original)
    const config = (await h.request('GET')).payload
    for (const [key, value] of Object.entries(limits)) assert.equal(config[key], value, key)
    assert.equal(config.defaults.maxActivations, 64)
    assert.equal(config.defaults.taskTimeoutMinutes, 120)
    assert.equal(await readFile(file, 'utf8'), original)
  } finally { await h.close() }
})

test('legacy execution settings migrate and obsolete review overrides are inert without rewriting the file on read', async () => {
  delete process.env.DSH_DELEGATION_FIRST
  const h = await host()
  try {
    const initial = await h.request('GET')
    const file = initial.payload.file
    const old = JSON.stringify({ version: 2, mode: 'auto', maxParallel: 1,
      models: { routine: { provider: 'local', model: 'worker', reasoningEffort: 'high' }, complex: { provider: 'local', model: 'reviewer' } } })
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, old)
    const migrated = await h.request('GET')
    assert.equal(migrated.payload.modelRouting, 'roles')
    assert.deepEqual(migrated.payload.models, { worker: { provider: 'local', model: 'worker', reasoningEffort: 'high' }, reviewer: null })
    assert.equal(await readFile(file, 'utf8'), old)
    const saved = await h.request('POST', { revision: migrated.payload.revision,
      models: { worker: { provider: 'local', model: 'new-worker' }, reviewer: null,
        routine: { provider: 'local', model: 'obsolete-worker' }, complex: { provider: 'local', model: 'obsolete-reviewer' } } })
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.payload.models, { worker: { provider: 'local', model: 'new-worker' }, reviewer: null })
    const stored = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(stored.version, 3)
    assert.deepEqual(stored.models, saved.payload.models)
    assert.equal(stored.maxParallel, 1)
  } finally { await h.close() }
})

test('history and archive routes expose saved tasks, Markdown downloads, and readable request errors', async () => {
  const h = await host()
  try {
    await h.state()
    const call = (name, args) => h.definitions.get(name).execute(args,
      { agent: h.agent, callId: name, token: {}, signal: new AbortController().signal })
    const request = async (pathname, method = 'GET') => {
      let status, headers, text
      await h.routes.get(pathname.split('?')[0])({ method, url: pathname },
        { writeHead(code, values) { status = code; headers = values }, end(value) { text = value } })
      return { status, headers, text, body: text?.startsWith('{') ? JSON.parse(text) : null }
    }
    await call('delegation_plan', { goal: '保留接口测试档案', tasks: [{
      id: 'a', title: '核对文件', instructions: '读取测试文件', scope: '测试数据', outputs: ['fixture.txt'], writes: [],
      complexity: 'routine', criteria: ['文件内容符合要求'], checks: [{ tool: 'read', arguments: { path: 'fixture.txt' } }],
    }] })
    await call('delegation_cancel', {})
    const history = await request('/dsh-delegation-first/api/history')
    assert.equal(history.status, 200)
    const id = history.body.items.find(item => item.goal === '保留接口测试档案').id
    const archive = await request('/dsh-delegation-first/api/archive?id=' + id)
    assert.equal(archive.status, 200)
    assert.equal(archive.body.plan.status, 'cancelled')
    const download = await request('/dsh-delegation-first/api/archive?id=' + id + '&format=markdown')
    assert.equal(download.status, 200)
    assert.match(download.headers['content-disposition'], /attachment/)
    assert.equal(download.text, archive.body.markdown)
    assert.equal((await request('/dsh-delegation-first/api/archive?id=..%2Fconfig')).status, 400)
    assert.equal((await request('/dsh-delegation-first/api/history?before=..')).status, 400)
    const missing = await request('/dsh-delegation-first/api/archive?id=2000-01-01T00-00-00-000Z-00000000-0000-0000-0000-000000000000')
    assert.equal(missing.status, 404)
    assert.match(missing.body.error, /不存在|移动/)
    assert.equal((await request('/dsh-delegation-first/api/history', 'POST')).status, 405)
    assert.equal((await request('/dsh-delegation-first/api/archive', 'POST')).status, 405)
  } finally { await h.close() }
})
test('plans retain the original human request across approval turns and state is scoped to the requested session', async () => {
  const h = await host()
  try {
    await h.state()
    h.turn('修复登录失败提示，并补充测试')
    await h.decide()
    h.turn('可以，开始执行')
    await h.decide(undefined, 'continue')
    const plan = await h.definitions.get('delegation_plan').execute({ goal: '模型整理后的目标', decisionReason: '执行者核对文件后由主控独立验收。', tasks: [{
      id: 'a', title: '核对文件', instructions: '读取测试文件', scope: '测试数据', outputs: ['fixture.txt'], writes: [],
      complexity: 'routine', criteria: ['内容符合要求'], checks: [{ tool: 'read', arguments: { path: 'fixture.txt' } }],
    }] }, { agent: h.agent, callId: 'plan', signal: new AbortController().signal })
    assert.equal(plan.plan.source.messageId, '1')
    assert.equal(plan.plan.source.text, '修复登录失败提示，并补充测试')
    let body
    await h.routes.get('/dsh-delegation-first/api/state')({ method: 'GET', url: '/dsh-delegation-first/api/state?sessionId=another-session' },
      { writeHead() {}, end(text) { body = JSON.parse(text) } })
    assert.deepEqual(body.plans, [])
    assert.deepEqual(body.sessions, [])
    assert.equal(body.sessionId, 'another-session')
    await h.routes.get('/dsh-delegation-first/api/state')({ method: 'GET', url: '/dsh-delegation-first/api/state?sessionId=root' },
      { writeHead() {}, end(text) { body = JSON.parse(text) } })
    assert.equal(body.plans.length, 1)
    assert.equal(body.plans[0].source.messageId, '1')
    h.turn('再补充账号锁定的测试')
    await h.definitions.get('delegation_decide').execute({ relation: 'update', mode: 'delegate', reason: '补充锁定场景，继续由原执行任务完成。' }, { agent: h.agent, signal: new AbortController().signal })
    const ongoing = await h.definitions.get('delegation_status').execute({},
      { agent: h.agent, callId: 'status', signal: new AbortController().signal })
    assert.equal(ongoing.plan.source.text, '修复登录失败提示，并补充测试')
    await h.definitions.get('delegation_cancel').execute({},
      { agent: h.agent, callId: 'cancel', signal: new AbortController().signal })
    h.turn('修改首页标题')
    const next = await h.definitions.get('delegation_plan').execute({ goal: '新任务', relation: 'new', decisionReason: '新任务交给执行者，主控核对最终文件。', tasks: plan.plan.tasks },
      { agent: h.agent, callId: 'next-plan', signal: new AbortController().signal })
    assert.equal(next.plan.source.text, '修改首页标题')
    assert.equal(next.plan.source.messageId, '4')
    await h.definitions.get('delegation_cancel').execute({},
      { agent: h.agent, callId: 'cancel-next', signal: new AbortController().signal })
  } finally { await h.close() }
})
test('native delegation cannot bypass configured task routing', async () => {
  const h = await host(); await h.state(); h.turn(complex)
  assert.match(h.call('subagent'), /delegation_plan.*delegation_run/s)
  h.result('subagent', { isError: true, error: { message: 'capacity full' } })
  assert.equal((await h.state()).delegated, 0)
  await h.decide()
  assert.equal(h.call('edit'), undefined)
  await h.close()
})
test('a result from a blocked native delegation cannot count as managed dispatch', async () => {
  const h = await host(); await h.state(); h.turn(complex)
  h.call('subagent'); assert.equal((await h.state()).delegated, 0)
  h.result('subagent', { isError: false, value: { subagentId: 'child' } })
  h.result('subagent', { isError: false, value: { subagentId: 'child' } })
  assert.equal((await h.state()).delegated, 0)
  await h.close()
})
test('continuation follows the coordinator decision rather than the wording of the request', async () => {
  const h = await host(); await h.state(); h.turn(complex); await h.decide()
  const original = (await h.state()).decision
  h.turn('还是这个任务，接着完善')
  await h.decide(undefined, 'continue')
  assert.deepEqual((await h.state()).decision, original)
  assert.equal((await h.state()).route, null)
  assert.equal(h.call('edit'), undefined)
  await h.close()
})

test('task wording, length and feature lists never produce automatic scores or dispatches', async () => {
  const h = await host(); await h.state()
  try {
    for (const text of [complex, '修改页面标题', '审计数据库', '实现用户登录注册、短信校验、密码重置和权限控制', '还要在原需求中补充校验。'.repeat(20)]) {
      h.turn(text)
      const state = await h.state()
      assert.equal(state.difficulty, null)
      assert.equal(state.route, null)
      assert.equal(state.source, null)
      assert.equal(state.turnStats.delegated, 0)
    }
  } finally { await h.close() }
})

test('workload thresholds do not rewrite the initial difficulty or route', async () => {
  const h = await host(); await h.state(); h.turn('修改页面标题')
  await h.decide()
  const initial = await h.state()
  for (let i = 0; i < 12; i++) assert.equal(h.call('read', String(i)), undefined)
  for (let i = 0; i < 6; i++) assert.equal(h.call('pwsh', `command-${i}`), undefined)
  for (const file of ['src/a.js', 'src/b.js', 'src/c.js']) {
    assert.equal(h.call('edit', file, h.agent, { file_path: file }), undefined)
  }
  const state = await h.state()
  assert.deepEqual(state.difficulty, initial.difficulty)
  assert.deepEqual(state.route, initial.route)
  await h.close()
})

test('follow-up turns retain the initial difficulty and allow continued direct execution', async () => {
  const h = await host(); await h.state(); h.turn('修改页面标题')
  await h.decide()
  const initial = await h.state()
  for (let i = 0; i < 4; i++) assert.equal(h.call('edit', String(i)), undefined)
  h.turn('继续呢')
  await h.decide(undefined, 'continue')
  assert.equal(h.call('edit', 'fifth'), undefined)
  assert.equal(h.call('edit', 'sixth'), undefined)
  assert.equal(h.call('edit', 'seventh'), undefined)
  const continued = (await h.state()).difficulty
  assert.equal(continued, null)
  assert.deepEqual((await h.state()).decision, initial.decision)
  await h.close()
})

test('large read-only context does not alter difficulty or block later direct work', async () => {
  const h = await host(); await h.state(); h.turn('你评审下代码，看看是否可以优化')
  const initial = await h.state()
  for (let i = 0; i < 40; i++) assert.equal(h.call('read', String(i)), undefined)
  assert.deepEqual((await h.state()).difficulty, initial.difficulty)
  await h.decide()
  assert.equal(h.call('edit'), undefined)
  assert.equal(h.call('read', 'after-delegation'), undefined)
  assert.equal(h.call('pwsh', 'worker', { id: 'worker' }), undefined)
  await h.close()
})

test('model-provided identifiers must refer to actual messages in the current session', async () => {
  const h = await host(); await h.state(); h.turn('修复指定文档')
  try {
    await assert.rejects(h.definitions.get('delegation_decide').execute({ relation: 'new', messageId: 'invented', mode: 'direct', reason: '修改后读取并验证。' }, { agent: h.agent }), /真实用户消息/)
    assert.equal((await h.state()).source, null)
    assert.match(h.call('edit'), /delegation_decide/)
  } finally { await h.close() }
})

test('explicit off and fixed modes keep their own execution policy', async () => {
  for (const mode of ['off', '20']) {
    process.env.DSH_DELEGATION_FIRST = mode
    const h = await host(); await h.state(); h.turn('修改页面标题')
    if (mode !== 'off') await h.decide()
    for (let i = 0; i < 15; i++) assert.equal(h.call('pwsh', String(i)), undefined, mode)
    if (mode === 'off') assert.equal(h.call('subagent'), undefined)
    await h.close()
  }
})

test('turn counters reset together while cumulative policy interceptions retain their origin', async () => {
  const h = await host(); await h.state(); h.turn(complex)
  try {
    for (let i = 0; i < 4; i++) assert.match(h.call('subagent', String(i)), /delegation_plan/)
    const first = await h.state()
    assert.equal(first.turnStats.denied, 4)
    assert.equal(first.sessionStats.denied, 4)
    assert.ok(first.sessionStats.since > 0)
    h.turn('继续')
    const next = await h.state()
    assert.deepEqual(next.turnStats, { direct: 0, delegated: 0, denied: 0 })
    assert.equal(next.denied, 4, 'legacy cumulative field must remain compatible')
    assert.equal(next.sessionStats.since, first.sessionStats.since)
  } finally { await h.close() }
})

test('a read-only baseline and three planning notes remain usable after an explicit direct-operation budget is spent', async () => {
  process.env.DSH_DELEGATION_FIRST = '1'
  const h = await host(); await h.state(); h.turn('你评审下代码，看看是否可以优化')
  await h.decide()
  try {
    assert.equal(h.call('pwsh', 'initial-baseline'), undefined)
    h.ctx.tools.execute = async exec => {
      assert.equal(h.call(exec.name, exec.callId, exec.agent, exec.arguments), undefined)
      return { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'isolated baseline' }] }
    }
    const invoke = (name, args) => h.definitions.get(name).execute(args,
      { agent: h.agent, callId: 'prepare-' + name, signal: new AbortController().signal })
    await invoke('delegation_inspect', { operation: 'list', directory: home })
    for (const kind of ['task_plan', 'findings', 'progress']) await invoke('delegation_note', { kind, content: '当前需求的准备记录' })
    await invoke('delegation_inspect', { operation: 'git_status', directory: home })
    assert.equal((await h.state()).turnStats.direct, 1)
    assert.equal((await h.state()).turnStats.denied, 0)
    assert.match(h.call('pwsh', 'unknown-script', h.agent, { command: 'Get-ChildItem; Remove-Item business.txt' }), /已阻止业务操作/)
  } finally { await h.close() }
})
test('configuration persists model routes, validates limits, and updates the current gate', async () => {
  delete process.env.DSH_DELEGATION_FIRST
  const h = await host(); await h.state(); h.turn('修改页面标题')
  const saved = await h.request('POST', { mode: 'strict', maxParallel: 1, maxActivations: 4, models: { routine: { provider: 'local', model: 'cheap' }, complex: null } })
  assert.equal(saved.status, 200)
  assert.equal(saved.payload.models.worker.model, 'cheap')
  assert.match(h.call('edit'), /派/)
  assert.equal((await h.request('POST', { maxParallel: 9 })).status, 400)
  assert.equal((await h.request('POST', { maxActivations: 257 })).status, 400)
  assert.equal((await h.request('POST', { models: { routine: { provider: 'local' } } })).status, 400)
  await h.close()
  const reopened = await host(); await reopened.state()
  const read = await reopened.request('GET')
  assert.equal(read.payload.maxParallel, 1); assert.equal(read.payload.maxActivations, 4); assert.equal(read.payload.models.worker.model, 'cheap')
  await reopened.close()
})

test('saving a stale provider explains the fix and preserves the saved configuration', async () => {
  delete process.env.DSH_DELEGATION_FIRST
  const h = await host(); await h.state()
  const previous = await h.request('GET')
  const result = await h.request('POST', { models: { routine: { provider: 'retired', model: 'cheap' }, complex: null } })
  assert.equal(result.status, 400)
  assert.match(result.payload.error, /执行模型.*失效.*DSH Agentrix/)
  assert.equal(result.payload.issue.retryable, false)
  assert.deepEqual((await h.request('GET')).payload.models, previous.payload.models)
  assert.equal((await h.request('POST', { mode: 'off', models: { routine: { provider: 'retired', model: 'cheap' }, complex: null } })).status, 200,
    'an invalid model must not prevent the user from turning delegation off')
  await h.close()
})

test('configuration exposes authoritative ranges and rejects stale or concurrent revision saves', async () => {
  delete process.env.DSH_DELEGATION_FIRST
  const h = await host(); await h.state()
  try {
    await h.request('POST', { mode: 'auto', models: { routine: null, complex: null } })
    const initial = (await h.request('GET')).payload
    assert.deepEqual(initial.ranges.maxAttempts, { min: 1, max: 10 })
    assert.equal(initial.defaults.taskTimeoutMinutes, 120)
    assert.equal(initial.source.kind, 'file')
    assert.ok(initial.revision)
    assert.ok(initial.updatedAt > 0)
    const replies = await Promise.all([
      h.request('POST', { revision: initial.revision, maxParallel: 3 }),
      h.request('POST', { revision: initial.revision, maxParallel: 4 }),
    ])
    assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409])
    const conflict = replies.find(reply => reply.status === 409)
    assert.equal(conflict.payload.code, 'CONFIG_CONFLICT')
    assert.notEqual(conflict.payload.revision, initial.revision)
    const latest = (await h.request('GET')).payload
    assert.equal(latest.maxParallel, replies.find(reply => reply.status === 200).payload.maxParallel)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(latest.file, JSON.stringify({ ...latest, maxParallel: 2 }), 'utf8')
    const external = await h.request('POST', { revision: latest.revision, maxParallel: 1 })
    assert.equal(external.status, 409)
    assert.equal(external.payload.maxParallel, 2)
  } finally { await h.close() }
})
