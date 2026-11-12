import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startSupervision, observeTool } from '../supervision.js'

function fixture() {
  const task = { attempts: 1 }
  startSupervision(task, 100, 120 * 60_000)
  let count = 0
  return { task, observe(name, args, text, callId = 'call-' + ++count) {
    return observeTool(task, { name, arguments: args, callId },
      { isError: false, value: name === 'pwsh' ? { exitCode: 0 } : undefined, content: [{ type: 'text', text }] }, 100 + count)
  } }
}

test('identical successful tool observations trigger one advisory with exact evidence', () => {
  const f = fixture()
  assert.equal(f.observe('pwsh', { command: 'count' }, '119'), null)
  const firstProgress = f.task.supervision.lastProgressAt
  assert.equal(f.observe('pwsh', { command: 'count' }, '119'), null)
  const alert = f.observe('pwsh', { command: 'count' }, '119')
  assert.equal(alert.code, 'REPEATED_OBSERVATION')
  assert.equal(alert.advisory, true)
  assert.deepEqual(alert.evidence, ['call-1', 'call-2', 'call-3'])
  assert.equal(f.task.supervision.lastProgressAt, firstProgress, 'a duplicate successful command is activity rather than new evidence')
  for (let i = 0; i < 10; i++) assert.equal(f.observe('pwsh', { command: 'count' }, '119'), null)
  assert.equal(f.task.supervision.used, 0)
})

test('alternating repeated observations are detected while duplicate delivery is ignored', () => {
  const f = fixture()
  f.observe('read', { file_path: 'a.md' }, 'same a', 'fixed-id')
  f.observe('read', { file_path: 'a.md' }, 'same a', 'fixed-id')
  assert.equal(f.task.supervision.notices.REPEATED_OBSERVATION, undefined)
  for (let i = 0; i < 2; i++) {
    f.observe('read', { file_path: 'b.md' }, 'same b')
    const alert = f.observe('read', { file_path: 'a.md' }, 'same a')
    if (i === 1) assert.equal(alert.code, 'REPEATED_OBSERVATION')
  }
})

test('different files, slices and output changes remain productive read-only work', () => {
  const f = fixture()
  for (let i = 0; i < 20; i++) {
    assert.equal(f.observe('read', { file_path: 'doc.md', offset: i * 100 }, 'similar contents'), null)
    assert.equal(f.observe('read', { file_path: 'file-' + i }, 'same contents'), null)
    assert.equal(f.observe('pwsh', { command: 'test' }, 'progress ' + i), null)
  }
  assert.ok(f.task.supervision.lastProgressAt > 100)
  assert.equal(f.task.supervision.pending, null)
})

test('intervening writes reset duplicate observations so repeated tests after changes do not warn', () => {
  const f = fixture()
  for (let i = 0; i < 8; i++) {
    assert.equal(f.observe('pwsh', { command: 'test' }, 'PASS'), null)
    assert.equal(f.observe('edit', { file_path: 'file.js', old_string: String(i), new_string: String(i + 1) }, 'ok'), null)
  }
  assert.equal(f.task.supervision.notices.REPEATED_OBSERVATION, undefined)
})
