import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

test('acceptance keeps the current task and actual execution visible above the activity feed', async () => {
  const request = { messageId: 'layout-request', text: '核对导入视频的效果' }
  const plan = { sessionId: 'session-current', source: request, goal: '核对视频导入与导出', status: 'running',
    decision: { mode: 'direct', reason: '最初预计直接核查' }, tasks: [{ id: 'a', title: '核查导入', status: 'running' }] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
    sessionId: plan.sessionId, plans: [plan], sessions: [{ sessionId: plan.sessionId, source: request }] }) }) })
  const view = f.mountView(plan.sessionId)
  const text = node => !node ? '' : typeof node !== 'object' ? String(node) : typeof node.type === 'function' ? text(node.type(node.props))
    : node.children.flat(Infinity).map(text).join(' ')
  try {
    await view.flush()
    const header = view.nodes('header')[0]
    assert.match(text(header), /核对视频导入与导出/)
    assert.match(text(header), /子代理协作/)
    assert.match(text(header), /执行中/)
    assert.doesNotMatch(text(header), /主控直接处理/)
  } finally { view.close(); f.close() }
})

test('long coordinator decisions lead with the conclusion and retain the full reason in a closed disclosure', async () => {
  const reason = '视觉调整依赖本轮上下文。' + '需要逐项核对交付效果和用户补充的要求。'.repeat(16)
  const request = { messageId: 'decision-layout', text: '调整视频导入效果' }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
    sessionId: 'session-current', plans: [], sessions: [{ sessionId: 'session-current', source: request,
      decision: { mode: 'direct', reason, requestId: request.messageId, at: 100 },
      execution: { requestId: request.messageId, running: true, lastResult: { tool: 'present', at: 110 } } }] }) }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    const decision = view.nodes('details').find(node => node.props?.['data-decision-reason'] === '')
    assert.ok(decision)
    assert.ok(!decision.props.open)
    assert.match(view.text(), /主控直接处理/)
    assert.ok(view.text().includes(reason), 'the complete recorded reason remains available')
    const tool = view.nodes('article').find(node => node.props?.['data-source'] === 'tool')
    assert.equal(tool.props['data-compact'], true)
    assert.doesNotMatch(view.text(), /present ·/)
  } finally { view.close(); f.close() }
})

/** Flatten a virtual element (including function components) to readable text. */
const flatten = node => !node ? '' : typeof node !== 'object' ? String(node)
  : node.type === 'style' ? ''
  : typeof node.type === 'function' ? flatten(node.type(node.props))
  : node.children.flat(Infinity).map(flatten).join(' ')

test('acceptance task labels distinguish pending review, errors, cancellation and capacity waiting', async () => {
  const request = { messageId: 'acceptance-labels', text: '核对独立审查与执行状态' }
  const plan = { sessionId: 'session-current', source: request, status: 'running', tasks: [
    { id: 'auditing', title: '核对改写', status: 'review', attempts: 2, audit: { status: 'running', forAttempt: 2 } },
    { id: 'failed', title: '运行失败', status: 'failed' },
    { id: 'blocked', title: '缺少资料', status: 'blocked' },
    { id: 'cancelled', title: '取消重复检查', status: 'cancelled' },
    { id: 'waiting', title: '等待并发名额', status: 'queued', dependsOn: [] },
  ] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
    sessionId: plan.sessionId, plans: [structuredClone(plan)], sessions: [{ sessionId: plan.sessionId, source: request }] }) }) })
  const view = f.mountView(plan.sessionId)
  const card = id => view.nodes('details').find(node => node.props?.['data-acceptance-task'] === id)
  try {
    await view.flush()
    assert.doesNotMatch(flatten(card('auditing')), /独立审查通过/)
    assert.match(flatten(card('auditing')), /独立审查.*执行中|独立审查.*进行中/)
    assert.match(flatten(view.nodes('section').find(node => node.props?.['data-acceptance-conclusion'])), /待验收 0/,
      'a running independent review must not also count as awaiting coordinator acceptance')
    assert.match(flatten(card('failed')), /执行失败/)
    assert.match(flatten(card('blocked')), /已阻塞/)
    assert.match(flatten(card('cancelled')), /已取消/)
    assert.match(flatten(card('waiting')), /待派单/)
    assert.doesNotMatch(flatten(card('waiting')), /等待前置/)
    plan.tasks[0].audit = { status: 'completed', forAttempt: 2, specVerdict: 'fail', qualityVerdict: 'pass' }
    await view.tick()
    assert.doesNotMatch(flatten(card('auditing')), /独立审查通过/)
    plan.tasks[0].audit.specVerdict = 'pass'
    await view.tick()
    assert.match(flatten(card('auditing')), /独立审查通过/)
    plan.tasks[0].audit.forAttempt = 1
    await view.tick()
    assert.doesNotMatch(flatten(card('auditing')), /独立审查通过/, 'an earlier attempt cannot certify the current deliverable')
  } finally { view.close(); f.close() }
})

test('acceptanceViewOf is the single state source for all nine page states', async () => {
  const f = await sidebarFixture()
  try {
    const of = (plans, sessions) => f.acceptanceViewOf({ sessionId: 's', plans, sessions }, 's')
    const request = { messageId: 'm1', text: '需求' }
    const session = { sessionId: 's', source: request }
    const plan = { sessionId: 's', source: request, status: 'running', tasks: [{ id: 'a', status: 'running' }] }
    assert.equal(of([], []), 'empty')
    assert.equal(of([], [session]), 'unknown')
    assert.equal(of([], [{ ...session, pendingMessages: [{ text: '新消息' }] }]), 'pending')
    assert.equal(of([], [{ ...session, decision: { mode: 'direct', reason: '理由' } }]), 'direct')
    assert.equal(of([plan], [session]), 'running')
    assert.equal(of([{ ...plan, cancelled: true }], [session]), 'cancelled')
    for (const outcome of ['completed', 'partial', 'blocked', 'cancelled']) {
      assert.equal(of([{ ...plan, completion: { id: 'r1', outcome, accepted: 0, total: 1,
        deliverables: [], evidence: [], remaining: [] } }], [session]), outcome)
    }
    assert.equal(of([{ ...plan, completion: { id: 'r2', outcome: 'unknown-value' } }], [session]), 'unknown')
    // A plan belonging to a previous request is never the current conclusion.
    assert.equal(of([{ ...plan, source: { messageId: 'old' } }], [{ ...session, source: { messageId: 'new' } }]), 'unknown')
  } finally { f.close() }
})

test('acceptance keeps the first conclusion visible instead of following a collapsed activity feed', async () => {
  const request = { messageId: 'acceptance-scroll', text: '核对首屏结论' }
  const body = { ok: true, sessionId: 'session-current', plans: [{ sessionId: 'session-current', source: request,
    status: 'running', tasks: [{ id: 'a', title: '核查', status: 'running' }] }],
    sessions: [{ sessionId: 'session-current', source: request }] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const view = f.mountView(body.sessionId)
  const page = { scrollTop: 0, scrollHeight: 3000, clientHeight: 500, querySelector: () => ({ open: false }) }
  try {
    await view.flush()
    view.nodes('main')[0].props.ref.current = page
    await view.tick()
    assert.equal(page.scrollTop, 0, 'the initial conclusion cannot disappear after a refresh')
    page.scrollTop = 120
    view.nodes('main')[0].props.onScroll({ currentTarget: page })
    await view.tick()
    assert.equal(page.scrollTop, 120, 'reading the evidence must preserve the current position')
    body.plans[0].source = body.sessions[0].source = { messageId: 'acceptance-next', text: '新的验收对象' }
    await view.tick()
    assert.equal(page.scrollTop, 0, 'another request starts at its conclusion')
  } finally { view.close(); f.close() }
})

test('direct execution renders a conclusion card with decision, execution summary and no-receipt notice', async () => {
  const request = { messageId: 'direct-req', text: '调整分享文章的案例，并核对生成的文档' }
  const session = { sessionId: 'session-current', source: request,
    decision: { mode: 'direct', reason: '目标产物路径明确，主控直接处理可减少派单开销。', requestId: request.messageId, at: 100 },
    execution: { requestId: request.messageId, running: false, toolCalls: 6,
      lastResult: { tool: 'write', target: 'exports/成片.mp4', at: 110 }, unresolvedChanges: [] } }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
    sessionId: 'session-current', plans: [], sessions: [session] }) }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    assert.match(view.text(), /主控直接执行/)
    assert.match(view.text(), /主控直接完成/)
    assert.match(view.text(), /本次需求未建立托管计划/)
    assert.match(view.text(), /不产生托管验收回执/)
    assert.match(view.text(), /判断理由.*目标产物路径明确/)
    assert.match(view.text(), /业务操作.*6 次/)
    assert.match(view.text(), /未解决修改.*0 项/)
    assert.match(view.text(), /最近工具/)
    assert.doesNotMatch(view.text(), /当前没有托管子代理计划/)
    assert.doesNotMatch(view.text(), /执行方式待记录|尚未记录执行活动/)
    const card = view.nodes('section').find(node => node.props?.['data-acceptance-conclusion'])
    assert.equal(card.props['data-acceptance-conclusion'], 'direct')
    assert.equal(card.props['data-tone'], 'blue')
    const feed = view.nodes('details').find(node => node.props?.['data-acceptance-fold'] === 'feed')
    assert.equal(feed.props.open, true, 'direct execution expands collaboration activity by default')
  } finally { view.close(); f.close() }
})

test('a direct decision with no retained execution record says so instead of inventing counts', async () => {
  const request = { messageId: 'direct-noexec', text: '检查一段文字' }
  const session = { sessionId: 'session-current', source: request,
    decision: { mode: 'direct', reason: '直接处理', requestId: request.messageId, at: 100 } }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
    sessionId: 'session-current', plans: [], sessions: [session] }) }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    assert.match(view.text(), /本次执行记录未保留操作计数/)
    assert.match(view.text(), /不产生托管验收回执/)
  } finally { view.close(); f.close() }
})

test('in-progress conclusion uses returned counts, real task chips and a concrete next step', async () => {
  const request = { messageId: 'run-req', text: '生成四段成片与定稿图' }
  const plan = { sessionId: 'session-current', source: request, goal: '生成四段成片与定稿图', status: 'running', tasks: [
    { id: 'a', title: '生成四段成片', status: 'accepted', criteria: ['C1 可播放'],
      checks: [{ tool: 'ffprobe', result: { passed: true, callId: 'v1', at: 100, summary: '时长与编码通过' } }], outputs: ['exports/a.mp4'] },
    { id: 'b', title: '生成定稿图', status: 'review', criteria: ['C2 尺寸正确'], outputs: ['exports/b.png'] },
    { id: 'c', title: '拼接转场', status: 'running', criteria: ['C3 顺序一致'], outputs: ['exports/c/'] },
    { id: 'd', title: '交付说明', status: 'queued', dependsOn: ['a', 'b'], criteria: ['C4 说明完整'], outputs: [] }
  ] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
    sessionId: 'session-current', plans: [structuredClone(plan)], sessions: [{ sessionId: 'session-current', source: request }] }) }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    const card = view.nodes('section').find(node => node.props?.['data-acceptance-conclusion'])
    assert.equal(card.props['data-acceptance-conclusion'], 'running')
    assert.equal(card.props['data-tone'], 'blue')
    const cardText = flatten(card)
    assert.match(cardText, /已返回 2\/4/)
    assert.match(cardText, /任务 4 · 执行中 1 · 等待 1 · 待验收 1/)
    assert.match(cardText, /等待执行者返回报告/)
    assert.doesNotMatch(cardText, /%/)
    const chips = view.nodes('div').find(node => node.props?.['data-acc-chips'] === '')
    assert.equal(chips.children.length, 4)
    assert.match(flatten(chips), /生成四段成片 · 已验收/)
    assert.match(flatten(chips), /拼接转场 · 执行中/)
    assert.match(flatten(chips), /交付说明 · 等待前置/)
    const receipt = view.nodes('details').find(node => node.props?.['data-acceptance-fold'] === 'receipt')
    assert.match(flatten(receipt), /尚未生成/)
    assert.equal(view.button('复制结论'), undefined, 'copy is only offered for accepted receipts')
  } finally { view.close(); f.close() }
})

