import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

test('the input dock shows worker activity before a turn tail or assistant actions exist and updates without a reply', async () => {
  const now = Date.now(), request = { messageId: 'live-request', text: '调整工作台参数' }
  const task = { id: 'parameters', title: '实现双接口与参数自动生成', status: 'running',
    progress: { tool: 'read', at: now - 2000 }, supervision: { startedAt: now - 180000, lastActivityAt: now - 1000,
      activity: { kind: 'tool', tool: 'edit', at: now - 1000 } } }
  const body = { ok: true, sessionId: 'session-current', sessions: [{ sessionId: 'session-current', source: request }],
    plans: [{ sessionId: 'session-current', protocolVersion: 2, source: request, status: 'running', tasks: [task] }] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  // A running host turn has no turn-tail node. Only the persistent input dock is mounted.
  const tail = f.mountDock('session-current')
  try {
    await tail.flush()
    assert.match(tail.text(), /实现双接口与参数自动生成/)
    assert.match(tail.text(), /当前.*修改文件/)
    assert.match(tail.text(), /最近.*读取文件/)
    assert.match(tail.text(), /已执行 3 分钟/)
    assert.ok(!tail.nodes('section').some(node => node.props?.role === 'alert'))
    task.supervision.activity = { kind: 'model', at: now }
    task.progress = { tool: 'edit', at: now }
    await tail.tick()
    assert.match(tail.text(), /模型正在生成/)
    assert.match(tail.text(), /最近.*修改文件/)
    assert.doesNotMatch(tail.text(), /当前.*工具正在执行/)
    task.progress.failed = true
    await tail.tick()
    assert.match(tail.text(), /最近.*修改文件.*该步骤失败/)
    task.status = 'review'; body.plans[0].status = 'review'
    task.execution = { status: 'DONE', summary: '实现已返回，等待实际验证' }
    await tail.tick()
    assert.match(tail.text(), /等待主控.*验证/)
    assert.doesNotMatch(tail.text(), /当前.*模型正在生成/)
    body.plans[0].completion = { id: 'done', outcome: 'completed', accepted: 1, total: 1, deliverables: [], evidence: [], remaining: [] }
    await tail.tick()
    assert.equal(tail.text(), '', 'the dock must not duplicate the final receipt')
  } finally { tail.close(); f.close() }
})

test('a new request in the same session never inherits the previous task or its receipt in current surfaces', async () => {
  const previous = { sessionId: 'session-current', protocolVersion: 2, status: 'accepted', goal: '交付可视化工作台',
    source: { messageId: 'request-old', text: '开发调试页面' },
    completion: { id: 'old-receipt', outcome: 'completed', accepted: 1, total: 1, deliverables: [], evidence: [], remaining: [] },
    tasks: [{ id: 'old-ui', title: '开发工作台', status: 'accepted', complexity: 'routine', checks: [], criteria: [] }] }
  const body = { ok: true, sessionId: 'session-current', plans: [previous], requestUsage: [{ sessionId: 'session-current', requestId: 'request-old', complete: true,
    roles: [{ role: 'worker', model: 'previous-request-model', attempt: 1, requests: 1, responses: 1, outputTokens: 999 }] }], sessions: [{ sessionId: 'session-current',
    source: { messageId: 'request-new', text: '检查密码服务代码实际调用的接口' }, route: { route: 'direct', reasons: [] } }] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const view = f.mountView('session-current'), action = f.mountAction('session-current'), notice = f.mountNotice('session-current')
  try {
    await view.flush(); await action.flush(); await notice.flush()
    const hero = view.nodes('section').find(node => node.props?.className === 'ddf-board-hero')
    assert.match(JSON.stringify(hero), /检查密码服务代码实际调用的接口/)
    assert.doesNotMatch(JSON.stringify(hero), /交付可视化工作台|已验收/)
    assert.match(view.text(), /其他需求的托管记录/)
    assert.match(view.text(), /交付可视化工作台/)
    assert.equal(view.nodes('section').filter(node => node.props?.['data-task-list'] === '').length, 0)
    assert.match(action.text(), /未启动子代理/)
    assert.doesNotMatch(action.text(), /已验收|已完成/)
    assert.equal(notice.text(), '')
    assert.doesNotMatch(view.text(), /previous-request-model/)
    body.plans = [{ sessionId: 'session-current', status: 'running', goal: '核查密码接口', source: body.sessions[0].source,
      tasks: [{ id: 'new-api', title: '核查实际调用', status: 'running', complexity: 'routine' }] }]
    await action.tick(); await view.tick(); await notice.tick()
    assert.match(action.text(), /进行中 1/)
    assert.match(view.text(), /核查实际调用/)
    assert.doesNotMatch(view.text(), /交付可视化工作台/)
  } finally { view.close(); action.close(); notice.close(); f.close() }
})

test('the confirmed plan takes precedence over an initial zero-score direct suggestion and tracks supplements', async () => {
  const body = { ok: true, sessionId: 'session-current', plans: [{ sessionId: 'session-current', status: 'running', goal: '开发可视化调试页面',
    routing: { route: 'direct', reasons: ['scope_small'] }, inputs: [
      { id: 'input-one', text: '交付人员需要操作引导', status: 'received' },
      { id: 'input-two', text: '默认配置便于使用', status: 'forwarded', taskId: 'ui', resolution: '已同步执行者', additionalCriteria: ['提供默认配置'] },
    ], tasks: [{ id: 'ui', title: '开发页面', status: 'running', complexity: 'complex', complexityReason: '重构页面并适配接口，需编译验证', dependsOn: [] }] }],
    sessions: [{ sessionId: 'session-current', difficulty: { score: 0, level: 'simple', signals: [] }, route: { route: 'direct', reasons: ['scope_small'] } }] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const view = f.mountView('session-current'), action = f.mountAction('session-current')
  try {
    await view.flush(); await action.flush()
    const main = view.nodes('div').find(node => node.props?.className === 'ddf-board-decision-main')
    assert.match(JSON.stringify(main), /主控已确认.*复杂.*重构页面/)
    assert.match(JSON.stringify(main), /已安排子代理.*独立审查/)
    assert.doesNotMatch(JSON.stringify(main), /评分|直接执行|系统建议/)
    assert.match(view.text(), /规则判断与建议.*评分 0.*直接执行/)
    assert.match(view.text(), /补充信息.*待主控处理 1 条.*交付人员需要操作引导/)
    assert.match(view.text(), /已同步至任务.*ui.*提供默认配置/)
    assert.match(action.text(), /待处理补充 1 条/)
  } finally { view.close(); action.close(); f.close() }
})

test('routing advice alone never claims delegation or completion', async () => {
  for (const route of ['direct', 'delegate_parallel']) {
    const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true,
      json: async () => ({ ok: true, sessionId: 'session-current', plans: [],
        sessions: [{ sessionId: 'session-current', route: { route, reasons: [] } }] }) }) })
    const action = f.mountAction('session-current')
    try {
      await action.flush()
      assert.match(action.text(), /未启动子代理/)
      assert.ok(!action.nodes('span').some(node => node.props?.['data-status'] === 'completed'))
    } finally { action.close(); f.close() }
  }
})

test('a coordinator quota problem shows the service recovery action without mislabeling returned work as failed', async () => {
  const plan = { sessionId: 'session-current', status: 'blocked', goal: '核对已有交付物', coordinatorIssue: {
    code: 'MODEL_SERVICE_QUOTA', model: 'main-model', message: '主控模型服务额度不足，已有报告保留', details: '429: exceed quota limit',
    action: '恢复服务商额度或手动调整主控模型后明确继续验证验收，不要重开执行者',
  }, tasks: [{ id: 'a', title: '原执行任务', status: 'review', complexity: 'routine', attempts: 5, report: '原执行报告', checks: [] }],
    completion: { id: 'receipt', outcome: 'blocked', accepted: 0, total: 1, deliverables: [], evidence: [], remaining: [{ taskId: 'a', title: '原执行任务', status: 'review', reason: '尚未验收' }] } }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true, sessionId: 'session-current', plans: [structuredClone(plan)], sessions: [], limits: { maxAttempts: 5 } }) }) })
  const view = f.mountView('session-current'), notice = f.mountDock('session-current')
  try {
    await view.flush(); await notice.flush()
    for (const text of [view.text(), notice.text()]) {
      assert.match(text, /主控模型服务额度不足/)
      assert.match(text, /恢复服务商额度.*明确继续验证验收/)
      assert.doesNotMatch(text, /提高 maxAttempts|提高每任务执行/)
    }
    plan.completion = null
    await notice.tick()
    assert.match(notice.text(), /主控模型服务额度不足.*429/s)
  } finally { view.close(); notice.close(); f.close() }
})

test('acceptance shows runtime policy and separate request usage even without a delegated plan', async () => {
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true,
    json: async () => ({ ok: true, sessionId: 'session-current', plans: [], sessions: [], runtimePolicyVersion: 2,
      requestUsage: [{ sessionId: 'session-current', requestId: 'r1', complete: true, roles: [
        { role: 'coordinator', model: 'main-model', attempt: 0, requests: 1, responses: 1, inputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: null, outputTokens: 10 },
      ] }] }) }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    assert.match(view.text(), /持续执行策略已生效/)
    assert.match(view.text(), /本次需求用量/)
    assert.match(view.text(), /main-model/)
    assert.match(view.text(), /缓存读取.*200/)
    assert.match(view.text(), /输入.*100/)
  } finally { view.close(); f.close() }
})

test('an activity inquiry is shown as a reminder rather than mandatory correction or a blocked task', async () => {
  const body = { ok: true, sessionId: 'session-current', plans: [{ sessionId: 'session-current', status: 'running', goal: '核查执行活动',
    tasks: [{ id: 'a', title: '等待命令返回', status: 'running', dependsOn: [], outputs: [], writes: [], criteria: [], checks: [],
      supervision: { used: 0, limit: 2, startedAt: Date.now(), pending: { advisory: true, reason: '请核对命令是否仍在执行。' } } }] }], sessions: [] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => body }) })
  const action = f.mountAction('session-current'), notice = f.mountDock('session-current'), view = f.mountView('session-current')
  try {
    await action.flush(); await notice.flush(); await view.flush()
    assert.match(action.text(), /需核对活动/)
    assert.match(notice.text(), /活动核对提醒/)
    assert.doesNotMatch(notice.text(), /等待主控纠偏|已阻塞/)
    assert.match(view.text(), /活动核对提醒/)
  } finally { action.close(); notice.close(); view.close(); f.close() }
})

test('acceptance uses the native full-height conversation surface and hides only its ordinary composer', async () => {
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true,
    json: async () => ({ ok: true, sessionId: 'session-current', plans: [], sessions: [] }) }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    const root = view.nodes('div').find(node => node.props?.className === 'ddf-board-root')
    assert.equal(root.props['data-conversation-composer-overlay'], '')
    assert.equal(root.props['data-ddf-acceptance'], '')
    const styles = view.nodes('style').map(node => node.children.join('')).join('\n')
    assert.match(styles, /\[data-conversation-scroll\]:has\(> \[data-slot="conversation\.session"\] \[data-ddf-acceptance\]\)/)
    assert.match(styles, /> \[data-composer-seat\]:not\(:has\(\[data-approval-key\],\[data-question-key\],\[data-plan-review-key\]\)\)/)
    assert.match(styles, /padding-bottom:calc\(40px \+ var\(--dsh-composer-height,200px\)\)/)
    assert.equal(view.nodes('textarea').length, 0)
  } finally { view.close(); f.close() }
})

