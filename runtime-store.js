import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

const INLINE_BYTES = 8 * 1024 * 1024
const CHUNK_NAME = /^[a-f0-9]{64}\.json$/
const hash = text => createHash('sha256').update(text).digest('hex')

/** The orchestrator serializes writes. Immutable chunks become visible only at manifest commit. */
export function createRuntimeStore(file) {
  const directory = file + '.state'
  let references = new Set()
  async function replace(target, content) {
    await writeFile(target + '.tmp', content, 'utf8')
    await rename(target + '.tmp', target)
  }
  return {
    async read() {
      const manifest = JSON.parse(await readFile(file, 'utf8'))
      if (manifest.version !== 2) return manifest
      if (!Array.isArray(manifest.sessions) || new Set(manifest.sessions.map(item => item.sessionId)).size !== manifest.sessions.length) throw new Error('任务清单格式无效')
      const state = { version: 1, plans: [], decisions: [], requestUsage: [] }, loaded = new Set()
      for (const item of manifest.sessions) {
        if (typeof item.sessionId !== 'string' || !CHUNK_NAME.test(item.file ?? '')) throw new Error('任务数据分片路径无效')
        let text
        try { text = await readFile(path.join(directory, item.file), 'utf8') }
        catch (error) { throw new Error('任务数据分片无法读取，原清单已保留：' + error.message, { cause: error }) }
        if (hash(text) + '.json' !== item.file) throw new Error('任务数据分片校验失败，原文件已保留')
        const chunk = JSON.parse(text)
        if (chunk.sessionId !== item.sessionId) throw new Error('任务数据分片会话不匹配')
        for (const key of ['plans', 'decisions', 'requestUsage']) {
          if (!Array.isArray(chunk[key]) || chunk[key].some(entry => entry.sessionId !== item.sessionId)) throw new Error('任务数据分片内容无效')
          state[key].push(...chunk[key])
        }
        loaded.add(item.file)
      }
      references = loaded
      return state
    },
    async write(state) {
      await mkdir(path.dirname(file), { recursive: true })
      const content = JSON.stringify(state)
      if (!references.size && Buffer.byteLength(content) <= INLINE_BYTES) {
        await replace(file, content)
        return
      }
      const sessions = new Map()
      for (const key of ['plans', 'decisions', 'requestUsage']) for (const entry of state[key] ?? []) {
        let chunk = sessions.get(entry.sessionId)
        if (!chunk) {
          chunk = { sessionId: entry.sessionId, plans: [], decisions: [], requestUsage: [] }
          sessions.set(entry.sessionId, chunk)
        }
        chunk[key].push(entry)
      }
      await mkdir(directory, { recursive: true })
      const manifest = { version: 2, sessions: [] }, next = new Set()
      for (const [sessionId, chunk] of sessions) {
        const text = JSON.stringify(chunk), name = hash(text) + '.json'
        if (!references.has(name)) await replace(path.join(directory, name), text)
        manifest.sessions.push({ sessionId, file: name }); next.add(name)
      }
      await replace(file, JSON.stringify(manifest))
      const previous = references
      references = next
      // Old snapshots are redundant only after the new manifest has committed.
      for (const name of previous) if (!next.has(name)) await unlink(path.join(directory, name)).catch(() => {})
    },
  }
}