test('task cards are real accordions: first open, others collapsed, polling never resets them', async () => {
  const request = { messageId: 'accordion-req', text: '生成四段成片' }
  const plan = { sessionId: 'session-current', source: request, goal: '生成四段成片', status: 'running', tasks: [
    { id: 'a', title: '生成四段成片', status: 'accepted', criteria: ['C1 可播放'],
      checks: [{ tool: 'ffprobe', result: { passed: true, callId: 'v1', at: 100, summary: '通过' } }], outputs: ['exports/a.mp4'] },
    { id: 'b', title: '生成定稿图', status: 'review', criteria: ['C2 尺寸正确'], checks: [], outputs: [] },
    { id: 'c', title: '整理交付说明', status: 'queued', criteria: ['C3 路径完整'], checks: [], outputs: [] }
  ] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
    sessionId: 'session-current', plans: [structuredClone(plan)], sessions: [{ sessionId: 'session-current', source: request }] }) }) })
  const view = f.mountView('session-current')
  const cards = () => view.nodes('details').filter(node => node.props?.['data-acceptance-task'])
  try {
    await view.flush()
    assert.equal(cards().length, 3)
    assert.equal(cards()[0].props.open, true, 'only the first task accordion opens by default')
    assert.equal(cards()[1].props.open, undefined, 'other tasks are uncontrolled, so a user can open them')
    assert.equal(cards()[2].props.open, undefined)
    const heads = view.nodes('summary').filter(node => node.props?.className === 'ddf-acc-task-head')
    assert.equal(heads.length, 3)
    assert.ok(view.nodes('span').some(node => node.props?.className === 'ddf-acc-task-chev'), 'each summary has a chevron')
    assert.match(flatten(heads[0]), /生成四段成片.*已验收/)
    const firstBody = cards()[0].children.find(node => node?.props?.className === 'ddf-acc-task-body')
    assert.ok(firstBody)
    assert.match(flatten(firstBody), /验收标准.*实际验证.*结论/)
    assert.match(flatten(firstBody), /C1 可播放/)
    assert.match(flatten(firstBody), /✓ 通过/)
    assert.equal(view.nodes('table').filter(node => node.props?.className === 'ddf-acc-criteria').length, 3,
      'collapsed bodies still contain their criteria tables')
    // The duplicate "current request" hero lives in the decision fold, never
    // at the top of the task list.
    const foldBody = id => view.nodes('details').find(node => node.props?.['data-acceptance-fold'] === id)
      .children.find(node => node?.props?.className === 'ddf-acc-fold-body')
    const hasHero = body => body.children.flat(Infinity).some(node => node?.props?.className === 'ddf-board-hero')
    assert.equal(hasHero(foldBody('tasks')), false)
    assert.equal(hasHero(foldBody('decision')), true)
    // A 3-second poll re-renders the page; no card gains or loses a controlled open value.
    await view.tick()
    assert.equal(cards()[0].props.open, true)
    assert.equal(cards()[1].props.open, undefined)
    assert.equal(cards()[2].props.open, undefined)
  } finally { view.close(); f.close() }
})

test('completed conclusion shows receipt, deliverables, evidence and a three-column task table', async () => {
  const request = { messageId: 'done-req', text: '生成成片' }
  const task = { id: 'a', title: '生成四段成片', status: 'accepted', criteria: ['C1 可播放', 'C2 顺序一致'],
    checks: [{ tool: 'ffprobe', result: { passed: true, callId: 'v1', at: 100, summary: '时长与编码通过' } }],
    outputs: ['exports/成片.mp4'], review: { findings: [{ criterion: 0, finding: '符合标准', evidence: ['verification-2f1a'] }] } }
  const plan = { sessionId: 'session-current', source: request, goal: '生成成片', status: 'accepted', tasks: [task],
    completion: { id: 'd1f0c3', at: 1000, outcome: 'completed', accepted: 1, total: 1,
      deliverables: [{ taskId: 'a', title: '生成四段成片', paths: ['exports/成片.mp4'] }],
      evidence: ['verification-2f1a'], remaining: [] } }
  const copied = []
  const f = await sidebarFixture(undefined, { clipboard: async text => { copied.push(text) }, fetchState: async () => ({ ok: true,
    json: async () => ({ ok: true, sessionId: 'session-current', plans: [structuredClone(plan)],
      sessions: [{ sessionId: 'session-current', source: request }] }) }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    const card = view.nodes('section').find(node => node.props?.['data-acceptance-conclusion'])
    assert.equal(card.props['data-acceptance-conclusion'], 'completed')
    assert.equal(card.props['data-tone'], 'green')
    const cardText = flatten(card)
    assert.match(cardText, /已完成/)
    assert.match(cardText, /已验收 1\/1/)
    assert.match(cardText, /回执 #d1f0c3/)
    assert.match(cardText, /exports\/成片\.mp4/)
    assert.match(cardText, /verification-2f1a/)
    assert.doesNotMatch(cardText, /已返回 1\/1/)
    assert.deepEqual(view.nodes('th').map(flatten), ['验收标准', '实际验证', '结论'])
    const tasksFold = view.nodes('details').find(node => node.props?.['data-acceptance-fold'] === 'tasks')
    assert.equal(tasksFold.props.open, true, 'accepted work expands the task evidence fold')
    const button = view.nodes('button').find(node => node.props?.['data-copy-conclusion'] === '')
    assert.ok(button)
    await button.props.onClick(); await view.flush()
    assert.equal(copied.length, 1)
    const markdown = copied[0]
    assert.match(markdown, /## 已完成/)
    assert.match(markdown, /回执 #d1f0c3/)
    assert.match(markdown, /已验收 1\/1/)
    assert.match(markdown, /- `exports\/成片\.mp4`/)
    assert.match(markdown, /- ✓ verification-2f1a/)
    assert.match(markdown, /> 下一步：/)
  } finally { view.close(); f.close() }
})

test('partial conclusion lists unfinished work bound to task names from the receipt', async () => {
  const request = { messageId: 'partial-req', text: '生成成片与报告' }
  const plan = { sessionId: 'session-current', source: request, goal: '生成成片与报告', status: 'blocked', tasks: [
    { id: 'a', title: '生成四段成片', status: 'accepted', criteria: ['C1 可播放'], checks: [], outputs: ['exports/a.mp4'] },
    { id: 'c', title: '汇总报告', status: 'review', criteria: ['C5 覆盖四段'], checks: [], outputs: [] },
    { id: 'd', title: '交付说明', status: 'cancelled', criteria: ['C6 路径完整'], checks: [], outputs: [] }
  ], completion: { id: 'e7b2a0', at: 1000, outcome: 'partial', accepted: 1, total: 3,
    deliverables: [{ taskId: 'a', title: '生成四段成片', paths: ['exports/a.mp4'] }], evidence: ['v1'],
    remaining: [{ taskId: 'c', title: '汇总报告', status: 'review', reason: '主控尚未完成最终验收' },
      { taskId: 'd', title: '交付说明', status: 'cancelled', reason: '已取消' }] } }
  const copied = []
  const f = await sidebarFixture(undefined, { clipboard: async text => { copied.push(text) }, fetchState: async () => ({ ok: true,
    json: async () => ({ ok: true, sessionId: 'session-current', plans: [structuredClone(plan)],
      sessions: [{ sessionId: 'session-current', source: request }] }) }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    const card = view.nodes('section').find(node => node.props?.['data-acceptance-conclusion'])
    assert.equal(card.props['data-acceptance-conclusion'], 'partial')
    assert.equal(card.props['data-tone'], 'amber')
    const cardText = flatten(card)
    assert.match(cardText, /部分完成 · 已验收 1\/3/)
    assert.match(cardText, /回执 #e7b2a0/)
    assert.match(cardText, /未完成项/)
    assert.match(cardText, /汇总报告 · 主控尚未完成最终验收/)
    assert.match(cardText, /交付说明 · 已取消/)
    assert.match(cardText, /exports\/a\.mp4/)
    const button = view.nodes('button').find(node => node.props?.['data-copy-conclusion'] === '')
    assert.ok(button)
    await button.props.onClick(); await view.flush()
    assert.match(copied[0], /- 汇总报告 · 主控尚未完成最终验收/)
    assert.match(copied[0], /- 交付说明 · 已取消/)
  } finally { view.close(); f.close() }
})

test('the empty view shows only a no-request conclusion, with no statistics or feed', async () => {
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
    sessionId: 'session-current', plans: [], sessions: [] }) }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    assert.match(view.text(), /当前会话还没有需求记录/)
    assert.match(view.text(), /尚无需求记录/)
    assert.match(view.text(), /主控收到需求后/)
    assert.doesNotMatch(view.text(), /当前没有托管子代理计划|主控直接处理/)
    assert.equal(view.nodes('div').filter(node => node.props?.className === 'ddf-focus-stats').length, 0)
    assert.equal(view.nodes('section').filter(node => node.props?.['data-collaboration-feed'] === '').length, 0)
    assert.equal(view.nodes('textarea').length, 0)
    assert.equal(view.nodes('input').length, 0)
    assert.ok(view.button('回到聊天'))
    assert.equal(view.button('复制结论'), undefined)
  } finally { view.close(); f.close() }
})

test('the first screen is header → conclusion → four evidence folds → collaboration activity → footer', async () => {
  const request = { messageId: 'order-req', text: '整理交付' }
  const plan = { sessionId: 'session-current', source: request, goal: '整理交付', status: 'accepted',
    tasks: [{ id: 'a', title: '整理文件', status: 'accepted', criteria: ['C1 完整'], checks: [], outputs: [] }],
    completion: { id: 'order-receipt', at: 1000, outcome: 'completed', accepted: 1, total: 1,
      deliverables: [], evidence: [], remaining: [] } }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
    sessionId: 'session-current', plans: [structuredClone(plan)], sessions: [{ sessionId: 'session-current', source: request }] }) }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    const direct = view.nodes('main')[0].children.flat(Infinity).filter(node => node && typeof node === 'object')
    const header = direct.findIndex(node => node.props?.className === 'ddf-board-header')
    const body = direct.findIndex(node => node.props?.className === 'ddf-acc-body')
    assert.ok(header >= 0 && body > header, 'the whole page body follows the sticky header in one column')
    const column = direct[body].children.flat(Infinity).filter(node => node && typeof node === 'object')
    const conclusion = column.findIndex(node => typeof node.type === 'function' && node.props?.conclusion)
    const folds = column.findIndex(node => node.props?.className === 'ddf-focus-context')
    const feed = column.findIndex(node => node.props?.['data-acceptance-fold'] === 'feed')
    const foot = column.findIndex(node => node.props?.className === 'ddf-acc-footnote')
    assert.ok(conclusion >= 0 && folds > conclusion && feed > folds && foot > feed)
    const evidenceFolds = column[folds].children.flat(Infinity).filter(node => node?.props?.['data-acceptance-fold'])
    assert.deepEqual(evidenceFolds.map(node => node.props['data-acceptance-fold']), ['tasks', 'decision', 'receipt', 'diagnostics'])
    assert.equal(evidenceFolds[0].props.open, true)
    assert.ok(!column[feed].props.open, 'collaboration activity stays collapsed for completed work')
    assert.match(flatten(column[foot]), /完整过程：Fleet/)
    const styles = view.nodes('style').map(node => node.children.join('')).join('\n')
    assert.match(styles, /--ddf-acc-gutter:max\(24px,calc\(\(100% - 880px\)\/2\)\)/)
    assert.match(styles, /\.ddf-focus-board>\.ddf-acc-body \{[^}]*padding:14px var\(--ddf-acc-gutter\)/)
    assert.match(styles, /@container ddf-focus \(max-width:900px\) \{ \.ddf-focus-board \{ --ddf-acc-gutter:16px; \} \}/)
  } finally { view.close(); f.close() }
})

test('acceptance copy is synchronised for the English locale', async () => {
  const request = { messageId: 'en-req', text: 'Check the article' }
  const session = { sessionId: 'session-current', source: request,
    decision: { mode: 'direct', reason: 'Small scope, handle directly.', requestId: request.messageId, at: 100 },
    execution: { requestId: request.messageId, toolCalls: 2, running: false, unresolvedChanges: [] } }
  const f = await sidebarFixture(undefined, { language: 'en', fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
    sessionId: 'session-current', plans: [], sessions: [session] }) }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    assert.match(view.text(), /Coordinator executed directly/)
    assert.match(view.text(), /Completed directly by the coordinator/)
    assert.match(view.text(), /No managed plan was created/)
    assert.match(view.text(), /produces no managed acceptance receipt/)
    assert.match(view.text(), /Tasks and evidence/)
    assert.match(view.text(), /Coordinator decision and execution/)
    assert.match(view.text(), /Receipt details/)
    assert.match(view.text(), /Runtime diagnostics/)
    assert.match(view.text(), /Collaboration activity/)
    assert.doesNotMatch(view.text(), /主控直接完成|当前没有托管子代理计划|本次需求/)
  } finally { view.close(); f.close() }
})

test('copying a conclusion is a local clipboard write and never adds a network request', async () => {
  const request = { messageId: 'net-req', text: '交付' }
  const plan = { sessionId: 'session-current', source: request, goal: '交付', status: 'accepted', tasks: [],
    completion: { id: 'net-receipt', at: 1000, outcome: 'completed', accepted: 1, total: 1,
      deliverables: [], evidence: [], remaining: [] } }
  let stateCalls = 0
  const f = await sidebarFixture(undefined, { clipboard: async () => {}, fetchState: async () => { stateCalls++; return { ok: true,
    json: async () => ({ ok: true, sessionId: 'session-current', plans: [structuredClone(plan)],
      sessions: [{ sessionId: 'session-current', source: request }] }) } } })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    const before = stateCalls
    const button = view.nodes('button').find(node => node.props?.['data-copy-conclusion'] === '')
    await button.props.onClick(); await view.flush()
    assert.equal(stateCalls, before)
    assert.match(view.text(), /结论已复制/)
  } finally { view.close(); f.close() }
})