test('the conversation surface contract also covers loading and failed reads before settings mount', async () => {
  const f = await sidebarFixture(undefined, { fetchState: async () => { throw new Error('HTTP 503') } })
  const view = f.mountView('session-current')
  try {
    const marker = () => view.nodes('div').find(node => node.props?.['data-ddf-acceptance'] === '')
    assert.ok(marker(), 'the loading view must already own the full-height surface')
    await view.flush()
    assert.ok(marker())
    assert.match(view.text(), /暂时无法显示任务状态/)
    assert.ok(view.button('重新读取'))
  } finally { view.close(); f.close() }
})

test('Agentrix branding is consistent in plugin metadata, navigation and configuration', async () => {
  for (const language of ['zh', 'en']) {
    const metadata = JSON.parse(await readFile(new URL(`../locale/${language}.json`, import.meta.url), 'utf8'))
    assert.equal(metadata.meta.title, 'DSH Agentrix')
  }
  for (const language of ['zh', 'en']) {
    const f = await sidebarFixture({ status: 'ready', value: { groups: [{ id: 'demo', name: 'Demo',
      models: [{ id: 'worker', name: 'Worker' }] }], failures: [] } }, { language })
    await f.setConfig({ ...designConfig(), models: { worker: { provider: 'demo', model: 'worker' }, reviewer: null } })
    const panel = f.mountPanel()
    try {
      await panel.flush()
      assert.equal(f.label(), 'DSH Agentrix')
      assert.match(panel.text(), /DSH Agentrix/)
      assert.doesNotMatch(panel.text(), /委派优先|Delegation [Ff]irst/)
    } finally { panel.close(); f.close() }
  }
})

test('model configuration only selects execution and shows automatic review without honoring obsolete choices', async () => {
  const f = await sidebarFixture({ status: 'ready', value: { groups: [{ id: 'demo', name: 'Demo', models: [
    { id: 'low', name: '低模型' }, { id: 'other-low', name: '另一执行模型' },
  ] }], failures: [] } })
  await f.setConfig({ ...designConfig(), modelRouting: 'roles', models: {
    worker: { provider: 'demo', model: 'low' }, reviewer: { provider: 'retired', model: 'obsolete-reviewer' },
  } })
  const panel = f.mountPanel()
  try {
    await panel.flush(); panel.button('子任务模型').props.onClick(); await panel.flush()
    assert.equal(panel.nodes('button').filter(node => node.props.role === 'tab').length, 4)
    const worker = panel.nodes('select').find(node => node.props.id === 'ddf-model-worker')
    const reviewer = panel.nodes('select').find(node => node.props.id === 'ddf-model-reviewer')
    assert.ok(worker); assert.equal(reviewer, undefined)
    assert.equal(worker.props.value, JSON.stringify(['demo', 'low']))
    assert.equal(panel.nodes('select').find(node => node.props.id === 'ddf-effort-reviewer'), undefined)
    assert.match(panel.text(), /主控.*对话框/)
    assert.match(panel.text(), /执行模型/); assert.match(panel.text(), /审查.*分发时.*主控模型/)
    assert.doesNotMatch(panel.text(), /obsolete-reviewer|审查模型不可用/)
    worker.props.onChange({ target: { value: JSON.stringify(['demo', 'other-low']) } }); await panel.flush()
    panel.button('保存').props.onClick(); await panel.flush()
    assert.deepEqual(f.posted().at(-1).models, { worker: { provider: 'demo', model: 'other-low' }, reviewer: null })
  } finally { panel.close(); f.close() }
})

test('a client with automatic review cannot save against a host that still honors separate review configuration', async () => {
  const f = await sidebarFixture()
  const config = designConfig(); delete config.reviewerModelPolicy
  await f.setConfig(config)
  const panel = f.mountPanel()
  try {
    await panel.flush()
    assert.match(panel.text(), /尚未载入自动审查选模/)
    assert.equal(panel.button('保存').props.disabled, true)
  } finally { panel.close(); f.close() }
})

test('task details display execution and review models separately from task complexity', async () => {
  const task = { id: 'a', title: '复杂接口实现', status: 'review', complexity: 'complex', criteria: [], checks: [],
    dispatcherModel: { provider: 'demo', model: 'high-reviewer', reasoningEffort: 'high', source: 'dispatch', attempt: 1 },
    modelRoute: { role: 'worker', source: 'configured', requested: { provider: 'demo', model: 'low-worker' }, actual: { provider: 'demo', model: 'low-worker' } },
    audit: { status: 'completed', specVerdict: 'pass', qualityVerdict: 'pass', modelRoute: { role: 'reviewer', requested: { provider: 'demo', model: 'high-reviewer' }, actual: { provider: 'demo', model: 'high-reviewer' } } } }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true, sessions: [],
    plans: [{ sessionId: 'session-current', goal: '按角色执行', status: 'review', tasks: [task] }] }) }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    assert.match(view.text(), /执行模型\s+low-worker/)
    assert.ok(view.nodes('strong').some(node => node.props?.title === 'demo / low-worker'))
    assert.match(view.text(), /审查模型：demo \/ high-reviewer/)
    assert.match(view.text(), /审查沿用主控模型：demo \/ high-reviewer.*high/)
    assert.match(view.text(), /任务复杂度\s+复杂/)
  } finally { view.close(); f.close() }
})

test('an older model-routing backend cannot overwrite role settings from the new panel', async () => {
  const f = await sidebarFixture()
  const old = designConfig(); delete old.modelRouting
  await f.setConfig(old)
  const panel = f.mountPanel()
  try {
    await panel.flush()
    assert.match(panel.text(), /尚未载入按角色分配模型/)
    assert.equal(panel.button('保存').props.disabled, true)
  } finally { panel.close(); f.close() }
})

test('a model conflict keeps the edited worker while ignoring obsolete reviewer changes', async () => {
  const f = await sidebarFixture({ status: 'ready', value: { groups: [{ id: 'demo', name: 'Demo', models:
    ['worker-a', 'worker-b', 'review-a', 'review-b'].map(id => ({ id, name: id })) }], failures: [] } })
  const initial = { ...designConfig(), models: { worker: { provider: 'demo', model: 'worker-a' }, reviewer: { provider: 'demo', model: 'review-a' } } }
  await f.setConfig(initial)
  const panel = f.mountPanel()
  try {
    await panel.flush(); panel.button('子任务模型').props.onClick(); await panel.flush()
    panel.nodes('select').find(node => node.props.id === 'ddf-model-worker').props.onChange({ target: { value: JSON.stringify(['demo', 'worker-b']) } })
    await panel.flush()
    await f.setConfig({ ...initial, revision: 'revision-b', models: { ...initial.models, reviewer: { provider: 'demo', model: 'review-b' } } })
    await panel.flush(); panel.button('保留我的修改').props.onClick(); await panel.flush()
    await panel.button('保存').props.onClick(); await panel.flush()
    assert.deepEqual(f.posted().at(-1).models, { worker: { provider: 'demo', model: 'worker-b' }, reviewer: null })
  } finally { panel.close(); f.close() }
})

test('chat and acceptance read the same program receipt and never label cancellation as failure', async () => {
  const plan = { protocolVersion: 2, sessionId: 'session-current', goal: '修复响应式布局', status: 'cancelled',
    tasks: [{ id: 'a', title: '响应式布局', status: 'cancelled', stop: { reason: '用户取消剩余工作' }, criteria: [], checks: [], outputs: [] }],
    completion: { id: 'receipt-cancelled-1', outcome: 'cancelled', accepted: 0, total: 1, evidence: [], deliverables: [],
      remaining: [{ taskId: 'a', title: '响应式布局', status: 'cancelled', reason: '用户取消剩余工作' }] } }
  const body = { ok: true, sessionId: 'session-current', plans: [plan], sessions: [] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const notice = f.mountNotice('session-current')
  try {
    await notice.flush()
    assert.match(notice.text(), /交付回执.*已停止，未验收/)
    assert.match(notice.text(), /用户取消剩余工作/)
    assert.doesNotMatch(notice.text(), /核对失败原因|决定重试或停止/)
  } finally { notice.close() }
  const view = f.mountView('session-current')
  try {
    await view.flush()
    assert.match(view.text(), /receipt-cancelled-1/)
    assert.match(view.text(), /已停止，未验收/)
    plan.status = 'accepted'; plan.tasks[0].status = 'accepted'
    plan.completion = { id: 'receipt-completed-2', outcome: 'completed', accepted: 1, total: 1,
      evidence: ['actual-check'], deliverables: [{ taskId: 'a', title: '响应式布局', paths: ['client.js'] }], remaining: [] }
    await view.tick()
    assert.match(view.text(), /交付回执.*已完成/)
    assert.match(view.text(), /client.js/)
    assert.match(view.text(), /actual-check/)
  } finally { view.close(); f.close() }
})

test('a terminal timeout receipt explains why the flow cannot continue and does not say it is still waiting', async () => {
  const plan = { protocolVersion: 2, sessionId: 'session-current', goal: '修复 DSH 插件注册', status: 'blocked',
    tasks: [{ id: 'a', title: '修复 DSH 插件注册', status: 'failed', attempts: 1, error: '子任务超过 60 分钟，已请求停止', criteria: [], checks: [], outputs: [] }],
    completion: { id: 'receipt-blocked-1', outcome: 'blocked', accepted: 0, total: 1, evidence: [], deliverables: [],
      remaining: [{ taskId: 'a', title: '修复 DSH 插件注册', status: 'failed', reason: '子任务超过 60 分钟，已请求停止' }] } }
  const body = { ok: true, sessionId: 'session-current', limits: { maxAttempts: 1 }, plans: [plan], sessions: [] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const notice = f.mountNotice('session-current'), action = f.mountAction('session-current'), view = f.mountView('session-current')
  try {
    await notice.flush(); await action.flush(); await view.flush()
    assert.match(notice.text(), /达到每任务执行次数上限/)
    assert.doesNotMatch(notice.text(), /等待 Agent|提交正式报告/)
    assert.match(action.text(), /已阻塞/)
    assert.doesNotMatch(action.text(), /等待 Agent|提交正式报告/)
    assert.match(view.text(), /达到每任务执行次数上限/)
    assert.match(view.text(), /新建计划/)
  } finally { notice.close(); action.close(); view.close(); f.close() }
})

test('new plans without a final receipt show accepted counts rather than a completed delivery claim', async () => {
  const body = { ok: true, sessionId: 'session-current', plans: [{ protocolVersion: 2, sessionId: 'session-current', status: 'accepted', completion: null,
    tasks: [{ id: 'a', status: 'accepted' }] }], sessions: [] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => body }) })
  const action = f.mountAction('session-current')
  try { await action.flush(); assert.doesNotMatch(action.text(), /已完成/); assert.match(action.text(), /已验收 1\/1/) }
  finally { action.close(); f.close() }
})

