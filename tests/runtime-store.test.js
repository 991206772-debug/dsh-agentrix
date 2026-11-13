import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRuntimeStore } from '../runtime-store.js'

test('large state commits a manifest atomically, retains unchanged sessions and fails closed on missing chunks', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentrix-store-')), file = path.join(directory, 'runs.json')
  const state = { version: 1, plans: [], requestUsage: [], decisions: [
    { sessionId: 'large', messages: [{ messageId: 'original', text: 'x'.repeat(8 * 1024 * 1024) + '-original' }] },
    { sessionId: 'other', messages: [{ messageId: 'other', text: 'preserved' }] },
  ] }
  const store = createRuntimeStore(file)
  try {
    await store.write(state)
    const initial = await readFile(file, 'utf8'), first = JSON.parse(initial)
    assert.equal(first.version, 2)
    state.decisions[0].messages[0].text += '-updated'
    await mkdir(file + '.tmp')
    await assert.rejects(store.write(state))
    assert.equal(await readFile(file, 'utf8'), initial)
    assert.ok((await createRuntimeStore(file).read()).decisions[0].messages[0].text.endsWith('-original'))
    await rm(file + '.tmp', { recursive: true })
    await store.write(state)
    const next = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(next.sessions.find(item => item.sessionId === 'other').file, first.sessions.find(item => item.sessionId === 'other').file)
    assert.ok((await createRuntimeStore(file).read()).decisions[0].messages[0].text.endsWith('-updated'))
    await unlink(path.join(file + '.state', next.sessions[0].file))
    await assert.rejects(createRuntimeStore(file).read(), error => error.code !== 'ENOENT' && /分片/.test(error.message))
    assert.equal(await readFile(file, 'utf8'), JSON.stringify(next))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('failed manifest commits leave no new chunks and later commits collect stale files without touching referenced data', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentrix-store-gc-')), file = path.join(directory, 'runs.json')
  const state = { version: 1, plans: [], requestUsage: [], decisions: [
    { sessionId: 'large', messages: [{ text: 'x'.repeat(8 * 1024 * 1024) }] },
    { sessionId: 'unchanged', messages: [{ text: 'still referenced' }] },
  ] }
  const store = createRuntimeStore(file)
  try {
    await store.write(state)
    const initial = await readFile(file, 'utf8'), first = JSON.parse(initial)
    state.decisions[0].messages[0].text += '-failed'
    await mkdir(file + '.tmp')
    await assert.rejects(createRuntimeStore(file).write(state))
    assert.deepEqual((await readdir(file + '.state')).sort(), first.sessions.map(item => item.file).sort())
    assert.equal(await readFile(file, 'utf8'), initial)
    await rm(file + '.tmp', { recursive: true })
    const stale = '0'.repeat(64) + '.json'
    await writeFile(path.join(file + '.state', stale), 'left by an interrupted old writer')
    await writeFile(path.join(file + '.state', stale + '.tmp'), 'incomplete chunk')
    await writeFile(path.join(file + '.state', 'notes.txt'), 'unrelated')
    state.decisions[0].messages[0].text += '-success'
    const reloaded = createRuntimeStore(file); await reloaded.read(); await reloaded.write(state)
    const manifest = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual((await readdir(file + '.state')).sort(), [...manifest.sessions.map(item => item.file), 'notes.txt'].sort())
    assert.ok((await createRuntimeStore(file).read()).decisions[0].messages[0].text.endsWith('-success'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a failed manifest rename removes its temporary file and newly created chunks', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agentrix-store-temp-')), file = path.join(directory, 'runs.json')
  try {
    await mkdir(file)
    await assert.rejects(createRuntimeStore(file).write({ version: 1, plans: [], requestUsage: [], decisions: [
      { sessionId: 'large', messages: [{ text: 'x'.repeat(8 * 1024 * 1024) }] },
    ] }))
    assert.equal((await readdir(directory)).includes('runs.json.tmp'), false)
    assert.deepEqual(await readdir(file + '.state'), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
