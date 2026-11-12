/**
 * Client half of `@local/dsh-delegation-first`.
 *
 * Sidebar configuration and session-scoped task acceptance.
 * Config/state come from the Host API; model choices share DSH's model picker
 * catalog and its configuration-change notifications.
 *
 * Written without a build step: this file is loaded verbatim by the Harness
 * module loader, React comes from `require('react')`, and every element is
 * `React.createElement` (aliased `h`) — no JSX, no imports of `@deepseek-ai/*`.
 *
 * Styling is `--dsw-alias-*` theme tokens only, each with a literal fallback,
 * so the page follows the active light/dark theme without shipping a palette.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-delegation-first',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React

    const NS = 'dsh-delegation-first'
    /** One id for the sidebar row and the page it selects. */
    const PANEL_ID = 'dsh-delegation-first'
    const VIEW_ID = 'delegation-acceptance'
    /** Right after the Notes row (order 21). */
    const PANEL_ORDER = 22
    /** The panel is a live monitor: three seconds keeps it readable, not busy. */
    const POLL_MS = 3000
    /** The inline chat summary only polls while the latest reply has active state. */
    const CHAT_POLL_MS = 2000
    /** How long the "saved" confirmation stays on the button. */
    const SAVED_HOLD_MS = 2400

    const MODES = ['auto', 'strict', 'off', 'fixed']

    // -----------------------------------------------------------------------
    // Dictionaries — every visible string, Chinese first.
    // -----------------------------------------------------------------------

    const zh = {
      nav: 'DSH Agentrix',
      title: 'DSH Agentrix',
      subtitle: '设置自动委派的模式、子任务模型和资源上限。',
      'badge.on': '已启用',
      'badge.off': '已关闭',
      'config.title': '配置',
      'config.subtitle': '改完点保存立即生效，不需要重启 Harness。',
      'mode.label': '模式',
      'mode.auto': '自动判断难度',
      'mode.auto.hint': '主控结合上下文、任务范围和并行价值决定是否委派，并记录理由；小任务可直接完成。',
      'mode.strict': '严格（先派单）',
      'mode.strict.hint': '没派单的回合，一次动手都不许。',
      'mode.off': '关闭',
      'mode.off.hint': '不拦任何工具调用，闸门形同不存在；编排引擎仍可手动派单。',
      'mode.fixed': '固定预算',
      'mode.fixed.hint': '每轮固定 n 次动手额度，不要求先派单。',
      'budget.label': '动手预算',
      'budget.unit': '次',
      'budget.hint': '0–20 的整数。固定预算时必填；严格模式下不使用。',
      'budget.disabled': '严格模式下不留动手额度。',
      'locked.title': '由环境变量 DSH_DELEGATION_FIRST 锁定',
      'locked.hint': '面板只读。要改配置请改环境变量后重启 Harness。',
      'save.idle': '保存',
      'save.saving': '保存中…',
      'save.saved': '已保存',
      'save.failed': '保存失败',
      'save.needThreshold': '固定预算模式下请填 0–20 的整数。',
      'save.invalidThreshold': '预算必须是 0–20 的整数。',
      'state.title': '实时状态',
      'state.subtitle': '每 3 秒刷新。本轮操作与累计拦截分开统计；协作进度以任务计划为准。',
      'table.session': '会话',
      'table.difficulty': '本轮难度',
      'table.route': '自动路由',
      'table.direct': '本轮业务操作',
      'table.delegated': '本轮派发',
      'table.denied': '本轮拦截',
      'table.cumulative': '本次载入后累计 {count} 次', 'table.since': '统计起点',
      'last.managed-plan': '等待任务验收', 'last.delegate-first': '需要先委派',
      'last.threshold': '本轮操作额度已用尽', 'last.managed-dispatch': '请从任务卡派发',
      'table.last': '最近一次策略拦截',
      'role.coordinator': '主控',
      'role.worker': 'worker',
      'level.simple': '简单',
      'level.medium': '中等',
      'level.complex': '复杂',
      'difficulty.none': '尚未判定',
      'difficulty.score': '评分 {score}',
      'difficulty.noSignals': '无信号',
      'difficulty.signals': '信号：{signals}',
      'last.none': '—',
      'empty.title': '还没有会话触发过判定',
      'empty.body': '在主界面发一轮消息，这个会话的判定就会出现在这里。',
      'loading': '正在读取配置…',
      'error.load': '读取失败',
      'footer.refreshed': '最近刷新 {time}',
      'footer.never': '尚未刷新',
      'footer.refresh': '立即刷新',
      'footer.refreshing': '刷新中…',
      'footer.failed': '刷新失败：{error}',
      'file.label': '配置文件',
      'signal.volume': '体量较大',
      'signal.bullets': '多条并列要求',
      'signal.targets': '多目标',
      'signal.heavy': '重任务关键词',
      'signal.files': '涉及多个文件',
      'signal.light': '轻量提问',
    }

    const en = {
      nav: 'DSH Agentrix',
      title: 'DSH Agentrix',
      subtitle: 'Configure automatic delegation, worker models, and execution limits.',
      'badge.on': 'On',
      'badge.off': 'Off',
      'config.title': 'Configuration',
      'config.subtitle': 'Saved changes apply immediately; no Harness restart needed.',
      'mode.label': 'Mode',
      'mode.auto': 'Judge each turn',
      'mode.auto.hint': 'The coordinator decides from context, scope and parallel value, and records its reason. Small tasks can be completed directly.',
      'mode.strict': 'Strict (delegate first)',
      'mode.strict.hint': 'No hands-on call at all in a turn that has not delegated.',
      'mode.off': 'Off',
      'mode.off.hint': 'No tool call is gated.',
      'mode.fixed': 'Fixed budget',
      'mode.fixed.hint': 'n hands-on calls per turn, no delegation required first.',
      'budget.label': 'Budget',
      'budget.unit': 'calls',
      'budget.hint': 'Whole number, 0\u201320. Required for a fixed budget; unused in strict mode.',
      'budget.disabled': 'Strict mode leaves no hands-on budget.',
      'locked.title': 'Locked by the DSH_DELEGATION_FIRST environment variable',
      'locked.hint': 'This panel is read-only. Change the environment variable and restart Harness instead.',
      'save.idle': 'Save',
      'save.saving': 'Saving\u2026',
      'save.saved': 'Saved',
      'save.failed': 'Save failed',
      'save.needThreshold': 'A fixed budget needs a whole number from 0 to 20.',
      'save.invalidThreshold': 'The budget must be a whole number from 0 to 20.',
      'state.title': 'Live status',
      'state.subtitle': 'Refreshes every 3 seconds. Turn activity and cumulative interceptions are separate; progress comes from the task plan.',
      'table.session': 'Session',
      'table.difficulty': 'This turn',
      'table.route': 'Route',
      'table.direct': 'Operations this turn',
      'table.delegated': 'Dispatches this turn',
      'table.denied': 'Interceptions this turn',
      'table.cumulative': '{count} since loading', 'table.since': 'Counted since',
      'last.managed-plan': 'Awaiting task acceptance', 'last.delegate-first': 'Delegation required',
      'last.threshold': 'Turn operation budget reached', 'last.managed-dispatch': 'Use task-card dispatch',
      'table.last': 'Latest policy interception',
      'role.coordinator': 'coordinator',
      'role.worker': 'worker',
      'level.simple': 'Simple',
      'level.medium': 'Medium',
      'level.complex': 'Complex',
      'difficulty.none': 'Not judged yet',
      'difficulty.score': 'score {score}',
      'difficulty.noSignals': 'no signals',
      'difficulty.signals': 'signals: {signals}',
      'last.none': '\u2014',
      'empty.title': 'No session has been judged yet',
      'empty.body': 'Send one message in the main view and this session\u2019s judgement appears here.',
      'loading': 'Reading configuration\u2026',
      'error.load': 'Could not load',
      'footer.refreshed': 'Last refreshed {time}',
      'footer.never': 'Not refreshed yet',
      'footer.refresh': 'Refresh now',
      'footer.refreshing': 'Refreshing\u2026',
      'footer.failed': 'Refresh failed: {error}',
      'file.label': 'Config file',
      'signal.volume': 'long input',
      'signal.bullets': 'bulleted requirements',
      'signal.targets': 'multiple goals',
      'signal.heavy': 'heavy-task keywords',
      'signal.files': 'touches several files',
      'signal.light': 'light question',
    }

    /**
     * Host signals are Chinese phrases (the scorer emits them verbatim). The
     * page translates the ones it knows and shows anything else as sent, so a
     * new signal from a future Host version is visible rather than blank.
     */
    const SIGNAL_KEYS = {
      '体量较大': 'signal.volume',
      '多条并列要求': 'signal.bullets',
      '多目标': 'signal.targets',
      '重任务关键词': 'signal.heavy',
      '涉及多个文件': 'signal.files',
      '轻量提问': 'signal.light',
    }

    const fill = (template, values) =>
      String(template).replace(/\{(\w+)\}/g, (_, key) => String(values?.[key] ?? ''))

    // -----------------------------------------------------------------------
    // Host access
    // -----------------------------------------------------------------------

    /** Resolve a Host route against the directory the page is served from. */
    function api(pathname) {
      const relative = String(pathname).replace(/^\/+/, '')
      if (typeof document === 'undefined') return `/${relative}`
      const url = new URL(relative, document.baseURI)
      return url.pathname + url.search
    }

    async function getJson(pathname, signal) {
      const response = await fetch(api(pathname), { cache: 'no-store', signal: signal ?? AbortSignal.timeout(8000) })
      let body
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      if (!response.ok || body?.ok !== true) {
        throw Object.assign(new Error(body?.error ?? `HTTP ${response.status}`), { status: response.status })
      }
      return body
    }

    /**
     * Save the setting.
     *
     * A rejected save still carries the Host's own Chinese explanation, so the
     * body is read before the status is judged: the panel shows that text
     * verbatim instead of inventing its own wording for a 400 or a 409.
     */
    async function postConfig(patch) {
      const response = await fetch(api('dsh-delegation-first/api/config'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
        signal: AbortSignal.timeout(8000),
      })
      let body
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      if (!response.ok || body?.ok !== true) {
        throw Object.assign(new Error(body?.error ?? `HTTP ${response.status}`), { status: response.status, config: body, code: body?.code })
      }
      return body
    }

    const getConfig = signal => getJson('dsh-delegation-first/api/config', signal)
    const getState = async (signal, sessionId) => {
      const data = await getJson('dsh-delegation-first/api/state?sessionId=' + encodeURIComponent(sessionId), signal)
      // An already-running Host may still return the older global response after the client reloads.
      const legacyHost = !Object.hasOwn(data, 'sessionId')
      if (!legacyHost && data.sessionId !== sessionId) {
        throw new Error('返回的记录与当前会话不一致，已停止显示。请重新读取。')
      }
      if (!Array.isArray(data.plans) || !Array.isArray(data.sessions)) {
        throw new Error('返回的数据缺少任务记录。请重新加载“DSH Agentrix”插件后重试。')
      }
      return { ...data, sessionId, legacyHost,
        plans: data.plans.filter(plan => plan.sessionId === sessionId),
        sessions: data.sessions.filter(session => session.sessionId === sessionId),
        archiveWarning: legacyHost ? null : data.archiveWarning }
    }

    function currentPlanOf(data, sessionId) {
      const plan = data?.plans?.find(item => item.sessionId === sessionId)
      const source = data?.sessions?.find(item => item.sessionId === sessionId)?.source
      return source?.messageId && source.messageId !== plan?.source?.messageId ? null : plan
    }

    Object.assign(zh, {
      'limits.title': '执行限制', 'limits.maxParallel': '全局同时执行', 'limits.maxAttempts': '每任务最多执行',
      'limits.maxActivations': '每个计划最多派发', 'limits.maxActivationsHint': '首次派发、返工和独立审查都计入；达到上限后停止自动开新子 Agent。', 'limits.taskTimeoutMinutes': '运行时间提醒（分钟）', 'models.title': '子任务模型',
      'models.routine': '普通执行任务', 'models.complex': '设计与复杂问题',
      'models.hint': '执行模型从 DSH 已配置列表选择；审查自动使用任务分发时的主控模型记录。运行中的任务保持原模型。',
      'models.reasoningEffort': '思考强度（可选）',
      'models.choose': '模型', 'models.defaultEffort': '使用模型默认值',
      'models.refresh': '刷新已配置模型', 'models.loading': '正在读取已配置模型…',
      'models.empty': '暂无可用模型，请先在 DSH「设置 → 模型」中配置，然后刷新。', 'models.unavailable': '当前不可用',
      'models.invalid': '{tier}不可用', 'models.invalidHint': '当前执行模型选择已失效，请重新选择并保存。',
      'models.invalidEffort': '当前模型不支持已选的思考强度，请重新选择或使用模型默认值。',
      'models.sameModel': '选择 {provider} 下的同一模型', 'models.saveHint': '调整后请点击“保存”；保存前仍使用原配置。',
      'models.notLoaded': '尚未确认', 'nav.modelInvalid': '模型不可用',
      'reminder.title': '子任务暂时无法启动', 'reminder.body': '{tiers}未配置或当前不可用。重新选择并保存后，主 Agent 才能继续派单。',
      'reminder.dismiss': '稍后处理',
      'plans.title': '任务与验收', 'plans.empty': '尚无任务计划。复杂工作开始后，主 Agent 会提交任务卡，进度显示在这里。',
      'plans.progress': '已验收 {accepted} / {total}', 'plans.model': '派单模型', 'plans.inherited': '继承主 Agent',
      'plans.dependencies': '依赖', 'plans.outputs': '交付物', 'plans.criteria': '验收标准', 'plans.checks': '主控验证',
      'plans.report': '子 Agent 报告', 'plans.review': '主控验收记录', 'plans.activity': '最近活动',
      'audit.title': '独立审查', 'audit.queued': '等待审查名额', 'audit.starting': '正在启动', 'audit.running': '进行中', 'audit.completed': '审查已返回',
      'audit.failed': '审查失败', 'audit.blocked': '审查已暂停', 'audit.cancelled': '审查已停止',
      'audit.pass': '通过', 'audit.fail': '未通过', 'audit.verdicts': '需求：{spec} · 质量：{quality}', 'audit.model': '审查模型',
      'audit.nextRunning': '独立审查进行中；主控可运行实际验证，等待两个结论后验收。',
      'audit.nextRetry': '主控处理原因后明确重试审查；不会自动重开。', 'audit.nextRework': '主控按具体问题返工，复查只检查原问题及修复引入的回归。',
      'audit.open': '待解决', 'audit.addressed': '已解决', 'audit.deferred': '可选建议',
      'execution.DONE': '执行完成，等待验收', 'execution.DONE_WITH_CONCERNS': '完成但有疑点，待主控处理',
      'execution.NEEDS_CONTEXT': '缺少上下文，已暂停', 'execution.BLOCKED': '执行受阻，已暂停', 'execution.report': '完整报告',
      'chat.auditCount': '审查中 {count}', 'chat.auditQueuedCount': '等待审查 {count}',
      'plans.recent': '最近进展', 'plans.blockers': '需要处理',
      'view.tab': '任务验收', 'view.hint': '打开需要查看的会话，在“任务验收”页签核对当前需求；协作过程看 Fleet，整理与导出用“分享会话”。',
      'view.empty': '本会话还没有托管任务。主 Agent 建立计划后，这里会显示需求、进度和验收结果。',
      'view.noSession': '请先打开一个会话，再查看任务验收。', 'view.request': '本次需求', 'view.unknownSource': '历史计划未保存原始需求，请回到聊天核对。',
      'view.project': '项目', 'view.noProject': '未提供项目目录', 'view.session': '会话', 'view.currentSession': '当前会话',
      'view.returned': '结果已返回 {returned} / {total}', 'view.accepted': '已验收 {accepted} / {total}',
      'view.next': '下一步', 'view.reviewNext': '主 Agent 运行验证并逐条验收。',
      'view.runningNext': '子 Agent 执行中，主 Agent 负责监督进度。', 'view.startNext': '主 Agent 启动已建立的计划。',
      'view.failedNext': '主 Agent 核对失败原因，处理后决定重试或停止。', 'view.configNext': '你需要调整并保存模型配置，再让主 Agent 继续。',
      'view.recoveredNext': '主 Agent 先清理重新加载前的子任务，再决定是否重试。',
      'view.doneNext': '主 Agent 已完成全部验收，最终结论见聊天。', 'view.stoppedNext': '计划已停止，主 Agent 在聊天说明未完成项。',
      'view.details': '查看验收详情', 'view.source': '原始需求与计划信息', 'view.message': '原始消息编号', 'view.goal': '计划目标',
      'view.fleet': '查看协作过程', 'view.share': '整理与导出', 'view.chat': '回到聊天',
      'view.boardRequest': '本次需求', 'view.boardStatus': '计划状态', 'view.boardTasks': '任务列表',
      'view.boardProgress': '总体进度', 'view.boardReturned': '已返回', 'view.boardAccepted': '已验收',
      'view.boardRunning': '执行中', 'view.boardWaiting': '等待中', 'view.boardAttempts': '派发尝试',
      'view.boardFailed': '有失败', 'view.boardReview': '待验收', 'view.boardDone': '已完成',
      'view.boardTaskCount': '共 {count} 项', 'view.boardUnfinished': '未完成任务：{tasks}',
      'view.boardDependency': '等待前置任务验收：{tasks}',
      'view.boardActivity': '当前进展', 'view.boardReason': '原因', 'view.boardNext': '下一步',
      'view.boardDetails': '查看任务详情', 'view.boardHideDetails': '收起任务详情',
      'view.boardAffected': '受影响', 'view.boardRootCause': '根因', 'view.boardNoActivity': '暂无进展',
      'view.boardNoReason': '记录中未提供具体原因', 'view.boardNoPlan': '当前没有托管子代理计划。',
      'view.boardNoPlanHint': '规则分级只提供建议，不会自动派单。上方的直接操作和派发次数反映本轮已记录的实际情况；没有托管计划时，不会有子代理进度或验收记录。',
      'view.unavailable': '对应页签未启用，可在 DSH 插件设置中检查。', 'view.diagnostics': '查看本会话的判断依据',
      'view.unknownError': '执行失败，旧记录未保存具体原因。请到 Fleet 或聊天核对原始错误。',
      'view.archiveWarning': '辅助记录提示',
      'view.loading': '正在读取本会话的任务…',
      'view.loadTitle': '暂时无法显示任务状态',
      'view.loadHint': '当前会话的需求、进度和验收结果尚未读到。可以重试，或回到聊天查看执行情况。',
      'view.staleTitle': '任务状态尚未更新', 'view.staleHint': '下方保留上次读取的结果，最新进度请到聊天确认。',
      'view.retry': '重新读取', 'view.retrying': '正在读取…', 'view.loadDetails': '查看原因',
      'view.lastRead': '上次读取 {time}',
      'view.footNote': '会话验收页每 3 秒只读取当前会话状态。',
      'view.coordinator': '主控 · 当前会话', 'view.returnedLabel': '结果已返回',
      'view.statAccepted': '已验收', 'view.statAttempts': '启动尝试', 'view.remaining': '剩余 {count}',
      'view.legacyHost': '插件服务仍在使用旧版，已筛选当前会话的记录。重新加载“DSH Agentrix”后可启用新版需求关联。',
      'plans.waiting': '等待主控验证与评审', 'plans.unverified': '尚未验证', 'plans.passed': '通过', 'plans.failed': '失败或结果不明确',
      'plans.configured': '用户配置', 'plans.observed': '已读取子 Agent 实际配置',
      'plans.notStarted': '尚未启动', 'plans.configPaused': '等待调整模型', 'plans.fixModel': '去调整模型',
      'plans.configHint': '本次派单未启动，不消耗执行次数。调整模型并保存后，再让主 Agent 继续。', 'plans.technical': '技术详情',
      'plans.autoPaused': '检测到子任务失败或阻塞，后续自动派单已暂停。主 Agent 处理失败原因后才能继续。',
      'plans.dispatchWaiting': '正在等待：',
      'plans.historyNote': '已结束的子 Agent 会保留为历史记录，运行资源已释放，不会继续执行。',
      'plans.childReleased': '子 Agent 已关闭，历史记录保留用于验收。',
      'plans.childDrained': '子 Agent 已通过清理接口释放。',
      'plans.childReleaseFailed': '子 Agent 清理失败：{error}',
      'plans.route': '自动路由', 'plans.route.direct': '直接执行', 'plans.route.delegate': '委派 1 个子 Agent',
      'plans.route.delegate_parallel': '并行委派多个子 Agent', 'plans.routeReasons': '判断依据：{reasons}',
      'plans.routeEstimate': '预计 {steps} 步 · {parallel} 个并行任务 · 置信度 {confidence}%',
      'plans.activationBudget': '启动尝试：{used} / {limit}，剩余 {remaining}',
      'plans.modelUnknown': '历史未记录', 'plans.modelPending': '尚未请求', 'plans.modelVerified': '实际请求已核对',
      'plans.modelMismatch': '错配请求已阻止', 'plans.modelExpected': '配置模型', 'plans.modelActual': '实际请求模型',
      'plans.modelReason': '复杂度依据', 'plans.modelSource': '配置来源', 'plans.modelReasonUnknown': '未记录',
      'plans.modelSourceConfigured': '用户配置', 'plans.modelSourceInherited': '启动时继承主 Agent',
      'chat.waitingCount': '等待 {count}', 'chat.reviewCount': '待验收 {count}', 'chat.failedCount': '失败 {count}', 'chat.blockedCount': '阻塞 {count}',
      'plans.routeWarnings': '路由提醒：{warnings}', 'plans.taskComplexity': '任务复杂度：{complexity}',
      'chat.routeDecision': '自动判断：{route}', 'chat.planSummary': '{status} · 已验收 {done}/{total}',
      'chat.activeSummary': '进行中 {running} · 已完成 {done}/{total}', 'chat.completedSummary': '已完成 {done}/{total}',
      'chat.navigationUnavailable': '当前版本无法从此处打开，请切换到会话的“任务验收”页签。',
      'chat.stopped': '已停止', 'chat.issueTask': '任务', 'chat.issueReason': '原因',
      'chat.unknownReason': '记录中未提供具体原因。', 'chat.unknownTask': '记录中未提供任务名称',
      'chat.stoppedNext': '如需继续，请让主 Agent 重新安排未完成的任务。',
      'chat.recoveredReason': '插件重新加载，旧子任务需要先清理。',
      'chat.affected': '共 {count} 项任务受影响，完整记录见任务验收。',
      'chat.noPlan': '未启动子代理，由主控判断是否委派', 'chat.reason': '依据：{reasons}', 'chat.budget': '启动尝试 {used}/{limit}',
      'chat.details': '查看任务进度', 'chat.running': '进行中', 'chat.waiting': '等待中', 'chat.review': '待验收',
      'chat.completed': '已完成', 'chat.failed': '有失败', 'chat.blocked': '已阻塞', 'chat.direct': '直接执行 · 未启动子代理',
      'chat.taskStatus': '{title} · {status}', 'chat.lastActivity': '最近活动：{value}', 'chat.waitReason': '等待：{value}',
      'chat.syncing': '同步中…', 'chat.unavailable': '暂时无法读取任务状态',
      'status.queued': '待派单', 'status.starting': '正在派单', 'status.running': '执行中', 'status.review': '待主 Agent 验收',
      'status.accepted': '已验收', 'status.failed': '执行失败', 'status.blocked': '已阻塞', 'status.cancelled': '已停止', 'status.planned': '计划已建立',
      'signal.features': '多个功能点',
    })
    Object.assign(en, {
      'limits.title': 'Execution limits', 'limits.maxParallel': 'Concurrent tasks across conversations', 'limits.maxAttempts': 'Maximum attempts per task',
      'limits.maxActivations': 'Maximum dispatches per plan', 'limits.maxActivationsHint': 'Counts first runs, retries and independent reviews; no new agent starts after the limit.',
      'limits.taskTimeoutMinutes': 'Elapsed-time reminder (minutes)', 'models.title': 'Worker models',
      'models.routine': 'Routine execution', 'models.complex': 'Design and difficult work',
      'models.hint': 'Select execution from the DSH catalog. Review uses the coordinator recorded at dispatch; running tasks keep their model.',
      'models.reasoningEffort': 'Reasoning effort (optional)',
      'models.choose': 'model', 'models.defaultEffort': 'Model default',
      'models.refresh': 'Refresh configured models', 'models.loading': 'Loading configured models…',
      'models.empty': 'No models available. Configure a model in DSH Settings → Models, then refresh.', 'models.unavailable': 'Unavailable',
      'models.invalid': '{tier} unavailable', 'models.invalidHint': 'This execution model is unavailable. Choose a current model and save.',
      'models.invalidEffort': 'The model does not support the saved reasoning effort. Choose a supported effort or use the default.',
      'models.sameModel': 'Select the same model under {provider}', 'models.saveHint': 'Click Save after changing the choice. The saved configuration stays active until then.',
      'models.notLoaded': 'Not confirmed yet', 'nav.modelInvalid': 'Model unavailable',
      'reminder.title': 'Worker tasks cannot start', 'reminder.body': 'The model configuration for {tiers} is unavailable. Select and save a valid model before the coordinator can dispatch tasks.',
      'reminder.dismiss': 'Later',
      'plans.title': 'Tasks and acceptance', 'plans.empty': 'No task plans yet. The coordinator submits task cards when substantial work begins.',
      'plans.progress': 'Accepted {accepted} / {total}', 'plans.model': 'Worker model', 'plans.inherited': 'Inherited from coordinator',
      'plans.dependencies': 'Dependencies', 'plans.outputs': 'Deliverables', 'plans.criteria': 'Acceptance criteria', 'plans.checks': 'Coordinator verification',
      'plans.report': 'Worker report', 'plans.review': 'Coordinator review', 'plans.activity': 'Last activity',
      'audit.title': 'Independent review', 'audit.queued': 'Waiting for review capacity', 'audit.starting': 'Starting', 'audit.running': 'In progress', 'audit.completed': 'Review returned',
      'audit.failed': 'Review failed', 'audit.blocked': 'Review paused', 'audit.cancelled': 'Review stopped',
      'audit.pass': 'Passed', 'audit.fail': 'Not passed', 'audit.verdicts': 'Requirements: {spec} · Quality: {quality}', 'audit.model': 'Reviewer model',
      'audit.nextRunning': 'Review in progress; the coordinator can run checks and must wait for both verdicts.',
      'audit.nextRetry': 'Resolve the cause, then explicitly retry the review. No automatic restart.', 'audit.nextRework': 'Fix concrete findings; re-review covers those findings and regressions introduced by the fix.',
      'audit.open': 'Open', 'audit.addressed': 'Addressed', 'audit.deferred': 'Optional suggestion',
      'execution.DONE': 'Work returned; awaiting acceptance', 'execution.DONE_WITH_CONCERNS': 'Completed with concerns; coordinator ruling required',
      'execution.NEEDS_CONTEXT': 'Context required; paused', 'execution.BLOCKED': 'Blocked; paused', 'execution.report': 'Full report',
      'chat.auditCount': 'Reviewing {count}', 'chat.auditQueuedCount': 'Waiting for review {count}',
      'plans.recent': 'Recent progress', 'plans.blockers': 'Needs attention',
      'view.tab': 'Task acceptance', 'view.hint': 'Open a conversation and use Task acceptance to check its request and results. Use Fleet for collaboration and Share for exports.',
      'view.empty': 'No managed tasks in this conversation yet. A coordinator plan will show its request, progress, and acceptance here.',
      'view.noSession': 'Open a conversation to view its acceptance.', 'view.request': 'Current request', 'view.unknownSource': 'This older plan has no saved original request. Check the conversation.',
      'view.project': 'Project', 'view.noProject': 'No project directory', 'view.session': 'Conversation', 'view.currentSession': 'Current conversation',
      'view.returned': 'Results returned {returned} / {total}', 'view.accepted': 'Accepted {accepted} / {total}',
      'view.next': 'Next', 'view.reviewNext': 'The coordinator runs verification and reviews each acceptance criterion.',
      'view.runningNext': 'Workers are executing. The coordinator supervises their progress.', 'view.startNext': 'The coordinator starts the plan.',
      'view.failedNext': 'The coordinator checks the failure, resolves its cause, and decides whether to retry or stop.',
      'view.configNext': 'Select and save a valid worker model, then ask the coordinator to continue.',
      'view.recoveredNext': 'The coordinator cleans up workers from before the reload before deciding whether to retry.',
      'view.doneNext': 'The coordinator accepted all tasks. See the conversation for the final conclusion.', 'view.stoppedNext': 'The plan was stopped. The coordinator reports unfinished work in the conversation.',
      'view.details': 'View acceptance details', 'view.source': 'Original request and plan', 'view.message': 'Source message ID', 'view.goal': 'Plan goal',
      'view.fleet': 'View collaboration', 'view.share': 'Summarize and export', 'view.chat': 'Back to chat',
      'view.boardRequest': 'Current request', 'view.boardStatus': 'Plan status', 'view.boardTasks': 'Tasks',
      'view.boardProgress': 'Overall progress', 'view.boardReturned': 'Returned', 'view.boardAccepted': 'Accepted',
      'view.boardRunning': 'Running', 'view.boardWaiting': 'Waiting', 'view.boardAttempts': 'Dispatch attempts',
      'view.boardFailed': 'Has failures', 'view.boardReview': 'Awaiting acceptance', 'view.boardDone': 'Completed',
      'view.boardTaskCount': '{count} tasks', 'view.boardUnfinished': 'Unfinished tasks: {tasks}',
      'view.boardDependency': 'Awaiting dependency acceptance: {tasks}',
      'view.boardActivity': 'Current activity', 'view.boardReason': 'Reason', 'view.boardNext': 'Next step',
      'view.boardDetails': 'View task details', 'view.boardHideDetails': 'Hide task details',
      'view.boardAffected': 'Affected', 'view.boardRootCause': 'Root cause', 'view.boardNoActivity': 'No activity recorded',
      'view.boardNoReason': 'No specific reason was recorded', 'view.boardNoPlan': 'No managed child-agent plan exists.',
      'view.boardNoPlanHint': 'Rule-based difficulty is advice and does not dispatch agents. The direct-action and dispatch counts above show recorded activity; without a managed plan, there is no child-agent progress or acceptance record.',
      'view.unavailable': 'This view is not enabled. Check DSH plugin settings.', 'view.diagnostics': 'View this conversation’s difficulty assessment',
      'view.unknownError': 'Execution failed. This older record has no detailed cause. Check Fleet or the conversation for the original error.',
      'view.archiveWarning': 'Supporting record warning',
      'view.loading': 'Reading this conversation’s tasks…',
      'view.loadTitle': 'Task status is temporarily unavailable',
      'view.loadHint': 'This conversation’s request, progress, and acceptance could not be loaded. Retry or check execution in the chat.',
      'view.staleTitle': 'Task status has not updated', 'view.staleHint': 'The last successful result is shown below. Check the chat for the latest progress.',
      'view.retry': 'Retry', 'view.retrying': 'Reading…', 'view.loadDetails': 'View reason',
      'view.lastRead': 'Last read {time}',
      'view.footNote': 'This acceptance view reads only the current conversation, every 3 seconds.',
      'view.coordinator': 'Coordinator · this conversation', 'view.returnedLabel': 'Results returned',
      'view.statAccepted': 'Accepted', 'view.statAttempts': 'Startup attempts', 'view.remaining': '{count} left',
      'view.legacyHost': 'An older plugin service is running. Records have been filtered to this conversation. Reload DSH Agentrix to enable original request tracking.',
      'plans.waiting': 'Awaiting coordinator verification and review', 'plans.unverified': 'Not verified', 'plans.passed': 'Passed', 'plans.failed': 'Failed or inconclusive',
      'plans.configured': 'Configured route', 'plans.observed': 'Observed child configuration',
      'plans.notStarted': 'Not started', 'plans.configPaused': 'Model selection required', 'plans.fixModel': 'Adjust model',
      'plans.configHint': 'Dispatch has not started and no attempt was spent. Select and save a valid model, then ask the coordinator to continue.', 'plans.technical': 'Technical details',
      'plans.autoPaused': 'A child task failed or is blocked, so automatic dispatch is paused. The coordinator must handle the cause before continuing.',
      'plans.dispatchWaiting': 'Waiting: ',
      'plans.historyNote': 'Finished child agents remain as history for acceptance; their runtime resources have been released.',
      'plans.childReleased': 'Child agent closed; its history is retained for acceptance.',
      'plans.childDrained': 'Child agent released through the cleanup fallback.',
      'plans.childReleaseFailed': 'Child cleanup failed: {error}',
      'plans.route': 'Automatic route', 'plans.route.direct': 'Direct execution', 'plans.route.delegate': 'Delegate to one worker',
      'plans.route.delegate_parallel': 'Delegate to parallel workers', 'plans.routeReasons': 'Reasons: {reasons}',
      'plans.routeEstimate': 'Estimated {steps} steps · {parallel} parallel tasks · {confidence}% confidence',
      'plans.activationBudget': 'Startup attempts: {used} / {limit}, {remaining} remaining',
      'plans.modelUnknown': 'Not recorded', 'plans.modelPending': 'No request yet', 'plans.modelVerified': 'Request verified',
      'plans.modelMismatch': 'Mismatched request blocked', 'plans.modelExpected': 'Configured model', 'plans.modelActual': 'Actual request model',
      'plans.modelReason': 'Complexity reason', 'plans.modelSource': 'Route source', 'plans.modelReasonUnknown': 'Not recorded',
      'plans.modelSourceConfigured': 'User configuration', 'plans.modelSourceInherited': 'Inherited at startup',
      'chat.waitingCount': '{count} waiting', 'chat.reviewCount': '{count} awaiting review', 'chat.failedCount': '{count} failed', 'chat.blockedCount': '{count} blocked',
      'plans.routeWarnings': 'Routing note: {warnings}', 'plans.taskComplexity': 'Task complexity: {complexity}',
      'chat.routeDecision': 'Automatic decision: {route}', 'chat.planSummary': '{status} · {done}/{total} accepted',
      'chat.activeSummary': '{running} running · {done}/{total} completed', 'chat.completedSummary': '{done}/{total} completed',
      'chat.navigationUnavailable': 'This version cannot open the view here. Select Task acceptance in this conversation.',
      'chat.stopped': 'stopped', 'chat.issueTask': 'Task', 'chat.issueReason': 'Reason',
      'chat.unknownReason': 'No specific reason was recorded.', 'chat.unknownTask': 'No task name was recorded',
      'chat.stoppedNext': 'To continue, ask the coordinator to make a new plan for the unfinished tasks.',
      'chat.recoveredReason': 'The plugin reloaded. Previous workers need cleanup first.',
      'chat.affected': '{count} tasks are affected. See Task acceptance for the complete record.',
      'chat.noPlan': 'No worker started; coordinator decides whether to delegate', 'chat.reason': 'Reasons: {reasons}',
      'chat.budget': 'Startup attempts {used}/{limit}', 'chat.details': 'View task progress', 'chat.running': 'running',
      'chat.waiting': 'waiting', 'chat.review': 'awaiting review', 'chat.completed': 'completed', 'chat.failed': 'failed',
      'chat.blocked': 'blocked', 'chat.direct': 'direct execution; no worker started', 'chat.taskStatus': '{title} · {status}',
      'chat.lastActivity': 'Last activity: {value}', 'chat.waitReason': 'Waiting: {value}', 'chat.syncing': 'Syncing…',
      'chat.unavailable': 'Task status is temporarily unavailable',
      'status.queued': 'Queued', 'status.starting': 'Starting', 'status.running': 'Running', 'status.review': 'Awaiting coordinator acceptance',
      'status.accepted': 'Accepted', 'status.failed': 'Failed', 'status.blocked': 'Blocked', 'status.cancelled': 'Stopped', 'status.planned': 'Planned',
      'signal.features': 'multiple features',
    })
    SIGNAL_KEYS['多个功能点'] = 'signal.features'

    const ROUTE_REASON_KEYS = {
      scope_small: 'routeReason.scopeSmall', medium_complexity: 'routeReason.medium', high_complexity: 'routeReason.high',
      multiple_goals: 'routeReason.goals', multiple_files: 'routeReason.files', heavy_work: 'routeReason.heavy',
      multiple_features: 'routeReason.features', implementation: 'routeReason.implementation',
      parallel_candidates: 'routeReason.parallel', context_only: 'routeReason.context',
    }
    Object.assign(zh, {
      'routeReason.scopeSmall': '范围明确且规模较小', 'routeReason.medium': '复杂度达到中等', 'routeReason.high': '复杂度达到高位',
      'routeReason.goals': '存在多个目标或并列要求', 'routeReason.files': '涉及多个文件', 'routeReason.heavy': '包含重任务关键词',
      'routeReason.features': '包含多个功能点', 'routeReason.implementation': '需要实施或评审',
      'routeReason.parallel': '任务可能独立，可并行派发', 'routeReason.context': '当前未形成明确实施目标',
    })
    Object.assign(en, {
      'routeReason.scopeSmall': 'the scope is small and explicit', 'routeReason.medium': 'medium complexity', 'routeReason.high': 'high complexity',
      'routeReason.goals': 'multiple goals or parallel requirements', 'routeReason.files': 'several files are involved', 'routeReason.heavy': 'heavy-task keywords',
      'routeReason.features': 'multiple features', 'routeReason.implementation': 'implementation or review is required',
      'routeReason.parallel': 'tasks may be independent and parallel', 'routeReason.context': 'no concrete implementation goal yet',
    })

    Object.assign(zh, {
      'completion.title': '交付回执', 'completion.completed': '已完成', 'completion.cancelled': '已停止，未验收',
      'models.worker': '执行模型', 'models.reviewer': '审查模型', 'models.workerUnset': '未配置（选择后才能派发）',
      'models.clear': '清除失效选择', 'models.missing': '执行模型尚未配置，请选择并保存；不会自动继承主控模型。',
      'cfg.modelRoles': '主控使用对话框选择的模型，负责拆分和最终验收。只需选择执行模型；独立审查自动沿用任务分发时记录的主控模型和思考强度，使用独立上下文。复杂度不改变执行模型。',
      'cfg.modelHintWorker': '普通和复杂任务均使用执行模型。未选择时暂停派发，不继承主控模型。',
      'cfg.modelHintReviewer': '无需配置。每次派发任务时固定主控模型和思考强度，后续审查使用该记录；中途切换聊天模型不改变已派任务。',
      'cfg.reviewAutomatic': '审查模型 · 自动使用分发者模型',
      'cfg.oldReviewPolicy': '当前服务尚未载入自动审查选模，配置暂不可保存；等待宿主自然重载后生效。',
      'plans.modelSourceDispatcher': '本次执行的分发者模型记录', 'plans.reviewSnapshot': '审查沿用主控模型',
      'plans.reviewLegacySnapshot': '旧任务缺少分发快照，采用首次审查时的主控模型',
      'cfg.oldModelRouting': '运行中的插件尚未载入按角色分配模型，新配置暂不可保存。请等待插件自然重载；当前仍按旧规则执行。',
      'completion.blocked': '尚未完成，已阻塞', 'completion.partial': '部分完成，其余尚未验收', 'completion.partialStopped': '部分完成，其余已停止',
      'completion.accepted': '已验收 {done}/{total}', 'completion.id': '回执编号', 'completion.deliverables': '已验收交付物',
      'delivery.title': '交付结果', 'delivery.pending': '任务已验收，正在发送结果', 'delivery.failed': '交付消息发送失败，验收结果已保留',
      'delivery.failedHint': '可继续本会话补发结果，无需重新执行子任务。', 'delivery.preview': '这里展示正文预览；完整内容请打开文件。',
      'delivery.readFailed': '正文暂未能读取，请打开交付文件核对：',
      'completion.evidence': '验证证据', 'completion.remaining': '未完成项', 'completion.reason': '原因',
      'completion.next': '最终交付结论与未完成项以程序回执为准。', 'completion.blockedNext': '处理失败原因后，让主 Agent 明确重试；当前回执不会自动继续。',
      'completion.blockedAttempts': '该任务已达到每任务执行次数上限（{limit} 次）。请在 DSH Agentrix 提高“每任务最多执行”后，再让主 Agent 明确重试；也可以新建计划。',
      'completion.cancelledNext': '计划已停止。如需继续，请让主 Agent 新建计划。',
      'completion.stopSource': '取消来源', 'completion.stopTime': '取消时间',
      'completion.source.coordinator': '主控', 'completion.source.host': '用户或宿主',
      'chat.receiptPending': '验收通过，回执生成中', 'chat.partial': '部分完成',
      'chat.acceptedSummary': '{status} · 已验收 {done}/{total}', 'chat.activeAcceptedSummary': '进行中 {running} · 已验收 {done}/{total}',
    })
    Object.assign(en, {
      'completion.title': 'Delivery receipt', 'completion.completed': 'Completed', 'completion.cancelled': 'Stopped, not accepted',
      'models.worker': 'Execution model', 'models.reviewer': 'Review model', 'models.workerUnset': 'Not configured (required to dispatch)',
      'models.clear': 'Clear unavailable selection', 'models.missing': 'Choose and save an execution model. Workers will not inherit the coordinator model.',
      'cfg.modelRoles': 'The coordinator uses the conversation model for planning and acceptance. Select only an execution model. Independent review uses the coordinator model and reasoning effort recorded at task dispatch in a separate context.',
      'cfg.modelHintWorker': 'Routine and complex tasks use this execution model. Dispatch pauses if it is unset.',
      'cfg.modelHintReviewer': 'No configuration needed. Each dispatch pins the coordinator model and reasoning effort for later review. Changing the chat model does not alter dispatched tasks.',
      'cfg.reviewAutomatic': 'Review model · Automatically uses dispatcher model',
      'cfg.oldReviewPolicy': 'Automatic review selection is not loaded. Saving is disabled until natural host reload.',
      'plans.modelSourceDispatcher': 'Dispatcher model recorded for this attempt', 'plans.reviewSnapshot': 'Review uses coordinator model',
      'plans.reviewLegacySnapshot': 'Legacy task has no dispatch snapshot; coordinator recorded at first review',
      'cfg.oldModelRouting': 'The running plugin still uses legacy model routing. Saving is disabled until the plugin reloads naturally.',
      'completion.blocked': 'Incomplete, blocked', 'completion.partial': 'Partially completed, remaining work not accepted', 'completion.partialStopped': 'Partially completed, remaining work stopped',
      'completion.accepted': '{done}/{total} accepted', 'completion.id': 'Receipt ID', 'completion.deliverables': 'Accepted deliverables',
      'delivery.title': 'Delivered result', 'delivery.pending': 'Accepted, sending the result', 'delivery.failed': 'Result delivery failed; acceptance is preserved',
      'delivery.failedHint': 'Continue this conversation to resend the result without rerunning subtasks.', 'delivery.preview': 'This is an inline preview. Open the file for the complete content.',
      'delivery.readFailed': 'Inline content could not be read. Check the deliverable file: ',
      'completion.evidence': 'Verification evidence', 'completion.remaining': 'Unfinished work', 'completion.reason': 'Reason',
      'completion.next': 'The program receipt records the final delivery outcome and unfinished work.', 'completion.blockedNext': 'Resolve the cause, then ask the coordinator to retry explicitly; this receipt will not continue automatically.',
      'completion.blockedAttempts': 'This task reached the per-task attempt limit ({limit}). Increase Maximum attempts in DSH Agentrix, then ask the coordinator to retry explicitly, or create a new plan.',
      'completion.cancelledNext': 'The plan was stopped. Ask the coordinator to create a new plan if you want to continue.',
      'completion.stopSource': 'Cancellation source', 'completion.stopTime': 'Cancelled at',
      'completion.source.coordinator': 'Coordinator', 'completion.source.host': 'User or host',
      'chat.receiptPending': 'Accepted, generating receipt', 'chat.partial': 'Partially completed',
      'chat.acceptedSummary': '{status} · {done}/{total} accepted', 'chat.activeAcceptedSummary': '{running} running · {done}/{total} accepted',
    })

    const CONFIG_TABS = ['policy', 'limits', 'models', 'diagnostics']
    Object.assign(zh, {
      'supervision.title': '过程监督', 'supervision.waiting': '等待主控纠偏', 'supervision.count': '待主控纠偏 {count} 项',
      'supervision.elapsed': '已执行 {minutes} 分钟', 'supervision.corrections': '主控纠偏 {used}/{limit}',
      'supervision.budget': '模型调用 {requests}/{requestLimit} · 输出 {output}/{outputLimit} Token',
      'supervision.usage': '模型调用 {requests} · 输出 {output} Token（本次执行统计，不设插件上限）',
      'supervision.context': '最近请求上下文 {tokens} Token', 'supervision.stage': '阶段结论（执行者提交，待核实）',
      'supervision.nextStep': '执行者下一步', 'supervision.corrected': '最近主控纠正',
      'supervision.next': '已通知原主控核对证据并纠正原子代理，已有产物和上下文保留。',
      'supervision.investigation': '调查', 'supervision.implementation': '实现', 'supervision.verification': '验证',
      'supervision.activity.model': '模型正在生成', 'supervision.activity.waiting_model_response': '等待模型响应',
      'supervision.activity.waiting_model': '等待下一步模型请求', 'supervision.activity.waiting_tool': '模型响应已返回，准备执行工具',
      'supervision.activity.tool': '工具正在执行', 'supervision.reporting': '正在提交报告',
      'supervision.wrapUp': '已提醒收尾：提交已有结果及未完成项',
      'supervision.continuation': '已自动续跑第 {segment} 段，沿用上一段产物和证据',
    })
    Object.assign(en, {
      'supervision.title': 'Execution supervision', 'supervision.waiting': 'Awaiting coordinator correction', 'supervision.count': '{count} awaiting correction',
      'supervision.elapsed': '{minutes} minutes elapsed', 'supervision.corrections': 'Coordinator corrections {used}/{limit}',
      'supervision.budget': 'Model calls {requests}/{requestLimit} · Output {output}/{outputLimit} tokens',
      'supervision.usage': 'Model calls {requests} · Output {output} tokens (this attempt; no plugin cap)',
      'supervision.context': 'Latest request context: {tokens} tokens', 'supervision.stage': 'Stage report (worker supplied, unverified)',
      'supervision.nextStep': 'Worker next step', 'supervision.corrected': 'Latest coordinator correction',
      'supervision.next': 'The original coordinator has been notified to inspect evidence and correct the original worker. Existing work and context are retained.',
      'supervision.investigation': 'Investigation', 'supervision.implementation': 'Implementation', 'supervision.verification': 'Verification',
      'supervision.activity.model': 'Model generating', 'supervision.activity.waiting_model_response': 'Waiting for model response',
      'supervision.activity.waiting_model': 'Waiting for the next model request', 'supervision.activity.waiting_tool': 'Response received; preparing tools',
      'supervision.activity.tool': 'Tool running', 'supervision.reporting': 'Submitting report',
      'supervision.wrapUp': 'Wrap-up requested: report existing results and unfinished work',
      'supervision.continuation': 'Automatically continuing segment {segment} with the previous work and evidence',
    })
    Object.assign(zh, {
      'view.decisionTitle': '本轮判断与执行安排', 'view.decisionDifficulty': '本轮难度',
      'view.decisionHint': '规则评分只给分流建议，不会自动派单；操作次数单独展示，不会改变难度。',
      'view.suggestedRoute': '系统建议', 'view.actualArrangement': '当前实际安排',
      'view.currentSessionTitle': '当前会话：{title}',
      'view.routeCurrent': '当前回合的建议', 'view.routeSnapshot': '计划建立时的建议',
      'view.actualDependency': '按任务依赖先后执行', 'view.actualParallel': '当前 {count} 个子 Agent 同时执行',
      'view.actualRunning': '当前 1 个子 Agent 在执行', 'view.actualQueued': '计划已建立，等待派发',
      'view.actualNoPlan': '未建立托管计划；没有可显示的子代理进度',
      'view.actualDirect': '主控已直接执行 {count} 次业务操作，未启动托管子代理',
      'view.actualCounts': '主控直接操作 {direct} 次、记录到派发 {delegated} 次；未建立托管计划',
      'view.actualUnknown': '未建立托管计划，当前记录不足以判断实际执行方式', 'view.actualAudit': '正在独立审查',
      'view.countersUnknown': '旧记录没有本轮统计，不用累计次数代替。',
      'view.taskModel': '执行模型', 'view.taskComplexity': '任务复杂度', 'view.taskAudit': '独立审查',
      'view.taskAcceptance': '主控验收', 'view.auditRequired': '复杂任务需独立审查',
      'view.auditCoordinator': '主控验证验收', 'view.auditExplicit': '独立审查必须通过', 'view.auditReason': '审查依据',
      'view.taskRoutine': '普通', 'view.taskComplex': '复杂', 'view.acceptanceStopped': '已停止，未验收',
      'view.auditOptional': '按需安排独立审查', 'view.acceptancePending': '报告提交后实际验证并验收',
      'view.acceptanceReview': '等待主控实际验证并逐条验收',
      'view.modelIdentifierNote': '仅核对 DSH 发出的模型标识；路由组内部实际模型以服务商返回的信息为准。',
      'view.currentAction': '当前动作', 'view.latestActivity': '最近工具记录',
      'view.executionDiagnostics': '执行诊断与额度', 'view.requestConsistent': '请求标识一致',
      'view.diagnostics': '查看完整判断与诊断',
    })
    Object.assign(en, {
      'view.decisionTitle': 'Assessment and actual execution', 'view.decisionDifficulty': 'This turn\'s difficulty',
      'view.decisionHint': 'Rule-based scoring only recommends a route; it does not dispatch agents. Operation counts are shown separately and do not change difficulty.',
      'view.suggestedRoute': 'Suggested route', 'view.actualArrangement': 'Actual arrangement',
      'view.currentSessionTitle': 'Current conversation: {title}',
      'view.routeCurrent': 'Recommendation for this turn', 'view.routeSnapshot': 'Recommendation when the plan was created',
      'view.actualDependency': 'Following task dependencies', 'view.actualParallel': '{count} child Agents are running concurrently',
      'view.actualRunning': 'One child Agent is running', 'view.actualQueued': 'Plan created; awaiting dispatch',
      'view.actualNoPlan': 'No managed plan; child-agent progress is unavailable',
      'view.actualDirect': 'The coordinator performed {count} direct operations; no managed child agent was started',
      'view.actualCounts': 'The coordinator performed {direct} direct operations and recorded {delegated} dispatches; no managed plan exists',
      'view.actualUnknown': 'No managed plan exists, and the available records do not show how execution proceeded', 'view.actualAudit': 'Independent review is running',
      'view.countersUnknown': 'This older record has no turn counters; cumulative counts are not substituted.',
      'view.taskModel': 'Execution model', 'view.taskComplexity': 'Task complexity', 'view.taskAudit': 'Independent review',
      'view.taskAcceptance': 'Coordinator acceptance', 'view.auditRequired': 'Complex tasks require independent review',
      'view.auditCoordinator': 'Coordinator verification and acceptance', 'view.auditExplicit': 'Independent review required', 'view.auditReason': 'Review reason',
      'view.taskRoutine': 'Routine', 'view.taskComplex': 'Complex', 'view.acceptanceStopped': 'Stopped without acceptance',
      'view.auditOptional': 'Independent review as needed', 'view.acceptancePending': 'Verification and acceptance after the report',
      'view.acceptanceReview': 'Awaiting actual verification and criterion-by-criterion acceptance',
      'view.modelIdentifierNote': 'Only the model identifier sent by DSH is checked; models selected inside a routing group depend on provider information.',
      'view.currentAction': 'Current action', 'view.latestActivity': 'Latest tool record',
      'view.executionDiagnostics': 'Execution diagnostics and limits', 'view.requestConsistent': 'Request identifier matches',
      'view.diagnostics': 'Full assessment and diagnostics',
    })
    Object.assign(zh, {
      'runtime.active': '持续执行策略已生效', 'runtime.pending': '当前进程尚未确认新策略，等待宿主自然重载',
      'usage.title': '本次需求用量', 'usage.partial': '统计不完整', 'usage.complete': '已记录全部已返回请求',
      'usage.coordinator': '主控', 'usage.worker': '执行者', 'usage.reviewer': '独立审查', 'usage.unknown': '未提供',
      'usage.input': '输入', 'usage.cacheRead': '缓存读取', 'usage.cacheWrite': '缓存写入', 'usage.output': '输出',
      'usage.calls': '模型请求', 'usage.attempt': '执行次数', 'usage.note': '按宿主原始字段分别统计，不合并缓存、不估算费用。',
      'supervision.requestNotice': '调用次数提醒已记录，原代理继续执行',
      'supervision.timeNotice': '运行时间提醒已记录，任务继续执行',
      'supervision.inquiry': '活动核对提醒', 'supervision.inquiryCount': '需核对活动 {count} 项',
      'view.actualNoPlan': '未建立托管计划；没有可显示的子代理进度',
      'view.confirmedDifficulty': '主控已确认的任务复杂度', 'view.confirmedArrangement': '主控已确认的执行安排',
      'view.initialAssessment': '规则判断与建议（仅供参考）', 'view.initialDifficulty': '规则估计', 'view.unconfirmed': '尚未确认',
      'view.delegationConfirmed': '已安排子代理', 'view.complexAudit': '执行完成后进行独立审查，主控最终验收',
      'view.routineAcceptance': '执行者提交报告，主控验证验收',
      'input.title': '补充信息', 'input.pending': '待主控处理 {count} 条', 'input.chatPending': '待处理补充 {count} 条',
      'input.queued': '待主控接收', 'input.received': '主控已接收，待处理', 'input.forwarded': '已同步至任务', 'input.resolved': '已答复', 'input.withdrawn': '已撤回',
      'input.history': '查看补充信息处理记录', 'input.criteria': '新增验收标准',
      'view.otherRequest': '其他需求的托管记录', 'view.recordedRequest': '托管计划对应需求（当前需求关联未确认）',
      'live.title': '协作进度', 'live.counts': '执行中 {running} · 等待 {waiting}', 'live.results': '已返回 {returned}/{total} · 已验收 {accepted}/{total}',
      'live.current': '当前', 'live.recent': '最近完成的工具', 'live.activityAt': '最近活动', 'live.unknown': '子代理执行中，当前步骤未记录', 'live.toolFailed': '该步骤失败',
      'live.read': '读取文件', 'live.search': '检索内容', 'live.glob': '查找文件', 'live.edit': '修改文件', 'live.write': '写入文件',
      'live.command': '执行命令', 'live.report': '提交报告', 'live.checkpoint': '记录阶段结果',
    })
    Object.assign(en, {
      'runtime.active': 'Continuous-execution policy is loaded', 'runtime.pending': 'New policy not confirmed; awaiting natural host reload',
      'usage.title': 'Usage for this request', 'usage.partial': 'Incomplete statistics', 'usage.complete': 'All returned requests recorded',
      'usage.coordinator': 'Coordinator', 'usage.worker': 'Worker', 'usage.reviewer': 'Independent reviewer', 'usage.unknown': 'Not provided',
      'usage.input': 'Input', 'usage.cacheRead': 'Cache read', 'usage.cacheWrite': 'Cache write', 'usage.output': 'Output',
      'usage.calls': 'Model requests', 'usage.attempt': 'Attempt', 'usage.note': 'Original host fields are recorded separately; no cache merging or cost estimates.',
      'supervision.requestNotice': 'Request-count reminder recorded; same agent continues',
      'supervision.timeNotice': 'Elapsed-time reminder recorded; task continues',
      'supervision.inquiry': 'Activity inquiry', 'supervision.inquiryCount': '{count} activity inquiries',
      'view.actualNoPlan': 'No managed plan; child-agent progress is unavailable',
      'view.confirmedDifficulty': 'Task complexity confirmed by coordinator', 'view.confirmedArrangement': 'Confirmed execution arrangement',
      'view.initialAssessment': 'Rule-based assessment and recommendation (advisory)', 'view.initialDifficulty': 'Rule-based estimate', 'view.unconfirmed': 'Not confirmed',
      'view.delegationConfirmed': 'Child agents assigned', 'view.complexAudit': 'Independent review after execution; coordinator accepts the result',
      'view.routineAcceptance': 'Worker reports; coordinator verifies and accepts',
      'input.title': 'Additional input', 'input.pending': '{count} awaiting coordinator handling', 'input.chatPending': '{count} pending supplements',
      'input.queued': 'Awaiting coordinator receipt', 'input.received': 'Received; awaiting handling', 'input.forwarded': 'Forwarded to task', 'input.resolved': 'Answered', 'input.withdrawn': 'Withdrawn',
      'input.history': 'Supplement handling history', 'input.criteria': 'Additional acceptance criteria',
      'view.otherRequest': 'Managed record for another request', 'view.recordedRequest': 'Request for this plan (current request association unconfirmed)',
      'live.title': 'Collaboration progress', 'live.counts': 'Running {running} · Waiting {waiting}', 'live.results': 'Returned {returned}/{total} · Accepted {accepted}/{total}',
      'live.current': 'Current', 'live.recent': 'Latest completed tool', 'live.activityAt': 'Latest activity', 'live.unknown': 'Worker running; current step not recorded', 'live.toolFailed': 'This step failed',
      'live.read': 'Reading a file', 'live.search': 'Searching contents', 'live.glob': 'Finding files', 'live.edit': 'Editing a file', 'live.write': 'Writing a file',
      'live.command': 'Running a command', 'live.report': 'Submitting a report', 'live.checkpoint': 'Recording stage findings',
    })

    Object.assign(zh, {
      'direct.title': '主控直接执行', 'direct.incomplete': '修改未完成',
      'direct.repairing': '修改遇错，继续处理中', 'dock.details': '执行详情',
      'dock.execution': '当前执行', 'dock.decision': '执行判断', 'dock.activity': '当前动作',
      'dock.toolCalls': '本轮工具调用', 'dock.callsUnit': '次', 'dock.unknownModel': '未记录', 'dock.issues': '异常记录',
      'dock.coordinator': '主控处理中', 'dock.repairing': '正在处理异常',
      'dock.waiting': '等待', 'dock.accepted': '验收', 'dock.failed': '失败', 'dock.blocked': '阻塞', 'dock.requestRefused': '请求被拒',
      'service.requestRefused': '模型服务拒绝本次请求。', 'service.refusalScope': '这是本次请求的拒绝结果，不代表模型整体不可用。',
      'service.refusalNext': '核对服务商支持的调用方式与限制，处理后由主控明确重试该任务。', 'service.rawDetails': '原始错误详情',
      'chat.othersContinue': '其他正在运行的任务继续执行。',
      'accordion.worker': '执行者', 'accordion.reviewing': '独立审查中', 'accordion.scope': '任务范围', 'accordion.dependency': '等待前置任务',
      'accordion.report': '执行者报告', 'accordion.auditReport': '审查报告', 'accordion.acceptance': '主控验收',
      'accordion.verified': '实际验证通过 {passed}/{total}', 'accordion.noChecks': '尚未记录验证',
      'dock.workers': '{count} 个子任务执行中', 'dock.audit': '独立审查中', 'dock.review': '待验收 {count} 项',
      'dock.taskCount': '{count} 项任务', 'dock.running': '执行中', 'dock.auditing': '审查中', 'dock.awaitingReview': '待验收',
      'dock.unavailable': '协作暂不可用', 'dock.offline': '状态暂不可用',
      'direct.advice': '系统建议委派，当前尚未启动子代理', 'direct.calls': '本轮工具调用 {count} 次',
      'direct.preparing': '主控准备中', 'decision.title': '主控决定', 'decision.direct': '直接执行', 'decision.delegate': '委派',
      'decision.reason': '判断理由', 'decision.pending': '等待主控记录执行方式和理由', 'decision.unrecorded': '主控判断未记录',
      'decision.revised': '需求已补充，等待主控更新判断', 'decision.notStarted': '已决定委派，尚未启动子代理', 'decision.at': '判断时间',
      'view.modelNoPlanHint': '主控按上下文判断是否委派；程序展示已记录的决定和实际活动。没有托管计划时，不会显示子代理进度或验收回执。', 'relation.title': '消息与需求的关联', 'relation.pending': '待主控确认消息关联', 'relation.new': '新需求', 'relation.continue': '继续原需求',
      'relation.update': '补充原需求或调整方案', 'relation.question': '询问进度或普通提问，沿用原需求',
      'direct.unavailable': '委派入口不可用', 'direct.checkPlugin': '请检查 DSH Agentrix 插件是否启用，以及宿主的子代理功能是否可用；当前没有通过这些入口启动协作。',
      'direct.backendMissing': 'Agentrix 插件服务不可用', 'direct.backendHint': '请检查插件是否启用；进度恢复前无法确认当前执行情况。',
      'direct.stale': '进度暂时无法更新，以下为最近记录',
      'coordination.incomplete': '尚未完成', 'coordination.coordinator': '主控操作未执行', 'coordination.worker': '协作操作未执行',
      'coordination.active': '协作执行策略已生效（v6）', 'coordination.pending': '协作执行策略等待加载',
      'plans.outputTruncated': '验证摘要已截断，完整结果已保存', 'plans.outputPath': '完整验证结果', 'plans.concerns': '执行疑点（验收前需处理）',
    })
    Object.assign(en, {
      'direct.title': 'Coordinator executing directly', 'direct.incomplete': 'File changes remain incomplete',
      'direct.repairing': 'Handling a failed change', 'dock.details': 'Execution details',
      'dock.execution': 'Current execution', 'dock.decision': 'Execution decision', 'dock.activity': 'Current activity',
      'dock.toolCalls': 'Tool calls this turn', 'dock.callsUnit': 'calls', 'dock.unknownModel': 'Not recorded', 'dock.issues': 'Issues',
      'dock.coordinator': 'Coordinator working', 'dock.repairing': 'Handling an issue',
      'dock.waiting': 'Queued', 'dock.accepted': 'Accepted', 'dock.failed': 'Failed', 'dock.blocked': 'Blocked', 'dock.requestRefused': 'Request refused',
      'service.requestRefused': 'The model service refused this request.', 'service.refusalScope': 'This refusal applies to this request; it does not establish that the model is unavailable.',
      'service.refusalNext': 'Check the provider\'s supported usage and restrictions, then explicitly retry this task after resolving the cause.', 'service.rawDetails': 'Original error details',
      'chat.othersContinue': 'Other running tasks continue.',
      'accordion.worker': 'Worker', 'accordion.reviewing': 'Independent review in progress', 'accordion.scope': 'Task scope', 'accordion.dependency': 'Waiting for dependencies',
      'accordion.report': 'Worker report', 'accordion.auditReport': 'Review report', 'accordion.acceptance': 'Coordinator acceptance',
      'accordion.verified': '{passed}/{total} checks verified', 'accordion.noChecks': 'No verification recorded',
      'dock.workers': '{count} subtasks running', 'dock.audit': 'Independent review', 'dock.review': '{count} awaiting acceptance',
      'dock.taskCount': '{count} tasks', 'dock.running': 'Running', 'dock.auditing': 'Reviewing', 'dock.awaitingReview': 'Awaiting acceptance',
      'dock.unavailable': 'Delegation unavailable', 'dock.offline': 'Status unavailable',
      'direct.advice': 'Delegation was suggested; no child agent has started', 'direct.calls': '{count} tool calls this turn',
      'direct.preparing': 'Coordinator preparing', 'decision.title': 'Coordinator decision', 'decision.direct': 'Execute directly', 'decision.delegate': 'Delegate',
      'decision.reason': 'Reason', 'decision.pending': 'Waiting for the coordinator to record its execution choice and reason', 'decision.unrecorded': 'Coordinator decision not recorded',
      'decision.revised': 'Request updated; waiting for a revised decision', 'decision.notStarted': 'Delegation chosen; no child agent has started', 'decision.at': 'Decision time',
      'view.modelNoPlanHint': 'The coordinator decides from context; the plugin shows its recorded choice and observed activity. Without a managed plan there is no child progress or acceptance receipt.', 'relation.title': 'Message relationship', 'relation.pending': 'Waiting for coordinator to classify the message', 'relation.new': 'New request', 'relation.continue': 'Continue the current request',
      'relation.update': 'Update the current scope or approach', 'relation.question': 'Progress inquiry or question; keep the current request',
      'direct.unavailable': 'Delegation tools unavailable', 'direct.checkPlugin': 'Check that DSH Agentrix is enabled and the host supports subagents. These entry points have not started collaboration.',
      'direct.backendMissing': 'Agentrix plugin service unavailable', 'direct.backendHint': 'Check that the plugin is enabled. Current execution cannot be confirmed until progress is available.',
      'direct.stale': 'Progress could not be refreshed; the last record is shown',
      'coordination.incomplete': 'Not completed', 'coordination.coordinator': 'Coordinator operation did not succeed', 'coordination.worker': 'Coordination operation did not succeed',
      'coordination.active': 'Coordination policy active (v6)', 'coordination.pending': 'Coordination policy awaiting reload',
      'plans.outputTruncated': 'Verification preview truncated; full output saved', 'plans.outputPath': 'Full verification output', 'plans.concerns': 'Worker concerns (resolve before acceptance)',
    })

    const CONFIG_NUMBERS = ['threshold', 'maxParallel', 'maxAttempts', 'maxActivations', 'taskTimeoutMinutes']
    // Compatibility only; current hosts provide the authoritative defaults and ranges.
    const LEGACY_RANGES = { threshold: { min: 0, max: 20 }, maxParallel: { min: 1, max: 4 }, maxAttempts: { min: 1, max: 3 }, maxActivations: { min: 1, max: 32 }, taskTimeoutMinutes: { min: 1, max: 60 } }
    Object.assign(zh, {
      'cfg.subtitle': '设置自动委派的模式、子任务模型和资源上限。保存后闸门与后续派单立即生效；在跑任务与环境变量锁定项不受影响。',
      'cfg.policy': '委派策略', 'cfg.limits': '执行限制', 'cfg.models': '子任务模型', 'cfg.diagnostics': '生效与诊断',
      'cfg.policyHint': '自动模式由主控结合实际工作决定是否委派；严格和固定模式保留操作限制。保存后应用新策略，当前调用统计不重置。',
      'cfg.limitsHint': '设置并发、返工、启动次数和运行时间提醒。时间与调用次数仅提醒，不中断原代理。',
      'cfg.diagnosticsHint': '只读。展示当前生效值的来源与各配置项的生效时机，避免“改了没反应”的误判。',
      'cfg.fields': '{count} 项', 'cfg.readonly': '只读', 'cfg.default': '默认 {value}', 'cfg.integer': '必须是 {min}–{max} 的整数', 'cfg.range': '{min}–{max} 的整数',
      'cfg.budgetContext': '固定模式必填 · 自动模式由主控判断',
      'cfg.maxParallelRange': '跨会话共享', 'cfg.maxAttemptsRange': '首次计入', 'cfg.maxActivationsRange': '执行与审查计入',
      'cfg.notePolicy': '生效说明', 'cfg.noteLimits': '不随保存变化', 'cfg.noteModels': '生效说明', 'cfg.noteDiagnostics': '验收不在这里',
      'cfg.policyAfter': ' 锁定项必须改变量并重启 Harness。',
      'cfg.modelsHint': '只需选择执行模型和可选思考强度；独立审查自动沿用分发者模型。',
      'limits.timeoutLabel': '运行时间提醒',
      'cfg.whenNow': '立即', 'cfg.whenPlan': '新建计划', 'cfg.whenTask': '新任务',
      'cfg.acceptanceNote': '打开需要查看的会话，在「任务验收」页签核对当前需求；协作过程看 Fleet，整理与导出用「分享会话」。',
      'cfg.defaultMode': '默认', 'cfg.times': '次', 'cfg.agents': '个', 'cfg.minutes': '分钟',
      'cfg.nowTool': '下一次工具调用生效', 'cfg.nextDispatch': '下一次派单生效', 'cfg.nextRework': '后续返工生效',
      'cfg.newPlan': '仅新建计划生效', 'cfg.newTask': '仅新启动任务生效',
      'cfg.policyNote': '切换到「关闭」后主控的委派纪律段在下一次 prompt 组装才消失；想完全按新模式运行，需发一轮新消息。环境变量 ',
      'cfg.limitsNote': '已建立的计划沿用创建时的派发上限；在跑子任务的超时计时器不重设；在跑子 Agent 沿用启动时解析的模型。',
      'cfg.modelsNote': '执行模型修改作用于后续派发与返工；审查沿用各次执行的分发者记录。运行中的任务不换模型。执行模型失效时，保存后需明确继续。',
      'cfg.loading': '正在读取配置…', 'cfg.loadTitle': '暂时无法读取配置', 'cfg.loadHint': '请检查 DSH 是否正常运行，然后重新读取。读取成功前不会保存任何修改。',
      'cfg.retry': '重新读取', 'cfg.loadDetails': '查看错误详情', 'cfg.stale': '本次刷新失败，当前显示上次读取的配置；草稿已保留。',
      'cfg.invalid': '有 {count} 项需要修正', 'cfg.dirty': '有未保存的修改', 'cfg.dirtyHint': '草稿已修改，尚未保存；保存前仍使用原配置。切换分组不会丢失修改。',
      'cfg.clean': '已是最新配置', 'cfg.discard': '放弃修改', 'cfg.saveUnavailable': '保存不可用', 'cfg.poll': '每 3 秒读取一次配置',
      'cfg.saveEffect': '保存后按各项生效时机应用', 'cfg.saveHint': '已保存。当前策略与后续派单使用新配置，运行中的任务保持不变。',
      'cfg.conflict': '配置已在别处更新', 'cfg.conflictHint': '编辑期间配置发生变化，草稿已保留。请核对差异，再决定如何处理。',
      'cfg.diff': '查看差异', 'cfg.server': '用服务器值覆盖', 'cfg.keep': '保留我的修改', 'cfg.base': '开始编辑时', 'cfg.latest': '最新配置', 'cfg.mine': '我的草稿', 'cfg.field': '配置项',
      'cfg.locked': '由环境变量 DSH_DELEGATION_FIRST 锁定，面板只读。该变量固定模式与预算，执行限制和模型仍从本机文件读取。修改变量并重启 Harness 后生效。',
      'cfg.source': '配置来源', 'cfg.file': '本机文件', 'cfg.env': '环境变量', 'cfg.defaults': '内置默认值', 'cfg.sourceLoading': '正在读取来源',
      'cfg.lockState': '锁定状态', 'cfg.unlocked': '未锁定', 'cfg.activeMode': '当前生效模式', 'cfg.savedAt': '最近保存', 'cfg.unknown': '未记录', 'cfg.unset': '未设置',
      'cfg.catalog': '已配置 {services} 个服务 · {models} 个模型', 'cfg.emptyTitle': '暂无可用模型',
      'cfg.emptyHint': '请先在 DSH 设置中配置模型服务，再刷新目录并选择执行模型；独立审查无需额外配置。',
      'cfg.modelImpact': '子任务暂时无法启动', 'cfg.chooseModel': '去选择模型', 'cfg.modelDraft': '所选模型不可用，请在子任务模型分组中重新选择；已保存的配置在保存前保持不变。',
      'cfg.when': '生效时机', 'cfg.explanation': '说明', 'cfg.policyTiming': '模式 / 动手预算', 'cfg.dispatchTiming': '全局同时执行 / 每任务最多执行',
      'cfg.activationTiming': '每个计划最多派发', 'cfg.taskTiming': '运行时间提醒 / 子任务模型', 'cfg.restart': '重启 Harness',
      'cfg.policyExplanation': '下一次工具调用；当前回合计数不重置', 'cfg.dispatchExplanation': '下一次派单、后续返工',
      'cfg.activationExplanation': '已建计划沿用旧上限', 'cfg.taskExplanation': '在跑任务不重设计时器、不换模型', 'cfg.envExplanation': '面板只读，POST 返回 409',
    })
    Object.assign(en, {
      'cfg.subtitle': 'Configure delegation, child models and resource limits. Each setting follows its effective time; running tasks keep their launch-time configuration.',
      'cfg.policy': 'Delegation policy', 'cfg.limits': 'Execution limits', 'cfg.models': 'Child models', 'cfg.diagnostics': 'Effective settings',
      'cfg.policyHint': 'Choose when the coordinator must delegate. Changes apply to the next tool call without resetting turn counts.',
      'cfg.limitsHint': 'Limit concurrency, attempts and task duration. First attempts count; concurrency is shared across conversations.', 'cfg.diagnosticsHint': 'Read-only sources and effective times. Draft edits apply only after saving.',
      'cfg.fields': '{count} fields', 'cfg.readonly': 'Read only', 'cfg.default': 'Default {value}', 'cfg.integer': 'Must be an integer from {min} to {max}', 'cfg.range': 'Integer from {min} to {max}',
      'cfg.budgetContext': 'Required in fixed mode; automatic routing is advisory.',
      'cfg.maxParallelRange': 'Shared across conversations', 'cfg.maxAttemptsRange': 'Includes the first attempt', 'cfg.maxActivationsRange': 'Includes initial dispatch and rework',
      'cfg.notePolicy': 'Effective time', 'cfg.noteLimits': 'Kept unchanged', 'cfg.noteModels': 'Effective time', 'cfg.noteDiagnostics': 'Acceptance lives in the conversation',
      'cfg.policyAfter': ' must be changed before restarting Harness.',
      'cfg.modelsHint': 'Choose execution and optional reasoning effort. Independent review uses the dispatcher model automatically.',
      'limits.timeoutLabel': 'Elapsed-time reminder',
      'cfg.whenNow': 'Immediately', 'cfg.whenPlan': 'New plans', 'cfg.whenTask': 'New activations',
      'cfg.acceptanceNote': 'Open a conversation and use Task acceptance to inspect the request. Fleet shows collaboration; Share conversation provides exports.',
      'cfg.defaultMode': 'Default', 'cfg.times': 'attempts', 'cfg.agents': 'tasks', 'cfg.minutes': 'minutes', 'cfg.nowTool': 'Next tool call', 'cfg.nextDispatch': 'Next dispatch', 'cfg.nextRework': 'Subsequent rework', 'cfg.newPlan': 'New plans only', 'cfg.newTask': 'New activations only',
      'cfg.policyNote': 'Disabling removes the coordinator discipline at the next prompt assembly. Send a new message to continue under the new mode. Environment overrides require a Harness restart.',
      'cfg.limitsNote': 'Existing plans retain their activation limit. Running tasks keep their timers and models.', 'cfg.modelsNote': 'Execution changes apply to later dispatch and rework. Review keeps the dispatcher record for that attempt; running tasks keep their models.',
      'cfg.loading': 'Reading configuration…', 'cfg.loadTitle': 'Configuration is unavailable', 'cfg.loadHint': 'Check that DSH is running, then retry. Saving is unavailable until configuration is loaded.', 'cfg.retry': 'Retry loading', 'cfg.loadDetails': 'Error details', 'cfg.stale': 'Refresh failed. The last configuration and your draft are retained.',
      'cfg.invalid': '{count} fields need correction', 'cfg.dirty': 'Unsaved changes', 'cfg.dirtyHint': 'Your draft is not saved. The previous configuration remains active; switching tabs retains edits.', 'cfg.clean': 'Configuration is up to date', 'cfg.discard': 'Discard changes', 'cfg.saveUnavailable': 'Saving unavailable', 'cfg.poll': 'Refreshes every 3 seconds', 'cfg.saveEffect': 'Each setting follows its effective time', 'cfg.saveHint': 'Saved. New policy and subsequent dispatches use the new settings. Running tasks are unchanged.',
      'cfg.conflict': 'Configuration changed elsewhere', 'cfg.conflictHint': 'Your draft is retained. Review the differences before resolving this change.', 'cfg.diff': 'Compare changes', 'cfg.server': 'Use latest settings', 'cfg.keep': 'Keep my edits', 'cfg.base': 'When editing began', 'cfg.latest': 'Latest settings', 'cfg.mine': 'My draft', 'cfg.field': 'Setting',
      'cfg.locked': 'DSH_DELEGATION_FIRST locks this page. It pins the mode and budget; resource limits and models still come from the local file. Change the variable and restart Harness to unlock.',
      'cfg.source': 'Configuration source', 'cfg.file': 'Local file', 'cfg.env': 'Environment', 'cfg.defaults': 'Built-in defaults', 'cfg.sourceLoading': 'Reading source', 'cfg.lockState': 'Lock state', 'cfg.unlocked': 'Unlocked', 'cfg.activeMode': 'Effective mode', 'cfg.savedAt': 'Last saved', 'cfg.unknown': 'Not recorded', 'cfg.unset': 'Not set',
      'cfg.catalog': '{services} configured services · {models} models', 'cfg.emptyTitle': 'No configured models', 'cfg.emptyHint': 'Configure a service in DSH settings, then refresh. Choose an execution model; review may follow the coordinator.', 'cfg.modelImpact': 'Child tasks cannot start', 'cfg.chooseModel': 'Choose a model', 'cfg.modelDraft': 'The selected model is unavailable. Choose another in Child models. Saved settings remain active until you save.',
      'cfg.when': 'Effective time', 'cfg.explanation': 'Details', 'cfg.policyTiming': 'Mode / operation budget', 'cfg.dispatchTiming': 'Concurrency / task attempts', 'cfg.activationTiming': 'Plan activation limit', 'cfg.taskTiming': 'Elapsed-time reminder / child model', 'cfg.restart': 'Restart Harness',
      'cfg.policyExplanation': 'Next tool call; turn counts are retained', 'cfg.dispatchExplanation': 'Subsequent dispatch and rework; running tasks continue', 'cfg.activationExplanation': 'Existing plans retain their original limit', 'cfg.taskExplanation': 'Running timers and models are unchanged', 'cfg.envExplanation': 'Read-only page; save requests return 409',
    })
    const MODEL_ROLES = ['worker']
    const modelRoutes = config => ({ worker: config?.models && Object.hasOwn(config.models, 'worker') ? config.models.worker : config?.models?.routine ?? null, reviewer: null })
    const draftOf = config => ({ mode: config?.mode ?? 'auto', threshold: config?.threshold ?? 2,
      maxParallel: config?.maxParallel ?? config?.defaults?.maxParallel ?? 2, maxAttempts: config?.maxAttempts ?? config?.defaults?.maxAttempts ?? 2,
      maxActivations: config?.maxActivations ?? config?.defaults?.maxActivations ?? 8, taskTimeoutMinutes: config?.taskTimeoutMinutes ?? config?.defaults?.taskTimeoutMinutes ?? 15,
      models: modelRoutes(config) })
    const configSignature = config => config?.revision ?? JSON.stringify(draftOf(config))
    const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right)
    const configRange = (config, key) => config?.ranges?.[key] ?? LEGACY_RANGES[key]
    const configLabel = (t, key) => t(key === 'threshold' ? 'budget.label' : 'limits.' + key)
    function configErrors(t, config, draft) {
      const errors = {}
      for (const key of CONFIG_NUMBERS) {
        if (key === 'threshold' && !['auto', 'fixed'].includes(draft.mode)) continue
        const range = configRange(config, key), value = draft[key]
        if (!Number.isInteger(value) || value < range.min || value > range.max) errors[key] = `${configLabel(t, key)}：${fill(t('cfg.integer'), range)}`
      }
      return errors
    }

    function modelProblem(route, catalogState) {
      if (!route || catalogState.status !== 'ready' || catalogState.error) return null
      if (catalogState.value?.failures?.some(failure => failure.id === route.provider)) return null
      const group = catalogState.value?.groups?.find(group => group.id === route.provider)
      const model = group?.models.find(model => model.id === route.model)
      if (!model) return 'model'
      if (route.reasoningEffort && !model.reasoning?.efforts?.some(effort => effort.id === route.reasoningEffort)) return 'effort'
      return null
    }

    function useCatalog(catalog) {
      return useSyncExternalStore(
        useCallback(notify => catalog.store.subscribe(notify), [catalog]),
        useCallback(() => catalog.store.getSnapshot(), [catalog]))
    }

    // The sidebar stays mounted while another page is open. Only read local
    // configuration here; catalog updates come from DSH's shared store.
    function createModelHealth(catalog) {
      let config = null, snapshot = { invalid: [], remind: false }, controller, dismissedKey = '', revision = 0
      const listeners = new Set()
      const sync = () => {
        const state = catalog.store.getSnapshot()
        const routes = modelRoutes(config)
        const invalid = MODEL_ROLES.filter(role => config?.modelRouting === 'roles' && role === 'worker' && !routes.worker || modelProblem(routes[role], state))
        const key = JSON.stringify(invalid.map(role => [role, routes[role]]))
        if (config && state.status === 'ready' && !state.error && !state.value?.failures?.length && !invalid.length) dismissedKey = ''
        snapshot = { invalid, key, remind: invalid.length > 0 && key !== dismissedKey }
        for (const fn of listeners) fn()
      }
      const publish = value => { config = value; revision++; sync() }
      const refresh = async () => {
        if (controller) return
        const active = new AbortController(), expected = revision; controller = active
        try {
          const value = await getConfig(AbortSignal.any([active.signal, AbortSignal.timeout(8000)]))
          if (!active.signal.aborted && revision === expected) publish(value)
        }
        catch { /* A failed read cannot establish that a model is invalid. */ }
        finally { if (controller === active) controller = null }
      }
      return {
        getSnapshot: () => snapshot,
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
        publish,
        dismiss() { dismissedKey = snapshot.key; sync() },
        start() {
          const off = catalog.store.subscribe(sync)
          catalog.load().catch(() => {})
          void refresh()
          const timer = window.setInterval(() => { void refresh() }, 15000)
          return () => { window.clearInterval(timer); controller?.abort(); off(); listeners.clear() }
        },
      }
    }

    function focusModel(tier) {
      tier = tier === 'routine' ? 'worker' : tier === 'complex' ? 'reviewer' : tier
      const target = document.getElementById(`ddf-model-${tier}`)
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' }); target?.focus({ preventScroll: true })
    }

    const ALERT_STYLES = `
.ddf-model-alert { display:flex; gap:12px; align-items:flex-start; box-sizing:border-box; padding:18px; margin:0 0 16px; border:1px solid var(--dsw-alias-state-danger-primary,#d14343); border-left-width:5px; border-radius:12px; background:var(--dsw-alias-bg-layer-1,#fff); color:var(--dsw-alias-label-primary,#1f2329); font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif; text-align:left; }
.ddf-model-alert[data-overlay] { position:fixed; top:var(--dsh-frame-overlay-top,24px); right:24px; width:min(440px,calc(100vw - 48px)); box-shadow:0 8px 32px #0003; pointer-events:auto; z-index:30; }
.ddf-model-alert strong { display:block; font-size:17px; color:var(--dsw-alias-state-danger-primary,#d14343); }
.ddf-model-alert p { margin:6px 0 12px; }
.ddf-notice-icon { display:inline-grid; place-items:center; flex:none; width:26px; height:26px; margin-top:2px; border-radius:50%; background:var(--dsw-alias-state-danger-primary,#d14343); color:var(--dsw-alias-bg-layer-1,#fff); font-size:18px; font-weight:700; }
.ddf-notice-actions { display:flex; flex-wrap:wrap; gap:8px; }
.ddf-notice-action { border:1px solid var(--dsw-alias-border-l1,#d0d3d8); border-radius:7px; padding:7px 12px; background:transparent; color:inherit; font:inherit; cursor:pointer; }
.ddf-notice-action[data-primary] { background:var(--dsw-alias-state-danger-primary,#d14343); border-color:transparent; color:var(--dsw-alias-bg-layer-1,#fff); font-weight:600; }
`

    function ModelReminder({ t, modelHealth, onFix, inline = false }) {
      const health = useSyncExternalStore(modelHealth.subscribe, modelHealth.getSnapshot)
      if (!health.invalid.length || (!inline && !health.remind)) return null
      return h('section', { className: 'ddf-model-alert', role: 'alert', 'data-overlay': inline ? undefined : true },
        h('style', null, ALERT_STYLES), h('span', { className: 'ddf-notice-icon', 'aria-hidden': true }, '!'),
        h('div', null, h('strong', null, t('reminder.title')),
          h('p', null, fill(t('reminder.body'), { tiers: health.invalid.map(tier => t(`models.${tier}`)).join('、') })),
          h('div', { className: 'ddf-notice-actions' },
            h('button', { type: 'button', className: 'ddf-notice-action', 'data-primary': true, onClick: onFix }, t('plans.fixModel')),
            !inline ? h('button', { type: 'button', className: 'ddf-notice-action', onClick: () => modelHealth.dismiss() }, t('reminder.dismiss')) : null)))
    }

    // -----------------------------------------------------------------------
    // Small pure helpers
    // -----------------------------------------------------------------------

    /** `HH:MM:SS`, local time. */
    function clockTime(millis) {
      const date = new Date(Number.isFinite(millis) ? millis : Date.now())
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** The first eight characters of a session id, which is what a person needs. */
    function shortId(sessionId) {
      const id = String(sessionId ?? '')
      const unique = id.replace(/^session-/, '')
      return unique.length > 8 ? unique.slice(0, 8) : unique || '—'
    }

    /** A level is only shown when the Host actually judged the turn. */
    function levelKey(difficulty) {
      const level = difficulty?.level
      return level === 'simple' || level === 'medium' || level === 'complex' ? level : null
    }

    function signalText(t, signal) {
      const key = SIGNAL_KEYS[signal]
      return key ? t(key) : String(signal ?? '')
    }

    function signalsText(t, difficulty) {
      const signals = Array.isArray(difficulty?.signals) ? difficulty.signals.filter(Boolean) : []
      if (!signals.length) return t('difficulty.noSignals')
      return fill(t('difficulty.signals'), { signals: signals.map((signal) => signalText(t, signal)).join('、') })
    }

    function routeLabel(t, route) {
      return route?.route && ['direct', 'delegate', 'delegate_parallel'].includes(route.route)
        ? t(`plans.route.${route.route}`) : t('difficulty.none')
    }

    function routeReasonsText(t, route) {
      const reasons = Array.isArray(route?.reasons) ? route.reasons.filter(Boolean) : []
      if (!reasons.length) return t('difficulty.noSignals')
      return reasons.map(reason => ROUTE_REASON_KEYS[reason] ? t(ROUTE_REASON_KEYS[reason]) : String(reason)).join('、')
    }

    function routeEstimate(t, route) {
      return fill(t('plans.routeEstimate'), {
        steps: Number.isFinite(route?.estimatedSteps) ? route.estimatedSteps : '—',
        parallel: Number.isFinite(route?.parallelTasks) ? route.parallelTasks : 1,
        confidence: Number.isFinite(route?.confidence) ? Math.round(route.confidence * 100) : '—',
      })
    }

    const EMPTY_CHAT_RESULT = { sessionId: null, data: null, error: '', loading: true }

    /** All chat slots share one request and polling timer per visible session. */
    function createChatProgress() {
      const sessions = new Map()
      const clearTimer = entry => { window.clearInterval(entry.timer); entry.timer = null }
      const remove = entry => {
        sessions.delete(entry.sessionId); clearTimer(entry); entry.controller?.abort(); entry.listeners.clear()
      }
      const refresh = async entry => {
        if (entry.controller || sessions.get(entry.sessionId) !== entry) return
        const controller = new AbortController(); entry.controller = controller
        try {
          const data = await getState(AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]), entry.sessionId)
          if (controller.signal.aborted || sessions.get(entry.sessionId) !== entry) return
          entry.result = { sessionId: entry.sessionId, data, error: '', errorStatus: null, loading: false }
          const plan = currentPlanOf(data, entry.sessionId)
          const route = plan?.routing ?? data.sessions?.find(item => item.sessionId === entry.sessionId)?.route
          const execution = data.sessions?.find(item => item.sessionId === entry.sessionId)?.execution
          entry.terminal = Boolean(plan && !execution?.running && !execution?.unresolvedChanges?.length
            && (plan.protocolVersion >= 2 ? plan.completion : ['accepted', 'cancelled'].includes(plan.status)))
          if (entry.terminal) clearTimer(entry)
          else if (entry.timer === null) entry.timer = window.setInterval(() => { void refresh(entry) }, CHAT_POLL_MS)
        } catch (error) {
          if (controller.signal.aborted || sessions.get(entry.sessionId) !== entry) return
          entry.result = { ...entry.result, loading: false, error: error.message || String(error), errorStatus: error.status }
        } finally { if (entry.controller === controller) entry.controller = null }
        for (const notify of entry.listeners) notify(entry.result)
      }
      return {
        subscribe(sessionId, notify) {
          let entry = sessions.get(sessionId)
          if (!entry) {
            entry = { sessionId, listeners: new Set(), result: { ...EMPTY_CHAT_RESULT, sessionId },
              controller: null, timer: null, terminal: false }
            sessions.set(sessionId, entry)
          }
          const first = entry.listeners.size === 0
          entry.listeners.add(notify); notify(entry.result)
          if (first || entry.terminal) {
            if (entry.timer === null) entry.timer = window.setInterval(() => { void refresh(entry) }, CHAT_POLL_MS)
            void refresh(entry)
          }
          return () => { if (entry.listeners.delete(notify) && entry.listeners.size === 0) remove(entry) }
        },
        dispose() { for (const entry of sessions.values()) remove(entry) },
      }
    }

    function useChatProgress(progress, sessionId, latest, identity) {
      const [result, setResult] = useState(EMPTY_CHAT_RESULT)
      useEffect(() => {
        if (!sessionId || !latest) return undefined
        return progress.subscribe(sessionId, setResult)
      }, [progress, sessionId, latest, identity])
      return result.sessionId === sessionId ? result : EMPTY_CHAT_RESULT
    }

    function latestChatReply(snapshot) {
      const order = snapshot?.timeline?.turnOrder
      if (Array.isArray(order) && snapshot.locations?.getTurn && snapshot.nodes?.get) {
        const keys = order.length ? snapshot.locations.getTurn(order.at(-1)) : []
        for (let index = keys.length - 1; index >= 0; index--) {
          const node = snapshot.nodes.get(keys[index])
          if (node?.kind === 'turn-tail') return node.data.closing?.finalNode ?? { seq: node.data.seq }
        }
        return {}
      }
      const nodes = snapshot?.legacy?.nodes
      if (!Array.isArray(nodes)) return null
      return nodes.filter(node => node?.kind === 'assistant' && Number.isFinite(node.seq))
        .reduce((latest, node) => !latest || node.seq > latest.seq ? node : latest, null)
    }

    /** Keep the inline card on the latest assistant reply only. */
    function useLatestAssistant(useChat, messageId) {
      if (typeof useChat !== 'function' || !messageId) return true
      try {
        return useChat(snapshot => {
          const latest = latestChatReply(snapshot)
          return latest === null || String(latest.messageId ?? '') === String(messageId)
        })
      } catch {
        return true
      }
    }

    function useLatestTail(useChat, seq) {
      if (typeof useChat !== 'function' || !Number.isFinite(seq)) return false
      try { return useChat(snapshot => latestChatReply(snapshot)?.seq === seq) } catch { return false }
    }

    function chatStatusKey(plan) {
      if (plan?.completion) return { completed: 'completed', cancelled: 'stopped', blocked: 'blocked', partial: 'partial' }[plan.completion.outcome]
      const remaining = (plan?.tasks ?? []).filter(task => task.status !== 'accepted')
      if (plan?.cancelled || remaining.length > 0 && remaining.every(task => task.status === 'cancelled')) return 'stopped'
      switch (plan?.status) {
        case 'running': return 'running'
        case 'review': return 'review'
        case 'accepted': return plan.protocolVersion >= 2 ? 'receiptPending' : 'completed'
        case 'failed': return 'failed'
        case 'blocked': return 'blocked'
        case 'cancelled': return 'stopped'
        default: return 'waiting'
      }
    }

    const CHAT_PROGRESS_STYLES = `
.ddf-chat-progress { display:inline-flex; align-items:center; flex:0 1 auto; min-width:0; max-width:min(240px,30vw); height:24px; vertical-align:middle; }
.ddf-chat-summary { display:inline-flex; align-items:center; gap:6px; box-sizing:border-box; min-width:0; max-width:100%; height:24px; margin:0; padding:0 7px; overflow:hidden; white-space:nowrap; border:1px solid var(--dsw-alias-border-l1,#e5e6eb); border-radius:6px; background:var(--dsw-alias-bg-layer-2,#f5f6f7); color:var(--dsw-alias-label-secondary,#646a73); font:12px/1.4 system-ui,"Microsoft YaHei",sans-serif; text-align:left; cursor:pointer; }
.ddf-chat-summary:hover { border-color:var(--dsw-alias-border-l2,#c9cdd4); }
.ddf-chat-summary:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7); outline-offset:2px; }
.ddf-chat-summary:disabled { cursor:default; }
.ddf-chat-progress[data-status="running"] .ddf-chat-summary { color:var(--dsw-alias-brand-primary,#4f6ef7); }
.ddf-chat-progress[data-status="failed"] .ddf-chat-summary,.ddf-chat-progress[data-status="blocked"] .ddf-chat-summary { color:var(--dsw-alias-state-error-primary,#f54a45); }
.ddf-chat-progress[data-status="completed"] .ddf-chat-summary { color:var(--dsw-alias-state-success-primary,#1f9d55); }
.ddf-chat-dot { width:5px; height:5px; border-radius:50%; background:currentColor; flex:none; }
.ddf-chat-summary-text { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
`

    function ChatProgressAction({ t, sessionId, messageId, useChat, openView, progress }) {
      const latest = useLatestAssistant(useChat, messageId)
      const result = useChatProgress(progress, sessionId, latest, messageId)

      if (!latest || !sessionId) return null
      const data = result.data
      const plan = currentPlanOf(data, sessionId)
      const session = data?.sessions?.find(item => item.sessionId === sessionId)
      const route = plan?.routing ?? session?.route
      if (!route && !plan && !session?.source && !result.error) return null
      const tasks = plan?.tasks ?? []
      const done = tasks.filter(task => task.status === 'accepted').length
      const running = tasks.filter(task => ['starting', 'running'].includes(task.status) || ['starting', 'running'].includes(task.audit?.status)).length
      const status = chatStatusKey(plan)
      const statusText = status === 'stopped' ? t(done ? 'completion.partialStopped' : 'completion.cancelled') : t(`chat.${status}`)
      const baseSummary = result.error && !data ? t('chat.unavailable') : plan
        ? fill(t(plan.protocolVersion >= 2 || status === 'stopped' ? status === 'running' ? 'chat.activeAcceptedSummary' : 'chat.acceptedSummary'
          : status === 'completed' ? 'chat.completedSummary' : status === 'running' ? 'chat.activeSummary' : 'chat.planSummary'),
          { status: statusText, running, done, total: tasks.length })
        : route?.route === 'direct' ? t('chat.direct') : t('chat.noPlan')
      const counts = [['queued', 'waitingCount'], ['review', 'reviewCount'], ['failed', 'failedCount'], ['blocked', 'blockedCount']]
        .map(([value, key]) => ({ count: tasks.filter(task => task.status === value && !(value === 'review' && ['queued', 'starting', 'running'].includes(task.audit?.status))).length, key }))
        .concat([{ count: tasks.filter(task => ['starting', 'running'].includes(task.audit?.status)).length, key: 'auditCount' },
          { count: tasks.filter(task => task.audit?.status === 'queued').length, key: 'auditQueuedCount' }])
        .filter(item => item.count > 0).map(item => fill(t('chat.' + item.key), { count: item.count }))
      const supervised = tasks.flatMap(task => [task, ...(task.audit ? [task.audit] : [])]).filter(task => ['starting', 'running'].includes(task.status) && task.supervision?.pending)
      const pendingInputs = plan?.cancelled ? [] : (plan?.inputs ?? []).filter(input => ['queued', 'received'].includes(input.status))
      const summary = [baseSummary, ...counts, ...(pendingInputs.length ? [fill(t('input.chatPending'), { count: pendingInputs.length })] : []), ...(supervised.length ? [fill(t(supervised.every(task => task.supervision.pending.advisory) ? 'supervision.inquiryCount' : 'supervision.count'), { count: supervised.length })] : [])].join(' · ')
      const canOpen = typeof openView === 'function'
      const hint = canOpen ? t('view.details') : t('chat.navigationUnavailable')
      const label = `${summary} · ${hint}`
      const title = [plan?.goal || session?.source?.text?.slice(0, 120) || plan?.source?.text?.slice(0, 120), summary, route ? fill(t('chat.routeDecision'), { route: routeLabel(t, route) }) : '',
        result.error ? t('chat.unavailable') : '', hint].filter(Boolean).join(' · ')
      return h('span', { className: 'ddf-chat-progress', 'data-status': status, role: 'status', title },
        h('style', null, CHAT_PROGRESS_STYLES),
        h('button', { type: 'button', className: 'ddf-chat-summary', disabled: !canOpen,
          title, 'aria-label': label, onClick: canOpen ? () => openView(VIEW_ID) : undefined },
          h('span', { className: 'ddf-chat-dot', 'aria-hidden': 'true' }),
          h('span', { className: 'ddf-chat-summary-text' }, summary)))
    }

    function chatProblem(plan) {
      if (!plan || plan.status === 'accepted') return null
      const unfinished = (plan.tasks ?? []).filter(task => task.status !== 'accepted')
      const stopped = plan.status === 'cancelled' || plan.cancelled || unfinished.length > 0 && unfinished.every(task => task.status === 'cancelled')
      const affected = (plan.tasks ?? []).map(task => !stopped && ['failed', 'blocked'].includes(task.audit?.status) ? { ...task.audit, title: task.audit.title || task.title } : task).filter(task => stopped
        ? task.status !== 'accepted' : ['failed', 'blocked', 'cancelled'].includes(task.status))
      if (!affected.length && !['failed', 'blocked'].includes(plan.status)) {
        const pending = (plan.tasks ?? []).flatMap(task => [task, ...(task.audit ? [task.audit] : [])])
          .filter(task => ['starting', 'running'].includes(task.status) && task.supervision?.pending)
        return pending.length ? { kind: 'supervision', primary: pending[0], tasks: pending, affected: pending.length } : null
      }
      const primary = affected.find(task => task.status === 'failed')
        ?? affected.find(task => task.issue?.message) ?? affected.find(task => task.recovered) ?? affected[0]
      return { kind: stopped ? 'stopped' : primary?.status === 'failed' ? 'failed' : 'blocked',
        primary, tasks: stopped ? affected : primary ? [primary] : [], affected: affected.length }
    }

    const CHAT_NOTICE_STYLES = `
.ddf-chat-notice { display:block; position:static; box-sizing:border-box; min-width:0; max-width:100%; margin:12px 0; padding:10px 12px; border:1px solid var(--dsw-alias-border-l1,#e5e6eb); border-left:3px solid var(--dsw-alias-state-error-primary,#f54a45); border-radius:7px; background:var(--dsw-alias-bg-layer-1,#fff); color:var(--dsw-alias-label-primary,#1f2329); font:13px/1.6 system-ui,"Microsoft YaHei",sans-serif; overflow-wrap:anywhere; }
.ddf-chat-notice[data-kind="stopped"] { border-left-color:var(--dsw-alias-border-l2,#c9cdd4); }
.ddf-chat-notice-heading { color:var(--dsw-alias-state-error-primary,#f54a45); }
.ddf-chat-notice[data-kind="stopped"] .ddf-chat-notice-heading { color:var(--dsw-alias-label-secondary,#646a73); }
.ddf-chat-notice[data-kind="supervision"] { border-left-color:var(--dsw-alias-state-warning-primary,#b7791f); }
.ddf-chat-notice[data-kind="supervision"] .ddf-chat-notice-heading { color:var(--dsw-alias-state-warning-primary,#b7791f); }
.ddf-chat-notice[data-kind="progress"] { border-left-color:var(--dsw-alias-brand-primary,#4f6ef7); }
.ddf-chat-notice[data-kind="progress"] .ddf-chat-notice-heading { color:var(--dsw-alias-brand-primary,#4f6ef7); }
.ddf-chat-live-task + .ddf-chat-live-task { margin-top:8px; padding-top:8px; border-top:1px solid var(--dsw-alias-border-l1,#e5e6eb); }
.ddf-chat-live-meta { color:var(--dsw-alias-label-secondary,#646a73); }
.ddf-chat-plan-heading { display:flex; flex-wrap:wrap; align-items:baseline; gap:6px 18px; justify-content:space-between; }
.ddf-chat-plan-heading strong { font-size:15px; font-weight:600; }
.ddf-chat-plan-heading span,.ddf-chat-plan-results { color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; font-variant-numeric:tabular-nums; }
.ddf-chat-task-list { margin-top:10px; border-top:1px solid var(--dsw-alias-border-l1,#e5e6eb); }
.ddf-chat-task { min-width:0; border-bottom:1px solid var(--dsw-alias-border-l1,#e5e6eb); }
.ddf-chat-task-summary { display:grid; grid-template-columns:10px minmax(0,1fr) auto; align-items:center; gap:10px; padding:12px 0; cursor:pointer; list-style:none; }
.ddf-chat-task-summary::-webkit-details-marker { display:none; }
.ddf-chat-task-summary::before { content:""; width:5px; height:5px; border-right:1.5px solid currentColor; border-bottom:1.5px solid currentColor; transform:rotate(-45deg); color:var(--dsw-alias-label-secondary,#646a73); }
.ddf-chat-task[open]>.ddf-chat-task-summary::before { transform:rotate(45deg); }
.ddf-chat-task-summary:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7); outline-offset:3px; }
.ddf-chat-task-identity { display:flex; min-width:0; flex-direction:column; gap:3px; }
.ddf-chat-task-title { font-size:14px; font-weight:600; overflow-wrap:anywhere; }
.ddf-chat-task-model { display:block; min-width:0; overflow:hidden; color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; text-overflow:ellipsis; white-space:nowrap; }
.ddf-chat-task-status { padding:2px 7px; border:1px solid var(--dsw-alias-border-l1,#e5e6eb); border-radius:5px; color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; white-space:nowrap; }
.ddf-chat-task[data-status="running"]>.ddf-chat-task-summary .ddf-chat-task-status,.ddf-chat-task[data-status="starting"]>.ddf-chat-task-summary .ddf-chat-task-status { color:var(--dsw-alias-brand-primary,#4f6ef7); }
.ddf-chat-task[data-status="failed"]>.ddf-chat-task-summary .ddf-chat-task-status,.ddf-chat-task[data-status="blocked"]>.ddf-chat-task-summary .ddf-chat-task-status { color:var(--dsw-alias-state-error-primary,#f54a45); }
.ddf-chat-task[data-status="accepted"]>.ddf-chat-task-summary .ddf-chat-task-status { color:var(--dsw-alias-state-success-primary,#1f9d55); }
.ddf-chat-task-body { padding:0 0 12px 20px; }
.ddf-chat-task-actor + .ddf-chat-task-actor { margin-top:10px; padding-top:10px; border-top:1px solid var(--dsw-alias-border-l1,#e5e6eb); }
.ddf-chat-task-issue { margin-top:10px; padding:8px 10px; border-left:2px solid var(--dsw-alias-state-error-primary,#f54a45); background:var(--dsw-alias-bg-layer-2,#f5f6f7); }
.ddf-chat-task-issue[data-kind="stopped"],.ddf-chat-task-issue[data-kind="supervision"] { border-left-color:var(--dsw-alias-border-l2,#c9cdd4); }
.ddf-chat-task-decision { margin-top:10px; color:var(--dsw-alias-label-secondary,#646a73); }
.ddf-chat-task-decision>summary { padding:5px 0; cursor:pointer; }
.ddf-chat-dock { --ddf-dock-tone:var(--dsw-alias-state-business-primary,#4f6ef7); position:relative; isolation:isolate; container:ddf-progress / inline-size; width:100%; min-width:0; max-width:min(760px,calc(100% - 24px)); margin:0 auto 6px; padding:4px 0; color:var(--dsw-alias-label-primary,#1f2329); font:12px/1.5 system-ui,"Microsoft YaHei",sans-serif; }
.ddf-chat-dock[data-tone="supervision"] { --ddf-dock-tone:var(--dsw-alias-state-warning-primary,#b7791f); }
.ddf-chat-dock[data-tone="service"] { --ddf-dock-tone:var(--dsw-alias-state-error-primary,#f54a45); }
.ddf-dock-disclosure { width:fit-content; max-width:100%; margin:0 auto; }
.ddf-dock-disclosure>summary { box-sizing:border-box; display:flex; align-items:center; gap:9px; max-width:100%; height:34px; padding:0 12px; border:1px solid var(--dsw-alias-border-l1,#e5e6eb); border-radius:12px; background:var(--dsw-alias-bg-layer-1,#fff); font-size:13px; cursor:pointer; list-style:none; user-select:none; }
.ddf-dock-disclosure>summary:hover,.ddf-dock-disclosure[open]>summary { background:var(--dsw-alias-bg-layer-2,#f5f6f7); }
.ddf-dock-disclosure>summary::-webkit-details-marker { display:none; }
.ddf-dock-dot { flex:none; width:5px; height:5px; border-radius:50%; background:var(--ddf-dock-tone); }
.ddf-dock-text { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-weight:500; }
.ddf-dock-indicator { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; color:var(--dsw-alias-label-secondary,#646a73); }
.ddf-dock-activity { max-width:9em; }
.ddf-dock-model { max-width:16ch; }
.ddf-dock-calls,.ddf-dock-accepted,.ddf-dock-running,.ddf-dock-auditing,.ddf-dock-review,.ddf-dock-queued,.ddf-dock-failed,.ddf-dock-blocked,.ddf-dock-refused { display:inline-flex; flex:none; align-items:baseline; gap:4px; overflow:visible; font-variant-numeric:tabular-nums; }
.ddf-dock-calls,.ddf-dock-accepted { padding-left:9px; border-left:1px solid var(--dsw-alias-border-l1,#e5e6eb); }
.ddf-dock-indicator strong { color:var(--dsw-alias-state-business-primary,#4f6ef7); font-size:14px; font-weight:600; }
.ddf-dock-accepted strong { color:var(--dsw-alias-state-success-primary,#369b83); }
.ddf-dock-failed strong,.ddf-dock-blocked strong,.ddf-dock-refused strong { color:var(--ddf-dock-tone); }
.ddf-dock-indicator small { font-size:12px; }
.ddf-dock-call-icon { color:var(--dsw-alias-state-business-primary,#4f6ef7); }
@container ddf-progress (max-width:440px) {
 .ddf-dock-disclosure>summary { gap:6px; padding:0 9px; font-size:12px; }
 .ddf-dock-model { max-width:10ch; }
 .ddf-dock-activity { max-width:6em; }
}
.ddf-dock-toggle { flex:none; width:4px; height:4px; margin:-3px 1px 0 2px; border-right:1px solid currentColor; border-bottom:1px solid currentColor; transform:rotate(45deg); color:var(--dsw-alias-label-secondary,#646a73); }
.ddf-dock-disclosure[open] .ddf-dock-toggle { margin-top:2px; transform:rotate(225deg); }
.ddf-dock-details { box-sizing:border-box; position:absolute; z-index:1; bottom:calc(100% + 6px); left:50%; transform:translateX(-50%); width:100%; max-height:min(65vh,560px,var(--ddf-dock-available-height,560px)); overflow:auto; overscroll-behavior:contain; scrollbar-width:thin; scrollbar-color:var(--dsw-alias-label-secondary,#8f959e) var(--dsw-alias-bg-layer-1,#fff); border:1px solid var(--dsw-alias-border-l1,#e5e6eb); border-radius:12px; background:var(--dsw-alias-bg-layer-1,#fff); box-shadow:0 8px 28px color-mix(in srgb,var(--dsw-alias-label-primary,#1f2329) 12%,transparent); }
.ddf-dock-panel-head { position:sticky; top:0; z-index:1; padding:14px 20px; border-bottom:1px solid var(--dsw-alias-border-l1,#e5e6eb); background:var(--dsw-alias-bg-layer-1,#fff); font-size:16px; }
.ddf-dock-disclosure>summary:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7); outline-offset:2px; }
.ddf-chat-dock .ddf-chat-notice { margin:0; }
.ddf-dock-details .ddf-chat-notice { padding:12px 18px 16px; border:0; border-radius:0; font-size:14px; }
.ddf-dock-details .ddf-decision { margin-top:12px; padding-top:10px; border-top:1px solid var(--dsw-alias-border-l1,#e5e6eb); }
.ddf-dock-details .ddf-decision-choice { font-weight:600; }
.ddf-chat-notice p { margin:5px 0; white-space:pre-wrap; }
.ddf-chat-notice-hint { color:var(--dsw-alias-label-secondary,#646a73); }
.ddf-chat-notice-action { display:inline-block; max-width:100%; margin:4px 0 0; padding:0; border:0; background:transparent; color:var(--dsw-alias-brand-primary,#4f6ef7); font:inherit; text-align:left; overflow-wrap:anywhere; cursor:pointer; }
.ddf-chat-notice-action:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#4f6ef7); outline-offset:2px; }
.ddf-chat-notice-action:disabled { color:var(--dsw-alias-label-secondary,#646a73); cursor:default; }
.ddf-dock-details .ddf-coordinator { padding:0 20px; }
.ddf-execution-row { --ddf-section-tone:var(--ddf-dock-tone); display:grid; grid-template-columns:108px minmax(0,1fr); gap:20px; padding:18px 0; border-bottom:1px solid var(--dsw-alias-border-l1,#e5e6eb); }
.ddf-execution-row:last-child { border-bottom:0; }
.ddf-execution-row[data-section="decision"] { --ddf-section-tone:var(--dsw-alias-state-success-primary,#369b83); }
.ddf-execution-row[data-section="request"] { --ddf-section-tone:var(--dsw-alias-label-secondary,#8f959e); }
.ddf-execution-row[data-section="issues"] { --ddf-section-tone:var(--dsw-alias-state-warning-primary,#b7791f); }
.ddf-execution-label h3 { display:flex; align-items:center; gap:9px; margin:0; font-size:14px; font-weight:600; line-height:1.6; }
.ddf-execution-label h3::before { content:""; flex:none; width:6px; height:6px; border-radius:50%; background:var(--ddf-section-tone); box-shadow:0 0 0 4px color-mix(in srgb,var(--ddf-section-tone) 14%,transparent); }
.ddf-coordinator .ddf-execution-status { margin:7px 0 0 15px; color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; }
.ddf-execution-content { min-width:0; }
.ddf-execution-metrics { display:grid; grid-template-columns:minmax(0,1.15fr) minmax(0,1.15fr) minmax(0,.7fr); margin:0; }
.ddf-execution-metrics>div { min-width:0; padding:0 16px; border-left:1px solid var(--dsw-alias-border-l1,#e5e6eb); }
.ddf-execution-metrics>div:first-child { padding-left:0; border-left:0; }
.ddf-execution-metrics>div:last-child { padding-right:0; }
.ddf-execution-metrics dt { color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; }
.ddf-execution-metrics dd { margin:9px 0 0; font-size:16px; font-weight:600; line-height:1.5; overflow-wrap:anywhere; }
.ddf-execution-metrics .ddf-execution-number { color:var(--ddf-dock-tone); font-size:30px; font-variant-numeric:tabular-nums; line-height:1.2; }
.ddf-execution-number small { margin-left:4px; color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; font-weight:400; }
.ddf-execution-target { display:block; margin-top:5px; color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; font-weight:400; }
.ddf-coordinator .ddf-execution-recent { margin:12px 0 0; color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; }
.ddf-coordinator .ddf-decision { margin:0; padding:0; border:0; }
.ddf-coordinator .ddf-decision p { margin:0 0 8px; }
.ddf-coordinator .ddf-decision p:last-child { margin-bottom:0; }
.ddf-coordinator .ddf-decision-choice { color:var(--dsw-alias-state-success-primary,#369b83); }
.ddf-coordinator .ddf-chat-live-meta { font-size:12px; }
.ddf-coordinator .ddf-source { margin:0; }
@container ddf-progress (max-width:560px) {
 .ddf-execution-row { grid-template-columns:minmax(0,1fr); gap:12px; padding:16px 0; }
 .ddf-execution-label { display:flex; flex-wrap:wrap; align-items:center; gap:8px 14px; }
 .ddf-coordinator .ddf-execution-status { margin:0; }
 .ddf-execution-metrics { grid-template-columns:repeat(3,minmax(0,1fr)); }
 .ddf-execution-metrics>div { padding:0 10px; }
 .ddf-execution-metrics dd { font-size:14px; }
 .ddf-execution-metrics .ddf-execution-number { font-size:26px; }
}
`

    function completionLabel(t, receipt) {
      const stopped = receipt.outcome === 'partial' && receipt.remaining.length > 0 && receipt.remaining.every(task => task.status === 'cancelled')
      return t('completion.' + (stopped ? 'partialStopped' : receipt.outcome))
    }

    function requestRefused(task) {
      return task?.issue?.code === 'MODEL_SERVICE_REQUEST_REFUSED'
        || !task?.issue && /Illegal API invocation from an unapproved channel/i.test(task?.error || '')
    }

    function taskServiceIssue(t, task) {
      return task?.issue || (requestRefused(task) ? { code: 'MODEL_SERVICE_REQUEST_REFUSED', message: t('service.requestRefused'),
        details: task.error, action: t('service.refusalNext') } : null)
    }

    function ServiceErrorDetails({ t, details }) {
      return details ? h('details', { className: 'ddf-service-error-details' },
        h('summary', null, t('service.rawDetails')), h('p', null, details)) : null
    }

    function serviceProblem(plan) {
      if (!plan || plan.cancelled || plan.status === 'cancelled') return null
      if (plan.coordinatorIssue && !plan.coordinatorIssue.resolvedAt) return plan.coordinatorIssue
      return (plan.tasks ?? []).flatMap(task => task.audit ? [task, task.audit] : [task])
        .find(task => ['failed', 'blocked'].includes(task.status) && ['MODEL_SERVICE_QUOTA', 'MODEL_SERVICE_RATE_LIMIT', 'MODEL_SERVICE_REQUEST_REFUSED'].includes(task.issue?.code))?.issue
    }

    function ServiceIssueNotice({ t, issue }) {
      if (!issue) return null
      const refused = issue.code === 'MODEL_SERVICE_REQUEST_REFUSED'
      return h('section', { className: 'ddf-chat-notice', role: 'alert', 'data-kind': 'service' },
        h('style', null, CHAT_NOTICE_STYLES), h('strong', null, issue.message),
        refused ? h('p', null, t('service.refusalScope')) : h('p', null, issue.details),
        h('p', null, t('view.next') + '：' + issue.action),
        refused ? h(ServiceErrorDetails, { t, details: issue.details }) : null)
    }

    function completionNext(t, plan, state) {
      const receipt = plan?.completion
      if (!receipt) return ''
      const service = serviceProblem(plan)
      if (service) return service.action
      if (receipt.outcome === 'blocked') {
        const limit = state?.limits?.maxAttempts
        const exhausted = Number.isInteger(limit) && receipt.remaining.some(item => {
          const task = (plan.tasks ?? []).find(candidate => candidate.id === item.taskId)
          return task && Number.isInteger(task.attempts) && task.attempts >= limit
        })
        return exhausted ? fill(t('completion.blockedAttempts'), { limit }) : t('completion.blockedNext')
      }
      if (receipt.outcome === 'cancelled') return t('completion.cancelledNext')
      return t('completion.next')
    }

    const RECEIPT_STYLES = `
.ddf-receipt { box-sizing:border-box; min-width:0; margin:12px 0; padding:14px 16px; border:1px solid var(--dsw-alias-border-l1,#e5e6eb); border-left:3px solid var(--dsw-alias-border-l2,#c9cdd4); border-radius:7px; background:var(--dsw-alias-bg-layer-1,#fff); color:var(--dsw-alias-label-primary,#1f2329); font:13px/1.6 system-ui,"Microsoft YaHei",sans-serif; overflow-wrap:anywhere; }
.ddf-receipt[data-outcome="completed"] { border-left-color:var(--dsw-alias-state-success-primary,#1f9d55); }
.ddf-receipt[data-outcome="blocked"] { border-left-color:var(--dsw-alias-state-error-primary,#f54a45); }
.ddf-receipt p { margin:6px 0; white-space:pre-wrap; }
.ddf-receipt ul { margin:6px 0; padding-left:20px; }
.ddf-receipt details,.ddf-receipt small { color:var(--dsw-alias-label-secondary,#646a73); }
.ddf-receipt summary { cursor:pointer; }
`

    function CompletionReceipt({ t, plan, state }) {
      const receipt = plan?.completion
      if (!receipt) return null
      const service = serviceProblem(plan)
      return h('section', { className: 'ddf-receipt', 'data-outcome': receipt.outcome, role: 'status' },
        h('style', null, RECEIPT_STYLES),
        h('strong', null, t('completion.title') + ' · ' + completionLabel(t, receipt)),
        service ? h('p', null, h('strong', null, service.message), service.code === 'MODEL_SERVICE_REQUEST_REFUSED' ? '' : ' · ' + service.details) : null,
        service?.code === 'MODEL_SERVICE_REQUEST_REFUSED' ? h(ServiceErrorDetails, { t, details: service.details }) : null,
        h('p', null, fill(t('completion.accepted'), { done: receipt.accepted, total: receipt.total })),
        h('p', { className: 'ddf-receipt-next' }, completionNext(t, plan, state)),
        receipt.reason ? h('p', null, t('completion.reason') + '：' + receipt.reason) : null,
        receipt.deliverables.length ? h('div', null, h('b', null, t('completion.deliverables')),
          h('ul', null, ...receipt.deliverables.map(task => h('li', { key: task.taskId }, task.title + '：' + task.paths.join('、'))))) : null,
        receipt.remaining.length ? h('div', null, h('b', null, t('completion.remaining')),
          h('ul', null, ...receipt.remaining.map(task => h('li', { key: task.taskId }, task.title + '：' + task.reason)))) : null,
        h('details', null, h('summary', null, t('completion.evidence')),
          ...receipt.evidence.map(id => h('p', { key: id }, h('code', null, id)))),
        h('small', null, t('completion.id') + '：' + receipt.id))
    }

    function liveToolLabel(t, name, compact = false) {
      const key = { read: 'read', grep: 'search', glob: 'glob', edit: 'edit', apply_patch: 'edit', write: 'write',
        pwsh: 'command', bash: 'command', delegation_report: 'report', delegation_checkpoint: 'checkpoint' }[name]
      return key ? t('live.' + key) + (compact ? '' : `（${name}）`) : name
    }

    function ChatTaskActivity({ t, task, label, route, action }) {
      const state = task.supervision, time = value => new Date(value).toLocaleTimeString()
      return h('div', { className: 'ddf-chat-task-actor' },
        h('p', null, h('strong', null, label), ' · ', route?.model || t('dock.unknownModel')),
        h('p', null, t('live.current') + '：', action),
        ['starting', 'running'].includes(task.status) && Number.isFinite(state?.startedAt) ? h('p', { className: 'ddf-chat-live-meta' },
          fill(t('supervision.elapsed'), { minutes: Math.max(0, Math.floor((Date.now() - state.startedAt) / 60000)) }),
          state.lastActivityAt ? ' · ' + t('live.activityAt') + ' ' + time(state.lastActivityAt) : '') : null,
        task.progress?.tool ? h('p', { className: 'ddf-chat-live-meta' }, t('live.recent') + '：', liveToolLabel(t, task.progress.tool),
          task.progress.at ? ' · ' + time(task.progress.at) : '', task.progress.failed ? ' · ' + t('live.toolFailed') : '') : null,
        state?.checkpoint?.summary ? h('p', null, t('supervision.stage') + '：' + state.checkpoint.summary) : null)
    }

    function ChatLiveProgress({ t, plan, openView, error }) {
      const tasks = plan?.tasks ?? [], accepted = tasks.filter(task => task.status === 'accepted').length
      if (!tasks.length || plan.completion || accepted === tasks.length && plan.protocolVersion < 2) return null
      const live = task => ['starting', 'running'].includes(task.status)
      const running = tasks.filter(task => live(task) || live(task.audit ?? {})).length
      const waiting = tasks.filter(task => task.status === 'queued' || task.audit?.status === 'queued').length
      const waitingOnDependencies = task => (task.dependsOn ?? []).some(id => tasks.some(other => other.id === id && other.status !== 'accepted'))
      const routeOf = task => task?.modelRoute?.actual ?? task?.modelRoute?.resolved ?? task?.modelRoute?.requested ?? task?.model
      const current = (task, target = task) => {
        if (live(target)) {
          if (target.status === 'starting') return t('status.starting')
          if (target.execution) return t('supervision.reporting')
          const activity = target.supervision?.activity
          return activity?.kind === 'tool' ? liveToolLabel(t, activity.tool)
            : activity?.kind ? t('supervision.activity.' + activity.kind) : t('live.unknown')
        }
        if (target !== task) return t('audit.' + target.status)
        if (task.status === 'review') return t('view.acceptanceReview')
        if (task.status === 'queued') return plan.dispatchWait?.message || t(waitingOnDependencies(task) ? 'view.actualDependency' : 'view.actualQueued')
        return t('status.' + task.status)
      }
      return h('section', { className: 'ddf-chat-notice ddf-chat-live', 'data-kind': 'progress', role: 'status' },
        h('style', null, CHAT_NOTICE_STYLES),
        h('div', { className: 'ddf-chat-plan-heading', 'aria-label': t('live.title') },
          h('strong', null, fill(t('dock.taskCount'), { count: tasks.length })), h('span', null, fill(t('live.counts'), { running, waiting }))),
        h('p', { className: 'ddf-chat-plan-results' }, fill(t('live.results'), {
          returned: tasks.filter(task => ['review', 'accepted'].includes(task.status)).length, accepted, total: tasks.length })),
        error ? h('p', { className: 'ddf-chat-live-meta' }, t('view.staleTitle')) : null,
        h('div', { className: 'ddf-chat-task-list' }, ...tasks.map((task, index) => {
          const audit = task.audit, auditing = audit && ['queued', 'starting', 'running', 'failed', 'blocked'].includes(audit.status)
          const target = task.status === 'accepted' || task.status === 'cancelled' ? task : auditing ? audit : task
          const route = routeOf(target) ?? (target === audit ? task.dispatcherModel : null)
          const status = requestRefused(target) && ['failed', 'blocked'].includes(target.status) ? t('dock.requestRefused')
            : target === audit ? live(audit) ? t('accordion.reviewing') : t('audit.' + audit.status)
              : task.status === 'queued' && waitingOnDependencies(task) ? t('accordion.dependency') : t('status.' + task.status)
          const problem = task.status === 'accepted' ? null : chatProblem({ status: task.status, cancelled: plan.cancelled, tasks: [task] })
          const checks = task.checks ?? []
          return h('details', { key: task.id, className: 'ddf-chat-task', 'data-task-id': task.id, 'data-status': target.status, open: index === 0 },
            h('summary', { className: 'ddf-chat-task-summary' },
              h('span', { className: 'ddf-chat-task-identity' }, h('strong', { className: 'ddf-chat-task-title' }, task.title || task.id),
                h('span', { className: 'ddf-chat-task-model', title: route ? `${route.provider} / ${route.model}` : undefined },
                  t(target === audit ? 'audit.title' : 'accordion.worker') + ' · ' + (route?.model || t('dock.unknownModel')))),
              h('span', { className: 'ddf-chat-task-status' }, status)),
            h('div', { className: 'ddf-chat-task-body' },
              task.scope ? h('p', { className: 'ddf-chat-live-meta' }, t('accordion.scope') + '：' + task.scope) : null,
              h(ChatTaskActivity, { t, task, label: t('accordion.worker'), route: routeOf(task), action: current(task) }),
              task.execution?.summary ? h('p', null, t('accordion.report') + '：' + task.execution.summary) : null,
              audit ? h(ChatTaskActivity, { t, task: audit, label: t('audit.title'), route: routeOf(audit) ?? task.dispatcherModel, action: current(task, audit) }) : null,
              audit?.execution?.summary ? h('p', null, t('accordion.auditReport') + '：' + audit.execution.summary) : null,
              h('p', { className: 'ddf-chat-live-meta' }, t('accordion.acceptance') + '：' + t(task.status === 'accepted' ? 'status.accepted'
                : task.status === 'cancelled' ? 'view.acceptanceStopped' : 'view.acceptanceReview'), ' · ', checks.length
                ? fill(t('accordion.verified'), { passed: checks.filter(check => check.result?.passed).length, total: checks.length }) : t('accordion.noChecks')),
              h(ChatPlanProblem, { t, plan, problem, compact: true, ownerId: task.id })))
        })),
        h('details', { className: 'ddf-chat-task-decision' }, h('summary', null, t('dock.decision')),
          h(DecisionDetails, { t, decision: plan.decision, current: plan.decisionCurrent !== false, resolution: plan.messageResolution, pending: plan.pendingMessages })),
        typeof openView === 'function' ? h('button', { type: 'button', className: 'ddf-chat-notice-action',
          onClick: () => openView(VIEW_ID) }, t('view.details')) : null)
    }

    const deliveryMessages = new Map()
    function DeliveryMessage({ t, delivery, openFile }) {
      const failed = delivery.status === 'failed'
      return h('section', { className: 'ddf-delivery', 'data-delivery-receipt': delivery.receiptId },
        h('style', null, '.ddf-delivery{margin:18px 0;color:var(--dsw-alias-label-primary,#1f2329);font:inherit;line-height:1.8;overflow-wrap:anywhere}.ddf-delivery>p{margin:10px 0}.ddf-delivery-files{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}.ddf-delivery-files button{border:1px solid var(--dsw-alias-border-l1,#d0d3d8);border-radius:6px;padding:7px 12px;background:transparent;color:inherit;font:inherit;cursor:pointer}.ddf-delivery-document{margin-top:22px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1,#e5e6eb)}.ddf-delivery-document p{white-space:pre-wrap;margin:12px 0}.ddf-delivery-document h2,.ddf-delivery-document h3{margin:20px 0 10px;line-height:1.5}.ddf-delivery-error{color:var(--dsw-alias-state-danger-primary,#d14343)}'),
        h('div', { role: failed ? 'alert' : 'status' }, h('strong', null, t(delivery.status === 'pending' ? 'delivery.pending' : failed ? 'delivery.failed' : 'delivery.title')),
          ' · ', fill(t('completion.accepted'), { done: delivery.accepted, total: delivery.total })),
        h('p', null, delivery.summary),
        failed ? h('p', { className: 'ddf-delivery-error' }, delivery.error, '。', t('delivery.failedHint')) : null,
        h('div', { className: 'ddf-delivery-files' }, ...(delivery.files ?? []).map(file => typeof openFile === 'function'
          ? h('button', { key: file.path, type: 'button', 'data-delivery-file': file.path, title: file.path, onClick: () => openFile(file.path) }, file.label)
          : h('p', { key: file.path }, file.label, '：', h('code', null, file.path)))),
        ...(delivery.documents ?? []).map(document => h('article', { key: document.path || document.label, className: 'ddf-delivery-document' },
          document.error ? h('p', { className: 'ddf-delivery-error' }, t('delivery.readFailed'), document.label, '（', document.error, '）')
            : (document.content || '').split(/\r?\n\s*\r?\n/).map((paragraph, index) => {
              const heading = /^(#{1,6})\s+([^\r\n]+)$/.exec(paragraph)
              return heading ? h('h' + Math.min(heading[1].length + 1, 6), { key: index }, heading[2]) : h('p', { key: index }, paragraph)
            }),
          document.truncated ? h('p', null, t('delivery.preview')) : null)),
        ...(delivery.remaining ?? []).map(task => h('p', { key: task.taskId }, task.title, '：', task.reason)))
    }
    function ChatIssueNotice({ t, sessionId, seq, useChat, openView, openFile, progress }) {
      const latest = useLatestTail(useChat, seq)
      const result = useChatProgress(progress, sessionId, latest, seq)
      const active = (result.data?.plans ?? []).find(plan => plan.sessionId === sessionId && plan.delivery?.anchorSeq === seq)?.delivery
      const [saved, setSaved] = useState(null)
      useEffect(() => {
        if (!sessionId || !Number.isSafeInteger(seq) || active) return undefined
        let alive = true
        const key = sessionId + ':' + seq
        const load = deliveryMessages.get(key) ?? fetch('/dsh-delegation-first/api/delivery?sessionId=' + encodeURIComponent(sessionId) + '&seq=' + seq)
          .then(response => response.ok ? response.json() : null).then(body => body?.ok && body.delivery?.sessionId === sessionId && body.delivery.anchorSeq === seq ? body.delivery : null)
          .catch(() => null)
        if (!deliveryMessages.has(key)) {
          if (deliveryMessages.size >= 32) deliveryMessages.delete(deliveryMessages.keys().next().value)
          deliveryMessages.set(key, load)
        }
        load.then(delivery => {
          if (delivery?.status !== 'delivered') deliveryMessages.delete(key)
          if (alive) setSaved({ key, delivery })
        })
        return () => { alive = false }
      }, [sessionId, seq, Boolean(active), active?.status])
      const delivery = active ?? (saved?.key === sessionId + ':' + seq ? saved.delivery : null)
      if (delivery) return h(DeliveryMessage, { t, delivery, openFile })
      if (!latest || !sessionId) return null
      const plan = currentPlanOf(result.data, sessionId)
      if (!plan) return null
      if (!plan.completion) return h(ChatPlanNotice, { t, plan, openView, error: result.error })
      if (plan.coordinatorIssue && !plan.coordinatorIssue.resolvedAt && !plan.cancelled) return null
      return h(CompletionReceipt, { t, plan, state: result.data })
    }

    function ChatProgressDock({ t, sessionId, session, progress }) {
      // The host mounts the input dock while a turn is still running. Its running
      // transition also refreshes a terminal snapshot when the next turn starts.
      const result = useChatProgress(progress, sessionId, true, session?.running)
      const dockRef = useRef(null)
      const fitDetails = () => {
        const dock = dockRef.current
        if (!dock) return
        const top = Math.max(0, dock.closest('[data-conversation-scroll]')?.getBoundingClientRect().top ?? 0)
        dock.style.setProperty('--ddf-dock-available-height', Math.max(0, dock.getBoundingClientRect().top - top - 16) + 'px')
      }
      useEffect(() => {
        if (typeof document === 'undefined') return
        const close = event => {
          const disclosure = dockRef.current?.querySelector('details')
          if (!disclosure?.open || event.type === 'keydown' && event.key !== 'Escape' || event.type === 'pointerdown' && dockRef.current.contains(event.target)) return
          disclosure.open = false
          if (event.type === 'keydown') disclosure.querySelector('summary')?.focus()
        }
        document.addEventListener('pointerdown', close)
        document.addEventListener('keydown', close)
        window.addEventListener('resize', fitDetails)
        return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); window.removeEventListener('resize', fitDetails) }
      }, [sessionId])
      const savedPlan = currentPlanOf(result.data, sessionId)
      const state = result.data?.sessions?.find(item => item.sessionId === sessionId)
      const availability = state?.delegationAvailability
      const missing = availability?.status === 'unavailable' ? h('section', { className: 'ddf-chat-notice', 'data-kind': 'service', role: 'alert' },
        h('style', null, CHAT_NOTICE_STYLES), h('strong', null, t('direct.unavailable')),
        availability.missingTools?.length ? h('p', null, availability.missingTools.join('、')) : null,
        h('p', null, t('direct.checkPlugin'))) : null
      const execution = state?.execution, failures = execution?.unresolvedChanges ?? []
      const backendMissing = result.errorStatus === 404 || result.error && !result.data
      const terminal = savedPlan && (savedPlan.protocolVersion >= 2 ? savedPlan.completion : savedPlan.completion || savedPlan.status === 'accepted') && !(savedPlan.coordinatorIssue && !savedPlan.coordinatorIssue.resolvedAt && !savedPlan.cancelled)
      const plan = terminal && (execution?.running || failures.length) ? null : savedPlan
      if (!backendMissing && !missing && (plan ? terminal : !execution?.running && !failures.length)) return null
      let summary, content, tone = 'progress'
      const indicators = []
      if (backendMissing) {
        summary = t('dock.offline'); tone = 'service'
        content = h('section', { className: 'ddf-chat-notice', role: 'alert' }, h('strong', null, t('direct.backendMissing')),
          h('p', null, t('direct.backendHint')), h('p', null, result.error))
      } else if (missing) {
        summary = t('dock.unavailable'); content = missing; tone = 'service'
      } else if (plan) {
        const tasks = plan.tasks ?? [], status = chatStatusKey(plan), done = tasks.filter(task => task.status === 'accepted').length
        const running = tasks.filter(task => ['starting', 'running'].includes(task.status) || ['starting', 'running'].includes(task.audit?.status)).length
        summary = status === 'stopped' ? t(done ? 'completion.partialStopped' : 'completion.cancelled')
          : tasks.length ? fill(t('dock.taskCount'), { count: tasks.length }) : t('chat.' + status)
        if (running) {
          const kind = tasks.some(task => ['starting', 'running'].includes(task.status)) ? 'running' : 'auditing', prefix = t('dock.' + kind)
          indicators.push({ kind, text: prefix + ' ' + running, prefix, value: running })
        }
        const review = tasks.filter(task => task.status === 'review' && !['queued', 'starting', 'running'].includes(task.audit?.status)).length
        if (review) indicators.push({ kind: 'review', text: t('dock.awaitingReview') + ' ' + review, prefix: t('dock.awaitingReview'), value: review })
        if (status === 'receiptPending') indicators.push({ kind: 'receipt', text: t('chat.receiptPending') })
        const queued = tasks.filter(task => task.status === 'queued' || task.audit?.status === 'queued').length
        if (queued) indicators.push({ kind: 'queued', text: t('dock.waiting') + ' ' + queued, prefix: t('dock.waiting'), value: queued })
        const problems = tasks.map(task => ['failed', 'blocked'].includes(task.audit?.status) ? task.audit : task)
        const refused = problems.filter(task => ['failed', 'blocked'].includes(task.status) && requestRefused(task)).length
        if (refused) indicators.push({ kind: 'refused', text: t('dock.requestRefused') + ' ' + refused, prefix: t('dock.requestRefused'), value: refused })
        for (const kind of ['failed', 'blocked']) {
          const count = problems.filter(task => task.status === kind && !requestRefused(task)).length
          if (count) indicators.push({ kind, text: t('dock.' + kind) + ' ' + count, prefix: t('dock.' + kind), value: count })
        }
        if (tasks.length) indicators.push({ kind: 'accepted', text: t('dock.accepted') + ' ' + done + '/' + tasks.length,
          prefix: t('dock.accepted'), value: done + '/' + tasks.length })
        content = h(ChatPlanNotice, { t, plan, error: result.error })
        tone = serviceProblem(plan) || ['failed', 'blocked'].includes(status) ? 'service' : chatProblem(plan) || plan.coordinationIssue && !plan.coordinationIssue.resolvedAt ? 'supervision' : 'progress'
      } else {
        summary = failures.length ? t(execution.running ? 'dock.repairing' : 'direct.incomplete') : t('dock.coordinator')
        const activity = execution.activity, action = activity?.kind === 'tool' ? liveToolLabel(t, activity.tool, true)
          : activity?.kind ? t('supervision.activity.' + activity.kind) : null
        if (execution.running && action) indicators.push({ kind: 'activity', text: action })
        if (execution.model?.model) indicators.push({ kind: 'model', text: execution.model.model })
        if (Number.isFinite(execution.toolCalls)) indicators.push({ kind: 'calls', text: fill(t('direct.calls'), { count: execution.toolCalls }),
          value: execution.toolCalls, unit: t('dock.callsUnit') })
        content = h(CoordinatorProgress, { t, state, error: result.error })
        tone = failures.length ? execution.running ? 'supervision' : 'service' : 'progress'
      }
      const identity = [sessionId, state?.source?.messageId || plan?.source?.messageId, plan ? plan.createdAt : execution?.startedAt,
        backendMissing ? 'backend' : missing ? 'unavailable' : plan ? 'plan' : failures.length ? 'change-failed' : 'direct', plan ? '' : failures.map(item => item.callId).join(',')].join(':')
      const label = [summary, ...indicators.map(item => item.text), t('dock.details')].join('，')
      return h('div', { className: 'ddf-chat-dock', 'data-tone': tone, ref: dockRef }, h('style', null, CHAT_NOTICE_STYLES),
        h('details', { className: 'ddf-dock-disclosure', key: identity, onToggle: fitDetails },
          h('summary', { title: label, 'aria-label': label }, h('span', { className: 'ddf-dock-dot', 'aria-hidden': 'true' }),
            h('span', { className: 'ddf-dock-text', role: 'status' }, summary),
            ...indicators.map(item => h('span', { key: item.kind, className: 'ddf-dock-indicator ddf-dock-' + item.kind, title: item.text },
              ...(item.value === undefined ? [item.text] : [item.kind === 'calls' ? h('span', { className: 'ddf-dock-call-icon', 'aria-hidden': 'true' }, '↗')
                : h('small', null, item.prefix), h('strong', null, item.value), item.unit ? h('small', null, item.unit) : null]))),
            h('span', { className: 'ddf-dock-toggle', 'aria-hidden': 'true' })),
          h('div', { className: 'ddf-dock-details', role: 'region', 'aria-label': t('dock.details') },
            h('div', { className: 'ddf-dock-panel-head' }, h('strong', null, t('dock.details'))), content)))
    }

    function AssociationDetails({ t, resolution, pending = [] }) {
      return h('div', { className: 'ddf-association' },
        pending.length ? h('p', null, t('relation.pending') + '：' + pending.map(message => message.text).join('；'))
          : resolution ? h('p', { className: 'ddf-chat-live-meta' }, t('relation.title') + '：' + t('relation.' + resolution.relation)) : null)
    }

    function DecisionDetails({ t, decision, current = true, preparing = false, resolution, pending = [] }) {
      if (!decision) return h('div', { className: 'ddf-decision' }, h(AssociationDetails, { t, resolution, pending }), h('p', { className: 'ddf-chat-live-meta' }, t(preparing ? 'decision.pending' : 'decision.unrecorded')))
      return h('div', { className: 'ddf-decision' },
        h(AssociationDetails, { t, resolution, pending }),
        h('p', { className: 'ddf-decision-choice' }, t('decision.title') + '：' + t('decision.' + decision.mode)),
        !current && !pending.length ? h('p', null, t('decision.revised')) : null,
        h('p', null, t('decision.reason') + '：' + decision.reason),
        h('p', { className: 'ddf-chat-live-meta' }, decision.model?.model || '—',
          decision.at ? ' · ' + t('decision.at') + '：' + new Date(decision.at).toLocaleTimeString() : ''))
    }

    function CoordinatorProgress({ t, state, error }) {
      const execution = state?.execution
      if (!execution || !execution.running && !execution.unresolvedChanges?.length) return null
      const failures = execution.unresolvedChanges ?? [], activity = execution.activity
      const current = activity?.kind === 'tool' ? liveToolLabel(t, activity.tool)
        : activity?.kind ? t('supervision.activity.' + activity.kind) : t('live.unknown')
      const calls = Number.isFinite(execution.toolCalls) ? execution.toolCalls : null
      return h('section', { className: 'ddf-chat-notice ddf-chat-live ddf-coordinator', 'data-kind': failures.length ? execution.running ? 'supervision' : 'service' : 'progress', role: failures.length && !execution.running ? 'alert' : 'status' },
        h('style', null, CHAT_NOTICE_STYLES),
        error ? h('p', null, t('direct.stale')) : null,
        h('div', { className: 'ddf-execution-row', 'data-section': 'current' },
          h('div', { className: 'ddf-execution-label' }, h('h3', null, t('dock.execution')),
            h('p', { className: 'ddf-execution-status' }, t(failures.length ? execution.running ? 'direct.repairing' : 'direct.incomplete' : state.decision?.mode === 'direct' ? 'direct.title' : 'direct.preparing'))),
          h('div', { className: 'ddf-execution-content' },
            h('dl', { className: 'ddf-execution-metrics' },
              h('div', null, h('dt', null, t('dock.activity')), h('dd', { 'data-metric': 'activity' }, execution.running ? current : t('direct.incomplete'),
                execution.running && activity?.target ? h('span', { className: 'ddf-execution-target' }, activity.target) : null)),
              h('div', null, h('dt', null, t('role.coordinator')), h('dd', { 'data-metric': 'model' }, execution.model?.model || t('dock.unknownModel'))),
              h('div', null, h('dt', null, t('dock.toolCalls')), h('dd', { className: 'ddf-execution-number', 'data-metric': 'calls',
                title: calls === null ? undefined : fill(t('direct.calls'), { count: calls }) }, calls ?? '—', calls === null ? null : h('small', null, t('dock.callsUnit'))))),
            execution.lastResult ? h('p', { className: 'ddf-execution-recent' }, t('live.recent') + '：' + liveToolLabel(t, execution.lastResult.tool),
              execution.lastResult.target ? ' · ' + execution.lastResult.target : '', execution.lastResult.failed ? ' · ' + t('live.toolFailed') : '') : null)),
        h('div', { className: 'ddf-execution-row', 'data-section': 'decision' },
          h('div', { className: 'ddf-execution-label' }, h('h3', null, t('dock.decision'))),
          h('div', { className: 'ddf-execution-content' },
            h(DecisionDetails, { t, decision: state.decision, current: state.decisionCurrent !== false, preparing: execution.running, resolution: state.messageResolution, pending: state.pendingMessages }),
            state.decision?.mode === 'delegate' && state.decisionCurrent !== false ? h('p', { className: 'ddf-chat-live-meta' }, t('decision.notStarted'))
              : state.route?.route && state.route.route !== 'direct' ? h('p', { className: 'ddf-chat-live-meta' }, t('direct.advice')) : null)),
        failures.length ? h('div', { className: 'ddf-execution-row', 'data-section': 'issues' },
          h('div', { className: 'ddf-execution-label' }, h('h3', null, t('dock.issues'))),
          h('div', { className: 'ddf-execution-content' }, ...failures.map(item => h('p', { key: item.callId }, (item.target || item.tool) + '：' + item.reason)))) : null,
        state.source?.text ? h('div', { className: 'ddf-execution-row', 'data-section': 'request' },
          h('div', { className: 'ddf-execution-label' }, h('h3', null, t('view.request'))),
          h('div', { className: 'ddf-execution-content' }, h('p', { className: 'ddf-source' }, state.source.text))) : null)
    }

    function CoordinationIssueNotice({ t, plan }) {
      const issue = plan?.coordinationIssue
      if (!issue || issue.resolvedAt || plan.completion) return null
      return h('section', { className: 'ddf-chat-notice', 'data-kind': 'coordination', role: 'status' },
        h('strong', null, t(issue.role === 'coordinator' || !issue.role ? 'coordination.coordinator' : 'coordination.worker')),
        h('p', null, issue.tool + '：' + issue.message), h('p', null, t('view.next') + '：' + issue.nextAction))
    }

    function ChatPlanNotice({ t, plan, openView, error }) {
      return h('div', null,
        h(CoordinationIssueNotice, { t, plan }), h(ChatPlanBody, { t, plan, openView, error }))
    }

    function ChatPlanBody({ t, plan, openView, error }) {
      const progress = h(ChatLiveProgress, { t, plan, openView, error })
      if (plan?.coordinatorIssue && !plan.coordinatorIssue.resolvedAt && !plan.cancelled) return h('div', null, progress, h(ServiceIssueNotice, { t, issue: plan.coordinatorIssue }))
      return plan?.tasks?.length ? progress : h(ChatPlanProblem, { t, plan, problem: chatProblem(plan), openView, error })
    }

    function ChatPlanProblem({ t, plan, problem, openView, error, compact = false, ownerId }) {
      if (!problem) return null
      const task = problem.primary, tasks = plan.tasks ?? []
      const issue = taskServiceIssue(t, task), refused = requestRefused(task) && problem.kind !== 'stopped'
      const recorded = problem.kind === 'supervision' ? task.supervision.pending.reason : task?.stop?.reason || issue?.message || task?.error
      const reason = typeof recorded === 'string' && recorded.trim() && !/^(error|子任务停止原因：error)$/i.test(recorded.trim())
        ? recorded.trim().split('\n')[0].slice(0, 400)
        : t(task?.recovered ? 'chat.recoveredReason' : 'chat.unknownReason')
      const next = problem.kind === 'supervision' ? t('supervision.next') : problem.kind === 'stopped' ? t('chat.stoppedNext')
        : issue?.action || t(task?.recovered ? 'view.recoveredNext' : 'view.failedNext')
      const done = tasks.filter(task => task.status === 'accepted').length
      const heading = fill(t(problem.kind === 'stopped' || problem.kind === 'supervision' ? 'chat.acceptedSummary' : 'chat.planSummary'), {
        status: refused ? t('dock.requestRefused') : problem.kind === 'supervision' ? t(task.supervision.pending.advisory ? 'supervision.inquiry' : 'supervision.waiting') : problem.kind === 'stopped' ? t(done ? 'completion.partialStopped' : 'completion.cancelled') : t(`chat.${problem.kind}`), done, total: tasks.length })
      const canOpen = !compact && typeof openView === 'function'
      return h('section', { className: compact ? 'ddf-chat-task-issue' : 'ddf-chat-notice', 'data-kind': problem.kind,
        role: problem.kind === 'stopped' ? 'status' : 'alert', 'aria-label': heading },
        h('style', null, CHAT_NOTICE_STYLES),
        !compact || problem.kind === 'supervision' ? h('strong', { className: 'ddf-chat-notice-heading' }, compact
          ? t(task.supervision.pending.advisory ? 'supervision.inquiry' : 'supervision.waiting') : heading) : null,
        error ? h('p', { className: 'ddf-chat-notice-hint' }, t('view.staleTitle')) : null,
        compact ? null : h('p', null, h('strong', null, t('chat.issueTask') + '：'),
          problem.tasks.map(item => item.title || item.id).join('、') || t('chat.unknownTask')),
        h('p', null, h('strong', null, t('chat.issueReason') + '：'), reason),
        refused ? h('p', { className: 'ddf-chat-live-meta' }, t('service.refusalScope')) : null,
        h('p', null, h('strong', null, t('view.next') + '：'), next),
        problem.kind !== 'stopped' && tasks.some(item => item.id !== ownerId && (['starting', 'running'].includes(item.status) || ['starting', 'running'].includes(item.audit?.status)))
          ? h('p', { className: 'ddf-chat-live-meta' }, t('chat.othersContinue')) : null,
        refused ? h(ServiceErrorDetails, { t, details: issue.details || task.error }) : null,
        problem.kind !== 'stopped' && problem.affected > 1
          ? h('p', { className: 'ddf-chat-notice-hint' }, fill(t('chat.affected'), { count: problem.affected })) : null,
        canOpen ? h('button', { type: 'button', className: 'ddf-chat-notice-action',
          onClick: () => openView(VIEW_ID) }, t('view.details')) : null)
    }

    // -----------------------------------------------------------------------
    // Configuration styles follow the host theme.
    // -----------------------------------------------------------------------

    const CONFIG_STYLES = `
.ddf-settings {
 --bg-layer-1:var(--dsw-alias-bg-layer-1,#fff); --bg-layer-2:var(--dsw-alias-bg-layer-2,#f7f8fa); --bg-layer-3:var(--dsw-alias-bg-layer-3,#f1f2f4);
 --border-l1:var(--dsw-alias-border-l1,#e5e6eb); --border-l2:var(--dsw-alias-border-l2,#c9cdd4);
 --label-primary:var(--dsw-alias-label-primary,#1f2329); --label-secondary:var(--dsw-alias-label-secondary,#646a73); --label-tertiary:var(--dsw-alias-label-tertiary,#8f959e);
 --success:var(--dsw-alias-state-success-primary,#1f9d55); --error:var(--dsw-alias-state-danger-primary,#d14343); --error-2:var(--dsw-alias-state-error-primary,#f54a45); --warn:var(--dsw-alias-state-warning-primary,#c78300);
 --brand:var(--dsw-alias-brand-primary,#4f6ef7); --primary-fill:var(--dsw-alias-button-primary-fill,#4f6ef7); --primary-foreground:var(--dsw-alias-label-primary-foreground,#fff); --hover-bg:var(--dsw-alias-interactive-bg-hover,var(--bg-layer-2)); --focus:var(--dsw-alias-state-business-primary,var(--brand)); --font:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
 color:var(--label-primary); font-family:var(--font); -webkit-font-smoothing:antialiased; }
.ddf-settings *, .ddf-settings *::before, .ddf-settings *::after {box-sizing:border-box}
.ddf-settings [hidden]{display:none !important}
.ddf-settings button{font-family:inherit}
.ddf-settings{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--bg-layer-1);font-size:14px}
.ddf-settings .ddf-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:24px 32px 16px;border-bottom:1px solid var(--border-l1);flex:none}
.ddf-settings .ddf-heading{min-width:0}
.ddf-settings .ddf-title{margin:0;font-size:19px;font-weight:650;letter-spacing:-.01em}
.ddf-settings .ddf-sub{margin:7px 0 0;font-size:13px;line-height:1.6;color:var(--label-secondary);max-width:600px}
.ddf-settings .ddf-head-right{display:flex;align-items:center;gap:8px;flex:none;padding-top:3px}
.ddf-settings .ddf-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;border:1px solid var(--success);color:var(--success);background:var(--bg-layer-1);font-size:12px;white-space:nowrap}
.ddf-settings .ddf-badge .dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.ddf-settings .ddf-badge[data-tone="off"]{border-color:var(--border-l1);color:var(--label-secondary)}
.ddf-settings .ddf-badge[data-tone="danger"]{border-color:var(--error);color:var(--error)}
.ddf-settings .ddf-source{display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border:1px solid var(--border-l1);border-radius:7px;font-size:11.5px;color:var(--label-secondary);background:var(--bg-layer-2);white-space:nowrap}
.ddf-settings .ddf-tabs{display:flex;align-items:stretch;gap:2px;padding:0 32px;border-bottom:1px solid var(--border-l1);flex:none;overflow-x:auto}
.ddf-settings .ddf-tab{position:relative;height:44px;padding:0 15px;border:0;background:none;color:var(--label-secondary);font-size:13px;cursor:pointer;white-space:nowrap}
.ddf-settings .ddf-tab:hover{color:var(--label-primary)}
.ddf-settings .ddf-tab[data-on="true"]{color:var(--label-primary);font-weight:600}
.ddf-settings .ddf-tab[data-on="true"]::after{content:"";position:absolute;left:12px;right:12px;bottom:-1px;height:2px;background:var(--brand);border-radius:2px}
.ddf-settings .ddf-tab:focus-visible{outline:2px solid var(--brand);outline-offset:-4px}
.ddf-settings .ddf-tab .count{display:inline-block;margin-left:6px;padding:0 5px;border-radius:5px;background:var(--bg-layer-2);color:var(--error);font:600 11px/16px var(--mono)}
.ddf-settings .ddf-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:18px 32px 24px;display:flex;flex-direction:column;gap:12px}
.ddf-settings .ddf-body::-webkit-scrollbar{width:8px}
.ddf-settings .ddf-body::-webkit-scrollbar-thumb{background:var(--border-l2);border-radius:8px}
.ddf-settings .ddf-banner{padding:10px 13px;border-radius:9px;font-size:12.5px;line-height:1.6;flex:none}
.ddf-settings .ddf-banner strong{font-weight:650}
.ddf-settings .ddf-banner[data-kind="error"]{border:1px solid var(--error);color:var(--error);background:var(--bg-layer-2)}
.ddf-settings .ddf-banner[data-kind="warn"]{border:1px solid var(--warn);color:var(--warn);background:var(--bg-layer-2)}
.ddf-settings .ddf-banner[data-kind="success"]{border:1px solid var(--success);color:var(--success);background:var(--bg-layer-2)}
.ddf-settings .ddf-banner[data-kind="info"]{border:1px solid var(--border-l1);color:var(--label-secondary);background:var(--bg-layer-2)}
.ddf-settings .ddf-banner .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}
.ddf-settings .ddf-mini-btn{height:26px;padding:0 10px;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit;font-size:12px;cursor:pointer;opacity:.9}
.ddf-settings .ddf-mini-btn:hover{opacity:1;background:var(--hover-bg)}
.ddf-settings .ddf-mini-btn[data-ghost]{border-color:var(--border-l2);color:var(--label-secondary)}
.ddf-settings .ddf-card{flex:none;border:1px solid var(--border-l1);border-radius:12px;background:var(--bg-layer-1);padding:16px 18px 18px;display:flex;flex-direction:column;gap:14px}
.ddf-settings .ddf-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.ddf-settings .ddf-card-title{margin:0;font-size:13.5px;font-weight:650}
.ddf-settings .ddf-card-sub{margin:5px 0 0;font-size:12px;line-height:1.6;color:var(--label-secondary);max-width:640px}
.ddf-settings .ddf-card-tag{flex:none;padding:3px 8px;border:1px solid var(--border-l1);border-radius:6px;font:500 11px/1.4 var(--mono);color:var(--label-tertiary);background:var(--bg-layer-2)}
.ddf-settings .ddf-divider{height:1px;background:var(--border-l1);margin:0 -18px}
.ddf-settings .ddf-modes{display:flex;flex-direction:column;gap:7px}
.ddf-settings .ddf-mode{display:flex;align-items:flex-start;gap:11px;padding:10px 12px;border-radius:9px;border:1px solid var(--border-l1);background:var(--bg-layer-1);cursor:pointer;text-align:left;color:inherit;transition:.14s}
.ddf-settings .ddf-mode:hover{border-color:var(--border-l2)}
.ddf-settings .ddf-mode[data-on="true"]{border-color:var(--brand);box-shadow:inset 0 0 0 .5px var(--brand);background:var(--bg-layer-2)}
.ddf-settings .ddf-mode:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.ddf-settings .ddf-radio{appearance:none;width:15px;height:15px;flex:none;margin:2px 0 0;border:1.5px solid var(--border-l2);border-radius:50%;background:transparent;box-shadow:none;cursor:pointer}
.ddf-settings .ddf-radio:checked{border-color:var(--brand);background:radial-gradient(circle,var(--brand) 0 42%,transparent 46%)}
.ddf-settings .ddf-radio:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.ddf-settings .ddf-mode-label{font-size:13px;font-weight:550}
.ddf-settings .ddf-mode-hint{display:block;margin-top:3px;font-size:12px;line-height:1.55;color:var(--label-secondary)}
.ddf-settings .ddf-mode-meta{margin-left:auto;flex:none;font:500 11px/1.5 var(--mono);color:var(--label-tertiary)}
.ddf-settings .ddf-field{display:flex;flex-direction:column;gap:7px}
.ddf-settings .ddf-field-head{display:flex;align-items:center;gap:8px}
.ddf-settings .ddf-label{font-size:13px;font-weight:550;color:var(--label-primary)}
.ddf-settings .ddf-default{font:500 11px/1.4 var(--mono);color:var(--label-tertiary);padding:2px 6px;border:1px solid var(--border-l1);border-radius:5px;background:var(--bg-layer-2)}
.ddf-settings .ddf-field-line{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ddf-settings .ddf-num{display:inline-flex;align-items:center;gap:7px}
.ddf-settings .ddf-input{width:80px;height:32px;padding:0 9px;border-radius:8px;border:1px solid var(--border-l1);background:var(--bg-layer-1);color:var(--label-primary);font:inherit;font-size:13px;font-variant-numeric:tabular-nums;outline:none}
.ddf-settings .ddf-input:focus-visible{border-color:var(--focus);box-shadow:0 0 0 2px color-mix(in srgb,var(--focus) 18%,transparent)}
.ddf-settings .ddf-input[aria-invalid="true"]{border-color:var(--error);background:var(--bg-layer-2)}
.ddf-settings .ddf-unit{font-size:12px;color:var(--label-secondary)}
.ddf-settings .ddf-range{font-size:12px;line-height:1.5;color:var(--label-secondary)}
.ddf-settings .ddf-effect{margin-left:auto;flex:none;font:500 11px/1.5 var(--mono);padding:2px 7px;border-radius:5px;color:var(--success);background:var(--bg-layer-2);border:1px solid var(--success)}
.ddf-settings .ddf-effect[data-kind="later"]{color:var(--warn);background:var(--bg-layer-2);border-color:var(--warn)}
.ddf-settings .ddf-effect[data-kind="restart"]{color:var(--error);background:var(--bg-layer-2);border-color:var(--error)}
.ddf-settings .ddf-field-error{font-size:12px;color:var(--error);display:flex;align-items:center;gap:5px}
.ddf-settings .ddf-field-error::before{content:"!";display:inline-grid;place-items:center;width:14px;height:14px;border-radius:50%;background:var(--error);color:#fff;font:700 10px/1 var(--font)}
.ddf-settings .ddf-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px 26px}
.ddf-settings .ddf-note{display:flex;gap:8px;align-items:flex-start;padding:10px 12px;border-radius:9px;background:var(--bg-layer-2);border:1px solid var(--border-l1);font-size:12px;line-height:1.6;color:var(--label-secondary)}
.ddf-settings .ddf-note b{color:var(--label-primary);font-weight:600}
.ddf-settings .ddf-note .ic{flex:none;font:700 12px/1.5 var(--mono);color:var(--brand)}
.ddf-settings .ddf-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ddf-settings .ddf-catalog{font-size:12px;color:var(--label-secondary)}
.ddf-settings .ddf-models-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.ddf-settings .ddf-model-block{display:flex;flex-direction:column;gap:9px;padding:13px 14px;border:1px solid var(--border-l1);border-radius:10px;background:var(--bg-layer-1)}
.ddf-settings .ddf-model-title{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:600}
.ddf-settings .ddf-model-title code{font:500 11px/1.4 var(--mono);color:var(--label-tertiary);padding:2px 6px;border-radius:5px;background:var(--bg-layer-2)}
.ddf-settings .ddf-model-block label{font-size:12px;color:var(--label-secondary)}
.ddf-settings .ddf-select{display:flex;align-items:center;justify-content:space-between;gap:8px;height:32px;padding:0 10px;border:1px solid var(--border-l1);border-radius:8px;background:var(--bg-layer-1);font-size:13px;color:var(--label-primary)}
.ddf-settings .ddf-select[data-disabled="true"]{background:var(--bg-layer-2);color:var(--label-tertiary)}
.ddf-settings .ddf-select svg{flex:none;opacity:.5}
.ddf-settings .ddf-select[aria-invalid="true"]{border-color:var(--error)}
.ddf-settings .ddf-model-error{padding:10px 11px;border:1px solid var(--error);border-radius:8px;background:var(--bg-layer-2);color:var(--error);font-size:12px;line-height:1.6}
.ddf-settings .ddf-model-error strong{display:block;font-size:12.5px;margin-bottom:3px}
.ddf-settings .ddf-model-error code{font:500 11px/1.5 var(--mono);color:var(--label-secondary)}
.ddf-settings .ddf-empty{text-align:center;padding:30px 20px;border:1px dashed var(--border-l2);border-radius:10px;background:var(--bg-layer-2)}
.ddf-settings .ddf-empty .glyph{width:38px;height:38px;margin:0 auto 12px;border-radius:10px;border:1px solid var(--border-l2);display:grid;place-items:center;font:600 18px/1 var(--mono);color:var(--label-tertiary);background:var(--bg-layer-1)}
.ddf-settings .ddf-empty h3{margin:0;font-size:14px;font-weight:650}
.ddf-settings .ddf-empty p{margin:7px auto 14px;max-width:420px;font-size:12.5px;line-height:1.65;color:var(--label-secondary)}
.ddf-settings .ddf-info-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 28px}
.ddf-settings .ddf-info-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--border-l1);font-size:12.5px}
.ddf-settings .ddf-info-row span{color:var(--label-secondary)}
.ddf-settings .ddf-info-row b{font-weight:550;text-align:right;overflow-wrap:anywhere}
.ddf-settings .ddf-info-row code{font:500 11.5px/1.5 var(--mono);color:var(--label-primary)}
.ddf-settings .ddf-table{width:100%;border-collapse:collapse;font-size:12.5px}
.ddf-settings .ddf-table th{text-align:left;font-weight:550;color:var(--label-secondary);padding:0 10px 8px 0;border-bottom:1px solid var(--border-l1);white-space:nowrap}
.ddf-settings .ddf-table td{padding:9px 10px 9px 0;border-bottom:1px solid var(--border-l1);vertical-align:middle}
.ddf-settings .ddf-table tr:last-child td{border-bottom:0}
.ddf-settings .ddf-table td:first-child{font-weight:500}
.ddf-settings .ddf-pill{display:inline-flex;align-items:center;padding:2px 8px;border-radius:5px;font:500 11px/1.5 var(--mono);white-space:nowrap}
.ddf-settings .ddf-pill[data-k="now"]{color:var(--success);background:var(--bg-layer-2);border:1px solid var(--success)}
.ddf-settings .ddf-pill[data-k="next"]{color:var(--warn);background:var(--bg-layer-2);border:1px solid var(--warn)}
.ddf-settings .ddf-pill[data-k="restart"]{color:var(--error);background:var(--bg-layer-2);border:1px solid var(--error)}
.ddf-settings .ddf-load-issue{max-width:660px;padding:22px;border:1px solid var(--border-l1);border-radius:12px;background:var(--bg-layer-1);margin:8px 0}
.ddf-settings .ddf-load-issue .glyph{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:var(--bg-layer-2);color:var(--error);font:700 16px/1 var(--font)}
.ddf-settings .ddf-load-issue h2{margin:12px 0 7px;font-size:17px;font-weight:650}
.ddf-settings .ddf-load-issue p{margin:0 0 16px;font-size:13px;line-height:1.7;color:var(--label-secondary)}
.ddf-settings .ddf-load-issue details{margin-top:16px;font-size:12px;color:var(--label-secondary)}
.ddf-settings .ddf-load-issue summary{cursor:pointer}
.ddf-settings .ddf-load-issue pre{white-space:pre-wrap;overflow-wrap:anywhere;font:500 11.5px/1.6 var(--mono);background:var(--bg-layer-2);padding:9px 11px;border-radius:7px}
.ddf-settings .ddf-savebar{flex:none;display:flex;align-items:center;gap:12px;padding:11px 32px;border-top:1px solid var(--border-l1);background:var(--bg-layer-1);min-height:58px}
.ddf-settings .ddf-save-status{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--label-secondary);min-width:0}
.ddf-settings .ddf-save-status .dot{width:7px;height:7px;border-radius:50%;background:var(--border-l2);flex:none}
.ddf-settings .ddf-save-status[data-tone="dirty"]{color:var(--label-primary);font-weight:550}
.ddf-settings .ddf-save-status[data-tone="dirty"] .dot{background:var(--warn)}
.ddf-settings .ddf-save-status[data-tone="saved"]{color:var(--success)}
.ddf-settings .ddf-save-status[data-tone="saved"] .dot{background:var(--success)}
.ddf-settings .ddf-save-status[data-tone="failed"]{color:var(--error)}
.ddf-settings .ddf-save-status[data-tone="failed"] .dot{background:var(--error)}
.ddf-settings .ddf-save-status .sep{color:var(--border-l2)}
.ddf-settings .ddf-effect-note{font-size:12px;color:var(--label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ddf-settings .ddf-save-actions{margin-left:auto;display:flex;align-items:center;gap:9px;flex:none}
.ddf-settings .ddf-btn{height:32px;padding:0 14px;border-radius:8px;border:1px solid var(--border-l1);background:var(--bg-layer-1);color:var(--label-primary);font-size:13px;cursor:pointer;white-space:nowrap}
.ddf-settings .ddf-btn:hover{border-color:var(--border-l2)}
.ddf-settings .ddf-btn:disabled{opacity:.42;cursor:not-allowed}
.ddf-settings .ddf-btn-primary{border-color:var(--primary-fill);background:var(--primary-fill);color:var(--primary-foreground);font-weight:600}
.ddf-settings .ddf-btn-primary:hover{opacity:.92;border-color:var(--primary-fill)}
.ddf-settings .ddf-btn:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.ddf-settings .ddf-foot{flex:none;display:flex;align-items:center;gap:12px;padding:8px 32px;border-top:1px solid var(--border-l1);background:var(--bg-layer-2);font-size:11.5px;color:var(--label-tertiary);font-variant-numeric:tabular-nums}
.ddf-settings .ddf-foot .link{color:var(--label-secondary);cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.ddf-settings .ddf-foot .path{margin-left:auto;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;font-family:var(--mono);font-size:11px}
.ddf-settings[data-locked="true"] .ddf-body{opacity:.72}
.ddf-settings[data-locked="true"] input,.ddf-settings[data-locked="true"] .ddf-mode,.ddf-settings[data-locked="true"] .ddf-select{pointer-events:none}
.ddf-settings[data-locked="true"] .ddf-input,.ddf-settings[data-locked="true"] .ddf-select{background:var(--bg-layer-2);color:var(--label-tertiary)}
.ddf-settings .ddf-mode {font-size:13.3333px}
.ddf-settings .ddf-mode-text { min-width:0; }
.ddf-settings .ddf-actions {display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}
.ddf-settings .ddf-config-banners {display:flex;flex-direction:column;gap:12px;flex:none}
.ddf-settings .ddf-body > [role="tabpanel"] {flex:none}
.ddf-settings .ddf-head .ddf-dot {width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.ddf-settings .ddf-badge[data-on="false"] {border-color:var(--border-l1);color:var(--label-secondary)}
.ddf-settings .ddf-badge[data-invalid="true"] {border-color:var(--error);color:var(--error)}
.ddf-settings .ddf-tab-count {display:inline-block;margin-left:6px;padding:0 5px;border-radius:5px;background:var(--bg-layer-2);color:var(--error);font:600 11px/16px var(--mono)}
.ddf-settings .ddf-config-note code{font-family:monospace;font-size:1em;line-height:inherit}
.ddf-settings .ddf-model-block select.ddf-select {width:100%;font-family:inherit;appearance:none;padding-right:30px;background-repeat:no-repeat;background-position:right 10px center;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' fill='none' stroke='%238f959e' stroke-width='1.4'/%3E%3C/svg%3E")}
.ddf-settings .ddf-select:disabled{background-color:var(--bg-layer-2);color:var(--label-tertiary)}
.ddf-settings .ddf-table-scroll{overflow-x:auto}
.ddf-settings .ddf-timing-table th:nth-child(1){width:34%}
.ddf-settings .ddf-timing-table th:nth-child(2){width:20%}
.ddf-settings .ddf-text-button{border:0;padding:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.ddf-settings .ddf-text-button:disabled{cursor:default;opacity:.5}
.ddf-settings .ddf-text-button:focus-visible,.ddf-settings summary:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.ddf-settings .ddf-foot .ddf-file{margin-left:auto;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;font-family:var(--mono);font-size:11px}
@media(max-width:1040px){.ddf-settings .ddf-head,.ddf-settings .ddf-tabs,.ddf-settings .ddf-body,.ddf-settings .ddf-savebar,.ddf-settings .ddf-foot{padding-left:18px;padding-right:18px}}
@media(max-width:700px){.ddf-settings .ddf-grid-2,.ddf-settings .ddf-models-grid,.ddf-settings .ddf-info-grid{grid-template-columns:1fr}.ddf-settings .ddf-effect{margin-left:0}.ddf-settings .ddf-mode-meta{display:none}.ddf-settings .ddf-savebar{flex-wrap:wrap}.ddf-settings .ddf-effect-note{display:none}.ddf-settings .ddf-foot .ddf-file{display:none}}

`

    /** The mode choices, each with its one-line explanation. */
    function ModeList(props) {
      const { t, value, disabled, onChange } = props
      return h('div', { className: 'ddf-modes', role: 'radiogroup', 'aria-label': t('mode.label') },
        MODES.map((mode) => {
          const on = value === mode
          return h('label', {
            key: mode,
            className: 'ddf-mode',
            'data-on': on ? 'true' : 'false',
            // A disabled control cannot be clicked, and `disabled` on the input
            // is what carries that through to keyboard and screen readers.
            'aria-disabled': disabled ? 'true' : 'false',
          },
          h('input', {
            className: 'ddf-radio',
            type: 'radio',
            name: 'ddf-mode',
            value: mode,
            checked: on,
            disabled,
            onChange: () => onChange(mode),
          }),
          h('span', { className: 'ddf-mode-text' },
            h('span', { className: 'ddf-mode-label' }, t(`mode.${mode}`)),
            h('span', { className: 'ddf-mode-hint', style: { display: 'block' } }, t(`mode.${mode}.hint`))), mode === 'auto' ? h('span', { className: 'ddf-mode-meta' }, t('cfg.defaultMode')) : null
          )
        }))
    }

    function ConfigHeading({ t, tab, count }) {
      return h('div', { className: 'ddf-card-head' }, h('div', null,
        h('h2', { className: 'ddf-card-title' }, t('cfg.' + tab)),
        h('p', { className: 'ddf-card-sub' }, t('cfg.' + tab + 'Hint'))),
        h('span', { className: 'ddf-card-tag' }, count ? fill(t('cfg.fields'), { count }) : t('cfg.readonly')))
    }
    function ConfigNote({ title, children }) {
      return h('div', { className: 'ddf-note ddf-config-note' }, h('span', { className: 'ic', 'aria-hidden': true }, 'i'),
        h('div', null, title ? h('b', null, title) : null, title ? '：' : null, children))
    }
    function ConfigNumber({ t, config, draft, onDraft, errors, name, disabled, timing }) {
      const range = configRange(config, name), error = errors[name]
      const context = name === 'threshold' ? t('cfg.budgetContext') : name === 'taskTimeoutMinutes' ? '' : t('cfg.' + name + 'Range')
      return h('div', { className: 'ddf-field ddf-config-field' },
        h('div', { className: 'ddf-field-head' }, h('label', { className: 'ddf-label', htmlFor: `ddf-${name}` }, name === 'taskTimeoutMinutes' ? t('limits.timeoutLabel') : configLabel(t, name)),
          h('span', { className: 'ddf-default' }, fill(t('cfg.default'), { value: config?.defaults?.[name] ?? draftOf(null)[name] }))),
        h('div', { className: 'ddf-field-line' }, h('div', { className: 'ddf-num' }, h('input', {
          id: `ddf-${name}`, className: 'ddf-input', type: 'number', inputMode: 'numeric', min: range.min, max: range.max, step: 1,
          value: draft[name] ?? '', disabled, 'aria-invalid': Boolean(error), 'aria-describedby': `ddf-${name}-help`,
          onChange: event => onDraft({ [name]: event.target.value === '' ? '' : Number(event.target.value) }),
        }), h('span', { className: 'ddf-unit' }, t(name === 'maxParallel' ? 'cfg.agents' : name === 'taskTimeoutMinutes' ? 'cfg.minutes' : 'cfg.times'))),
        h('span', { className: 'ddf-range', id: `ddf-${name}-help` }, fill(t('cfg.range'), range) + (context ? ' · ' + context : '')),
        h('span', { className: 'ddf-effect', 'data-kind': ['newPlan', 'newTask'].includes(timing) ? 'later' : 'now' }, t('cfg.' + timing))),
        error ? h('span', { className: 'ddf-field-error', role: 'alert' }, error) : null)
    }
    function ConfigCard({ t, config, draft, onDraft, errors, disabled }) {
      return h('section', { className: 'ddf-card' }, h(ConfigHeading, { t, tab: 'policy', count: 2 }),
        h('div', { className: 'ddf-divider' }),
        h(ModeList, { t, value: draft.mode, disabled, onChange: mode => onDraft({ mode }) }),
        h('div', { className: 'ddf-divider' }),
        h(ConfigNumber, { t, config, draft, onDraft, errors, name: 'threshold', disabled: disabled || !['auto', 'fixed'].includes(draft.mode), timing: 'nowTool' }),
        h(ConfigNote, { title: t('cfg.notePolicy') }, t('cfg.policyNote'), h('code', null, 'DSH_DELEGATION_FIRST'), t('cfg.policyAfter')))
    }
    function LimitConfig({ t, config, draft, onDraft, errors, disabled }) {
      return h('section', { className: 'ddf-card' }, h(ConfigHeading, { t, tab: 'limits', count: 4 }), h('div', { className: 'ddf-divider' }),
        h('div', { className: 'ddf-grid-2 ddf-limits-grid' }, ...[['maxParallel', 'nextDispatch'], ['maxAttempts', 'nextRework'], ['maxActivations', 'newPlan'], ['taskTimeoutMinutes', 'newTask']]
          .map(([name, timing]) => h(ConfigNumber, { key: name, t, config, draft, onDraft, errors, name, timing, disabled }))),
        h(ConfigNote, { title: t('cfg.noteLimits') }, t('cfg.limitsNote')))
    }
    function ExecutionConfig({ t, draft, onDraft, catalogState, onRefreshModels, disabled }) {
      const groups = catalogState.value?.groups ?? []
      const routeKey = route => route ? JSON.stringify([route.provider, route.model]) : ''
      return h('section', { className: 'ddf-card' }, h(ConfigHeading, { t, tab: 'models', count: 2 }),
        h('p', { className: 'ddf-hint' }, t('cfg.modelRoles')),
        h('div', { className: 'ddf-toolbar' }, h('button', { type: 'button', className: 'ddf-btn',
          disabled: catalogState.status === 'loading', onClick: onRefreshModels }, t('models.refresh')),
          h('span', { className: 'ddf-catalog', role: 'status' }, catalogState.status === 'loading' ? t('models.loading')
            : fill(t('cfg.catalog'), { services: groups.length, models: groups.reduce((sum, group) => sum + group.models.length, 0) }))),
        catalogState.error ? h('div', { className: 'ddf-banner', 'data-kind': 'error', role: 'alert' }, catalogState.error) : null,
        ...(catalogState.value?.failures ?? []).map(failure => h('div', { key: failure.id, className: 'ddf-banner', 'data-kind': 'warn' }, `${failure.name}: ${failure.message}`)),
        catalogState.status === 'ready' && !groups.length && !catalogState.error && !catalogState.value?.failures?.length
          ? h('div', { className: 'ddf-empty ddf-model-empty' }, h('div', { className: 'glyph', 'aria-hidden': true }, '◇'),
            h('h3', null, t('cfg.emptyTitle')), h('p', null, t('cfg.emptyHint'))) : null,
        h('div', { className: 'ddf-divider' }),
        h('div', { className: 'ddf-models ddf-models-grid' }, ...MODEL_ROLES.map(tier => {
          const route = draft.models?.[tier]
          const selected = groups.find(group => group.id === route?.provider)?.models.find(model => model.id === route?.model)
          const efforts = selected?.reasoning?.efforts ?? []
          const problem = modelProblem(route, catalogState)
          const candidates = problem === 'model' ? groups.flatMap(group => group.models
            .filter(model => model.id === route.model).map(model => ({ provider: group.id, name: group.name, model: model.id }))) : []
          const choose = value => onDraft({ models: { ...draft.models, [tier]: value } })
          const warningId = `ddf-model-${tier}-warning`
          return h('div', { key: tier, className: 'ddf-model ddf-model-block' },
            h('div', { className: 'ddf-model-title' }, t(`models.${tier}`), h('code', null, tier)),
            h('label', { htmlFor: `ddf-model-${tier}` }, t('models.choose')),
            h('select', { id: `ddf-model-${tier}`, className: 'ddf-select', value: routeKey(route), disabled,
              'aria-invalid': problem === 'model' ? true : undefined, 'aria-describedby': problem ? warningId : undefined,
              onChange: event => { const value = event.target.value; const [provider, model] = value ? JSON.parse(value) : []; choose(value ? { provider, model } : null) } },
              h('option', { value: '' }, t('models.workerUnset')),
              route && !selected ? h('option', { value: routeKey(route), disabled: true }, `${route.provider}/${route.model} · ${t(problem ? 'models.unavailable' : 'models.notLoaded')}`) : null,
              ...groups.map(group => h('optgroup', { key: group.id, label: group.name }, ...group.models.map(model => h('option',
                { key: model.id, value: routeKey({ provider: group.id, model: model.id }) }, model.name === model.id ? model.name : `${model.name} (${model.id})`))))),
            problem ? h('div', { className: 'ddf-model-error', id: warningId, role: 'alert' },
              h('strong', null, fill(t('models.invalid'), { tier: t(`models.${tier}`) })), h('code', null, `${route.provider} / ${route.model}`),
              h('p', null, t(problem === 'effort' ? 'models.invalidEffort' : 'models.invalidHint')),
              h('div', { className: 'ddf-actions' }, candidates.length === 1 ? h('button', { type: 'button', className: 'ddf-btn', disabled,
                onClick: () => choose({ provider: candidates[0].provider, model: candidates[0].model }) }, fill(t('models.sameModel'), { provider: candidates[0].name })) : null,
                h('button', { type: 'button', className: 'ddf-btn', disabled, onClick: () => choose(null) }, t('models.clear'))),
              h('p', null, t('models.saveHint'))) : null,
            !route ? h('p', { className: 'ddf-error', role: 'status' }, t('models.missing')) : null,
            h('label', { htmlFor: `ddf-effort-${tier}` }, t('models.reasoningEffort')),
            h('select', { id: `ddf-effort-${tier}`, className: 'ddf-select', value: route?.reasoningEffort ?? '', disabled: disabled || !selected || !efforts.length,
              'aria-invalid': problem === 'effort' ? true : undefined,
              onChange: event => { const { reasoningEffort, ...withoutEffort } = route
                choose(event.target.value ? { ...withoutEffort, reasoningEffort: event.target.value } : withoutEffort) } },
              h('option', { value: '' }, t('models.defaultEffort')),
              route?.reasoningEffort && !efforts.some(effort => effort.id === route.reasoningEffort)
                ? h('option', { value: route.reasoningEffort, disabled: true }, `${route.reasoningEffort} · ${t('models.unavailable')}`) : null,
              ...efforts.map(effort => h('option', { key: effort.id, value: effort.id }, effort.name))),
            h('p', { className: 'ddf-range', style: { margin: '2px 0 0' } }, t('cfg.modelHintWorker')))
        }), h('div', { className: 'ddf-model-role', 'data-review-policy': 'dispatcher-snapshot' }, h('h3', null, t('cfg.reviewAutomatic')),
          h('p', { className: 'ddf-hint' }, t('cfg.modelHintReviewer')))), h(ConfigNote, { title: t('cfg.noteModels') }, t('cfg.modelsNote')))
    }
    function ConfigDiagnostics({ t, config }) {
      const source = config?.source
      const sourceLabel = source?.kind === 'env' ? t('cfg.env') : source?.kind === 'defaults' ? t('cfg.defaults') : t('cfg.file')
      const rows = [
        ['cfg.source', sourceLabel], ['cfg.lockState', config?.locked ? t('cfg.readonly') : t('cfg.unlocked')],
        ['cfg.activeMode', t('mode.' + config?.mode)], ['Profile', source?.profile ?? '—'],
        ['cfg.savedAt', config?.updatedAt ? clockTime(config.updatedAt) : t('cfg.unknown')],
        ['cfg.env', source?.environmentValue || t('cfg.unset')],
      ]
      return h('section', { className: 'ddf-card' }, h(ConfigHeading, { t, tab: 'diagnostics' }), h('div', { className: 'ddf-divider' }),
        h('div', { className: 'ddf-info-grid' }, ...rows.map(([key, value]) => h('div', { key, className: 'ddf-info-row' },
          h('span', null, key === 'Profile' ? key : t(key)), h(['Profile', 'cfg.savedAt', 'cfg.env'].includes(key) ? 'code' : 'b',
            { title: key === 'cfg.savedAt' && config?.updatedAt ? new Date(config.updatedAt).toLocaleString() : undefined }, value)))),
        h('div', { className: 'ddf-divider' }), h('div', { className: 'ddf-table-scroll' },
          h('table', { className: 'ddf-table ddf-timing-table' }, h('thead', null, h('tr', null, ...['field', 'when', 'explanation'].map(key => h('th', { key }, t('cfg.' + key))))),
            h('tbody', null, ...[
              ['policyTiming', 'nowTool', 'policyExplanation'], ['dispatchTiming', 'nextDispatch', 'dispatchExplanation'],
              ['activationTiming', 'newPlan', 'activationExplanation'], ['taskTiming', 'newTask', 'taskExplanation'], ['env', 'restart', 'envExplanation'],
            ].map(([key, when, explanation]) => h('tr', { key }, h('td', null, key === 'env' ? 'DSH_DELEGATION_FIRST' : t('cfg.' + key)),
              h('td', null, h('span', { className: 'ddf-pill', 'data-k': when === 'restart' ? 'restart' : ['newPlan', 'newTask'].includes(when) ? 'next' : 'now' },
                t('cfg.' + (when === 'restart' ? 'restart' : when === 'newPlan' ? 'whenPlan' : when === 'newTask' ? 'whenTask' : 'whenNow')))), h('td', null, t('cfg.' + explanation))))))),
        h(ConfigNote, { title: t('cfg.noteDiagnostics') }, t('cfg.acceptanceNote')))
    }

    // -----------------------------------------------------------------------
    // Session-scoped acceptance board and complete task records.
    // -----------------------------------------------------------------------

    const requiresAudit = task => task.reviewPolicy === undefined ? task.complexity === 'complex' : task.reviewPolicy === 'independent'
    const reviewPolicyKey = task => task.reviewPolicy === 'coordinator' ? 'view.auditCoordinator'
      : task.reviewPolicy === 'independent' ? 'view.auditExplicit' : task.complexity === 'complex' ? 'view.auditRequired' : 'view.auditOptional'

    function modelStatusKey(task) {
      const route = task.modelRoute
      const mismatch = task.issue?.code === 'MODEL_ROUTE_MISMATCH' || Boolean(route?.rejected)
      return mismatch ? 'plans.modelMismatch' : route?.actual ? 'plans.modelVerified'
        : route ? 'plans.modelPending' : 'plans.modelUnknown'
    }

    /** Full acceptance evidence stays available in the collapsed task record. */
    function UsageDetails({ t, usage }) {
      if (!usage) return h('details', { className: 'ddf-board-diagnostics' }, h('summary', null, t('usage.title') + ' · ' + t('usage.partial')))
      const value = number => Number.isFinite(number) ? String(number) : t('usage.unknown')
      const complete = usage.complete && usage.roles.every(row => row.responses >= row.requests && row.inputTokens !== null && row.outputTokens !== null)
      return h('details', { className: 'ddf-board-diagnostics', 'data-request-usage': usage.requestId },
        h('summary', null, t('usage.title') + ' · ' + t(complete ? 'usage.complete' : 'usage.partial')),
        h('p', null, usage.requestId),
        ...usage.roles.map((row, index) => h('p', { key: index },
          t('usage.' + row.role) + ' · ' + (row.model || t('usage.unknown')) + ' · ' + t('usage.attempt') + ' ' + row.attempt,
          ' · ' + t('usage.calls') + ' ' + row.requests,
          ...[['inputTokens', 'input'], ['cacheReadTokens', 'cacheRead'], ['cacheWriteTokens', 'cacheWrite'], ['outputTokens', 'output']]
            .map(([key, label]) => ' · ' + t('usage.' + label) + ' ' + value(row[key])))),
        h('p', null, t('usage.note')))
    }

    function SupervisionDetails({ t, task }) {
      const state = task?.supervision
      if (!state) return null
      const live = ['starting', 'running'].includes(task.status)
      const minutes = Math.max(0, Math.floor(((task.finishedAt ?? Date.now()) - state.startedAt) / 60000))
      const line = (...children) => h('p', { className: 'ddf-board-task-line' }, ...children)
      const activity = live && task.execution ? t('supervision.reporting') : live && state.activity ? t('supervision.activity.' + state.activity.kind) : ''
      return h('div', { className: 'ddf-supervision', role: 'group', 'aria-label': t('supervision.title') },
        line(fill(t('supervision.elapsed'), { minutes }), activity ? ' · ' + activity + (state.activity?.tool ? ' · ' + state.activity.tool : '') : '',
          ' · ' + fill(t('supervision.corrections'), { used: state.used, limit: state.limit })),
        task.continuation?.used ? line(fill(t('supervision.continuation'), { segment: task.continuation.used + 1 })) : null,
        state.metrics && state.limits ? line(fill(t(Number.isFinite(state.limits.outputTokens) ? 'supervision.budget' : 'supervision.usage'), { requests: state.metrics.requests, requestLimit: state.limits.requests,
          output: state.metrics.outputTokens, outputLimit: state.limits.outputTokens }), state.metrics.contextTokens ? ' · ' + fill(t('supervision.context'), { tokens: state.metrics.contextTokens }) : '') : null,
        state.notices?.REQUEST_VOLUME ? line(t('supervision.requestNotice')) : null,
        state.notices?.ELAPSED_TIME ? line(t('supervision.timeNotice')) : null,
        state.pending ? line(h('strong', null, t(live ? state.pending.advisory ? 'supervision.inquiry' : 'supervision.waiting' : 'supervision.title') + '：'), state.pending.reason) : null,
        state.wrapUpRequestedAt ? line(t('supervision.wrapUp')) : null,
        state.checkpoint ? line(h('strong', null, t('supervision.stage') + ' · ' + t('supervision.' + state.checkpoint.phase) + '：'), state.checkpoint.summary,
          ' · ' + t('supervision.nextStep') + '：' + state.checkpoint.nextStep) : null,
        state.lastCorrection ? line(h('strong', null, t('supervision.corrected') + '：'), state.lastCorrection.message) : null)
    }

    function TaskDetails({ t, task, compact = false }) {
      const route = task.modelRoute
      const selected = route?.resolved ?? route?.requested
      const mismatch = task.issue?.code === 'MODEL_ROUTE_MISMATCH' || Boolean(route?.rejected)
      const tier = route?.role ? t('models.' + route.role) : task.complexity === 'complex' ? t('models.complex') : t('models.routine')
      const audit = task.audit
      const auditSelected = audit?.modelRoute?.actual ?? audit?.modelRoute?.resolved ?? audit?.modelRoute?.requested ?? task.dispatcherModel
      const status = value => h('span', { className: 'ddf-status', 'data-status': value }, t('status.' + value))
      return h('details', { className: compact ? 'ddf-board-task-details' : 'ddf-task' },
        compact ? h('summary', null, t('view.boardDetails')) : h('summary', null, h('strong', null, task.title || task.id), status(task.status),
          h('span', { className: 'ddf-diff-meta' }, fill(t('plans.taskComplexity'), { complexity: t('models.' + (task.complexity || 'routine')) }))),
        h('div', { className: 'ddf-task-body' },
          h('div', null, `${tier} → ${selected?.model ?? task.model?.model ?? t('plans.modelUnknown')}`,
            h('span', { className: 'ddf-model-check' }, t(modelStatusKey(task)))),
          h('p', { className: 'ddf-hint' }, t('plans.modelReason') + '：' + (task.complexityReason || t('plans.modelReasonUnknown'))),
          task.reviewPolicy ? h('p', { className: 'ddf-hint' }, t(reviewPolicyKey(task)) + ' · ' + t('view.auditReason') + '：' + task.reviewReason) : null,
          route ? h('p', { className: 'ddf-hint' }, t('view.modelIdentifierNote')) : null,
          h('p', { className: 'ddf-hint' }, t('plans.modelSource') + '：' + (route
            ? t(route.source === 'dispatcher' ? 'plans.modelSourceDispatcher' : route.source === 'configured' ? 'plans.modelSourceConfigured' : 'plans.modelSourceInherited') : t('plans.modelUnknown'))),
          task.dispatcherModel && (task.audit || task.reviewPolicy !== 'coordinator') ? h('p', { className: 'ddf-hint' }, t('plans.reviewSnapshot') + '：' + task.dispatcherModel.provider + ' / ' + task.dispatcherModel.model + ' · ' + t('models.reasoningEffort') + '：' + (task.dispatcherModel.reasoningEffort ?? t('models.defaultEffort')),
            task.dispatcherModel.source === 'legacy-review' ? ' · ' + t('plans.reviewLegacySnapshot') : '') : null,
          mismatch ? h('p', { className: 'ddf-error' }, task.error || t('plans.modelMismatch')) : null,
          h(SupervisionDetails, { t, task }),
          task.execution ? h('p', { className: 'ddf-hint' }, t('execution.' + task.execution.status) + '：' + task.execution.summary) : null,
          ...(task.execution?.concerns ?? []).map((concern, i) => h('p', { key: 'concern-' + i, className: 'ddf-warn' }, t('plans.concerns') + '：' + concern)),
          task.stop ? h('div', null,
            h('p', null, t('completion.reason') + '：' + task.stop.reason),
            h('p', { className: 'ddf-hint' }, t('completion.stopSource') + '：' + t('completion.source.' + task.stop.source)),
            task.stop.at ? h('p', { className: 'ddf-hint' }, t('completion.stopTime') + '：' + new Date(task.stop.at).toLocaleString()) : null) : null,
          audit ? h('div', { role: 'status' },
            h('strong', null, t('audit.title') + ' · ' + t('audit.' + audit.status)),
            auditSelected ? h('p', { className: 'ddf-hint' }, t('audit.model') + '：' + auditSelected.provider + ' / ' + auditSelected.model
              + ' · ' + t(audit.modelRoute?.actual ? 'plans.modelVerified' : 'plans.modelPending')) : null,
            audit.status === 'completed' ? h('p', null, fill(t('audit.verdicts'), { spec: t('audit.' + audit.specVerdict), quality: t('audit.' + audit.qualityVerdict) })) : null,
            audit.error ? h('p', { className: 'ddf-error' }, audit.error) : null) : null,
          ...(task.issues ?? []).map(issue => h('p', { key: issue.id, className: issue.status === 'open' ? 'ddf-warn' : 'ddf-hint' },
            `${issue.id} · ${t('audit.' + issue.status)} · ${issue.finding}`,
            h('small', null, ' · ' + (issue.evidence ?? []).join('、')))),
          h('strong', null, t('plans.criteria')),
          h('ol', null, ...(task.criteria ?? []).map((criterion, i) => h('li', { key: i }, criterion))),
          h('strong', null, t('plans.checks')),
          ...(task.checks ?? []).map((check, i) => h('div', { key: i },
            h('div', null, check.tool + ' · ' + (check.result ? t(check.result.passed ? 'plans.passed' : 'plans.failed') : t('plans.unverified'))),
            check.result?.truncated ? h('p', { className: 'ddf-warn' }, t('plans.outputTruncated')) : null,
            h('details', null, h('summary', null, t('plans.technical')),
              h('pre', null, JSON.stringify(check.arguments, null, 2)),
              check.result ? h('pre', null, check.result.callId + '\n' + check.result.summary) : null,
              check.result?.outputPath ? h('p', null, t('plans.outputPath') + '：', h('code', null, check.result.outputPath)) : null))),
          task.review ? h('div', null, h('strong', null, t('plans.review')),
            ...(task.review.findings ?? []).map((finding, i) => h('p', { key: i },
              `${finding.criterion + 1}. ${finding.finding} (${(finding.evidence ?? []).join(', ')})`))) : null,
          h('details', null, h('summary', null, t('plans.technical')),
            h('p', null, t('plans.modelExpected') + '：' + (route?.requested ? `${route.requested.provider} / ${route.requested.model}` : t('plans.modelUnknown'))),
            h('p', null, t('plans.modelActual') + '：' + (route?.actual ? `${route.actual.provider} / ${route.actual.model}` : t(route ? 'plans.modelPending' : 'plans.modelUnknown'))),
            task.childId ? h('code', null, task.childId) : null,
            h('p', null, t('plans.dependencies') + '：' + ((task.dependsOn ?? []).join('、') || '—')),
            h('p', null, t('plans.outputs') + '：' + (task.outputs ?? []).join('、')),
            task.release?.status === 'released' ? h('p', { className: 'ddf-hint' }, t('plans.childReleased')) : null,
            task.release?.status === 'drained' ? h('p', { className: 'ddf-hint' }, t('plans.childDrained')) : null,
            task.release?.status === 'failed' ? h('p', { className: 'ddf-foot-failed' }, fill(t('plans.childReleaseFailed'), { error: task.release.error })) : null,
            task.error ? h('pre', null, task.error) : null),
          task.execution?.reportPath ? h('p', { className: 'ddf-hint' }, t('execution.report') + '：', h('code', null, task.execution.reportPath)) : null,
          audit?.report ? h('details', null, h('summary', null, t('audit.title')), h('pre', null, audit.report)) : null,
          task.report ? h('details', null, h('summary', null, t('plans.report')), h('pre', null, task.report)) : null))
    }

    /** Original request and complete records, opened from the acceptance summary. */
    function PlanDetails({ t, plan, sessionId, hidden }) {
      const tasks = plan?.tasks ?? []
      return h('div', { className: 'ddf-board-records', hidden },
        h('div', { className: 'ddf-card-title' }, t('view.details')),
        plan.activationBudget ? h('p', { className: 'ddf-hint' }, fill(t('plans.activationBudget'), plan.activationBudget)) : null,
        plan.routing ? h('p', { className: 'ddf-hint' }, routeEstimate(t, plan.routing)) : null,
        h(DecisionDetails, { t, decision: plan.decision, current: plan.decisionCurrent !== false, resolution: plan.messageResolution, pending: plan.pendingMessages }),
        h('details', { className: 'ddf-details' }, h('summary', null, t('view.source')),
          h('div', { className: 'ddf-task-body' },
            h('pre', null, plan.source?.text || t('view.unknownSource')),
            h('p', { className: 'ddf-hint' }, t('view.session') + '：' + (plan.sessionTitle || t('view.currentSession')) + ' · ' + shortId(plan.sessionId || sessionId)),
            h('p', { className: 'ddf-hint' }, t('view.message') + '：' + (plan.source?.messageId || '—')),
            h('p', { className: 'ddf-hint' }, t('view.goal') + '：' + plan.goal),
            h('code', { className: 'ddf-record-path' }, plan.sessionId || sessionId),
            h('code', { className: 'ddf-record-path' }, plan.cwd || t('view.noProject')))),
        ...tasks.map(task => h(TaskDetails, { key: task.id, t, task })))
    }

    function blockersOf(plan) {
      const tasks = plan?.tasks ?? []
      return tasks.map(task => ['failed', 'blocked'].includes(task.audit?.status)
        ? { ...task.audit, title: task.audit.title || task.title } : task)
        .filter(task => ['failed', 'blocked'].includes(task.status))
    }

    const DASHBOARD_STYLES = `
/* Use the same full-height surface as Trajectory. Like Context, hide only
   this occurrence's ordinary composer; pending user interactions stay visible. */
[data-conversation-scroll]:has(> [data-slot="conversation.session"] [data-ddf-acceptance]) > [data-composer-seat]:not(:has([data-approval-key],[data-question-key],[data-plan-review-key])) { display:none; }
[data-conversation-scroll]:has(> [data-slot="conversation.session"] [data-ddf-acceptance]) ~ [data-width-handle] { display:none; }
[data-conversation-scroll]:has(> [data-slot="conversation.session"] [data-ddf-acceptance]):has(> [data-composer-seat] :is([data-approval-key],[data-question-key],[data-plan-review-key])) [data-ddf-acceptance] .ddf-board { padding-bottom:calc(40px + var(--dsh-composer-height,200px)); }
.ddf-board-root { --ddf-board-accent:var(--dsw-alias-state-business-primary,color-mix(in srgb,var(--dsw-alias-button-primary-fill,#2459d3) 80%,var(--dsw-alias-label-primary,#1f2329))); --ddf-board-success:var(--dsw-alias-state-success-primary,color-mix(in srgb,#16764b 65%,var(--dsw-alias-label-primary,#1f2329))); --ddf-board-warning:var(--dsw-alias-state-warn-primary,color-mix(in srgb,#946000 65%,var(--dsw-alias-label-primary,#1f2329))); --ddf-board-error:var(--dsw-alias-state-danger-primary,color-mix(in srgb,#b33239 65%,var(--dsw-alias-label-primary,#1f2329))); display:flex; flex-direction:column; flex:1 1 auto; width:100%; height:100%; min-width:0; min-height:0; overflow:auto; background:var(--dsw-alias-bg-layer-2,#f5f6f7); color:var(--dsw-alias-label-primary,#1f2329); font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif; }
.ddf-board-root *,.ddf-board-root *::before,.ddf-board-root *::after { box-sizing:border-box; }
.ddf-board { flex:none; width:100%; max-width:1120px; min-width:0; margin:0 auto; padding:24px 24px 40px; display:flex; flex-direction:column; gap:16px; }
.ddf-board > * { min-width:0; }
.ddf-board-header { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; padding-bottom:16px; border-bottom:1px solid var(--dsw-alias-border-l1,#e5e6eb); }
.ddf-board-title { margin:0; font-size:24px; line-height:1.25; letter-spacing:-.02em; }
.ddf-board-meta { margin:6px 0 0; color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; overflow-wrap:anywhere; }
.ddf-board-actions { display:flex; justify-content:flex-end; flex-wrap:wrap; gap:8px; flex:none; }
.ddf-board-action { min-height:32px; max-width:100%; padding:4px 12px; border:1px solid var(--dsw-alias-border-l1,#e5e6eb); border-radius:7px; background:var(--dsw-alias-bg-layer-1,#fff); color:var(--dsw-alias-label-primary,#1f2329); font:inherit; font-size:12px; cursor:pointer; overflow-wrap:anywhere; touch-action:manipulation; }
.ddf-board-action:hover:not(:disabled) { border-color:var(--dsw-alias-border-l2,#c9cdd4); color:var(--dsw-alias-label-primary,#1f2329); }
.ddf-board button:focus-visible,.ddf-board summary:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4f6ef7)); outline-offset:2px; }
.ddf-board-action:disabled { opacity:.48; cursor:not-allowed; }
.ddf-board-hero { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:20px; padding:18px 20px; border:1px solid var(--dsw-alias-border-l1,#e5e6eb); border-radius:12px; background:var(--dsw-alias-bg-layer-1,#fff); }
.ddf-board-hero-label { margin:0 0 5px; color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; }
.ddf-board-goal { margin:0; max-width:760px; font-size:18px; line-height:1.45; font-weight:650; overflow-wrap:anywhere; }
.ddf-board-route { margin:10px 0 0; color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; line-height:1.6; overflow-wrap:anywhere; }
.ddf-board-route b { color:var(--dsw-alias-label-primary,#1f2329); font-weight:600; }
.ddf-board-status { align-self:start; justify-self:start; display:inline-flex; align-items:center; gap:7px; min-height:30px; padding:4px 10px; border:1px solid var(--dsw-alias-border-l1,#e5e6eb); border-radius:999px; color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; white-space:nowrap; }
.ddf-board-status::before { content:""; width:7px; height:7px; border-radius:50%; background:currentColor; flex:none; }
.ddf-board-status[data-status="running"],.ddf-board-status[data-status="starting"] { color:var(--ddf-board-accent); }
.ddf-board-status[data-status="accepted"] { color:var(--dsw-alias-state-success-primary,#1f9d55); }
.ddf-board-status[data-status="failed"],.ddf-board-status[data-status="blocked"] { color:var(--dsw-alias-state-danger-primary,#d14343); }
.ddf-board-status[data-status="cancelled"] { color:var(--dsw-alias-label-secondary,#646a73); }
.ddf-board-metrics { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:0; padding:12px 0; border:1px solid var(--dsw-alias-border-l1,#e5e6eb); border-radius:9px; background:var(--dsw-alias-bg-layer-1,#fff); }
.ddf-board-metric { min-width:0; padding:0 14px; border-right:1px solid var(--dsw-alias-border-l1,#e5e6eb); }
.ddf-board-metric:last-child { border-right:0; }
.ddf-board-metric-label { display:block; color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; }
.ddf-board-metric-value { display:block; margin-top:4px; font:600 20px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-variant-numeric:tabular-nums; color:var(--dsw-alias-label-primary,#1f2329); overflow-wrap:anywhere; }
.ddf-board-metric-note { display:block; margin-top:4px; font-size:12px; color:var(--dsw-alias-label-secondary,#646a73); }
.ddf-board-progress { display:flex; flex-direction:column; gap:8px; padding:14px 16px; border:1px solid var(--dsw-alias-border-l1,#e5e6eb); border-radius:9px; background:var(--dsw-alias-bg-layer-1,#fff); }
.ddf-board-progress-head { display:flex; align-items:center; justify-content:space-between; gap:12px; color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; }
.ddf-board-progress-track { height:7px; overflow:hidden; border-radius:999px; background:var(--dsw-alias-bg-layer-2,#f5f6f7); }
.ddf-board-progress-track i { display:block; height:100%; min-width:0; border-radius:inherit; background:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4f6ef7)); }
.ddf-board-section-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-top:4px; }
.ddf-board-section-title { margin:0; font-size:16px; font-weight:650; }
.ddf-board-section-note { color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; }
.ddf-board-task-list { display:flex; flex-direction:column; gap:10px; }
.ddf-board-task { min-width:0; padding:15px 16px; border:1px solid var(--dsw-alias-border-l1,#e5e6eb); border-radius:10px; background:var(--dsw-alias-bg-layer-1,#fff); }
.ddf-board-task[data-status="failed"],.ddf-board-task[data-status="blocked"] { border-left:3px solid var(--dsw-alias-state-danger-primary,#d14343); }
.ddf-board-task[data-affected="true"] { border-left-color:var(--dsw-alias-border-l2,#c9cdd4); }
.ddf-board-task[data-status="cancelled"] { border-left:3px solid var(--dsw-alias-border-l2,#c9cdd4); }
.ddf-board-task-tag { color:var(--dsw-alias-label-primary,#1f2329); font-weight:600; }
.ddf-board-task-head { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; min-width:0; }
.ddf-board-task-title-wrap { min-width:0; }
.ddf-board-task-title { margin:0; font-size:16px; line-height:1.45; font-weight:650; overflow-wrap:anywhere; }
.ddf-board-task-meta { display:flex; align-items:center; flex-wrap:wrap; gap:5px 12px; margin-top:5px; color:var(--dsw-alias-label-secondary,#646a73); font-size:11px; overflow-wrap:anywhere; }
.ddf-board-task-meta code { color:var(--dsw-alias-label-tertiary,#8f959e); font:inherit; }
.ddf-board-task-status { flex:none; padding:3px 8px; border:1px solid var(--dsw-alias-border-l1,#e5e6eb); border-radius:6px; color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; white-space:nowrap; }
.ddf-board-task[data-status="running"] .ddf-board-task-status,.ddf-board-task[data-status="starting"] .ddf-board-task-status { color:var(--ddf-board-accent); border-color:currentColor; background:color-mix(in srgb,currentColor 8%,var(--dsw-alias-bg-layer-1,#fff)); }
.ddf-board-task[data-status="running"],.ddf-board-task[data-status="starting"] { border-left:3px solid var(--ddf-board-accent); }
.ddf-board-task[data-status="review"] { border-left:3px solid var(--ddf-board-warning); }
.ddf-board-task[data-status="review"] .ddf-board-task-status { color:var(--ddf-board-warning); border-color:currentColor; }
.ddf-board-task[data-status="accepted"] .ddf-board-task-status { color:var(--dsw-alias-state-success-primary,#1f9d55); border-color:currentColor; }
.ddf-board-task[data-status="failed"] .ddf-board-task-status,.ddf-board-task[data-status="blocked"] .ddf-board-task-status { color:var(--dsw-alias-state-danger-primary,#d14343); border-color:currentColor; }
.ddf-board-task[data-status="cancelled"] .ddf-board-task-status { color:var(--dsw-alias-label-secondary,#646a73); }
.ddf-board-task-facts { display:grid; grid-template-columns:1.1fr 1fr 1fr 1.2fr; gap:14px; margin:15px 0 13px; }
.ddf-board-task-facts > div { min-width:0; }
.ddf-board-task-facts dt { margin-bottom:4px; color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; }
.ddf-board-task-facts dd { display:flex; flex-direction:column; gap:3px; margin:0; color:var(--dsw-alias-label-primary,#1f2329); font-size:14px; overflow-wrap:anywhere; }
.ddf-board-fact-note { color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; }
.ddf-board-model-check[data-state="plans.modelVerified"] { color:var(--ddf-board-success); }
.ddf-board-model-check[data-state="plans.modelMismatch"] { color:var(--ddf-board-error); font-weight:600; }
.ddf-board-task-line[data-current-activity] { padding-top:11px; border-top:1px solid var(--dsw-alias-border-l1,#e5e6eb); color:var(--dsw-alias-label-primary,#1f2329); font-size:14px; }
.ddf-board-execution-diagnostics { margin-top:12px; }
.ddf-board-execution-diagnostics > summary { color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; }
.ddf-board-task-line { margin:10px 0 0; color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; line-height:1.6; overflow-wrap:anywhere; }
.ddf-board-task-line strong { color:var(--dsw-alias-label-primary,#1f2329); font-weight:600; }
.ddf-board-task-line[data-kind="error"] { color:var(--dsw-alias-state-danger-primary,#d14343); }
.ddf-board-task-line[data-kind="next"] { color:var(--dsw-alias-state-warn-primary,#c78300); }
.ddf-board-task-details { margin-top:11px; border-top:1px solid var(--dsw-alias-border-l1,#e5e6eb); padding-top:9px; }
.ddf-board-task-details summary { width:max-content; max-width:100%; cursor:pointer; color:var(--dsw-alias-brand-primary,#4f6ef7); font-size:12px; }
.ddf-board-task-fix { align-self:flex-start; min-height:28px; padding:0 9px; border:1px solid currentColor; border-radius:6px; background:transparent; color:var(--dsw-alias-state-warn-primary,#c78300); font:inherit; font-size:12px; cursor:pointer; }
.ddf-board-task-fix:hover { background:var(--dsw-alias-bg-layer-2,#f5f6f7); }
.ddf-board-task-fix:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4f6ef7)); outline-offset:2px; }
.ddf-board-next { padding:14px 16px; border:1px solid var(--dsw-alias-border-l1,#e5e6eb); border-radius:9px; background:var(--dsw-alias-bg-layer-2,#f5f6f7); color:var(--dsw-alias-label-secondary,#646a73); font-size:13px; line-height:1.6; overflow-wrap:anywhere; }
.ddf-board-next b { color:var(--dsw-alias-label-primary,#1f2329); font-weight:650; }
.ddf-board-next p { margin:4px 0 0; }
.ddf-board-next .ddf-board-action { margin-top:8px; }
.ddf-board-empty { padding:34px 20px; border:1px dashed var(--dsw-alias-border-l2,#c9cdd4); border-radius:10px; background:var(--dsw-alias-bg-layer-1,#fff); text-align:center; }
.ddf-board-empty h2 { margin:0; font-size:16px; }
.ddf-board-empty p { margin:7px auto 0; max-width:540px; color:var(--dsw-alias-label-secondary,#646a73); font-size:13px; }
.ddf-board-records,.ddf-board-diagnostics,.ddf-board-load-issue { margin:0; padding:16px; border:1px solid var(--dsw-alias-border-l1,#e5e6eb); border-radius:8px; background:var(--dsw-alias-bg-layer-1,#fff); overflow-wrap:anywhere; }
.ddf-board-records { margin-top:12px; }
.ddf-board summary { cursor:pointer; font-size:13px; color:var(--dsw-alias-label-primary,#1f2329); overflow-wrap:anywhere; }
.ddf-board summary:hover { color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4f6ef7)); }
.ddf-board pre { max-width:100%; max-height:280px; margin:8px 0 0; padding:12px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; background:var(--dsw-alias-bg-layer-2,#f5f6f7); border-radius:6px; font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.ddf-board code { font-size:12px; overflow-wrap:anywhere; }
.ddf-board .ddf-task { padding:12px 0; border-top:1px solid var(--dsw-alias-border-l1,#e5e6eb); }
.ddf-board .ddf-task > summary { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.ddf-board .ddf-task-body { min-width:0; display:flex; flex-direction:column; gap:8px; margin-top:12px; font-size:12px; overflow-wrap:anywhere; }
.ddf-board .ddf-task-body p,.ddf-board .ddf-task-body ol { margin:0; }
.ddf-board .ddf-task-body ol { padding-left:20px; }
.ddf-board .ddf-hint,.ddf-board .ddf-diff-meta,.ddf-board .ddf-model-check { font-size:12px; color:var(--dsw-alias-label-secondary,#646a73); }
.ddf-board .ddf-record-path { display:block; }
.ddf-board .ddf-error,.ddf-board .ddf-foot-failed { color:var(--dsw-alias-state-danger-primary,#d14343); }
.ddf-board .ddf-warn { color:var(--dsw-alias-state-warn-primary,#c78300); }
.ddf-board .ddf-status { color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; }
.ddf-board-diagnostics > summary { font-weight:600; }
.ddf-board-assessment { margin:12px 0 0; font-size:12px; }
.ddf-board-assessment > p { margin:0 0 12px; color:var(--dsw-alias-label-secondary,#646a73); }
.ddf-board-assessment dl { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px 24px; margin:0; }
.ddf-board-assessment dl > div { min-width:0; }
.ddf-board-assessment dt { margin:0 0 4px; color:var(--dsw-alias-label-secondary,#646a73); }
.ddf-board-assessment dd { display:flex; flex-direction:column; gap:4px; margin:0; overflow-wrap:anywhere; }
.ddf-board-assessment article + article { margin-top:16px; padding-top:16px; border-top:1px solid var(--dsw-alias-border-l1,#e5e6eb); }
.ddf-board-load-issue { border-left:3px solid var(--dsw-alias-state-warn-primary,#c78300); }
.ddf-board-load-issue h2 { margin:4px 0 8px; font-size:16px; }
.ddf-board-load-issue p { margin:0 0 12px; color:var(--dsw-alias-label-secondary,#646a73); }
.ddf-board-load-issue details { margin-top:12px; }
.ddf-board-inline-notice { margin:0; font-size:12px; color:var(--dsw-alias-label-secondary,#646a73); overflow-wrap:anywhere; }
.ddf-board-inline-notice[data-kind="error"] { color:var(--dsw-alias-state-danger-primary,#d14343); }
.ddf-board-decision { border:1px solid var(--dsw-alias-border-l1,#dfe5ee); border-radius:10px; overflow:hidden; background:var(--dsw-alias-bg-layer-1,#fff); }
.ddf-board-decision-main { display:grid; grid-template-columns:minmax(0,.9fr) minmax(0,1.25fr); }
.ddf-board-decision-main h2 { margin:0 0 8px; font-size:12px; color:var(--dsw-alias-label-secondary,#646a73); font-weight:600; }
.ddf-board-decision-difficulty { padding:19px 20px; border-left:3px solid var(--ddf-board-accent); background:var(--dsw-alias-bg-layer-2,#f5f6f7); background:color-mix(in srgb,var(--ddf-board-accent) 7%,var(--dsw-alias-bg-layer-1,#fff)); }
.ddf-board-decision-level { display:flex; align-items:baseline; flex-wrap:wrap; gap:12px; }
.ddf-board-decision-level strong { font-size:27px; line-height:1.25; font-weight:650; color:var(--dsw-alias-label-primary,#1f2329); }
.ddf-board-decision-level > span { color:var(--ddf-board-accent); font:600 13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.ddf-board-decision-signals { margin:10px 0 0; font-size:13px; color:var(--dsw-alias-label-primary,#1f2329); overflow-wrap:anywhere; }
.ddf-board-decision-note { margin:6px 0 0; font-size:12px; line-height:1.6; color:var(--dsw-alias-label-secondary,#646a73); overflow-wrap:anywhere; }
.ddf-board-decision-routes { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.1fr); align-items:start; gap:18px; padding:19px 20px; }
.ddf-board-decision-route { color:var(--ddf-board-accent); font-size:14px; font-weight:650; overflow-wrap:anywhere; }
.ddf-board-decision-actual { border-left:2px solid var(--ddf-board-accent); padding-left:12px; min-width:0; }
.ddf-board-decision-actual > strong { color:var(--dsw-alias-label-primary,#1f2329); font-size:14px; font-weight:650; }
.ddf-board-decision-counters { display:flex; align-items:baseline; flex-wrap:wrap; gap:10px 22px; padding:11px 20px; border-top:1px solid var(--dsw-alias-border-l1,#dfe5ee); }
.ddf-board-decision-count { display:flex; align-items:baseline; gap:7px; color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; }
.ddf-board-decision-count > strong { color:var(--dsw-alias-label-primary,#1f2329); font:600 16px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.ddf-board-decision-cumulative { color:var(--dsw-alias-label-secondary,#646a73); font-size:11px; }
.ddf-board-decision-interception { flex:1 1 240px; min-width:0; }
.ddf-board-decision-interception > summary { color:var(--ddf-board-accent); font-size:12px; }
.ddf-board-decision-interception p { margin:6px 0 0; color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; overflow-wrap:anywhere; }
.ddf-board-decision-legacy { padding:0 20px 11px; }
@media (max-width:960px){ .ddf-board-decision-main { grid-template-columns:1fr; } .ddf-board-task-facts { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media (max-width:720px){
  .ddf-board { padding:18px 14px 28px; }
  .ddf-board-header,.ddf-board-hero { grid-template-columns:1fr; display:grid; gap:14px; }
  .ddf-board-header { display:flex; flex-direction:column; }
  .ddf-board-actions { justify-content:flex-start; }
  .ddf-board-metrics { grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
  .ddf-board-metric:last-child { grid-column:span 2; }
  .ddf-board-assessment dl { grid-template-columns:1fr; }
  .ddf-board-progress-head,.ddf-board-section-head { flex-wrap:wrap; }
  .ddf-board-task-head { flex-direction:column; gap:8px; }
  .ddf-board-task-status { align-self:flex-start; }
  .ddf-board-decision-routes { grid-template-columns:1fr; }
  .ddf-board-decision-main > div { padding:16px; }
  .ddf-board-decision-counters { padding:11px 16px; gap:10px 16px; }
}
@media (max-width:380px){ .ddf-board { gap:12px; padding:16px 12px 24px; } .ddf-board-hero,.ddf-board-task { padding:12px; } .ddf-board-metric { padding:12px; } .ddf-board-metric-value { font-size:18px; } .ddf-board-title { font-size:22px; } }
`

    function dashboardStatusKey(plan) {
      if (!plan) return 'planned'
      if (plan.completion) return { completed: 'accepted', cancelled: 'cancelled', blocked: 'blocked', partial: plan.completion.remaining.every(task => task.status === 'cancelled') ? 'cancelled' : 'blocked' }[plan.completion.outcome]
      const tasks = plan.tasks ?? []
      const work = tasks.flatMap(task => task.audit && !['accepted', 'cancelled'].includes(task.status) ? [task, task.audit] : [task])
      const active = work.some(task => ['starting', 'running'].includes(task.status))
      if (plan.cancelled || plan.status === 'cancelled') return 'cancelled'
      if (tasks.some(task => task.status === 'cancelled') && tasks.every(task => ['accepted', 'cancelled'].includes(task.status))) return 'cancelled'
      if (work.some(task => task.status === 'failed') || plan.status === 'failed') return 'failed'
      if (work.some(task => task.status === 'blocked') && !active) return 'blocked'
      if (active) return 'running'
      if (tasks.some(task => task.status === 'review')) return 'review'
      if (tasks.length && tasks.every(task => task.status === 'accepted')) return 'accepted'
      if (tasks.length) return 'queued'
      return plan.status === 'starting' ? 'running' : plan.status || 'planned'
    }

    function dashboardAffected(task, tasks) {
      if (!['blocked', 'queued', 'cancelled'].includes(task.status) || task.recovered || task.issue?.message) return false
      return /^计划因子任务 .+ 失败而暂停/.test(task.error || '') || (task.dependsOn ?? []).some(id => {
        const dependency = tasks.find(item => item.id === id)
        return dependency && ['failed', 'blocked', 'cancelled'].includes(dependency.status)
      })
    }

    function dashboardRootTask(tasks) {
      return tasks.find(task => task.status === 'failed' || task.audit?.status === 'failed')
        || tasks.find(task => (task.status === 'blocked' || task.audit?.status === 'blocked') && !dashboardAffected(task, tasks))
    }

    function dashboardNextText(t, status, tasks, modelBlock, rootTask) {
      if (status === 'cancelled') return t('view.stoppedNext')
      if (status === 'accepted') return t('view.doneNext')
      const issue = taskServiceIssue(t, rootTask)
      if (issue?.action) return issue.action
      if (modelBlock) return t('view.configNext')
      if (tasks.some(task => task.recovered || task.audit?.recovered)) return t('view.recoveredNext')
      if (tasks.some(task => ['failed', 'blocked'].includes(task.audit?.status))) return t('audit.nextRetry')
      if (status === 'failed' || status === 'blocked') return t('view.failedNext')
      if (tasks.some(task => ['queued', 'starting', 'running'].includes(task.audit?.status))) return t('audit.nextRunning')
      if (tasks.some(task => task.issues?.some(issue => issue.status === 'open' && issue.severity !== 'minor'))) return t('audit.nextRework')
      if (status === 'review') return t('view.reviewNext')
      if (status === 'running') return t('view.runningNext')
      return t('view.startNext')
    }

    function dashboardReason(t, task) {
      if (task.stop?.reason) return task.stop.reason
      const issue = taskServiceIssue(t, task)
      if (issue?.message) return issue.message
      if (task.error && !/^(error|子任务停止原因：error)$/i.test(task.error)) return task.error
      return t('view.boardNoReason')
    }

    function BoardDecision({ t, session, plan, status, running }) {
      const route = plan?.routing ?? session?.route
      const semantic = session?.requestBindingVersion >= 2
      const pending = session?.pendingMessages ?? []
      const decision = plan ? plan.decision : session?.decision
      const decisionCurrent = (plan ? plan.decisionCurrent : session?.decisionCurrent) !== false
      const difficulty = session?.difficulty, level = levelKey(difficulty)
      const tasks = plan?.tasks ?? []
      const complex = tasks.some(task => task.complexity === 'complex')
      const confirmed = complex ? t('view.taskComplex') : tasks.length && tasks.every(task => task.complexity === 'routine') ? t('view.taskRoutine') : t('cfg.unknown')
      const reasons = tasks.filter(task => task.complexityReason).map(task => `${task.title || task.id}：${task.complexityReason}`).join('；')
      const dependent = tasks.filter(task => ['queued', 'blocked'].includes(task.status)
        && (task.dependsOn ?? []).some(id => tasks.some(item => item.id === id && item.status !== 'accepted')))
      const direct = session?.turnStats?.direct, delegated = session?.turnStats?.delegated
      const noPlanActual = !Number.isFinite(direct) || !Number.isFinite(delegated) ? t('view.actualUnknown')
        : direct > 0 && delegated > 0 ? fill(t('view.actualCounts'), { direct, delegated })
        : direct > 0 ? fill(t('view.actualDirect'), { count: direct }) : t('view.actualNoPlan')
      const actual = !plan ? noPlanActual
        : ['accepted', 'cancelled', 'failed', 'blocked'].includes(status) ? t('status.' + status)
        : running > 1 ? fill(t('view.actualParallel'), { count: running })
        : dependent.length ? t('view.actualDependency')
        : tasks.some(task => ['starting', 'running'].includes(task.audit?.status)) ? t('view.actualAudit')
        : running ? t('view.actualRunning') : status === 'review' ? t('view.acceptanceReview') : t('view.actualQueued')
      const count = (key, label) => h('div', { className: 'ddf-board-decision-count', key },
        h('span', null, t('table.' + label)),
        h('strong', null, Number.isFinite(session?.turnStats?.[key]) ? String(session.turnStats[key]) : t('cfg.unknown')))
      const cumulative = session?.sessionStats?.denied ?? session?.denied
      return h('section', { className: 'ddf-board-decision', 'aria-label': t('view.decisionTitle') },
        h('div', { className: 'ddf-board-decision-main' },
          h('div', { className: 'ddf-board-decision-difficulty' },
            h('h2', null, t(plan ? 'view.confirmedDifficulty' : semantic ? 'relation.title' : 'view.initialDifficulty')),
            h('div', { className: 'ddf-board-decision-level' }, h('strong', null, plan ? confirmed : semantic ? t(pending.length ? 'relation.pending' : session.messageResolution ? 'relation.' + session.messageResolution.relation : 'decision.unrecorded') : level && difficulty?.signals?.length ? t('level.' + level) : t('view.unconfirmed'))),
            h('p', { className: 'ddf-board-decision-signals' }, plan ? reasons || t('plans.modelReasonUnknown') : semantic ? pending.map(message => message.text).join('；') : signalsText(t, difficulty))),
          h('div', { className: 'ddf-board-decision-routes' },
            h('div', null, h('h2', null, t('decision.title')),
              h('strong', { className: 'ddf-board-decision-route' }, t(decision ? 'decision.' + decision.mode : 'decision.unrecorded')),
              decision ? h('p', { className: 'ddf-board-decision-note' }, decision.reason) : null,
              !decisionCurrent && decision && !pending.length ? h('p', { className: 'ddf-board-decision-note' }, t('decision.revised')) : null,
              plan && semantic ? h(AssociationDetails, { t, resolution: session.messageResolution, pending }) : null,
              plan ? h('p', { className: 'ddf-board-decision-note' }, t(tasks.some(task => requiresAudit(task) || task.audit) ? 'view.complexAudit' : 'view.routineAcceptance')) : null),
            h('div', { className: 'ddf-board-decision-actual' }, h('h2', null, t('view.actualArrangement')), h('strong', null, actual),
              dependent.length ? h('p', { className: 'ddf-board-decision-note' }, fill(t('view.boardDependency'), {
                tasks: [...new Set(dependent.flatMap(task => task.dependsOn ?? []))].map(id => tasks.find(task => task.id === id))
                  .filter(task => task && task.status !== 'accepted').map(task => task.title || task.id).join('、') })) : null,
              plan?.dispatchWait?.message ? h('p', { className: 'ddf-board-decision-note' }, plan.dispatchWait.message) : null))),
        difficulty || route ? h('details', { className: 'ddf-board-execution-diagnostics' }, h('summary', null, t('view.initialAssessment')),
          h('p', null, level ? t('level.' + level) : t('cfg.unknown'), ' · ', Number.isFinite(difficulty?.score) ? fill(t('difficulty.score'), { score: difficulty.score }) : '', ' · ', signalsText(t, difficulty)),
          h('p', null, t('view.suggestedRoute') + '：', routeLabel(t, route), ' · ', routeReasonsText(t, route)),
          h('p', { className: 'ddf-board-decision-note' }, t('view.decisionHint'))) : null,
        h('div', { className: 'ddf-board-decision-counters' }, count('direct', 'direct'), count('delegated', 'delegated'), count('denied', 'denied'),
          Number.isFinite(cumulative) ? h('span', { className: 'ddf-board-decision-cumulative' }, fill(t('table.cumulative'), { count: cumulative })) : null,
          session?.last?.tool ? h('details', { className: 'ddf-board-decision-interception' },
            h('summary', null, t('table.last') + '：', h('code', null, session.last.tool)),
            h('p', null, session.last.message || t('last.' + session.last.kind))) : null),
        session && !session.turnStats ? h('p', { className: 'ddf-board-decision-note ddf-board-decision-legacy' }, t('view.countersUnknown')) : null)
    }

    function InputDetails({ t, plan }) {
      if (!plan?.inputs?.length) return null
      const pending = plan.inputs.filter(input => ['queued', 'received'].includes(input.status))
      const entry = input => h('div', { key: input.id }, h('p', null, t('input.' + input.status), input.taskId ? ' · ' + input.taskId : '', ' · ', input.text),
        input.resolution ? h('p', null, input.resolution) : null,
        input.additionalCriteria?.length ? h('p', null, t('input.criteria') + '：' + input.additionalCriteria.join('；')) : null)
      return h('section', { className: 'ddf-board-next', 'data-inputs': '' },
        h('strong', null, t('input.title'), pending.length ? ' · ' + fill(t('input.pending'), { count: pending.length }) : ''),
        ...pending.map(entry), h('details', null, h('summary', null, t('input.history')), ...plan.inputs.filter(input => !pending.includes(input)).map(entry)))
    }

    function DashboardTaskCard({ t, task, plan, rootTask, onFix }) {
      const status = task.status || 'queued'
      const route = task.modelRoute?.actual ?? task.modelRoute?.resolved ?? task.modelRoute?.requested ?? task.model
      const auditActivity = task.audit ? t('audit.title') + ' · ' + t('audit.' + task.audit.status) : ''
      const dependencies = (task.dependsOn ?? []).map(id => plan.tasks.find(item => item.id === id)).filter(item => item && item.status !== 'accepted')
      const waiting = status === 'queued' && dependencies.length ? fill(t('view.boardDependency'), { tasks: dependencies.map(item => item.title || item.id).join('、') }) : ''
      const current = ['starting', 'running'].includes(task.audit?.status) ? task.audit : task
      const liveActivity = ['starting', 'running'].includes(current.status) && current.supervision?.activity
      const activity = waiting || (liveActivity ? (current.execution ? t('supervision.reporting')
        : t('supervision.activity.' + current.supervision.activity.kind) + (current.supervision.activity.tool ? '：' + current.supervision.activity.tool : ''))
        : auditActivity || task.execution?.summary || (task.progress?.tool ? t('view.latestActivity') + '：' + task.progress.tool : t('view.boardNoActivity')))
      const reason = ['failed', 'blocked', 'cancelled'].includes(status) ? dashboardReason(t, task) : ''
      const affected = dashboardAffected(task, plan.tasks)
      const issue = taskServiceIssue(t, task), auditIssue = taskServiceIssue(t, task.audit)
      const next = status === 'cancelled' ? t('chat.stoppedNext') : issue?.action
        || (task.recovered ? t('view.recoveredNext') : ['failed', 'blocked'].includes(status) ? t('view.failedNext') : '')
      const isRoot = Boolean(rootTask && rootTask.id === task.id)
      const detail = route ? `${route.provider} / ${route.model}` : t('plans.modelUnknown')
      const auditRoute = task.audit?.modelRoute?.actual ?? task.audit?.modelRoute?.resolved ?? task.audit?.modelRoute?.requested ?? task.dispatcherModel
      const fact = (label, value, note, kind) => h('div', { 'data-fact': kind }, h('dt', null, t(label)), h('dd', null, value,
        note ? h('span', { className: 'ddf-board-fact-note' }, note) : null))
      return h('article', { className: 'ddf-board-task', 'data-task-id': task.id, 'data-status': status,
        'data-root': isRoot ? 'true' : 'false', 'data-affected': affected ? 'true' : 'false' },
        h('div', { className: 'ddf-board-task-head' },
          h('div', { className: 'ddf-board-task-title-wrap' },
            h('h3', { className: 'ddf-board-task-title' }, task.title || task.id),
            h('div', { className: 'ddf-board-task-meta' },
              isRoot ? h('span', { className: 'ddf-board-task-tag' }, t('view.boardRootCause')) : null,
              affected ? h('span', { className: 'ddf-board-task-tag' }, t('view.boardAffected')) : null)),
          h('span', { className: 'ddf-board-task-status' }, t('status.' + status))),
        h('dl', { className: 'ddf-board-task-facts' },
          fact('view.taskModel', h('strong', { title: detail }, route?.model || t('plans.modelUnknown')),
            h('span', { className: 'ddf-board-model-check', 'data-state': modelStatusKey(task) },
              t(modelStatusKey(task) === 'plans.modelVerified' ? 'view.requestConsistent' : modelStatusKey(task))), 'model'),
          fact('view.taskComplexity', task.complexity === 'complex' ? t('view.taskComplex') : task.complexity === 'routine' ? t('view.taskRoutine') : t('cfg.unknown'), null, 'complexity'),
          fact('view.taskAudit', task.reviewPolicy === 'coordinator' && !task.audit ? t('view.auditCoordinator') : auditRoute?.model || t(reviewPolicyKey(task)),
            task.audit ? t('audit.' + task.audit.status) : task.reviewPolicy === 'independent' ? t('view.auditExplicit') : null, 'audit'),
          fact('view.taskAcceptance', t(status === 'accepted' ? 'status.accepted' : status === 'cancelled' ? 'view.acceptanceStopped' : status === 'review' ? 'view.acceptanceReview' : 'view.acceptancePending'), null, 'acceptance')),
        h('p', { className: 'ddf-board-task-line', 'data-current-activity': true }, h('strong', null, t('view.currentAction') + '：'), activity),
        h('p', { className: 'ddf-board-task-line' }, h('strong', null, t('plans.modelReason') + '：'), task.complexityReason || t('plans.modelReasonUnknown')),
        task.reviewPolicy ? h('p', { className: 'ddf-board-task-line' }, h('strong', null, t('view.auditReason') + '：'), task.reviewReason) : null,
        task.supervision || task.audit?.supervision ? h('details', { className: 'ddf-board-execution-diagnostics' },
          h('summary', null, t('view.executionDiagnostics')), h(SupervisionDetails, { t, task: current })) : null,
        reason ? h('p', { className: 'ddf-board-task-line', 'data-kind': status === 'cancelled' || affected ? undefined : 'error' }, h('strong', null, t('view.boardReason') + '：'), reason) : null,
        next ? h('p', { className: 'ddf-board-task-line', 'data-kind': 'next' }, h('strong', null, t('view.boardNext') + '：'), next) : null,
        requestRefused(task) && status !== 'cancelled' ? h(ServiceErrorDetails, { t, details: issue.details || task.error }) : null,
        task.audit ? h('p', { className: 'ddf-board-task-line' }, h('strong', null, t('audit.title') + '：'),
          task.audit.modelRoute?.requested ? `${task.audit.modelRoute.requested.provider} / ${task.audit.modelRoute.requested.model} · ` : '',
          task.audit.status === 'completed' && task.audit.specVerdict && task.audit.qualityVerdict
            ? fill(t('audit.verdicts'), { spec: t('audit.' + task.audit.specVerdict), quality: t('audit.' + task.audit.qualityVerdict) })
            : t('audit.' + task.audit.status)) : null,
        task.audit?.error ? h('p', { className: 'ddf-board-task-line', 'data-kind': 'error' }, auditIssue?.message || task.audit.error) : null,
        requestRefused(task.audit) ? h(ServiceErrorDetails, { t, details: auditIssue.details || task.audit.error }) : null,
        ...(task.issues ?? []).map(issue => h('p', { key: issue.id, className: 'ddf-board-task-line',
          'data-kind': issue.status === 'open' ? 'error' : undefined }, `${issue.id} · ${issue.finding} · ${(issue.evidence ?? []).join('、')}`)),
        task.issue?.code === 'MODEL_CONFIG_INVALID' ? h('button', { type: 'button', className: 'ddf-board-task-fix', onClick: () => onFix(task.issue.tier) }, t('plans.fixModel')) : null,
        h(TaskDetails, { t, task, compact: true }))
    }

    Object.assign(zh, {
      'focus.title': '协作动态', 'focus.all': '全部', 'focus.coordinator': '主控', 'focus.user': '需求发起者',
      'focus.worker': '执行者', 'focus.reviewer': '独立审查', 'focus.request': '本次需求', 'focus.decision': '主控判断',
      'focus.started': '开始执行', 'focus.tool': '工具记录', 'focus.activity': '当前活动', 'focus.checkpoint': '阶段记录 · 待核实',
      'focus.report': '正式报告 · 尚未验收', 'focus.reportAccepted': '正式报告 · 已验收', 'focus.reportStopped': '正式报告 · 任务已停止，未验收', 'focus.auditReport': '独立审查报告', 'focus.verification': '实际验证',
      'focus.review': '主控验收记录', 'focus.issue': '异常记录', 'focus.waiting': '等待原因', 'focus.receipt': '程序交付回执',
      'focus.toolReturned': '工具已返回，正确性尚待验证', 'focus.toolFailed': '工具返回错误', 'focus.empty': '尚未记录执行活动',
      'focus.memberEmpty': '该成员尚未产生记录', 'focus.recordsHint': '依据当前快照保留的近期工具活动、阶段记录和报告展示；完整证据见任务详情。',
      'focus.tasks': '任务详情', 'focus.close': '收起任务详情', 'focus.context': '需求与主控判断', 'focus.member': '按成员筛选',
      'focus.latest': '回到最新活动', 'focus.details': '查看报告与验收依据', 'focus.passed': '验证通过', 'focus.failed': '验证失败',
      'focus.more': '查看更多（还有 {count} 条）',
    })
    Object.assign(en, {
      'focus.title': 'Collaboration activity', 'focus.all': 'All', 'focus.coordinator': 'Coordinator', 'focus.user': 'Requester',
      'focus.worker': 'Worker', 'focus.reviewer': 'Independent reviewer', 'focus.request': 'Current request', 'focus.decision': 'Coordinator decision',
      'focus.started': 'Execution started', 'focus.tool': 'Tool record', 'focus.activity': 'Current activity', 'focus.checkpoint': 'Checkpoint · not verified',
      'focus.report': 'Formal report · not accepted', 'focus.reportAccepted': 'Formal report · accepted', 'focus.reportStopped': 'Formal report · stopped without acceptance', 'focus.auditReport': 'Independent review report', 'focus.verification': 'Actual verification',
      'focus.review': 'Coordinator acceptance record', 'focus.issue': 'Issue record', 'focus.waiting': 'Waiting reason', 'focus.receipt': 'Program delivery receipt',
      'focus.toolReturned': 'Tool returned; correctness still requires verification', 'focus.toolFailed': 'Tool returned an error', 'focus.empty': 'No execution activity recorded',
      'focus.memberEmpty': 'No records for this member yet', 'focus.recordsHint': 'Recent tool activity, checkpoints and reports retained in the current snapshot. Full evidence is available in task details.',
      'focus.tasks': 'Task details', 'focus.close': 'Close task details', 'focus.context': 'Request and coordinator decision', 'focus.member': 'Filter by member',
      'focus.latest': 'Latest activity', 'focus.details': 'View report and acceptance evidence', 'focus.passed': 'Verification passed', 'focus.failed': 'Verification failed',
      'focus.more': 'Show more ({count} earlier records)',
    })

    function collaborationRecords(t, plan, session) {
      const route = target => target?.modelRoute?.actual ?? target?.modelRoute?.resolved ?? target?.modelRoute?.requested ?? target?.model
      const request = session?.source ?? plan?.source, recordedDecision = plan?.decision ?? session?.decision
      const decision = request?.messageId && recordedDecision?.requestId && recordedDecision.requestId !== request.messageId ? null : recordedDecision
      const execution = request?.messageId && session?.execution?.requestId && session.execution.requestId !== request.messageId ? null : session?.execution
      const members = [{ id: 'coordinator', name: t('focus.coordinator'), role: t('focus.coordinator'), model: execution?.model?.model || decision?.model?.model }]
      const records = new Map()
      const add = (id, member, source, text, at, taskId, detail) => {
        if (text) records.set(id, { id, member, source, text, at: Number.isFinite(at) ? at : null, taskId, detail })
      }
      add('request:' + (request?.messageId || ''), 'user', 'request', request?.text, request?.at)
      if (decision) add('decision:' + (decision.revisionId || decision.at || ''), 'coordinator', 'decision', decision.reason, decision.at)
      const activityText = activity => activity?.kind === 'tool' ? liveToolLabel(t, activity.tool)
        : activity?.kind ? t('supervision.activity.' + activity.kind) : ''
      if (execution?.running) add('coordinator:activity', 'coordinator', 'activity', activityText(execution.activity), execution.activity?.at)
      if (execution?.lastResult) {
        const result = execution.lastResult
        add('coordinator:result:' + result.at, 'coordinator', 'tool', liveToolLabel(t, result.tool) + (result.target ? ' · ' + result.target : '')
          + ' · ' + t(result.failed ? 'focus.toolFailed' : 'focus.toolReturned'), result.at)
      }
      for (const failure of execution?.unresolvedChanges ?? []) add('coordinator:issue:' + failure.callId, 'coordinator', 'issue', failure.reason, failure.at)
      for (const task of plan?.tasks ?? []) {
        for (const [role, target] of [['worker', task], ...(task.audit ? [['reviewer', task.audit]] : [])]) {
          const id = role + ':' + task.id, model = route(target) ?? (role === 'reviewer' ? task.dispatcherModel : null)
          members.push({ id, name: task.title || task.id, role: t('focus.' + role), taskId: task.id, model: model?.model, modelState: modelStatusKey(target) })
          const prefix = id + ':' + (target.attempts ?? 0) + ':'
          const supervision = target.supervision, live = !['accepted', 'cancelled'].includes(task.status) && ['starting', 'running'].includes(target.status)
          if (Number.isFinite(supervision?.startedAt)) add(prefix + 'started', id, 'started', task.title || task.id, supervision.startedAt, task.id)
          for (const evidence of supervision?.evidence ?? []) add(prefix + 'tool:' + (evidence.callId || evidence.tool + ':' + evidence.at), id, 'tool',
            liveToolLabel(t, evidence.tool) + ' · ' + t(evidence.failed ? 'focus.toolFailed' : 'focus.toolReturned'), evidence.at, task.id)
          if (target.progress?.tool && !(supervision?.evidence ?? []).some(item => item.tool === target.progress.tool && item.at === target.progress.at))
            add(prefix + 'progress:' + target.progress.at, id, 'tool', liveToolLabel(t, target.progress.tool) + ' · ' + t(target.progress.failed ? 'focus.toolFailed' : 'focus.toolReturned'), target.progress.at, task.id)
          if (live) add(prefix + 'activity', id, 'activity', target.execution ? t('supervision.reporting') : activityText(supervision?.activity) || t('live.unknown'), supervision?.activity?.at, task.id)
          if (supervision?.checkpoint) add(prefix + 'checkpoint', id, 'checkpoint', supervision.checkpoint.summary, supervision.checkpoint.at, task.id)
          if (target.execution || target.report) add(prefix + 'report', id, role === 'reviewer' ? 'auditReport' : 'report', target.execution?.summary || target.report,
            target.execution?.at ?? target.finishedAt, task.id, target.execution?.reportPath)
          if (target.error || target.issue?.message) add(prefix + 'issue', id, 'issue', taskServiceIssue(t, target)?.message || target.error || target.issue?.message, target.finishedAt, task.id)
          if (supervision?.pending) add(prefix + 'supervision', id, 'issue', supervision.pending.reason, supervision.pending.at, task.id)
        }
        for (const [index, check] of (task.checks ?? []).entries()) if (check.result) add('verify:' + task.id + ':' + (check.result.callId || index), 'coordinator', 'verification',
          (task.title || task.id) + ' · ' + check.tool + ' · ' + t(check.result.passed ? 'focus.passed' : 'focus.failed') + (check.result.summary ? ' · ' + check.result.summary : ''),
          check.result.at, task.id)
        if (task.review) add('review:' + task.id + ':' + task.attempts, 'coordinator', 'review', (task.title || task.id) + ' · ' + t('status.' + task.status), task.review.at, task.id)
        if (task.status === 'queued') add('waiting:' + task.id, 'worker:' + task.id, 'waiting',
          (task.dependsOn ?? []).some(id => plan.tasks.some(item => item.id === id && item.status !== 'accepted')) ? t('accordion.dependency') : plan.dispatchWait?.message || t('view.actualQueued'), null, task.id)
        if (task.stop) add('stop:' + task.id, 'worker:' + task.id, 'issue', task.stop.reason, task.stop.at, task.id)
      }
      if (plan?.completion) add('receipt:' + plan.completion.id, 'coordinator', 'receipt', completionLabel(t, plan.completion), plan.completion.at)
      return { members, records: [...records.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)) }
    }

    const FOCUS_PAGE_SIZE = 20

    function CollaborationFeed({ t, plan, session, member, onMember, onOpenTask, history, onMore }) {
      const { members, records } = collaborationRecords(t, plan, session)
      const selected = members.some(item => item.id === member) ? member : 'all'
      const matching = selected === 'all' ? records : records.filter(record => record.member === selected)
      const range = history?.[selected], anchor = range ? matching.findIndex(record => record.id === range.firstId) : -1
      const remaining = anchor >= 0 ? anchor : Math.max(0, matching.length - (range?.count ?? FOCUS_PAGE_SIZE))
      const visible = matching.slice(remaining), nextStart = Math.max(0, remaining - FOCUS_PAGE_SIZE)
      return h('section', { className: 'ddf-focus-feed', 'data-collaboration-feed': '', 'aria-label': t('focus.title') },
        h('nav', { className: 'ddf-focus-members', 'aria-label': t('focus.member') },
          ...[{ id: 'all', name: t('focus.all') }, ...members].map(item => h('button', {
            key: item.id, type: 'button', 'data-member-filter': item.id, 'aria-pressed': selected === item.id,
            title: [item.role, item.name, item.model].filter(Boolean).join(' · '), onClick: () => onMember(item.id),
          }, h('span', { className: 'ddf-focus-avatar', 'aria-hidden': 'true' }, item.id === 'all' ? '⋯' : item.id === 'coordinator' ? t('focus.coordinator').slice(0, 1) : item.taskId?.slice(0, 2)),
          h('span', null, item.taskId ? item.role + ' · ' + item.name : item.name)))),
        h('div', { className: 'ddf-focus-messages', role: 'log', 'aria-label': t('focus.title'), 'aria-live': 'off' },
          remaining > 0 ? h('div', { className: 'ddf-focus-history' }, h('button', { type: 'button', className: 'ddf-board-action',
            'data-load-earlier': '', onClick: () => onMore(selected, matching[nextStart].id, matching.length - nextStart) }, fill(t('focus.more'), { count: remaining }))) : null,
          ...visible.map(record => {
            const actor = members.find(item => item.id === record.member) ?? { name: t('focus.user'), role: t('focus.user') }
            const task = plan?.tasks?.find(item => item.id === record.taskId)
            const source = record.source === 'report' ? task?.status === 'accepted' ? 'reportAccepted' : task?.status === 'cancelled' ? 'reportStopped' : 'report' : record.source
            return h('article', { key: record.id, className: 'ddf-focus-message', 'data-feed-entry': record.id, 'data-member': record.member, 'data-source': record.source },
              h('span', { className: 'ddf-focus-avatar', 'aria-hidden': 'true' }, actor.role?.slice(0, 1)),
              h('div', { className: 'ddf-focus-message-main' },
                h('div', { className: 'ddf-focus-byline' }, h('strong', null, actor.role + (actor.taskId ? ' · ' + actor.name : '')),
                  actor.model ? h('span', null, actor.model) : null,
                  record.at !== null ? h('time', { dateTime: new Date(record.at).toISOString() }, new Date(record.at).toLocaleTimeString()) : null),
                h('div', { className: 'ddf-focus-bubble' }, record.text),
                h('small', { className: 'ddf-focus-source' }, t('focus.' + source), actor.modelState ? ' · ' + t(actor.modelState) : ''),
                record.detail ? h('p', { className: 'ddf-focus-path' }, record.detail) : null,
                record.taskId && ['report', 'auditReport', 'verification', 'review', 'issue'].includes(record.source) ? h('button', { type: 'button', className: 'ddf-focus-record-link', 'data-open-task': record.taskId,
                  onClick: () => onOpenTask(record.taskId) }, t('focus.details')) : null))
          }),
          !visible.length ? h('p', { className: 'ddf-focus-empty' }, t(selected === 'all' ? 'focus.empty' : 'focus.memberEmpty')) : null,
          h('p', { className: 'ddf-focus-record-note' }, t('focus.recordsHint'))))
    }

    const FOCUS_BOARD_STYLES = `
.ddf-board-root:has(.ddf-focus-board) { overflow:hidden; background:var(--dsw-alias-bg-layer-1,#fff); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; }
.ddf-focus-board { flex:1 1 auto; height:100%; min-height:0; max-width:1440px; padding:0; gap:0; overflow:auto; overflow-anchor:none; overscroll-behavior:contain; scrollbar-width:thin; container:ddf-focus / inline-size; }
.ddf-focus-board [hidden] { display:none!important; }
.ddf-focus-board>.ddf-board-header { flex:none; position:sticky; top:0; z-index:3; background:var(--dsw-alias-bg-layer-1,#fff); padding:18px 22px 13px; margin:0; gap:14px; }
.ddf-focus-board pre { max-height:none; overflow:visible; }
.ddf-focus-board .ddf-board-title { font-size:18px; font-weight:600; line-height:1.5; }
.ddf-focus-board .ddf-board-meta { font-size:11px; margin-top:3px; }
.ddf-focus-board .ddf-board-actions { gap:6px; }
.ddf-focus-board .ddf-board-action { font-size:12px; min-height:29px; border-radius:7px; }
.ddf-focus-stats { display:flex; flex-wrap:wrap; align-items:center; gap:7px 18px; padding:10px 22px; font-size:12px; color:var(--dsw-alias-label-secondary,#646a73); flex:none; }
.ddf-focus-stats>strong { color:var(--dsw-alias-label-primary,#1f2329); font-size:13px; font-weight:500; }
.ddf-focus-stats .ddf-board-status { margin:0; padding:2px 8px; font-size:11px; }
.ddf-focus-context { flex:none; padding:0 22px 11px; border-bottom:1px solid var(--dsw-alias-border-l1,#e5e6eb); font-size:12px; }
.ddf-focus-context>summary { cursor:pointer; color:var(--dsw-alias-label-secondary,#646a73); width:fit-content; }
.ddf-focus-context .ddf-board-hero { margin-top:12px; padding:12px 15px; }
.ddf-focus-context .ddf-board-goal { font-size:14px; }
.ddf-focus-context .ddf-board-decision { margin-top:12px; }
.ddf-focus-context .ddf-board-decision-main { grid-template-columns:1fr 1.3fr; }
.ddf-focus-context .ddf-board-decision-level strong { font-size:22px; }
.ddf-focus-context .ddf-board-decision-signals,.ddf-focus-context .ddf-board-decision-note { font-size:12px; }
.ddf-focus-context .ddf-board-diagnostics { margin-top:10px; }
.ddf-focus-notices { flex:none; padding:0 22px; font-size:12px; }
.ddf-focus-notices:empty { display:none; }
.ddf-focus-notices .ddf-board-next,.ddf-focus-notices .ddf-board-empty,.ddf-focus-notices .ddf-chat-notice { margin:8px 0; padding:9px 12px; font-size:12px; }
.ddf-focus-board>.ddf-board-load-issue,.ddf-focus-board>.ddf-board-inline-notice { margin:8px 22px; flex:none; }
.ddf-focus-workspace { flex:none; min-height:0; display:grid; grid-template-columns:minmax(0,1fr); position:relative; }
.ddf-focus-workspace[data-drawer-open="true"] { grid-template-columns:minmax(0,1fr) minmax(290px,34%); }
.ddf-focus-feed { min-width:0; min-height:0; }
.ddf-focus-members { display:flex; flex-wrap:wrap; gap:6px; padding:12px 22px; border-bottom:1px solid var(--dsw-alias-border-l1,#e5e6eb); }
.ddf-focus-members button { display:inline-flex; align-items:center; gap:6px; max-width:210px; padding:4px 8px; border:0; border-radius:8px; background:transparent; color:var(--dsw-alias-label-secondary,#646a73); font:inherit; font-size:12px; line-height:1.5; cursor:pointer; }
.ddf-focus-members button>span:last-child { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.ddf-focus-members button[aria-pressed="true"] { background:var(--dsw-alias-bg-layer-2,#f1f4fa); color:var(--dsw-alias-state-business-primary,#2878e5); }
.ddf-focus-avatar { width:30px; height:30px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; flex:none; background:var(--dsw-alias-bg-layer-2,#f1f4fa); color:var(--dsw-alias-state-business-primary,#2878e5); font-size:12px; }
.ddf-focus-members .ddf-focus-avatar { width:23px; height:23px; font-size:10px; }
.ddf-focus-messages { padding:20px clamp(18px,6%,70px); }
.ddf-focus-history { margin:0 0 20px; text-align:center; }
.ddf-focus-message { display:flex; gap:11px; margin:0 0 19px; min-width:0; }
.ddf-focus-message-main { min-width:0; max-width:calc(100% - 42px); }
.ddf-focus-byline { display:flex; align-items:baseline; flex-wrap:wrap; gap:5px 10px; margin-bottom:5px; font-size:11px; color:var(--dsw-alias-label-secondary,#646a73); }
.ddf-focus-byline strong { font-size:12px; font-weight:500; color:var(--dsw-alias-label-primary,#1f2329); }
.ddf-focus-bubble { border-radius:4px 14px 14px; background:var(--dsw-alias-bg-layer-2,#f1f2f5); padding:10px 14px; font-size:13px; line-height:1.7; overflow-wrap:anywhere; white-space:pre-wrap; }
.ddf-focus-message[data-source="decision"] .ddf-focus-bubble { border-left:2px solid var(--dsw-alias-state-business-primary,#2878e5); }
.ddf-focus-message[data-source="issue"] .ddf-focus-bubble { border-left:2px solid var(--ddf-board-error); }
.ddf-focus-message[data-source="verification"] .ddf-focus-bubble { border-left:2px solid var(--dsw-alias-state-business-primary,#2878e5); }
.ddf-focus-message[data-member="user"] { flex-direction:row-reverse; }
.ddf-focus-message[data-member="user"] .ddf-focus-bubble { border-radius:14px 4px 14px 14px; }
.ddf-focus-source { display:block; margin:5px 2px 0; color:var(--dsw-alias-label-secondary,#646a73); font-size:11px; }
.ddf-focus-path { margin:4px 2px; font-size:11px; color:var(--dsw-alias-label-secondary,#646a73); overflow-wrap:anywhere; }
.ddf-focus-record-link { padding:4px 2px; border:0; background:transparent; color:var(--dsw-alias-state-business-primary,#2878e5); font:inherit; font-size:12px; line-height:1.5; text-align:left; cursor:pointer; }
.ddf-focus-empty,.ddf-focus-record-note { color:var(--dsw-alias-label-secondary,#646a73); font-size:12px; margin:10px 0; }
.ddf-focus-drawer { min-width:0; padding:0 16px 18px; border-left:1px solid var(--dsw-alias-border-l1,#e5e6eb); background:var(--dsw-alias-bg-layer-1,#fff); }
.ddf-focus-drawer-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:14px 0; background:var(--dsw-alias-bg-layer-1,#fff); }
.ddf-focus-drawer-head h2 { font-size:14px; font-weight:500; margin:0; }
.ddf-focus-drawer .ddf-board-section-head { display:none; }
.ddf-focus-drawer .ddf-board-task-list { display:block; }
.ddf-focus-task { padding:11px 0; border-bottom:1px solid var(--dsw-alias-border-l1,#e5e6eb); }
.ddf-focus-task>summary { cursor:pointer; font-size:12px; overflow-wrap:anywhere; }
.ddf-focus-task>summary>strong { font-weight:500; }
.ddf-focus-task>summary>span { display:block; margin:4px 0 0 14px; color:var(--dsw-alias-label-secondary,#646a73); font-size:11px; }
.ddf-focus-drawer .ddf-board-task { padding:12px 0 2px; border:0; border-radius:0; box-shadow:none; }
.ddf-focus-drawer .ddf-board-task-title { font-size:14px; }
.ddf-focus-drawer .ddf-board-task-facts { display:flex; flex-direction:column; gap:8px; }
.ddf-focus-drawer .ddf-board-task-line,.ddf-focus-drawer .ddf-board-fact-note { font-size:12px; }
.ddf-focus-board button:focus-visible,.ddf-focus-board summary:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary,#2878e5); outline-offset:2px; }
@container ddf-focus (max-width:780px) {
 .ddf-focus-board>.ddf-board-header { padding:14px 16px 10px; flex-wrap:wrap; }
 .ddf-focus-board .ddf-board-title { font-size:16px; }
 .ddf-focus-board .ddf-board-meta { font-size:11px; }
 .ddf-focus-board .ddf-board-actions { justify-content:flex-start; }
 .ddf-focus-stats { padding:9px 16px; gap:5px 12px; }
 .ddf-focus-context { padding:0 16px 10px; }
 .ddf-focus-context .ddf-board-decision-main { grid-template-columns:minmax(0,1fr); }
 .ddf-focus-members { padding:9px 16px; }
 .ddf-focus-members button { max-width:175px; }
 .ddf-focus-messages { padding:16px; }
 .ddf-focus-notices { padding:0 16px; }
 .ddf-focus-workspace[data-drawer-open="true"] { grid-template-columns:minmax(0,1fr); }
 .ddf-focus-workspace[data-drawer-open="true"] .ddf-focus-feed { display:none; }
 .ddf-focus-drawer { border-left:0; }
}
`

    function DashboardPage({ t, state, sessionId, plan, openView, enabledView, onFix, detailsOpen, onToggleDetails, notice, updatedAt, member, onMember, onOpenTask, selectedTask, feedRef, onFeedScroll, onLatest, showLatest, drawerButtonRef, history, onMore }) {
      const tasks = plan?.tasks ?? [], status = dashboardStatusKey(plan)
      const statusLabel = plan?.completion ? completionLabel(t, plan.completion) : status === 'accepted' && plan.protocolVersion >= 2
        ? t('chat.receiptPending') : t({ failed: 'view.boardFailed', accepted: 'view.boardDone', review: 'view.boardReview' }[status] || 'status.' + status)
      const accepted = tasks.filter(task => task.status === 'accepted').length
      const returned = tasks.filter(task => ['review', 'accepted'].includes(task.status)).length
      const pending = tasks.filter(task => !['accepted', 'cancelled'].includes(task.status))
      const running = pending.filter(task => ['starting', 'running'].includes(task.status) || ['starting', 'running'].includes(task.audit?.status)).length
      const waiting = pending.filter(task => task.status === 'queued' || task.audit?.status === 'queued').length
      const problems = pending.map(task => ['failed', 'blocked'].includes(task.audit?.status) ? task.audit : task)
      const rootTask = status === 'cancelled' ? null : dashboardRootTask(tasks)
      const orderedTasks = rootTask ? [rootTask, ...tasks.filter(task => task !== rootTask)] : tasks
      const blockers = plan ? blockersOf(plan) : [], modelBlock = blockers.find(task => task.issue?.code === 'MODEL_CONFIG_INVALID')
      const session = state?.sessions?.find(item => item.sessionId === sessionId), request = session?.source
      const route = plan?.routing || session?.route, sessionTitle = plan?.sessionTitle || session?.sessionTitle
      const previous = state?.plans?.find(item => item.sessionId === sessionId && item !== plan)
      const next = plan?.completion ? completionNext(t, plan, state) : serviceProblem(plan)?.action || (plan ? dashboardNextText(t, status, tasks, modelBlock, rootTask) : '')
      const links = (state ? ['chat', 'fleet', 'share'] : ['chat']).map(id => {
        const enabled = enabledView(id)
        return h('button', { key: id, type: 'button', className: 'ddf-board-action', disabled: !enabled,
          title: enabled ? undefined : t('view.unavailable'), onClick: enabled ? () => openView(id) : undefined }, t('view.' + id))
      })
      return h('div', { className: 'ddf-board-root', 'data-ddf-acceptance': '', 'data-conversation-composer-overlay': '' },
        h('style', null, DASHBOARD_STYLES + FOCUS_BOARD_STYLES),
        h('main', { className: 'ddf-board ddf-focus-board', 'data-status': status, ref: feedRef, onScroll: onFeedScroll },
          h('header', { className: 'ddf-board-header' },
            h('div', null, h('h1', { className: 'ddf-board-title' }, sessionTitle || t('focus.title')),
              h('p', { className: 'ddf-board-meta' }, sessionTitle
                ? fill(t('view.currentSessionTitle'), { title: sessionTitle }) + ' · ' + shortId(sessionId)
                : t('view.currentSession') + ' · ' + shortId(sessionId),
                updatedAt ? ' · ' + fill(t('view.lastRead'), { time: new Date(updatedAt).toLocaleTimeString() }) : '', ' · ' + t('view.footNote'))),
            h('div', { className: 'ddf-board-actions' },
              showLatest && !detailsOpen ? h('button', { type: 'button', className: 'ddf-board-action', onClick: onLatest, 'data-follow-latest': '' }, t('focus.latest')) : null,
              h('button', { type: 'button', className: 'ddf-board-action', 'data-drawer-toggle': '', 'aria-expanded': detailsOpen,
                'aria-controls': 'ddf-focus-task-drawer', ref: drawerButtonRef, onClick: onToggleDetails }, t(detailsOpen ? 'focus.close' : 'focus.tasks')),
              ...links)),
          notice,
          state?.storageError ? h('p', { className: 'ddf-board-inline-notice', 'data-kind': 'error', role: 'alert' }, state.storageError) : null,
          h('div', { className: 'ddf-focus-stats', 'aria-label': t('view.boardProgress') },
            plan ? h('span', { className: 'ddf-board-status', 'data-status': status, role: 'status' }, statusLabel) : null,
            h('strong', null, fill(t('dock.taskCount'), { count: tasks.length })),
            ...[[t('dock.running'), running], [t('dock.waiting'), waiting], [t('dock.awaitingReview'), tasks.filter(task => task.status === 'review' && !['queued', 'starting', 'running'].includes(task.audit?.status)).length]]
              .filter(([, count]) => count > 0).map(([label, count]) => h('span', { key: label }, label + ' ' + count)),
            ...['refused', 'failed', 'blocked'].map(kind => ({ kind, count: problems.filter(task => ['failed', 'blocked'].includes(task.status) && (kind === 'refused' ? requestRefused(task) : !requestRefused(task) && task.status === kind)).length }))
              .filter(item => item.count > 0).map(item => h('span', { key: item.kind }, t(item.kind === 'refused' ? 'dock.requestRefused' : 'dock.' + item.kind) + ' ' + item.count)),
            plan ? h('span', null, t('dock.accepted') + ' ' + accepted + '/' + tasks.length) : null),
          h('details', { className: 'ddf-focus-context' }, h('summary', null, t('focus.context')),
            plan || request?.text ? h('section', { className: 'ddf-board-hero' },
              h('div', null, h('p', { className: 'ddf-board-hero-label' }, t(request?.messageId ? 'view.boardRequest' : 'view.recordedRequest')),
                h('p', { className: 'ddf-board-goal' }, plan?.goal || request?.text || plan?.source?.text || t('view.unknownSource'))),
              h('span', { className: 'ddf-board-status', 'data-status': status, role: 'status' }, plan ? statusLabel : t('view.actualNoPlan'))) : null,
            plan || session || route ? h(BoardDecision, { t, session, plan, status, running }) : null,
            h(UsageDetails, { t, usage: state?.requestUsage?.find(entry => entry.sessionId === sessionId && (!request?.messageId || entry.requestId === request.messageId)) ?? plan?.usage }),
            state ? h('p', { className: 'ddf-board-inline-notice', 'data-runtime-policy': state.runtimePolicyVersion ?? 'unknown' }, t(state.runtimePolicyVersion >= 2 ? 'runtime.active' : 'runtime.pending')) : null,
            state ? h('p', { className: 'ddf-board-inline-notice', 'data-coordination-policy': state.coordinationPolicyVersion ?? 'unknown' }, t(state.coordinationPolicyVersion >= 6 ? 'coordination.active' : 'coordination.pending')) : null,
            plan?.routingWarnings?.length ? h('p', { className: 'ddf-board-inline-notice' }, fill(t('plans.routeWarnings'), { warnings: plan.routingWarnings.join('；') })) : null,
            plan ? h('details', { className: 'ddf-board-diagnostics' }, h('summary', null, t('view.source')), h(PlanDetails, { t, plan, sessionId, hidden: false })) : null,
            previous ? h('details', { className: 'ddf-board-diagnostics', 'data-previous-request': previous.source?.messageId || 'unknown' },
              h('summary', null, t('view.otherRequest')), h('p', null, previous.goal, ' · ', previous.completion ? completionLabel(t, previous.completion) : t('status.' + previous.status)),
              h('p', null, previous.source?.text || t('view.unknownSource')), h('p', null, t('view.message') + '：', previous.source?.messageId || '—')) : null,
            session ? h('details', { className: 'ddf-board-diagnostics' }, h('summary', null, t('view.diagnostics')), h(StateCard, { t, state: { sessions: [session] } })) : null,
            state?.archiveWarning ? h('details', { className: 'ddf-board-diagnostics' }, h('summary', null, t('view.archiveWarning')), h('p', { className: 'ddf-board-inline-notice' }, state.archiveWarning)) : null),
          h('div', { className: 'ddf-focus-notices' },
            h(CompletionReceipt, { t, plan, state }), h(CoordinationIssueNotice, { t, plan }),
            !plan?.completion && plan?.coordinatorIssue && !plan.coordinatorIssue.resolvedAt && !plan.cancelled ? h(ServiceIssueNotice, { t, issue: plan.coordinatorIssue }) : null,
            h(InputDetails, { t, plan }),
            state && !plan ? h('section', { className: 'ddf-board-empty', role: 'status' }, h('h2', null, t('view.boardNoPlan')), h('p', null, t(state?.requestBindingVersion >= 2 ? 'view.modelNoPlanHint' : 'view.boardNoPlanHint'))) : null,
            plan ? h('section', { className: 'ddf-board-next', role: 'status' }, h('b', null, t('view.boardNext') + '：'), next,
              status === 'cancelled' && tasks.some(task => task.status !== 'accepted') ? h('p', null, fill(t('view.boardUnfinished'), { tasks: tasks.filter(task => task.status !== 'accepted').map(task => task.title || task.id).join('、') })) : null,
              plan.dispatchWait?.message && !['accepted', 'cancelled'].includes(status) ? h('p', null, t('plans.dispatchWaiting') + plan.dispatchWait.message) : null,
              plan.autoDispatch === false && blockers.length && status !== 'cancelled' ? h('p', null, t('plans.autoPaused')) : null,
              modelBlock && status !== 'cancelled' ? h('button', { type: 'button', className: 'ddf-board-action', onClick: () => onFix(modelBlock.issue.tier) }, t('plans.fixModel')) : null) : null),
          h('div', { className: 'ddf-focus-workspace', 'data-drawer-open': detailsOpen },
            h(CollaborationFeed, { t, plan, session, member, onMember, onOpenTask, history, onMore }),
            h('aside', { id: 'ddf-focus-task-drawer', className: 'ddf-focus-drawer', 'data-task-drawer': '', 'data-selected-task': selectedTask,
              hidden: !detailsOpen, 'aria-label': t('focus.tasks') },
              h('div', { className: 'ddf-focus-drawer-head' }, h('h2', null, t('focus.tasks'))),
              plan ? h('section', { 'data-task-list': '' },
                h('div', { className: 'ddf-board-section-head' }, h('h2', { className: 'ddf-board-section-title' }, t('view.boardTasks')), h('span', { className: 'ddf-board-section-note' }, fill(t('view.boardTaskCount'), { count: tasks.length }))),
                h('div', { className: 'ddf-board-task-list' }, ...orderedTasks.map((task, index) => h('details', { key: task.id, className: 'ddf-focus-task', open: detailsOpen && (selectedTask ? selectedTask === task.id : index === 0) },
                  h('summary', null, h('strong', null, task.title || task.id), h('span', null, t(task.status === 'queued' && (task.dependsOn ?? []).some(id => tasks.some(other => other.id === id && other.status !== 'accepted')) ? 'accordion.dependency' : 'status.' + task.status))),
                  h(DashboardTaskCard, { t, task, plan, rootTask, onFix }))))) : h('p', null, t('view.boardNoPlan')),
              h('p', { className: 'ddf-focus-record-note' }, t('view.boardReturned') + ' ' + returned + '/' + tasks.length,
                plan?.activationBudget ? ' · ' + t('view.boardAttempts') + ' ' + plan.activationBudget.used + '/' + plan.activationBudget.limit : ''))),
          state?.legacyHost ? h('p', { className: 'ddf-board-inline-notice', role: 'status' }, t('view.legacyHost')) : null))
    }


    function TaskView({ t, sessionId, openView, getViews, onFix }) {
      const [result, setResult] = useState({ data: null, error: '', loading: true, updatedAt: null })
      const [detailsOpen, setDetailsOpen] = useState(false)
      const [focus, setFocus] = useState({ key: '', member: 'all', taskId: null })
      const [showLatest, setShowLatest] = useState(false)
      const feedRef = useRef(null)
      const drawerButtonRef = useRef(null)
      const following = useRef({ key: '', member: 'all', active: true })
      const historyScroll = useRef(null)
      const refreshRef = useRef(null)
      useEffect(() => {
        if (!sessionId) return
        let alive = true, inFlight
        const refresh = async (manual = false) => {
          if (inFlight) return
          const controller = new AbortController()
          inFlight = controller
          if (manual) setResult(previous => ({ ...previous, loading: true }))
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8000)])
          try {
            const data = await getState(signal, sessionId)
            if (alive && !signal.aborted) setResult({ data, error: '', loading: false, updatedAt: Date.now() })
          } catch (error) {
            if (alive && !controller.signal.aborted) setResult(previous => ({ ...previous, loading: false, error: error.message || String(error) }))
          } finally { if (inFlight === controller) inFlight = null }
        }
        refreshRef.current = refresh
        void refresh(true)
        const timer = window.setInterval(() => { void refresh() }, POLL_MS)
        return () => { alive = false; refreshRef.current = null; window.clearInterval(timer); inFlight?.abort() }
      }, [sessionId])
      const state = result.data?.sessionId === sessionId ? result.data : null
      const plan = currentPlanOf(state, sessionId)
      const focusKey = sessionId + ':' + (state?.sessions?.find(item => item.sessionId === sessionId)?.source?.messageId || plan?.source?.messageId || '') + ':' + (plan?.createdAt ?? '')
      const selection = focus.key === focusKey ? focus : { member: 'all', taskId: null }
      useEffect(() => {
        const saved = historyScroll.current, page = feedRef.current
        historyScroll.current = null
        if (page && saved?.key === focusKey && saved.member === selection.member) {
          if (saved.anchor?.isConnected) page.scrollTop += saved.anchor.getBoundingClientRect().top - saved.anchorTop
          else page.scrollTop = saved.top + page.scrollHeight - saved.height
        }
      }, [focusKey, selection.member, selection.history])
      useEffect(() => {
        const reset = following.current.key !== focusKey || following.current.member !== selection.member
        following.current = { key: focusKey, member: selection.member, active: reset || following.current.active }
        if (reset) setShowLatest(false)
        if (following.current.active && feedRef.current && !detailsOpen) feedRef.current.scrollTop = feedRef.current.scrollHeight
      }, [result.updatedAt, focusKey, selection.member, detailsOpen])
      useEffect(() => {
        if (!detailsOpen || focus.key !== focusKey) return
        const page = feedRef.current, target = page?.querySelector?.('.ddf-focus-task[open]')
        if (target) page.scrollTop += target.getBoundingClientRect().top - page.getBoundingClientRect().top
          - (page.querySelector('.ddf-board-header')?.getBoundingClientRect().height ?? 0) - 12
      }, [detailsOpen, focus.key, focusKey, selection.taskId])
      useEffect(() => {
        if (typeof document === 'undefined' || !detailsOpen || focus.key !== focusKey) return
        const close = event => { if (event.key === 'Escape') { setDetailsOpen(false); drawerButtonRef.current?.focus() } }
        document.addEventListener('keydown', close)
        return () => document.removeEventListener('keydown', close)
      }, [detailsOpen, focus.key, focusKey])
      const views = getViews()
      const enabledView = id => typeof openView === 'function' && views.some(view => view.id === id)
      const notice = result.error ? h('section', { className: 'ddf-board-load-issue', 'data-stale': Boolean(state), role: 'status' },
            h('h2', null, t(state ? 'view.staleTitle' : 'view.loadTitle')),
            h('p', null, t(state ? 'view.staleHint' : 'view.loadHint'),
              state && result.updatedAt ? ' ' + fill(t('view.lastRead'), { time: new Date(result.updatedAt).toLocaleTimeString() }) : null),
            h('button', { type: 'button', className: 'ddf-board-action', disabled: result.loading,
              onClick: () => { void refreshRef.current?.(true) } }, t(result.loading ? 'view.retrying' : 'view.retry')),
            h('details', null, h('summary', null, t('view.loadDetails')), h('pre', null, result.error)))
        : !sessionId || !state ? h('p', { className: 'ddf-board-inline-notice', role: 'status' }, t(!sessionId ? 'view.noSession' : 'view.loading')) : null
      return h(DashboardPage, { t, state, sessionId, plan, openView, enabledView, onFix, notice, updatedAt: result.updatedAt,
        member: selection.member, feedRef, drawerButtonRef, showLatest, history: selection.history,
        onMore: (member, firstId, count) => {
          const page = feedRef.current, anchor = page?.querySelector?.('[data-feed-entry]')
          historyScroll.current = page ? { key: focusKey, member, top: page.scrollTop, height: page.scrollHeight,
            anchor, anchorTop: anchor?.getBoundingClientRect().top } : null
          following.current.active = false; setShowLatest(true)
          setFocus(previous => {
            const current = previous.key === focusKey ? previous : selection
            return { ...current, key: focusKey, history: { ...current.history, [member]: { firstId, count } } }
          })
        },
        onFeedScroll: event => { const element = event.currentTarget; following.current.active = element.scrollHeight - element.scrollTop - element.clientHeight < 48; setShowLatest(!following.current.active) },
        onLatest: () => { following.current.active = true; setShowLatest(false); if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight },
        onMember: member => setFocus({ ...selection, key: focusKey, member }),
        onOpenTask: taskId => { setFocus({ ...selection, key: focusKey, taskId }); setDetailsOpen(true) },
        selectedTask: selection.taskId, detailsOpen: focus.key === focusKey && detailsOpen,
        onToggleDetails: () => { setFocus({ ...selection, key: focusKey }); setDetailsOpen(value => focus.key === focusKey ? !value : true) } })
    }
    /** Labelled diagnostics wrap independently at any conversation width. */
    function SessionAssessment({ t, session }) {
      const level = levelKey(session.difficulty)
      const score = session.difficulty?.score
      const field = (key, ...values) => h('div', { key }, h('dt', null, t('table.' + key)), h('dd', null, ...values))
      return h('article', null, h(DecisionDetails, { t, decision: session.decision, current: session.decisionCurrent !== false, resolution: session.messageResolution, pending: session.pendingMessages }), h('dl', null,
        field('session', h('code', { title: session.sessionId }, shortId(session.sessionId)), t(session.role === 'worker' ? 'role.worker' : 'role.coordinator')),
        field('difficulty', level ? t('level.' + level) : t('difficulty.none'),
          level && Number.isFinite(score) ? h('span', null, fill(t('difficulty.score'), { score })) : null,
          h('span', { className: 'ddf-diff-meta' }, signalsText(t, session.difficulty))),
        field('route', session.route?.route ? routeLabel(t, session.route) : t('difficulty.none'),
          session.route?.route ? h('span', { className: 'ddf-diff-meta' }, routeReasonsText(t, session.route)) : null),
        field('direct', String(session.turnStats?.direct ?? session.direct ?? 0)),
        field('delegated', String(session.turnStats?.delegated ?? session.delegated ?? 0)),
        field('denied', session.turnStats ? String(session.turnStats.denied ?? 0) : '—',
          h('span', { className: 'ddf-diff-meta', title: session.sessionStats?.since
            ? t('table.since') + '：' + new Date(session.sessionStats.since).toLocaleString() : undefined },
            fill(t('table.cumulative'), { count: session.sessionStats?.denied ?? session.denied ?? 0 }))),
        field('last', session.last?.tool ? h('code', null, String(session.last.tool)) : t('last.none'),
          session.last?.tool ? h('span', { className: 'ddf-diff-meta' }, session.last.message || t('last.' + session.last.kind)) : null)))
    }

    function StateCard({ t, state }) {
      const sessions = Array.isArray(state?.sessions) ? state.sessions : []
      return h('section', { className: 'ddf-board-assessment' },
        h('p', null, t('state.subtitle')),
        ...sessions.map(session => h(SessionAssessment, { key: session.sessionId, t, session })))
    }

    /** Sidebar row glyph: a gate with an arrow leaving it. */
    function DelegationIcon(props) {
      const size = props?.size ?? 16
      const active = props?.active === true
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', opacity: active ? 1 : 0.9 },
      },
      h('path', {
        d: 'M5.2 4.4h8.6l5 5v10.2a2 2 0 0 1-2 2H5.2a2 2 0 0 1-2-2V6.4a2 2 0 0 1 2-2Z',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinejoin: 'round',
      }),
      h('path', { d: 'M13.4 4.6v4.6h4.7', stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round' }),
      h('path', { d: 'M7.6 14.6h6.2', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      h('path', { d: 'M11.6 12.2l2.4 2.4-2.4 2.4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    // -----------------------------------------------------------------------
    // Page
    // -----------------------------------------------------------------------

    function DelegationPanel(props) {
      const t = props?.t ?? (key => key), catalog = props.catalog, modelHealth = props.modelHealth
      const catalogState = useCatalog(catalog)
      const health = useSyncExternalStore(modelHealth.subscribe, modelHealth.getSnapshot)
      const [config, setConfig] = useState(null), [draft, setDraft] = useState(draftOf(null))
      const [phase, setPhase] = useState('loading'), [save, setSave] = useState({ status: 'idle', error: '' })
      const [tab, setTab] = useState(props.focusTier ? 'models' : 'policy')
      const [conflict, setConflict] = useState(null), [refreshedAt, setRefreshedAt] = useState(null)
      const [refreshError, setRefreshError] = useState(''), [refreshing, setRefreshing] = useState(false)
      const alive = useRef(true), dirty = useRef(false), base = useRef(null), inFlight = useRef(null), saving = useRef(false), savedTimer = useRef(null)
      useEffect(() => { catalog.load().catch(() => {}) }, [catalog])
      useEffect(() => { if (health.remind) modelHealth.dismiss() }, [health.remind, modelHealth])
      useEffect(() => { if (props.focusTier) setTab('models') }, [props.focusTier])
      useEffect(() => { if (phase === 'ready' && props.focusTier && tab === 'models') focusModel(props.focusTier) }, [phase, props.focusTier, tab])
      useEffect(() => () => { alive.current = false; inFlight.current?.abort(); window.clearTimeout(savedTimer.current) }, [])
      const onRefreshModels = useCallback(async () => { try { await catalog.refresh() } catch { /* Catalog store exposes refresh errors. */ } }, [catalog])
      const refresh = useCallback(async () => {
        if (inFlight.current || saving.current) return
        const controller = new AbortController(); inFlight.current = controller
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8000)])
        try {
          const next = await getConfig(signal)
          if (!alive.current || signal.aborted) return
          setConfig(next); modelHealth.publish(next)
          if (!dirty.current) { base.current = next; setDraft(draftOf(next)); setConflict(null) }
          else setConflict(configSignature(next) !== configSignature(base.current) ? next : null)
          setRefreshedAt(Date.now()); setRefreshError(''); setPhase('ready')
        } catch (error) {
          if (!alive.current || controller.signal.aborted) return
          setRefreshError(error.message || String(error)); setPhase(previous => previous === 'ready' ? 'ready' : 'error')
        } finally { if (inFlight.current === controller) inFlight.current = null }
      }, [modelHealth])
      useEffect(() => {
        alive.current = true; void refresh()
        const timer = window.setInterval(() => { void refresh() }, POLL_MS)
        return () => window.clearInterval(timer)
      }, [refresh])
      const onRefresh = useCallback(async () => { setRefreshing(true); try { await refresh() } finally { if (alive.current) setRefreshing(false) } }, [refresh])
      const onDraft = patch => {
        if (!config || config.locked || saving.current) return
        if (!dirty.current) base.current = config
        const next = { ...draft, ...patch }
        dirty.current = !sameValue(next, draftOf(base.current)); setDraft(next); setSave({ status: 'idle', error: '' })
        if (!dirty.current) { base.current = config; setDraft(draftOf(config)); setConflict(null) }
      }
      const discard = () => { if (!config || saving.current) return
        dirty.current = false; base.current = config; setDraft(draftOf(config)); setConflict(null); setSave({ status: 'idle', error: '' }) }
      const keepEdits = () => {
        const previous = draftOf(base.current), next = draftOf(conflict)
        for (const key of Object.keys(previous)) {
          if (key === 'models') { next.models = { ...next.models }
            for (const tier of MODEL_ROLES) if (!sameValue(draft.models?.[tier], previous.models?.[tier])) next.models[tier] = draft.models?.[tier] ?? null
          } else if (!sameValue(draft[key], previous[key])) next[key] = draft[key]
        }
        base.current = conflict; dirty.current = !sameValue(next, draftOf(conflict)); setDraft(next); setConflict(null); setSave({ status: 'idle', error: '' })
      }
      const errors = configErrors(t, config, draft), errorCount = Object.keys(errors).length
      const invalidModels = MODEL_ROLES.filter(tier => modelProblem(draft.models?.[tier], catalogState))
      const disabled = !config || config.locked === true || config.modelRouting !== 'roles' || config.reviewerModelPolicy !== 'dispatcher-snapshot' || save.status === 'saving'
      const onSave = async () => {
        if (disabled || saving.current || conflict || errorCount || (!sameValue(draft.mode, 'off') && invalidModels.length)) return
        saving.current = true; setSave({ status: 'saving', error: '' }); inFlight.current?.abort(); inFlight.current = null
        window.clearTimeout(savedTimer.current)
        try {
          const saved = await postConfig({ ...draft, ...(base.current?.revision ? { revision: base.current.revision } : {}) })
          if (!alive.current) return
          dirty.current = false; base.current = saved; setConfig(saved); setDraft(draftOf(saved)); setConflict(null)
          modelHealth.publish(saved); setSave({ status: 'saved', error: '' }); setRefreshedAt(Date.now()); setRefreshError('')
          savedTimer.current = window.setTimeout(() => { if (alive.current) setSave(previous => previous.status === 'saved' ? { status: 'idle', error: '' } : previous) }, SAVED_HOLD_MS)
        } catch (error) {
          if (!alive.current) return
          if (error.code === 'CONFIG_CONFLICT' && error.config?.revision) { setConfig(error.config); setConflict(error.config); modelHealth.publish(error.config) }
          else if (error.status === 409 && error.config?.locked) { setConfig(error.config); modelHealth.publish(error.config) }
          setSave({ status: 'failed', error: error.message || String(error) })
        } finally { saving.current = false }
      }
      const tabCount = key => key === 'policy' ? Number(Boolean(errors.threshold)) : key === 'limits' ? errorCount - Number(Boolean(errors.threshold)) : key === 'models' ? invalidModels.length : 0
      const source = config?.source?.kind ?? (config?.locked ? 'env' : config ? 'file' : null)
      const sourceText = source ? t('cfg.' + source) : t('cfg.sourceLoading')
      const statusText = config?.locked ? t('cfg.readonly') : health.invalid.length && config?.mode !== 'off' ? t('nav.modelInvalid') : config ? t(config.mode === 'off' ? 'badge.off' : 'badge.on') : t('cfg.loading')
      const ready = Boolean(config), isDirty = dirty.current
      const saveText = config?.locked ? t('cfg.readonly') : !ready ? t('cfg.loading') : conflict ? t('cfg.conflict') : errorCount ? fill(t('cfg.invalid'), { count: errorCount })
        : save.status === 'saving' ? t('save.saving') : save.status === 'failed' ? t('save.failed') : save.status === 'saved' ? t('save.saved') : isDirty ? t('cfg.dirty') : t('cfg.clean')
      const savedDraft = draftOf(base.current), latestDraft = draftOf(conflict)
      const changedFields = conflict ? Object.keys(draft).filter(key => !sameValue(savedDraft[key], latestDraft[key]) || !sameValue(savedDraft[key], draft[key])) : []
      const displayValue = value => value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—')
      const cardProps = { t, config, draft, onDraft, errors, disabled }
      return h('div', { className: 'ddf-root ddf-settings', 'data-locked': config?.locked ? 'true' : 'false' }, h('style', null, CONFIG_STYLES),
        h('header', { className: 'ddf-head' }, h('div', { className: 'ddf-heading' }, h('h1', { className: 'ddf-title' }, t('title')), h('p', { className: 'ddf-sub' }, t('cfg.subtitle'))),
          h('div', { className: 'ddf-head-right' }, h('span', { className: 'ddf-badge', 'data-on': ready && config.mode !== 'off' && !config.locked ? 'true' : 'false', 'data-invalid': Boolean(health.invalid.length) && config?.mode !== 'off', role: 'status' }, h('span', { className: 'ddf-dot', 'aria-hidden': true }), statusText),
            h('span', { className: 'ddf-source', title: config?.file }, sourceText, config?.file ? ' · ' + config.file.split(/[\\/]/).at(-1) : ''))),
        h('div', { className: 'ddf-tabs', role: 'tablist', 'aria-label': t('config.title') }, ...CONFIG_TABS.map(key => h('button', {
          key, id: `ddf-tab-${key}`, type: 'button', className: 'ddf-tab', role: 'tab', 'data-on': tab === key, 'aria-selected': tab === key,
          'aria-controls': `ddf-panel-${key}`, tabIndex: tab === key ? 0 : -1, onClick: () => setTab(key),
          onKeyDown: event => { const index = CONFIG_TABS.indexOf(key), target = event.key === 'ArrowRight' ? (index + 1) % 4 : event.key === 'ArrowLeft' ? (index + 3) % 4 : event.key === 'Home' ? 0 : event.key === 'End' ? 3 : -1
            if (target < 0) return; event.preventDefault(); setTab(CONFIG_TABS[target]); event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[target]?.focus() },
        }, t('cfg.' + key), tabCount(key) ? h('span', { className: 'ddf-tab-count' }, String(tabCount(key))) : null))),
        h('div', { className: 'ddf-body' },
          h('div', { className: 'ddf-config-banners' },
          !ready ? h('section', { className: 'ddf-config-empty ddf-load-issue', role: 'status' }, h('h2', null, t(phase === 'error' ? 'cfg.loadTitle' : 'cfg.loading')),
            h('p', null, t(phase === 'error' ? 'cfg.loadHint' : 'view.hint')),
            phase === 'error' ? h('button', { type: 'button', className: 'ddf-btn ddf-btn-primary', onClick: onRefresh, disabled: refreshing }, t('cfg.retry')) : null,
            refreshError ? h('details', null, h('summary', null, t('cfg.loadDetails')), h('pre', null, refreshError)) : null) : null,
          ready && config.locked ? h('div', { className: 'ddf-banner', 'data-kind': 'warn', role: 'note' }, t('cfg.locked'), h('code', null, config.source?.environmentValue || '')) : null,
          ready && conflict ? h('div', { className: 'ddf-banner', 'data-kind': 'warn', role: 'alert' }, h('strong', null, t('cfg.conflict')), '：', t('cfg.conflictHint'),
            h('div', { className: 'ddf-actions' }, h('button', { type: 'button', className: 'ddf-btn', onClick: discard }, t('cfg.server')),
              h('button', { type: 'button', className: 'ddf-btn', onClick: keepEdits }, t('cfg.keep'))),
            h('details', null, h('summary', null, t('cfg.diff')), h('div', { className: 'ddf-table-scroll' }, h('table', { className: 'ddf-table' },
              h('thead', null, h('tr', null, ...['field', 'base', 'latest', 'mine'].map(key => h('th', { key }, t('cfg.' + key))))),
              h('tbody', null, ...changedFields.map(key => h('tr', { key }, h('td', null, key === 'mode' ? t('mode.label') : key === 'models' ? t('cfg.models') : configLabel(t, key)),
                ...[savedDraft[key], latestDraft[key], draft[key]].map((value, i) => h('td', { key: i }, displayValue(value)))))))))) : null,
          ready && config.modelRouting !== 'roles' ? h('div', { className: 'ddf-banner', 'data-kind': 'warn', role: 'status' }, t('cfg.oldModelRouting')) : null,
          ready && config.modelRouting === 'roles' && config.reviewerModelPolicy !== 'dispatcher-snapshot' ? h('div', { className: 'ddf-banner', 'data-kind': 'warn', role: 'status' }, t('cfg.oldReviewPolicy')) : null,
          ready && errorCount ? h('div', { className: 'ddf-banner', 'data-kind': 'error', role: 'alert' }, h('strong', null, fill(t('cfg.invalid'), { count: errorCount })),
            h('ul', null, ...Object.entries(errors).map(([key, text]) => h('li', { key }, h('button', { className: 'ddf-text-button', type: 'button', onClick: () => setTab(key === 'threshold' ? 'policy' : 'limits') }, text))))) : null,
          ready && config.mode !== 'off' && health.invalid.length ? h('div', { className: 'ddf-banner', 'data-kind': 'error', role: 'alert' }, h('strong', null, t('cfg.modelImpact')), '：', t('reminder.body').replace('{tiers}', health.invalid.map(tier => t('models.' + tier)).join('、')),
            h('div', { className: 'ddf-actions' }, h('button', { type: 'button', className: 'ddf-btn', onClick: () => setTab('models') }, t('cfg.chooseModel')))) : null,
          ready && invalidModels.length && !health.invalid.length ? h('div', { className: 'ddf-banner', 'data-kind': 'error', role: 'alert' }, t('cfg.modelDraft')) : null,
          ready && save.status === 'failed' && !conflict ? h('div', { className: 'ddf-banner', 'data-kind': 'error', role: 'alert' }, h('strong', null, t('save.failed')), '：', save.error) : null,
          ready && save.status === 'saved' ? h('div', { className: 'ddf-banner', 'data-kind': 'success', role: 'status' }, t('cfg.saveHint')) : null,
          ready && isDirty && !conflict && !errorCount && save.status !== 'failed' ? h('div', { className: 'ddf-banner', 'data-kind': 'info', role: 'status' }, t('cfg.dirtyHint')) : null,
          ready && refreshError ? h('div', { className: 'ddf-banner', 'data-kind': 'warn', role: 'status' }, t('cfg.stale'), h('details', null, h('summary', null, t('cfg.loadDetails')), h('pre', null, refreshError))) : null,
          ),
          ...CONFIG_TABS.map(key => h('div', { key, id: `ddf-panel-${key}`, role: 'tabpanel', 'aria-labelledby': `ddf-tab-${key}`, hidden: !ready || tab !== key },
            key === 'policy' ? h(ConfigCard, cardProps) : key === 'limits' ? h(LimitConfig, cardProps) : key === 'models'
              ? h(ExecutionConfig, { ...cardProps, catalogState, onRefreshModels }) : h(ConfigDiagnostics, { t, config })))),
        h('div', { className: 'ddf-savebar' }, h('div', { className: 'ddf-save-status', 'data-tone': save.status === 'failed' || errorCount ? 'failed' : save.status === 'saved' ? 'saved' : isDirty ? 'dirty' : '', role: 'status' }, h('span', { className: 'ddf-dot dot', 'aria-hidden': true }), saveText),
          h('span', { className: 'sep', style: { color: 'var(--border-l2)' } }, '·'),
          h('span', { className: 'ddf-effect-note' }, isDirty ? t('cfg.saveEffect') : t('cfg.poll')),
          h('div', { className: 'ddf-save-actions' }, h('button', { type: 'button', className: 'ddf-btn', disabled: disabled || !isDirty, onClick: discard }, t('cfg.discard')),
            h('button', { type: 'button', className: 'ddf-btn ddf-btn-primary', disabled: disabled || Boolean(conflict) || errorCount > 0 || (draft.mode !== 'off' && invalidModels.length > 0), onClick: onSave }, config?.locked ? t('cfg.saveUnavailable') : save.status === 'saving' ? t('save.saving') : t('save.idle')))),
        h('footer', { className: 'ddf-foot' }, h('span', null, refreshedAt ? fill(t('footer.refreshed'), { time: clockTime(refreshedAt) }) : t('footer.never')),
          h('button', { type: 'button', className: 'ddf-text-button link', disabled: refreshing || saving.current, onClick: onRefresh }, t('footer.refresh')),
          config?.file ? h('span', { className: 'ddf-file', title: config.file }, t('file.label') + '：' + config.file) : null))
    }

    // -----------------------------------------------------------------------
    // Module
    // -----------------------------------------------------------------------

    return {
      inject: ['slots', 'locale', 'modelDirectories', 'layout'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-delegation-first: dictionaries')
        const t = ctx.locale.bind(NS)
        const progress = createChatProgress()
        ctx.effect(() => () => progress.dispose(), 'dsh-delegation-first: chat progress')
        const modelHealth = createModelHealth(ctx.modelDirectories.catalog)
        let focusTier
        const openModelConfig = tier => {
          focusTier = tier || modelHealth.getSnapshot().invalid[0]
          ctx.layout.selectPanel(PANEL_ID)
          modelHealth.dismiss()
        }
        ctx.effect(() => modelHealth.start(), 'dsh-delegation-first: model reminders')
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: `${PANEL_ID}-model-reminder`, locale: NS,
        }, () => h(ModelReminder, { t, modelHealth, onFix: () => openModelConfig() })))

        // The sidebar owns the row; the matching `main` key is the page it
        // selects. Both registrations wait for their slot to be declared, so a
        // host without global panels simply shows nothing.
        ctx.slots.inject('sidebar.panellist', () => {
          let dispose, previous
          const sync = () => {
            const invalid = modelHealth.getSnapshot().invalid.length > 0
            if (invalid === previous) return
            previous = invalid; dispose?.()
            dispose = ctx.slots.register({
              name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER,
              label: () => invalid ? `${t('nav')} · ${t('nav.modelInvalid')}` : t('nav'),
              locale: NS, inject: () => ({ t }),
            }, props => h('span', { title: invalid ? t('nav.modelInvalid') : t('nav'),
              style: { position: 'relative', display: 'inline-flex' } },
            h(DelegationIcon, props), invalid ? h('span', { style: {
              position: 'absolute', right: -4, top: -5, borderRadius: '50%', width: 12, height: 12,
              background: 'var(--dsw-alias-state-danger-primary,#d14343)', color: 'var(--dsw-alias-bg-layer-1,#fff)',
              fontSize: 10, fontWeight: 700, lineHeight: '12px', textAlign: 'center',
            } }, '!') : null))
          }
          sync()
          const off = modelHealth.subscribe(sync)
          return () => { off(); dispose?.() }
        })

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ t }),
        }, (slotProps) => h(DelegationPanel, { t: slotProps?.t ?? t, catalog: ctx.modelDirectories.catalog, modelHealth, focusTier })))

        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view', id: VIEW_ID, order: 35, locale: NS,
          label: () => t('view.tab'), inject: () => ({ t }),
        }, slotProps => h(TaskView, {
          key: slotProps?.sessionId || '', t: slotProps?.t ?? t, sessionId: slotProps?.sessionId,
          openView: slotProps?.openView,
          onFix: openModelConfig,
          getViews: () => ctx.slots.entries?.('conversation.view').map(entry => ({ id: entry.options.id })) ?? [],
        })))

        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock', id: `${PANEL_ID}-live`, order: 10, locale: NS,
          inject: sessionId => ({ t, sessionId }),
        }, ownerProps => h(ChatProgressDock, {
          t: ownerProps?.t ?? t, sessionId: ownerProps?.sessionId, session: ownerProps?.session, progress,
        })))

        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail', id: `${PANEL_ID}-issues`, order: 25, locale: NS,
          inject: () => ({ t }),
        }, ownerProps => h(ChatIssueNotice, {
          t: ownerProps?.t ?? t, sessionId: ownerProps?.sessionId, seq: ownerProps?.seq,
          useChat: ownerProps?.useChat, openView: ownerProps?.openView, openFile: ownerProps?.openFile, progress,
        })))

        // Put a compact, latest-reply-only progress summary beside the normal
        // assistant actions. The full acceptance panel remains the durable view;
        // this card only answers "did it delegate, and what is happening now?".
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions', id: `${PANEL_ID}-progress`, order: 25, locale: NS,
          inject: () => ({ t }),
        }, ownerProps => h(ChatProgressAction, {
          t: ownerProps?.t ?? t,
          sessionId: ownerProps?.sessionId,
          messageId: ownerProps?.messageId,
          useChat: ownerProps?.useChat,
          openView: ownerProps?.openView,
          progress,
        })))
      },
    }
  },
})