test('legacy cancellation is displayed as stopped and unaccepted without inventing a receipt', async () => {
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
    plans: [{ sessionId: 'session-current', status: 'blocked', tasks: [{ id: 'a', title: '响应式布局', status: 'cancelled', error: null }] }], sessions: [] }) }) })
  const action = f.mountAction('session-current'), notice = f.mountDock('session-current')
  try {
    await action.flush(); await notice.flush()
    assert.match(action.text(), /已停止/)
    assert.doesNotMatch(action.text(), /已阻塞/)
    assert.match(notice.text(), /已停止，未验收/)
    assert.doesNotMatch(notice.text(), /交付回执|决定重试或停止/)
  } finally { action.close(); notice.close(); f.close() }
})

test('review progress distinguishes active audits, verdicts, concrete findings and next actions', async () => {
  const task = { id: 'a', title: '接口修复', status: 'review', complexity: 'complex', attempts: 1,
    execution: { status: 'DONE', summary: '已提交交付物', reportPath: 'reports/a-1.md' },
    audit: { status: 'running', modelRoute: { requested: { provider: 'test', model: 'Gemini' } } },
    issues: [], criteria: ['字段正确'], checks: [], dependsOn: [], outputs: [], writes: [] }
  const body = { ok: true, sessionId: 'session-current', plans: [{ sessionId: 'session-current', goal: '修复接口', status: 'running', tasks: [task], autoDispatch: true }], sessions: [] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const action = f.mountAction('session-current')
  try {
    await action.flush()
    assert.match(action.text(), /审查中 1/)
    assert.doesNotMatch(action.text(), /待验收 1/)
  } finally { action.close() }
  const view = f.mountView('session-current')
  try {
    await view.flush()
    assert.match(view.text(), /独立审查.*进行中/)
    assert.match(view.text(), /Gemini/)
    body.plans[0].status = 'review'
    task.audit = { ...task.audit, status: 'completed', specVerdict: 'fail', qualityVerdict: 'pass' }
    task.issues = [{ id: 'a-1-1', criterion: 0, severity: 'important', finding: '返回缺少字段', evidence: ['result.txt:2'], status: 'open' }]
    await view.tick()
    assert.match(view.text(), /需求.*未通过/)
    assert.match(view.text(), /质量.*通过/)
    assert.match(view.text(), /a-1-1.*返回缺少字段/)
    assert.match(view.text(), /按具体问题返工/)
    task.audit = { status: 'failed', error: '服务不可用' }
    await view.tick()
    assert.match(view.text(), /服务不可用/)
    assert.match(view.text(), /处理原因后.*重试审查/)
  } finally { view.close(); f.close() }
})

test('task models show their tier, reason, expected route and verified request without claiming inheritance', async () => {
  const task = { id: 'a', title: '目录梳理', status: 'running', complexity: 'routine', complexityReason: '只检查目录结构',
    model: { provider: 'magpie', model: 'auto/hy4free' },
    modelRoute: { source: 'configured', requested: { provider: 'magpie', model: 'auto/hy4free' },
      resolved: { provider: 'magpie', model: 'auto/hy4free' }, actual: { provider: 'magpie', model: 'auto/hy4free' } },
    criteria: [], checks: [], dependsOn: [], outputs: [], writes: [] }
  const body = { ok: true, sessionId: 'session-current', plans: [{ sessionId: 'session-current', goal: '项目评审', status: 'running', tasks: [task], autoDispatch: true }], sessions: [] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    assert.match(view.text(), /普通执行.*→.*auto\/hy4free/)
    assert.match(view.text(), /只检查目录结构/)
    assert.match(view.text(), /已核对/)
    body.plans[0].tasks = [{ ...task, status: 'blocked', issue: { code: 'MODEL_ROUTE_MISMATCH' }, error: '预期 Hy4，收到主对话模型；发送前已阻止',
      modelRoute: { ...task.modelRoute, actual: null, rejected: { provider: 'magpie', model: 'parent' } } }]
    await view.tick()
    assert.match(view.text(), /错配请求已阻止/)
    assert.match(view.text(), /预期 Hy4，收到主对话模型/)
    body.plans[0].tasks = [{ ...task, modelRoute: null, model: null }]
    await view.tick()
    assert.match(view.text(), /未记录/)
    assert.doesNotMatch(view.text(), /继承主 Agent/)
  } finally { view.close(); f.close() }
})

test('chat progress describes waiting and review tasks even when this turn dispatched none', async () => {
  const body = { ok: true, sessionId: 'session-current', plans: [{ sessionId: 'session-current', status: 'running', tasks: [
    { id: 'a', status: 'running' }, { id: 'b', status: 'queued' }, { id: 'c', status: 'review' }, { id: 'd', status: 'failed' },
  ] }], sessions: [{ sessionId: 'session-current', delegated: 0, denied: 4, turnStats: { direct: 0, delegated: 0, denied: 0 } }] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const action = f.mountAction('session-current')
  try {
    await action.flush()
    assert.match(action.text(), /进行中 1/)
    assert.match(action.text(), /等待 1/)
    assert.match(action.text(), /待验收 1/)
    assert.match(action.text(), /失败 1/)
    assert.doesNotMatch(action.text(), /被拒|派单 0/)
  } finally { action.close(); f.close() }
})
async function sidebarFixture(initialCatalog = { status: 'ready', value: { groups: [], failures: [] } }, options = {}) {
  const entries = new Map(), cleanups = [], timers = new Map(), subscribers = new Set(), timeouts = new Map(), posted = []
  let config = { ok: true, mode: 'auto', models: { routine: { provider: 'retired', model: 'worker' }, complex: null } }
  let catalogState = initialCatalog, dictionaries, sequence = 0, selectedPanel, hookRunner
  const catalog = {
    store: { getSnapshot: () => catalogState, subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn) } },
    async load() {}, async refresh() {},
  }
  const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children }, children }),
    useSyncExternalStore: (_subscribe, get) => get(), useCallback: (fn, dependencies) => hookRunner?.callback ? hookRunner.callback(fn, dependencies) : fn,
    useEffect: (...args) => hookRunner?.effect(...args), useMemo: fn => fn(),
    useRef: value => hookRunner ? hookRunner.ref(value) : ({ current: value }),
    useState: initial => hookRunner ? hookRunner.state(initial) : [typeof initial === 'function' ? initial() : initial, () => {}] }
  const ctx = {
    modelDirectories: { catalog },
    layout: { selectPanel(id) { selectedPanel = id } },
    effect(fn) { cleanups.push(fn()) },
    locale: { register(_ns, value) { dictionaries = value }, bind: () => key => dictionaries[options.language ?? 'zh'][key] ?? key },
    slots: {
      inject(_name, fn) { cleanups.push(fn()) },
      entries: () => ['fleet', 'share', 'chat'].map(id => ({ options: { id } })),
      register(options, render) {
        const entry = { options, render }; entries.set(options.name, entry)
        return () => { if (entries.get(options.name) === entry) entries.delete(options.name) }
      },
    },
  }
  const window = {
    __ModuleLoader__: { load: ({ factory }) => factory(() => React).apply(ctx) },
    setInterval(fn) { const id = ++sequence; timers.set(id, fn); return id },
    clearInterval(id) { timers.delete(id) },
    setTimeout(fn) { const id = ++sequence; timeouts.set(id, fn); return id },
    clearTimeout(id) { timeouts.delete(id) },
  }
  vm.runInNewContext(source, { window, AbortSignal, AbortController,
    fetch: async (url, request) => {
      if (url.includes('/api/state') && options.fetchState) return options.fetchState(url, request?.signal)
      if (request?.method === 'POST') posted.push(JSON.parse(request.body))
      const custom = await options.fetchConfig?.(request, config)
      if (custom) return custom
      if (request?.method === 'POST') config = { ...config, ...JSON.parse(request.body) }
      return { ok: true, json: async () => structuredClone(config) }
    } })
  const flush = () => new Promise(resolve => setImmediate(resolve))
  await flush()
  const elements = node => {
    if (!node || typeof node !== 'object') return []
    if (typeof node.type === 'function') return elements(node.type(node.props))
    return [node, ...node.children.flat(Infinity).flatMap(elements)]
  }
  const textOf = node => !node ? '' : typeof node !== 'object' ? String(node)
    : node.type === 'style' ? '' : node.children.flat(Infinity).map(textOf).join(' ')
  const reminder = () => elements(entries.get('shell.overlay')?.render())
  return {
    label: () => entries.get('sidebar.panellist').options.label(),
    async setConfig(value) { config = value; for (const fn of timers.values()) fn(); await flush() },
    setCatalog(value) { catalogState = value; for (const fn of subscribers) fn() },
    reminderText: () => reminder().filter(node => node.props?.role === 'alert').map(textOf).join(' '),
    clickReminder(label) { const button = reminder().find(node => node.type === 'button' && textOf(node) === label); assert.ok(button, label); button.props.onClick() },
    selectedPanel: () => selectedPanel,
    view: (sessionId, openView) => entries.get('conversation.view')?.render({ sessionId, openView }),
    action: (sessionId, messageId = 'assistant-current') => entries.get('conversation.chat.assistant-actions')?.render({ sessionId, messageId }),
    mountView(sessionId, openView = () => {}) {
      const values = [], refs = [], effects = [], disposers = []
      let position = 0, effectPosition = 0, refPosition = 0, tree
      const state = initial => {
        const i = position++
        if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial
        return [values[i], value => { values[i] = typeof value === 'function' ? value(values[i]) : value }]
      }
      const ref = initial => refs[refPosition++] ??= { current: initial }
      const effect = (fn, dependencies) => {
        const i = effectPosition++, prior = effects[i]
        if (!prior || dependencies.some((value, j) => value !== prior[j])) {
          disposers[i]?.(); effects[i] = dependencies; disposers[i] = fn()
        }
      }
      hookRunner = { state, ref, effect }
      const render = () => {
        hookRunner = { state, ref, effect }
        position = 0; effectPosition = 0; refPosition = 0
        const view = entries.get('conversation.view').render({ sessionId, openView })
        tree = view.type(view.props)
      }
      render()
      return {
        async flush() { await flush(); render() },
        async tick() { for (const fn of timers.values()) fn(); await flush(); render() },
        text: () => elements(tree).map(textOf).join(' '),
        nodes: type => elements(tree).filter(node => node.type === type),
        tree: () => tree,
        button(label) { return elements(tree).find(node => node.type === 'button' && textOf(node) === label) },
        close() { for (const fn of disposers) fn?.() },
      }
    },
    timerCount: () => timers.size,
    mountDock(sessionId, session = { running: true }) {
      return this.mountAction(sessionId, undefined, undefined, undefined, { dock: true, session })
    },
    mountNotice(sessionId, seq = 2, useChat, openView) {
      return this.mountAction(sessionId, 'assistant-current', useChat ?? (selector => selector({ legacy: {
        nodes: [{ kind: 'assistant', seq, messageId: 'assistant-current' }],
      } })), openView, { seq })
    },
    mountAction(sessionId, messageId = 'assistant-current', useChat, openView, notice) {
      const values = [], refs = [], effects = [], disposers = []
      let position = 0, effectPosition = 0, refPosition = 0, tree, props = { sessionId, messageId, useChat, openView, ...notice }
      const state = initial => {
        const i = position++
        if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial
        return [values[i], value => { values[i] = typeof value === 'function' ? value(values[i]) : value }]
      }
      const ref = initial => refs[refPosition++] ??= { current: initial }
      const effect = (fn, dependencies) => {
        const i = effectPosition++, prior = effects[i]
        if (!prior || dependencies.some((value, j) => value !== prior[j])) {
          disposers[i]?.(); effects[i] = dependencies; disposers[i] = fn()
        }
      }
      hookRunner = { state, ref, effect }
      const render = () => {
        hookRunner = { state, ref, effect }
        position = 0; effectPosition = 0; refPosition = 0
        const entry = entries.get(notice?.dock ? 'conversation.input.dock' : notice ? 'conversation.chat.turnTail' : 'conversation.chat.assistant-actions')
        const action = entry?.render({ ...props, ...(notice?.dock ? entry.options.inject?.(props.sessionId) : {}) })
        tree = action?.type ? action.type(action.props) : action
      }
      render()
      return {
        async flush() { await flush(); render() },
        async tick() { for (const fn of timers.values()) fn(); await flush(); render() },
        text: () => elements(tree).map(textOf).join(' '),
        nodes: type => elements(tree).filter(node => node.type === type),
        update(value) { props = { ...props, ...value }; render() },
        close() { for (const fn of disposers.splice(0)) fn?.() },
      }
    },
    panelText: () => elements(entries.get('main')?.render()).filter(node => node.type === 'div').map(textOf).join(' '),
    posted: () => posted,
    mountPanel() {
      const values = [], refs = [], effects = [], disposers = [], callbacks = []
      let position = 0, effectPosition = 0, refPosition = 0, callbackPosition = 0, tree
      const state = initial => { const i = position++; if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial
        return [values[i], value => { values[i] = typeof value === 'function' ? value(values[i]) : value }] }
      const ref = initial => refs[refPosition++] ??= { current: initial }
      const effect = (fn, dependencies) => { const i = effectPosition++, prior = effects[i]
        if (!prior || dependencies.some((value, j) => value !== prior[j])) { disposers[i]?.(); effects[i] = dependencies; disposers[i] = fn() } }
      const callback = (fn, dependencies) => { const i = callbackPosition++, prior = callbacks[i]
        if (!prior || dependencies.some((value, j) => value !== prior.dependencies[j])) callbacks[i] = { fn, dependencies }
        return callbacks[i].fn }
      const render = () => { hookRunner = { state, ref, effect, callback }; position = 0; effectPosition = 0; refPosition = 0; callbackPosition = 0
        const panel = entries.get('main').render(); tree = panel.type(panel.props) }
      const visible = node => { if (!node || typeof node !== 'object' || node.props?.hidden) return []
        if (typeof node.type === 'function') return visible(node.type(node.props))
        return [node, ...node.children.flat(Infinity).flatMap(visible)] }
      const text = node => !node ? '' : typeof node !== 'object' ? String(node) : node.type === 'style' || node.props?.hidden ? ''
        : typeof node.type === 'function' ? text(node.type(node.props)) : node.children.flat(Infinity).map(text).join(' ')
      render()
      return {
        async flush() { await flush(); render() },
        async tick() { for (const fn of [...timers.values()]) fn(); await flush(); render() },
        text: () => text(tree), nodes: type => visible(tree).filter(node => node.type === type),
        styles: () => visible(tree).filter(node => node.type === 'style').map(node => node.children.join('')).join('\n'),
        tree: () => tree,
        button(label) { return visible(tree).find(node => node.type === 'button' && (text(node).trim() === label || (node.props.role === 'tab' && text(node).trim().startsWith(label)))) },
        close() { for (const fn of disposers) fn?.(); hookRunner = null },
      }
    },
    close() { for (const fn of cleanups.reverse()) fn?.(); assert.equal(timers.size, 0); assert.equal(subscribers.size, 0) },
  }
}

