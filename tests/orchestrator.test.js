import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createOrchestrator, DEFAULT_OPTIONS } from '../orchestrator.js'

const cleanup = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()() })
const tick = () => new Promise(resolve => setTimeout(resolve, 15))
async function waitFor(predicate) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await tick() }
  assert.ok(predicate(), 'the expected public task state did not arrive')
}
const card = (id, overrides = {}) => ({
  id, title: id, instructions: '检查指定文件，给出具体结果', scope: '只检查当前任务',
  outputs: ['result.txt'], writes: [], dependsOn: [], complexity: 'routine',
  criteria: ['交付物存在且内容符合要求'], checks: [{ tool: 'read', arguments: { path: 'result.txt' } }], ...overrides,
})

test('explicit coordinator review decouples execution complexity without bypassing evidence acceptance', async () => {
  const f = await fixture()
  const reason = '资料范围较大但交付仅为可核对的编辑建议，由主控验证验收。'
  await f.plan([card('a', { complexity: 'complex', reviewPolicy: 'coordinator', reviewReason: reason })])
  await f.execute('delegation_run'); await f.complete(0, { stopReason: 'completed', output: [] })
  assert.equal(f.snapshot().tasks[0].reviewPolicy, 'coordinator')
  assert.equal(f.snapshot().tasks[0].audit, undefined)
  assert.equal(f.pending.length, 1)
  await assert.rejects(f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [] }), /验证/)
  await f.reload()
  assert.equal(f.snapshot().tasks[0].reviewReason, reason)
  const state = await f.execute('delegation_status')
  assert.match(f.render('delegation_status', {}, state), /coordinator/)
  const proof = await f.execute('delegation_verify', { taskId: 'a' })
  await f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterionId: 'C1', finding: '实际内容符合要求', evidence: [proof.results[0].ref] }] })
  assert.equal(f.snapshot().completion.outcome, 'completed')
  const saved = await f.engine.readArchive(f.snapshot().archive.id)
  assert.match(saved.markdown, /审查方式：主控验证验收/)
  assert.ok(saved.markdown.includes(reason))
})

test('explicit independent review remains mandatory for routine execution and preserves the dispatcher model', async () => {
  const f = await fixture()
  await f.plan([card('a', { reviewPolicy: 'independent', reviewReason: '改动虽少但影响权限边界，须独立审查。' })])
  await f.execute('delegation_run'); await f.complete(0, { stopReason: 'completed', output: [] })
  assert.equal(f.snapshot().tasks[0].audit.status, 'running')
  assert.equal(f.calls[1].request.agentOptions.model, 'parent')
  const proof = await f.execute('delegation_verify', { taskId: 'a' })
  const accept = () => f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterionId: 'C1', finding: '实际验证通过', evidence: [proof.results[0].ref] }] })
  await assert.rejects(accept(), /独立审查/)
  await f.finishAudit(1, { specVerdict: 'pass', qualityVerdict: 'pass', issues: [] })
  await accept()
  assert.equal(f.snapshot().completion.outcome, 'completed')
})

test('review policy choices require a valid explicit reason before any dispatch', async () => {
  for (const fields of [{ reviewPolicy: 'skip', reviewReason: '不能跳过验收' }, { reviewPolicy: 'coordinator' },
    { reviewPolicy: 'independent', reviewReason: ' ' }, { reviewReason: '缺少对应方式' }]) {
    const f = await fixture()
    await assert.rejects(f.plan([card('a', fields)]), /reviewPolicy|审查/)
    assert.equal(f.pending.length, 0)
  }
})

test('fix dispatch and re-review carry only the affected criteria and reports instead of the entire specification', async () => {
  const f = await fixture()
  await f.plan([card('a', { complexity: 'complex', instructions: 'UNRELATED_FULL_SPEC '.repeat(250),
    criteria: ['返回包含必要字段', 'UNRELATED_ACCEPTANCE_CRITERION'] })])
  await f.execute('delegation_run'); await f.complete(0, { stopReason: 'completed', output: [] })
  const originalReport = f.snapshot().tasks[0].execution.reportPath
  await f.finishAudit(1, { specVerdict: 'fail', qualityVerdict: 'pass', issues: [
    { criterion: 0, severity: 'important', finding: '返回缺少必要字段', evidence: ['result.txt:2'] }] })
  const issue = f.snapshot().tasks[0].issues[0]
  await f.execute('delegation_review', { taskId: 'a', verdict: 'rework', issueIds: [issue.id] })
  const fix = f.calls[2].request.prompt[0].text
  assert.ok(fix.includes(originalReport))
  assert.ok(fix.includes(issue.id))
  assert.doesNotMatch(fix, /UNRELATED_FULL_SPEC|UNRELATED_ACCEPTANCE_CRITERION/)
  assert.ok(fix.length < f.calls[0].request.prompt[0].text.length * 0.5)
  await f.complete(2, { stopReason: 'completed', output: [] })
  const audit = f.calls[3].request.prompt[0].text
  assert.ok(audit.includes(originalReport))
  assert.ok(audit.includes(f.snapshot().tasks[0].execution.reportPath))
  assert.ok(audit.includes(issue.id))
  assert.doesNotMatch(audit, /UNRELATED_FULL_SPEC|UNRELATED_ACCEPTANCE_CRITERION/)
  await f.finishAudit(3, { specVerdict: 'pass', qualityVerdict: 'pass', issues: [],
    resolutions: [{ id: issue.id, status: 'ADDRESSED', evidence: ['result.txt:2 已修复'] }] })
  const proof = await f.execute('delegation_verify', { taskId: 'a' })
  await assert.rejects(f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [
    { criterionId: 'C1', finding: '仅核对修复仍不足以完成最终验收', evidence: [proof.results[0].ref] }] }), /逐条/)
  await f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: ['C1', 'C2'].map(criterionId =>
    ({ criterionId, finding: '实际结果满足原验收标准', evidence: [proof.results[0].ref] })) })
  assert.equal(f.snapshot().completion.outcome, 'completed')
})

test('new user criteria retain the full task brief and audit even when existing findings also need repair', async () => {
  const f = await fixture()
  await f.plan([card('a', { complexity: 'complex', instructions: 'FULL_BRIEF_REQUIRED_FOR_NEW_SCOPE' })])
  await f.execute('delegation_run'); await f.complete(0, { stopReason: 'completed', output: [] })
  await f.finishAudit(1, { specVerdict: 'fail', qualityVerdict: 'pass', issues: [
    { criterion: 0, severity: 'important', finding: '缺少字段', evidence: ['result.txt:2'] }] })
  const message = { id: 'new-delivery-rule', source: { kind: 'user' }, content: [{ type: 'text', text: '还需要操作说明' }] }
  f.emit('session/event', f.parent, { type: 'user/message', data: message })
  await f.execute('delegation_decide', { relation: 'update', messageId: message.id, mode: 'delegate', reason: '将新增操作说明纳入原任务。' })
  await f.execute('delegation_review', { taskId: 'a', verdict: 'rework', inputIds: [message.id], additionalCriteria: ['NEW_DELIVERY_CRITERION'] })
  assert.equal(f.snapshot().tasks[0].reworkContext.expanded, true)
  assert.match(f.calls[2].request.prompt[0].text, /FULL_BRIEF_REQUIRED_FOR_NEW_SCOPE/)
  assert.match(f.calls[2].request.prompt[0].text, /NEW_DELIVERY_CRITERION/)
  await f.complete(2, { stopReason: 'completed', output: [] })
  assert.match(f.calls[3].request.prompt[0].text, /FULL_BRIEF_REQUIRED_FOR_NEW_SCOPE/)
  assert.match(f.calls[3].request.prompt[0].text, /NEW_DELIVERY_CRITERION/)
})

test('identical findings from one audit keep one stable issue without merging distinct evidence', async () => {
  const f = await fixture()
  await f.plan([card('a', { complexity: 'complex' })]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  const issue = { criterion: 0, severity: 'important', finding: '引用行号不正确', evidence: ['result.txt:2', 'result.txt:4'] }
  await f.finishAudit(1, { specVerdict: 'fail', qualityVerdict: 'pass', issues: [issue,
    { ...issue, evidence: [...issue.evidence].reverse() }, { ...issue, evidence: ['other.txt:2'] }] })
  assert.equal(f.snapshot().tasks[0].issues.length, 2)
  assert.notEqual(f.snapshot().tasks[0].issues[0].id, f.snapshot().tasks[0].issues[1].id)
})

test('repeated successful observations notify the original coordinator once without stopping or spending correction budget', async () => {
  const f = await fixture(); await f.plan([card('a')]); await f.execute('delegation_run')
  const child = f.children[0]
  const observe = i => f.engine.observe({ agent: child, name: 'pwsh', callId: 'repeat-' + i,
    arguments: { command: 'count characters' } }, { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: '119' }] })
  for (let i = 0; i < 3; i++) observe(i)
  await waitFor(() => f.parent.injected.some(message => message.source.kind === 'delegation-supervision'))
  let task = f.snapshot().tasks[0]
  assert.equal(task.supervision.pending.code, 'REPEATED_OBSERVATION')
  assert.equal(task.supervision.pending.advisory, true)
  assert.equal(task.supervision.used, 0)
  assert.equal(f.snapshot().recovery.used, 0)
  await f.execute('delegation_control', { taskId: 'a', action: 'steer', message: '这些计算不再影响需求，先交付完整结果。' })
  for (let i = 3; i < 15; i++) observe(i)
  await tick()
  assert.equal(f.parent.injected.filter(message => message.source.kind === 'delegation-supervision').length, 1)
  task = f.snapshot().tasks[0]
  assert.equal(task.supervision.used, 0)
  assert.equal(task.status, 'running')
  assert.equal(f.pending.length, 1)
  assert.equal(f.pending[0].receipt.disposed, undefined)
})

test('one plan call records delegation and starts its configured worker without a separate run', async () => {
  const f = await fixture()
  const result = await f.execute('delegation_plan', { goal: '一次派发隔离任务', decisionReason: '执行者核对文件，主控验证验收。', start: true, tasks: [card('a')] })
  assert.equal(f.engine.decisionFor(f.parent.id).mode, 'delegate')
  assert.equal(result.plan.tasks[0].status, 'running')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].request.agentOptions.model, 'cheap')
  assert.equal(result.nextAction.type, 'wait')
  await f.execute('delegation_run')
  assert.equal(f.calls.length, 1, 'a legacy duplicate run must not start a second worker')
})

test('batch verification runs every configured check once and retains separate evidence without accepting the task', async () => {
  const f = await fixture()
  await f.plan([card('a', { checks: [{ tool: 'read', arguments: { path: 'result.txt' } }, { tool: 'pwsh', arguments: { command: 'node --test' } }] })])
  await f.execute('delegation_run'); await f.complete(0, { stopReason: 'completed', output: [] })
  const result = await f.execute('delegation_verify', { taskId: 'a' })
  assert.equal(result.passed, true)
  assert.deepEqual(result.results.map(item => item.checkIndex), [0, 1])
  assert.equal(new Set(result.results.map(item => item.ref)).size, 2)
  assert.deepEqual(result.criteria, [{ id: 'C1', criterion: 0, text: '交付物存在且内容符合要求' }])
  assert.ok(result.results.every(item => item.criteria === undefined && item.nextAction === undefined))
  assert.equal(f.snapshot().tasks[0].status, 'review')
  assert.equal(f.snapshot().completion, null)
  await f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterionId: 'C1', finding: '两项检查均已实际核对', evidence: result.results.map(item => item.ref) }] })
  assert.equal(f.snapshot().completion.outcome, 'completed')
})

test('combined dispatch keeps plan-only compatibility and does not launch an invalid model', async () => {
  for (const start of [undefined, false]) {
    const f = await fixture()
    await f.execute('delegation_plan', { goal: '只保存', decisionReason: '保存后再检查', ...(start === undefined ? {} : { start }), tasks: [card('a')] })
    assert.equal(f.calls.length, 0)
    assert.equal(f.snapshot().tasks[0].status, 'queued')
  }
  const invalid = await fixture({ models: { worker: { provider: 'local', model: 'missing' } } })
  await assert.rejects(invalid.execute('delegation_plan', { goal: '校验后才启动', decisionReason: '执行者检查', start: true, tasks: [card('a')] }), /model unavailable|模型/)
  assert.equal(invalid.calls.length, 0)
  assert.equal(invalid.snapshot().tasks[0].attempts, 0)
})

test('batch verification retains failed checks and rejects overlapping verification and acceptance', async () => {
  const f = await fixture()
  await f.plan([card('a', { checks: [{ tool: 'pwsh', arguments: { command: 'node --test' } }, { tool: 'read', arguments: { path: 'result.txt' } }] })])
  await f.execute('delegation_run'); await f.complete(0, { stopReason: 'completed', output: [] })
  const entered = Promise.withResolvers(), gate = Promise.withResolvers(), original = f.ctx.tools.execute
  let count = 0
  f.setExit(1)
  f.ctx.tools.execute = async exec => {
    count++
    if (count === 1) { entered.resolve(); await gate.promise }
    return original(exec)
  }
  const checking = f.execute('delegation_verify', { taskId: 'a' })
  await entered.promise
  await assert.rejects(f.execute('delegation_verify', { taskId: 'a' }), /正在执行/)
  await assert.rejects(f.execute('delegation_verify', { taskId: 'a', checkIndex: 1 }), /正在执行/)
  await assert.rejects(f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [] }), /等待正在执行/)
  gate.resolve()
  const result = await checking
  assert.deepEqual(result.results.map(item => item.passed), [false, true])
  assert.equal(result.passed, false)
  assert.equal(count, 2)
  assert.equal(f.snapshot().completion, null)
  await assert.rejects(f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [] }), /尚未全部通过/)
  f.setExit(0)
  const single = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  assert.equal(single.passed, true)
  assert.ok(single.ref)
  assert.equal(single.results, undefined, 'legacy single-check shape is preserved')
})

test('cancellation during batch verification stops later checks and cannot record post-cancel success', async () => {
  const f = await fixture()
  await f.plan([card('a', { checks: [{ tool: 'read', arguments: { path: 'result.txt' } }, { tool: 'read', arguments: { path: 'other.txt' } }] })])
  await f.execute('delegation_run'); await f.complete(0, { stopReason: 'completed', output: [] })
  const original = f.ctx.tools.execute
  let count = 0
  f.ctx.tools.execute = async exec => {
    count++
    await f.cancel({ reason: '用户在验证期间取消' })
    return original(exec)
  }
  await assert.rejects(f.execute('delegation_verify', { taskId: 'a' }), /取消/)
  assert.equal(count, 1)
  assert.equal(f.snapshot().tasks[0].checks[0].result, null)
  assert.equal(f.snapshot().completion.outcome, 'cancelled')
  assert.equal(f.pending[0].receipt.disposeCount, 1)
})

test('managed report schemas expose only fields belonging to the current child role', async () => {
  const f = await fixture({ scopedTools: true })
  await f.plan([card('a', { complexity: 'complex' })]); await f.execute('delegation_run')
  const worker = f.definition('delegation_report', 0)
  assert.equal(worker.parameters.properties.specVerdict, undefined)
  assert.equal(worker.parameters.properties.qualityVerdict, undefined)
  assert.equal(worker.parameters.properties.issues, undefined)
  assert.ok(worker.parameters.properties.concerns)
  await assert.rejects(f.report(0, { status: 'DONE', summary: '冒充审查', report: '不应通过', specVerdict: 'pass' }), /执行者不能/)
  await f.complete(0, { stopReason: 'completed', output: [] })
  const reviewer = f.definition('delegation_report', 1)
  assert.ok(reviewer.parameters.properties.specVerdict)
  assert.ok(reviewer.parameters.properties.qualityVerdict)
  assert.ok(reviewer.parameters.properties.issues)
  await assert.rejects(f.report(1, { status: 'DONE', summary: '缺审查结论', report: '不应通过' }), /独立审查必须/)
  await f.finishAudit(1, { specVerdict: 'pass', qualityVerdict: 'pass', issues: [] })
  assert.equal(f.snapshot().tasks[0].audit.status, 'completed')
})

test('acceptance uses supplied criterion IDs and current-task evidence references across reload', async () => {
  const f = await fixture()
  await f.plan([card('a', { criteria: ['结果为 31', '数量为 3'] }), card('b')]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  await f.complete(1, { stopReason: 'completed', output: [] })
  const first = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  assert.match(first.ref ?? '', /^E[0-9a-f]{12}$/)
  assert.deepEqual(first.criteria, [{ id: 'C1', criterion: 0, text: '结果为 31' }, { id: 'C2', criterion: 1, text: '数量为 3' }])
  const foreign = await f.execute('delegation_verify', { taskId: 'b', checkIndex: 0 })
  const findings = ref => ['C1', 'C2'].map(criterionId => ({ criterionId, finding: '已实际核对', evidence: [ref] }))
  await assert.rejects(f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: findings(foreign.ref) }), /本次主控验证|当前可用/)
  const current = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  assert.notEqual(current.ref, first.ref)
  await assert.rejects(f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: findings(first.ref) }), /本次主控验证|当前可用/)
  await assert.rejects(f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: findings(first.callId) }), /本次主控验证|当前可用/)
  await assert.rejects(f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [
    { criterionId: 'C9', finding: '错误编号', evidence: [current.ref] }, findings(current.ref)[1],
  ] }), /C1.*C2/)
  await f.reload()
  const compact = JSON.parse(f.render('delegation_status', {}, await f.execute('delegation_status')))
  assert.deepEqual(compact.plan.tasks[0].criteria, first.criteria)
  assert.equal(compact.plan.tasks[0].checks[0].ref, current.ref)
  await f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: findings(current.ref) })
  assert.deepEqual(f.snapshot().tasks[0].review.findings.map(item => item.criterion), [0, 1])
  assert.ok(f.snapshot().tasks[0].review.findings.every(item => item.evidence[0] === current.callId))
  await f.execute('delegation_review', { taskId: 'b', verdict: 'accept', findings: [{ criterion: 0, finding: '旧格式继续有效', evidence: [foreign.callId] }] })
  assert.equal(f.snapshot().completion.outcome, 'completed')
})

test('event waiting returns the first actionable report while other workers keep running', async () => {
  const f = await fixture()
  await f.plan([card('a'), card('b')]); const started = await f.execute('delegation_run')
  assert.equal(started.nextAction.type, 'wait')
  let returned = false
  const waiting = f.execute('delegation_wait').then(value => { returned = true; return value })
  await tick(); assert.equal(returned, false)
  await f.complete(0, { stopReason: 'completed', output: [] })
  const result = await waiting
  assert.equal(result.nextAction.type, 'verify')
  assert.deepEqual(result.nextAction.taskIds, ['a'])
  assert.equal(f.snapshot().tasks[1].status, 'running')
  assert.equal(f.pending[1].receipt.disposeCount, undefined)
  assert.equal(f.snapshot().recovery.used, 0)
  const proof = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  const accepted = await f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterionId: 'C1', finding: '已核对', evidence: [proof.ref] }] })
  assert.equal(accepted.nextAction.type, 'wait')
  const incoming = f.execute('delegation_wait')
  await tick()
  f.emit('session/event', f.parent, { type: 'agent/inbox/spliced', data: { inserted: [{ id: 'supplement-wait', source: { kind: 'user' }, content: [{ type: 'text', text: '补充检查标准' }] }] } })
  const updated = await incoming
  assert.equal(updated.nextAction.type, 'resolve_message')
  assert.equal(f.calls.length, 2)
  assert.equal(f.snapshot().tasks[1].status, 'running')
  await f.cancel({ reason: '隔离等待测试结束，明确取消剩余任务' })
})

for (const reason of ['parallel', 'write-conflict']) for (const stopping of [false, true]) {
  test(`queued ${reason} work waits for another session without spending recovery (${stopping ? 'turn end' : 'wait tool'})`, async () => {
    const f = await fixture({ maxParallel: reason === 'parallel' ? 1 : 4 })
    const other = { ...f.parent, id: 'queued-parent', injected: [] }
    const get = f.ctx.get.bind(f.ctx)
    f.ctx.get = name => name === 'agents' ? { get: id => id === other.id ? other : get(name).get(id), list: () => [...get(name).list(), other] } : get(name)
    const writes = reason === 'write-conflict' ? ['shared.txt'] : []
    await f.plan([card('holder', { writes })]); await f.execute('delegation_run')
    await f.plan([card('queued', { writes })], other); await f.execute('delegation_run', {}, other)
    assert.equal(f.snapshot(other.id).dispatchWait.reason, reason)
    let returned = false
    const waiting = (stopping ? f.emit('agent/turn-stopping', { agent: other, signal: new AbortController().signal })
      : f.execute('delegation_wait', {}, other)).then(value => { returned = true; return value })
    await tick(); assert.equal(returned, false, 'queued work must remain suspended without calling the model again')
    assert.equal(f.snapshot(other.id).recovery.used, 0)
    await f.complete(0, { stopReason: 'completed', output: [] })
    const proof = await f.execute('delegation_verify', { taskId: 'holder', checkIndex: 0 })
    await f.execute('delegation_review', { taskId: 'holder', verdict: 'accept', findings: [{ criterionId: 'C1', finding: '已核对', evidence: [proof.ref] }] })
    await waitFor(() => f.calls.length === 2)
    await tick(); assert.equal(returned, false, 'dispatch events alone must not wake the coordinator model')
    await f.report(1, { status: 'DONE', summary: '原排队任务已执行', report: '等待主控验证验收' })
    f.pending[1].resolve({ stopReason: 'completed', output: [] })
    await waiting
    assert.equal(f.snapshot(other.id).tasks[0].status, 'review')
    assert.equal(f.snapshot(other.id).completion, null)
    assert.equal(f.snapshot(other.id).recovery.used, 0)
    assert.equal(f.calls.length, 2)
    await f.cancel({ reason: '隔离排队测试结束' }, other)
  })
}

