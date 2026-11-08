import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { completionText, incompleteReason } from './completion.js'

const RECORD_ID = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9-]{36}$/
const labels = { queued: '待派单', starting: '正在派单', running: '执行中', review: '待评审',
  accepted: '已验收', failed: '执行失败', blocked: '已阻塞', cancelled: '已停止', planned: '计划已建立' }
const time = value => value ? new Date(value).toISOString() : '—'
const list = values => values?.length ? values.map(value => '- ' + value).join('\n') : '- 无'
const json = value => '~~~json\n' + JSON.stringify(value, null, 2) + '\n~~~'
const invalid = message => Object.assign(new Error(message), { statusCode: 400 })
async function replace(file, content) {
  await writeFile(file + '.tmp', content, 'utf8')
  await rename(file + '.tmp', file)
}

export function taskSummary(plan) {
  const remaining = plan.tasks.filter(task => task.status !== 'accepted')
  const lines = ['# 任务档案', '', plan.goal, '',
    '- 状态：' + labels[plan.status],
    '- 创建时间：' + time(plan.createdAt), '- 最近更新：' + time(plan.updatedAt),
    '- 工作目录：' + (plan.cwd || '未提供项目目录'), '- 主 Agent：' + plan.sessionId,
    '- 原始需求消息：' + (plan.source?.messageId || '未记录'),
    plan.routing?.route ? '- 路由：' + plan.routing.route + '（依据：' + ((plan.routing.reasonLabels || plan.routing.reasons || []).join('、') || '未记录') + '）' : '',
    plan.activationBudget ? '- 启动尝试次数：' + plan.activationBudget.used + ' / ' + plan.activationBudget.limit + '（剩余 ' + Math.max(0, plan.activationBudget.limit - plan.activationBudget.used) + '）' : '',
    ...(plan.routingWarnings?.length ? ['- 路由提醒：' + plan.routingWarnings.join('；')] : []),
    '', '## 原始需求', '', plan.source?.text || '历史记录未保存原始需求，请回到来源会话核对。',
    '- 已验收：' + plan.tasks.filter(task => task.status === 'accepted').length + ' / ' + plan.tasks.length,
    '', '## 最近进展', '', list((plan.recentEvents || []).map(event =>
      time(event.at) + ' · ' + (event.taskId ? event.taskId + ' · ' : '') + event.message)),
    '', '## 未完成项与接续位置', '',
    remaining.length ? list(remaining.map(task => task.id + '：' + labels[task.status] + '；' +
      incompleteReason(task))) : '全部子任务已验收。',
    '', '本档案提供继续处理所需的记录；重新加载后，活动子任务须先清理，再按现有规则重试。']
  if (plan.completion) lines.push('', '## 程序交付回执', '', completionText(plan.completion))
  for (const task of plan.tasks) {
    lines.push('', '## ' + task.id + ' · ' + task.title, '',
      '- 状态：' + labels[task.status], '- 执行次数：' + task.attempts,
      ...(task.continuation?.used ? ['- 自动续跑段数：' + task.continuation.used + '（上一段预算已用尽，已沿用现有产物继续）'] : []),
      '- 模型角色：' + (task.modelRoute?.role === 'worker' ? '执行模型' : task.modelRoute?.role === 'reviewer' ? '审查模型' : '历史未记录'),
      '- 任务复杂度：' + (task.complexity === 'complex' ? '复杂问题' : '普通执行'),
      '- 档位依据：' + (task.complexityReason || '未记录'),
      '- 配置来源：' + (task.modelRoute ? task.modelRoute.source === 'configured' ? '用户配置' : '启动时继承主 Agent' : '历史未记录'),
      '- 配置模型：' + (task.modelRoute?.requested ? task.modelRoute.requested.provider + ' / ' + task.modelRoute.requested.model : '未记录'),
      '- 实际请求模型：' + (task.modelRoute?.actual ? task.modelRoute.actual.provider + ' / ' + task.modelRoute.actual.model : task.modelRoute ? '尚未请求' : '历史未记录'),
      ...(!task.modelRoute && task.model ? ['- 历史模型记录：' + task.model.provider + ' / ' + task.model.model + '（未记录配置与实际请求的区别）'] : []),
      ...(task.modelRoute?.rejected ? ['- 已阻止的模型请求：' + task.modelRoute.rejected.provider + ' / ' + task.modelRoute.rejected.model] : []),
      '- 子 Agent：' + (task.childId || '尚未派单'), '- 依赖：' + (task.dependsOn.join('、') || '无'),
      '- 最近活动：' + (task.progress ? task.progress.tool + ' · ' + time(task.progress.at) : '暂无'),
      '', '### 任务说明与边界', '', task.instructions, '', task.scope,
      '', '### 声明的交付物', '', list(task.outputs),
      '', '### 可修改路径', '', list(task.writes),
      '', '### 验收标准', '', list(task.criteria))
    if (task.supervision) {
      const state = task.supervision, metrics = state.metrics, limits = state.limits
      lines.push('', '### 过程监督', '', `- 主控纠偏：${state.used}/${state.limit}`,
        '- 本次截止时间：' + time(state.deadlineAt),
        ...(metrics && limits ? [`- 模型调用：${metrics.requests}/${limits.requests}；输出 Token：${metrics.outputTokens}/${limits.outputTokens}；最近上下文 Token：${metrics.contextTokens}`] : []),
        ...(state.pending ? ['- 需要主控处理：' + state.pending.reason] : []),
        ...(state.lastCorrection ? ['- 最近主控纠正：' + state.lastCorrection.message] : []),
        ...(state.wrapUpRequestedAt ? ['- 已提醒原子代理收尾：' + time(state.wrapUpRequestedAt)] : []),
        ...(state.checkpoint ? ['- 阶段结论（执行者提交，待核实）：' + state.checkpoint.summary,
          '- 执行者下一步：' + state.checkpoint.nextStep, '- 阶段工具证据：' + state.checkpoint.evidence.join('、')] : []))
    }
    if (task.error) lines.push('', '### 阻塞或失败原因', '', task.error)
    if (task.stop) lines.push('', '### 取消记录', '', '- 原因：' + task.stop.reason,
      '- 取消来源：' + ({ coordinator: '主控', host: '用户或宿主' }[task.stop.source] || task.stop.source),
      '- 取消时间：' + time(task.stop.at))
    if (task.feedback) lines.push('', '### 主 Agent 的纠偏或返工要求', '', task.feedback)
    if (task.execution) lines.push('', '### 执行结论', '',
      '- 状态：' + task.execution.status, '- 摘要：' + task.execution.summary,
      '- 完整报告：' + task.execution.reportPath,
      ...(task.execution.reason ? ['- 原因：' + task.execution.reason] : []),
      ...(task.execution.concerns?.length ? ['- 疑点：' + task.execution.concerns.join('；')] : []))
    if (task.audit) {
      const audit = task.audit, route = audit.modelRoute?.actual ?? audit.modelRoute?.resolved ?? audit.modelRoute?.requested
      const verdict = value => value === 'pass' ? '通过' : value === 'fail' ? '未通过' : '未记录'
      lines.push('', '### 独立审查', '', '- 状态：' + ({ completed: '审查已返回', queued: '等待审查名额' }[audit.status] || labels[audit.status]),
        '- 审查对应执行次数：' + audit.forAttempt, '- 审查启动次数：' + audit.attempts,
        '- 需求：' + verdict(audit.specVerdict) + '；质量：' + verdict(audit.qualityVerdict),
        '- 审查模型：' + (route ? route.provider + ' / ' + route.model : '未记录') + '（' + (audit.modelRoute?.actual ? '实际请求已核对' : '尚未记录实际请求') + '）',
        '- 审查配置来源：' + (audit.modelRoute ? audit.modelRoute.source === 'configured' ? '用户配置' : '审查启动时跟随主控' : '历史未记录'),
        ...(audit.error ? ['- 原因：' + audit.error] : []),
        ...(audit.execution?.reportPath ? ['- 完整报告：' + audit.execution.reportPath] : []),
        ...(audit.report ? ['', audit.report] : []))
    }
    if (task.issues?.length) lines.push('', '### 具体问题及处理', '', ...task.issues.map(issue =>
      '- ' + issue.id + ' · ' + ({ open: '待解决', addressed: '已解决', deferred: '可选建议' }[issue.status]) + ' · ' + issue.finding +
      '；证据：' + issue.evidence.join('、') + (issue.resolutionEvidence ? '；复查证据：' + issue.resolutionEvidence.join('、') : '')))
    if (task.report) lines.push('', '### 子 Agent 报告', '', task.report)
    lines.push('', '### 主 Agent 验证证据')
    for (const check of task.checks) {
      lines.push('', '- 工具：' + check.tool, json(check.arguments))
      const result = check.result
      lines.push(result ? '- 结果：' + (result.passed ? '通过' : '失败或结果不明确') +
        '；证据：' + result.callId + (result.exitCode !== undefined ? '；退出码：' + result.exitCode : '') : '- 结果：尚未验证')
      if (result) lines.push('', result.summary || '（无文本输出）')
    }
    lines.push('', '### 主 Agent 验收结论', '', task.review
      ? list(task.review.findings.map(finding => task.criteria[finding.criterion] + '：' +
        finding.finding + '；证据：' + finding.evidence.join('、'))) : '尚未验收。')
    if (task.review?.concernsResolution) lines.push('', '- 疑点处理：' + task.review.concernsResolution)
  }
  lines.push('', '---', '此摘要由插件根据任务状态生成。完整关键事件保存在同目录 events.jsonl；结构化任务快照保存在 task.json。', '')
  return lines.join('\n')
}