const designConfig = () => ({ ok: true, mode: 'auto', threshold: 2, maxParallel: 2, maxAttempts: 2, maxActivations: 8, taskTimeoutMinutes: 15,
  revision: 'revision-a', defaults: { mode: 'auto', threshold: 2, maxParallel: 2, maxAttempts: 2, maxActivations: 8, taskTimeoutMinutes: 15 },
  ranges: { threshold: { min: 0, max: 20 }, maxParallel: { min: 1, max: 4 }, maxAttempts: { min: 1, max: 3 }, maxActivations: { min: 1, max: 32 }, taskTimeoutMinutes: { min: 1, max: 60 } },
  source: { kind: 'file', profile: 'default', environmentValue: null }, modelRouting: 'roles', reviewerModelPolicy: 'dispatcher-snapshot', models: { worker: null, reviewer: null }, locked: false, file: 'C:/test/default.json' })

test('expanded defaults and server ranges work without replacing saved lower limits', async () => {
  const defaults = { maxParallel: 4, maxAttempts: 5, maxActivations: 64, taskTimeoutMinutes: 120 }
  const maxima = { maxParallel: 8, maxAttempts: 10, maxActivations: 256, taskTimeoutMinutes: 240 }
  const ranges = Object.fromEntries(Object.entries(maxima).map(([key, max]) => [key, { min: 1, max }]))
  const f = await sidebarFixture()
  await f.setConfig({ ok: true, mode: 'auto', models: { worker: null, reviewer: null }, defaults, ranges })
  const panel = f.mountPanel()
  try {
    await panel.flush(); panel.button('执行限制').props.onClick(); await panel.flush()
    for (const [key, value] of Object.entries(defaults)) {
      const input = panel.nodes('input').find(node => node.props.id === 'ddf-' + key)
      assert.equal(Number(input.props.value), value, key + ' fallback')
      assert.equal(input.props.max, maxima[key], key + ' range')
      assert.ok(panel.text().includes('默认 ' + value), key + ' default label')
    }
    const saved = designConfig()
    await f.setConfig({ ...saved, revision: 'expanded-revision', defaults, ranges }); await panel.flush()
    for (const key of Object.keys(defaults)) {
      assert.equal(Number(panel.nodes('input').find(node => node.props.id === 'ddf-' + key).props.value), saved[key], key + ' saved value')
    }
    const expanded = { maxParallel: 6, maxAttempts: 6, maxActivations: 128, taskTimeoutMinutes: 180 }
    for (const [key, value] of Object.entries(expanded)) {
      panel.nodes('input').find(node => node.props.id === 'ddf-' + key).props.onChange({ target: { value: String(value) } })
      await panel.flush()
    }
    assert.equal(panel.button('保存').props.disabled, false)
    await panel.button('保存').props.onClick(); await panel.flush()
    for (const [key, value] of Object.entries(expanded)) assert.equal(f.posted().at(-1)[key], value, key + ' saved')
  } finally { panel.close(); f.close() }
})

test('the four configuration tabs preserve drafts and validate fields using server ranges', async () => {
  const configured = designConfig(); configured.ranges.maxAttempts.max = 4
  const f = await sidebarFixture(); await f.setConfig(configured); const panel = f.mountPanel()
  try {
    await panel.flush()
    assert.equal(panel.nodes('button').filter(node => node.props?.role === 'tab').length, 4)
    panel.button('执行限制').props.onClick(); await panel.flush()
    let attempts = panel.nodes('input').find(node => node.props.id === 'ddf-maxAttempts')
    assert.equal(attempts.props.max, 4, 'use the server range rather than a client constant')
    attempts.props.onChange({ target: { value: '5' } }); await panel.flush()
    assert.match(panel.text(), /有 1 项需要修正/)
    assert.equal(panel.button('保存').props.disabled, true)
    panel.button('委派策略').props.onClick(); await panel.flush()
    panel.button('执行限制').props.onClick(); await panel.flush()
    attempts = panel.nodes('input').find(node => node.props.id === 'ddf-maxAttempts')
    assert.equal(String(attempts.props.value), '5')
    attempts.props.onChange({ target: { value: '3' } }); await panel.flush()
    assert.equal(panel.button('保存').props.disabled, false)
    assert.match(panel.text(), /有未保存的修改/)
  } finally { panel.close(); f.close() }
})