test('acceptance returns automatic dispatch guidance instead of inviting a duplicate run', async () => {
  const f = await fixture()
  await f.plan([card('a'), card('b', { dependsOn: ['a'] })]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  const proof = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  const value = await f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterionId: 'C1', finding: '已核对', evidence: [proof.ref] }] })
  assert.equal(value.nextAction.type, 'wait')
  assert.match(value.nextAction.message, /自动.*启动|自动.*推进/)
  await waitFor(() => f.calls.length === 2)
  assert.equal(f.snapshot().tasks[1].attempts, 1)
})

test('explicit cancellation ends an event wait without reopening or double releasing the worker', async () => {
  const f = await fixture(); await f.plan([card('a')]); await f.execute('delegation_run')
  const waiting = f.execute('delegation_wait')
  await tick()
  await f.cancel({ reason: '用户明确取消隔离测试' })
  const result = await waiting
  assert.equal(result.nextAction.type, 'finished')
  assert.equal(f.snapshot().completion.outcome, 'cancelled')
  assert.equal(f.calls.length, 1)
  assert.equal(f.pending[0].receipt.disposeCount, 1)
  assert.equal(f.snapshot().recovery.used, 0)
})

test('reference-based rework still requires new verification and explicit issue resolutions', async () => {
  const f = await fixture(); await f.plan([card('a')]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  const old = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  await f.execute('delegation_review', { taskId: 'a', verdict: 'rework', issues: [
    { criterionId: 'C1', severity: 'important', finding: '实际产物需要修正', evidence: [old.ref] },
  ] })
  await f.complete(1, { stopReason: 'completed', output: [] })
  const fresh = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  const findings = [{ criterionId: 'C1', finding: '返工产物已实际核对', evidence: [fresh.ref] }]
  await assert.rejects(f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings }), /未解决/)
  const id = f.snapshot().tasks[0].issues.find(issue => issue.status === 'open').id
  await assert.rejects(f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings,
    resolutions: [{ id, status: 'ADDRESSED', evidence: [old.ref] }] }), /本次主控验证/)
  await f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings,
    resolutions: [{ id, status: 'ADDRESSED', evidence: [fresh.ref] }] })
  assert.equal(f.snapshot().completion.outcome, 'completed')
  assert.equal(f.calls.length, 2)
})

test('failed verification asks for a review of the failure rather than repeated verification', async () => {
  const f = await fixture(); await f.plan([card('a', { checks: [{ tool: 'pwsh', arguments: { command: 'node verify.mjs' } }] })]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] }); f.setExit(1)
  const proof = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  assert.equal(proof.passed, false)
  assert.equal(proof.nextAction.type, 'review')
  assert.match(proof.nextAction.message, /失败/)
  await assert.rejects(f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterionId: 'C1', finding: '不能冒充通过', evidence: [proof.ref] }] }), /主控验证尚未全部通过/)
  assert.equal(f.snapshot().completion, null)
})

test('default task summaries and notifications retain concerns and the required acceptance step', async () => {
  const f = await fixture({ autoConclude: true })
  await f.plan([card('a')]); await f.execute('delegation_run')
  await f.report(0, { status: 'DONE_WITH_CONCERNS', summary: '文件已核对', report: '完整交付说明', concerns: ['真实数据库行为尚未验证'] })
  await waitFor(() => f.snapshot().tasks[0].status === 'review')
  const value = await f.execute('delegation_status')
  const compact = JSON.parse(f.render('delegation_status', {}, value)).plan.tasks[0]
  assert.equal(compact.execution.status, 'DONE_WITH_CONCERNS')
  assert.deepEqual(compact.execution.concerns, ['真实数据库行为尚未验证'])
  await waitFor(() => f.parent.injected.some(message => JSON.stringify(message).includes('真实数据库行为尚未验证')))
  const proof = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  assert.match(proof.nextAction.message, /concernsResolution/)
  await f.execute('delegation_review', { taskId: 'a', verdict: 'accept', concernsResolution: '本次仅验收静态文件，保留真实数据库验证限制。',
    findings: [{ criterionId: 'C1', finding: '已按本次范围核对', evidence: [proof.ref] }] })
  assert.equal(f.snapshot().completion.outcome, 'completed')
})

test('long verification output stays complete across reload and can be read in bounded chunks', async () => {
  const f = await fixture(); await f.plan([card('a')]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  const output = '已核对的正文\n'.repeat(800) + 'TAIL:尚未完成真实数据库验证'
  const execute = f.ctx.tools.execute
  f.ctx.tools.execute = async exec => { const result = await execute(exec); result.content[0].text = output; return result }
  const proof = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  assert.equal(proof.truncated, true)
  assert.equal(proof.outputCharacters, output.length)
  assert.equal(await readFile(proof.outputPath, 'utf8'), output)
  assert.ok(proof.summary.length <= 2000)
  assert.match(f.render('delegation_verify', {}, proof), /truncated|截断/)
  assert.match(proof.readOutput, /delegation_status.*checkIndex/)
  await f.reload()
  let actual = '', offset = 0
  do {
    const args = { taskId: 'a', detail: 'full', checkIndex: 0, offset, limit: 700 }
    const value = await f.execute('delegation_status', args)
    const chunk = JSON.parse(f.render('delegation_status', args, value))
    assert.equal(chunk.available, 'full')
    assert.ok(chunk.content.length <= 700)
    actual += chunk.content; offset = chunk.nextOffset
  } while (offset !== null)
  assert.equal(actual, output)
  await assert.rejects(f.execute('delegation_status', { detail: 'full', checkIndex: 0 }), /taskId/)
  await assert.rejects(f.execute('delegation_status', { taskId: 'a', checkIndex: 0 }), /full/)
  await assert.rejects(f.execute('delegation_status', { taskId: 'a', detail: 'full', checkIndex: 0, offset: -1 }), /offset/)
  await assert.rejects(f.execute('delegation_status', { taskId: 'a', detail: 'full', checkIndex: 0, limit: 100000 }), /limit/)
  const archive = await f.engine.readArchive(f.snapshot().archive.id)
  assert.ok(archive.markdown.includes(proof.outputPath))
  assert.match(archive.markdown, /摘要.*截断|截断.*摘要/)
})

test('failure to retain a new verification output invalidates the older result and preserves its history', async () => {
  const f = await fixture(); await f.plan([card('a')]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  const old = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  await writeFile(path.join(f.snapshot().archive.directory, 'verification'), 'not a directory')
  const execute = f.ctx.tools.execute
  f.ctx.tools.execute = async exec => { const result = await execute(exec); result.content[0].text = '长验证结果'.repeat(1000); return result }
  await assert.rejects(f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 }), /完整验证输出保存失败.*未登记/)
  await f.reload()
  assert.equal(f.snapshot().tasks[0].checks[0].result, null)
  assert.ok(f.snapshot().tasks[0].evidence.some(item => item.callId === old.callId))
  await assert.rejects(f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterionId: 'C1', finding: '旧结果不能代替失败的新验证', evidence: [old.callId] }] }), /本次主控验证/)
  assert.equal(f.snapshot().completion, null)
})

test('normal results advance three dependent tasks without spending completion recovery', async () => {
  const f = await fixture({ autoConclude: true })
  await f.plan([card('a'), card('b', { dependsOn: ['a'] }), card('c', { dependsOn: ['b'] })])
  await f.execute('delegation_run')
  for (const [index, taskId] of ['a', 'b', 'c'].entries()) {
    const waiting = f.endTurn()
    await tick()
    await f.report(index, { status: 'DONE', summary: taskId + ' 已返回', report: '交付物已检查，等待主控验证' })
    await waiting
    assert.equal(f.snapshot().recovery.used, 0, 'a normal result notification is not a missing-step recovery')
    assert.equal(f.snapshot().completion, null)
    const proof = await f.execute('delegation_verify', { taskId, checkIndex: 0 })
    await f.execute('delegation_review', { taskId, verdict: 'accept', findings: [{ criterion: 0, finding: '实际检查通过', evidence: [proof.callId] }] })
  }
  assert.equal(f.snapshot().completion.outcome, 'completed')
  assert.equal(f.calls.length, 3)
  assert.equal(f.parent.injected.filter(message => message.source.kind === 'delegation-recovery').length, 0)
  assert.equal(f.parent.injected.filter(message => message.source.kind === 'delegation-result').length, 3)
  assert.ok(f.pending.every(item => item.receipt.disposeCount === 1))
})

test('completion recovery is bounded per unchanged stage and advances only with actual validation', async () => {
  const f = await fixture()
  await f.plan([card('a')]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  await f.endTurn(); await f.endTurn()
  assert.equal(f.snapshot().recovery.used, 2)
  const proof = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  assert.equal(proof.passed, true)
  await f.endTurn()
  assert.equal(f.snapshot().recovery.used, 1, 'actual verification starts the acceptance stage without inheriting the prior stage cap')
  assert.equal(f.snapshot().completion, null)
  await f.execute('delegation_status')
  await f.endTurn()
  assert.equal(f.snapshot().recovery.used, 2, 'status reads do not reset the recovery cap')
  await f.reload()
  await f.endTurn()
  assert.equal(f.snapshot().completion.outcome, 'blocked')
})

test('the worker receives the exact planned verification tools and arguments without changing its model', async () => {
  const f = await fixture()
  const checks = [{ tool: 'read', arguments: { file_path: 'src/result.js' } },
    { tool: 'pwsh', arguments: { command: 'node --test tests/specific-contract.test.js', description: 'Verify the delivery contract' } }]
  await f.plan([card('a', { checks })]); await f.execute('delegation_run')
  const prompt = f.calls[0].request.prompt.map(block => block.text).join('\n')
  for (const check of checks) {
    assert.ok(prompt.includes(check.tool))
    assert.ok(prompt.includes(JSON.stringify(check.arguments)), 'planned check arguments are supplied intact')
  }
  assert.match(prompt, /局部实现|实现细节/)
  assert.equal(f.calls[0].request.agentOptions.model, 'cheap')
  assert.equal(f.snapshot().tasks[0].execution, null)
})

test('checkpoints retain early successful evidence without exposing the full index or accepting foreign and stale calls', async () => {
  const f = await fixture()
  await f.plan([card('a'), card('b')]); await f.execute('delegation_run')
  for (let i = 0; i < 64; i++) f.engine.observe({ agent: f.children[0], name: 'read', callId: 'read-' + i }, { isError: false, content: [] })
  f.engine.observe({ agent: f.children[0], name: 'read', callId: 'failed-read' }, { isError: true, content: [{ type: 'text', text: 'file not found' }] })
  f.engine.observe({ agent: f.children[1], name: 'read', callId: 'foreign-read' }, { isError: false, content: [] })
  const args = { phase: 'investigation', summary: '已核对早期读取的接口定义', nextStep: '按定义实现', evidence: ['read-0'] }
  await f.checkpoint(0, args)
  assert.equal(f.snapshot().tasks[0].supervision.evidence.length, 16, 'recent activity remains compact')
  assert.equal(f.snapshot().tasks[0].supervision.evidenceIndex, undefined, 'the UI snapshot does not include the internal lookup index')
  const full = await f.execute('delegation_status', { taskId: 'a', detail: 'full' })
  assert.equal(full.task.supervision.evidenceIndex, undefined, 'full task reports do not resend all tool metadata')
  await assert.rejects(f.checkpoint(0, { ...args, evidence: ['failed-read'] }), /证据/)
  await assert.rejects(f.checkpoint(0, { ...args, evidence: ['foreign-read'] }), /证据/)
  await f.engine.readArchive(f.snapshot().archive.id)
  const saved = JSON.parse(await readFile(f.file, 'utf8')).plans[0].tasks[0]
  assert.equal(saved.supervision.evidenceIndex['read-0'].failed, false, 'the index is persisted, not inferred from the recent window')
  await f.complete(0, { stopReason: 'completed', output: [] })
  const proof = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  await f.execute('delegation_review', { taskId: 'a', verdict: 'rework', issues: [{ criterion: 0, severity: 'important', finding: '需要修正实际结果', evidence: [proof.callId] }] })
  await assert.rejects(f.checkpoint(2, args), /证据/, 'the previous attempt does not authorize evidence in the new attempt')
  f.engine.observe({ agent: f.children[2], name: 'read', callId: 'new-attempt-read' }, { isError: false, content: [] })
  await f.checkpoint(2, { ...args, evidence: ['new-attempt-read'] })
  await f.reload()
  const restored = await f.engine.readArchive(f.snapshot().archive.id)
  assert.equal(restored.plan.tasks[0].supervision.evidenceIndex['new-attempt-read'].failed, false)
  assert.equal(restored.plan.tasks[0].supervision.evidenceIndex['read-0'], undefined)
})

test('managed coordination guards conflicting tools but preserves observers and unrelated agents', async () => {
  const f = await fixture()
  assert.equal(f.engine.guardCoordination({ agent: f.parent, name: 'team_task_create', arguments: {} }), undefined, 'direct work keeps its existing tools')
  await f.plan([card('a')]); await f.execute('delegation_run')
  for (const id of ['parent', f.children[0].id]) {
    for (const name of ['team_task_create', 'team_task_update', 'wait_agent', 'subagent']) {
      const message = f.engine.guardCoordination?.({ agent: id === 'parent' ? f.parent : f.children[0], name, callId: `${id}-${name}`, arguments: {} })
      assert.match(message ?? '', /delegation_status|delegation_control|delegation_report/)
    }
    for (const name of ['read', 'team_task_list', 'team_task_get', 'list_agents']) assert.equal(f.engine.guardCoordination({ agent: { id }, name, arguments: {} }), undefined)
  }
  assert.equal(f.engine.guardCoordination({ agent: { id: 'another-session' }, name: 'team_task_create', arguments: {} }), undefined)
  assert.equal(f.snapshot().tasks[0].status, 'running')
  assert.equal(f.snapshot().activationBudget.used, 1)
  assert.equal(f.pending[0].receipt.disposeCount, undefined)
  f.config.enabled = false
  assert.equal(f.engine.guardCoordination?.({ agent: f.parent, name: 'team_task_create', arguments: {} }), undefined)
})

test('failed coordinator operations cannot complete a running task and resolve only after relevant progress', async () => {
  const f = await fixture(); await f.plan([card('a')]); await f.execute('delegation_run')
  await assert.rejects(f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 }), /待评审/)
  let issue = f.snapshot().coordinationIssue
  assert.equal(issue?.tool, 'delegation_verify')
  assert.equal(issue?.taskId, 'a')
  assert.match(issue?.nextAction ?? '', /等待.*报告/)
  assert.equal(issue?.resolvedAt, undefined)
  await f.execute('delegation_status')
  assert.equal(f.snapshot().coordinationIssue.resolvedAt, undefined, 'a successful status read does not repair a failed operation')
  await assert.rejects(f.execute('delegation_report', { status: 'DONE', summary: '已完成', report: '主控声称文件已交付' }), /子会话身份/)
  issue = f.snapshot().coordinationIssue
  assert.equal(issue.tool, 'delegation_report')
  f.emit('session/event', f.parent, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已交付，任务全部完成。' }] } } })
  assert.equal(f.snapshot().tasks[0].status, 'running')
  assert.equal(f.snapshot().completion, null)
  assert.equal(f.snapshot().tasks[0].execution, null)
  assert.equal(f.snapshot().recovery.used, 0)
  await assert.rejects(readFile(path.join(f.directory, 'result.txt')), { code: 'ENOENT' })
  await f.complete(0, { stopReason: 'completed', output: [] })
  assert.ok(f.snapshot().coordinationIssue.resolvedAt, 'the actual worker report advances the stage')
  assert.equal(f.snapshot().completion, null)
  const proof = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  await f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterion: 0, finding: '已核对实际结果', evidence: [proof.callId] }] })
  assert.equal(f.snapshot().completion.outcome, 'completed')
  assert.equal(f.pending[0].receipt.disposeCount, 1)
})

test('coordination failures deduplicate policy and transport observations and persist across reload', async () => {
  const f = await fixture(); await f.plan([card('a')])
  const exec = { agent: f.parent, name: 'team_task_update', callId: 'duplicate-board-completion', arguments: { action: 'complete' } }
  const denial = f.engine.guardCoordination?.(exec)
  assert.match(denial ?? '', /Agentrix/)
  f.engine.guardCoordination(exec)
  f.engine.observe(exec, { isError: true, content: [{ type: 'text', text: denial }] })
  await f.engine.readArchive(f.snapshot().archive.id)
  const saved = JSON.parse(await readFile(f.file, 'utf8')).plans[0]
  assert.equal(saved.coordinationIssue.callId, exec.callId)
  assert.equal(saved.recentEvents.filter(event => event.type === 'plan.coordination_failed').length, 1)
  await f.reload()
  assert.equal(f.snapshot().coordinationIssue.callId, exec.callId)
  assert.equal(f.snapshot().completion, null)
  const archive = await f.engine.readArchive(f.snapshot().archive.id)
  assert.match(archive.markdown, /主控操作未执行/)
  assert.match(archive.markdown, /team_task_update/)
})

test('a failed verification remains unresolved when its successful transport omits the structured failure value', async () => {
  const f = await fixture()
  await f.plan([card('a', { checks: [{ tool: 'pwsh', arguments: { command: 'isolated check' } }] })]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  f.setExit(1)
  const proof = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  assert.equal(proof.passed, false)
  const issue = f.snapshot().coordinationIssue
  assert.equal(issue.tool, 'delegation_verify')
  assert.equal(issue.resolvedAt, undefined)
  f.emit('session/event', f.parent, { type: 'tool/call', data: { name: 'delegation_verify', callId: issue.callId, arguments: JSON.stringify({ taskId: 'a', checkIndex: 0 }) } })
  f.emit('session/event', f.parent, { type: 'tool/result', data: { message: { toolCallId: issue.callId, isError: false, content: [{ type: 'text', text: JSON.stringify(proof) }] } } })
  assert.equal(f.snapshot().coordinationIssue.resolvedAt, undefined, 'transport success cannot turn failed verification into successful progress')
  assert.equal(f.snapshot().completion, null)
  f.setExit(0)
  await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  assert.ok(f.snapshot().coordinationIssue.resolvedAt, 'a new successful verification resolves the original issue')
})

test('verification follows host cancellation without adding a plugin execution deadline', async () => {
  const controller = new AbortController(), f = await fixture({ signal: controller.signal })
  await f.plan([card('long-check')]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  let received
  const original = f.ctx.tools.execute
  f.ctx.tools.execute = async exec => { received = exec.signal; return original(exec) }
  await f.execute('delegation_verify', { taskId: 'long-check', checkIndex: 0 })
  assert.equal(received, controller.signal, 'the host signal must be forwarded without a hidden 60-second deadline')
  controller.abort()
  assert.equal(received.aborted, true)
})

test('a model-confirmed new request never cancels or rewrites the existing worker plan', async () => {
  const f = await fixture(); await f.plan([card('old')]); await f.execute('delegation_run')
  const originalSource = f.snapshot().source
  const message = { id: 'new-request', source: { kind: 'user' }, content: [{ type: 'text', text: '另外开个新任务' }] }
  f.emit('session/event', f.parent, { type: 'agent/inbox/spliced', data: { inserted: [message] } })
  assert.equal(f.snapshot().inputs?.length ?? 0, 0)
  await f.execute('delegation_decide', { relation: 'new', mode: 'direct', reason: '新任务先读取资料，不替换旧任务的执行。' })
  assert.equal(f.engine.sourceOf('parent').messageId, 'new-request')
  assert.deepEqual(f.snapshot().source, originalSource)
  assert.equal(f.snapshot().tasks[0].status, 'running')
  assert.equal(f.snapshot().cancelled, false)
  assert.equal(f.pending[0].receipt.disposeCount, undefined)
  assert.equal(f.calls.length, 1)
  await assert.rejects(f.plan([card('new')]), /当前计划尚未验收/)
  await f.complete(0, { stopReason: 'completed', output: [] })
  const proof = await f.execute('delegation_verify', { taskId: 'old', checkIndex: 0 })
  await f.execute('delegation_review', { taskId: 'old', verdict: 'accept', findings: [{ criterion: 0, finding: '旧需求交付已独立核对', evidence: [proof.callId] }] })
  assert.equal(f.snapshot().completion.outcome, 'completed')
  assert.equal(f.conclusions.includes('parent'), false, 'finishing the old plan cannot end the coordinator handling the new request')
})

test('the delegation decision is recorded separately from planning and actual child activation', async () => {
  const f = await fixture()
  const decision = await f.execute('delegation_decide', { mode: 'delegate', reason: '执行需要逐份核对多份文件，交给执行模型后由主控验证。' })
  assert.equal(f.calls.length, 0)
  const planned = await f.execute('delegation_plan', { goal: '完成任务并由主控验收', tasks: [card('a')] })
  assert.equal(planned.plan.decision.reason, decision.decision.reason)
  assert.equal(f.calls.length, 0)
  await f.execute('delegation_run')
  assert.equal(f.calls.length, 1)
  const archived = await f.engine.readArchive(f.snapshot().archive.id)
  assert.match(archived.markdown, /主控决定：委派/)
  assert.ok(archived.markdown.includes(decision.decision.reason))
})

test('new plans cannot start without a valid delegation reason; legacy queued plans remain compatible', async () => {
  const f = await fixture()
  await f.execute('delegation_plan', { goal: '先准备再决定', tasks: [card('a')] })
  await assert.rejects(f.execute('delegation_run'), /delegation_decide/)
  assert.equal(f.calls.length, 0)
  await assert.rejects(f.execute('delegation_decide', { mode: 'delegate', reason: '' }), /非空/)
  await assert.rejects(f.execute('delegation_decide', { mode: 'other', reason: '执行核对工作后由主控验收。' }), /direct.*delegate/)
  await assert.rejects(f.execute('delegation_decide', { mode: 'direct', reason: '准备直接重复修改这些交付文件。' }), /不能同时/)
  assert.equal(f.calls.length, 0)
  await f.execute('delegation_decide', { mode: 'delegate', reason: '执行模型核对文件，主控独立验证并验收结果。' })
  await f.execute('delegation_run')
  assert.equal(f.calls.length, 1)

  const legacy = await fixture()
  await legacy.execute('delegation_plan', { goal: '旧版已排队任务', tasks: [card('old')] })
  await legacy.reload(async file => {
    const stored = JSON.parse(await readFile(file, 'utf8'))
    delete stored.plans[0].decisionProtocolVersion
    delete stored.decisions
    await writeFile(file, JSON.stringify(stored))
  })
  await legacy.execute('delegation_run')
  assert.equal(legacy.calls.length, 1)
  assert.equal(legacy.snapshot().decision, null, 'legacy startup must not invent a reason')
})

test('review uses the dispatching coordinator snapshot across model changes and reload instead of saved review overrides', async () => {
  const f = await fixture({ models: { worker: { provider: 'local', model: 'cheap' }, reviewer: { provider: 'retired', model: 'obsolete-reviewer' } } })
  let main = { provider: 'local', model: 'dispatcher-high', reasoningEffort: 'high' }
  f.parent.session.requestHeader = () => ({ config: main })
  await f.plan([card('a', { complexity: 'complex' })]); await f.execute('delegation_run')
  const dispatcher = f.snapshot().tasks[0].dispatcherModel
  assert.equal(dispatcher.model, 'dispatcher-high')
  assert.equal(dispatcher.reasoningEffort, 'high')
  assert.equal(dispatcher.attempt, 1)
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).plans[0].tasks[0].dispatcherModel.model, 'dispatcher-high')
  main = { provider: 'local', model: 'later-selector', reasoningEffort: 'low' }
  f.config.enabled = false
  await f.report(0, { status: 'DONE', summary: '执行已返回', report: '等待原分发者模型审查' })
  f.pending[0].resolve({ stopReason: 'completed', output: [] })
  await waitFor(() => f.snapshot().tasks[0].status === 'review')
  await f.reload()
  f.config.enabled = true
  await f.execute('delegation_audit', { taskId: 'a' })
  const audit = f.snapshot().tasks[0].audit
  assert.deepEqual(f.calls[1].request.agentOptions, { provider: 'local', model: 'dispatcher-high', reasoningEffort: 'high' })
  assert.equal(audit.modelRoute.source, 'dispatcher')
  let sent = 0
  f.emit('llm/stream', { sessionId: audit.childId, provider: 'local', model: 'dispatcher-high', reasoningEffort: 'high' }, () => { sent++ })
  assert.throws(() => f.emit('llm/stream', { sessionId: audit.childId, provider: 'local', model: 'later-selector', reasoningEffort: 'low' }, () => { sent++ }), /模型请求与任务配置不一致/)
  assert.equal(sent, 1)
  assert.equal(f.snapshot().tasks[0].dispatcherModel.model, 'dispatcher-high')
})