test('focused worker artifacts expose full output and report locations without opening technical details', async () => {
  const task = { id: 'a', title: '核对接口', status: 'review', outputs: ['reports/result.md', 'E:\\shared\\schema.json'],
    execution: { status: 'DONE', summary: '核对已返回', reportPath: 'C:\\archive\\reports\\a\\worker-1.md' },
    audit: { status: 'completed', execution: { summary: '审查已返回', reportPath: 'C:\\archive\\reports\\a\\review-1-1.md' } } }
  const plan = { sessionId: 'session-current', cwd: 'D:\\workspace\\project', status: 'review', tasks: [task] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
    sessionId: plan.sessionId, plans: [plan], sessions: [] }) }) })
  const view = f.mountView(plan.sessionId)
  const text = node => !node ? '' : typeof node !== 'object' ? String(node) : typeof node.type === 'function' ? text(node.type(node.props))
    : node.children.flat(Infinity).map(text).join(' ')
  try {
    await view.flush()
    view.nodes('button').find(node => node.props?.['data-member-filter'] === 'worker:a').props.onClick(); await view.flush()
    const artifacts = view.nodes('section').find(node => node.props?.['data-task-artifacts'] === 'a' && node.props['data-artifact-surface'] === 'member')
    assert.ok(artifacts, 'selecting a worker exposes its outputs outside technical disclosures')
    assert.match(text(artifacts), /D:\\workspace\\project\\reports\\result\.md/)
    assert.match(text(artifacts), /E:\\shared\\schema\.json/)
    assert.match(text(artifacts), /C:\\archive\\reports\\a\\worker-1\.md/)
    assert.match(text(artifacts), /已提交报告.*待验收/)
    assert.doesNotMatch(text(artifacts), /review-1-1\.md|已验收/)
  } finally { view.close(); f.close() }
})

test('task artifacts are visible beside submitted reports and keep reviewer files separate', async () => {
  const task = { id: 'a', title: '整理核查结果', status: 'accepted', outputs: ['reports/result.md'],
    execution: { status: 'DONE', summary: '执行结果已提交', at: 100, reportPath: '/archive/a/worker-1.md' },
    audit: { status: 'completed', execution: { summary: '独立审查已提交', at: 110, reportPath: '/archive/a/review-1-1.md' } } }
  const plan = { sessionId: 'session-current', cwd: '/workspace/project', status: 'accepted', tasks: [task] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
    sessionId: plan.sessionId, plans: [plan], sessions: [] }) }) })
  const view = f.mountView(plan.sessionId)
  const text = node => !node ? '' : typeof node !== 'object' ? String(node) : typeof node.type === 'function' ? text(node.type(node.props))
    : node.children.flat(Infinity).map(text).join(' ')
  const artifacts = surface => view.nodes('section').filter(node => node.props?.['data-task-artifacts'] === 'a' && node.props['data-artifact-surface'] === surface)
  try {
    await view.flush()
    assert.equal(artifacts('report').length, 2, 'worker and review reports expose their file locations inline')
    assert.ok(artifacts('task').some(node => node.props['data-artifact-role'] === 'worker'), 'the task detail lists outputs before technical diagnostics')
    view.nodes('button').find(node => node.props?.['data-member-filter'] === 'reviewer:a').props.onClick(); await view.flush()
    const review = artifacts('member')[0]
    assert.match(text(review), /独立审查报告.*\/archive\/a\/review-1-1\.md/)
    assert.match(text(review), /主控已验收/)
    assert.doesNotMatch(text(review), /reports\/result\.md|worker-1\.md/)
  } finally { view.close(); f.close() }
})

test('task artifact locations can be copied and missing directories never become invented absolute paths', async () => {
  const copied = [], task = { id: 'a', title: '交付核查文件', status: 'running', outputs: ['reports/result.md'] }
  const plan = { sessionId: 'session-current', cwd: '/workspace/project', status: 'running', tasks: [task] }
  const f = await sidebarFixture(undefined, { clipboard: async path => { copied.push(path) }, fetchState: async () => ({ ok: true,
    json: async () => ({ ok: true, sessionId: plan.sessionId, plans: [structuredClone(plan)], sessions: [] }) }) })
  const view = f.mountView(plan.sessionId)
  try {
    await view.flush()
    view.nodes('button').find(node => node.props?.['data-member-filter'] === 'worker:a').props.onClick(); await view.flush()
    const copy = view.nodes('button').find(node => node.props?.['data-artifact-copy'] === '/workspace/project/reports/result.md')
    assert.ok(copy)
    await copy.props.onClick(); await view.flush()
    assert.deepEqual(copied, ['/workspace/project/reports/result.md'])
    assert.match(view.text(), /已复制/)
    assert.match(view.text(), /计划交付，尚未提交报告/)
    delete plan.cwd
    await view.tick()
    assert.ok(view.nodes('button').some(node => node.props?.['data-artifact-copy'] === 'reports/result.md'))
    assert.match(view.text(), /未记录完整目录，保留原路径/)
  } finally { view.close(); f.close() }
})

test('chat child-task accordions expose worker and reviewer file locations without opening the acceptance page', async () => {
  const plan = { sessionId: 'session-current', cwd: 'D:/workspace/project', status: 'running', tasks: [{ id: 'a', title: '核查文件', status: 'review',
    outputs: ['reports/result.md'], execution: { summary: '报告已提交', reportPath: 'C:/archive/a/worker-1.md' },
    audit: { status: 'completed', execution: { summary: '复核已返回', reportPath: 'C:/archive/a/review-1-1.md' } } }] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
    sessionId: plan.sessionId, plans: [plan], sessions: [] }) }) })
  const dock = f.mountDock(plan.sessionId)
  try {
    await dock.flush()
    const artifacts = dock.nodes('section').filter(node => node.props?.['data-artifact-surface'] === 'chat')
    assert.equal(artifacts.length, 2)
    assert.match(dock.text(), /D:\/workspace\/project\/reports\/result\.md/)
    assert.match(dock.text(), /C:\/archive\/a\/worker-1\.md/)
    assert.match(dock.text(), /C:\/archive\/a\/review-1-1\.md/)
    assert.doesNotMatch(dock.text(), /主控已验收/)
  } finally { dock.close(); f.close() }
})

test('artifact copy failures remain readable and stopped tasks never imply accepted deliverables', async () => {
  const task = { id: 'a', title: '已停止任务', status: 'cancelled', outputs: ['result.md'], audit: { status: 'cancelled' } }
  const plan = { sessionId: 'session-current', status: 'cancelled', tasks: [task] }
  const f = await sidebarFixture(undefined, { clipboard: async () => { throw new Error('Clipboard permission denied') },
    fetchState: async () => ({ ok: true, json: async () => ({ ok: true, sessionId: plan.sessionId, plans: [plan], sessions: [] }) }) })
  const view = f.mountView(plan.sessionId)
  try {
    await view.flush()
    view.nodes('button').find(node => node.props?.['data-member-filter'] === 'worker:a').props.onClick(); await view.flush()
    await view.nodes('button').find(node => node.props?.['data-artifact-copy'] === 'result.md').props.onClick(); await view.flush()
    assert.match(view.text(), /复制失败，请选中路径手动复制/)
    assert.match(view.text(), /任务已停止，未验收/)
    assert.doesNotMatch(view.text(), /主控已验收/)
    view.nodes('button').find(node => node.props?.['data-member-filter'] === 'reviewer:a').props.onClick(); await view.flush()
    assert.match(view.text(), /尚未记录交付文件或报告路径/)
    assert.equal(view.nodes('section').find(node => node.props?.['data-artifact-surface'] === 'member').props['data-artifact-role'], 'reviewer')
  } finally { view.close(); f.close() }
})

test('focused feed initially shows the latest twenty records and reveals earlier records twenty at a time', async () => {
  const plan = { sessionId: 'session-current', protocolVersion: 2, source: { messageId: 'history-request', text: '核对所有验证结果' }, status: 'review',
    tasks: [{ id: 'a', title: '核对报告', status: 'review', checks: Array.from({ length: 54 }, (_, index) => ({ tool: 'read',
      result: { callId: 'check-' + index, at: 100 + index, passed: true, summary: '记录 ' + index } })) }] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
    sessionId: plan.sessionId, plans: [structuredClone(plan)], sessions: [] }) }) })
  const view = f.mountView(plan.sessionId)
  const entries = () => view.nodes('article').filter(node => node.props?.['data-feed-entry'])
  const more = () => view.nodes('button').find(node => node.props?.['data-load-earlier'] === '')
  try {
    await view.flush()
    assert.equal(entries().length, 20)
    assert.equal(entries()[0].props['data-feed-entry'], 'verify:a:check-34')
    assert.equal(entries().at(-1).props['data-feed-entry'], 'verify:a:check-53')
    assert.ok(more())
    more().props.onClick(); await view.flush()
    assert.equal(entries().length, 40)
    assert.equal(entries()[0].props['data-feed-entry'], 'verify:a:check-14')
    await view.tick()
    assert.equal(entries().length, 40, 'polling keeps the revealed range')
    more().props.onClick(); await view.flush()
    assert.equal(entries().length, 55)
    assert.equal(entries()[0].props['data-source'], 'request')
    assert.equal(more(), undefined, 'the current snapshot has no more records to reveal')
  } finally { view.close(); f.close() }
})

test('focused collaboration shows real records in a readonly member-filtered feed', async () => {
  const request = { messageId: 'focus-request', text: '核查两份文档并提交可验证的评审' }
  const plan = { sessionId: 'session-current', protocolVersion: 2, createdAt: 100, status: 'running', source: request,
    decision: { mode: 'delegate', reason: '两份文档可以独立核查，主控实际验证验收。', at: 110, model: { model: 'high-model' } },
    tasks: [{ id: 'a', title: '核查功能说明', status: 'running', attempts: 1,
      modelRoute: { actual: { provider: 'demo', model: 'worker-model' } },
      supervision: { startedAt: 120, activity: { kind: 'tool', tool: 'read', at: 150 },
        evidence: [{ callId: 'read-a', tool: 'read', at: 140, failed: false }] } },
    { id: 'b', title: '核查文章结构', status: 'review', attempts: 1,
      modelRoute: { actual: { provider: 'demo', model: 'worker-model' } },
      execution: { status: 'DONE', at: 160, summary: '结构报告已返回，建议将安装步骤前移。', reportPath: 'reports/b.md' } }] }
  const body = { ok: true, sessionId: plan.sessionId, plans: [plan], sessions: [{ sessionId: plan.sessionId, source: request }] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const view = f.mountView(plan.sessionId)
  const entries = () => view.nodes('article').filter(node => node.props?.['data-feed-entry'])
  try {
    await view.flush()
    assert.ok(view.nodes('section').some(node => node.props?.['data-collaboration-feed'] === ''), 'the current view is a collaboration feed')
    assert.equal(view.nodes('textarea').length, 0)
    assert.equal(view.nodes('input').length, 0)
    assert.ok(entries().some(node => node.props['data-source'] === 'tool' && node.props['data-member'] === 'worker:a'))
    assert.ok(entries().some(node => node.props['data-source'] === 'report' && node.props['data-member'] === 'worker:b'))
    assert.match(view.text(), /结构报告已返回/)
    const filter = view.nodes('button').find(node => node.props?.['data-member-filter'] === 'worker:a')
    assert.ok(filter)
    filter.props.onClick(); await view.flush()
    assert.ok(entries().length)
    assert.ok(entries().every(node => node.props['data-member'] === 'worker:a'))
    const keys = entries().map(node => node.props['data-feed-entry'])
    await view.tick()
    assert.deepEqual(entries().map(node => node.props['data-feed-entry']), keys, 'polling the same snapshot does not duplicate records')
    view.nodes('button').find(node => node.props?.['data-member-filter'] === 'all').props.onClick(); await view.flush()
    assert.ok(entries().some(node => node.props['data-source'] === 'report'))
    view.nodes('button').find(node => node.props?.['data-open-task'] === 'b').props.onClick(); await view.flush()
    assert.equal(view.nodes('aside').find(node => node.props?.['data-task-drawer'] === '').props['data-selected-task'], 'b')
  } finally { view.close(); f.close() }
})

test('focused history keeps revealed records on refresh and scopes each member range to the current request', async () => {
  const request = { messageId: 'history-current', text: '核对当前需求' }
  const task = { id: 'a', title: '核查结果', status: 'review', supervision: { evidence: Array.from({ length: 16 }, (_, index) => ({
    callId: 'read-' + index, tool: 'read', at: 1 + index, failed: false })) },
    checks: Array.from({ length: 45 }, (_, index) => ({ tool: 'read', result: { callId: 'check-' + index, at: 100 + index, passed: true } })) }
  const plan = { sessionId: 'session-current', protocolVersion: 2, source: request, createdAt: 1, status: 'review', tasks: [task] }
  const row = { sessionId: plan.sessionId, source: request }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone({ ok: true,
    sessionId: plan.sessionId, plans: [plan], sessions: [row] }) }) })
  const view = f.mountView(plan.sessionId)
  const entries = () => view.nodes('article').filter(node => node.props?.['data-feed-entry'])
  const more = () => view.nodes('button').find(node => node.props?.['data-load-earlier'] === '')
  const select = async member => { view.nodes('button').find(node => node.props?.['data-member-filter'] === member).props.onClick(); await view.flush() }
  try {
    await view.flush(); more().props.onClick(); await view.flush()
    assert.equal(entries().length, 40)
    assert.equal(entries()[0].props['data-feed-entry'], 'verify:a:check-5')
    task.checks.push({ tool: 'read', result: { callId: 'check-45', at: 145, passed: true } })
    await view.tick()
    assert.equal(entries()[0].props['data-feed-entry'], 'verify:a:check-5', 'a new result does not remove history the user has already revealed')
    assert.equal(entries().length, 41)
    await select('coordinator')
    assert.equal(entries().length, 20)
    more().props.onClick(); await view.flush()
    assert.equal(entries().length, 40)
    await select('worker:a')
    assert.equal(entries().length, 16)
    assert.equal(more(), undefined)
    await select('all')
    assert.equal(entries().length, 41, 'each member filter remembers its own revealed range')
    row.source = plan.source = { messageId: 'history-next', text: '下一项需求' }
    await view.tick()
    assert.equal(entries().length, 20, 'a new request starts with the recent records again')
  } finally { view.close(); f.close() }
})