test('configuration styles use semantic theme colors for dark-mode contrast', async () => {
  const f = await sidebarFixture(); await f.setConfig(designConfig()); const panel = f.mountPanel()
  try {
    await panel.flush()
    const styles = panel.styles()
    assert.match(styles, /--primary-fill:var\(--dsw-alias-button-primary-fill/)
    assert.match(styles, /--primary-foreground:var\(--dsw-alias-label-primary-foreground/)
    assert.match(styles, /--hover-bg:var\(--dsw-alias-interactive-bg-hover/)
    assert.match(styles, /--focus:var\(--dsw-alias-state-business-primary/)
    assert.doesNotMatch(styles, /--ink:\s*var\(--label-primary\)/)
    assert.match(styles, /\.ddf-settings \.ddf-btn-primary\{[^}]*background:var\(--primary-fill\)[^}]*color:var\(--primary-foreground\)/)
    assert.match(styles, /\.ddf-settings \.ddf-mode\[data-on="true"\]\{[^}]*border-color:var\(--brand\)/)
    assert.match(styles, /\.ddf-settings \.ddf-tab\[data-on="true"\]::after[^}]*background:var\(--brand\)/)
    assert.match(styles, /\.ddf-settings \.ddf-radio\{[^}]*appearance:none/)
    assert.match(styles, /\.ddf-settings \.ddf-radio:checked\{[^}]*radial-gradient\(circle,var\(--brand\)/)
    assert.doesNotMatch(styles, /background:(?:#fff8f8|#fffaf0|#f4fbf6|#eef8f1|#fff6e6|#fdf0f0|#fdecec)/i)
    assert.doesNotMatch(styles, /background:rgba\(0,0,0/)
  } finally { panel.close(); f.close() }
})

test('configuration conflicts preserve user edits and explicitly rebase them on the latest revision', async () => {
  const f = await sidebarFixture(); await f.setConfig(designConfig()); const panel = f.mountPanel()
  try {
    await panel.flush(); panel.button('执行限制').props.onClick(); await panel.flush()
    panel.nodes('input').find(node => node.props.id === 'ddf-maxAttempts').props.onChange({ target: { value: '3' } }); await panel.flush()
    await f.setConfig({ ...designConfig(), revision: 'revision-b', maxParallel: 4 }); await panel.flush()
    assert.match(panel.text(), /配置已在别处更新/)
    assert.equal(panel.button('保存').props.disabled, true)
    panel.button('保留我的修改').props.onClick(); await panel.flush()
    assert.equal(Number(panel.nodes('input').find(node => node.props.id === 'ddf-maxParallel').props.value), 4)
    assert.equal(Number(panel.nodes('input').find(node => node.props.id === 'ddf-maxAttempts').props.value), 3)
    await panel.button('保存').props.onClick(); await panel.flush()
    assert.equal(f.posted().at(-1).revision, 'revision-b')
    assert.match(panel.text(), /已保存/)
  } finally { panel.close(); f.close() }
})

test('configuration read failures prevent saving and retry restores usable controls', async () => {
  let fail = true
  const f = await sidebarFixture(undefined, { fetchConfig: async () => { if (fail) throw new Error('isolated unavailable') } })
  const panel = f.mountPanel()
  try {
    await panel.flush(); assert.match(panel.text(), /暂时无法读取配置/)
    assert.equal(panel.button('保存').props.disabled, true)
    assert.equal(panel.nodes('input').length, 0)
    fail = false
    await panel.button('重新读取').props.onClick(); await panel.flush()
    assert.ok(panel.nodes('input').length > 0)
    assert.doesNotMatch(panel.text(), /暂时无法读取配置/)
  } finally { panel.close(); f.close() }
})

test('failed saving preserves the draft and a locked configuration remains read only', async () => {
  let saveFailed = true
  const f = await sidebarFixture(undefined, { fetchConfig: async request => request?.method === 'POST' && saveFailed
    ? { ok: false, status: 500, json: async () => ({ ok: false, error: '配置写入失败：隔离错误' }) } : undefined })
  await f.setConfig(designConfig()); const panel = f.mountPanel()
  try {
    await panel.flush(); panel.button('执行限制').props.onClick(); await panel.flush()
    panel.nodes('input').find(node => node.props.id === 'ddf-maxParallel').props.onChange({ target: { value: '3' } }); await panel.flush()
    await panel.button('保存').props.onClick(); await panel.flush()
    assert.match(panel.text(), /配置写入失败：隔离错误/)
    assert.equal(Number(panel.nodes('input').find(node => node.props.id === 'ddf-maxParallel').props.value), 3)
    saveFailed = false
    await panel.button('保存').props.onClick(); await panel.flush()
    assert.match(panel.text(), /已保存/)
    await f.setConfig({ ...designConfig(), locked: true, source: { kind: 'env', profile: 'default', environmentValue: 'strict' } }); await panel.flush()
    assert.match(panel.text(), /DSH_DELEGATION_FIRST 锁定/)
    assert.equal(panel.button('保存不可用').props.disabled, true)
    assert.ok(panel.nodes('input').every(node => node.props.disabled))
  } finally { panel.close(); f.close() }
})

test('model choices keep native catalog behavior and clear stale reasoning when switching models', async () => {
  const f = await sidebarFixture({ status: 'ready', value: { groups: [{ id: 'demo', name: 'Demo', models: [
    { id: 'one', name: 'One', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }, { id: 'two', name: 'Two' },
  ] }], failures: [] } })
  await f.setConfig({ ...designConfig(), models: { routine: { provider: 'demo', model: 'one', reasoningEffort: 'high' }, complex: null } })
  const panel = f.mountPanel()
  try {
    await panel.flush(); panel.button('子任务模型').props.onClick(); await panel.flush()
    assert.match(panel.text(), /已配置 1 个服务 · 2 个模型/)
    assert.equal(panel.nodes('select').find(node => node.props.id === 'ddf-effort-worker').props.value, 'high')
    panel.nodes('select').find(node => node.props.id === 'ddf-model-worker').props.onChange({ target: { value: JSON.stringify(['demo', 'two']) } }); await panel.flush()
    assert.equal(panel.nodes('select').find(node => node.props.id === 'ddf-effort-worker').props.value, '')
    assert.equal(panel.nodes('select').find(node => node.props.id === 'ddf-effort-worker').props.disabled, true)
  } finally { panel.close(); f.close() }
})

test('an older host response is scoped locally without showing unrelated tasks or a false load error', async () => {
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true,
    json: async () => ({ ok: true, plans: [{ sessionId: 'session-other', goal: '其他会话的私有需求' }],
      sessions: [{ sessionId: 'session-other' }], archiveWarning: '其他会话的档案提示' }) }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    assert.match(view.text(), /当前没有托管子代理计划/)
    assert.match(view.text(), /重新加载.*DSH Agentrix/)
    assert.doesNotMatch(view.text(), /读取失败|其他会话的私有需求|其他会话的档案提示/)
  } finally { view.close(); f.close() }
})

test('a stopped two-of-four plan explains the unfinished tasks in the dock without claiming a failure', async () => {
  const body = { ok: true, sessionId: 'session-current', plans: [{ sessionId: 'session-current', status: 'cancelled', cancelled: true,
    tasks: [{ id: 'a', title: '数据审查', status: 'accepted' }, { id: 'b', title: '认证审查', status: 'accepted' },
      { id: 'c', title: '技术栈核查', status: 'cancelled', error: '主控已停止任务' },
      { id: 'd', title: '汇总报告', status: 'cancelled', error: '主控已停止任务' }] }], sessions: [] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => body }) })
  const action = f.mountAction('session-current'), notice = f.mountDock('session-current')
  try {
    await action.flush(); await notice.flush()
    assert.match(action.text(), /部分完成，其余已停止.*已验收 2\/4/)
    assert.doesNotMatch(action.text(), /已阻塞/)
    assert.match(notice.text(), /部分完成，其余已停止.*已验收 2\/4/)
    assert.match(notice.text(), /技术栈核查.*汇总报告/)
    assert.match(notice.text(), /主控已停止任务/)
    assert.match(notice.text(), /下一步.*重新安排/)
    assert.equal(notice.nodes('section')[0]?.props['data-kind'], 'stopped')
    assert.equal(notice.nodes('section')[0]?.props.role, 'status')
    assert.equal(action.nodes('section').length, 0)
  } finally { action.close(); notice.close(); f.close() }
})

test('failure details identify the source failure while another child is still running', async () => {
  const body = { ok: true, sessionId: 'session-current', plans: [{ sessionId: 'session-current', status: 'running', tasks: [
    { id: 'waiting', title: '下游汇总', status: 'blocked', error: '等待失败任务处理后继续' },
    { id: 'failed', title: '技术栈核查', status: 'failed', error: 'HTTP 401: provider authentication failed\n at provider.request' },
    { id: 'running', title: '仍在审查', status: 'running' },
  ] }], sessions: [] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => body }) })
  const notice = f.mountDock('session-current')
  try {
    await notice.flush()
    assert.match(notice.text(), /技术栈核查/)
    assert.match(notice.text(), /HTTP 401: provider authentication failed/)
    assert.match(notice.text(), /下一步.*核对失败原因/)
    assert.doesNotMatch(notice.text(), /等待失败任务处理后继续/)
    assert.equal(notice.nodes('section')[0]?.props['data-kind'], 'failed')
    assert.equal(notice.nodes('section')[0]?.props.role, 'alert')
  } finally { notice.close(); f.close() }
})

test('model issues, recovered tasks and missing reasons use the recorded explanation and guidance', async t => {
  for (const scenario of [
    { task: { issue: { code: 'MODEL_CONFIG_INVALID', message: '普通执行模型不可用：magpie / auto/hy4free', action: '请重新选择并保存模型。' }, error: 'no adapter stack trace' },
      reason: /普通执行模型不可用：magpie \/ auto\/hy4free/, next: /重新选择并保存模型/, excluded: /no adapter stack trace/ },
    { task: { recovered: true, error: '插件重新加载，旧子任务需要先清理' }, reason: /插件重新加载/, next: /清理重新加载前的子任务/ },
    { task: { error: 'error' }, reason: /记录中未提供具体原因/, next: /核对失败原因/ },
  ]) await t.test(String(scenario.reason), async () => {
    const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
      sessionId: 'session-current', plans: [{ sessionId: 'session-current', status: 'blocked',
        tasks: [{ id: 'a', title: '受影响任务', status: 'blocked', ...scenario.task }] }], sessions: [] }) }) })
    const notice = f.mountDock('session-current')
    try {
      await notice.flush()
      assert.match(notice.text(), scenario.reason)
      assert.match(notice.text(), scenario.next)
      if (scenario.excluded) assert.doesNotMatch(notice.text(), scenario.excluded)
    } finally { notice.close(); f.close() }
  })
})

test('healthy execution and waits show status cards while accepted legacy tasks add no issue notice', async t => {
  for (const status of ['running', 'planned', 'review', 'accepted']) await t.test(status, async () => {
    const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
      sessionId: 'session-current', plans: [{ sessionId: 'session-current', status,
        dispatchWait: { message: '正在等待其他会话释放名额' }, tasks: [{ id: 'a', status: status === 'planned' ? 'queued' : status }] }], sessions: [] }) }) })
    const notice = f.mountDock('session-current')
    try {
      await notice.flush()
      assert.ok(!notice.nodes('section').some(node => node.props?.role === 'alert'))
      if (status === 'accepted') assert.equal(notice.text(), '')
      else {
        assert.match(notice.text(), /协作进度/)
        assert.ok(notice.nodes('section').some(node => node.props?.['data-kind'] === 'progress' && node.props.role === 'status'))
        if (status === 'planned') assert.match(notice.text(), /等待其他会话释放名额/)
        if (status === 'review') assert.match(notice.text(), /等待主控实际验证/)
      }
    } finally { notice.close(); f.close() }
  })
})

test('the dock, receipt and progress button share one request and timer until the last subscriber leaves', async () => {
  let calls = 0
  const f = await sidebarFixture(undefined, { fetchState: async () => {
    calls++
    return { ok: true, json: async () => ({ ok: true, sessionId: 'session-current', plans: [{ sessionId: 'session-current',
      status: 'blocked', tasks: [{ id: 'a', title: '核查', status: 'failed', error: 'HTTP 500' }] }], sessions: [] }) }
  } })
  const baseline = f.timerCount(), action = f.mountAction('session-current'), notice = f.mountNotice('session-current'), dock = f.mountDock('session-current')
  try {
    await action.flush(); await notice.flush(); await dock.flush()
    assert.equal(calls, 1)
    assert.equal(f.timerCount(), baseline + 1)
    await action.tick(); await notice.flush()
    assert.equal(calls, 2)
    action.close()
    notice.close()
    await dock.tick()
    assert.equal(calls, 3)
    dock.close()
    assert.equal(f.timerCount(), baseline)
  } finally { action.close(); notice.close(); dock.close(); f.close() }
})