test('review retries keep the original dispatcher and a new worker attempt captures the new coordinator', async () => {
  const f = await fixture()
  f.parent.options = { provider: 'local', model: 'first-coordinator', reasoningEffort: 'high' }
  await f.plan([card('a', { complexity: 'complex' })]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  f.pending[1].reject(new Error('审查服务暂时失败'))
  await waitFor(() => f.snapshot().tasks[0].audit.status === 'failed')
  f.parent.options = { provider: 'local', model: 'second-coordinator', reasoningEffort: 'low' }
  await f.execute('delegation_audit', { taskId: 'a', message: '原服务已恢复，重试审查' })
  assert.equal(f.calls[2].request.agentOptions.model, 'first-coordinator')
  assert.equal(f.calls[2].request.agentOptions.reasoningEffort, 'high')
  await f.finishAudit(2, { specVerdict: 'pass', qualityVerdict: 'pass', issues: [] })
  const proof = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  await f.execute('delegation_review', { taskId: 'a', verdict: 'rework', issues: [
    { criterion: 0, severity: 'important', finding: '交付缺少约定内容', evidence: [proof.callId] },
  ] })
  assert.equal(f.snapshot().tasks[0].dispatcherModel.model, 'second-coordinator')
  assert.equal(f.snapshot().tasks[0].dispatcherModel.attempt, 2)
  await f.complete(3, { stopReason: 'completed', output: [] })
  assert.equal(f.calls[4].request.agentOptions.model, 'second-coordinator')
  assert.equal(f.calls[4].request.agentOptions.reasoningEffort, 'low')
  const events = await readFile(path.join(f.snapshot().archive.directory, 'events.jsonl'), 'utf8')
  assert.ok(events.includes('first-coordinator') && events.includes('second-coordinator'))
})

test('legacy returned work records a review-time fallback without rewriting its historical model route', async () => {
  const f = await fixture(); await f.plan([card('legacy')]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  await f.reload(async file => {
    const stored = JSON.parse(await readFile(file, 'utf8'))
    delete stored.plans[0].tasks[0].dispatcherModel
    await writeFile(file, JSON.stringify(stored))
  })
  const workerRoute = f.snapshot().tasks[0].modelRoute
  f.parent.options = { provider: 'local', model: 'legacy-review-coordinator' }
  await f.execute('delegation_audit', { taskId: 'legacy' })
  assert.deepEqual(f.snapshot().tasks[0].modelRoute, workerRoute)
  assert.equal(f.snapshot().tasks[0].dispatcherModel.source, 'legacy-review')
  assert.equal(f.calls[1].request.agentOptions.model, 'legacy-review-coordinator')
  const saved = await f.engine.readArchive(f.snapshot().archive.id)
  assert.match(saved.markdown, /旧任务缺少分发快照.*首次审查/s)
})

test('queued tasks capture the coordinator when actually dispatched rather than when the plan was created', async () => {
  const f = await fixture({ maxParallel: 1 })
  f.parent.options.model = 'first-coordinator'
  await f.plan([card('a'), card('b')]); await f.execute('delegation_run')
  assert.equal(f.snapshot().tasks[1].dispatcherModel, undefined)
  f.parent.options.model = 'next-coordinator'
  await f.complete(0, { stopReason: 'completed', output: [] })
  await waitFor(() => f.snapshot().tasks[1].status === 'running')
  assert.equal(f.snapshot().tasks[0].dispatcherModel.model, 'first-coordinator')
  assert.equal(f.snapshot().tasks[1].dispatcherModel.model, 'next-coordinator')
})

test('a completed plan remains archived but is not injected as the current plan for a new request', async () => {
  const options = { source: { messageId: 'request-old', text: '完成第一项交付' } }
  const f = await fixture(options); await f.plan([card('old-delivery')]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  const proof = await f.execute('delegation_verify', { taskId: 'old-delivery', checkIndex: 0 })
  await f.execute('delegation_review', { taskId: 'old-delivery', verdict: 'accept', findings: [{ criterion: 0, finding: '实际验证完成', evidence: [proof.callId] }] })
  const old = f.snapshot()
  assert.match(f.engine.summary('parent'), /old-delivery/)
  options.source = { messageId: 'request-new', text: '检查另一项代码调用' }
  assert.equal(f.engine.summary('parent'), '')
  assert.deepEqual(f.snapshot(), old, 'request selection must not rewrite the old result')
  assert.equal(f.engine.hasPending('parent'), false)
  const archive = await f.engine.readArchive(old.archive.id)
  assert.equal(archive.plan.completion.id, old.completion.id)
  assert.equal(archive.plan.source.messageId, 'request-old')
  assert.equal(f.pending.length, 1)
})

test('request and elapsed reminders keep the same worker running without waking the coordinator', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const f = await fixture({ taskTimeoutMinutes: 1 })
  await f.plan([card('continuous')]); await f.execute('delegation_run')
  const childId = f.children[0].id
  for (let i = 0; i < 85; i++) f.emit('llm/stream', { sessionId: childId, provider: 'local', model: 'cheap' }, () => {})
  t.mock.timers.tick(70_000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.snapshot().tasks[0].status, 'running')
  assert.equal(f.snapshot().tasks[0].childId, childId)
  assert.equal(f.calls.length, 1)
  assert.equal(f.parent.injected.length, 0)
  assert.equal(f.snapshot().tasks[0].supervision.used, 0)
  assert.equal(f.snapshot().tasks[0].supervision.metrics.requests, 85)
  assert.ok(f.snapshot().tasks[0].supervision.notices.REQUEST_VOLUME)
  assert.ok(f.snapshot().tasks[0].supervision.notices.ELAPSED_TIME)
  t.mock.timers.reset()
  await f.complete(0, { stopReason: 'completed', output: [] })
  assert.equal(f.snapshot().tasks[0].status, 'review')
  assert.equal(f.pending[0].receipt.disposeCount, 1)
})

test('model-facing status omits long reports while scoped details and stored evidence remain complete', async () => {
  const f = await fixture(); await f.plan([card('compact')]); await f.execute('delegation_run')
  const report = '完整交付证据'.repeat(3000)
  await f.complete(0, { stopReason: 'completed', output: [{ type: 'text', text: report }] })
  const status = await f.execute('delegation_status')
  const rendered = f.render('delegation_status', {}, status)
  assert.ok(rendered.length < JSON.stringify(status).length * 0.3)
  assert.ok(!rendered.includes(report))
  const detail = await f.execute('delegation_status', { taskId: 'compact', detail: 'full' })
  assert.equal(detail.task.report, report)
  await assert.rejects(f.execute('delegation_status', { detail: 'full' }), /taskId|任务/)
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).plans[0].tasks[0].report, report)
})

test('request usage includes preparation, both child roles and retries, deduplicates messages and survives reload', async () => {
  const f = await fixture()
  const message = (agent, seq, usage) => f.emit('session/event', agent, { type: 'assistant/message', seq, data: { usage } })
  f.emit('llm/stream', { sessionId: 'parent', provider: 'local', model: 'parent' }, () => {})
  message(f.parent, 1, { inputTokens: 100, cacheReadTokens: 200, outputTokens: 10 })
  assert.equal(f.engine.requestUsage('parent').roles[0].inputTokens, 100)
  await f.plan([card('usage', { complexity: 'complex' })]); await f.execute('delegation_run')
  const child = f.children[0]
  f.emit('llm/stream', { sessionId: child.id, provider: 'local', model: 'cheap' }, () => {})
  message(child, 2, { inputTokens: 300, cacheReadTokens: 400, outputTokens: 20 })
  message(child, 2, { inputTokens: 300, cacheReadTokens: 400, outputTokens: 20 })
  await f.complete(0, { stopReason: 'completed', output: [] })
  const audit = f.children[1]
  f.emit('llm/stream', { sessionId: audit.id, provider: 'local', model: 'parent' }, () => {})
  message(audit, 3, { inputTokens: 500, outputTokens: 30 })
  await f.finishAudit(1, { specVerdict: 'pass', qualityVerdict: 'pass', issues: [] })
  const usage = f.snapshot().usage
  assert.deepEqual(usage.roles.map(row => [row.role, row.inputTokens, row.cacheReadTokens, row.outputTokens]),
    [['coordinator', 100, 200, 10], ['worker', 300, 400, 20], ['reviewer', 500, null, 30]])
  assert.equal(usage.roles[1].responses, 1)
  const markdown = await readFile(f.snapshot().archive.summaryPath, 'utf8')
  assert.match(markdown, /本次需求用量/)
  assert.match(markdown, /缓存读取.*200/)
  await f.reload()
  assert.deepEqual(f.snapshot().usage, usage)
  const reread = f.engine.requestUsage('parent')
  message(f.parent, 1, { inputTokens: 100, cacheReadTokens: 200, outputTokens: 10 })
  assert.deepEqual(f.engine.requestUsage('parent'), reread)
  const proof = await f.execute('delegation_verify', { taskId: 'usage', checkIndex: 0 })
  await f.execute('delegation_review', { taskId: 'usage', verdict: 'rework', issues: [
    { criterion: 0, severity: 'important', finding: '需要补充原要求', evidence: [proof.callId] },
  ] })
  await f.execute('delegation_run')
  const retry = f.children.at(-1)
  f.emit('llm/stream', { sessionId: retry.id, provider: 'local', model: 'cheap' }, () => {})
  message(retry, 4, { inputTokens: 50, outputTokens: 5 })
  assert.deepEqual(f.snapshot().usage.roles.filter(row => row.role === 'worker').map(row => [row.attempt, row.inputTokens]), [[1, 300], [2, 50]])
})

test('direct usage follows the actual request model across selector changes and reload without creating a plan', async () => {
  const options = { source: { messageId: 'direct-one', text: '小修直接完成' } }
  const f = await fixture(options)
  f.emit('llm/stream', { sessionId: 'parent', provider: 'local', model: 'parent' }, () => {})
  f.parent.options.model = 'new-selection'
  f.emit('session/event', f.parent, { type: 'assistant/message', seq: 1, data: { usage: { inputTokens: 12, cacheReadTokens: 8, outputTokens: 3 } } })
  const first = f.engine.requestUsage('parent')
  assert.equal(first.roles[0].model, 'parent')
  assert.equal(first.roles[0].inputTokens, 12)
  assert.equal(f.snapshot(), undefined)
  assert.equal(f.calls.length, 0)
  await f.reload()
  assert.deepEqual(f.engine.requestUsage('parent'), first)
  options.source = { messageId: 'direct-two', text: '另一个小需求' }
  f.emit('llm/stream', { sessionId: 'parent', provider: 'local', model: 'new-selection' }, () => {})
  f.emit('session/event', f.parent, { type: 'assistant/message', seq: 2, data: {} })
  const next = f.engine.requestUsage('parent')
  assert.equal(next.requestId, 'direct-two')
  assert.equal(next.complete, false)
  assert.equal(next.roles[0].inputTokens, null)
  assert.equal(next.roles[0].requests, 1)
  assert.equal(f.calls.length, 0)
})

test('read-only reviewers keep working and may checkpoint their evidence without spending correction allowance', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const f = await fixture({ taskTimeoutMinutes: 1 })
  await f.plan([card('a', { complexity: 'complex' })]); await f.execute('delegation_run')
  t.mock.timers.reset()
  await f.complete(0, { stopReason: 'completed', output: [] })
  const audit = f.children[1]
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  for (let i = 0; i < 7; i++) {
    f.engine.observe({ agent: audit, name: 'read', arguments: { file_path: `part-${i}.js` }, callId: `part-${i}` }, { isError: false, content: [] })
    t.mock.timers.tick(5 * 60_000)
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(f.engine.guardChild({ agent: audit, name: 'delegation_checkpoint' }), undefined)
  await f.checkpoint(1, { phase: 'verification', summary: '已核对七份交付物。', nextStep: '提交审查报告。', evidence: ['part-6'] })
  const full = await f.execute('delegation_status', { taskId: 'a', detail: 'full' })
  assert.equal(full.task.audit.supervision.evidenceIndex, undefined, 'review evidence lookup stays internal in worker detail too')
  assert.equal(f.snapshot().tasks[0].audit.status, 'running')
  assert.equal(f.snapshot().tasks[0].audit.supervision.used, 0)
  assert.equal(f.snapshot().tasks[0].audit.supervision.pending, null)
  assert.equal(f.parent.injected.filter(message => message.source.kind === 'delegation-supervision').length, 0)
  assert.equal(f.calls.length, 2)
})

test('default execution limits dispatch four tasks and retain the expanded plan and time budgets', async () => {
  const f = await fixture()
  await f.plan(['a', 'b', 'c', 'd', 'e'].map(id => card(id)))
  await f.execute('delegation_run')
  const plan = f.snapshot()
  assert.equal(f.calls.length, 4)
  assert.equal(plan.tasks[4].status, 'queued')
  assert.equal(plan.activationBudget.limit, 64)
  for (const task of plan.tasks.slice(0, 4)) {
    assert.equal(task.supervision.remindAt - task.supervision.startedAt, 120 * 60_000)
  }
})

test('execution ignores complexity and both independent audit paths use the dispatching coordinator', async () => {
  const f = await fixture({ autoConclude: true, models: {
    worker: { provider: 'local', model: 'low-worker' }, reviewer: { provider: 'local', model: 'high-reviewer' },
  } })
  await f.plan([card('routine'), card('complex', { complexity: 'complex' })])
  await f.execute('delegation_run')
  assert.deepEqual(f.calls.map(call => call.request.agentOptions.model), ['low-worker', 'low-worker'])
  assert.deepEqual(f.snapshot().tasks.map(task => task.modelRoute.role), ['worker', 'worker'])
  await f.report(1, { status: 'DONE', summary: '复杂任务已按方案执行', report: '交付物等待高模型核对' })
  await waitFor(() => f.calls.length === 3)
  assert.equal(f.calls[2].request.agentOptions.model, 'parent')
  assert.equal(f.snapshot().tasks[1].audit.modelRoute.role, 'reviewer')
  await f.report(0, { status: 'DONE', summary: '普通任务已执行', report: '交付物等待核对' })
  await waitFor(() => f.snapshot().tasks[0].status === 'review')
  await f.execute('delegation_audit', { taskId: 'routine' })
  assert.equal(f.calls[3].request.agentOptions.model, 'parent')
  assert.equal(f.parent.options.model, 'parent')
  const saved = await f.engine.readArchive(f.snapshot().archive.id)
  assert.match(saved.markdown, /模型角色：执行模型/)
  assert.match(saved.markdown, /审查模型：local \/ parent/)
})

test('an unset worker never inherits the coordinator and review uses the saved dispatcher route', async () => {
  const f = await fixture({ autoConclude: true, models: { worker: null, reviewer: null } })
  await f.plan([card('a', { complexity: 'complex' })])
  await assert.rejects(f.execute('delegation_run'), /执行模型尚未配置/)
  assert.equal(f.calls.length, 0)
  assert.equal(f.snapshot().tasks[0].attempts, 0)
  assert.equal(f.snapshot().activationBudget.used, 0)
  assert.equal(f.snapshot().tasks[0].issue.role, 'worker')
  f.config.models.worker = { provider: 'local', model: 'low-worker' }
  await f.execute('delegation_run')
  await f.report(0, { status: 'DONE', summary: '已执行', report: '交付物待审查' })
  await waitFor(() => f.calls.length === 2)
  assert.equal(f.calls[0].request.agentOptions.model, 'low-worker')
  assert.equal(f.calls[1].request.agentOptions.model, 'parent')
  assert.equal(f.snapshot().tasks[0].audit.modelRoute.source, 'dispatcher')
  f.parent.options.model = 'changed-parent'
  let sent = 0
  const childId = f.snapshot().tasks[0].audit.childId
  f.emit('llm/stream', { sessionId: childId, provider: 'local', model: 'parent' }, () => { sent++ })
  assert.equal(sent, 1)
  assert.equal(f.snapshot().tasks[0].audit.modelRoute.actual.model, 'parent')
})

test('an unavailable dispatcher service blocks complex work before spending a worker activation', async () => {
  const f = await fixture({ models: { worker: { provider: 'local', model: 'low-worker' }, reviewer: { provider: 'retired', model: 'high-reviewer' } } })
  f.parent.options = { provider: 'retired', model: 'dispatcher-model' }
  await f.plan([card('a', { complexity: 'complex' })])
  await assert.rejects(f.execute('delegation_run'), /审查模型/)
  assert.equal(f.calls.length, 0)
  assert.equal(f.snapshot().tasks[0].issue.role, 'reviewer')
  assert.equal(f.snapshot().activationBudget.used, 0)
})

test('a coordinator cannot use an unexplained stop as successful cleanup', async () => {
  const f = await fixture()
  await f.plan([card('responsive-layout')]); await f.execute('delegation_run')
  await assert.rejects(f.execute('delegation_control', { taskId: 'responsive-layout', action: 'stop' }), /取消原因/)
  assert.equal(f.snapshot().tasks[0].status, 'running')
  assert.equal(f.pending[0].receipt.disposed, undefined)
  await f.execute('delegation_control', { taskId: 'responsive-layout', action: 'stop', reason: '用户明确取消本次修改' })
  assert.equal(f.snapshot().status, 'cancelled')
  assert.equal(f.snapshot().tasks[0].error, null)
  assert.equal(f.snapshot().tasks[0].stop.reason, '用户明确取消本次修改')
  assert.equal(f.snapshot().tasks[0].review, null)
  assert.equal(f.pending[0].receipt.disposeCount, 1)
})

test('an unexplained whole-plan cancel preserves failure and requires an explicit task retry', async () => {
  const f = await fixture({ maxAttempts: 2 })
  await f.plan([card('a')]); await f.execute('delegation_run')
  f.pending[0].reject(new Error('模型服务短暂不可用'))
  await waitFor(() => f.snapshot().tasks[0].status === 'failed')
  const result = await f.execute('delegation_cancel')
  assert.equal(result.status, 'blocked')
  assert.equal(f.snapshot().cancelled, false)
  assert.equal(f.snapshot().tasks[0].status, 'failed')
  assert.equal(f.calls.length, 1)
  await f.execute('delegation_control', { taskId: 'a', action: 'retry', message: '已处理服务错误，只重试失败任务' })
  assert.equal(f.snapshot().tasks[0].status, 'running')
  assert.equal(f.snapshot().tasks[0].attempts, 2)
  assert.equal(f.calls.length, 2)
  assert.equal(f.snapshot().completion, null)
})

test('an explicit reason still cancels a failed plan, while exhausted retries stay blocked', async () => {
  const explicit = await fixture({ maxAttempts: 2 })
  await explicit.plan([card('a')]); await explicit.execute('delegation_run')
  explicit.pending[0].reject(new Error('外部服务不可用'))
  await waitFor(() => explicit.snapshot().tasks[0].status === 'failed')
  await explicit.cancel({ reason: '用户明确取消，不再继续尝试' })
  assert.equal(explicit.snapshot().status, 'cancelled')
  assert.equal(explicit.snapshot().completion.outcome, 'cancelled')
  await assert.rejects(explicit.execute('delegation_run'), /计划已明确取消/)

  const exhausted = await fixture({ maxAttempts: 1 })
  await exhausted.plan([card('b')]); await exhausted.execute('delegation_run')
  exhausted.pending[0].reject(new Error('重试额度已用尽'))
  await waitFor(() => exhausted.snapshot().tasks[0].status === 'failed')
  const result = await exhausted.execute('delegation_cancel')
  assert.equal(result.status, 'blocked')
  assert.equal(exhausted.snapshot().cancelled, false)
  assert.equal(exhausted.snapshot().completion.outcome, 'blocked')
  assert.equal(exhausted.calls.length, 1)
})

