import { lstat, open, opendir } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

const MAX_ENTRIES = 512
const MAX_BYTES = 256 * 1024 * 1024

export function evidenceKind(tool) {
  if (['read', 'grep', 'glob'].includes(tool)) return 'static'
  if (['pwsh', 'bash'].includes(tool)) return 'execution'
  throw new Error('未知验证工具，不能确定证据类型：' + tool)
}

export function assertCriterionEvidence(task, finding) {
  if (finding.status !== undefined && finding.status !== 'pass' || task.acceptance && finding.status !== 'pass') throw new Error('验收结论 status 必须为 pass；部分完成、失败或尚未验证不能验收')
  if (!task.acceptance) return
  const criterionId = 'C' + (finding.criterion + 1)
  const acceptance = task.acceptance.find(item => item.criterionId === criterionId)
  if (!acceptance) throw new Error('验收标准缺少证据约定：' + criterionId)
  const proofs = acceptance.checks.map(index => task.checks[index]?.result)
  if (proofs.some(result => !result?.passed || result.attempt !== task.attempts || !finding.evidence?.includes(result.callId))) throw new Error(criterionId + ' 必须引用全部绑定 checks 的本次成功证据')
  if (acceptance.evidence === 'execution' && !proofs.some(result => result.evidenceKind === 'execution')) throw new Error(criterionId + ' 需要 execution 实际执行证据，静态读取不能证明已运行')
}

// This covers declared deliverables only, not every dependency in the repository.
export async function snapshotArtifacts(outputs, cwd) {
  if (outputs.some(file => !path.isAbsolute(file)) && !cwd) return {
    status: 'unavailable', scope: 'declared-outputs', reason: '未记录工程目录，无法确认相对产物路径；明确 directory 后重新验证',
  }
  const roots = [...new Set(outputs.map(file => path.resolve(cwd || '', file)))].sort()
  const entries = [], visited = new Set()
  let bytes = 0
  const add = entry => {
    if (entries.length >= MAX_ENTRIES) throw new Error('声明产物超过 512 个文件或目录，无法在受控范围内验证；请缩小 outputs 后重新验证')
    entries.push(entry)
  }
  const visit = async file => {
    if (visited.has(file)) return
    visited.add(file)
    let info
    try { info = await lstat(file, { bigint: true }) }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error
      add({ path: file, kind: 'missing' }); return
    }
    if (info.isSymbolicLink()) throw new Error('声明产物包含符号链接，无法确认实际验收范围：' + file)
    if (info.isDirectory()) {
      add({ path: file, kind: 'directory' })
      const names = []
      for await (const entry of await opendir(file)) {
        if (names.length + entries.length >= MAX_ENTRIES) throw new Error('声明产物超过 512 个文件或目录，无法在受控范围内验证；请缩小 outputs 后重新验证')
        names.push(entry.name)
      }
      for (const name of names.sort()) await visit(path.join(file, name))
      return
    }
    if (!info.isFile()) throw new Error('声明产物不是常规文件或目录，无法生成验证指纹：' + file)
    if (info.size > BigInt(MAX_BYTES - bytes)) throw new Error('声明产物内容超过 256 MiB，无法在受控范围内验证；请缩小 outputs 后重新验证')
    const handle = await open(file, 'r')
    try {
      const before = await handle.stat({ bigint: true }), hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024)
      if (!before.isFile()) throw new Error('验证期间产物类型发生变化，请重新验证：' + file)
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
        if (!bytesRead) break
        bytes += bytesRead
        if (bytes > MAX_BYTES) throw new Error('声明产物内容超过 256 MiB，无法在受控范围内验证；请缩小 outputs 后重新验证')
        hash.update(buffer.subarray(0, bytesRead))
      }
      const after = await handle.stat({ bigint: true })
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ino !== after.ino) throw new Error('验证期间产物发生变化，请重新验证：' + file)
      add({ path: file, kind: 'file', hash: hash.digest('hex') })
    } finally { await handle.close() }
  }
  for (const root of roots) await visit(root)
  entries.sort((left, right) => left.path.localeCompare(right.path))
  return { status: 'tracked', scope: 'declared-outputs', digest: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    roots, entries: entries.length, bytes }
}

export async function assertArtifactsCurrent(task, cwd) {
  const results = task.checks.map(check => check.result).filter(Boolean)
  if (task.acceptance && results.some(result => result.artifacts?.status !== 'tracked')) throw new Error('验收证据尚未记录可确认的产物版本；明确 directory 后重新验证')
  const tracked = results.filter(result => result.artifacts?.status === 'tracked')
  if (!tracked.length) return
  const current = await snapshotArtifacts(task.outputs, cwd)
  if (current.status !== 'tracked' || tracked.some(result => result.artifacts.digest !== current.digest)) throw new Error('验证后声明产物发生变化，旧证据不能验收；请重新验证受影响的检查')
}