test('only the latest turn tail shows and subscribes to the current delivery receipt', async () => {
  let calls = 0
  const snapshot = { timeline: { turnOrder: [1, 2] }, locations: { getTurn: turn => [`tail-${turn}`] }, nodes: new Map([
    ['tail-1', { kind: 'turn-tail', data: { seq: 10, closing: { finalNode: { seq: 10, messageId: 'old' } } } }],
    ['tail-2', { kind: 'turn-tail', data: { seq: 20, closing: { finalNode: { seq: 20, messageId: 'current' } } } }],
  ]) }
  const f = await sidebarFixture(undefined, { fetchState: async () => {
    calls++; return { ok: true, json: async () => ({ ok: true, sessionId: 'session-current', plans: [{
      sessionId: 'session-current', status: 'blocked', tasks: [{ id: 'a', title: '当前任务', status: 'failed', error: '当前错误' }],
      completion: { id: 'receipt', outcome: 'blocked', accepted: 0, total: 1, deliverables: [], evidence: [],
        remaining: [{ taskId: 'a', title: '当前任务', reason: '当前错误' }] },
    }], sessions: [] }) }
  } })
  const old = f.mountNotice('session-current', 10, selector => selector(snapshot))
  const current = f.mountNotice('session-current', 20, selector => selector(snapshot))
  try {
    await old.flush(); await current.flush()
    assert.equal(old.text(), '')
    assert.match(current.text(), /当前错误/)
    assert.equal(calls, 1)
  } finally { old.close(); current.close(); f.close() }
})

test('switching sessions clears prior issues and releasing all subscribers aborts the pending request', async () => {
  let finish, pendingSignal, otherAction
  const f = await sidebarFixture(undefined, { fetchState: async (url, signal) => {
    if (url.includes('session-other')) {
      pendingSignal = signal
      return new Promise(resolve => { finish = resolve })
    }
    return { ok: true, json: async () => ({ ok: true, sessionId: 'session-current', plans: [{ sessionId: 'session-current',
      status: 'blocked', tasks: [{ id: 'a', title: '旧任务', status: 'failed', error: '旧错误' }] }], sessions: [] }) }
  } })
  const notice = f.mountDock('session-current')
  try {
    await notice.flush()
    assert.match(notice.text(), /旧错误/)
    notice.update({ sessionId: 'session-other' }); await notice.flush()
    assert.doesNotMatch(notice.text(), /旧错误|旧任务/)
    otherAction = f.mountAction('session-other')
    notice.close()
    assert.equal(pendingSignal.aborted, false, 'the remaining button still owns the shared request')
    otherAction.close()
    assert.equal(pendingSignal.aborted, true)
    finish({ ok: true, json: async () => ({ ok: true, sessionId: 'session-other', plans: [], sessions: [] }) })
    await new Promise(resolve => setImmediate(resolve))
  } finally { notice.close(); otherAction?.close(); f.close() }
})

test('a new turn refreshes a stopped snapshot and a failed refresh retains the recorded issue', async () => {
  let phase = 'cancelled'
  const f = await sidebarFixture(undefined, { fetchState: async () => {
    if (phase === 'offline') throw new Error('HTTP 503')
    return { ok: true, json: async () => ({ ok: true, sessionId: 'session-current', plans: [{ sessionId: 'session-current', status: phase,
      tasks: [{ id: 'a', title: '核查', status: phase === 'cancelled' ? 'cancelled' : 'failed', error: phase === 'cancelled' ? '主控已停止任务' : '真实执行错误' }] }], sessions: [] }) }
  } })
  const notice = f.mountDock('session-current', { running: false })
  try {
    await notice.flush(); assert.match(notice.text(), /已停止/)
    phase = 'blocked'
    notice.update({ session: { running: true } })
    await notice.flush(); assert.match(notice.text(), /真实执行错误/)
    phase = 'offline'; await notice.tick()
    assert.match(notice.text(), /真实执行错误/)
    assert.match(notice.text(), /状态尚未更新/)
  } finally { notice.close(); f.close() }
})

test('a mismatched response explains recovery and hides export actions instead of showing a bare load error', async () => {
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true,
    json: async () => ({ ok: true, sessionId: 'session-other', plans: [], sessions: [] }) }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    assert.match(view.text(), /暂时无法显示任务状态/)
    assert.match(view.text(), /当前会话/)
    assert.match(view.text(), /不一致/)
    assert.ok(view.button('重新读取'))
    assert.ok(view.button('回到聊天'))
    assert.equal(view.button('查看协作过程'), undefined)
    assert.equal(view.button('整理与导出'), undefined)
    assert.doesNotMatch(view.text(), /读取失败/)
  } finally { view.close(); f.close() }
})

test('manual retry disables repeated requests and restores the normal view after recovery', async () => {
  let calls = 0, finish
  const f = await sidebarFixture(undefined, { fetchState: async () => {
    if (++calls === 1) throw new TypeError('Failed to fetch')
    return new Promise(resolve => { finish = resolve })
  } })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    view.button('重新读取').props.onClick()
    await view.flush()
    const retrying = view.button('正在读取…')
    assert.equal(retrying.props.disabled, true)
    retrying.props.onClick()
    assert.equal(calls, 2)
    finish({ ok: true, json: async () => ({ ok: true, sessionId: 'session-current', plans: [], sessions: [] }) })
    await view.flush()
    assert.match(view.text(), /当前没有托管子代理计划/)
    assert.doesNotMatch(view.text(), /暂时无法显示|Failed to fetch/)
    assert.ok(view.button('整理与导出'))
  } finally { view.close(); f.close() }
})

test('a refresh failure retains the last successful result and marks it as not updated', async () => {
  let fail = false
  const f = await sidebarFixture(undefined, { fetchState: async () => {
    if (fail) throw new Error('HTTP 503')
    return { ok: true, json: async () => ({ ok: true, sessionId: 'session-current',
      plans: [{ sessionId: 'session-current', goal: '本会话上次读取的需求', status: 'accepted', tasks: [] }], sessions: [] }) }
  } })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    fail = true; await view.tick()
    assert.match(view.text(), /本会话上次读取的需求/)
    assert.match(view.text(), /任务状态尚未更新/)
    assert.match(view.text(), /上次读取/)
    assert.ok(view.button('重新读取'))
    assert.doesNotMatch(view.text(), /暂时无法显示任务状态/)
    const sections = view.nodes('main')[0].children.flat(Infinity).filter(node => node?.props?.className)
    assert.ok(sections.findIndex(node => node.props.className === 'ddf-board-load-issue') < sections.findIndex(node => node.props.className === 'ddf-board-hero'),
      'a stale-result warning must appear before the retained task content')
  } finally { view.close(); f.close() }
})

test('acceptance is registered inside the conversation and remounts for each exact session', async () => {
  const f = await sidebarFixture()
  try {
    const openView = () => {}
    const first = f.view('session-5b9af71d-a', openView)
    const second = f.view('session-6c0bf82e-b', openView)
    assert.equal(first.props.sessionId, 'session-5b9af71d-a')
    assert.equal(second.props.sessionId, 'session-6c0bf82e-b')
    assert.notEqual(first.props.key, second.props.key)
    assert.equal(first.props.openView, openView)
    first.props.onFix('routine')
    assert.equal(f.selectedPanel(), 'dsh-delegation-first')
  } finally { f.close() }
})

test('settings render before the first response and do not include the old global task and archive center', async () => {
  const f = await sidebarFixture()
  try {
    const text = f.panelText()
    assert.match(text, /配置/)
    assert.match(text, /任务验收/)
    assert.doesNotMatch(text, /查看历史任务|打开任务档案|查看验收详情/)
  } finally { f.close() }
})

test('sidebar marks stale models before the configuration page is opened and clears after a saved correction', async () => {
  const f = await sidebarFixture()
  try {
    assert.match(f.label(), /DSH Agentrix.*模型不可用/)
    await f.setConfig({ ok: true, mode: 'auto', models: { routine: null, complex: null } })
    assert.equal(f.label(), 'DSH Agentrix')
  } finally { f.close() }
})

test('a visible reminder explains the impact, can be dismissed, and opens model configuration', async () => {
  const f = await sidebarFixture()
  try {
    assert.match(f.reminderText(), /子任务暂时无法启动/)
    assert.match(f.reminderText(), /去调整模型/)
    f.clickReminder('稍后处理')
    assert.equal(f.reminderText(), '')
    assert.match(f.label(), /模型不可用/, 'dismissing the banner must retain the sidebar warning')
    await f.setConfig({ ok: true, mode: 'auto', models: { routine: { provider: 'retired', model: 'worker' }, complex: null } })
    assert.equal(f.reminderText(), '', 'polling the same problem must not reopen the banner')
    await f.setConfig({ ok: true, mode: 'auto', models: { routine: { provider: 'another-retired', model: 'worker' }, complex: null } })
    assert.match(f.reminderText(), /子任务暂时无法启动/)
    f.clickReminder('去调整模型')
    assert.equal(f.selectedPanel(), 'dsh-delegation-first')
  } finally { f.close() }
})

test('loading and provider catalog failures do not become stale-model alerts', async () => {
  const f = await sidebarFixture({ status: 'loading', value: null })
  try {
    assert.equal(f.label(), 'DSH Agentrix')
    f.setCatalog({ status: 'ready', value: { groups: [], failures: [{ id: 'retired', message: 'temporary failure' }] } })
    assert.equal(f.label(), 'DSH Agentrix')
    f.setCatalog({ status: 'ready', value: { groups: [], failures: [] } })
    assert.match(f.label(), /模型不可用/)
  } finally { f.close() }
})

test('the board exposes the confirmed plan before tasks and keeps rule-based advice in diagnostics', async () => {
  const body = { ok: true, sessionId: 'session-current', plans: [{ sessionId: 'session-current', status: 'running',
    goal: '按接口规范开发工具', routing: { route: 'delegate_parallel', reasons: ['multiple_files'] }, tasks: [
      { id: 'spec', title: '确定接口规范', status: 'running', complexity: 'routine' },
      { id: 'build', title: '开发工具', status: 'queued', complexity: 'complex', dependsOn: ['spec'] },
    ] }], sessions: [
    { sessionId: 'another-session', difficulty: { level: 'complex', score: 19, signals: ['其他会话信号'] } },
    { sessionId: 'session-current', difficulty: { level: 'medium', score: 3, signals: ['涉及多个文件'] },
      route: { route: 'delegate_parallel', reasons: ['multiple_files'] }, turnStats: { direct: 1, delegated: 1, denied: 0 },
      sessionStats: { denied: 4 }, last: { tool: 'pwsh', message: '主控命令需要先委派' } },
  ] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    const sections = view.nodes('section')
    const decisionIndex = sections.findIndex(node => node?.props?.className === 'ddf-board-decision')
    assert.ok(decisionIndex >= 0, 'judgment summary must be visible without expanding diagnostics')
    assert.ok(decisionIndex < sections.findIndex(node => node?.props?.['data-task-list'] === ''), 'judgment must precede task cards')
    const main = view.nodes('div').find(node => node.props?.className === 'ddf-board-decision-main')
    assert.match(JSON.stringify(main), /主控已确认.*复杂.*独立审查/)
    assert.doesNotMatch(JSON.stringify(main), /评分 3|系统建议/)
    assert.match(view.text(), /规则判断.*中等.*评分 3.*并行委派多个子 Agent/)
    assert.match(view.text(), /当前实际安排.*按任务依赖先后执行/)
    assert.match(view.text(), /本轮拦截.*0.*本次载入后累计 4 次/)
    assert.doesNotMatch(view.text(), /其他会话信号|评分 19/)
    assert.match(view.text(), /最近一次策略拦截.*pwsh.*主控命令需要先委派/)
  } finally { view.close(); f.close() }
})