test('a legacy internal cancellation can resume the original plan after the retry limit is raised', async () => {
  const f = await fixture({ maxAttempts: 2 })
  await f.plan([card('a')]); await f.execute('delegation_run')
  await f.cancel()
  await f.reload(async file => {
    const stored = JSON.parse(await readFile(file, 'utf8'))
    stored.plans[0].cancelledBy = 'implicit'
    stored.plans[0].tasks[0].stop.reason = '主控明确取消整个计划'
    await writeFile(file, JSON.stringify(stored))
  })
  assert.equal(f.snapshot().status, 'cancelled')
  const result = await f.execute('delegation_run')
  assert.equal(result.plan.status, 'running')
  assert.equal(f.snapshot().completion, null)
  assert.equal(f.snapshot().tasks[0].status, 'running')
  assert.equal(f.snapshot().tasks[0].attempts, 2)
  assert.equal(f.calls.length, 2)
})

test('a committed report concludes the original child and a failed tool result cannot become a report', async () => {
  const f = await fixture({ autoConclude: true })
  await f.plan([card('a')]); await f.execute('delegation_run')
  assert.equal(f.calls[0].delivery, 'caller')
  const childId = f.pending[0].receipt.childId
  assert.match(f.engine.guardChild({ agent: { id: childId }, name: 'send_message' }), /报告/)
  await f.report(0, { status: 'DONE', summary: '正式提交', report: '完整产物与验证记录' })
  await waitFor(() => f.snapshot().tasks[0].status === 'review')
  assert.equal(f.snapshot().tasks[0].execution.commitState, 'committed')
  assert.equal(f.conclusions.filter(id => id === childId).length, 1)
  assert.equal(f.pending[0].receipt.disposeCount, 1)
  assert.match(f.engine.guardChild({ agent: { id: childId }, name: 'edit' }), /报告已提交/)
  const failed = await fixture({ autoConclude: true, reportResultError: true })
  await failed.plan([card('b')]); await failed.execute('delegation_run')
  await assert.rejects(failed.report(0, { status: 'DONE', summary: '尚未确认', report: '工具输出管线失败' }), /管线/)
  assert.notEqual(failed.snapshot().tasks[0].execution?.commitState, 'committed')
  assert.equal(failed.snapshot().tasks[0].review, null)
})

test('the final accepted tool result creates an authoritative receipt and concludes the coordinator', async () => {
  const f = await fixture({ autoConclude: true })
  await f.plan([card('a')]); await f.execute('delegation_run')
  await f.report(0, { status: 'DONE', summary: '等待验收', report: '文件与测试记录' })
  await waitFor(() => f.snapshot().tasks[0].status === 'review')
  assert.equal(f.snapshot().completion, null)
  const evidence = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  const result = await f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterion: 0, finding: '实际读取符合要求', evidence: [evidence.callId] }] })
  const receipt = f.snapshot().completion
  assert.equal(receipt.outcome, 'completed')
  assert.equal(receipt.accepted, 1)
  assert.deepEqual(receipt.remaining, [])
  assert.ok(receipt.evidence.includes(evidence.callId))
  assert.deepEqual(receipt.deliverables, [{ taskId: 'a', title: 'a', paths: ['result.txt'] }])
  assert.equal(result.completion.id, receipt.id)
  assert.equal(f.conclusions.filter(id => id === f.parent.id).length, 1)
  await f.execute('delegation_control', { taskId: 'a', action: 'stop' })
  await f.cancel()
  assert.equal(f.snapshot().completion.id, receipt.id)
  assert.equal(f.snapshot().status, 'accepted')
  await f.emit('session/event', { id: f.parent.id }, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  assert.equal(f.snapshot().completion.id, receipt.id, 'later host cleanup must preserve an accepted receipt')
  assert.notEqual(f.snapshot().cancelled, true)
  assert.equal(f.pending[0].receipt.disposeCount, 1)
  const saved = await f.engine.readArchive(f.snapshot().archive.id)
  assert.ok(saved.markdown.includes(receipt.id))
})

test('turn stopping repairs the same child twice and then blocks without reopening it', async () => {
  const f = await fixture()
  await f.plan([card('a')]); await f.execute('delegation_run')
  await f.endTurn(0); await f.endTurn(0)
  assert.equal(f.children[0].injected.length, 2)
  assert.equal(f.snapshot().tasks[0].recovery.used, 2)
  await f.endTurn(0)
  await waitFor(() => f.snapshot().tasks[0].status === 'blocked')
  assert.equal(f.snapshot().tasks[0].issue.code, 'REPORT_REQUIRED')
  assert.equal(f.pending[0].receipt.disposeCount, 1)
  assert.equal(f.calls.length, 1)
  await f.execute('delegation_status'); await f.reload()
  assert.equal(f.snapshot().tasks[0].recovery.used, 2)
  assert.equal(f.calls.length, 1)
})

test('coordinator recovery is bounded, persists and never turns unverified work into success', async () => {
  const f = await fixture({ autoConclude: true })
  await f.plan([card('a')]); await f.execute('delegation_run')
  await f.report(0, { status: 'DONE', summary: '已有产物', report: '等待主控验证' })
  await waitFor(() => f.snapshot().tasks[0].status === 'review')
  await f.endTurn(); await f.endTurn()
  assert.equal(f.parent.injected.filter(message => message.source.kind === 'delegation-recovery').length, 2)
  await f.endTurn()
  assert.equal(f.snapshot().recovery.used, 2)
  assert.equal(f.snapshot().completion.outcome, 'blocked')
  assert.equal(f.snapshot().completion.accepted, 0)
  assert.match(f.snapshot().completion.reason, /两次|2/)
  await f.reload()
  assert.equal(f.snapshot().recovery.used, 2)
  assert.equal(f.calls.length, 1)
})

test('coordinator stopping waits on the original child and user cancellation prevents any wakeup', async () => {
  const f = await fixture({ autoConclude: true })
  await f.plan([card('a')]); await f.execute('delegation_run')
  const waiting = f.endTurn()
  await tick()
  assert.equal(f.parent.injected.length, 0)
  await f.report(0, { status: 'DONE', summary: '已返回', report: '等待实际验证' })
  await waiting
  assert.equal(f.calls.length, 1)
  assert.equal(f.parent.injected.filter(message => message.source.kind === 'delegation-result').length, 1)
  assert.equal(f.snapshot().recovery.used, 0)
  const cancelled = await fixture()
  await cancelled.plan([card('b')]); await cancelled.execute('delegation_run')
  const controller = new AbortController(), stop = cancelled.endTurn(undefined, controller.signal)
  controller.abort(new Error('用户停止'))
  await stop
  await cancelled.emit('session/event', { id: cancelled.parent.id }, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  await waitFor(() => cancelled.pending[0].receipt.disposed)
  assert.equal(cancelled.snapshot().cancelled, false)
  assert.equal(cancelled.snapshot().completion.outcome, 'blocked')
  assert.ok(cancelled.snapshot().interruption)
  assert.equal(cancelled.parent.injected.length, 0)
  assert.equal(cancelled.calls.length, 1)
  assert.equal(cancelled.pending[0].receipt.disposeCount, 1)
})

test('failed work and partial cancellation keep their causes in the generated receipt', async () => {
  const failed = await fixture()
  await failed.plan([card('a')]); await failed.execute('delegation_run')
  failed.pending[0].reject(new Error('模型服务 403，无访问权限'))
  await waitFor(() => failed.snapshot().tasks[0].status === 'failed')
  await failed.endTurn()
  assert.equal(failed.snapshot().completion.outcome, 'blocked')
  assert.match(failed.snapshot().completion.remaining[0].reason, /403/)
  await failed.execute('delegation_control', { taskId: 'a', action: 'stop', reason: '用户选择暂不处理服务权限' })
  assert.match(failed.snapshot().tasks[0].error, /403/)
  const partial = await fixture({ autoConclude: true })
  await partial.plan([card('a'), card('b')]); await partial.execute('delegation_run')
  await partial.report(0, { status: 'DONE', summary: 'a 已返回', report: '交付物 a' })
  await waitFor(() => partial.snapshot().tasks[0].status === 'review')
  const evidence = await partial.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  await partial.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterion: 0, finding: '已核对', evidence: [evidence.callId] }] })
  await partial.execute('delegation_control', { taskId: 'b', action: 'stop', reason: '用户取消剩余任务' })
  assert.equal(partial.snapshot().completion.outcome, 'partial')
  assert.equal(partial.snapshot().completion.accepted, 1)
  assert.match(partial.snapshot().completion.remaining[0].reason, /取消剩余/)
  assert.equal(partial.snapshot().status, 'cancelled')
  const saved = await partial.engine.readArchive(partial.snapshot().archive.id)
  assert.match(saved.markdown, /部分完成，其余已停止/)
  assert.match(saved.markdown, /取消来源：主控/)
  assert.match(saved.markdown, /取消剩余任务/)
})

test('a rejected acceptance result cannot commit success and cancellation wins a report race', async () => {
  const options = { autoConclude: true, reviewResultError: true }
  const f = await fixture(options)
  await f.plan([card('a')]); await f.execute('delegation_run')
  await f.report(0, { status: 'DONE', summary: '待验收', report: '已返回产物' })
  await waitFor(() => f.snapshot().tasks[0].status === 'review')
  const evidence = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  const review = { taskId: 'a', verdict: 'accept', findings: [{ criterion: 0, finding: '实际核对通过', evidence: [evidence.callId] }] }
  await assert.rejects(f.execute('delegation_review', review), /管线/)
  assert.equal(f.snapshot().tasks[0].status, 'review')
  assert.equal(f.snapshot().tasks[0].pendingAcceptance, undefined)
  assert.equal(f.snapshot().completion, null)
  options.reviewResultError = false
  await f.execute('delegation_review', review)
  assert.equal(f.snapshot().completion.outcome, 'completed')

  const raced = await fixture({ autoConclude: true, async beforeResult(exec) {
    if (exec.name === 'delegation_report') await raced.cancel()
  } })
  await raced.plan([card('b')]); await raced.execute('delegation_run')
  await raced.report(0, { status: 'DONE', summary: '已写文件', report: '报告与取消同时发生时保留本报告' })
  await tick()
  const task = raced.snapshot().tasks[0]
  assert.equal(task.status, 'cancelled')
  assert.equal(task.report, '报告与取消同时发生时保留本报告')
  assert.notEqual(task.execution.commitState, 'committed')
  assert.equal(task.review, null)
  assert.equal(raced.snapshot().completion.outcome, 'cancelled')
  assert.equal(raced.pending[0].receipt.disposeCount, 1)
  assert.equal(raced.parent.injected.length, 0)
  assert.equal(raced.calls.length, 1)
})

test('plugin disposal rolls back an unconfirmed acceptance before saving the reload state', async () => {
  const f = await fixture({ autoConclude: true, async beforeResult(exec) {
    if (exec.name === 'delegation_review') await f.engine.dispose()
  } })
  await f.plan([card('a')]); await f.execute('delegation_run')
  await f.report(0, { status: 'DONE', summary: '已返回', report: '实际工具结果尚未确认验收' })
  await waitFor(() => f.snapshot().tasks[0].status === 'review')
  const evidence = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  await f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterion: 0, finding: '待工具确认', evidence: [evidence.callId] }] })
  const saved = JSON.parse(await readFile(f.file, 'utf8')).plans[0]
  assert.equal(saved.tasks[0].pendingAcceptance, undefined)
  assert.equal(saved.tasks[0].status, 'review')
  assert.equal(saved.completion, null)
  assert.equal(f.pending[0].receipt.disposeCount, 1)
})

test('an explicit retry invalidates the old cancellation receipt and resumes only that task', async () => {
  const f = await fixture({ maxParallel: 1 })
  await f.plan([card('a'), card('b')]); await f.execute('delegation_run')
  await f.cancel()
  const old = f.snapshot().completion
  await f.execute('delegation_control', { taskId: 'a', action: 'retry', message: '用户明确恢复 a，取消 b 的决定保持' })
  assert.equal(f.calls.length, 2)
  assert.equal(f.snapshot().tasks[0].status, 'running')
  assert.equal(f.snapshot().tasks[0].stop, undefined)
  assert.equal(f.snapshot().tasks[1].status, 'cancelled')
  assert.equal(f.snapshot().completion, null)
  const events = (await readFile(path.join(f.snapshot().archive.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.ok(events.some(event => event.type === 'plan.completion_invalidated' && event.completion.id === old.id))
  assert.ok(events.some(event => event.type === 'task.retry' && event.stop.reason))
})

test('structured worker reports preserve full evidence and isolate missing context without reopening that worker', async () => {
  const f = await fixture({ maxParallel: 1 })
  await f.plan([card('a'), card('b')]); await f.execute('delegation_run')
  const report = '已检查现有接口。\n' + '完整证据\n'.repeat(900) + '尾部证据保留'
  await assert.rejects(f.execute('delegation_report', { status: 'DONE', summary: '伪造报告', report }), /子.*身份|当前执行者/)
  await f.report(0, { status: 'NEEDS_CONTEXT', summary: '缺少接口约定', reason: '需要确认返回字段定义', report })
  f.pending[0].resolve({ stopReason: 'completed', output: [{ type: 'text', text: '短返回' }] }); await tick()
  const task = f.snapshot().tasks[0]
  assert.equal(task.status, 'blocked')
  assert.equal(task.execution.status, 'NEEDS_CONTEXT')
  assert.equal(task.report, report)
  assert.equal(await readFile(task.execution.reportPath, 'utf8'), report)
  assert.match(task.error, /需要确认返回字段定义/)
  await waitFor(() => f.calls.length === 2)
  assert.equal(f.snapshot().autoDispatch, true)
  assert.equal(f.snapshot().tasks[1].status, 'running')
  assert.equal(f.pending[0].receipt.disposeCount, 1)
  await assert.rejects(f.report(0, { status: 'DONE', summary: '过期报告', report: '旧执行者不能覆盖' }), /当前|结束|身份/)
  await f.execute('delegation_status'); await tick()
  assert.equal(f.calls.length, 2)
})

test('complex tasks require one independent read-only reviewer with shared budget, model routing and cleanup', async () => {
  const f = await fixture({ maxParallel: 1, maxActivations: 2 })
  await f.plan([card('a', { complexity: 'complex' })]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] }); await tick()
  assert.equal(f.calls.length, 2)
  assert.equal(f.snapshot().tasks[0].attempts, 1)
  assert.equal(f.snapshot().activationBudget.used, 2)
  const audit = f.snapshot().tasks[0].audit
  assert.equal(audit.status, 'running')
  assert.equal(audit.modelRoute.resolved.model, 'parent')
  assert.notEqual(audit.childId, f.snapshot().tasks[0].childId)
  assert.match(f.calls[1].request.prompt[0].text, /需求.*质量/)
  assert.match(f.calls[1].request.prompt[0].text, /独立|只读/)
  assert.match(f.engine.guardChild({ agent: { id: audit.childId }, name: 'pwsh' }), /只读/)
  assert.match(f.engine.guardChild({ agent: { id: audit.childId }, name: 'subagent' }), /委派/)
  assert.equal(f.engine.guardChild({ agent: { id: audit.childId }, name: 'read' }), undefined)
  const evidence = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  const accept = () => f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterion: 0, finding: '实际读取后符合', evidence: [evidence.callId] }] })
  await assert.rejects(accept(), /独立审查/)
  await f.report(1, { status: 'DONE', summary: '需求与质量均通过', report: '逐条核对任务要求及产物，未发现缺陷。', specVerdict: 'pass', qualityVerdict: 'pass', issues: [] })
  f.pending[1].resolve({ stopReason: 'completed', output: [] }); await tick()
  assert.equal(f.snapshot().tasks[0].audit.status, 'completed')
  assert.equal(f.pending[1].receipt.disposeCount, 1)
  await accept()
  assert.equal(f.snapshot().status, 'accepted')
  assert.equal(f.calls.length, 2)
})

test('rework tracks concrete findings and scoped re-review closes them without extending the task', async () => {
  const f = await fixture({ maxParallel: 1, maxAttempts: 2, maxActivations: 4 })
  await f.plan([card('a', { complexity: 'complex' })]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  await f.finishAudit(1, { specVerdict: 'fail', qualityVerdict: 'pass', issues: [{ criterion: 0, severity: 'important', finding: '返回缺少必要字段', evidence: ['result.txt:2'] }] })
  const oldEvidence = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  const issueId = f.snapshot().tasks[0].issues[0].id
  assert.ok(issueId)
  await f.execute('delegation_review', { taskId: 'a', verdict: 'rework', issueIds: [issueId] })
  assert.equal(f.calls.length, 3)
  assert.match(f.calls[2].request.prompt[0].text, new RegExp(issueId))
  await f.complete(2, { stopReason: 'completed', output: [] })
  assert.match(f.calls[3].request.prompt[0].text, /只复查/)
  await assert.rejects(f.report(3, { status: 'DONE', summary: '跳过旧问题', report: '不能跳过', specVerdict: 'pass', qualityVerdict: 'pass', issues: [] }), /逐条|原问题/)
  await assert.rejects(f.report(3, { status: 'DONE', summary: '扩大范围', report: '未指明由本次修复引入', specVerdict: 'fail', qualityVerdict: 'pass',
    resolutions: [{ id: issueId, status: 'ADDRESSED', evidence: ['result.txt:2 已补字段'] }],
    issues: [{ criterion: 0, severity: 'important', finding: '旧模块也可以重构', evidence: ['unrelated.js:8'] }] }), /范围|本次修复/)
  await f.finishAudit(3, { specVerdict: 'pass', qualityVerdict: 'pass', issues: [],
    resolutions: [{ id: issueId, status: 'ADDRESSED', evidence: ['result.txt:2 已补字段'] }] })
  assert.equal(f.snapshot().tasks[0].issues[0].status, 'addressed')
  await assert.rejects(f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterion: 0, finding: '旧证据', evidence: [oldEvidence.callId] }] }), /验证|证据/)
  const evidence = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  await f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterion: 0, finding: '已重新核对修复', evidence: [evidence.callId] }] })
  assert.equal(f.snapshot().status, 'accepted')
  assert.equal(f.calls.length, 4)
  const saved = await f.engine.readArchive(f.snapshot().archive.id)
  assert.match(saved.markdown, /独立审查/)
  assert.match(saved.markdown, /需求：通过；质量：通过/)
  assert.ok(saved.markdown.includes(issueId + ' · 已解决'))
  assert.ok(saved.markdown.includes('result.txt:2 已补字段'))
  const events = (await readFile(path.join(f.snapshot().archive.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.ok(events.some(event => event.type === 'task.reported' && event.role === 'reviewer' && event.forAttempt === 1 && event.specVerdict === 'fail'))
  await f.reload()
  assert.equal(f.snapshot().tasks[0].issues[0].status, 'addressed')
  assert.equal(f.snapshot().tasks[0].audit.status, 'completed')
  assert.equal(f.calls.length, 4)
})

test('minor suggestions cannot trigger rework and completion concerns need an explicit ruling', async () => {
  const f = await fixture()
  await f.plan([card('a')]); await f.execute('delegation_run')
  await f.report(0, { status: 'DONE_WITH_CONCERNS', summary: '完成但存在疑点', report: '完整结果', concerns: ['实际服务尚未联调'] })
  f.pending[0].resolve({ stopReason: 'completed', output: [] }); await waitFor(() => f.snapshot().tasks[0].status === 'review')
  const evidence = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  await f.execute('delegation_review', { taskId: 'a', verdict: 'rework', issues: [{ criterion: 0, severity: 'minor', finding: '可优化命名', evidence: [evidence.callId] }] })
  assert.equal(f.calls.length, 1)
  assert.equal(f.snapshot().tasks[0].status, 'review')
  await assert.rejects(f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterion: 0, finding: '已核对', evidence: [evidence.callId] }] }), /疑点/)
  await f.execute('delegation_review', { taskId: 'a', verdict: 'accept', concernsResolution: '本任务只要求隔离验证；真实服务验证明确列为未验证。', findings: [{ criterion: 0, finding: '已核对', evidence: [evidence.callId] }] })
  assert.equal(f.snapshot().tasks[0].issues[0].status, 'deferred')
})