/** Supporting execution records live with the profile; existing project archives retain their paths. */
export function createTaskRecords(file) {
  const root = file.replace(/\.json$/, '') + '.archive'
  const index = path.join(root, 'index')
  function attach(plan) {
    const id = plan.archive?.id
    if (id !== undefined && !RECORD_ID.test(id)) throw invalid('任务档案编号无效')
    const recordId = id || time(plan.createdAt).replace(/[:.]/g, '-') + '-' + randomUUID()
    const storage = plan.archive ? (plan.archive.storage || 'project') : 'profile'
    const directory = path.join(storage === 'profile' ? root : (plan.cwd || root), '.agent-tasks', recordId)
    plan.archive = { id: recordId, directory, summaryPath: path.join(directory, 'task.md'), storage }
    return plan.archive
  }
  async function write(plan, events) {
    const archive = attach(plan)
    await mkdir(archive.directory, { recursive: true })
    await mkdir(index, { recursive: true })
    for (const task of plan.tasks.flatMap(task => task.audit ? [task, task.audit] : [task])) if (task.execution && task.report) {
      const target = reportPath(plan, task)
      await mkdir(path.dirname(target), { recursive: true })
      await replace(target, task.report)
    }
    if (events.length) await appendFile(path.join(archive.directory, 'events.jsonl'),
      events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8')
    await replace(path.join(archive.directory, 'task.json'), JSON.stringify(plan, null, 2) + '\n')
    await replace(archive.summaryPath, taskSummary(plan))
    const descriptor = { ...archive, goal: plan.goal.slice(0, 240), status: plan.status,
      createdAt: plan.createdAt, updatedAt: plan.updatedAt, cwd: plan.cwd,
      accepted: plan.tasks.filter(task => task.status === 'accepted').length, total: plan.tasks.length }
    await replace(path.join(index, archive.id + '.json'), JSON.stringify(descriptor))
  }
  async function history(before) {
    if (before !== undefined && !RECORD_ID.test(before)) throw invalid('历史任务游标无效')
    let entries
    try { entries = await readdir(index, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') return { items: [], next: null }; throw error }
    const ids = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name.slice(0, -5)).filter(id => RECORD_ID.test(id) && (!before || id < before)).sort().reverse()
    const page = ids.slice(0, 20)
    const items = await Promise.all(page.map(id => readDescriptor(id)))
    return { items, next: ids.length > page.length ? page.at(-1) : null }
  }
  async function readDescriptor(id) {
    if (!RECORD_ID.test(id || '')) throw invalid('任务档案编号无效')
    return JSON.parse(await readFile(path.join(index, id + '.json'), 'utf8'))
  }
  async function read(id) {
    const descriptor = await readDescriptor(id)
    const [state, markdown] = await Promise.all([
      readFile(path.join(descriptor.directory, 'task.json'), 'utf8'), readFile(descriptor.summaryPath, 'utf8'),
    ])
    return { plan: JSON.parse(state), markdown }
  }
  function reportPath(plan, task) {
    return path.join(attach(plan).directory, 'reports', task.id,
      `${task.role === 'reviewer' ? 'review-' + task.forAttempt : 'worker'}-${task.attempts}.md`)
  }
  return { attach, write, history, read, reportPath }
}