test('revealing earlier focused records preserves the reading anchor and does not resume automatic following', async () => {
  const plan = { sessionId: 'session-current', protocolVersion: 2, status: 'review', tasks: [{ id: 'a', title: '核查历史记录', status: 'review',
    checks: Array.from({ length: 45 }, (_, index) => ({ tool: 'read', result: { callId: 'history-' + index, at: 100 + index, passed: true } })) }] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
    sessionId: plan.sessionId, plans: [plan], sessions: [] }) }) })
  const view = f.mountView(plan.sessionId)
  let anchorTop = 250
  const anchor = { isConnected: true, getBoundingClientRect: () => ({ top: anchorTop }) }
  const page = { scrollTop: 120, scrollHeight: 3000, clientHeight: 500, querySelector: () => anchor }
  try {
    await view.flush()
    view.nodes('main')[0].props.ref.current = page
    view.nodes('button').find(node => node.props?.['data-load-earlier'] === '').props.onClick()
    anchorTop = 2250; page.scrollHeight = 5000
    await view.flush()
    assert.equal(page.scrollTop, 2120, 'prepending older records keeps the previously visible record at the same screen position')
    assert.ok(view.nodes('button').some(node => node.props?.['data-follow-latest'] === ''))
    await view.tick()
    assert.equal(page.scrollTop, 2120, 'a refresh while reading older records cannot jump to the bottom')
    view.nodes('button').find(node => node.props?.['data-load-earlier'] === '').props.onClick()
    page.scrollTop = 2520; page.scrollHeight = 5400
    await view.flush()
    assert.equal(page.scrollTop, 2520, 'an anchor already preserved by the browser must not be moved back to the old scroll offset')
  } finally { view.close(); f.close() }
})

test('acceptance shows explicit review policy and reason separately from execution complexity', async () => {
  for (const policy of ['coordinator', 'independent']) {
    const task = { id: 'a', title: '核对产物', status: 'running', complexity: policy === 'coordinator' ? 'complex' : 'routine',
      reviewPolicy: policy, reviewReason: '根据错误风险选择本次审查方式', dependsOn: [], writes: [], outputs: [], criteria: [], checks: [],
      dispatcherModel: { provider: 'test', model: 'coordinator-model' } }
    const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true, sessions: [],
      plans: [{ sessionId: 'session-current', goal: '核对', status: 'running', tasks: [task] }] }) }) })
    const view = f.mountView('session-current')
    try {
      await view.flush()
      assert.match(view.text(), /审查依据.*根据错误风险选择本次审查方式/)
      assert.match(view.text(), policy === 'coordinator' ? /主控验证验收/ : /独立审查必须通过/)
      if (policy === 'coordinator') assert.doesNotMatch(view.text(), /复杂任务需独立审查/)
    } finally { view.close(); f.close() }
  }
})

test('acceptance distinguishes the current coordination policy from a host still running the previous policy', async () => {
  for (const version of [6, 7]) {
    const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
      sessionId: 'session-current', plans: [], sessions: [], coordinationPolicyVersion: version,
      executionPolicyVersion: version === 7 ? 1 : undefined, runtimeBuild: version === 7 ? 'abcdef123456' : undefined }) }) })
    const view = f.mountView('session-current')
    try {
      await view.flush()
      assert.match(view.text(), version === 7 ? /原生优先执行策略已生效（v7）/ : /协作执行策略等待加载/)
      if (version === 6) assert.doesNotMatch(view.text(), /原生优先执行策略已生效/)
      else assert.match(view.text(), /abcdef123456/)
    } finally { view.close(); f.close() }
  }
})

test('focused board keeps tasks in a closed drawer and restores current-request selection after polling', async () => {
  const request = { messageId: 'focus-current', text: '当前需求只读核查' }
  const plan = { sessionId: 'session-current', protocolVersion: 2, source: request, createdAt: 10, status: 'running',
    tasks: [{ id: 'a', title: '核查当前文件', status: 'running', attempts: 1, progress: { tool: 'read', at: 20 } },
      { id: 'b', title: '汇总核查', status: 'queued', dependsOn: ['a'] }] }
  const session = { sessionId: plan.sessionId, source: request }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true,
    json: async () => structuredClone({ ok: true, sessionId: plan.sessionId, plans: [plan], sessions: [session] }) }) })
  const view = f.mountView(plan.sessionId)
  const drawer = () => view.nodes('aside').find(node => node.props?.['data-task-drawer'] === '')
  try {
    await view.flush()
    assert.equal(drawer()?.props.hidden, true, 'the selected compact design does not start with a full task column')
    view.nodes('button').find(node => node.props?.['data-drawer-toggle'] === '').props.onClick(); await view.flush()
    assert.equal(drawer().props.hidden, false)
    assert.equal(drawer().props['data-selected-task'], null)
    assert.ok(view.nodes('button').some(node => node.props?.['data-drawer-toggle'] === ''),
      'the task drawer toggle stays reachable from the Tasks and evidence fold while the whole page scrolls')
    view.nodes('button').find(node => node.props?.['data-member-filter'] === 'worker:a').props.onClick(); await view.flush()
    await view.tick()
    assert.equal(drawer().props.hidden, false)
    assert.equal(view.nodes('button').find(node => node.props?.['data-member-filter'] === 'worker:a').props['aria-pressed'], true)
    session.source = { messageId: 'focus-new', text: '新的直接核查需求' }
    await view.tick()
    assert.equal(drawer().props.hidden, true)
    assert.equal(view.nodes('button').find(node => node.props?.['data-member-filter'] === 'all').props['aria-pressed'], true)
    assert.ok(!view.nodes('article').some(node => node.props?.['data-feed-entry'] && node.props['data-member'] === 'worker:a'))
  } finally { view.close(); f.close() }
})

test('focused feed labels accepted reports accurately and never assigns previous-request activity to a new request', async () => {
  const request = { messageId: 'request-current', text: '本轮需求' }
  const plan = { sessionId: 'session-current', protocolVersion: 2, status: 'accepted', source: request,
    tasks: [{ id: 'a', title: '已验收文件', status: 'accepted', attempts: 1,
      execution: { status: 'DONE', at: 120, summary: '交付报告', reportPath: 'reports/a.md' },
      audit: { status: 'completed', execution: { at: 130, summary: '独立审查无阻塞项' }, modelRoute: { actual: { provider: 'demo', model: 'high-reviewer' } } },
      checks: [{ tool: 'pwsh', result: { passed: true, callId: 'proof-1', at: 140, summary: '真实验证完成' } }],
      review: { at: 150, findings: [] } }] }
  const row = { sessionId: plan.sessionId, source: request }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true,
    json: async () => structuredClone({ ok: true, sessionId: plan.sessionId, plans: [plan], sessions: [row] }) }) })
  const view = f.mountView(plan.sessionId)
  const rendered = node => !node ? '' : typeof node !== 'object' ? String(node) : typeof node.type === 'function' ? rendered(node.type(node.props))
    : node.children.flat(Infinity).map(rendered).join(' ')
  const records = () => view.nodes('article').filter(node => node.props?.['data-feed-entry'])
  try {
    await view.flush()
    const report = records().find(node => node.props['data-source'] === 'report')
    assert.match(rendered(report), /已验收/)
    assert.doesNotMatch(rendered(report), /待主控验收|尚未验收/)
    assert.ok(records().some(node => node.props['data-member'] === 'reviewer:a' && node.props['data-source'] === 'auditReport'))
    assert.match(rendered(records().find(node => node.props['data-source'] === 'verification')), /验证通过.*真实验证完成/)
    row.source = { messageId: 'request-next', text: '全新需求' }
    row.decision = { requestId: 'request-current', mode: 'delegate', at: 110, reason: '上一轮决定，不应混入新需求动态' }
    row.execution = { requestId: 'request-current', running: true, activity: { kind: 'tool', tool: 'edit', at: 160 },
      lastResult: { tool: 'write', target: 'previous-result.md', at: 155 } }
    await view.tick()
    assert.ok(records().every(node => node.props['data-source'] === 'request'))
    assert.match(rendered(records()[0]), /全新需求/)
  } finally { view.close(); f.close() }
})

test('focused board excludes terminal review activity from counts and preserves issue-only records', async () => {
  const plan = { sessionId: 'session-current', protocolVersion: 2, status: 'blocked', tasks: [
    { id: 'accepted', title: '已验收任务', status: 'accepted', audit: { status: 'running', supervision: { activity: { kind: 'model_output', at: 120 } } } },
    { id: 'cancelled', title: '已取消任务', status: 'cancelled', audit: { status: 'queued' } },
    { id: 'blocked', title: '待补充资料', status: 'blocked', issue: { code: 'EXTERNAL_INPUT_REQUIRED', message: '需要补充接口文档' } },
  ] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
    sessionId: plan.sessionId, plans: [plan], sessions: [] }) }) })
  const view = f.mountView(plan.sessionId)
  const text = node => !node ? '' : typeof node !== 'object' ? String(node) : typeof node.type === 'function' ? text(node.type(node.props))
    : node.children.flat(Infinity).map(text).join(' ')
  try {
    await view.flush()
    const counts = view.nodes('div').find(node => node.props?.className === 'ddf-focus-stats')
    assert.doesNotMatch(text(counts), /执行中 [1-9]|等待 [1-9]/)
    const record = view.nodes('article').find(node => node.props?.['data-feed-entry'] && node.props['data-member'] === 'worker:blocked')
    assert.ok(record)
    assert.match(text(record), /需要补充接口文档/)
    assert.ok(!view.nodes('article').some(node => node.props?.['data-source'] === 'activity' && node.props['data-member'] === 'reviewer:accepted'))
  } finally { view.close(); f.close() }
})

test('focused board follows and preserves the whole page scroll position', async () => {
  const plan = { sessionId: 'session-current', protocolVersion: 2, status: 'running', tasks: [{ id: 'a', title: '核查文件', status: 'running' }] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
    sessionId: plan.sessionId, plans: [plan], sessions: [] }) }) })
  const view = f.mountView(plan.sessionId)
  try {
    await view.flush()
    const page = view.nodes('main')[0]
    assert.equal(typeof page.props.onScroll, 'function', 'the page owns reading and following, rather than an inner message pane')
    assert.ok(!view.nodes('div').some(node => node.props?.role === 'log' && node.props.onScroll))
    const position = { scrollTop: 100, scrollHeight: 1400, clientHeight: 400 }
    page.props.ref.current = position
    page.props.onScroll({ currentTarget: position }); await view.flush()
    const latest = view.nodes('button').find(node => node.props?.['data-follow-latest'] === '')
    assert.ok(latest)
    assert.ok(view.nodes('header')[0].children.flat(Infinity).some(node => node?.props?.className === 'ddf-board-actions'
      && node.children.flat(Infinity).some(child => child?.props?.['data-follow-latest'] === '')))
    await view.tick()
    assert.equal(position.scrollTop, 100, 'polling preserves a user reading earlier page content')
    latest.props.onClick(); await view.flush()
    assert.equal(position.scrollTop, position.scrollHeight)
  } finally { view.close(); f.close() }
})