test('reviewer failure stays local and only an explicit bounded audit retry can reopen it', async () => {
  const f = await fixture({ maxParallel: 1, maxAttempts: 2, maxActivations: 3 })
  await f.plan([card('a', { complexity: 'complex' })]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  f.pending[1].reject(new Error('服务暂时不可用'))
  await waitFor(() => f.snapshot().tasks[0].audit.status === 'failed')
  assert.equal(f.snapshot().autoDispatch, true)
  for (let i = 0; i < 3; i++) await f.execute('delegation_run')
  assert.equal(f.calls.length, 2)
  await assert.rejects(f.execute('delegation_audit', { taskId: 'a' }), /重试依据|原因/)
  await f.execute('delegation_audit', { taskId: 'a', message: '服务恢复，保留原交付物，只重试审查' })
  assert.equal(f.calls.length, 3)
  assert.equal(f.snapshot().tasks[0].attempts, 1)
  await f.finishAudit(2, { specVerdict: 'pass', qualityVerdict: 'pass', issues: [] })
  assert.equal(f.snapshot().activationBudget.used, 3)
  assert.equal(f.pending[1].receipt.disposeCount, 1)
  assert.equal(f.pending[2].receipt.disposeCount, 1)
  await f.execute('delegation_audit', { taskId: 'a' })
  assert.equal(f.calls.length, 3, 'completed audit requests are idempotent')
})

test('reviewers cannot escape the activation budget or first-request model guard', async () => {
  const limited = await fixture({ maxActivations: 1 })
  await limited.plan([card('a', { complexity: 'complex' })]); await limited.execute('delegation_run')
  await limited.complete(0, { stopReason: 'completed', output: [] })
  assert.equal(limited.calls.length, 1)
  assert.equal(limited.snapshot().tasks[0].audit.status, 'blocked')
  assert.match(limited.snapshot().tasks[0].audit.error, /预算/)
  let dispatches = 0
  const f = await fixture({ maxParallel: 1, onStart(spec) {
    if (spec.label.startsWith('独立审查')) f.emit('llm/stream', { sessionId: spec.childId, provider: 'local', model: 'cheap' }, () => { dispatches++ })
  } })
  await f.plan([card('a', { complexity: 'complex' })]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  await waitFor(() => f.snapshot().tasks[0].audit.status === 'blocked')
  assert.equal(dispatches, 0)
  assert.equal(f.calls.length, 2)
  assert.equal(f.pending[1].receipt.disposeCount, 1)
  assert.equal(f.snapshot().tasks[0].audit.issue.code, 'MODEL_ROUTE_MISMATCH')
})

test('cancelling a live review releases it once and never restarts it', async () => {
  const f = await fixture()
  await f.plan([card('a', { complexity: 'complex' })]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  await f.cancel(); await tick()
  assert.equal(f.snapshot().status, 'cancelled')
  assert.equal(f.snapshot().tasks[0].audit.status, 'cancelled')
  assert.equal(f.pending[0].receipt.disposeCount, 1)
  assert.equal(f.pending[1].receipt.disposeCount, 1)
  assert.equal(f.calls.length, 2)
})

test('routine rework closes findings only with fresh coordinator evidence', async () => {
  const f = await fixture()
  await f.plan([card('a')]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  const first = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  await f.execute('delegation_review', { taskId: 'a', verdict: 'rework', issues: [{ criterion: 0, severity: 'important', finding: '缺字段', evidence: [first.callId] }] })
  await f.complete(1, { stopReason: 'completed', output: [] })
  const second = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  const id = f.snapshot().tasks[0].reworkIds[0]
  const args = { taskId: 'a', verdict: 'accept', findings: [{ criterion: 0, finding: '字段已补齐', evidence: [second.callId] }] }
  await assert.rejects(f.execute('delegation_review', { ...args, resolutions: [{ id, status: 'ADDRESSED', evidence: [first.callId] }] }), /本次|证据/)
  await f.execute('delegation_review', { ...args, resolutions: [{ id, status: 'ADDRESSED', evidence: [second.callId] }] })
  assert.equal(f.snapshot().tasks[0].issues[0].status, 'addressed')
  assert.equal(f.calls.length, 2)
})

test('review reminders do not stop reviewers and reload still releases them exactly once', async t => {
  const f = await fixture({ taskTimeoutMinutes: 1 })
  await f.plan([card('a', { complexity: 'complex' })]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  await f.reload()
  assert.equal(f.snapshot().tasks[0].audit.status, 'blocked')
  assert.equal(f.pending[1].receipt.disposeCount, 1)
  assert.equal(f.calls.length, 2)
  await assert.rejects(f.execute('delegation_audit', { taskId: 'a', message: '不能绕过清理' }), /stop/)
  const timed = await fixture({ taskTimeoutMinutes: 1 })
  await timed.plan([card('b', { complexity: 'complex' })]); await timed.execute('delegation_run')
  await timed.complete(0, { stopReason: 'completed', output: [] })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // The active timer was created before mocking; explicitly retry an audit after a simulated transport error.
  timed.pending[1].reject(new Error('transport failed'))
  for (let i = 0; i < 100 && timed.snapshot().tasks[0].audit.status !== 'failed'; i++) await new Promise(resolve => setImmediate(resolve))
  await timed.execute('delegation_audit', { taskId: 'b', message: '链路已恢复' })
  t.mock.timers.tick(60_000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(timed.snapshot().tasks[0].audit.status, 'running')
  assert.equal(timed.pending[2].receipt.disposeCount, undefined)
  assert.equal(timed.calls.length, 3)
})

test('concurrent audit requests cannot admit duplicate reviewers while model validation is pending', async () => {
  const f = await fixture()
  await f.plan([card('a')]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  const gate = Promise.withResolvers(), resolveModel = f.ctx.llm.resolveCallConfig
  let validations = 0
  f.ctx.llm.resolveCallConfig = async route => {
    if (++validations === 2) await gate.promise
    return resolveModel(route)
  }
  const first = f.execute('delegation_audit', { taskId: 'a' })
  const second = f.execute('delegation_audit', { taskId: 'a' })
  await waitFor(() => f.calls.length === 2)
  gate.resolve()
  await Promise.all([first, second])
  assert.equal(f.calls.length, 2)
  assert.equal(f.snapshot().activationBudget.used, 2)
  await f.cancel()
  assert.equal(f.pending[1].receipt.disposeCount, 1)
})

test('new tasks cannot omit structured reports while legacy complex tasks retain their original acceptance contract', async () => {
  const current = await fixture()
  await current.plan([card('a')]); await current.execute('delegation_run')
  current.pending[0].resolve({ stopReason: 'completed', output: [{ type: 'text', text: '只说完成' }] })
  await waitFor(() => current.snapshot().tasks[0].status === 'blocked')
  assert.match(current.snapshot().tasks[0].error, /没有提交结构化报告/)
  assert.equal(current.calls.length, 1)
  const legacy = await fixture()
  await legacy.plan([card('old', { complexity: 'complex' })])
  await legacy.reload(async file => {
    const stored = JSON.parse(await readFile(file, 'utf8'))
    for (const key of ['protocolVersion', 'execution', 'issues', 'reworkIds']) delete stored.plans[0].tasks[0][key]
    await writeFile(file, JSON.stringify(stored))
  })
  await legacy.execute('delegation_run')
  legacy.pending[0].resolve({ stopReason: 'completed', output: [{ type: 'text', text: '历史报告' }] })
  await waitFor(() => legacy.snapshot().tasks[0].status === 'review')
  assert.equal(legacy.snapshot().tasks[0].audit, undefined)
  const evidence = await legacy.execute('delegation_verify', { taskId: 'old', checkIndex: 0 })
  await legacy.execute('delegation_review', { taskId: 'old', verdict: 'accept', findings: [{ criterion: 0, finding: '按原合同实际核对', evidence: [evidence.callId] }] })
  assert.equal(legacy.snapshot().status, 'accepted')
  assert.equal(legacy.calls.length, 1)
})

test('preparation tools use exact native permits and keep notes in the current request directory', async () => {
  const source = { messageId: 'request-1', text: '检查业务代码' }
  const f = await fixture({ source })
  f.parent.session.header.cwd = f.directory
  const calls = []
  f.ctx.tools.execute = async exec => {
    calls.push(exec)
    assert.equal(f.engine.allowsVerification(exec), true)
    assert.equal(f.engine.allowsVerification({ ...exec, arguments: { ...exec.arguments, command: 'Remove-Item business.txt' } }), false)
    assert.equal(f.engine.allowsVerification({ ...exec, agent: { id: 'other' } }), false)
    return { isError: false, value: { exitCode: 0 }, content: [{ type: 'text', text: 'baseline' }] }
  }
  await f.execute('delegation_inspect', { operation: 'list', directory: f.directory })
  const notes = []
  for (const kind of ['task_plan', 'findings', 'progress']) {
    const note = await f.execute('delegation_note', { kind, content: kind + ' 内容' })
    assert.equal(await readFile(note.path, 'utf8'), kind + ' 内容')
    assert.ok(note.path.startsWith(f.directory + path.sep))
    notes.push(note.path)
  }
  await f.execute('delegation_inspect', { operation: 'git_status', directory: f.directory })
  assert.equal(calls.length, 2)
  assert.match(calls[1].arguments.command, /--no-optional-locks.*core\.fsmonitor=false.*status/)
  assert.equal(f.engine.allowsVerification(calls[0]), false, 'permit expires when the nested execution completes')
  source.messageId = 'request-2'
  const next = await f.execute('delegation_note', { kind: 'task_plan', content: '新需求' })
  assert.notEqual(next.path, notes[0])
  assert.equal(await readFile(notes[0], 'utf8'), 'task_plan 内容')
  await assert.rejects(f.execute('delegation_note', { kind: '../business', content: 'bad' }), /记录|文件|kind/)
  await assert.rejects(f.execute('delegation_note', { kind: 'task_plan', content: 'bad', path: 'business.txt' }), /参数|路径/)
  await assert.rejects(f.execute('delegation_inspect', { operation: 'list', command: 'Remove-Item business.txt' }), /参数|命令/)
  const linked = path.dirname(next.path)
  const outside = path.join(f.directory, 'outside-notes')
  await mkdir(outside)
  assert.ok(linked.startsWith(f.directory + path.sep))
  await rm(linked, { recursive: true })
  await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.execute('delegation_note', { kind: 'progress', content: 'bad' }), /链接|目录/)
  assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(outside)), [])
})

test('a reserved child route blocks its first mismatched request before any provider dispatch', async () => {
  let dispatches = 0
  const f = await fixture({ maxParallel: 1, onStart(spec, ctx) {
    assert.ok(spec.childId, 'the expected route must be registered before startActivation')
    f.emit('llm/stream', { sessionId: spec.childId, provider: 'local', model: 'parent' }, () => { dispatches++ })
  } })
  await f.plan([card('a'), card('b')]); await f.execute('delegation_run'); await tick()
  assert.equal(dispatches, 0)
  assert.equal(f.calls.length, 1)
  const task = f.snapshot().tasks[0]
  assert.equal(task.issue.code, 'MODEL_ROUTE_MISMATCH')
  assert.equal(f.snapshot().autoDispatch, false)
  assert.equal(f.pending[0].receipt.disposeCount, 1)
  await f.execute('delegation_status'); await tick()
  assert.equal(f.calls.length, 1)
})

test('resolved model snapshots stay fixed and actual requests are distinct from child options', async () => {
  const f = await fixture({ defaultReasoning: 'high' })
  await f.plan([card('a', { complexityReason: '普通文件检查' }), card('b', { complexity: 'complex', complexityReason: '涉及设计判断' })])
  await f.execute('delegation_run')
  assert.deepEqual(f.calls.map(call => call.request.agentOptions.model), ['cheap', 'cheap'])
  assert.deepEqual(f.calls.map(call => call.request.agentOptions.reasoningEffort), ['high', 'high'])
  assert.equal(f.snapshot().tasks[0].modelRoute.actual, null)
  f.parent.options.model = 'new-parent'; f.config.models.worker.model = 'new-worker'
  let dispatches = 0
  for (const [i, model] of ['cheap', 'cheap'].entries()) {
    f.emit('llm/stream', { sessionId: f.pending[i].receipt.childId, provider: 'local', model, reasoningEffort: 'high' }, () => { dispatches++ })
  }
  f.emit('llm/stream', { sessionId: 'unrelated', provider: 'other', model: 'unrelated' }, () => { dispatches++ })
  assert.equal(dispatches, 3)
  const route = f.snapshot().tasks[0].modelRoute
  assert.equal(route.requested.model, 'cheap'); assert.equal(route.actual.model, 'cheap')
  assert.equal(route.source, 'configured'); assert.equal(f.snapshot().tasks[0].complexityReason, '普通文件检查')
  await f.cancel()
  const archive = await f.engine.readArchive(f.snapshot().archive.id)
  assert.match(archive.markdown, /普通文件检查/)
  assert.match(archive.markdown, /配置模型.*cheap/)
  assert.match(archive.markdown, /实际请求模型.*cheap/)
})
test('a coordinator reason alone cannot cancel healthy siblings after one service refusal', async () => {
  const f = await fixture({ maxParallel: 2 })
  await f.plan([card('refused'), card('working')]); await f.execute('delegation_run')
  f.emit('session/event', f.children[0], { type: 'turn/end', data: { reason: { kind: 'error', error: {
    message: 'WorkBuddy: Illegal API invocation from an unapproved channel',
  } } } })
  f.pending[0].resolve({ stopReason: 'error', output: [] })
  await waitFor(() => f.snapshot().tasks[0].status === 'blocked')
  await assert.rejects(f.execute('delegation_cancel', { reason: '其他任务同模型必然也失败，取消整个计划' }), /真实用户消息/)
  assert.equal(f.snapshot().cancelled, false)
  assert.equal(f.snapshot().tasks[1].status, 'running')
  assert.equal(f.pending[1].receipt.disposeCount, undefined)
  await assert.rejects(f.execute('delegation_cancel', { reason: '用户取消', messageId: 'invented' }), /真实用户消息/)
  assert.equal(f.calls.length, 2)
})

test('host interruption resumes the original plan without repeating accepted work', async () => {
  const f = await fixture({ maxParallel: 2 })
  await f.plan([card('accepted'), card('interrupted'), card('queued'), card('refused')]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  const proof = await f.execute('delegation_verify', { taskId: 'accepted' })
  await f.execute('delegation_review', { taskId: 'accepted', verdict: 'accept', findings: [{ criterionId: 'C1', finding: '原产物已验证', evidence: [proof.results[0].ref] }] })
  const archiveId = f.snapshot().archive.id
  await f.emit('session/event', f.parent, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  assert.equal(f.snapshot().cancelled, false)
  assert.equal(f.snapshot().status, 'blocked')
  assert.ok(f.snapshot().interruption)
  assert.equal(f.snapshot().tasks[0].status, 'accepted')
  assert.equal(f.pending[1].receipt.disposeCount, 1)
  const calls = f.calls.length
  await f.reload()
  assert.equal(f.calls.length, calls, 'reload must not restart interrupted tasks')
  await f.execute('delegation_run')
  assert.equal(f.snapshot().archive.id, archiveId)
  assert.equal(f.snapshot().tasks[0].status, 'accepted')
  assert.equal(f.snapshot().tasks[0].checks[0].result.ref, proof.results[0].ref)
  assert.equal(f.snapshot().tasks[1].status, 'running')
  assert.equal(f.snapshot().tasks[1].attempts, 2)
  assert.equal(f.pending[1].receipt.disposeCount, 1)
  const archived = await f.engine.readArchive(archiveId)
  assert.match(archived.markdown, /执行中断与恢复/)
})

test('continuing a host interruption preserves the separate service failure and only resumes interrupted work', async () => {
  const f = await fixture()
  await f.plan([card('refused'), card('interrupted')]); await f.execute('delegation_run')
  f.emit('session/event', f.children[0], { type: 'turn/end', data: { reason: { kind: 'error', error: {
    code: 'AUTH', message: 'WorkBuddy: Illegal API invocation from an unapproved channel',
  } } } })
  f.pending[0].resolve({ stopReason: 'error', output: [] })
  await waitFor(() => f.snapshot().tasks[0].status === 'blocked')
  const failure = f.snapshot().tasks[0].issue
  await f.emit('session/event', f.parent, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  await f.execute('delegation_run')
  assert.equal(f.calls.length, 3)
  assert.equal(f.snapshot().tasks[0].attempts, 1)
  assert.deepEqual(f.snapshot().tasks[0].issue, failure)
  assert.equal(f.snapshot().tasks[1].attempts, 2)
  assert.equal(f.snapshot().tasks[1].status, 'running')
})

test('a committed report interrupted before native settlement resumes at acceptance without re-execution', async () => {
  const f = await fixture()
  await f.plan([card('a')]); await f.execute('delegation_run')
  await f.report(0, { status: 'DONE', summary: '报告已确认', report: '实际交付物已生成，等待验收。' })
  const report = f.snapshot().tasks[0].execution.reportPath
  await f.emit('session/event', f.parent, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  await f.execute('delegation_run')
  assert.equal(f.calls.length, 1)
  assert.equal(f.snapshot().tasks[0].status, 'review')
  assert.equal(f.snapshot().tasks[0].execution.reportPath, report)
  assert.equal(f.pending[0].receipt.disposeCount, 1)
})

test('failed interruption cleanup cannot start a replacement until the old child is drained', async () => {
  const f = await fixture()
  await f.plan([card('a')]); await f.execute('delegation_run')
  f.pending[0].receipt.dispose = async () => { throw new Error('旧执行释放失败') }
  f.ctx.subagents.drainChildren = async () => { throw new Error('旧执行清理失败') }
  await f.emit('session/event', f.parent, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  await assert.rejects(f.execute('delegation_run'), /清理失败|释放失败/)
  assert.equal(f.calls.length, 1)
  f.ctx.subagents.drainChildren = async () => {}
  await f.execute('delegation_run')
  assert.equal(f.calls.length, 2)
})

test('verified user cancellation retains its reason through host shutdown and never auto-resumes', async () => {
  const f = await fixture()
  await f.plan([card('a')]); await f.execute('delegation_run')
  await f.cancel({ reason: '用户取消原任务' })
  const receipt = f.snapshot().completion.id, cancellation = f.snapshot().cancellation
  await f.emit('session/event', f.parent, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  await f.reload()
  assert.equal(f.snapshot().completion.id, receipt)
  assert.deepEqual(f.snapshot().cancellation, cancellation)
  await assert.rejects(f.execute('delegation_run'), /计划已明确取消/)
  assert.equal(f.calls.length, 1)
  const archived = await f.engine.readArchive(f.snapshot().archive.id)
  assert.ok(archived.markdown.includes(cancellation.messageId))
})

test('legacy host-cancelled work stays stopped on reload and a real continue resumes the same task', async () => {
  const f = await fixture()
  await f.plan([card('a')]); await f.execute('delegation_run'); await f.cancel()
  const archiveId = f.snapshot().archive.id
  await f.reload(async file => {
    const stored = JSON.parse(await readFile(file, 'utf8')), plan = stored.plans[0]
    plan.cancelledBy = 'host'; delete plan.cancellation
    plan.tasks[0].stop = { source: 'host', previousStatus: 'running', reason: '宿主中断当前执行，尚未完成验收' }
    await writeFile(file, JSON.stringify(stored))
  })
  assert.equal(f.snapshot().cancelled, true)
  assert.equal(f.calls.length, 1)
  f.emit('session/event', f.parent, { type: 'user/message', data: { id: 'continue-legacy', source: { kind: 'user' }, content: '继续原任务' } })
  await f.execute('delegation_decide', { relation: 'continue', messageId: 'continue-legacy' })
  assert.equal(f.snapshot().archive.id, archiveId)
  assert.equal(f.snapshot().cancelled, false)
  assert.equal(f.snapshot().tasks[0].status, 'running')
  assert.equal(f.calls.length, 2)
})

test('a real continue message restores returned work for acceptance without a new worker', async () => {
  const f = await fixture()
  await f.plan([card('a')]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  const report = f.snapshot().tasks[0].execution.reportPath
  await f.emit('session/event', f.parent, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  f.emit('session/event', f.parent, { type: 'user/message', data: { id: 'continue-original', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } })
  await f.execute('delegation_decide', { relation: 'continue', messageId: 'continue-original' })
  assert.equal(f.snapshot().cancelled, false)
  assert.equal(f.snapshot().tasks[0].status, 'review')
  assert.equal(f.snapshot().tasks[0].execution.reportPath, report)
  assert.equal(f.snapshot().completion, null)
  assert.equal(f.snapshot().nextAction.type, 'verify')
  assert.equal(f.calls.length, 1)
})

test('managed model discovery and dispatch share configured routes without a native session allowlist', async () => {
  const f = await fixture()
  const models = await f.execute('delegation_models')
  assert.equal(models.passed, true)
  assert.equal(models.requested.model, 'cheap')
  assert.equal(models.authorization.source, 'agentrix-config')
  assert.equal(models.actual, null)
  await f.plan([card('a')]); await f.execute('delegation_run')
  assert.equal(f.calls[0].request.agentOptions.model, models.resolved.model)
  assert.equal(f.snapshot().tasks[0].modelRoute.authorization.source, models.authorization.source)
  assert.match(f.engine.guardChild({ agent: f.children[0], name: 'list_subagent_models' }), /启动模型/)
  f.config.models.worker.model = 'changed-worker'
  assert.equal((await f.execute('delegation_models')).requested.model, 'changed-worker')
  assert.equal((await f.execute('delegation_models', { taskId: 'a' })).requested.model, 'cheap')
})

test('an explicit native allowlist blocks both discovery and dispatch before spending an activation', async () => {
  const f = await fixture({ allowedModels: [{ provider: 'local', model: 'parent' }] })
  const models = await f.execute('delegation_models')
  assert.equal(models.passed, false)
  assert.equal(models.issue.code, 'MODEL_ROUTE_UNAUTHORIZED')
  assert.equal(models.authorization.source, 'session-policy')
  await f.plan([card('a')])
  await assert.rejects(f.execute('delegation_run'), /当前会话.*授权/)
  assert.equal(f.calls.length, 0)
  assert.equal(f.snapshot().activationBudget.used, 0)
  assert.equal(f.snapshot().tasks[0].issue.code, models.issue.code)
})

test('managed discovery preserves model resolution errors and does not claim an actual request', async () => {
  const f = await fixture({ models: { worker: { provider: 'retired', model: 'old' } } })
  const models = await f.execute('delegation_models')
  assert.equal(models.passed, false)
  assert.equal(models.issue.code, 'MODEL_CONFIG_INVALID')
  assert.equal(models.actual, null)
  assert.equal(f.calls.length, 0)
})

test('reviewer authorization is checked before a complex worker is created', async () => {
  const f = await fixture({ allowedModels: [{ provider: 'local', model: 'cheap' }] })
  assert.equal((await f.execute('delegation_models')).passed, true)
  const reviewer = await f.execute('delegation_models', { role: 'reviewer' })
  assert.equal(reviewer.passed, false)
  assert.equal(reviewer.requested.model, 'parent')
  await f.plan([card('a', { complexity: 'complex' })])
  await assert.rejects(f.execute('delegation_run'), /当前会话.*授权/)
  assert.equal(f.calls.length, 0)
  assert.equal(f.snapshot().activationBudget.used, 0)
  assert.equal(f.snapshot().tasks[0].modelRoute.authorization.status, 'allowed', 'reviewer denial must not mislabel worker authorization')
})

test('historical running-model records do not invent a past authorization result', async () => {
  const f = await fixture()
  await f.plan([card('a')]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  await f.reload(async file => {
    const stored = JSON.parse(await readFile(file, 'utf8'))
    delete stored.plans[0].tasks[0].modelRoute.authorization
    await writeFile(file, JSON.stringify(stored))
  })
  const result = await f.execute('delegation_models', { taskId: 'a' })
  assert.equal(result.passed, null)
  assert.equal(result.authorization.status, 'unknown')
  assert.equal(f.calls.length, 1)
})

test('multiple continue messages are acknowledged before resuming the original interrupted plan once', async () => {
  const f = await fixture()
  await f.plan([card('a')]); await f.execute('delegation_run')
  await f.emit('session/event', f.parent, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  const archiveId = f.snapshot().archive.id
  for (const id of ['continue-first', 'continue-last']) f.emit('session/event', f.parent, { type: 'user/message', data: { id, source: { kind: 'user' }, content: '继续原任务' } })
  const first = await f.execute('delegation_decide', { relation: 'continue', messageId: 'continue-first' })
  assert.equal(first.pendingMessages.length, 1)
  assert.equal(f.calls.length, 1)
  await f.execute('delegation_decide', { relation: 'continue', messageId: 'continue-last' })
  assert.equal(f.calls.length, 2)
  assert.equal(f.snapshot().archive.id, archiveId)
  assert.equal(f.snapshot().tasks[0].status, 'running')
})

test('a stale direct decision can be repaired within continue without changing the request or adding requirements', async () => {
  const f = await fixture()
  await f.plan([card('a')]); await f.execute('delegation_run')
  await f.emit('session/event', f.parent, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  const archiveId = f.snapshot().archive.id
  await f.reload(async file => {
    const stored = JSON.parse(await readFile(file, 'utf8'))
    stored.decisions[0].decision.mode = 'direct'
    stored.plans[0].decision.mode = 'direct'
    await writeFile(file, JSON.stringify(stored))
  })
  f.emit('session/event', f.parent, { type: 'user/message', data: { id: 'continue-direct', source: { kind: 'user' }, content: '继续' } })
  await f.execute('delegation_decide', { relation: 'continue', messageId: 'continue-direct' })
  assert.equal(f.calls.length, 1, 'the acknowledged message must not cause a failed startup or invent a decision')
  await f.execute('delegation_decide', { relation: 'continue', messageId: 'continue-direct', mode: 'delegate', reason: '继续监督已存在的托管任务，沿用原任务卡与验收要求。' })
  assert.equal(f.calls.length, 2)
  assert.equal(f.snapshot().archive.id, archiveId)
  assert.equal(f.snapshot().inputs, undefined)
  assert.equal(f.snapshot().messageResolution.relation, 'continue')
  assert.equal(f.engine.decisionFor(f.parent.id).mode, 'delegate')
})

test('a continue plan call reuses existing task cards instead of replacing the interrupted archive', async () => {
  const f = await fixture()
  await f.plan([card('original')]); await f.execute('delegation_run')
  await f.emit('session/event', f.parent, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  const archiveId = f.snapshot().archive.id
  f.emit('session/event', f.parent, { type: 'user/message', data: { id: 'continue-plan', source: { kind: 'user' }, content: '继续' } })
  const result = await f.execute('delegation_plan', { relation: 'continue', messageId: 'continue-plan', decisionReason: '继续原计划，由执行者完成、主控验收。', start: true, goal: '继续原需求', tasks: [card('replacement')] })
  assert.equal(result.plan.archive.id, archiveId)
  assert.deepEqual(result.plan.tasks.map(task => task.id), ['original'])
  assert.equal(f.calls.length, 2)
})

async function fixture(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-orchestrator-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const calls = [], pending = [], tools = new Map(), events = new Map(), children = new Map(), conclusions = [], scopedTools = new Map()
  const parent = { id: 'parent', options: { provider: 'local', model: 'parent' }, session: { header: {}, requestHeader: () => undefined,
    snapshotEvents: () => options.allowedModels === undefined ? [] : [{ type: 'subagent/model-selection-policy', data: { allowedModels: options.allowedModels } }] },
    status: 'running', injected: [], inject(message) { this.injected.push(message) }, steer(message) { this.injected.push(message) } }
  let engine, count = 0, exitCode = 0
  const attachScope = agent => {
    if (!options.scopedTools) return
    const definitions = new Map(); scopedTools.set(agent.id, definitions)
    agent.ctx = { tools: {
      register(definition) { definitions.set(definition.name, definition); return () => { if (definitions.get(definition.name) === definition) definitions.delete(definition.name) } },
      restrict() { return () => {} },
    } }
  }
  attachScope(parent)
  const config = { enabled: true, ...DEFAULT_OPTIONS, models: { worker: { provider: 'local', model: 'cheap' }, reviewer: { provider: 'local', model: 'deep' } }, ...options }
  const ctx = {
    get(name) { return { subagents: ctx.subagents, llm: ctx.llm, agents: { get: id => id === parent.id ? parent : children.get(id), list: () => [parent, ...children.values()] } }[name] },
    on(name, fn) { events.set(name, fn); return () => events.delete(name) },
    llm: { async resolveCallConfig(route) {
      if (route.provider === 'retired') throw Object.assign(new Error('no adapter registered for provider "retired"'), { code: 'NO_ADAPTER' })
      if (route.model === 'missing') throw new Error('model unavailable')
      return { config: { ...route, ...(options.defaultReasoning ? { reasoningEffort: options.defaultReasoning } : {}) }, modelInfo: { id: route.model } }
    } },
    subagents: {
      resolveMaxDepth: () => 1,
      async startActivation(spec) {
        calls.push(spec)
        if (options.startError) throw new Error('capacity full')
        const deferred = Promise.withResolvers()
        children.set(spec.childId, { id: spec.childId, session: { header: { origin: 'subagent', parentSession: spec.request.parent.id } },
          injected: [], inject(message) { this.injected.push(message) } })
        attachScope(children.get(spec.childId))
        await events.get('agent/created')?.({ agent: children.get(spec.childId) })
        const receipt = { childId: spec.childId ?? `child-${calls.length}`, result: deferred.promise, async dispose() { receipt.disposed = true; receipt.disposeCount = (receipt.disposeCount ?? 0) + 1; deferred.resolve({ stopReason: 'aborted', output: [] }) } }
        pending.push({ ...deferred, receipt })
        try { options.onStart?.(spec, ctx) } catch (error) { deferred.reject(error) }
        return receipt
      },
      async sendMessage(...args) { calls.push(args); return 'message' },
      async drainChildren() {},
    },
    tools: {
      get: () => ({}),
      view: () => ({ restrictableNames: [...tools.keys()] }),
      register(def) { tools.set(def.name, def); return () => tools.delete(def.name) },
      async execute(exec) {
        assert.equal(engine.allowsVerification(exec), true)
        const result = { isError: false, value: exec.name === 'pwsh' ? { exitCode } : 'file content', content: [{ type: 'text', text: 'actual output' }] }
        engine.observe(exec, result)
        return result
      },
    },
  }
  const file = path.join(directory, 'runs.json')
  const build = () => createOrchestrator({ ctx, file, getConfig: () => config, getSource: () => options.source ?? { messageId: 'request-1', text: '当前需求' }, getRoute: () => options.route ?? null, onDelegated: () => count++ })
  engine = build(); await engine.ready
  cleanup.push(() => engine.dispose())
  const invoke = async (name, args, agent) => {
    let concluded = false
    const exec = { name, arguments: args, agent, callId: `outer-${++count}`, token: {}, signal: options.signal ?? new AbortController().signal,
      concludeTurn() { concluded = true; conclusions.push(agent.id) } }
    try {
      const value = await (scopedTools.get(agent.id)?.get(name) ?? tools.get(name)).execute(args, exec)
      await options.beforeResult?.(exec, value)
      const isError = name === 'delegation_report' && options.reportResultError || name === 'delegation_review' && options.reviewResultError
      await events.get('tools/result')?.(exec, { isError: Boolean(isError), value })
      if (isError) throw new Error('模拟工具输出管线失败')
      if (concluded && options.autoConclude && agent !== parent) pending.find(item => item.receipt.childId === agent.id)?.resolve({ stopReason: 'completed', output: [] })
      return value
    } catch (error) {
      await events.get('tools/result')?.(exec, { isError: true, content: [{ type: 'text', text: error.message }] })
      throw error
    }
  }
  const execute = (name, args = {}, agent = parent) => invoke(name, args, agent)
  const plan = (tasks, agent = parent) => execute('delegation_plan', { goal: '完成任务并由主控验收', decisionReason: '执行者核对隔离文件，主控保留独立上下文验证和验收。', tasks }, agent)
  const snapshot = (sessionId = parent.id) => engine.snapshot().find(plan => plan.sessionId === sessionId)
  return { get engine() { return engine }, ctx, calls, pending, config, execute, plan, snapshot, directory, file, parent, conclusions,
    cancel(args = {}, agent = parent) {
      const messageId = 'cancel-user-' + ++count
      events.get('session/event')?.(agent, { type: 'user/message', data: { id: messageId, source: { kind: 'user' }, content: [{ type: 'text', text: args.reason ?? '取消当前计划' }] } })
      return execute('delegation_cancel', { ...args, reason: args.reason ?? '用户明确取消', messageId }, agent)
    },
    definition: (name, index) => scopedTools.get(index === undefined ? parent.id : pending[index].receipt.childId)?.get(name) ?? tools.get(name),
    render: (name, args, value) => tools.get(name).output.render(args, value).map(block => block.text).join('\n'),
    get children() { return [...children.values()] },
    endTurn: (index, signal = new AbortController().signal) => events.get('agent/turn-stopping')?.({ agent: index === undefined ? parent : children.get(pending[index].receipt.childId), signal }),
    report: (index, args) => invoke('delegation_report', args, children.get(pending[index].receipt.childId)),
    checkpoint: (index, args) => invoke('delegation_checkpoint', args, children.get(pending[index].receipt.childId)),
    async complete(index, result) {
      await this.report(index, { status: 'DONE', summary: '已完成隔离任务', report: result.output?.filter(item => item.type === 'text').map(item => item.text).join('\n') || '已检查隔离产物。' })
      pending[index].resolve(result)
      await waitFor(() => {
        const task = snapshot().tasks.find(item => item.childId === pending[index].receipt.childId)
        return task && !['starting', 'running'].includes(task.status) && !['queued', 'starting'].includes(task.audit?.status)
      })
    },
    async finishAudit(index, values) {
      await this.report(index, { status: 'DONE', summary: '独立审查结论', report: '按任务要求读取实际文件，逐条记录核对结果。', ...values })
      pending[index].resolve({ stopReason: 'completed', output: [] })
      await waitFor(() => snapshot().tasks.some(task => task.audit?.childId === pending[index].receipt.childId && task.audit.status === 'completed'))
    },
    emit: (name, ...args) => events.get(name)?.(...args),
    setExit: value => { exitCode = value }, async reload(transform) {
      await engine.dispose()
      if (transform) await transform(file)
      engine = build(); await engine.ready; return engine
    } }
}

test('optional archive failures do not prevent dispatch or lose persisted acceptance evidence', async () => {
  const f = await fixture()
  await f.plan([card('a')])
  const archive = f.snapshot().archive
  await rm(archive.directory, { recursive: true })
  await writeFile(archive.directory, 'simulate an unavailable document directory')
  await f.execute('delegation_run')
  assert.equal(f.calls.length, 1)
  assert.equal(f.engine.storageError, null)
  assert.match(f.engine.archiveWarning, /档案|记录/)
  await f.complete(0, { stopReason: 'completed', output: [{ type: 'text', text: '已交付' }] })
  await tick()
  const evidence = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  await f.execute('delegation_review', { taskId: 'a', verdict: 'accept',
    findings: [{ criterion: 0, finding: '已核对文件', evidence: [evidence.callId] }] })
  const stored = JSON.parse(await readFile(f.file, 'utf8')).plans[0]
  assert.equal(stored.tasks[0].status, 'accepted')
  assert.ok(stored.tasks[0].review.findings[0].evidence.length)
})

test('failure to persist required runtime state still prevents child startup', async () => {
  const f = await fixture()
  await f.plan([card('a')])
  await unlink(f.file)
  await mkdir(f.file)
  await assert.rejects(f.execute('delegation_run'))
  assert.equal(f.calls.length, 0)
  assert.ok(f.engine.storageError)
  await rm(f.file, { recursive: true })
})

test('current DSH batch execution produces the exact verification evidence under the normal guard', async () => {
  const f = await fixture()
  await f.plan([card('a')])
  await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [{ type: 'text', text: 'done' }] })
  await tick()
  const executeOne = f.ctx.tools.execute
  f.ctx.tools.selectExecutor = () => ({})
  f.ctx.tools.execute = async input => {
    assert.equal(input.calls.length, 1)
    const call = input.calls[0]
    const result = await executeOne({ ...input, name: call.name, callId: call.id, arguments: JSON.parse(call.arguments) })
    return { results: [{ callId: call.id, result }] }
  }
  const evidence = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  assert.equal(evidence.passed, true)
  assert.equal(f.snapshot().tasks[0].checks[0].result.callId, evidence.callId)
})

test('legacy project archives keep their original paths and missing request provenance stays explicit', async () => {
  const f = await fixture()
  f.parent.session.header.cwd = path.join(f.directory, 'project')
  await f.plan([card('a')])
  const id = f.snapshot().archive.id
  const oldDirectory = path.join(f.parent.session.header.cwd, '.agent-tasks', id)
  const engine = await f.reload(async file => {
    const stored = JSON.parse(await readFile(file, 'utf8'))
    const plan = stored.plans[0]
    delete plan.source
    plan.archive = { id, directory: oldDirectory, summaryPath: path.join(oldDirectory, 'task.md') }
    await writeFile(file, JSON.stringify(stored))
  })
  assert.equal(engine.snapshot()[0].archive.directory, oldDirectory)
  assert.equal(engine.snapshot()[0].source, undefined)
  const saved = await engine.readArchive(id)
  assert.match(saved.markdown, /历史记录未保存原始需求/)
  assert.equal(f.calls.length, 0)
})

test('a new plan preserves the previous task archive and its cancellation history', async () => {
  const f = await fixture()
  f.parent.session.header.cwd = f.directory
  await f.plan([card('first')])
  const first = f.snapshot()
  assert.ok(first.archive?.id, 'each plan needs an independent archive')
  await f.cancel()
  await f.plan([card('second')])
  assert.notEqual(f.snapshot().archive.id, first.archive.id)
  const old = await f.engine.readArchive(first.archive.id)
  assert.equal(old.plan.status, 'cancelled')
  assert.match(old.markdown, /first/)
  assert.match(old.markdown, /已停止/)
  const events = (await readFile(path.join(first.archive.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.ok(events.some(event => event.type === 'plan.created'))
  assert.ok(events.some(event => event.type === 'plan.cancelled'))
  assert.equal((await f.engine.history()).items.length, 2)
})

test('the archive retains results and validation evidence across rework and restart', async () => {
  const f = await fixture()
  await f.plan([card('a')]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [{ type: 'text', text: 'first attempt result' }] }); await tick()
  const firstCheck = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  await f.execute('delegation_review', { taskId: 'a', verdict: 'rework', issues: [{ criterion: 0, severity: 'important', finding: '补上缺失结果', evidence: [firstCheck.callId] }] })
  await f.complete(1, { stopReason: 'completed', output: [{ type: 'text', text: 'second attempt result' }] }); await tick()
  const secondCheck = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  await f.execute('delegation_review', { taskId: 'a', verdict: 'accept', resolutions: [{ id: f.snapshot().tasks[0].reworkIds[0], status: 'ADDRESSED', evidence: [secondCheck.callId] }], findings: [{ criterion: 0, finding: '已核对第二次结果', evidence: [secondCheck.callId] }] })
  const archive = f.snapshot().archive
  const engine = await f.reload()
  const saved = await engine.readArchive(archive.id)
  assert.equal(saved.plan.status, 'accepted')
  assert.match(saved.markdown, /second attempt result/)
  assert.match(saved.markdown, /已核对第二次结果/)
  assert.ok(saved.markdown.includes(secondCheck.callId))
  const events = await readFile(path.join(archive.directory, 'events.jsonl'), 'utf8')
  assert.ok(events.includes(firstCheck.callId))
  assert.ok(events.includes('first attempt result'))
  assert.ok(events.includes('补上缺失结果'))
  assert.equal(f.calls.length, 2, 'reading archives and restarting cannot dispatch more work')
})

test('restart records an interrupted task and keeps the archive available without automatic execution', async () => {
  const f = await fixture()
  await f.plan([card('a')]); await f.execute('delegation_run')
  const archive = f.snapshot().archive
  const engine = await f.reload()
  const saved = await engine.readArchive(archive.id)
  assert.equal(saved.plan.tasks[0].status, 'blocked')
  assert.match(saved.markdown, /清理.*重试/)
  assert.ok(saved.plan.recentEvents.some(event => event.type === 'task.interrupted'))
  assert.equal(f.calls.length, 1)
})

test('legacy snapshots gain an archive without inventing execution history or launching work', async () => {
  const f = await fixture()
  await f.plan([card('legacy')]); await f.cancel()
  const engine = await f.reload(async file => {
    const stored = JSON.parse(await readFile(file, 'utf8'))
    delete stored.plans[0].archive; delete stored.plans[0].recentEvents
    await writeFile(file, JSON.stringify(stored))
  })
  const plan = engine.snapshot()[0]
  const saved = await engine.readArchive(plan.archive.id)
  assert.match(saved.markdown, /从已有任务快照首次建档/)
  assert.match(saved.markdown, /更早的执行过程未记录/)
  assert.equal(saved.plan.tasks[0].status, 'cancelled')
  assert.equal(f.calls.length, 0)
})

test('archives survive cache eviction and history is paginated without duplicate tasks', async () => {
  const f = await fixture()
  let first
  for (let i = 0; i < 23; i++) {
    f.parent.id = 'parent-' + i
    await f.plan([card('task-' + i)])
    first ||= f.engine.snapshot()[0].archive.id
    await f.cancel()
  }
  assert.equal(f.engine.snapshot().length, 12)
  assert.ok(f.engine.snapshot().every(plan => plan.archive.id !== first))
  assert.equal((await f.engine.readArchive(first)).plan.status, 'cancelled')
  const page = await f.engine.history()
  assert.equal(page.items.length, 20)
  const older = await f.engine.history(page.next)
  assert.equal(older.items.length, 3)
  assert.equal(older.next, null)
  assert.equal(new Set([...page.items, ...older.items].map(item => item.id)).size, 23)
})

test('ordinary tool activity is coalesced and does not rewrite the Markdown archive', async t => {
  const f = await fixture()
  await f.plan([card('a')]); await f.execute('delegation_run')
  const summary = f.snapshot().archive.summaryPath
  const before = (await stat(summary, { bigint: true })).mtimeNs
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (let i = 0; i < 100; i++) f.engine.observe({ agent: { id: f.pending[0].receipt.childId }, name: 'read-' + i }, { isError: false })
  t.mock.timers.tick(1000)
  await f.engine.history()
  assert.equal((await stat(summary, { bigint: true })).mtimeNs, before)
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).plans[0].tasks[0].progress.tool, 'read-99')
  assert.equal(f.calls.length, 1)
})

test('new records stay in profile storage even when the project archive location is unwritable', async () => {
  const f = await fixture()
  f.parent.session.header.cwd = f.directory
  const obstruction = path.join(f.directory, '.agent-tasks')
  await writeFile(obstruction, 'occupied by a file')
  await f.plan([card('a')])
  assert.equal(f.snapshot().archive.storage, 'profile')
  assert.ok(f.snapshot().archive.directory.startsWith(f.file.replace(/\.json$/, '.archive')))
  assert.equal(f.engine.storageError, null)
  assert.equal(f.calls.length, 0)
  await unlink(obstruction)
  const engine = await f.reload()
  assert.equal(engine.storageError, null)
  assert.ok((await engine.readArchive(engine.snapshot()[0].archive.id)).markdown)
  assert.equal(f.calls.length, 0)
})

test('routes by task, limits concurrency, and waits for dependency acceptance', async () => {
  const f = await fixture({ maxParallel: 2 })
  await f.plan([card('a'), card('b', { complexity: 'complex' }), card('c', { dependsOn: ['a'] })])
  await f.execute('delegation_run')
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls.map(call => call.request.agentOptions.model), ['cheap', 'cheap'])
  assert.equal(f.calls[0].request.parent.id, 'parent')
  await f.complete(0, { stopReason: 'completed', output: [{ type: 'text', text: 'done result.txt' }] }); await tick()
  assert.equal(f.snapshot().tasks[0].status, 'review')
  assert.equal(f.calls.length, 2)
  const check = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  await f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterion: 0, evidence: [check.callId], finding: '已读取交付文件，结果符合要求' }] })
  assert.equal(f.calls.length, 3)
})

test('queued tasks expose the concurrency wait instead of looking stuck', async () => {
  const f = await fixture({ maxParallel: 1 })
  await f.plan([card('a'), card('b')])
  await f.execute('delegation_run')
  assert.equal(f.calls.length, 1)
  assert.equal(f.snapshot().tasks[1].status, 'queued')
  assert.equal(f.snapshot().dispatchWait.reason, 'parallel')
  assert.match(f.snapshot().dispatchWait.message, /并发名额/)
  assert.match(f.engine.summary('parent'), /正在等待：.*并发名额/)
  await f.complete(0, { stopReason: 'completed', output: [] })
  for (let i = 0; i < 50 && f.calls.length < 2; i++) await tick()
  assert.equal(f.calls.length, 2, 'the queue should continue automatically after the slot is released')
  assert.equal(f.snapshot().dispatchWait, null)
})

test('a plan activation budget blocks queued work and prevents endless reopening', async () => {
  const f = await fixture({ maxParallel: 2, maxActivations: 1 })
  await f.plan([card('a'), card('b')])
  await f.execute('delegation_run')
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.snapshot().activationBudget, { limit: 1, used: 1, remaining: 0 })
  assert.equal(f.snapshot().tasks[1].status, 'blocked')
  assert.equal(f.snapshot().autoDispatch, false)
  assert.equal(f.snapshot().dispatchWait.reason, 'activation-limit')
  await f.complete(0, { stopReason: 'completed', output: [] }); await tick()
  assert.equal(f.snapshot().tasks[0].status, 'review')
  await assert.rejects(f.execute('delegation_control', { taskId: 'b', action: 'retry', message: '预算已用尽，确认不再自动开新子任务' }), /预算已用尽/)
  assert.equal(f.calls.length, 1)
})

test('the plan records a warning when the task card disagrees with the route', async () => {
  const f = await fixture({ route: { route: 'delegate_parallel', reasons: ['high_complexity'], estimatedSteps: 4, parallelTasks: 2, confidence: 0.9 } })
  await f.plan([card('a')])
  assert.match(f.snapshot().routingWarnings[0], /并行.*1 个任务/)
})

test('failed startup is visible and does not count or auto retry', async () => {
  const f = await fixture({ startError: true })
  await f.plan([card('a')]); await f.execute('delegation_run')
  assert.equal(f.snapshot().tasks[0].status, 'failed')
  assert.match(f.snapshot().tasks[0].error, /capacity full/)
  assert.equal(f.calls.length, 1)
})

test('native child errors retain the actual provider failure in state, summary and saved tasks', async () => {
  const f = await fixture({ models: { routine: { provider: 'local', model: 'cheap' }, complex: null } })
  await f.plan([card('a', { complexity: 'complex' })]); await f.execute('delegation_run')
  const message = '403 Forbidden: This account only allows Codex official clients'
  f.emit('session/event', { id: f.pending[0].receipt.childId }, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'AUTH', message } } } })
  f.pending[0].resolve({ stopReason: 'error', output: [] }); await tick()
  assert.equal(f.snapshot().tasks[0].status, 'failed')
  assert.match(f.snapshot().tasks[0].error, /403.*only allows Codex official clients/)
  assert.match(f.engine.summary('parent'), /403.*only allows Codex official clients/)
  await f.reload()
  assert.match(f.snapshot().tasks[0].error, /403.*only allows Codex official clients/)
  assert.equal(f.calls.length, 1, 'authentication failures must not trigger fallback or automatic retry')
  assert.equal(f.calls[0].request.agentOptions.model, 'cheap')
})

test('a coordinator quota error preserves returned work and requires service recovery rather than automatic redispatch', async () => {
  const f = await fixture(); await f.plan([card('a')]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [{ type: 'text', text: '已保存的交付结果' }] })
  await f.emit('session/event', f.parent, { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'QUOTA', message: '429: exceed quota limit' } } } })
  const stopped = f.snapshot()
  assert.equal(stopped.coordinatorIssue.code, 'MODEL_SERVICE_QUOTA')
  assert.equal(stopped.coordinatorIssue.model, 'parent')
  assert.equal(stopped.tasks[0].status, 'review')
  assert.match(stopped.tasks[0].report, /已保存的交付结果/)
  assert.equal(stopped.completion.outcome, 'blocked')
  const cancel = await f.execute('delegation_cancel')
  assert.equal(cancel.status, 'blocked')
  assert.equal(f.snapshot().cancelled, false)
  assert.equal(f.pending.length, 1)
  assert.match(f.engine.summary('parent'), /额度不足.*恢复/s)
  await f.reload()
  assert.equal(f.snapshot().coordinatorIssue.details, '429: exceed quota limit')
  f.emit('session/event', f.parent, { type: 'assistant/message', seq: 51, data: { usage: { outputTokens: 1 } } })
  assert.ok(f.snapshot().coordinatorIssue.resolvedAt)
  assert.equal(f.snapshot().completion, null)
  const proof = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  await f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterion: 0, finding: '恢复后核对原交付物', evidence: [proof.callId] }] })
  assert.equal(f.snapshot().completion.outcome, 'completed')
  assert.equal(f.pending.length, 1)
})

