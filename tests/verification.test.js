import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { evidenceKind, assertCriterionEvidence, snapshotArtifacts, assertArtifactsCurrent } from '../verification.js'

async function directory(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'dsh-verification-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  return cwd
}

test('only real shell tools provide execution evidence', () => {
  for (const tool of ['read', 'grep', 'glob']) assert.equal(evidenceKind(tool), 'static')
  for (const tool of ['pwsh', 'bash']) assert.equal(evidenceKind(tool), 'execution')
  assert.throws(() => evidenceKind('custom-runtime'), /未知验证工具/)
})

test('criterion evidence respects status, bound checks, type and current attempt', () => {
  const task = { attempts: 2, acceptance: [{ criterionId: 'C1', evidence: 'execution', checks: [0, 1] }], checks: [
    { result: { callId: 'read', passed: true, attempt: 2, evidenceKind: 'static' } },
    { result: { callId: 'run', passed: true, attempt: 2, evidenceKind: 'execution' } },
  ] }
  const finding = { criterion: 0, status: 'pass', evidence: ['read', 'run'] }
  assert.doesNotThrow(() => assertCriterionEvidence(task, finding))
  for (const status of ['partial', 'fail', 'unverified', undefined]) assert.throws(() => assertCriterionEvidence(task, { ...finding, status }), /status/)
  assert.throws(() => assertCriterionEvidence(task, { ...finding, evidence: ['read'] }), /绑定/)
  task.checks[1].result.evidenceKind = 'static'
  assert.throws(() => assertCriterionEvidence(task, finding), /实际执行/)
  task.acceptance[0].evidence = 'static'
  assert.doesNotThrow(() => assertCriterionEvidence(task, finding))
  task.checks[1].result.attempt = 1
  assert.throws(() => assertCriterionEvidence(task, finding), /本次成功证据/)
  assert.doesNotThrow(() => assertCriterionEvidence({ checks: [] }, { criterion: 0 }))
  assert.throws(() => assertCriterionEvidence({ checks: [] }, { status: 'fail' }), /status/)
})

test('missing output creation and directory membership invalidate recorded evidence', async t => {
  const cwd = await directory(t), outputs = ['missing.txt', 'delivery']
  await mkdir(path.join(cwd, 'delivery'))
  await writeFile(path.join(cwd, 'delivery', 'a.txt'), 'first')
  const initial = await snapshotArtifacts(outputs, cwd)
  const task = { outputs, checks: [{ result: { artifacts: initial } }] }
  assert.equal(initial.status, 'tracked')
  assert.equal(initial.scope, 'declared-outputs')
  await assertArtifactsCurrent(task, cwd)
  await writeFile(path.join(cwd, 'missing.txt'), 'new file')
  await assert.rejects(assertArtifactsCurrent(task, cwd), /产物发生变化/)
  const afterCreate = await snapshotArtifacts(outputs, cwd)
  task.checks[0].result.artifacts = afterCreate
  await writeFile(path.join(cwd, 'delivery', 'b.txt'), 'second')
  await assert.rejects(assertArtifactsCurrent(task, cwd), /产物发生变化/)
})

test('content changes invalidate evidence while unrelated files and output order do not', async t => {
  const cwd = await directory(t)
  await writeFile(path.join(cwd, 'a.txt'), 'original')
  await writeFile(path.join(cwd, 'b.txt'), 'other')
  const first = await snapshotArtifacts(['a.txt', 'b.txt'], cwd)
  assert.equal((await snapshotArtifacts(['b.txt', 'a.txt', 'a.txt'], cwd)).digest, first.digest)
  await writeFile(path.join(cwd, 'unrelated.txt'), 'outside declared outputs')
  assert.equal((await snapshotArtifacts(['a.txt', 'b.txt'], cwd)).digest, first.digest)
  await writeFile(path.join(cwd, 'a.txt'), 'modified')
  assert.notEqual((await snapshotArtifacts(['a.txt', 'b.txt'], cwd)).digest, first.digest)
})

test('unknown relative roots stay explicitly untracked and cannot satisfy strict acceptance', async () => {
  const artifacts = await snapshotArtifacts(['result.txt'])
  assert.equal(artifacts.status, 'unavailable')
  assert.match(artifacts.reason, /directory/)
  const task = { outputs: ['result.txt'], acceptance: [{ criterionId: 'C1' }], checks: [{ result: { artifacts } }] }
  await assert.rejects(assertArtifactsCurrent(task), /工程|directory/)
  delete task.acceptance
  await assertArtifactsCurrent(task)
})

test('declared directories have an explicit enumeration limit instead of silent omission', async t => {
  const cwd = await directory(t), output = path.join(cwd, 'delivery')
  await mkdir(output)
  await Promise.all(Array.from({ length: 512 }, (_, index) => writeFile(path.join(output, index + '.txt'), 'x')))
  await assert.rejects(snapshotArtifacts(['delivery'], cwd), /超过 512/)
})

test('symbolic output roots are rejected instead of following files outside the declared tree', async t => {
  const cwd = await directory(t), target = path.join(cwd, 'target'), link = path.join(cwd, 'delivery')
  await mkdir(target)
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(snapshotArtifacts(['delivery'], cwd), /符号链接/)
})