test('managed chat shows actual task states and never claims completed delivery before a receipt exists', async () => {
  const plan = { protocolVersion: 2, sessionId: 'session-current', status: 'running', completion: null,
    tasks: [{ id: 'a', title: '生成独立工具', status: 'running' }],
    coordinationIssue: { code: 'COORDINATION_OPERATION_FAILED', tool: 'write', callId: 'denied-write', message: '主控写入被拒绝',
      nextAction: '等待原执行者提交正式报告，再验证验收。', at: 100 } }
  const body = { ok: true, enabled: true, coordinationPolicyVersion: 2, sessionId: 'session-current', plans: [plan], sessions: [] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const dock = f.mountDock('session-current'), action = f.mountAction('session-current')
  try {
    await dock.flush(); await action.flush()
    assert.match(dock.nodes('summary')[0].props['aria-label'], /1 项任务.*执行中 1.*验收 0\/1/)
    assert.match(action.text(), /进行中 1.*已验收 0\/1/)
    assert.doesNotMatch(action.text(), /已完成/)
    assert.match(dock.text(), /主控操作未执行.*主控写入被拒绝.*等待原执行者/)
    assert.equal(plan.tasks[0].error, undefined)
    plan.status = 'review'; plan.tasks[0].status = 'review'
    await dock.tick(); await action.flush()
    assert.match(dock.nodes('summary')[0].props['aria-label'], /1 项任务.*待验收 1.*验收 0\/1/)
    plan.status = 'accepted'; plan.tasks[0].status = 'accepted'; plan.coordinationIssue.resolvedAt = 200
    await dock.tick(); await action.flush()
    assert.match(dock.nodes('summary')[0].props['aria-label'], /1 项任务.*回执生成中.*验收 1\/1/)
    assert.doesNotMatch(action.text(), /已完成/)
    assert.doesNotMatch(dock.text(), /主控操作未执行/)
    plan.completion = { id: 'verified-receipt', outcome: 'completed', accepted: 1, total: 1, evidence: ['actual-proof'], deliverables: [], remaining: [] }
    await dock.tick(); await action.flush()
    assert.equal(dock.text(), '')
    assert.match(action.text(), /已完成/)
    assert.doesNotMatch(action.text(), /尚未完成/)
  } finally { dock.close(); action.close(); f.close() }
})

test('coordination notices show legacy repeated shell guidance once without removing distinct explanations', async () => {
  const guidance = '当前计划尚有未验收的写入任务，普通 pwsh/bash 暂不可用。读取源码允许使用 read/grep/glob；目录检查用 delegation_inspect。'
  const reason = '[DSH Agentrix] 本次普通 Shell 命令未执行。'
  const plan = { protocolVersion: 2, sessionId: 'session-current', status: 'running', completion: null,
    tasks: [{ id: 'a', title: '提取文档', status: 'running' }],
    coordinationIssue: { tool: 'pwsh', role: 'coordinator', callId: 'blocked-shell', message: reason + guidance, nextAction: guidance, at: 100 } }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
    enabled: true, sessionId: plan.sessionId, plans: [structuredClone(plan)], sessions: [] }) }) })
  const dock = f.mountDock(plan.sessionId)
  const notice = () => dock.nodes('section').find(node => node.props?.['data-kind'] === 'coordination')
  try {
    await dock.flush()
    assert.equal(flatten(notice()).split(guidance).length - 1, 1, 'the stored legacy guidance is shown only as the next action')
    assert.ok(flatten(notice()).includes('pwsh：' + reason), 'the actual blocked operation and reason remain visible')
    assert.ok(flatten(notice()).includes('下一步： ' + guidance))
    plan.coordinationIssue.message = '检查尚未执行；请核对工作目录。'
    plan.coordinationIssue.nextAction = '改用 delegation_inspect 检查目录。'
    await dock.tick()
    assert.ok(flatten(notice()).includes(plan.coordinationIssue.message))
    assert.ok(flatten(notice()).includes(plan.coordinationIssue.nextAction), 'a different next action is preserved')
    plan.coordinationIssue.message = guidance + '另外仍需核对工作目录。'
    plan.coordinationIssue.nextAction = guidance
    await dock.tick()
    assert.ok(flatten(notice()).includes(plan.coordinationIssue.message), 'overlapping text is not stripped from the middle of an explanation')
    plan.coordinationIssue.message = '检查失败，请核对工作目录。'
    plan.coordinationIssue.nextAction = '工作目录。'
    await dock.tick()
    assert.ok(flatten(notice()).includes(plan.coordinationIssue.message), 'a suffix inside a sentence is not a repeated guidance paragraph')
    plan.coordinationIssue.resolvedAt = 200
    await dock.tick()
    assert.equal(notice(), undefined)
  } finally { dock.close(); f.close() }
})

test('a previous terminal receipt never hides current coordinator work or stops its activity polling', async t => {
  for (const outcome of ['completed', 'cancelled', 'blocked']) await t.test(outcome, async () => {
    const request = { messageId: 'continued-request', text: '继续核对当前需求' }
    const plan = { sessionId: 'session-current', protocolVersion: 2, source: request, createdAt: 100,
      status: outcome === 'completed' ? 'accepted' : outcome, cancelled: outcome === 'cancelled',
      tasks: [{ id: 'old-task', title: '原任务', status: outcome === 'completed' ? 'accepted' : outcome }],
      completion: { id: 'old-receipt', at: 200, outcome, accepted: outcome === 'completed' ? 1 : 0,
        total: 1, deliverables: [], evidence: [], remaining: [] } }
    const originalPlan = JSON.stringify(plan)
    const row = { sessionId: plan.sessionId, source: request, execution: { running: true, startedAt: 300,
      toolCalls: 1, activity: { kind: 'model' }, model: { model: 'current/coordinator' }, unresolvedChanges: [] } }
    let fetches = 0
    const f = await sidebarFixture(undefined, { fetchState: async () => { fetches++; return { ok: true,
      json: async () => structuredClone({ ok: true, sessionId: plan.sessionId, plans: [plan], sessions: [row] }) } } })
    const dock = f.mountDock(plan.sessionId)
    const label = () => dock.nodes('summary')[0]?.props['aria-label'] ?? ''
    try {
      await dock.flush()
      assert.match(label(), /主控处理中.*模型正在生成.*current\/coordinator.*1/)
      assert.doesNotMatch(label(), /子任务执行中|已停止|已验收/)
      const firstFetches = fetches
      row.execution.toolCalls = 3
      row.execution.activity = { kind: 'tool', tool: 'read' }
      await dock.tick()
      assert.ok(fetches > firstFetches, 'a historical receipt must not stop polling the current turn')
      assert.match(label(), /主控处理中.*读取文件.*3/)
      row.execution.running = false
      row.execution.unresolvedChanges = [{ callId: 'current-edit-failed', tool: 'edit', target: 'demo.md', reason: '当前修改尚未成功' }]
      await dock.tick()
      assert.match(label(), /修改未完成/)
      assert.match(dock.text(), /当前修改尚未成功/)
      row.execution.unresolvedChanges = []
      await dock.tick()
      assert.equal(dock.text(), '', 'idle execution without unfinished changes can close normally')
      const endedFetches = fetches
      await dock.tick()
      assert.equal(fetches, endedFetches, 'polling stops after the current work actually ends')
      assert.equal(JSON.stringify(plan), originalPlan, 'displaying current activity does not alter the historical receipt')
    } finally { dock.close(); f.close() }
  })
})

test('coordinator activity after completed delegation keeps the old decision historical instead of claiming no worker started', async () => {
  const request = { messageId: 'same-development-request', text: '继续开发应用' }
  const decision = { mode: 'delegate', reason: '先由执行者提取 PRD，主控并行搭建应用。', at: 100, model: { model: 'coordinator' } }
  const plan = { sessionId: 'session-current', protocolVersion: 2, source: request, status: 'accepted', createdAt: 100,
    decision, tasks: [{ id: 'prd-extract', status: 'accepted', attempts: 1, childId: 'original-worker' }],
    completion: { id: 'prd-receipt', at: 200, outcome: 'completed', accepted: 1, total: 1, deliverables: [], evidence: [], remaining: [] } }
  const row = { sessionId: plan.sessionId, source: request, decision, decisionCurrent: true, messageResolution: { relation: 'continue' },
    turnStats: { direct: 3, delegated: 0, denied: 0 }, execution: { running: true, startedAt: 300, toolCalls: 4,
      activity: { kind: 'model' }, lastResult: { tool: 'write', target: 'app/src/tokens.css' }, unresolvedChanges: [] } }
  const before = JSON.stringify({ plan, row })
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone({ ok: true,
    sessionId: plan.sessionId, plans: [plan], sessions: [row] }) }) })
  const dock = f.mountDock(plan.sessionId)
  const section = name => dock.nodes('div').find(node => node.props?.['data-section'] === name)
  try {
    await dock.flush()
    assert.match(flatten(section('current')), /主控直接执行.*模型正在生成/)
    assert.match(flatten(section('decision')), /上次执行判断.*委派/)
    assert.ok(flatten(section('decision')).includes(decision.reason))
    assert.match(flatten(section('decision')), /上次委派已完成.*当前由主控直接处理.*执行判断尚未更新/)
    assert.doesNotMatch(dock.text(), /尚未启动子代理|主控准备中|主控决定：直接执行/)
    assert.equal(JSON.stringify({ plan, row }), before, 'observed direct work must not rewrite a recorded model decision or receipt')
    row.decision = { ...decision, reason: '下一阶段另有独立任务需要委派。', at: 400 }
    await dock.tick()
    assert.match(flatten(section('decision')), /主控决定.*委派/)
    assert.match(flatten(section('decision')), /尚未启动子代理/, 'a newly recorded delegation intention remains distinct from the previous completed plan')
    assert.doesNotMatch(flatten(section('decision')), /执行判断尚未更新/)
  } finally { dock.close(); f.close() }
})

test('an active managed worker stays visible when the current turn has no new dispatch', async () => {
  const request = { messageId: 'active-development-request', text: '继续核对文档' }
  const plan = { sessionId: 'session-current', protocolVersion: 2, source: request, status: 'running', completion: null,
    decision: { mode: 'delegate', reason: '原执行者继续提取文档。', at: 100 },
    tasks: [{ id: 'prd-extract', title: '提取文档', status: 'running', attempts: 1, childId: 'original-worker' }] }
  const row = { sessionId: plan.sessionId, source: request, decision: plan.decision, decisionCurrent: true,
    turnStats: { direct: 1, delegated: 0, denied: 0 }, execution: { running: true, startedAt: 200, toolCalls: 1,
      activity: { kind: 'tool', tool: 'read' }, unresolvedChanges: [] } }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone({ ok: true,
    sessionId: plan.sessionId, plans: [plan], sessions: [row] }) }) })
  const dock = f.mountDock(plan.sessionId)
  try {
    await dock.flush()
    assert.match(dock.nodes('summary')[0].props['aria-label'], /执行中 1/)
    assert.match(dock.text(), /提取文档/)
    assert.doesNotMatch(dock.text(), /尚未启动子代理|上次委派已完成/)
  } finally { dock.close(); f.close() }
})

test('coordinator overview groups observed activity, model and tool calls separately from its decision and request', async () => {
  const row = { sessionId: 'session-current', source: { messageId: 'request', text: '核对接口文档并准备调试工具' },
    decision: { mode: 'direct', reason: '先核对接口与现有代码，再确定实施范围。', model: { model: 'previous/coordinator' } },
    messageResolution: { relation: 'new' }, execution: { running: true, toolCalls: 7, model: { model: 'current/coordinator' },
      activity: { kind: 'tool', tool: 'grep', target: 'docs/interface.md' },
      lastResult: { tool: 'read', target: 'src/client.js', failed: false }, unresolvedChanges: [] } }
  const body = { ok: true, sessionId: row.sessionId, plans: [], sessions: [row] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const dock = f.mountDock(row.sessionId)
  try {
    await dock.flush()
    assert.deepEqual(dock.nodes('h3').map(node => node.children.join('')), ['当前执行', '执行判断', '本次需求'])
    const metrics = dock.nodes('dd'), metric = name => metrics.find(node => node.props['data-metric'] === name)
    assert.match(JSON.stringify(metric('activity')), /检索内容.*grep/)
    assert.match(JSON.stringify(metric('model')), /current\/coordinator/)
    assert.doesNotMatch(JSON.stringify(metric('model')), /previous\/coordinator/)
    assert.equal(metric('calls')?.children[0], 7)
    assert.match(dock.text(), /docs\/interface.md/)
    assert.match(dock.text(), /src\/client.js/)
    assert.ok(dock.text().includes(row.decision.reason))
    assert.ok(dock.text().includes(row.source.text))
    assert.doesNotMatch(dock.text(), /估算价值|缓存命中率|tok\/s|隐藏提示/)
    row.execution.toolCalls = 0
    delete row.execution.model
    await dock.tick()
    assert.equal(dock.nodes('dd').find(node => node.props['data-metric'] === 'calls')?.children[0], 0)
    assert.match(JSON.stringify(dock.nodes('dd').find(node => node.props['data-metric'] === 'model')), /未记录/)
    delete row.execution.toolCalls
    await dock.tick()
    assert.equal(dock.nodes('dd').find(node => node.props['data-metric'] === 'calls')?.children[0], '—')
  } finally { dock.close(); f.close() }
})

test('task totals and running counts stay distinct with a dependent task waiting for acceptance', async () => {
  const tasks = ['facts', 'structure', 'wording'].map(id => ({ id, title: id, status: 'running' }))
  tasks.push({ id: 'summary', title: '汇总评审', status: 'queued', dependsOn: ['facts', 'structure', 'wording'] })
  const plan = { sessionId: 'session-current', protocolVersion: 2, status: 'running', tasks }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true,
    json: async () => structuredClone({ ok: true, sessionId: plan.sessionId, plans: [plan], sessions: [] }) }) })
  const dock = f.mountDock(plan.sessionId), notice = f.mountNotice(plan.sessionId)
  const text = node => !node ? '' : typeof node !== 'object' ? String(node) : typeof node.type === 'function' ? text(node.type(node.props))
    : node.type === 'style' ? '' : node.children.flat(Infinity).map(text).join(' ')
  try {
    await dock.flush(); await notice.flush()
    assert.match(dock.nodes('summary')[0].props['aria-label'], /4 项任务.*执行中 3.*等待 1/)
    for (const surface of [dock, notice]) {
      const items = surface.nodes('details').filter(node => node.props?.['data-task-id'])
      assert.equal(items.length, 4)
      const waiting = items.find(node => node.props['data-task-id'] === 'summary')
      assert.match(text(waiting.children.find(node => node?.type === 'summary')), /等待前置任务/)
      assert.doesNotMatch(surface.text(), /尚未完成|3 个子任务执行中/)
      assert.equal(surface.nodes('p').filter(node => node.props?.role === 'status').length, 0, 'do not repeat the strip as a loose status paragraph')
    }
    tasks[0].status = 'accepted'
    await dock.tick()
    assert.match(dock.nodes('summary')[0].props['aria-label'], /4 项任务.*执行中 2.*等待 1.*验收 1\/4/)
  } finally { dock.close(); notice.close(); f.close() }
})