test('native child rate limits cannot be retried by an unexplained cancel but allow explicit recovery', async () => {
  const f = await fixture({ maxParallel: 1 }); await f.plan([card('a'), card('b')]); await f.execute('delegation_run')
  f.emit('session/event', f.children[0], { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: 'HTTP 429 Too Many Requests' } } } })
  f.pending[0].resolve({ stopReason: 'error', output: [] })
  await waitFor(() => !['starting', 'running'].includes(f.snapshot().tasks[0].status))
  assert.equal(f.snapshot().tasks[0].issue.code, 'MODEL_SERVICE_RATE_LIMIT')
  assert.match(f.snapshot().tasks[0].error, /HTTP 429/)
  const result = await f.execute('delegation_cancel')
  assert.equal(result.status, 'blocked')
  assert.equal(f.snapshot().cancelled, false)
  await waitFor(() => f.pending.length === 2)
  await f.execute('delegation_run')
  assert.equal(f.pending.length, 2)
  await f.execute('delegation_control', { taskId: 'a', action: 'retry', message: '已等待服务商解除限流，明确重试' })
  assert.equal(f.pending.length, 2, 'the independent task still holds the only slot')
  await f.complete(1, { stopReason: 'completed', output: [] })
  await waitFor(() => f.pending.length === 3)
  assert.equal(f.snapshot().tasks[0].attempts, 2)
  assert.equal(f.pending[0].receipt.disposeCount, 1)
})

