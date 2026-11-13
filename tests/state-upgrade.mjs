// Synthetic persistence acceptance through the actual old/current orchestrator recovery entry points.
// No desktop profile, model service, native AgentLoop or real user journal is used.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createOrchestrator, DEFAULT_OPTIONS } from '../orchestrator.js'
import { createRuntimeStore } from '../runtime-store.js'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const legacyRevision = '6eb496b'
const currentRevision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'agentrix-state-upgrade-'))
const resolvedRoot = await realpath(temporaryRoot)
const home = path.join(temporaryRoot, 'isolated-dsh-home')
const file = path.join(home, 'delegation-first', 'upgrade.runs.json')
const originalHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const openEngines = new Set()
const digest = value => createHash('sha256').update(value).digest('hex')
const evidenceId = 'delegation-check-11111111-1111-4111-8111-111111111111'
const proofText = 'Synthetic verification: accepted result and its evidence survive upgrade and restore.\n'
const summary = { legacyRevision, currentRevision, scenarios: [], layer: 'actual createOrchestrator ready/save; synthetic host only',
  realModels: false, realUserData: false }

function contained(target) {
  const relative = path.relative(resolvedRoot, path.resolve(target))
  assert.ok(relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative),
    'recursive filesystem operation must stay inside the task-created temporary directory')
}
async function removeInside(target) {
  contained(target)
  await rm(target, { recursive: true, force: true })
}
async function backupTo(target) {
  contained(target)
  await cp(home, target, { recursive: true, errorOnExist: true, force: false })
}
async function restoreFrom(source) {
  contained(source)
  await removeInside(home)
  await cp(source, home, { recursive: true, errorOnExist: true, force: false })
}
function task(status) {
  return { id: 'task', title: 'Synthetic persistence task', instructions: 'Preserve the synthetic result.',
    scope: 'Only the isolated temporary profile.', outputs: ['synthetic-result.txt'], writes: [], dependsOn: [],
    complexity: 'routine', criteria: ['Result and evidence remain readable.'], protocolVersion: 2,
    checks: [{ tool: 'read', arguments: { file_path: 'synthetic-result.txt' }, result: null }],
    status, attempts: 1, issues: [], reworkIds: [], report: '', error: null, feedback: '', evidence: [],
    review: null, execution: null, childId: null, model: { provider: 'synthetic', model: 'worker' } }
}
function decision(sessionId) {
  const source = { messageId: sessionId + '-request', text: 'Synthetic request for ' + sessionId }
  return { sessionId, source, revision: source, decision: { mode: 'delegate', reason: 'Synthetic recovery fixture.',
    requestId: source.messageId, revisionId: source.messageId, at: 1, model: { provider: 'synthetic', model: 'coordinator' } },
  messages: [{ messageId: source.messageId, text: source.text, at: 1,
    resolution: { relation: 'new', requestId: source.messageId } }] }
}
function fixturePlan(sessionId, status) {
  const entry = decision(sessionId)
  return { sessionId, goal: 'Synthetic migration ' + sessionId, cwd: path.join(home, 'project'), createdAt: 1, updatedAt: 1,
    source: entry.source, decision: entry.decision, tasks: [task(status)], autoDispatch: false, cancelled: status === 'cancelled',
    recentEvents: [], completion: null, activationBudget: { limit: 64, used: 1 } }
}
async function open(factory, sourceFile = file) {
  const definitions = new Map(), hooks = new Map()
  let started = 0
  const parent = { id: 'accepted-session', status: 'idle', session: { header: { cwd: path.join(home, 'project') } },
    options: { provider: 'synthetic', model: 'coordinator' } }
  const ctx = {
    get(name) { return { agents: { get: id => id === parent.id ? parent : undefined, list: () => [parent] },
      tools: ctx.tools, subagents: { async startActivation() { started++; throw new Error('migration must never start a model') } } }[name] },
    on(name, handler) { hooks.set(name, handler); return () => hooks.delete(name) },
    tools: { register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) },
      get: () => ({}), view: () => ({ restrictableNames: [...definitions.keys()] }) },
  }
  const engine = factory({ ctx, file: sourceFile, getConfig: () => ({ enabled: true, ...DEFAULT_OPTIONS }) })
  openEngines.add(engine)
  await engine.ready
  return { engine, get started() { return started }, async rejectMutation() {
    const definition = definitions.get('delegation_plan')
    await assert.rejects(definition.execute({ goal: 'Must not overwrite corrupt state', tasks: [task('queued')] },
      { name: 'delegation_plan', arguments: {}, agent: parent, callId: 'synthetic-recovery-protection',
        signal: new AbortController().signal }), /保存|恢复|任务文件|清单|分片/)
  } }
}
async function close(handle) {
  await handle.engine.dispose()
  openEngines.delete(handle.engine)
}
function assertPlans(engine, cleanupExpected = true) {
  const accepted = engine.snapshot().find(plan => plan.sessionId === 'accepted-session')
  assert.equal(accepted.tasks[0].status, 'accepted')
  assert.equal(accepted.completion.id, 'synthetic-accepted-receipt')
  assert.equal(accepted.tasks[0].checks[0].result.callId, evidenceId)
  assert.deepEqual(accepted.tasks[0].review.findings[0].evidence, [evidenceId])
  const cancelled = engine.snapshot().find(plan => plan.sessionId === 'cancelled-session')
  assert.equal(cancelled.cancelled, true)
  assert.equal(cancelled.tasks[0].status, 'cancelled')
  assert.equal(cancelled.tasks[0].recovered, true)
  assert.equal(cancelled.tasks[0].release.status, 'failed')
  assert.equal(cancelled.cancellation.messageId, 'synthetic-cancel-message')
  if (cleanupExpected) assert.equal(cancelled.cancellation.cleanup.status, 'failed')
}
async function assertUpgraded(handle, longMessage) {
  assert.equal(handle.engine.storageError, null)
  assert.equal(handle.started, 0)
  assertPlans(handle.engine)
  assert.equal(handle.engine.requestContext('accepted-session').messages.at(-1).text, longMessage)
  for (let index = 0; index < 105; index++) {
    assert.equal(handle.engine.requestContext('history-' + index).messages[0].text, 'Synthetic history ' + index)
  }
  assert.equal(await readFile(handle.engine.snapshot().find(plan => plan.sessionId === 'accepted-session')
    .tasks[0].checks[0].result.outputPath, 'utf8'), proofText)
}