test('the collapsed strip shows real coordinator activity and switches to child queue and acceptance counts', async () => {
  const row = { sessionId: 'session-current', execution: { running: true, toolCalls: 12,
    model: { model: 'observed/coordinator' }, activity: { kind: 'tool', tool: 'grep' }, unresolvedChanges: [] } }
  const body = { ok: true, sessionId: row.sessionId, plans: [], sessions: [row] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const dock = f.mountDock(row.sessionId)
  try {
    await dock.flush()
    const label = () => dock.nodes('summary')[0].props['aria-label']
    assert.match(label(), /主控处理中.*检索内容.*observed\/coordinator.*12/)
    assert.doesNotMatch(label(), /tok\/s|132%|181%/)
    row.execution.toolCalls = 0
    delete row.execution.model
    await dock.tick()
    assert.match(label(), /本轮工具调用 0 次/)
    assert.doesNotMatch(label(), /observed\/coordinator|undefined/)
    body.plans = [{ sessionId: row.sessionId, protocolVersion: 2, status: 'running', tasks: [
      { id: 'a', status: 'running' }, { id: 'b', status: 'running' }, { id: 'c', status: 'queued' }, { id: 'd', status: 'accepted' },
    ] }]
    await dock.tick()
    assert.match(label(), /4 项任务.*执行中 2.*等待 1.*验收 1\/4/)
    assert.doesNotMatch(label(), /observed\/coordinator|本轮工具调用/)
  } finally { dock.close(); f.close() }
})

test('input progress defaults to one short summary and keeps raw diagnostics inside a closed disclosure', async () => {
  const target = 'D:/demo/articles/agentrix-multi-agent-blog.md'
  const execution = { running: true, startedAt: 100, toolCalls: 2, activity: { kind: 'waiting_model_response' },
    lastResult: { tool: 'read', target }, unresolvedChanges: [{ callId: 'edit-failed', target, reason: 'Error: old_string was not found in ' + target }] }
  const body = { ok: true, sessionId: 'session-current', plans: [], sessions: [{ sessionId: 'session-current',
    source: { messageId: 'request-one', text: '这句话有问题，换一个合适的说法' }, execution }] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const dock = f.mountDock('session-current')
  try {
    await dock.flush()
    const details = dock.nodes('details')[0], summary = dock.nodes('summary')[0]
    assert.ok(details, 'progress must be collapsible')
    assert.notEqual(details.props.open, true)
    assert.match(JSON.stringify(summary), /正在处理异常/)
    assert.doesNotMatch(JSON.stringify(summary), /old_string|D:\/demo|agentrix-multi-agent-blog|这句话|修改未完成/)
    assert.match(dock.text(), /old_string was not found/)
    assert.ok(!dock.nodes('section').some(node => node.props.role === 'alert'), 'a running repair is not a terminal error')
    execution.running = false
    await dock.tick()
    assert.match(JSON.stringify(dock.nodes('summary')[0]), /修改未完成/)
  } finally { dock.close(); f.close() }
})

test('composer labels stay short and distinguish coordinator work from actual child execution', async () => {
  const row = { sessionId: 'session-current', source: { messageId: 'request-one', text: '调整文章案例' },
    execution: { running: true, startedAt: 100, toolCalls: 2, activity: { kind: 'waiting_model_response' }, unresolvedChanges: [] } }
  const body = { ok: true, sessionId: 'session-current', plans: [], sessions: [row] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const dock = f.mountDock('session-current')
  try {
    await dock.flush()
    assert.match(JSON.stringify(dock.nodes('summary')[0]), /主控处理中/)
    assert.doesNotMatch(JSON.stringify(dock.nodes('summary')[0]), /主控直接执行|详情.*隐藏/)
    assert.match(JSON.stringify(dock.nodes('summary')[0]), /等待模型响应/)
    assert.ok(!dock.nodes('button').some(node => /隐藏/.test(node.props['aria-label'] ?? '')))
    body.plans = [{ sessionId: 'session-current', source: row.source, status: 'running', tasks: [
      { id: 'a', status: 'running' }, { id: 'b', status: 'running' }, { id: 'c', status: 'queued' },
    ] }]
    await dock.tick()
    assert.match(dock.nodes('summary')[0].props['aria-label'], /3 项任务.*执行中 2.*等待 1/)
    assert.doesNotMatch(JSON.stringify(dock.nodes('summary')[0]), /主控处理中|已验收|协作进度/)
  } finally { dock.close(); f.close() }
})

test('progress stays available across polling and new work without a hide action, with the full request and reason', async () => {
  const execution = { running: false, startedAt: 100, activity: {}, toolCalls: 1,
    unresolvedChanges: [{ callId: 'failed-one', target: 'article.md', reason: 'old_string was not found' }] }
  const request = '核对文档中的接口约定、参数来源与异常处理。'.repeat(10) + '最后生成交付说明。'
  const reason = '需要先阅读接口文档并核对代码调用，再确定实现范围。'.repeat(8)
  const row = { sessionId: 'session-current', source: { messageId: 'request-one', text: request }, execution,
    decision: { mode: 'direct', reason } }
  const body = { ok: true, sessionId: 'session-current', plans: [], sessions: [row] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const dock = f.mountDock('session-current')
  try {
    await dock.flush()
    assert.ok(dock.text().includes(request), 'the expanded details must retain the entire request')
    assert.ok(dock.text().includes(reason), 'the decision reason must remain complete')
    const paragraphs = dock.nodes('p'), reasonIndex = paragraphs.findIndex(node => JSON.stringify(node.children).includes(reason))
    assert.ok(reasonIndex >= 0 && reasonIndex < paragraphs.findIndex(node => node.props.className === 'ddf-source'), 'current work and reasoning should precede the full request')
    assert.doesNotMatch(dock.text(), /隐藏提示/)
    const sizes = new Map()
    dock.nodes('div').find(node => node.props.className === 'ddf-chat-dock').props.ref.current = {
      closest: () => ({ getBoundingClientRect: () => ({ top: 180 }) }),
      getBoundingClientRect: () => ({ top: 600 }),
      style: { setProperty: (key, value) => sizes.set(key, value) },
    }
    dock.nodes('details')[0].props.onToggle()
    assert.equal(sizes.get('--ddf-dock-available-height'), '404px', 'the panel must fit below the chat clipping boundary')
    const key = dock.nodes('details')[0].props.key
    await dock.tick()
    assert.equal(dock.nodes('details')[0].props.key, key, 'polling should preserve the disclosure identity')
    execution.unresolvedChanges.push({ callId: 'failed-two', target: 'other.md', reason: 'cannot write' })
    await dock.tick()
    assert.match(dock.text(), /cannot write/)
    execution.startedAt = 200; execution.running = true; execution.unresolvedChanges = []
    row.source = { messageId: 'request-two', text: '核对另一份材料' }
    execution.activity = { kind: 'tool', tool: 'grep' }
    await dock.tick()
    assert.match(JSON.stringify(dock.nodes('summary')[0]), /主控处理中/)
    assert.match(dock.text(), /核对另一份材料/)
    assert.match(dock.text(), /检索内容/)
    assert.doesNotMatch(dock.text(), /cannot write|隐藏提示/)
  } finally { dock.close(); f.close() }
})

test('the dock shows formal decision reasons and does not treat assistant prose or delegation intent as a started worker', async () => {
  const row = { sessionId: 'session-current', source: { messageId: 'request', text: '核对分享文档' },
    route: { route: 'delegate', reasons: [] }, decision: null, execution: { running: true, toolCalls: 1,
      activity: { kind: 'tool', tool: 'read' }, statement: '我已经修改完成。', unresolvedChanges: [] } }
  const body = { ok: true, sessionId: 'session-current', enabled: true, plans: [], sessions: [row] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const dock = f.mountDock('session-current')
  try {
    await dock.flush()
    assert.match(dock.text(), /等待主控记录执行方式和理由/)
    assert.doesNotMatch(dock.text(), /我已经修改完成|尚未说明/)
    row.decision = { mode: 'delegate', reason: '需要逐份核对文档，交给执行模型后由主控验证。', model: { model: 'high' }, at: Date.now() }
    row.decisionCurrent = true
    await dock.tick()
    assert.match(dock.text(), /主控决定.*委派/)
    assert.ok(dock.text().includes(row.decision.reason))
    assert.match(dock.text(), /已决定委派，尚未启动子代理/)
    assert.doesNotMatch(dock.text(), /子任务执行中/)
    row.decisionCurrent = false
    await dock.tick()
    assert.match(dock.text(), /需求已补充.*更新判断/)
  } finally { dock.close(); f.close() }
})

test('unclassified messages are visible without claiming a scope change or generating rule scores', async () => {
  const row = { sessionId: 'session-current', requestBindingVersion: 2, source: { messageId: 'original', text: '修复原任务' },
    decision: { mode: 'direct', reason: '原任务只有一处修改。' }, decisionCurrent: false,
    messageResolution: { relation: 'new' }, pendingMessages: [{ messageId: 'pending', text: '另外开一个新任务' }],
    execution: { running: true, toolCalls: 1, activity: { kind: 'tool', tool: 'read' } } }
  const body = { ok: true, enabled: true, sessionId: 'session-current', requestBindingVersion: 2, plans: [], sessions: [row] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const dock = f.mountDock('session-current'), view = f.mountView('session-current')
  try {
    await dock.flush(); await view.flush()
    assert.match(dock.text(), /待主控确认消息关联.*另外开一个新任务/)
    assert.doesNotMatch(dock.text(), /需求已补充/)
    assert.doesNotMatch(view.text(), /置信度|评分 0|预计.*步/)
    row.pendingMessages = []; row.messageResolution = { relation: 'question' }; row.decisionCurrent = true
    await dock.tick(); await view.tick()
    assert.match(dock.text(), /询问进度或普通提问.*沿用原需求/)
    assert.doesNotMatch(dock.text(), /待主控确认消息关联|需求已补充/)
  } finally { dock.close(); view.close(); f.close() }
})

test('direct work is visible in the input dock with actual activity, advisory mismatch and unresolved edits', async () => {
  const execution = { running: true, startedAt: Date.now(), toolCalls: 2, statement: null,
    activity: { kind: 'tool', tool: 'edit', target: 'article.md' },
    lastResult: { tool: 'read', target: 'article.md', at: Date.now(), failed: false }, unresolvedChanges: [] }
  const body = { ok: true, sessionId: 'session-current', enabled: true, plans: [], sessions: [{ sessionId: 'session-current',
    source: { messageId: 'direct-request', text: '改写文章并生成分享文档' }, route: { route: 'delegate', reasons: [] }, execution,
    decision: { mode: 'direct', reason: '文档修改范围明确，主控直接调整并核对内容。', at: Date.now(), model: { model: 'high' } }, decisionCurrent: true,
    delegationAvailability: { status: 'available', missingTools: [] } }] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const dock = f.mountDock('session-current')
  try {
    await dock.flush()
    assert.match(dock.text(), /改写文章并生成分享文档/)
    assert.match(dock.text(), /主控直接执行/)
    assert.match(dock.text(), /当前.*修改文件.*article\.md/)
    assert.match(dock.text(), /建议.*委派.*尚未启动子代理/)
    assert.match(dock.text(), /判断理由.*文档修改范围明确/)
    execution.unresolvedChanges = [{ callId: 'failed-edit', tool: 'edit', target: 'article.md', reason: 'old_string was not found' }]
    execution.statement = 'Markdown 和 Word 已全部修改完成。'
    execution.running = false
    await dock.tick()
    assert.match(dock.text(), /修改未完成.*article\.md.*old_string/)
    assert.doesNotMatch(dock.text(), /已完成|已验收/)
    execution.unresolvedChanges = []
    await dock.tick()
    assert.equal(dock.text(), '', 'ordinary ended direct work needs no persistent completion card')
  } finally { dock.close(); f.close() }
})

test('missing delegation tools and a missing backend show actionable warnings instead of an empty dock', async () => {
  const body = { ok: true, sessionId: 'session-current', enabled: true, plans: [], sessions: [{ sessionId: 'session-current',
    source: { text: '生成文档' }, delegationAvailability: { status: 'unavailable', missingTools: ['delegation_plan', 'delegation_run'] } }] }
  let missingBackend = false
  const f = await sidebarFixture(undefined, { fetchState: async () => missingBackend
    ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, json: async () => structuredClone(body) } })
  const dock = f.mountDock('session-current')
  try {
    await dock.flush()
    assert.match(dock.text(), /委派入口不可用.*delegation_plan/)
    assert.match(dock.text(), /插件.*启用/)
    missingBackend = true
    await dock.tick()
    assert.match(dock.text(), /插件服务不可用/)
    assert.doesNotMatch(dock.text(), /等待子代理|协作中/)
    missingBackend = false; body.sessions[0].delegationAvailability.status = 'available'
    await dock.tick()
    assert.equal(dock.text(), '')
  } finally { dock.close(); f.close() }
})

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
    assert.match(JSON.stringify(main), /主控判断未记录.*独立审查/)
    assert.match(JSON.stringify(main), /当前 1 个子 Agent 在执行/)
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

test('cancellation cleanup failures stay visible in chat and acceptance without claiming resources were released', async () => {
  const cleanup = { status: 'failed', remaining: [{ taskId: 'a', role: 'reviewer', childId: 'old-review', error: 'drain failed' }] }
  const plan = { protocolVersion: 2, sessionId: 'session-current', goal: '核对报告', status: 'cancelled', cancelled: true,
    cancellation: { reason: '用户取消', cleanup }, tasks: [{ id: 'a', title: '报告', status: 'cancelled', criteria: [], checks: [], outputs: [] }],
    completion: { id: 'cleanup-receipt', outcome: 'cancelled', accepted: 0, total: 1, evidence: [], deliverables: [], cleanup,
      remaining: [{ taskId: 'a', title: '报告', status: 'cancelled', reason: '用户取消' }] } }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
    sessionId: 'session-current', plans: [structuredClone(plan)], sessions: [] }) }) })
  const notice = f.mountNotice('session-current'), view = f.mountView('session-current')
  try {
    await notice.flush(); await view.flush()
    for (const text of [notice.text(), view.text()]) {
      assert.match(text, /取消已请求，资源清理未完成/)
      assert.match(text, /drain failed/)
      assert.doesNotMatch(text, /计划已停止。如需继续|资源已释放/)
    }
    plan.completion = null
    await view.tick(); await notice.tick()
    assert.match(view.text(), /资源清理未完成/)
    assert.match(notice.text(), /资源清理未完成/)
  } finally { notice.close(); view.close(); f.close() }
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
  let catalogState = initialCatalog, dictionaries, sequence = 0, selectedPanel, hookRunner, moduleApi
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
    navigator: options.clipboard ? { clipboard: { writeText: options.clipboard } } : {},
    __ModuleLoader__: { load: ({ factory }) => { moduleApi = factory(() => React); moduleApi.apply(ctx) } },
    setInterval(fn) { const id = ++sequence; timers.set(id, fn); return id },
    clearInterval(id) { timers.delete(id) },
    setTimeout(fn) { const id = ++sequence; timeouts.set(id, fn); return id },
    clearTimeout(id) { timeouts.delete(id) },
  }
  vm.runInNewContext(source, { window, AbortSignal, AbortController,
    fetch: async (url, request) => {
      if (url.includes('/api/delivery')) return options.fetchDelivery ? options.fetchDelivery(url) : { ok: true, json: async () => ({ ok: true, delivery: null }) }
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
    // The pure state function is the single source for the P0 view; expose it
    // so the state table can be asserted directly as well as through the DOM.
    acceptanceViewOf: (state, sessionId) => moduleApi.acceptanceViewOf(state, sessionId),
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
    assert.match(view.text(), /当前会话还没有需求记录/)
    assert.doesNotMatch(view.text(), /当前没有托管子代理计划/)
    assert.match(view.text(), /重新加载.*DSH Agentrix/)
    assert.doesNotMatch(view.text(), /读取失败|其他会话的私有需求|其他会话的档案提示/)
    assert.equal(view.nodes('section').filter(node => node.props?.['data-collaboration-feed'] === '').length, 0, 'an empty view shows no empty feed')
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
    const stopped = notice.nodes('section').find(node => node.props?.['data-kind'] === 'stopped')
    assert.ok(stopped)
    assert.equal(stopped.props.role, 'status')
    assert.equal(action.nodes('section').length, 0)
  } finally { action.close(); notice.close(); f.close() }
})

test('chat groups mixed task states into independent accordions with readable task, status and model headers', async () => {
  const request = { messageId: 'accordion-request', text: '核对隔离示例文章' }
  const route = { requested: { provider: 'demo', model: 'requested-worker' }, actual: { provider: 'demo', model: 'observed-worker' } }
  const tasks = ['核对事实', '检查用词', '整理意见'].map((title, index) => ({ id: 'worker-' + index, title, status: 'running', modelRoute: route }))
  tasks.push({ id: 'refused', title: '评审结构', status: 'blocked', modelRoute: route,
    issue: { code: 'MODEL_SERVICE_REQUEST_REFUSED', message: '本次请求被服务商拒绝', action: '处理后明确重试该任务。' } })
  const body = { ok: true, sessionId: 'session-current', plans: [{ sessionId: 'session-current', protocolVersion: 2,
    source: request, createdAt: 100, status: 'running', tasks }], sessions: [{ sessionId: 'session-current', source: request }] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const dock = f.mountDock('session-current'), notice = f.mountNotice('session-current')
  const text = node => !node ? '' : typeof node !== 'object' ? String(node) : typeof node.type === 'function' ? text(node.type(node.props))
    : node.children.flat(Infinity).map(text).join(' ')
  try {
    await dock.flush(); await notice.flush()
    for (const surface of [dock, notice]) {
      const items = surface.nodes('details').filter(node => node.props?.['data-task-id'])
      assert.equal(items.length, 4, 'all tasks, including the refused request, have their own disclosure')
      for (const [index, item] of items.entries()) {
        const header = item.children.find(node => node?.type === 'summary')
        assert.ok(header, 'the task identity is readable without expanding its body')
        assert.match(text(header), new RegExp(tasks[index].title))
        assert.match(text(header), index === 3 ? /请求被拒/ : /执行中|进行中/)
        assert.match(text(header), /observed-worker/)
        assert.doesNotMatch(text(header), /requested-worker/)
        assert.equal(item.props.open, index === 0, 'only the first task opens by default')
        assert.equal(item.props.name, undefined, 'native accordions must allow multiple open tasks')
      }
    }
  } finally { dock.close(); notice.close(); f.close() }
})

test('task accordion identity survives polling, coordinator turns and execution to review transitions', async () => {
  const request = { messageId: 'accordion-stable', text: '核对原需求' }
  const task = { id: 'original-task', title: '原任务', status: 'running', model: { provider: 'demo', model: 'worker' } }
  const plan = { sessionId: 'session-current', protocolVersion: 2, source: request, createdAt: 100, status: 'running', tasks: [task] }
  const row = { sessionId: plan.sessionId, source: request, execution: { running: true, startedAt: 200, unresolvedChanges: [] } }
  const body = { ok: true, sessionId: plan.sessionId, plans: [plan], sessions: [row] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const dock = f.mountDock(plan.sessionId)
  const disclosure = () => dock.nodes('details').find(node => node.props?.className === 'ddf-dock-disclosure')
  const item = () => dock.nodes('details').find(node => node.props?.['data-task-id'] === task.id)
  try {
    await dock.flush()
    const parentKey = disclosure().props.key, taskKey = item().props.key, defaultOpen = item().props.open
    await dock.tick()
    assert.equal(disclosure().props.key, parentKey)
    assert.equal(item().props.key, taskKey)
    row.execution.startedAt = 300
    row.execution.unresolvedChanges = [{ callId: 'coordinator-denial', reason: '主控重复写入被拒绝' }]
    plan.status = 'review'; task.status = 'review'
    task.audit = { status: 'running', model: { provider: 'demo', model: 'reviewer' } }
    await dock.tick()
    assert.equal(disclosure().props.key, parentKey, 'a new coordinator turn and plan phase do not remount the dock')
    assert.equal(item().props.key, taskKey, 'the reviewer continues inside the existing task disclosure')
    assert.equal(item().props.open, defaultOpen, 'polling does not introduce a different controlled-open value')
    assert.equal(item().props.name, undefined)
    task.audit.status = 'completed'
    await dock.tick()
    assert.equal(disclosure().props.key, parentKey)
    assert.equal(item().props.key, taskKey)
    const nextRequest = { messageId: 'accordion-next', text: '核对下一项需求' }
    plan.source = nextRequest; plan.createdAt = 400; row.source = nextRequest
    await dock.tick()
    assert.notEqual(disclosure().props.key, parentKey, 'a different request or plan starts a new disclosure identity')
  } finally { dock.close(); f.close() }
})

test('one task accordion groups worker and independent review while its header follows the active role', async () => {
  const request = { messageId: 'accordion-review', text: '核查执行与审查' }
  const task = { id: 'reviewed-task', title: '核对改写建议', status: 'review',
    modelRoute: { actual: { provider: 'demo', model: 'actual-worker' } },
    execution: { status: 'DONE', summary: '执行报告已返回，尚待独立审查与主控验收。' },
    audit: { status: 'running', modelRoute: { requested: { provider: 'demo', model: 'requested-reviewer' },
      actual: { provider: 'demo', model: 'actual-reviewer' } },
      supervision: { startedAt: Date.now() - 60000, lastActivityAt: Date.now(), activity: { kind: 'tool', tool: 'read' } } } }
  const plan = { sessionId: 'session-current', protocolVersion: 2, source: request, createdAt: 100, status: 'running', tasks: [task] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
    sessionId: plan.sessionId, plans: [structuredClone(plan)], sessions: [{ sessionId: plan.sessionId, source: request }] }) }) })
  const dock = f.mountDock(plan.sessionId)
  const text = node => !node ? '' : typeof node !== 'object' ? String(node) : typeof node.type === 'function' ? text(node.type(node.props))
    : node.children.flat(Infinity).map(text).join(' ')
  const item = () => dock.nodes('details').find(node => node.props?.['data-task-id'] === task.id)
  const header = () => item().children.find(node => node?.type === 'summary')
  try {
    await dock.flush()
    assert.equal(dock.nodes('details').filter(node => node.props?.['data-task-id']).length, 1)
    assert.match(text(header()), /核对改写建议.*独立审查.*actual-reviewer.*审查中/)
    assert.doesNotMatch(text(header()), /requested-reviewer|actual-worker|已验收/)
    assert.match(text(item()), /执行者.*actual-worker/)
    assert.match(text(item()), /独立审查.*actual-reviewer/)
    assert.match(text(item()), /当前.*读取文件/)
    assert.match(text(item()), /执行报告已返回，尚待独立审查与主控验收/)
    task.audit.status = 'completed'; task.audit.specVerdict = 'pass'; task.audit.qualityVerdict = 'pass'
    await dock.tick()
    assert.match(text(header()), /actual-worker.*待.*验收/)
    assert.doesNotMatch(text(header()), /已验收/)
    task.status = 'accepted'; plan.status = 'accepted'
    await dock.tick()
    assert.match(text(header()), /已验收/)
    plan.completion = { id: 'accordion-receipt', outcome: 'completed', accepted: 1, total: 1, deliverables: [], evidence: [], remaining: [] }
    await dock.tick()
    assert.equal(dock.text(), '', 'the final receipt owns completed delivery instead of duplicating the accordion dock')
  } finally { dock.close(); f.close() }
})