test('a refused request preserves its cause while another task on the same model continues and recovery stays explicit', async () => {
  const f = await fixture({ maxParallel: 2 })
  await f.plan([card('refused'), card('working')]); await f.execute('delegation_run')
  const message = 'WorkBuddy: Illegal API invocation from an unapproved channel — WorkBuddy refused words in this client prompt'
  f.emit('session/event', f.children[0], { type: 'turn/end', data: { reason: {
    kind: 'error', error: { code: '11128', message },
  } } })
  f.pending[0].resolve({ stopReason: 'error', output: [] })
  await waitFor(() => !['starting', 'running'].includes(f.snapshot().tasks[0].status))
  const refused = f.snapshot().tasks[0], working = f.snapshot().tasks[1]
  assert.equal(refused.issue?.code, 'MODEL_SERVICE_REQUEST_REFUSED')
  assert.equal(refused.status, 'blocked')
  assert.equal(refused.issue.role, 'worker')
  assert.equal(refused.issue.provider, 'local')
  assert.equal(refused.issue.model, 'cheap')
  assert.equal(refused.issue.originalCode, '11128')
  assert.equal(refused.issue.details, message)
  assert.match(refused.issue.message, /执行者.*本次请求.*拒绝/)
  assert.match(refused.issue.action, /服务商.*支持.*调用方式|服务商.*限制/)
  assert.match(refused.issue.action, /明确重试.*失败任务/)
  assert.equal(refused.error, message)
  assert.equal(working.status, 'running')
  assert.equal(working.model.model, 'cheap')
  assert.equal(f.snapshot().status, 'running')
  assert.equal(f.calls.length, 2)
  const cancel = await f.execute('delegation_cancel')
  assert.equal(cancel.issue.code, 'MODEL_SERVICE_REQUEST_REFUSED')
  assert.equal(f.snapshot().tasks[1].status, 'running', 'handling refusal must not stop the other live task')
  assert.equal(f.snapshot().cancelled, false)
  assert.equal(f.snapshot().completion, null)
  assert.equal(f.pending[1].receipt.disposeCount, undefined)
  await f.execute('delegation_run')
  assert.equal(f.calls.length, 2, 'an unexplained cancel or repeated run must not reopen the refused task')
  await f.complete(1, { stopReason: 'completed', output: [] })
  await f.reload()
  assert.equal(f.snapshot().tasks[0].issue.details, message)
  assert.equal(f.snapshot().tasks[0].issue.code, 'MODEL_SERVICE_REQUEST_REFUSED')
  assert.equal(f.snapshot().tasks[1].status, 'review')
  await f.execute('delegation_control', { taskId: 'refused', action: 'retry', message: '已核对服务商支持的调用方式并处理限制，明确重试失败任务' })
  assert.equal(f.calls.length, 3)
  assert.equal(f.calls[2].request.agentOptions.model, 'cheap')
  assert.equal(f.snapshot().tasks[0].attempts, 2)
  assert.equal(f.pending[0].receipt.disposeCount, 1)
  assert.equal(f.pending[1].receipt.disposeCount, 1)
})

test('refused worker and review requests retain readable causes and raw service errors in the Markdown summary', async t => {
  for (const role of ['worker', 'reviewer']) await t.test(role, async () => {
    const f = await fixture()
    await f.plan([card('a', { complexity: role === 'reviewer' ? 'complex' : 'routine' })]); await f.execute('delegation_run')
    if (role === 'reviewer') await f.complete(0, { stopReason: 'completed', output: [] })
    const index = role === 'reviewer' ? 1 : 0
    const message = 'WorkBuddy: Illegal API invocation from an unapproved channel — this request was refused'
    f.emit('session/event', f.children[index], { type: 'turn/end', data: { reason: { kind: 'error', error: { code: '11128', message } } } })
    f.pending[index].resolve({ stopReason: 'error', output: [] })
    await waitFor(() => (role === 'reviewer' ? f.snapshot().tasks[0].audit : f.snapshot().tasks[0]).status === 'blocked')
    const archive = await f.engine.readArchive(f.snapshot().archive.id)
    assert.match(archive.markdown, role === 'reviewer' ? /独立审查模型的本次请求被服务商拒绝/ : /执行者模型的本次请求被服务商拒绝/)
    assert.ok(archive.markdown.includes('- 原始错误：' + message))
    assert.match(archive.markdown, /下一步：.*核对服务商支持的调用方式/)
  })
})

test('other model errors do not become service request refusals from their code or HTTP status alone', async t => {
  for (const error of [
    { code: '11128', message: 'WorkBuddy: other error (11128)' },
    { code: 'AUTH', status: 403, message: 'HTTP 403 Forbidden: access denied' },
    { code: 'EACCES', message: 'permission denied, open result.txt' },
    { code: 'MODEL_ERROR', message: 'The model context window was exceeded' },
  ]) await t.test(error.code, async () => {
    const f = await fixture(); await f.plan([card('a')]); await f.execute('delegation_run')
    f.emit('session/event', f.children[0], { type: 'turn/end', data: { reason: { kind: 'error', error } } })
    f.pending[0].resolve({ stopReason: 'error', output: [] })
    await waitFor(() => f.snapshot().tasks[0].status === 'failed')
    assert.equal(f.snapshot().tasks[0].issue, null)
    assert.equal(f.snapshot().tasks[0].error, error.message)
    assert.equal(f.calls.length, 1)
  })
})

test('a child failure isolates dependent work while unrelated queued work continues', async () => {
  const f = await fixture({ maxParallel: 1 })
  await f.plan([card('a'), card('dependent', { dependsOn: ['a'] }), card('b')])
  await f.execute('delegation_run')
  assert.equal(f.calls.length, 1)
  f.pending[0].resolve({ stopReason: 'error', output: [] })
  await tick()
  await waitFor(() => f.calls.length === 2)
  assert.equal(f.snapshot().tasks[0].status, 'failed')
  assert.equal(f.snapshot().tasks[1].status, 'queued')
  assert.equal(f.snapshot().tasks[2].status, 'running')
  assert.equal(f.snapshot().autoDispatch, true)
  assert.equal(f.snapshot().tasks[0].attempts, 1)
  await f.execute('delegation_run')
  assert.equal(f.calls.length, 2, 'run must not retry the failed task or start its dependent')
})

test('completed children are released while their session history remains inspectable', async () => {
  const f = await fixture()
  await f.plan([card('a')]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  for (let i = 0; i < 50 && f.snapshot().tasks[0].status !== 'review'; i++) await tick()
  assert.equal(f.pending[0].receipt.disposed, true)
  assert.equal(f.snapshot().tasks[0].release.status, 'released')
})

test('an unrelated child failure cannot contaminate a managed task', async () => {
  const f = await fixture(); await f.plan([card('a')]); await f.execute('delegation_run')
  f.emit('session/event', { id: 'unrelated-child' }, { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'unrelated failure' } } } })
  await f.complete(0, { stopReason: 'completed', output: [] }); await tick()
  assert.equal(f.snapshot().tasks[0].status, 'review')
  assert.equal(f.snapshot().tasks[0].error, null)
})
test('failed validation and invented evidence cannot pass acceptance', async () => {
  const f = await fixture(); await f.plan([card('a', { checks: [{ tool: 'pwsh', arguments: { command: 'node --test', description: 'Run tests' } }] })])
  await f.execute('delegation_run'); await f.complete(0, { stopReason: 'completed', output: [] }); await tick()
  f.setExit(1); const result = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  assert.equal(result.passed, false)
  await assert.rejects(f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterion: 0, evidence: [result.callId], finding: 'done' }] }), /验证/)
  f.setExit(0); await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  await assert.rejects(f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterion: 0, evidence: ['invented'], finding: 'done' }] }), /证据/)
})
test('rework is bounded and invalidates old validation evidence', async () => {
  const f = await fixture({ maxAttempts: 2 }); await f.plan([card('a')]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] }); await tick()
  const first = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  await f.execute('delegation_review', { taskId: 'a', verdict: 'rework', issues: [{ criterion: 0, severity: 'important', finding: '结果缺少要求的字段', evidence: [first.callId] }] })
  assert.equal(f.calls.length, 2); assert.equal(f.snapshot().tasks[0].checks[0].result, null)
  await f.complete(1, { stopReason: 'completed', output: [] }); await tick()
  await assert.rejects(f.execute('delegation_review', { taskId: 'a', verdict: 'rework', issueIds: f.snapshot().tasks[0].reworkIds }), /次数/)
})
test('invalid models never silently fall back', async () => {
  const f = await fixture({ models: { routine: { provider: 'local', model: 'missing' }, complex: null } })
  await f.plan([card('a')]); await assert.rejects(f.execute('delegation_run'), /model unavailable/)
  assert.equal(f.calls.length, 0); assert.match(f.snapshot().tasks[0].error, /model unavailable/)
})

test('a retired provider blocks the whole dispatch with an actionable error and no spent attempts', async () => {
  const f = await fixture({ models: { routine: { provider: 'retired', model: 'cheap' }, complex: { provider: 'local', model: 'deep' } } })
  await f.plan([card('valid-first', { complexity: 'complex' }), card('stale-route')])
  for (let i = 0; i < 3; i++) {
    await assert.rejects(f.execute('delegation_run'), /执行模型.*失效.*DSH Agentrix.*配置未更新前不要重试/)
    assert.equal(f.calls.length, 0)
    assert.equal(f.snapshot().tasks[1].attempts, 0)
  }
  const task = f.snapshot().tasks[1]
  assert.equal(task.status, 'blocked')
  assert.equal(task.childId, null)
  assert.equal(task.model.provider, 'retired')
  assert.equal(task.issue.code, 'MODEL_CONFIG_INVALID')
  assert.equal(task.issue.retryable, false)
  assert.match(task.issue.details, /no adapter registered/)
  assert.match(f.engine.summary('parent'), /配置未更新前不要重试/)
  f.config.models.routine = { provider: 'local', model: 'cheap' }
  await f.execute('delegation_run')
  assert.equal(f.calls.length, 2)
  assert.equal(f.snapshot().tasks[1].attempts, 1)
  assert.equal(f.snapshot().tasks[1].issue, null)
})

test('retrying a configuration block rechecks the model before starting anything', async () => {
  const f = await fixture({ models: { routine: { provider: 'retired', model: 'cheap' }, complex: null } })
  await f.plan([card('a')])
  await assert.rejects(f.execute('delegation_run'), /模型.*失效/)
  await assert.rejects(f.execute('delegation_control', { taskId: 'a', action: 'retry', message: '再次确认' }), /配置未更新前不要重试/)
  assert.equal(f.snapshot().tasks[0].attempts, 0)
  assert.equal(f.calls.length, 0)
  f.config.models.routine = { provider: 'local', model: 'cheap' }
  await f.execute('delegation_control', { taskId: 'a', action: 'retry', message: '已重新选择当前可用的服务和模型' })
  assert.equal(f.calls.length, 1)
  assert.equal(f.snapshot().tasks[0].attempts, 1)
})
test('rejects cyclic dependency plans and serializes overlapping writes', async () => {
  const f = await fixture()
  await assert.rejects(f.plan([card('a', { dependsOn: ['b'] }), card('b', { dependsOn: ['a'] })]), /循环/)
  await f.plan([card('a', { writes: ['src'] }), card('b', { writes: ['src/file.js'] })]); await f.execute('delegation_run')
  assert.equal(f.calls.length, 1)
})
test('wildcard write scopes reserve their own directory instead of unrelated projects', async () => {
  const f = await fixture()
  await f.plan([card('unrelated', { writes: ['C:/Users/Demo/Coopanion'] }),
    card('workbench', { writes: ['D:/projects/workbench/**'] }),
    card('overlap', { writes: ['D:/projects/workbench/src/main.go'] })])
  await f.execute('delegation_run')
  assert.equal(f.calls.length, 2)
  assert.equal(f.snapshot().tasks[1].status, 'running')
  assert.equal(f.snapshot().tasks[2].status, 'queued')
  assert.equal(f.snapshot().dispatchWait.taskId, 'workbench')
})
test('an unrelated historical session awaiting review does not block a wildcard writer', async () => {
  const f = await fixture()
  f.parent.id = 'previous-session'
  await f.plan([card('old-cleanup', { writes: ['C:/Users/Demo/Coopanion'] })])
  await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  f.parent.id = 'current-session'
  await f.plan([card('build', { writes: ['D:/projects/workbench/**'] })])
  await f.execute('delegation_run')
  const plans = f.engine.snapshot()
  assert.equal(plans.find(plan => plan.sessionId === 'previous-session').status, 'review')
  assert.equal(plans.find(plan => plan.sessionId === 'current-session').tasks[0].status, 'running')
  assert.equal(plans.find(plan => plan.sessionId === 'current-session').dispatchWait, null)
  assert.equal(f.calls.length, 2)
})
test('explicit cancellation clears write waits and historical cancelled waits stay hidden after reload', async () => {
  const f = await fixture()
  await f.plan([card('a', { writes: ['src'] }), card('b', { writes: ['src/file.js'] })])
  await f.execute('delegation_run')
  assert.equal(f.snapshot().dispatchWait.reason, 'write-conflict')
  await f.cancel({ reason: '用户明确结束本计划' })
  assert.equal(f.snapshot().dispatchWait, null)
  const launches = f.calls.length
  await f.reload(async file => {
    const stored = JSON.parse(await readFile(file, 'utf8'))
    stored.plans[0].dispatchWait = { reason: 'write-conflict', message: '旧版本残留的等待信息', taskId: 'a' }
    await writeFile(file, JSON.stringify(stored))
  })
  assert.equal(f.snapshot().status, 'cancelled')
  assert.equal(f.snapshot().dispatchWait, null)
  assert.equal(f.calls.length, launches)
})
test('restart marks unfinished tasks blocked and does not spawn again', async () => {
  const f = await fixture(); await f.plan([card('a')]); await f.execute('delegation_run')
  const engine = await f.reload()
  assert.equal(engine.snapshot()[0].tasks[0].status, 'blocked')
  assert.equal(f.calls.length, 1)
})
test('a task awaiting review keeps its write paths reserved', async () => {
  const f = await fixture(); await f.plan([card('a', { writes: ['src/file.js'] }), card('b', { writes: ['src/file.js'] })])
  await f.execute('delegation_run'); assert.equal(f.calls.length, 1)
  await f.complete(0, { stopReason: 'completed', output: [] }); await tick()
  assert.equal(f.calls.length, 1, 'validation must not race another writer')
})
test('validation remains usable after reload and repeated cleanup preserves accepted tasks', async () => {
  const f = await fixture(); await f.plan([card('a')]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] }); await tick()
  const result = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  await f.reload()
  await f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterion: 0, finding: '内容已核对', evidence: [result.callId] }] })
  const unchanged = await f.execute('delegation_control', { taskId: 'a', action: 'stop' })
  assert.equal(unchanged.task.status, 'accepted')
  assert.equal(f.snapshot().status, 'accepted')
})
test('supervision messages and cancellation use the exact native child and release it', async () => {
  const f = await fixture(); await f.plan([card('a')]); await f.execute('delegation_run')
  await f.execute('delegation_control', { taskId: 'a', action: 'steer', message: '先核对第一条验收要求' })
  assert.equal(f.calls[1][1], f.pending[0].receipt.childId)
  await f.cancel()
  assert.equal(f.snapshot().status, 'cancelled')
  assert.equal(f.pending[0].receipt.disposed, true)
})
test('repeated child errors wake the waiting original coordinator without reopening a child or spending completion recovery', async () => {
  const f = await fixture(); await f.plan([card('a')]); await f.execute('delegation_run')
  const stopping = f.endTurn()
  await tick()
  const child = f.children[0]
  for (let i = 0; i < 3; i++) f.engine.observe({ agent: child, name: 'cordis_inspect_query', callId: 'invalid-' + i,
    arguments: { input: '{}' } }, { isError: true, content: [{ type: 'text', text: 'input must be an object' }] })
  await waitFor(() => f.parent.injected.some(message => message.source.kind === 'delegation-supervision'))
  await stopping
  assert.equal(f.snapshot().recovery.used, 0)
  assert.equal(f.snapshot().tasks[0].status, 'running')
  assert.equal(f.pending.length, 1)
  assert.equal(f.pending[0].receipt.disposed, undefined)
  const alert = f.snapshot().tasks[0].supervision.pending
  assert.equal(alert.code, 'REPEATED_TOOL_ERROR')
  assert.match(alert.reason, /input must be an object/)
  await f.execute('delegation_control', { taskId: 'a', action: 'steer', message: 'input 传对象，按已公开 schema 重试一次。' })
  assert.equal(f.calls[1][1], child.id)
  assert.equal(f.snapshot().tasks[0].supervision.used, 1)
  assert.equal(f.snapshot().tasks[0].supervision.pending, null)
})

test('a human supplement wakes the waiting coordinator and survives retargeting without replacing the worker', async () => {
  const f = await fixture(); await f.plan([card('a')]); await f.execute('delegation_run')
  const stopping = f.endTurn(); await tick()
  const message = { id: 'supplement-1', source: { kind: 'user' }, content: [{ type: 'text', text: '交付人员不懂技术，需要操作引导。' }] }
  f.emit('session/event', f.parent, { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [message] } })
  f.emit('session/event', f.parent, { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' } })
  f.emit('session/event', f.parent, { type: 'agent/inbox/spliced', data: { target: 'next-step', start: 0, inserted: [message] } })
  const woke = await Promise.race([stopping.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))])
  assert.equal(woke, true, 'queued human input must release the stopping hook before the child finishes')
  assert.equal(f.engine.pendingMessages('parent').length, 1)
  assert.equal(f.snapshot().inputs?.length ?? 0, 0, 'receiving a message does not assign it to the plan')
  assert.equal(f.snapshot().recovery.used, 0)
  assert.equal(f.pending.length, 1)
  assert.equal(f.pending[0].receipt.disposed, undefined)
  assert.equal(f.parent.injected.length, 0, 'the original queued message is consumed by the host, not injected twice')
})

