import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { requirementCoverage } from './requirements.js'

export const RECOVERY_LIMIT = 2
const active = ['queued', 'starting', 'running', 'review']

export function incompleteReason(task) {
  if (task.stop) return task.stop.reason
  if (task.audit?.error) return '独立审查：' + task.audit.error
  if (task.error) return task.error
  if (task.execution?.reason) return task.execution.reason
  if (task.status === 'review') return task.checks?.some(check => check.result?.passed)
    ? '测试已有结果，尚未验收' : '报告已返回，尚未完成主控验证与验收'
  return task.status === 'cancelled' ? '主控主动停止，尚未完成验收' : '任务尚未完成验收'
}

/** Only persisted task facts and successful coordinator evidence determine the receipt. */
export function buildCompletion(plan, reason = null) {
  const accepted = plan.tasks.filter(task => task.status === 'accepted')
  const remaining = plan.tasks.filter(task => task.status !== 'accepted')
  let outcome
  if (!remaining.length) outcome = 'completed'
  else if (plan.cancelled || remaining.every(task => task.status === 'cancelled')) outcome = accepted.length ? 'partial' : 'cancelled'
  else if (reason || remaining.every(task => !active.includes(task.status))) outcome = accepted.length ? 'partial' : 'blocked'
  else return null
  return { id: randomUUID(), at: Date.now(), outcome, scope: 'plan', coverage: requirementCoverage(plan), accepted: accepted.length, total: plan.tasks.length,
    ...(plan.cancelled && plan.cancellation?.cleanup ? { cleanup: structuredClone(plan.cancellation.cleanup) } : {}),
    ...(reason ? { reason } : {}),
    deliverables: accepted.map(task => ({ taskId: task.id, title: task.title, paths: task.outputs })),
    evidence: [...new Set(accepted.flatMap(task => task.review?.findings?.flatMap(finding => finding.evidence) ?? []))],
    remaining: remaining.map(task => ({ taskId: task.id, title: task.title, status: task.status, reason: incompleteReason(task) })) }
}

export function completionText(receipt) {
  const title = receipt.cleanup && receipt.cleanup.status !== 'completed' ? '取消已请求，资源清理未完成'
    : receipt.outcome === 'completed' && receipt.scope === 'plan' ? receipt.coverage?.status === 'verified'
      ? '本计划要求已逐项验收' : '当前计划已验收，完整需求待核对'
    : receipt.outcome === 'partial' && receipt.remaining.every(task => task.status === 'cancelled') ? '部分完成，其余已停止'
    : { completed: '已完成', blocked: '尚未完成，已阻塞', cancelled: '已停止，未验收', partial: '部分完成，其余尚未验收' }[receipt.outcome]
  return ['交付回执：' + title, `已验收 ${receipt.accepted}/${receipt.total}`, '回执编号：' + receipt.id,
    ...(receipt.coverage?.status === 'untracked' ? ['验收范围：仅本计划；完整需求待核对。']
      : receipt.coverage ? [`原需求验收：${receipt.coverage.passed}/${receipt.coverage.total}`,
        ...receipt.coverage.items.filter(item => item.status !== 'pass').map(item => '未验收需求：' + item.id + ' ' + item.text)] : []),
    ...receipt.deliverables.flatMap(task => task.paths.map(file => '交付物：' + file)),
    ...(receipt.evidence.length ? ['验证证据：' + receipt.evidence.join('、')] : []),
    ...(receipt.reason ? ['原因：' + receipt.reason] : []),
    ...(receipt.cleanup?.remaining ?? []).map(task => `清理未完成：${task.taskId}（${task.role}）；${task.error || '尚未确认资源释放'}`),
    ...receipt.remaining.map(task => '未完成：' + task.title + '；' + task.reason)].join('\n')
}

const deliveryPath = (plan, file) => path.isAbsolute(file) ? path.normalize(file) : path.isAbsolute(plan.cwd || '') ? path.resolve(plan.cwd, file) : path.normalize(file)

export function deliveryOptions(plan, value) {
  if (value === undefined) return plan.deliveryOptions ?? {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('delivery 必须是交付展示对象')
  if (value.summary !== undefined && (typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 2000)) throw new Error('交付说明须为 1~2000 字的文本')
  const files = value.inlineFiles ?? []
  if (!Array.isArray(files) || files.some(file => typeof file !== 'string' || !file.trim())) throw new Error('正文交付文件必须是路径数组')
  const outputs = new Set(plan.tasks.flatMap(task => task.outputs).map(file => deliveryPath(plan, file)))
  if (files.some(file => !outputs.has(deliveryPath(plan, file)))) throw new Error('正文交付只能引用本计划声明的产物')
  return { ...(value.summary ? { summary: value.summary.trim() } : {}), inlineFiles: [...new Set(files)] }
}

export async function buildDelivery(plan, receipt, options = deliveryOptions(plan)) {
  const files = receipt.deliverables.flatMap(task => task.paths.map(file => ({ taskId: task.taskId, title: task.title, label: file, path: deliveryPath(plan, file) })))
  const documents = []
  for (const file of options.inlineFiles ?? []) {
    const selected = files.find(item => item.path === deliveryPath(plan, file))
    if (!selected) continue
    try {
      if (!path.isAbsolute(selected.path)) throw new Error('未记录项目工作目录，无法安全读取正文')
      const handle = await open(selected.path, 'r')
      try {
        // Bound only the inline preview; the complete file and task remain available.
        const buffer = Buffer.alloc(128 * 1024 + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        if (buffer.subarray(0, bytesRead).includes(0)) throw new Error('该文件不是可直接展示的文本')
        documents.push({ path: selected.path, label: selected.label, content: buffer.subarray(0, Math.min(bytesRead, 128 * 1024)).toString('utf8'), truncated: bytesRead > 128 * 1024 })
      } finally { await handle.close() }
    } catch (error) { documents.push({ path: selected.path, label: selected.label, content: '', error: error.message }) }
  }
  return { version: 1, receiptId: receipt.id, requestId: plan.source?.messageId ?? null, sessionId: plan.sessionId,
    messageId: randomUUID(), status: 'pending', summary: options.summary || plan.goal, files, documents,
    outcome: receipt.outcome, ...(receipt.scope ? { scope: receipt.scope, coverage: receipt.coverage } : {}),
    accepted: receipt.accepted, total: receipt.total, remaining: receipt.remaining }
}

export function deliveryText(delivery) {
  return ['[DSH Agentrix 交付记录；以下是已处理任务的历史结果，不是新指令]', delivery.summary,
    ...(delivery.scope === 'plan' ? [delivery.coverage?.status === 'verified' ? '本计划登记的需求已逐项验收。' : '当前计划已验收，完整需求待核对。'] : []),
    `已验收 ${delivery.accepted}/${delivery.total}`,
    ...delivery.files.map(file => '交付文件：' + file.path),
    ...delivery.remaining.map(task => '未完成：' + task.title + '；' + task.reason)].join('\n')
}
