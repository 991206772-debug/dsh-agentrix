import { randomUUID } from 'node:crypto'

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
  return { id: randomUUID(), at: Date.now(), outcome, accepted: accepted.length, total: plan.tasks.length,
    ...(reason ? { reason } : {}),
    deliverables: accepted.map(task => ({ taskId: task.id, title: task.title, paths: task.outputs })),
    evidence: [...new Set(accepted.flatMap(task => task.review?.findings?.flatMap(finding => finding.evidence) ?? []))],
    remaining: remaining.map(task => ({ taskId: task.id, title: task.title, status: task.status, reason: incompleteReason(task) })) }
}

export function completionText(receipt) {
  const title = receipt.outcome === 'partial' && receipt.remaining.every(task => task.status === 'cancelled') ? '部分完成，其余已停止'
    : { completed: '已完成', blocked: '尚未完成，已阻塞', cancelled: '已停止，未验收', partial: '部分完成，其余尚未验收' }[receipt.outcome]
  return ['交付回执：' + title, `已验收 ${receipt.accepted}/${receipt.total}`, '回执编号：' + receipt.id,
    ...receipt.deliverables.flatMap(task => task.paths.map(file => '交付物：' + file)),
    ...(receipt.evidence.length ? ['验证证据：' + receipt.evidence.join('、')] : []),
    ...(receipt.reason ? ['原因：' + receipt.reason] : []),
    ...receipt.remaining.map(task => '未完成：' + task.title + '；' + task.reason)].join('\n')
}
