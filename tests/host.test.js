import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-delegation-test-'))
const previous = { home: process.env.DSH_HOME, mode: process.env.DSH_DELEGATION_FIRST }
beforeEach(() => { process.env.DSH_HOME = home; process.env.DSH_DELEGATION_FIRST = 'auto' })
after(async () => {
  for (const [key, value] of [['DSH_HOME', previous.home], ['DSH_DELEGATION_FIRST', previous.mode]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
  await rm(home, { recursive: true, force: true })
})

export async function host() {
  const listeners = new Map(), routes = new Map(), definitions = new Map(), cleanups = []
  let guard
  const agent = { id: 'root' }
  const sessions = { get: id => ({ header: id === 'worker' ? { origin: 'subagent', parentSession: 'root' } : {} }) }
  const emit = (name, ...args) => { for (const fn of listeners.get(name) ?? []) fn(...args) }
  const ctx = {
    tools: {
      guard(fn) { guard = fn; return () => {} },
      get: name => definitions.get(name) ?? (name === 'subagent' ? {} : undefined),
      schemas: () => ['subagent', 'read', 'grep', 'glob', 'pwsh'].map(name => ({ name })).concat([...definitions.keys()].map(name => ({ name }))),
      register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) },
    },
    get(name) { return { sessions, agents: { list: () => [], get: id => id === 'root' ? agent : undefined }, webServer: ctx.webServer,
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
  const state = async () => {
    let body
    await routes.get('/dsh-delegation-first/api/state')({ method: 'GET' }, { writeHead() {}, end(text) { body = JSON.parse(text) } })
    return body.sessions.find(row => row.sessionId === 'root')
  }
  let turn = 0
  return {
    ctx, agent, definitions, emit, state, routes,
    turn(text) {
      emit('session/event', { id: 'root' }, { type: 'agent/inbox/spliced', data: { inserted: [{ id: String(++turn), source: { kind: 'user' }, content: [{ type: 'text', text }] }] } })
      emit('session/event', { id: 'root' }, { type: 'turn/start', data: { turn } })
    },
    call(name, id = 'call', who = agent, args = {}) { return guard({ name, callId: id, agent: who, arguments: args, signal: new AbortController().signal }) },
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

test('legacy model settings migrate to execution and review roles without rewriting the file on read', async () => {
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
    assert.deepEqual(migrated.payload.models, { worker: { provider: 'local', model: 'worker', reasoningEffort: 'high' }, reviewer: { provider: 'local', model: 'reviewer' } })
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
    h.turn('可以，开始执行')
    const plan = await h.definitions.get('delegation_plan').execute({ goal: '模型整理后的目标', tasks: [{
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
    const ongoing = await h.definitions.get('delegation_status').execute({},
      { agent: h.agent, callId: 'status', signal: new AbortController().signal })
    assert.equal(ongoing.plan.source.text, '修复登录失败提示，并补充测试')
    await h.definitions.get('delegation_cancel').execute({},
      { agent: h.agent, callId: 'cancel', signal: new AbortController().signal })
    h.turn('修改首页标题')
    const next = await h.definitions.get('delegation_plan').execute({ goal: '新任务', tasks: plan.plan.tasks },
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
  assert.match(h.call('edit'), /派/)
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
test('continue preserves the previous complex task', async () => {
  const h = await host(); await h.state(); h.turn(complex); h.turn('继续')
  assert.equal((await h.state()).difficulty.level, 'complex')
  assert.match(h.call('edit'), /派/)
  await h.close()
})
test('a simple change is not blocked by the automatic budget', async () => {
  const h = await host(); await h.state(); h.turn('修改页面标题')
  for (let i = 0; i < 5; i++) assert.equal(h.call('edit', String(i)), undefined)
  await h.close()
})
test('a short multi-feature request is not classified as simple', async () => {
  const h = await host(); await h.state(); h.turn('实现用户登录注册、短信校验、密码重置和权限控制')
  assert.notEqual((await h.state()).difficulty.level, 'simple')
  await h.close()
})

test('actual short implementation and review requests are not treated as simple questions', async () => {
  const h = await host(); await h.state()
  for (const text of [
    '改成左树右表的。看起来方便，还有缺少weknora基础配置模块',
    '默认把文档推送到weknora啊，然后能推送，自动创建的就最好，我只需要维护一个配置页面就行',
    '你评审下代码，看看是否可以优化',
    '改成exe呢',
  ]) {
    h.turn(text)
    assert.notEqual((await h.state()).difficulty.level, 'simple', text)
  }
  await h.close()
})

test('short approvals and follow-up requirements retain task context, while new questions reset it', async () => {
  const h = await host(); await h.state(); h.turn(complex)
  for (const text of ['可以，开始修复', '继续呢', '发给同事用']) {
    h.turn(text)
    assert.equal((await h.state()).difficulty.level, 'complex', text)
    assert.match(h.call('edit'), /派/)
  }
  h.turn('你是什么模型')
  assert.equal((await h.state()).difficulty.level, 'simple')
  assert.equal(h.call('edit'), undefined)
  await h.close()
})

test('growing execution workload requires delegation before a simple task runs indefinitely', async () => {
  const h = await host(); await h.state(); h.turn('修改页面标题')
  for (let i = 0; i < 6; i++) assert.equal(h.call('pwsh', String(i)), undefined)
  assert.match(h.call('pwsh', 'seventh'), /派/)
  const state = await h.state()
  assert.equal(state.difficulty.level, 'complex')
  assert.match(state.difficulty.signals.join(' '), /执行.*6/)
  await h.close()
})

test('follow-up turns cannot reset a growing execution workload', async () => {
  const h = await host(); await h.state(); h.turn('修改页面标题')
  for (let i = 0; i < 4; i++) assert.equal(h.call('edit', String(i)), undefined)
  h.turn('继续呢')
  assert.equal(h.call('edit', 'fifth'), undefined)
  assert.equal(h.call('edit', 'sixth'), undefined)
  assert.match(h.call('edit', 'seventh'), /派/)
  await h.close()
})

test('editing several real files upgrades the initial single-file estimate', async () => {
  const h = await host(); await h.state(); h.turn('修改页面标题')
  for (const file of ['src/a.js', 'src/b.js', 'src/c.js']) {
    assert.equal(h.call('edit', file, h.agent, { file_path: file }), undefined)
  }
  assert.match(h.call('edit', 'fourth', h.agent, { file_path: 'src/d.js' }), /派/)
  assert.match((await h.state()).difficulty.signals.join(' '), /3.*文件/)
  await h.close()
})

test('read-only context remains available after workload escalation', async () => {
  const h = await host(); await h.state(); h.turn('你评审下代码，看看是否可以优化')
  for (let i = 0; i < 12; i++) assert.equal(h.call('read', String(i)), undefined)
  for (let i = 12; i < 40; i++) assert.equal(h.call('read', String(i)), undefined)
  assert.equal((await h.state()).difficulty.level, 'complex', 'reading can strengthen the routing advice without blocking context')
  assert.match(h.call('edit'), /派/)
  assert.equal(h.call('read', 'after-delegation'), undefined)
  assert.equal(h.call('pwsh', 'worker', { id: 'worker' }), undefined)
  await h.close()
})

test('state exposes an explicit route, reasons, estimate, and confidence', async () => {
  const h = await host(); await h.state()
  h.turn(complex)
  let state = await h.state()
  assert.equal(state.route.route, 'delegate_parallel')
  assert.ok(state.route.reasons.includes('high_complexity'))
  assert.ok(state.route.reasons.includes('parallel_candidates'))
  assert.ok(state.route.estimatedSteps > 1)
  assert.ok(state.route.parallelTasks >= 2)
  assert.ok(state.route.confidence > 0 && state.route.confidence <= 1)
  h.turn('修改页面标题')
  state = await h.state()
  assert.equal(state.route.route, 'direct')
  assert.ok(state.route.reasons.includes('scope_small'))
  await h.close()
})

test('explicit off and fixed modes keep their own execution policy', async () => {
  for (const mode of ['off', '20']) {
    process.env.DSH_DELEGATION_FIRST = mode
    const h = await host(); await h.state(); h.turn('修改页面标题')
    for (let i = 0; i < 15; i++) assert.equal(h.call('pwsh', String(i)), undefined, mode)
    if (mode === 'off') assert.equal(h.call('subagent'), undefined)
    await h.close()
  }
})

test('turn counters reset together while cumulative policy interceptions retain their origin', async () => {
  const h = await host(); await h.state(); h.turn(complex)
  try {
    for (let i = 0; i < 4; i++) assert.match(h.call('edit', String(i)), /派/)
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

test('a read-only baseline and three planning notes remain usable after the direct-operation budget is spent', async () => {
  const h = await host(); await h.state(); h.turn('你评审下代码，看看是否可以优化')
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