try {
  const legacyDirectory = path.join(temporaryRoot, 'legacy-source')
  await mkdir(legacyDirectory, { recursive: true })
  for (const name of ['orchestrator.js', 'completion.js', 'supervision.js', 'usage.js', 'task-records.js']) {
    const source = execFileSync('git', ['show', legacyRevision + ':' + name], { cwd: repository, maxBuffer: 4 * 1024 * 1024 })
    await writeFile(path.join(legacyDirectory, name), source)
  }
  await writeFile(path.join(legacyDirectory, 'package.json'), '{"type":"module"}')
  const legacy = await import(pathToFileURL(path.join(legacyDirectory, 'orchestrator.js')).href)
  const { createTaskRecords } = await import(pathToFileURL(path.join(legacyDirectory, 'task-records.js')).href)
  const records = createTaskRecords(file)
  const accepted = fixturePlan('accepted-session', 'accepted')
  records.attach(accepted)
  const outputPath = await records.writeVerification(accepted, accepted.tasks[0], evidenceId, proofText)
  accepted.tasks[0].checks[0].result = { callId: evidenceId, ref: evidenceId, attempt: 1, passed: true,
    summary: proofText, outputPath, truncated: false }
  accepted.tasks[0].execution = { status: 'DONE', summary: 'Synthetic result', commitState: 'committed' }
  accepted.tasks[0].report = 'Synthetic accepted execution report.'
  accepted.tasks[0].review = { findings: [{ criterion: 0, finding: 'Synthetic result checked.', evidence: [evidenceId] }] }
  accepted.completion = { id: 'synthetic-accepted-receipt', at: 2, outcome: 'completed', accepted: 1, total: 1,
    deliverables: [{ taskId: 'task', title: 'Synthetic persistence task', paths: ['synthetic-result.txt'] }],
    evidence: [evidenceId], remaining: [] }
  const cancelled = fixturePlan('cancelled-session', 'cancelled')
  cancelled.cancellation = { source: 'user-message', messageId: 'synthetic-cancel-message',
    text: 'Cancel the synthetic task.', reason: 'Synthetic cancellation.', at: 2 }
  cancelled.tasks[0].childId = 'synthetic-old-child'
  cancelled.tasks[0].recovered = true
  cancelled.tasks[0].release = { status: 'failed', error: 'Synthetic cleanup unavailable.', at: 2 }
  cancelled.tasks[0].stop = { reason: cancelled.cancellation.reason, source: 'coordinator', at: 2, previousStatus: 'running' }
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ version: 1, plans: [accepted, cancelled], requestUsage: [],
    decisions: [decision('accepted-session'), decision('cancelled-session')] }))
  const oldInitial = await open(legacy.createOrchestrator)
  assert.equal(oldInitial.engine.storageError, null)
  assertPlans(oldInitial.engine, false)
  await close(oldInitial)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 1)

  // Fixture a state the old writer could accumulate before its next restart. The old reader's
  // 100-session limit and already-truncated historical input cannot be repaired by rolling back.
  const legacyState = JSON.parse(await readFile(file, 'utf8'))
  const longMessage = '迁'.repeat(3 * 1024 * 1024) + '-SYNTHETIC-LONG-MESSAGE-TAIL'
  legacyState.decisions.find(entry => entry.sessionId === 'accepted-session').messages.push({
    messageId: 'synthetic-long-update', text: longMessage, at: 3,
    resolution: { relation: 'update', requestId: 'accepted-session-request' } })
  legacyState.decisions.unshift(...Array.from({ length: 105 }, (_, index) => ({ sessionId: 'history-' + index,
    messages: [{ messageId: 'history-message-' + index, text: 'Synthetic history ' + index }] })))
  const legacyContent = JSON.stringify(legacyState)
  assert.ok(Buffer.byteLength(legacyContent) > 8 * 1024 * 1024 && Buffer.byteLength(legacyContent) < 16 * 1024 * 1024)
  await writeFile(file, legacyContent)
  const beforeBackup = path.join(temporaryRoot, 'before-upgrade-backup')
  await backupTo(beforeBackup)
  const legacyHash = digest(await readFile(file))

  const upgraded = await open(createOrchestrator)
  await assertUpgraded(upgraded, longMessage)
  await close(upgraded)
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(manifest.version, 2)
  assert.equal(manifest.sessions.length, 107)
  assert.ok((await stat(file)).size < 64 * 1024)
  summary.scenarios.push('old v1 -> current v2 in the same profile; 107 sessions, long input, accepted evidence and failed cancellation cleanup preserved')

  const upgradedBackup = path.join(temporaryRoot, 'upgraded-backup')
  await backupTo(upgradedBackup)
  const backupFile = path.join(upgradedBackup, path.relative(home, file))
  assert.equal(digest(await readFile(backupFile)), digest(await readFile(file)))
  for (const entry of manifest.sessions) {
    assert.equal(digest(await readFile(path.join(backupFile + '.state', entry.file))), entry.file.slice(0, -5))
  }
  assert.equal(await readFile(path.join(upgradedBackup, path.relative(home, outputPath)), 'utf8'), proofText)
  summary.scenarios.push('complete backup contains manifest, every referenced chunk, archive and verification output')

  for (const damage of ['missing', 'checksum']) {
    await restoreFrom(upgradedBackup)
    const chunk = path.join(file + '.state', manifest.sessions.find(entry => entry.sessionId === 'accepted-session').file)
    if (damage === 'missing') await unlink(chunk)
    else await writeFile(chunk, (await readFile(chunk, 'utf8')) + '\n')
    const protectedManifest = digest(await readFile(file))
    const broken = await open(createOrchestrator)
    assert.match(broken.engine.storageError, /分片/)
    await broken.rejectMutation()
    assert.equal(broken.started, 0)
    await close(broken)
    assert.equal(digest(await readFile(file)), protectedManifest)
    summary.scenarios.push(damage + ' chunk: recovery reports error, mutation rejected, original manifest retained')
  }
  await restoreFrom(upgradedBackup)
  const restored = await open(createOrchestrator)
  await assertUpgraded(restored, longMessage)
  await close(restored)
  assert.equal((await createRuntimeStore(file).read()).decisions.length, 107)
  summary.scenarios.push('full backup restored to original profile path and recovered through current orchestrator')

  const v2Hash = digest(await readFile(file))
  const incompatibleOld = await open(legacy.createOrchestrator)
  assert.match(incompatibleOld.engine.storageError, /格式不支持/)
  await close(incompatibleOld)
  assert.equal(digest(await readFile(file)), v2Hash)
  await restoreFrom(beforeBackup)
  assert.equal(digest(await readFile(file)), legacyHash)
  const rollback = await open(legacy.createOrchestrator)
  assert.equal(rollback.engine.storageError, null)
  assertPlans(rollback.engine, false)
  assert.equal(rollback.engine.requestContext('accepted-session').messages.at(-1).text, longMessage)
  assert.equal(await readFile(outputPath, 'utf8'), proofText)
  await close(rollback)
  const rollbackState = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(rollbackState.version, 1)
  assert.equal(rollbackState.decisions.length, 100, 'the old reader retains its documented historical limit')
  assert.equal(digest(await readFile(path.join(beforeBackup, path.relative(home, file)))), legacyHash)
  summary.scenarios.push('old code rejects v2 without overwriting it; old code plus pre-upgrade v1 backup restores accepted and cancelled work')
  summary.knownLimits = ['persistence acceptance only; synthetic state does not prove real-model quality or live desktop behavior',
    'rollback requires pre-upgrade backup; old reader keeps only its latest 100 decision records',
    'upgrade preserves existing input; text already truncated by older releases cannot be reconstructed',
    'backups are copied while the test profile is stopped; concurrent live backup is not covered']
  console.log(JSON.stringify({ passed: true, ...summary }, null, 2))
} finally {
  for (const engine of openEngines) await engine.dispose().catch(() => {})
  if (originalHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalHome
  const temporaryParent = await realpath(os.tmpdir())
  const relative = path.relative(temporaryParent, resolvedRoot)
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(resolvedRoot).startsWith('agentrix-state-upgrade-'),
    'cleanup root must be the directory created by this script under the system temporary directory')
  await rm(resolvedRoot, { recursive: true, force: true })
}