test('the no-plan view shows the session name and actual coordinator work separately from advice', async () => {
  const body = { ok: true, sessionId: 'session-current', plans: [], sessions: [{
    sessionId: 'session-current', sessionTitle: '便签保存内容丢失排查',
    difficulty: { level: 'complex', score: 6, signals: ['需要实施或评审'] },
    route: { route: 'delegate', reasons: ['high_complexity'] },
    turnStats: { direct: 12, delegated: 0, denied: 0 },
  }] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    assert.match(view.text(), /当前会话：便签保存内容丢失排查/)
    assert.match(view.text(), /主控已直接执行/)
    assert.match(view.text(), /本轮业务操作 12/)
    assert.match(view.text(), /规则评分只给分流建议，不会自动派单/)
    assert.match(view.text(), /当前没有托管子代理计划/)
    assert.doesNotMatch(view.text(), /已安排子代理/)
  } finally { view.close(); f.close() }
})

test('judgment summary retains zero scores and never presents cumulative counters as this-turn counts', async () => {
  const body = { ok: true, sessionId: 'session-current', plans: [], sessions: [{ sessionId: 'session-current',
    difficulty: { level: 'simple', score: 0, signals: [] }, route: { route: 'direct', reasons: [] }, direct: 8, delegated: 6, denied: 4 }] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    assert.match(view.text(), /评分 0/)
    const main = view.nodes('div').find(node => node.props?.className === 'ddf-board-decision-main')
    assert.match(JSON.stringify(main), /尚未确认/)
    assert.doesNotMatch(JSON.stringify(main), /简单|评分 0/)
    const counters = view.nodes('div').filter(node => node.props?.className === 'ddf-board-decision-count')
    assert.equal(counters.length, 3)
    assert.ok(counters.every(node => node.children.flat(Infinity).some(child => child?.type === 'strong' && child.children.includes('未记录'))))
  } finally { view.close(); f.close() }
})

test('task facts keep models and complexity separate and current tool activity wins over the previous tool', async () => {
  const task = { id: 'a', title: '分析接口', status: 'running', complexity: 'complex', complexityReason: '包含协议适配', progress: { tool: 'read' },
    modelRoute: { role: 'worker', requested: { provider: 'magpie', model: 'group/xiaodi' }, actual: { provider: 'magpie', model: 'group/xiaodi' } },
    audit: { status: 'queued', modelRoute: { role: 'reviewer', requested: { provider: 'demo', model: 'high-reviewer' } } },
    supervision: { startedAt: Date.now(), used: 0, limit: 2, activity: { kind: 'tool', tool: 'pwsh' } } }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true, sessions: [],
    plans: [{ sessionId: 'session-current', goal: '核查当前动作', status: 'running', tasks: [task] }] }) }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    assert.ok(view.nodes('dl').some(node => node.props?.className === 'ddf-board-task-facts'))
    const activity = view.nodes('p').find(node => node.props?.className === 'ddf-board-task-line' && node.props?.['data-current-activity'])
    assert.ok(activity, 'current activity needs its own visible line')
    assert.match(activity.children.flat(Infinity).filter(child => typeof child === 'string').join(' '), /工具正在执行.*pwsh/)
    assert.doesNotMatch(activity.children.flat(Infinity).filter(child => typeof child === 'string').join(' '), /read/)
    assert.match(view.text(), /group\/xiaodi/)
    assert.match(view.text(), /high-reviewer/)
    assert.match(view.text(), /仅核对.*模型标识/)
  } finally { view.close(); f.close() }
})

test('the acceptance view explains the automatic route and plan dispatch budget', async () => {
  const response = { ok: true, json: async () => ({ ok: true, sessionId: 'session-current',
    plans: [{ sessionId: 'session-current', goal: '完成登录改造', source: { text: '实现登录并补测试', messageId: 'm1' },
      status: 'blocked', autoDispatch: false,
      routing: { route: 'delegate_parallel', reasons: ['high_complexity', 'parallel_candidates'], estimatedSteps: 4, parallelTasks: 2, confidence: 0.9 },
      routingWarnings: ['路由建议并行，但任务卡只有 1 个任务；请确认是否遗漏可独立工作'],
      activationBudget: { limit: 8, used: 2, remaining: 6 }, cwd: 'D:/project', tasks: [{
        id: 'login', title: '登录改造', status: 'blocked', complexity: 'complex', error: '计划派发预算已用尽', criteria: ['结果可验证'], checks: [],
        dependsOn: [], outputs: ['src/login.js'], writes: ['src/login.js'], model: null, childId: null,
      }] }], sessions: [{ sessionId: 'session-current', route: { route: 'delegate_parallel', reasons: ['high_complexity', 'parallel_candidates'] } }] }) }
  const f = await sidebarFixture(undefined, { fetchState: async () => response })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    assert.match(view.text(), /并行委派多个子 Agent/)
    assert.match(view.text(), /复杂度达到高位/)
    assert.match(view.text(), /派发尝试.*2 \/ 8.*剩余 6/)
    assert.match(view.text(), /路由提醒/)
    assert.match(view.text(), /任务复杂度\s+复杂/)
  } finally { view.close(); f.close() }
})

test('the acceptance view is an operation board for stopped work and exposes the root reason first', async () => {
  const body = { ok: true, sessionId: 'session-current', plans: [{ sessionId: 'session-current', status: 'cancelled', cancelled: true,
    goal: '完成密评初查', source: { text: '检查项目结构与认证链路' },
    tasks: [{ id: 'a', title: '审查认证链路', status: 'accepted', complexity: 'complex', criteria: [], checks: [] },
      { id: 'b', title: '核查技术栈与部署配置', status: 'cancelled', error: '主控已停止任务', complexity: 'routine', criteria: ['结果可定位'], checks: [] },
      { id: 'c', title: '汇总报告', status: 'cancelled', error: '计划因子任务 b 失败而暂停', complexity: 'routine', criteria: [], checks: [] }] }], sessions: [] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    assert.match(view.text(), /已停止/)
    assert.match(view.text(), /本次需求.*完成密评初查/)
    assert.match(view.text(), /任务列表/)
    assert.match(view.text(), /核查技术栈与部署配置/)
    assert.match(view.text(), /主控已停止任务/)
    assert.match(view.text(), /受影响/)
    assert.doesNotMatch(view.text(), /待派单.*已停止/)
    assert.equal(view.nodes('svg').length, 0, 'the default view must not render the blueprint wires or mascot')
    assert.equal(view.nodes('details').filter(node => node.props?.open).length, 0, 'technical details start collapsed')
    assert.ok(view.nodes('button').some(node => String(node.props?.['aria-expanded']) === 'false'))
  } finally { view.close(); f.close() }
})

test('conversation assessment stays inside the scrolling board and uses labelled fields instead of a wide table', async () => {
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
    sessionId: 'session-current', plans: [], sessions: [{ sessionId: 'session-current', role: 'coordinator',
      difficulty: { level: 'simple', score: 0, signals: ['continuation'] }, route: { route: 'direct', reasons: ['small_scope'] },
      turnStats: { direct: 0, delegated: 0, denied: 0 }, sessionStats: { denied: 3 }, last: null }] }) }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    const main = view.nodes('main')[0]
    const descendants = node => !node || typeof node !== 'object' ? [] : [node, ...node.children.flat(Infinity).flatMap(descendants)]
    assert.ok(descendants(main).some(node => node.props?.className === 'ddf-board-diagnostics'), 'assessment must share the board scroll container')
    assert.equal(view.nodes('table').length, 0, 'a single conversation must not use the old seven-column table')
    assert.ok(view.nodes('dl').length)
    assert.match(view.text(), /本轮业务操作.*本轮派发.*本轮拦截/)
    assert.match(view.text(), /本次载入后累计 3 次/)
    const styles = view.nodes('style').map(node => node.children.join('')).join('\n')
    assert.match(styles, /\.ddf-board-diagnostics/)
    assert.match(styles, /\.ddf-board-assessment/)
    assert.match(styles, /box-sizing:border-box/)
  } finally { view.close(); f.close() }
})

test('board plan status follows task reality and activity priority', async t => {
  const cases = [
    ['stopped legacy plan', { status: 'blocked', tasks: [{ status: 'accepted' }, { status: 'cancelled' }] }, '已停止'],
    ['explicit cancellation wins', { status: 'cancelled', tasks: [{ status: 'failed' }] }, '已停止'],
    ['failure before activity', { status: 'running', tasks: [{ status: 'running' }, { status: 'failed' }] }, '有失败'],
    ['activity before review', { status: 'review', tasks: [{ status: 'review' }, { status: 'starting' }] }, '执行中'],
    ['blocking while active', { status: 'blocked', tasks: [{ status: 'blocked' }, { status: 'running' }] }, '执行中'],
    ['blocked without activity', { status: 'running', tasks: [{ status: 'blocked' }, { status: 'queued' }] }, '已阻塞'],
    ['review', { status: 'running', tasks: [{ status: 'review' }] }, '待验收'],
    ['done', { status: 'running', tasks: [{ status: 'accepted' }] }, '已完成'],
    ['queued', { status: 'planned', tasks: [{ status: 'queued' }] }, '待派单'],
    ['audit active', { status: 'review', tasks: [{ status: 'review', audit: { status: 'running' } }] }, '执行中'],
    ['audit failed', { status: 'review', tasks: [{ status: 'review', audit: { status: 'failed', error: '审查服务不可用' } }] }, '有失败'],
  ]
  for (const [name, plan, label] of cases) await t.test(name, async () => {
    const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
      sessionId: 'session-current', plans: [{ ...plan, sessionId: 'session-current', goal: '检查状态',
        tasks: plan.tasks.map((task, i) => ({ id: String(i), title: '任务' + i, ...task })) }], sessions: [] }) }) })
    const view = f.mountView('session-current')
    try {
      await view.flush()
      const status = view.nodes('span').find(node => node.props?.className === 'ddf-board-status')
      assert.equal(status.children.join(''), label)
    } finally { view.close(); f.close() }
  })
})

test('board leads with the source failure and keeps downstream pauses secondary', async () => {
  const body = { ok: true, sessionId: 'session-current', sessions: [], plans: [{ sessionId: 'session-current', status: 'blocked', goal: '核查配置',
    tasks: [{ id: 'report', title: '汇总报告', status: 'blocked', dependsOn: ['source'], error: '计划因子任务 source 失败而暂停' },
      { id: 'running', title: '仍在核查', status: 'running', progress: { tool: 'read' } },
      { id: 'source', title: '检查登录配置', status: 'failed', error: 'HTTP 401', issue: { message: '凭证无效', action: '更新凭证后请主控决定是否重试' } }] }] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => body }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    const tasks = view.nodes('article').filter(node => node.props?.className === 'ddf-board-task')
    assert.equal(tasks[0].props['data-task-id'], 'source')
    assert.equal(tasks[0].props['data-root'], 'true')
    assert.equal(tasks.find(node => node.props['data-task-id'] === 'report').props['data-affected'], 'true')
    assert.match(view.text(), /凭证无效/)
    assert.match(view.text(), /更新凭证后请主控决定是否重试/)
    assert.match(view.text(), /受影响/)
    assert.match(view.text(), /执行中/)
  } finally { view.close(); f.close() }
})