test('task accordion headers keep accepted and cancelled results ahead of stale review activity or errors', async () => {
  const request = { messageId: 'accordion-terminal', text: '显示实际验收与取消结果' }
  const plan = { sessionId: 'session-current', protocolVersion: 2, source: request, status: 'cancelled', cancelled: true,
    tasks: [{ id: 'accepted', title: '已验收任务', status: 'accepted', model: { provider: 'demo', model: 'worker' },
      audit: { status: 'running', model: { provider: 'demo', model: 'stale-reviewer' } } },
    { id: 'cancelled', title: '用户取消任务', status: 'cancelled', model: { provider: 'demo', model: 'worker' },
      stop: { reason: '用户取消剩余工作。' }, audit: { status: 'failed', model: { provider: 'demo', model: 'stale-reviewer' },
        issue: { code: 'MODEL_SERVICE_REQUEST_REFUSED', message: '审查请求曾被拒绝' } } }] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
    sessionId: plan.sessionId, plans: [structuredClone(plan)], sessions: [{ sessionId: plan.sessionId, source: request }] }) }) })
  const dock = f.mountDock(plan.sessionId)
  const text = node => !node ? '' : typeof node !== 'object' ? String(node) : node.type === 'style' ? ''
    : typeof node.type === 'function' ? text(node.type(node.props)) : node.children.flat(Infinity).map(text).join(' ')
  try {
    await dock.flush()
    const tasks = dock.nodes('details').filter(node => node.props?.['data-task-id'])
    assert.equal(tasks.length, 2)
    const header = taskId => text(tasks.find(node => node.props['data-task-id'] === taskId).children.find(node => node?.type === 'summary'))
    assert.match(header('accepted'), /执行者.*worker.*已验收/)
    assert.doesNotMatch(header('accepted'), /审查中|stale-reviewer/)
    assert.match(header('cancelled'), /执行者.*worker.*已停止/)
    assert.doesNotMatch(header('cancelled'), /请求被拒|审查失败|stale-reviewer/)
    assert.match(text(tasks.find(node => node.props['data-task-id'] === 'cancelled')), /用户取消剩余工作/)
    assert.doesNotMatch(text(tasks.find(node => node.props['data-task-id'] === 'accepted')), /原因：/)
  } finally { dock.close(); f.close() }
})

