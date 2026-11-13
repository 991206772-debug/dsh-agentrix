import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, unlink } from 'node:fs/promises'
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