test('board preserves model repair, reload cleanup, missing reasons and dependency waiting', async t => {
  for (const [task, pattern] of [
    [{ status: 'blocked', issue: { code: 'MODEL_CONFIG_INVALID', tier: 'routine', message: '普通执行模型不可用', action: '重新选择可用模型并保存' } }, /普通执行模型不可用/],
    [{ status: 'blocked', recovered: true, error: '插件重新加载，旧子任务需要先清理' }, /先清理重新加载前的子任务/],
    [{ status: 'failed', error: 'error' }, /记录中未提供具体原因/],
    [{ status: 'queued', dependsOn: ['parent'] }, /等待.*前置核查/],
  ]) await t.test(String(pattern), async () => {
    const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true, sessionId: 'session-current',
      plans: [{ sessionId: 'session-current', status: 'running', goal: '运行检查', tasks: [
        { id: 'parent', title: '前置核查', status: 'running' }, { id: 'child', title: '后续核查', ...task }] }], sessions: [] }) }) })
    const view = f.mountView('session-current')
    try {
      await view.flush()
      assert.match(view.text(), pattern)
      if (task.issue?.code === 'MODEL_CONFIG_INVALID') {
        assert.ok(view.button('去调整模型'))
        view.button('去调整模型').props.onClick()
        assert.equal(f.selectedPanel(), 'dsh-delegation-first')
      }
    } finally { view.close(); f.close() }
  })
})

test('collapsed board task details retain the full request, model, checks, evidence and reports', async () => {
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true, sessionId: 'session-current', sessions: [],
    plans: [{ sessionId: 'session-current', status: 'accepted', goal: '核查接口', source: { text: '原始需求完整内容', messageId: 'message-source' }, cwd: 'D:/project',
      tasks: [{ id: 'api', title: '接口检查', status: 'accepted', childId: 'child-session', dependsOn: ['base'], outputs: ['src/api.js'],
        modelRoute: { requested: { provider: 'provider-a', model: 'worker-requested' }, actual: { provider: 'provider-b', model: 'worker-actual' } },
        criteria: ['返回字段完整'], checks: [{ tool: 'test', arguments: { command: 'node --test' }, result: { passed: true, callId: 'check-123', summary: '字段验证通过' } }],
        review: { findings: [{ criterion: 0, finding: '符合标准', evidence: ['check-123'] }] }, release: { status: 'released' },
        execution: { status: 'DONE', summary: '完成字段检查', reportPath: 'reports/api.md' },
        audit: { status: 'completed', specVerdict: 'pass', qualityVerdict: 'pass', report: '独立审查完整报告' }, report: '子任务完整报告' }] }] }) }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    assert.equal(view.nodes('details').filter(node => node.props?.open).length, 0)
    view.button('查看验收详情').props.onClick()
    await view.flush()
    for (const value of ['原始需求完整内容', 'message-source', '返回字段完整', 'node --test', 'check-123', '字段验证通过', '符合标准',
      'provider-a / worker-requested', 'provider-b / worker-actual', 'child-session', 'src/api.js', 'base', 'reports/api.md', '独立审查完整报告', '子任务完整报告', '子 Agent 已关闭']) {
      assert.ok(view.text().includes(value), value)
    }
  } finally { view.close(); f.close() }
})

test('the latest assistant action shows multi-task progress and updates to final acceptance', async () => {
  let body = { ok: true, sessionId: 'session-current', plans: [{
    sessionId: 'session-current', status: 'running', autoDispatch: true,
    routing: { route: 'delegate_parallel', reasons: ['multiple_files', 'parallel_candidates'], estimatedSteps: 4, parallelTasks: 2, confidence: 0.9 },
    activationBudget: { limit: 8, used: 2, remaining: 6 }, dispatchWait: null,
    tasks: [
      { id: 'a', title: '读取源码', status: 'accepted', progress: { tool: 'read', at: Date.now() }, error: null },
      { id: 'b', title: '整理方案', status: 'running', progress: { tool: 'grep', at: Date.now() }, error: null },
      { id: 'c', title: '补充验证', status: 'queued', progress: null, error: null },
    ],
  }], sessions: [{ sessionId: 'session-current', route: { route: 'delegate_parallel', reasons: ['multiple_files', 'parallel_candidates'] } }] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const action = f.mountAction('session-current', 'assistant-current')
  try {
    await action.flush()
    assert.match(action.text(), /进行中 1 · 已完成 1\/3/)
    assert.doesNotMatch(action.text(), /读取源码|整理方案|补充验证|派发|判断依据/)
    body = { ...body, plans: [{ ...body.plans[0], status: 'accepted', autoDispatch: false,
      tasks: body.plans[0].tasks.map(task => ({ ...task, status: 'accepted' })) }] }
    await action.tick()
    assert.match(action.text(), /已完成 3\/3/)
  } finally { action.close(); f.close() }
})

test('running supervision is visible in chat and task details with evidence, elapsed time and separate budgets', async () => {
  const task = { id: 'a', title: '修复工具参数', status: 'running', criteria: [], checks: [],
    supervision: { used: 1, limit: 2, startedAt: Date.now() - 720000, deadlineAt: Date.now() + 600000,
      pending: { code: 'REPEATED_TOOL_ERROR', reason: 'input 必须传对象，连续三次参数错误。' },
      activity: { kind: 'model' }, metrics: { requests: 12, outputTokens: 1200, contextTokens: 24000 },
      limits: { requests: 80, outputTokens: 40000 },
      checkpoint: { phase: 'investigation', summary: '已确认真实参数 schema。', nextStep: '按已确认接口实现。', verified: false },
      lastCorrection: { message: '先使用正确的对象参数。' } } }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true, sessions: [],
    plans: [{ protocolVersion: 2, sessionId: 'session-current', goal: '验证过程监督', status: 'running', tasks: [task] }] }) }) })
  const view = f.mountView('session-current'), action = f.mountAction('session-current'), notice = f.mountDock('session-current')
  try {
    await view.flush(); await action.flush(); await notice.flush()
    assert.match(view.text(), /已执行.*12.*分钟/)
    assert.match(view.text(), /模型正在生成/)
    assert.match(view.text(), /模型调用.*12\/80/)
    assert.match(view.text(), /1200\/40000/)
    assert.match(view.text(), /执行者提交，待核实/)
    assert.match(view.text(), /按已确认接口实现/)
    assert.match(view.text(), /先使用正确的对象参数/)
    assert.match(action.text(), /待主控纠偏.*1/)
    assert.match(notice.text(), /input 必须传对象/)
    assert.ok(notice.nodes('section').some(node => node.props['data-kind'] === 'supervision'))
    assert.doesNotMatch(notice.text(), /执行失败|已完成/)
    task.supervision.limits.outputTokens = null
    task.supervision.metrics.outputTokens = 50000
    await view.tick()
    assert.match(view.text(), /输出 50000 Token.*本次执行统计/)
    assert.doesNotMatch(view.text(), /50000\/(?:null|undefined|40000)/)
  } finally { view.close(); action.close(); notice.close(); f.close() }
})

test('the chat action owns its compact styles without mounting a settings or acceptance page', async () => {
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true,
    json: async () => ({ ok: true, sessionId: 'session-current', plans: [],
      sessions: [{ sessionId: 'session-current', route: { route: 'direct', reasons: [] } }] }) }) })
  const action = f.mountAction('session-current')
  try {
    await action.flush()
    assert.equal(action.nodes('details').length, 0, 'the action strip must not contain expandable task details')
    const styles = action.nodes('style').map(node => node.children.join('')).join('\n')
    assert.match(styles, /height:\s*24px/)
    assert.match(styles, /white-space:\s*nowrap/)
    assert.match(styles, /text-overflow:\s*ellipsis/)
    assert.match(styles, /max-width:/)
    assert.match(styles, /:focus-visible/)
    assert.match(styles, /var\(--dsw-alias-bg-layer-/)
    assert.match(action.text(), /直接执行/)
  } finally { action.close(); f.close() }
})

test('the compact chat button opens the current conversation acceptance view', async () => {
  const opened = []
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true,
    json: async () => ({ ok: true, sessionId: 'session-current', plans: [],
      sessions: [{ sessionId: 'session-current', route: { route: 'delegate', reasons: [] } }] }) }) })
  const action = f.mountAction('session-current', 'assistant-current', undefined, id => opened.push(id))
  try {
    await action.flush()
    const [button] = action.nodes('button')
    assert.ok(button, 'progress must be a keyboard-accessible native button')
    assert.equal(button.props.type, 'button')
    assert.equal(button.props.disabled, false)
    assert.match(button.props['aria-label'], /查看验收详情/)
    button.props.onClick()
    assert.deepEqual(opened, ['delegation-acceptance'])
  } finally { action.close(); f.close() }
})

test('a host without chat navigation explains how to reach acceptance without expanding the action strip', async () => {
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true,
    json: async () => ({ ok: true, sessionId: 'session-current', plans: [],
      sessions: [{ sessionId: 'session-current', route: { route: 'delegate', reasons: [] } }] }) }) })
  const action = f.mountAction('session-current')
  try {
    await action.flush()
    const [button] = action.nodes('button')
    assert.ok(button)
    assert.equal(button.props.disabled, true)
    assert.match(button.props.title, /无法从此处打开.*任务验收/)
    assert.match(button.props['aria-label'], /无法从此处打开.*任务验收/)
    assert.equal(action.nodes('details').length, 0)
  } finally { action.close(); f.close() }
})

test('older assistant actions do not duplicate the live progress card', async () => {
  const response = { ok: true, json: async () => ({ ok: true, sessionId: 'session-current',
    plans: [{ sessionId: 'session-current', status: 'running', tasks: [{ id: 'a', title: '执行任务', status: 'running', progress: null }] }],
    sessions: [{ sessionId: 'session-current', route: { route: 'delegate', reasons: ['medium_complexity'] } }] }) }
  const f = await sidebarFixture(undefined, { fetchState: async () => response })
  const useChat = selector => selector({ legacy: { nodes: [
    { kind: 'assistant', messageId: 'assistant-old', seq: 1 },
    { kind: 'assistant', messageId: 'assistant-current', seq: 2 },
  ] } })
  const oldAction = f.mountAction('session-current', 'assistant-old', useChat)
  try {
    await oldAction.flush()
    assert.equal(oldAction.text(), '')
    oldAction.close()
    const currentAction = f.mountAction('session-current', 'assistant-current', useChat)
    await currentAction.flush()
    assert.match(currentAction.text(), /进行中 1 · 已完成 0\/1/)
    currentAction.close()
  } finally { oldAction.close(); f.close() }
})