test('mixed failures keep all running task activity visible in the dock and chat notice', async () => {
  const now = Date.now(), request = { messageId: 'mixed-request', text: '核对隔离示例文档' }
  const plan = { sessionId: 'session-current', protocolVersion: 2, source: request, status: 'running', tasks: [
    ...['核对事实', '检查用词', '汇总意见'].map((title, index) => ({ id: 'running-' + index, title, status: 'running',
      supervision: { startedAt: now - 180000, lastActivityAt: now - 1000, activity: { kind: 'tool', tool: 'grep' } },
      progress: { tool: 'read', at: now - 2000 } })),
    { id: 'failed', title: '评审结构', status: 'failed', error: 'HTTP 500: isolated provider error' },
  ] }
  const body = { ok: true, sessionId: plan.sessionId, plans: [plan], sessions: [{ sessionId: plan.sessionId, source: request }] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => structuredClone(body) }) })
  const dock = f.mountDock(plan.sessionId), notice = f.mountNotice(plan.sessionId)
  try {
    await dock.flush(); await notice.flush()
    for (const surface of [dock, notice]) {
      for (const title of ['核对事实', '检查用词', '汇总意见', '评审结构']) assert.ok(surface.text().includes(title), title)
      assert.match(surface.text(), /当前.*检索内容/)
      assert.match(surface.text(), /最近完成的工具.*读取文件/)
      assert.match(surface.text(), /最近活动/)
      assert.match(surface.text(), /HTTP 500: isolated provider error/)
      assert.match(surface.text(), /已验收 0\/4/)
      assert.doesNotMatch(surface.text(), /已完成 0\/4/)
    }
    assert.match(dock.nodes('summary')[0].props['aria-label'], /4 项任务.*执行中 3.*失败 1.*验收 0\/4/)
  } finally { dock.close(); notice.close(); f.close() }
})

test('request refusals use a short explanation and keep raw errors in details for new and legacy tasks', async t => {
  const raw = 'WorkBuddy: Illegal API invocation from an unapproved channel — https://example.invalid/REFUSED.md — request refused'
  const renderedText = (node, includeDetails = false) => !node ? '' : typeof node !== 'object' ? String(node)
    : node.type === 'style' || node.type === 'details' && !includeDetails ? ''
      : typeof node.type === 'function' ? renderedText(node.type(node.props), includeDetails)
        : node.children.flat(Infinity).map(child => renderedText(child, includeDetails)).join(' ')
  for (const structured of [false, true]) await t.test(structured ? 'structured issue' : 'legacy error', async () => {
    const request = { messageId: 'refusal-request', text: '核对隔离文档' }
    const task = { id: 'refused', title: '结构核查', status: structured ? 'blocked' : 'failed', error: raw, criteria: [], checks: [],
      ...(structured ? { issue: { code: 'MODEL_SERVICE_REQUEST_REFUSED', message: '执行者模型服务拒绝本次请求',
        details: raw, action: '核对服务商支持的调用方式，处理后明确重试该任务。' } } : {}) }
    const plan = { sessionId: 'session-current', protocolVersion: 2, source: request, status: 'running', tasks: [task,
      { id: 'active', title: '事实核查', status: 'running', criteria: [], checks: [] }] }
    const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => ({ ok: true,
      sessionId: plan.sessionId, plans: [structuredClone(plan)], sessions: [{ sessionId: plan.sessionId, source: request }] }) }) })
    const dock = f.mountDock(plan.sessionId), view = f.mountView(plan.sessionId)
    try {
      await dock.flush(); await view.flush()
      const alert = dock.nodes('section').find(node => node.props?.role === 'alert')
      const card = view.nodes('article').find(node => node.props?.['data-task-id'] === task.id)
      for (const node of [alert, card]) {
        assert.ok(node)
        const main = renderedText(node)
        assert.match(main, /本次请求.*拒绝|拒绝本次请求/)
        assert.doesNotMatch(main, /Illegal API invocation|example\.invalid|模型不可用|模型配置已失效|决定重试或停止/)
      }
      for (const surface of [dock, view]) {
        const technical = surface.nodes('details').find(node => node.props?.className === 'ddf-service-error-details')
        assert.ok(technical, 'raw service errors remain available in collapsed details')
        assert.match(renderedText(technical, true), /Illegal API invocation from an unapproved channel/)
        assert.equal(technical.props.open, undefined)
      }
      assert.match(dock.nodes('summary')[0].props['aria-label'], /请求被拒 1.*验收 0\/2/)
      assert.match(dock.text(), /事实核查/)
      assert.doesNotMatch(dock.text(), /已完成 0\/2/)
    } finally { dock.close(); view.close(); f.close() }
  })
})

test('failure details identify the source failure while another child is still running', async () => {
  const body = { ok: true, sessionId: 'session-current', plans: [{ sessionId: 'session-current', status: 'running', tasks: [
    { id: 'waiting', title: '下游汇总', status: 'blocked', error: '等待失败任务处理后继续' },
    { id: 'failed', title: '技术栈核查', status: 'failed', error: 'HTTP 401: provider authentication failed\n at provider.request' },
    { id: 'running', title: '仍在审查', status: 'running' },
  ] }], sessions: [] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => body }) })
  const notice = f.mountDock('session-current')
  const text = node => !node ? '' : typeof node !== 'object' ? String(node) : node.type === 'style' ? '' : typeof node.type === 'function' ? text(node.type(node.props))
    : node.children.flat(Infinity).map(text).join(' ')
  const nodes = (node, type) => !node || typeof node !== 'object' ? [] : typeof node.type === 'function' ? nodes(node.type(node.props), type)
    : [...(node.type === type ? [node] : []), ...node.children.flat(Infinity).flatMap(child => nodes(child, type))]
  try {
    await notice.flush()
    const tasks = notice.nodes('details').filter(node => node.props?.['data-task-id'])
    const source = tasks.find(node => node.props['data-task-id'] === 'failed')
    assert.ok(source)
    assert.match(text(source), /技术栈核查/)
    assert.match(text(source), /HTTP 401: provider authentication failed/)
    assert.match(text(source), /下一步.*核对失败原因/)
    assert.doesNotMatch(text(source), /等待失败任务处理后继续/)
    assert.match(text(tasks.find(node => node.props['data-task-id'] === 'waiting')), /等待失败任务处理后继续/)
    assert.match(text(tasks.find(node => node.props['data-task-id'] === 'running')), /仍在审查/)
    const failure = nodes(source, 'section').find(node => node.props?.role === 'alert')
    assert.equal(failure?.props['data-kind'], 'failed')
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
        assert.match(notice.text(), /1 项任务/)
        assert.ok(notice.nodes('div').some(node => node.props?.['aria-label'] === '协作进度'))
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
    assert.match(view.text(), /当前会话还没有需求记录/)
    assert.doesNotMatch(view.text(), /当前没有托管子代理计划/)
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
    assert.ok(sections.findIndex(node => node.props.className === 'ddf-board-load-issue') < sections.findIndex(node => node.props.className === 'ddf-acc-body'),
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
    decision: { mode: 'delegate', reason: '规范和实现可以分工处理，主控统一验证接口和交付结果。' }, decisionCurrent: true,
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
    assert.ok(decisionIndex >= 0, 'the full judgment remains available in the request context')
    assert.ok(decisionIndex < sections.findIndex(node => node?.props?.['data-task-list'] === ''), 'judgment must precede task cards')
    const main = view.nodes('div').find(node => node.props?.className === 'ddf-board-decision-main')
    assert.match(JSON.stringify(main), /主控已确认.*复杂.*独立审查/)
    assert.match(JSON.stringify(main), /主控决定.*委派.*规范和实现可以分工处理/)
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
    assert.match(view.text(), /尚无需求记录/)
    assert.match(view.text(), /当前会话还没有需求记录/)
    assert.doesNotMatch(view.text(), /当前没有托管子代理计划/)
    assert.doesNotMatch(view.text(), /已安排子代理/)
    assert.equal(view.nodes('div').filter(node => node.props?.className === 'ddf-focus-stats').length, 0, 'an empty view shows no empty statistics')
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
    assert.equal(view.nodes('details').filter(node => node.props?.open && !node.props?.['data-acceptance-fold'] && !node.props?.['data-acceptance-task']).length, 0, 'technical details start collapsed')
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
        criteria: ['返回字段完整'], checks: [{ tool: 'test', arguments: { command: 'node --test' }, result: { passed: true, callId: 'check-123', summary: '字段验证通过', truncated: true, outputPath: 'verification/check-123.txt' } }],
        review: { findings: [{ criterion: 0, finding: '符合标准', evidence: ['check-123'] }] }, release: { status: 'released' },
        execution: { status: 'DONE_WITH_CONCERNS', summary: '完成字段检查', reportPath: 'reports/api.md', concerns: ['实际数据库尚未验证'] },
        audit: { status: 'completed', specVerdict: 'pass', qualityVerdict: 'pass', report: '独立审查完整报告' }, report: '子任务完整报告' }] }] }) }) })
  const view = f.mountView('session-current')
  try {
    await view.flush()
    assert.equal(view.nodes('details').filter(node => node.props?.open && !node.props?.['data-acceptance-fold'] && !node.props?.['data-acceptance-task']).length, 0,
      'page folds and the first task accordion may start open, but technical task details stay collapsed')
    view.button('任务详情').props.onClick()
    await view.flush()
    for (const value of ['原始需求完整内容', 'message-source', '返回字段完整', 'node --test', 'check-123', '字段验证通过', '符合标准',
      'provider-a / worker-requested', 'provider-b / worker-actual', 'child-session', 'src/api.js', 'base', 'reports/api.md', '独立审查完整报告', '子任务完整报告', '子 Agent 已关闭', '实际数据库尚未验证', 'verification/check-123.txt', '验证摘要已截断']) {
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
      lastProgress: { summary: '已修改声明的交付文件，内容尚待验证：article.md' },
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
    assert.match(view.text(), /最近工具证据.*article\.md/)
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
test('final delivery shows accepted content and clickable files outside tool and reasoning disclosures', async () => {
  const delivery = { version: 1, sessionId: 'session-current', anchorSeq: 7, receiptId: 'delivery-receipt', messageId: 'delivery-message', status: 'delivered',
    outcome: 'completed', accepted: 2, total: 2, summary: '文章和改动说明已完成。', remaining: [],
    files: [{ label: '文章.md', path: 'D:/fixture/文章.md' }], documents: [{ label: '文章.md', path: 'D:/fixture/文章.md', content: '# 交付文章\n\n这是直接展示的完整正文。' }] }
  const body = { ok: true, deliveryProtocolVersion: 1, plans: [{ sessionId: 'session-current', status: 'accepted', delivery }], sessions: [] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => body }),
    fetchDelivery: async () => ({ ok: true, json: async () => ({ ok: true, delivery }) }) })
  const notice = f.mountNotice('session-current', 7), opened = []
  try {
    notice.update({ openFile: file => opened.push(file) }); await notice.flush()
    assert.match(notice.text(), /文章和改动说明已完成/)
    assert.match(notice.text(), /直接展示的完整正文/)
    assert.match(notice.text(), /2.*2/)
    assert.equal(notice.nodes('details').length, 0, 'delivery content is readable without expanding a tool card')
    const file = notice.nodes('button').find(node => node.props['data-delivery-file'])
    assert.ok(file)
    file.props.onClick()
    assert.deepEqual(opened, ['D:/fixture/文章.md'])
  } finally { notice.close(); f.close() }
})

test('historical final delivery stays on its own reply when another request becomes current', async () => {
  const delivery = { version: 1, sessionId: 'session-current', anchorSeq: 10, receiptId: 'old-delivery', status: 'delivered',
    outcome: 'completed', accepted: 1, total: 1, summary: '上一项文章已交付。', remaining: [], files: [], documents: [{ label: '原文章', content: '原任务的完整正文。' }] }
  const body = { ok: true, plans: [], sessions: [{ sessionId: 'session-current', source: { messageId: 'new-request', text: '新的独立任务' } }] }
  const f = await sidebarFixture(undefined, { fetchState: async () => ({ ok: true, json: async () => body }),
    fetchDelivery: async url => ({ ok: true, json: async () => ({ ok: true, delivery: new URL(url, 'http://localhost').searchParams.get('seq') === '10' ? delivery : null }) }) })
  const useChat = selector => selector({ legacy: { nodes: [{ kind: 'assistant', seq: 10 }, { kind: 'assistant', seq: 20 }] } })
  const old = f.mountNotice('session-current', 10, useChat), current = f.mountNotice('session-current', 20, useChat)
  try {
    await old.flush(); await current.flush()
    assert.match(old.text(), /原任务的完整正文/)
    assert.doesNotMatch(current.text(), /原任务的完整正文|上一项文章/)
  } finally { old.close(); current.close(); f.close() }
})

test('failed final delivery retains visible results and distinguishes sending failure from task failure', async () => {
  const delivery = { version: 1, sessionId: 'session-current', anchorSeq: 8, receiptId: 'failed-delivery', status: 'failed', error: '消息记录暂时不可写',
    outcome: 'completed', accepted: 1, total: 1, summary: '工作已经验收。', remaining: [], files: [{ label: '结果.md', path: 'D:/fixture/结果.md' }], documents: [] }
  const f = await sidebarFixture(undefined, { fetchDelivery: async () => ({ ok: true, json: async () => ({ ok: true, delivery }) }) })
  const notice = f.mountNotice('session-current', 8)
  try {
    await notice.flush()
    assert.match(notice.text(), /工作已经验收/)
    assert.match(notice.text(), /交付.*失败|发送.*失败/)
    assert.match(notice.text(), /结果.md/)
    assert.doesNotMatch(notice.text(), /任务失败|(?:请|需要|必须)重新执行子任务/)
  } finally { notice.close(); f.close() }
})
