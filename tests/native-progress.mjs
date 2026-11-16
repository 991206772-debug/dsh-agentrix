// Installed Cordis, HTTP server, tools and model middleware; synthetic messages only.
// Run in Electron Node mode with DSH_MODULE_ROOT. No provider or live profile is used.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { get } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply } from '../index.js'

const root = process.env.DSH_MODULE_ROOT
if (!root) throw new Error('DSH_MODULE_ROOT is required')
const native = name => import(pathToFileURL(path.join(root, name, 'lib/index.js')).href)
const { Context } = await native('cordis')
const { createScope } = await native('dsh-scope')
const { WebServer } = await native('dsh-host-webserver')
const { ToolRuntime, defineTool } = await native('dsh-tools')
const { NativeToolExecutor } = await native('dsh-tool-executor-native')
const { LlmRuntime, LlmAdapter } = await native('dsh-llm')
const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-native-progress-'))
process.env.DSH_HOME = directory
process.env.DSH_DELEGATION_FIRST = 'auto'
const ctx = new Context()
const agent = { id: 'progress-root', options: { provider: 'fixture', model: 'coordinator' },
  session: { header: { cwd: directory }, requestHeader: () => undefined, snapshotEvents: () => [] } }
agent.ctx = createScope(ctx, agent).ctx
ctx.provide('systemPrompt', { tools() {}, section() { return () => {} } })
ctx.provide('sessions', { get: id => id === agent.id ? agent.session : undefined })
ctx.provide('agents', { get: id => id === agent.id ? agent : undefined, list: () => [agent] })
ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, compression: 'gzip', compressionLevel: 6, compressionThresholdBytes: 0 })
const runtime = new ToolRuntime(ctx)
runtime.setExecutor(new NativeToolExecutor(ctx))
const llm = new LlmRuntime(ctx)
let finishTool, finishModel, modelCalls = 0
runtime.register(defineTool({ name: 'read', description: 'Isolated pending tool', parameters: {},
  output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
    render: (_args, value) => [{ type: 'text', text: value.text }] },
  async execute() { await new Promise(resolve => { finishTool = resolve }); return { text: 'fixture content' } } }))
class Adapter extends LlmAdapter {
  async *stream() {
    modelCalls++
    await new Promise(resolve => { finishModel = resolve })
    yield { type: 'block-start', index: 0, block: { type: 'text', text: '' } }
    yield { type: 'block-delta', index: 0, delta: { type: 'text', text: 'fixture reply' } }
    yield { type: 'block-end', index: 0 }
  }
}
llm.registerAdapter(['fixture'], new Adapter())
apply(ctx)
const pause = () => new Promise(resolve => setTimeout(resolve, 10))
const until = async (predicate, label) => {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await pause() }
  throw new Error('Timed out: ' + label)
}
const connections = []
let origin
const state = async () => {
  const body = await (await fetch(origin + '/dsh-delegation-first/api/state?sessionId=' + agent.id)).json()
  return body.sessions.find(row => row.sessionId === agent.id)
}
const events = id => new Promise((resolve, reject) => {
  const request = get(origin + '/dsh-delegation-first/api/events?sessionId=' + id, { headers: { 'accept-encoding': 'gzip' } }, response => {
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['content-encoding'], undefined, 'SSE must not be buffered by gzip')
    assert.match(response.headers['content-type'], /text\/event-stream/)
    const connection = { request, response, text: '', changes: 0 }
    response.setEncoding('utf8')
    response.on('data', data => { connection.text += data; connection.changes = connection.text.split('data: {}\n\n').length - 1 })
    response.on('error', () => {})
    connections.push(connection); resolve(connection)
  })
  request.on('error', reject)
})
let sequence = 0
const call = async (name, args = {}) => {
  const id = 'progress-' + ++sequence
  const batch = await runtime.execute({ calls: [{ id, name, arguments: JSON.stringify(args) }], agent, signal: new AbortController().signal })
  const result = batch.results.find(item => item.callId === id).result
  assert.equal(result.isError, false, JSON.stringify(result))
  return result
}
const input = (id, text, turn) => {
  ctx.emit('session/event', { id: agent.id }, { type: 'user/message', data: { id, source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  ctx.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn } })
}
try {
  await until(() => ctx.get('webServer')?.port, 'installed HTTP server')
  origin = ctx.get('webServer').getOrigin()
  await state()
  assert.equal((await fetch(origin + '/dsh-delegation-first/api/events')).status, 400)
  assert.equal((await fetch(origin + '/dsh-delegation-first/api/events?sessionId=x', { method: 'POST' })).status, 405)
  const live = await events(agent.id), other = await events('unrelated-session')
  await until(() => live.text.includes(': connected'), 'immediate event connection')
  input('review', '先评审，不改代码', 1)
  await until(() => live.changes >= 1, 'new input event')
  await call('delegation_decide', { relation: 'new', mode: 'direct', reason: '只读评审，不写代码。' })
  const beforeTool = live.changes
  const tool = call('read')
  await until(() => finishTool && live.changes > beforeTool, 'native tool start')
  assert.equal((await state()).execution.activity.kind, 'tool')
  input('implement', '选择 B，开始实施', 2)
  const row = await state()
  assert.equal(row.latestMessage.messageId, 'implement')
  assert.equal(row.source.messageId, 'review')
  assert.equal(row.decisionCurrent, false)
  finishTool(); await tool
  await call('delegation_decide', { relation: 'continue', reason: '开始修改并验证原方案。' })
  assert.equal((await state()).messageResolution.reason, '开始修改并验证原方案。')
  const beforeModel = live.changes
  const stream = (async () => { for await (const chunk of llm.stream({ sessionId: agent.id, provider: 'fixture', model: 'coordinator',
    messages: [], signal: new AbortController().signal })) {} })()
  await until(() => finishModel && live.changes > beforeModel, 'native model request event')
  assert.equal((await state()).execution.activity.kind, 'waiting_model_response')
  const beforeResponse = live.changes
  finishModel(); await stream
  await until(() => live.changes > beforeResponse, 'first model content event')
  assert.equal((await state()).execution.activity.kind, 'model')
  assert.equal(modelCalls, 1, 'progress observation must add zero model requests')
  assert.equal(other.changes, 0, 'other sessions must not receive these invalidations')
  assert.doesNotMatch(live.text, /评审|实施|fixture reply/)
  live.request.destroy()
  await events(agent.id)
  ctx.emit('session/event', { id: agent.id }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await until(() => connections.at(-1).changes > 0, 'updates after reconnection')
  assert.equal((await state()).execution.running, false)
  console.log('PASS: installed HTTP server with gzip, session-scoped SSE, actual ToolRuntime start/result and LlmRuntime request/content, latest input provenance, reconnect, zero additional model requests')
} finally {
  finishTool?.(); finishModel?.()
  await ctx.fiber.dispose()
  while (ctx.fiber.inertia) await ctx.fiber.inertia
  for (const connection of connections) connection.request.destroy()
  await rm(directory, { recursive: true, force: true })
}
