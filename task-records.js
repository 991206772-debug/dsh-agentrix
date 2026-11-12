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
    ...(plan.messageResolution ? ['- 最近消息关联：' + ({ new: '新需求', continue: '继续原需求', update: '补充或调整原需求', question: '询问进度或普通提问' }[plan.messageResolution.relation] || '未记录'),
      '- 关联消息：' + plan.messageResolution.messageId + '；对应需求：' + plan.messageResolution.requestId] : []),
    '- 主控决定：' + (plan.decision ? plan.decision.mode === 'delegate' ? '委派' : '直接执行' : '未记录'),
    ...(plan.decision ? ['- 判断理由：' + plan.decision.reason,
      '- 判断时间：' + time(plan.decision.at) + '；主控模型：' + plan.decision.model.provider + ' / ' + plan.decision.model.model,
      '- 对应需求与补充：' + plan.decision.requestId + ' / ' + plan.decision.revisionId] : []),
    plan.routing?.route ? '- 初始分流建议（非主控最终决定）：' + plan.routing.route + '（依据：' + ((plan.routing.reasonLabels || plan.routing.reasons || []).join('、') || '未记录') + '）' : '',
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
  if (plan.interruption) lines.push('', '## 执行中断与恢复', '',
    '- 中断原因：' + plan.interruption.reason, '- 中断时间：' + time(plan.interruption.at),
    '- 恢复时间：' + time(plan.interruption.resumedAt),
    '- 接续方式：用户明确继续后沿用原计划，只恢复未完成部分；已返回报告继续验证验收，失败任务须处理原因后明确重试。')
  if (plan.cancellation) lines.push('', '## 整计划取消来源', '',
    '- 用户消息：' + plan.cancellation.messageId, '- 取消原因：' + plan.cancellation.reason,
    '- 取消时间：' + time(plan.cancellation.at))
  if (plan.coordinationIssue) {
    const issue = plan.coordinationIssue
    lines.push('', '## ' + (issue.role === 'coordinator' ? '主控操作未执行' : '协作操作未执行'), '',
      '- 工具：' + issue.tool, '- 调用编号：' + (issue.callId || '未记录'),
      '- 原因：' + issue.message, '- 下一步：' + issue.nextAction,
      '- 发生时间：' + time(issue.at), '- 解决时间：' + time(issue.resolvedAt))
  }
  if (plan.coordinatorIssue) lines.push('', '## 主控模型服务', '', plan.coordinatorIssue.message,
    '- 服务：' + (plan.coordinatorIssue.provider || '未记录') + ' / ' + (plan.coordinatorIssue.model || '未记录'),
    '- 原始错误：' + plan.coordinatorIssue.details, '- 下一步：' + plan.coordinatorIssue.action,
    '- 恢复响应时间：' + time(plan.coordinatorIssue.resolvedAt))
  if (plan.inputs?.length) lines.push('', '## 用户补充及处理', '', ...plan.inputs.flatMap(input => [
    `- ${input.id} · ${{ queued: '待主控接收', received: '主控已接收，待处理', forwarded: '已同步至任务', resolved: '已答复', withdrawn: '已撤回' }[input.status] || input.status} · ${time(input.at)}`,
    input.text, ...(input.taskId ? ['- 对应任务：' + input.taskId] : []), ...(input.resolution ? ['- 处理说明：' + input.resolution] : []),
    ...(input.additionalCriteria?.length ? ['- 新增验收标准：' + input.additionalCriteria.join('；')] : [])]))
  const usage = plan.usage
  lines.push('', '## 本次需求用量', '', usage?.complete && usage.roles.every(row => row.responses >= row.requests)
    ? '已记录全部已返回请求；输入、缓存和输出沿用宿主原始口径，不估算费用。' : '统计不完整；历史或缺失数据不补造。')
  const token = value => Number.isFinite(value) ? value : '未提供'
  for (const row of usage?.roles ?? []) lines.push(`- ${{ coordinator: '主控', worker: '执行者', reviewer: '独立审查' }[row.role]} · ${row.model ?? '未记录模型'} · 执行次数 ${row.attempt} · 模型请求 ${row.requests} · 输入 ${token(row.inputTokens)} · 缓存读取 ${token(row.cacheReadTokens)} · 缓存写入 ${token(row.cacheWriteTokens)} · 输出 ${token(row.outputTokens)}`)
  for (const task of plan.tasks) {
    lines.push('', '## ' + task.id + ' · ' + task.title, '',
      '- 状态：' + labels[task.status], '- 执行次数：' + task.attempts,
      ...(task.continuation?.used ? ['- 自动续跑段数：' + task.continuation.used + '（上一段预算已用尽，已沿用现有产物继续）'] : []),
      '- 模型角色：' + (task.modelRoute?.role === 'worker' ? '执行模型' : task.modelRoute?.role === 'reviewer' ? '审查模型' : '历史未记录'),
      '- 任务复杂度：' + (task.complexity === 'complex' ? '复杂问题' : '普通执行'),
      '- 档位依据：' + (task.complexityReason || '未记录'),
      '- 配置来源：' + (task.modelRoute ? task.modelRoute.source === 'configured' ? '用户配置' : '启动时继承主 Agent' : '历史未记录'),
      '- 配置模型：' + (task.modelRoute?.requested ? task.modelRoute.requested.provider + ' / ' + task.modelRoute.requested.model : '未记录'),
      ...(task.dispatcherModel ? [
        '- 审查沿用主控模型：' + task.dispatcherModel.provider + ' / ' + task.dispatcherModel.model + '；思考强度：' + (task.dispatcherModel.reasoningEffort ?? '模型默认值'),
        '- 分发模型记录：' + (task.dispatcherModel.source === 'legacy-review' ? '旧任务缺少分发快照，采用首次审查时的主控模型' : '任务第 ' + task.dispatcherModel.attempt + ' 次派发时固定') + '；时间：' + time(task.dispatcherModel.at),
      ] : []),
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
        (state.remindAt ? '- 运行时间提醒：' + time(state.remindAt) : '- 历史截止时间：' + time(state.deadlineAt)),
        ...(metrics && limits ? [`- 本次执行模型调用：${metrics.requests}${Number.isFinite(limits.requests) ? '/' + limits.requests : ''}；输出 Token：${metrics.outputTokens}${Number.isFinite(limits.outputTokens) ? '/' + limits.outputTokens : '（仅统计，不设插件上限）'}；最近上下文 Token：${metrics.contextTokens}`] : []),
        ...(state.notices?.REQUEST_VOLUME ? ['- 调用次数提醒已记录；原代理继续执行。'] : []),
        ...(state.notices?.ELAPSED_TIME ? ['- 运行时间提醒已记录；任务继续执行。'] : []),
        ...(state.pending ? ['- 需要主控处理：' + state.pending.reason] : []),
        ...(state.lastCorrection ? ['- 最近主控纠正：' + state.lastCorrection.message] : []),
        ...(state.wrapUpRequestedAt ? ['- 已提醒原子代理收尾：' + time(state.wrapUpRequestedAt)] : []),
        ...(state.checkpoint ? ['- 阶段结论（执行者提交，待核实）：' + state.checkpoint.summary,
          '- 执行者下一步：' + state.checkpoint.nextStep, '- 阶段工具证据：' + state.checkpoint.evidence.join('、')] : []))
    }
    if (task.error) lines.push('', '### 阻塞或失败原因', '', task.issue?.message || task.error)
    if (task.issue?.details) lines.push('- 原始错误：' + task.issue.details)
    if (task.issue?.action) lines.push('- 下一步：' + task.issue.action)
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
        '- 审查配置来源：' + (audit.modelRoute ? audit.modelRoute.source === 'dispatcher' ? '沿用本次执行的分发者模型记录' : audit.modelRoute.source === 'configured' ? '历史用户配置' : '历史审查启动时跟随主控' : '历史未记录'),
        ...(audit.error ? ['- 原因：' + (audit.issue?.message || audit.error)] : []),
        ...(audit.issue?.details ? ['- 原始错误：' + audit.issue.details] : []),
        ...(audit.issue?.action ? ['- 下一步：' + audit.issue.action] : []),
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
        '；证据：' + result.callId + (result.ref ? '；引用编号：' + result.ref : '') + (result.exitCode !== undefined ? '；退出码：' + result.exitCode : '') : '- 结果：尚未验证')
      if (result) lines.push('', result.summary || '（无文本输出）')
      if (result?.truncated) lines.push('- 上方仅为截断摘要；完整验证输出：' + result.outputPath)
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
  function verificationPath(plan, task, callId) {
    if (!/^delegation-check-[a-f0-9-]{36}$/.test(callId)) throw invalid('验证证据编号无效')
    return path.join(attach(plan).directory, 'verification', task.id, callId + '.txt')
  }
  async function writeVerification(plan, task, callId, output) {
    const target = verificationPath(plan, task, callId)
    await mkdir(path.dirname(target), { recursive: true })
    await replace(target, output)
    return target
  }
  async function readVerification(plan, task, evidence) {
    if (!evidence.outputPath) return evidence.summary ?? ''
    const expected = verificationPath(plan, task, evidence.callId)
    if (path.resolve(evidence.outputPath) !== path.resolve(expected)) throw invalid('完整验证输出路径与证据不匹配')
    return readFile(expected, 'utf8')
  }
  return { attach, write, history, read, reportPath, writeVerification, readVerification }
}