test('supplements are explicitly forwarded with acceptance criteria or acknowledged before acceptance', async () => {
  const f = await fixture(); await f.plan([card('a')]); await f.execute('delegation_run')
  const message = { id: 'new-requirement', source: { kind: 'user' }, content: [{ type: 'text', text: '操作人员不懂技术，请提供引导。' }] }
  f.emit('session/event', f.parent, { type: 'agent/inbox/spliced', data: { target: 'next-step', inserted: [message] } })
  f.emit('session/event', f.parent, { type: 'user/message', data: message })
  await f.execute('delegation_decide', { relation: 'update', mode: 'delegate', reason: '将操作引导补充进原任务，执行者继续处理。' })
  await assert.rejects(f.execute('delegation_control', { taskId: 'a', action: 'steer', message: '完善交付体验', inputIds: [message.id] }), /验收标准|additionalCriteria/)
  await f.execute('delegation_control', { taskId: 'a', action: 'steer', message: '增加面向交付人员的操作引导',
    inputIds: [message.id], additionalCriteria: ['页面提供无需技术背景的操作引导'] })
  assert.equal(f.calls[1][1], f.children[0].id)
  assert.match(f.calls[1][2][0].text, /操作人员不懂技术/)
  assert.equal(f.snapshot().inputs[0].status, 'forwarded')
  assert.equal(f.snapshot().tasks[0].criteria.length, 2)
  assert.equal(f.pending.length, 1)
  await f.complete(0, { stopReason: 'completed', output: [] })
  const proof = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  const question = { ...message, id: 'progress-question', content: [{ type: 'text', text: '进度怎么样？' }] }
  f.emit('session/event', f.parent, { type: 'agent/inbox/spliced', data: { target: 'next-step', inserted: [question] } })
  const accept = () => f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [0, 1].map(criterion => ({ criterion, finding: '按本次要求实际核对通过', evidence: [proof.callId] })) })
  await assert.rejects(accept(), /补充|消息/)
  await f.execute('delegation_decide', { relation: 'question' })
  assert.equal(f.snapshot().inputs.some(input => input.id === question.id), false)
  await accept()
  assert.equal(f.snapshot().status, 'accepted')
})

test('a supplement arriving during acceptance defers the receipt and reaches bounded rework after reload', async () => {
  const message = { id: 'delivery-guidance', source: { kind: 'user' }, content: [{ type: 'text', text: '交付操作员不懂技术，需要页面引导。' }] }
  let inserted = false
  const f = await fixture({ beforeResult(exec) {
    if (exec.name === 'delegation_review' && !inserted) {
      inserted = true
      f.emit('session/event', f.parent, { type: 'agent/inbox/spliced', data: { target: 'next-step', inserted: [message] } })
    }
  } })
  await f.plan([card('a')]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  const proof = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  await f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterion: 0, finding: '原标准已验证', evidence: [proof.callId] }] })
  assert.equal(f.snapshot().tasks[0].status, 'review')
  assert.equal(f.snapshot().completion, null)
  assert.equal(f.snapshot().tasks[0].pendingAcceptance, undefined)
  await f.reload()
  assert.equal(f.engine.pendingMessages('parent')[0].text, message.content[0].text)
  await f.execute('delegation_decide', { relation: 'update', mode: 'delegate', reason: '补充交付操作引导，在原任务中返工完成。' })
  assert.match(f.engine.summary('parent'), /delivery-guidance.*交付操作员/)
  await f.execute('delegation_review', { taskId: 'a', verdict: 'rework', inputIds: [message.id],
    additionalCriteria: ['页面提供面向操作员的引导'], feedback: '落实新增交付要求' })
  await f.execute('delegation_run')
  const task = f.snapshot().tasks[0]
  assert.equal(task.attempts, 2)
  assert.equal(task.checks[0].result, null)
  assert.equal(task.evidence.length, 0)
  assert.equal(f.pending.length, 2)
  assert.match(JSON.stringify(f.calls.filter(call => !Array.isArray(call)).at(-1)), /交付操作员不懂技术/)
  const saved = await f.engine.readArchive(f.snapshot().archive.id)
  assert.match(saved.markdown, /用户补充.*delivery-guidance/s)
  assert.match(saved.markdown, /新增验收标准.*页面提供面向操作员的引导/s)
})

test('withdrawn input does not prevent acceptance and cancellation ignores later supplements', async () => {
  const f = await fixture(); await f.plan([card('a')]); await f.execute('delegation_run')
  const message = { id: 'withdrawn-input', source: { kind: 'user' }, content: [{ type: 'text', text: '暂时不要增加此功能' }] }
  f.emit('session/event', f.parent, { type: 'agent/inbox/spliced', data: { target: 'next-step', start: 0, inserted: [message] } })
  f.emit('session/event', f.parent, { type: 'agent/inbox/spliced', data: { target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' } })
  await f.complete(0, { stopReason: 'completed', output: [] })
  const proof = await f.execute('delegation_verify', { taskId: 'a', checkIndex: 0 })
  await f.execute('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterion: 0, finding: '已验证', evidence: [proof.callId] }] })
  assert.equal(f.snapshot().completion.outcome, 'completed')
  const cancelled = await fixture(); await cancelled.plan([card('b')]); await cancelled.execute('delegation_run')
  const stopping = cancelled.endTurn(); await tick()
  await cancelled.cancel({ reason: '用户明确取消' }); await stopping
  cancelled.emit('session/event', cancelled.parent, { type: 'agent/inbox/spliced', data: { target: 'next-step', inserted: [message] } })
  assert.equal(cancelled.snapshot().inputs, undefined)
  assert.equal(cancelled.pending.length, 1)
  assert.equal(cancelled.pending[0].receipt.disposeCount, 1)
  assert.equal(cancelled.parent.injected.length, 0)
})

test('stage checkpoints keep current-task evidence and unfinished work without claiming acceptance or extending the deadline', async () => {
  const f = await fixture(); await f.plan([card('a')]); await f.execute('delegation_run')
  const deadline = f.snapshot().tasks[0].supervision.deadlineAt
  const args = { phase: 'investigation', summary: '已核对原生工具参数，尚未修改。', nextStep: '按确认的接口实现修复。', evidence: ['read-current'] }
  await assert.rejects(f.checkpoint(0, args), /证据/)
  f.engine.observe({ agent: f.children[0], name: 'read', callId: 'read-current' }, { isError: false, content: [] })
  await f.checkpoint(0, args)
  const task = f.snapshot().tasks[0]
  assert.equal(task.supervision.checkpoint.summary, args.summary)
  assert.equal(task.supervision.checkpoint.verified, false)
  assert.equal(task.supervision.deadlineAt, deadline)
  assert.equal(task.status, 'running')
  assert.equal(f.snapshot().completion, null)
  await assert.rejects(f.execute('delegation_checkpoint', args), /托管子/)
  await f.reload()
  assert.equal(f.snapshot().tasks[0].supervision.checkpoint.nextStep, args.nextStep)
})

test('no activity is an advisory once, does not consume correction allowance and never becomes a timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const f = await fixture({ taskTimeoutMinutes: 1 }); await f.plan([card('a')]); await f.execute('delegation_run')
  t.mock.timers.tick(10 * 60_000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.snapshot().tasks[0].supervision.pending?.code, 'NO_ACTIVITY')
  await f.engine.history()
  await f.execute('delegation_control', { taskId: 'a', action: 'steer', message: '工具仍在执行，继续等待结果。' })
  t.mock.timers.tick(30 * 60_000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.snapshot().tasks[0].status, 'running')
  assert.equal(f.snapshot().tasks[0].supervision.used, 0)
  assert.equal(f.parent.injected.length, 1)
  assert.equal(f.pending[0].receipt.disposeCount, undefined)
})


test('token usage is observed without imposing generation or cumulative token limits', async () => {
  const f = await fixture(); await f.plan([card('a')]); await f.execute('delegation_run')
  assert.equal(f.calls[0].request.agentOptions.maxTokens, undefined)
  assert.doesNotMatch(f.calls[0].request.prompt[0].text, /40000|8192|32000/)
  const child = f.children[0]
  let sent = 0
  f.emit('llm/stream', { sessionId: child.id, provider: 'local', model: 'cheap' }, () => { sent++ })
  const event = { type: 'assistant/message', seq: 11, data: { usage: { inputTokens: 1000, cacheReadTokens: 99000, outputTokens: 50000 } } }
  f.emit('session/event', { id: child.id }, event)
  f.emit('session/event', { id: child.id }, event)
  await tick()
  const task = f.snapshot().tasks[0]
  assert.equal(task.supervision.metrics.requests, 1)
  assert.equal(task.supervision.metrics.contextTokens, 100000)
  assert.equal(task.supervision.metrics.outputTokens, 50000)
  assert.equal(task.supervision.pending, null)
  f.emit('llm/stream', { sessionId: child.id, provider: 'local', model: 'cheap' }, () => { sent++ })
  assert.equal(f.snapshot().tasks[0].status, 'running')
  assert.equal(f.pending[0].receipt.disposeCount, undefined)
  assert.equal(f.calls.length, 1)
  assert.equal(sent, 2)
  assert.equal(task.modelRoute.actual.model, 'cheap')
  await f.complete(0, { stopReason: 'completed', output: [] })
  const archive = await f.engine.readArchive(f.snapshot().archive.id)
  assert.match(archive.markdown, /输出 Token：50000（仅统计，不设插件上限）/)
  assert.doesNotMatch(archive.markdown, /50000\/(?:null|undefined|40000)/)
})
test('a provider configured output allowance is preserved rather than reduced to 8192', async () => {
  const f = await fixture()
  f.ctx.llm.resolveCallConfig = async route => ({ config: { ...route, maxTokens: 32768 } })
  await f.plan([card('a')]); await f.execute('delegation_run')
  assert.equal(f.calls[0].request.agentOptions.maxTokens, 32768)
})
test('native output truncations continue the same child without using report recovery or starting a replacement', async () => {
  const f = await fixture()
  await f.plan([card('a')]); await f.execute('delegation_run')
  const child = f.children[0]
  for (let i = 0; i < 3; i++) {
    const stream = f.emit('llm/stream', { sessionId: child.id, provider: 'local', model: 'cheap' }, () => (async function* () {
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    })())
    for await (const chunk of stream) {}
    await f.endTurn(0)
  }
  assert.equal(f.snapshot().tasks[0].recovery.used, 0)
  assert.equal(child.injected.length, 3)
  assert.equal(f.calls.length, 1)
  assert.equal(f.snapshot().tasks[0].status, 'running')
  assert.equal(f.pending[0].receipt.disposeCount, undefined)
  await f.cancel({ reason: '用户取消优先于输出续接' })
  const notices = child.injected.length
  await f.endTurn(0)
  assert.equal(child.injected.length, notices)
})
test('a committed report survives the native sticky max-tokens stop reason and remains subject to acceptance', async () => {
  const f = await fixture()
  await f.plan([card('a')]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'max-tokens', output: [] })
  assert.equal(f.snapshot().tasks[0].status, 'review')
  assert.equal(f.snapshot().completion, null)
  assert.equal(f.pending[0].receipt.disposeCount, 1)
})
test('the original coordinator can continue truncated output without consuming acceptance recovery', async () => {
  const f = await fixture()
  await f.plan([card('a')])
  for (let i = 0; i < 3; i++) {
    const stream = f.emit('llm/stream', { sessionId: f.parent.id, provider: 'local', model: 'parent' }, () => (async function* () {
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    })())
    for await (const chunk of stream) {}
    await f.endTurn()
  }
  assert.equal(f.snapshot().recovery.used, 0)
  assert.equal(f.parent.injected.length, 3)
  assert.equal(f.calls.length, 0)
})

test('an unspecified reasoning effort accepts only the native recorded default and pins it for subsequent requests', async () => {
  const f = await fixture(); await f.plan([card('a')]); await f.execute('delegation_run')
  const child = f.children[0]
  child.session.requestHeader = () => ({ config: { provider: 'local', model: 'cheap', reasoningEffort: 'max' }, adapterDefaults: { reasoningEffort: true } })
  let sent = 0
  const request = { sessionId: child.id, provider: 'local', model: 'cheap', reasoningEffort: 'max' }
  f.emit('llm/stream', request, () => { sent++ })
  assert.equal(sent, 1)
  assert.equal(f.snapshot().tasks[0].modelRoute.resolved.reasoningEffort, 'max')
  assert.equal(f.snapshot().tasks[0].modelRoute.defaultSource, 'native-request-header')
  assert.throws(() => f.emit('llm/stream', { ...request, reasoningEffort: 'high' }, () => { sent++ }), /模型请求与任务配置不一致/)
  assert.equal(sent, 1)
  const explicit = await fixture({ models: { worker: { provider: 'local', model: 'cheap', reasoningEffort: 'high' }, reviewer: null } })
  await explicit.plan([card('b')]); await explicit.execute('delegation_run')
  explicit.children[0].session.requestHeader = child.session.requestHeader
  assert.throws(() => explicit.emit('llm/stream', { ...request, sessionId: explicit.children[0].id }, () => { sent++ }), /模型请求与任务配置不一致/)
  assert.equal(sent, 1)
})

test('a native default recorded without adapterDefaults does not block the first reviewer request', async () => {
  const f = await fixture(); await f.plan([card('a', { complexity: 'complex' })]); await f.execute('delegation_run')
  await f.complete(0, { stopReason: 'completed', output: [] })
  const child = f.children[1]
  child.session.requestHeader = () => ({ config: { provider: 'local', model: 'parent', reasoningEffort: 'max' }, tools: [] })
  let sent = 0
  f.emit('llm/stream', { sessionId: child.id, provider: 'local', model: 'parent', reasoningEffort: 'max' }, () => { sent++ })
  assert.equal(sent, 1)
  assert.equal(f.snapshot().tasks[0].audit.modelRoute.defaultSource, 'native-request-header')
  assert.throws(() => f.emit('llm/stream', { sessionId: child.id, provider: 'local', model: 'wrong', reasoningEffort: 'max' }, () => { sent++ }), /模型请求与任务配置不一致/)
  assert.equal(sent, 1)
})

test('task cards reject missing live-tool required arguments before any worker is started', async () => {
  const f = await fixture()
  f.ctx.tools.schemas = () => [
    { name: 'read', parameters: { type: 'object', required: ['file_path'], properties: { file_path: { type: 'string' } } } },
    { name: 'glob', parameters: { type: 'object', required: ['pattern'], properties: { path: { type: 'string' }, pattern: { type: 'string' } } } },
  ]
  await assert.rejects(f.plan([card('a')]), /read.*file_path/)
  await assert.rejects(f.plan([card('a', { checks: [{ tool: 'glob', arguments: { path: '.' } }] })]), /glob.*pattern/)
  assert.equal(f.pending.length, 0)
  await f.plan([card('a', { checks: [{ tool: 'read', arguments: { file_path: 'result.txt' } }] })])
  await f.execute('delegation_run')
  assert.equal(f.pending.length, 1)
})

test('supervision deduplicates errors, persists its correction cap and never restarts or releases a child twice', async () => {
  const f = await fixture(); await f.plan([card('a')]); await f.execute('delegation_run')
  let call = 0
  const fail = () => f.engine.observe({ agent: f.children[0], name: 'grep', callId: 'missing-path-' + ++call },
    { isError: true, content: [{ type: 'text', text: 'search failed: packaged path is not a directory' }] })
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 8; i++) fail()
    await waitFor(() => f.parent.injected.filter(message => message.source.kind === 'delegation-supervision').length === round + 1)
    await f.execute('delegation_control', { taskId: 'a', action: 'steer', message: '使用已确认可用的读取入口，第 ' + (round + 1) + ' 次纠正。' })
    assert.equal(f.snapshot().tasks[0].supervision.used, round + 1)
  }
  for (let i = 0; i < 3; i++) fail()
  await waitFor(() => f.snapshot().tasks[0].status === 'blocked')
  assert.equal(f.snapshot().tasks[0].issue.code, 'SUPERVISION_EXHAUSTED')
  assert.equal(f.pending[0].receipt.disposeCount, 1)
  assert.equal(f.pending.length, 1)
  await f.reload()
  assert.equal(f.snapshot().tasks[0].supervision.used, 2)
  assert.equal(f.pending[0].receipt.disposeCount, 1)
})

test('changed files break a repeated-failure streak and cancellation suppresses pending supervision', async () => {
  const f = await fixture(); await f.plan([card('a')]); await f.execute('delegation_run')
  const child = f.children[0], failure = { isError: false, value: { exitCode: 1 }, content: [{ type: 'text', text: 'one assertion failed' }] }
  let call = 0
  const fail = () => f.engine.observe({ agent: child, name: 'pwsh', callId: 'test-failed-' + ++call }, failure)
  fail(); fail()
  f.engine.observe({ agent: child, name: 'edit', callId: 'fix-applied' }, { isError: false, content: [] })
  fail(); fail()
  assert.equal(f.snapshot().tasks[0].supervision.pending, null)
  fail()
  await f.cancel()
  await tick()
  const notices = f.parent.injected.length
  fail(); await tick()
  assert.equal(f.parent.injected.length, notices)
  assert.equal(f.snapshot().tasks[0].status, 'cancelled')
  assert.equal(f.pending[0].receipt.disposeCount, 1)
})

test('crossing the request reminder keeps checkpoints, context and the same activation', async () => {
  const f = await fixture(); await f.plan([card('a')]); await f.execute('delegation_run')
  const child = f.children[0]
  f.engine.observe({ agent: child, name: 'read', callId: 'read-proof' }, { isError: false, content: [] })
  await f.checkpoint(0, { phase: 'investigation', summary: '已有调查结论，尚未实现。', nextStep: '按原方案继续。', evidence: ['read-proof'] })
  let sent = 0
  for (let i = 0; i < 81; i++) f.emit('llm/stream', { sessionId: child.id, provider: 'local', model: 'cheap' }, () => { sent++ })
  assert.equal(sent, 81)
  assert.equal(f.snapshot().tasks[0].supervision.checkpoint.summary, '已有调查结论，尚未实现。')
  assert.equal(f.pending[0].receipt.disposeCount, undefined)
  assert.equal(f.snapshot().tasks[0].attempts, 1)
  assert.equal(f.snapshot().activationBudget.used, 1)
  await f.complete(0, { stopReason: 'completed', output: [] })
  assert.equal(f.snapshot().tasks[0].status, 'review')
})


test('request counts never interrupt an admitted worker even when no activation slot remains', async () => {
  for (const maxActivations of [1, 3]) {
    const f = await fixture({ maxActivations })
    await f.plan([card('a')]); await f.execute('delegation_run')
    for (let i = 0; i < 100; i++) f.emit('llm/stream', { sessionId: f.children[0].id, provider: 'local', model: 'cheap' }, () => {})
    assert.equal(f.snapshot().tasks[0].status, 'running')
    assert.equal(f.calls.length, 1)
    assert.equal(f.snapshot().activationBudget.used, 1)
    assert.equal(f.parent.injected.length, 0)
  }
})


test('a historical budget block stays recorded and is not automatically relaunched', async () => {
  const f = await fixture({ maxActivations: 3 })
  await f.plan([card('a')]); await f.execute('delegation_run')
  await f.reload(async file => {
    const stored = JSON.parse(await readFile(file, 'utf8'))
    const task = stored.plans[0].tasks[0]
    task.status = 'blocked'
    delete task.recovered
    task.issue = { code: 'EXECUTION_BUDGET_EXHAUSTED', retryable: false, message: '旧版本达到模型预算' }
    task.error = task.issue.message
    delete task.continuation
    task.supervision.lastProgressAt = task.supervision.startedAt + 1
    task.supervision.metrics = { requests: 80, inputTokens: 1000, outputTokens: 40000, contextTokens: 1000 }
    await writeFile(file, JSON.stringify(stored))
  })
  const result = await f.execute('delegation_run')
  assert.equal(result.plan.status, 'blocked')
  assert.equal(f.calls.length, 1)
  assert.equal(f.snapshot().tasks[0].attempts, 1)
  assert.equal(f.snapshot().tasks[0].issue.code, 'EXECUTION_BUDGET_EXHAUSTED')
})

test('elapsed reminders never interrupt a report being confirmed in the real result pipeline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const f = await fixture({ taskTimeoutMinutes: 1, autoConclude: true, beforeResult: async exec => {
    if (exec.name === 'delegation_report') { entered.resolve(); await release.promise }
  } })
  await f.plan([card('a')]); await f.execute('delegation_run')
  const reporting = f.report(0, { status: 'DONE', summary: '实际测试已有结果', report: '原始产物与测试结果均已记录，等待主控验收。' })
  await entered.promise
  t.mock.timers.tick(60_000)
  assert.equal(f.pending[0].receipt.disposed, undefined)
  release.resolve(); await reporting
  for (let i = 0; i < 100 && f.snapshot().tasks[0].status === 'running'; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.snapshot().tasks[0].status, 'review')
  assert.equal(f.snapshot().tasks[0].execution.commitState, 'committed')
  assert.equal(f.pending[0].receipt.disposeCount, 1)
  assert.equal(f.snapshot().completion, null)
})

test('elapsed reminders preserve the worker until explicit cancellation cleans it once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const f = await fixture({ taskTimeoutMinutes: 1 })
  await f.plan([card('a')]); await f.execute('delegation_run')
  t.mock.timers.tick(60_000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.snapshot().tasks[0].status, 'running')
  assert.equal(f.pending[0].receipt.disposed, undefined)
  await f.cancel({ reason: '用户明确取消' })
  assert.equal(f.pending[0].receipt.disposeCount, 1)
  assert.equal(f.calls.length, 1)
})
