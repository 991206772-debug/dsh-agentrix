// Isolated UI fixture. No DSH connection, model request, or user profile writes.
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { DEFAULT_OPTIONS, OPTION_RANGES, COORDINATION_POLICY_VERSION } from '../orchestrator.js'
import { buildCompletion } from '../completion.js'
const assetDirectory = process.argv[2]
if (!assetDirectory) throw new Error('Provide a directory containing react.js and react-dom.js')
const invalid = process.argv.includes('--invalid')
const loadError = process.argv.includes('--load-error')
const nextRequest = process.argv.includes('--next-request')
const directProgress = process.argv.includes('--direct-progress')
const coordinationConflict = process.argv.includes('--coordination-conflict')
const mixedRefusal = process.argv.includes('--mixed-refusal')
const accordion = process.argv.includes('--accordion')
const waitingDependencies = process.argv.includes('--waiting-dependencies')
const liveProgress = process.argv.includes('--live-progress') || directProgress || coordinationConflict || mixedRefusal || accordion || waitingDependencies
let config = { ok: true, modelRouting: 'roles', reviewerModelPolicy: 'dispatcher-snapshot', mode: 'auto', threshold: 2, ...DEFAULT_OPTIONS, locked: false,
  models: { worker: { provider: invalid ? 'retired-demo' : 'demo', model: 'routine-model' }, reviewer: null }, file: 'C:/isolated-test/delegation-first/default.json',
  defaults: { mode: 'auto', threshold: 2, ...DEFAULT_OPTIONS }, ranges: { threshold: { min: 0, max: 20 }, ...OPTION_RANGES },
  revision: 'preview-1', updatedAt: Date.now(), source: { kind: 'file', profile: 'default', environmentValue: null } }
let configRevision = 1
if (process.argv.includes('--fidelity')) {
  config.models = { worker: null, reviewer: null }
  config.file = 'C:\\Users\\Demo\\.dsh\\delegation-first\\default.json'
}
if (process.argv.includes('--locked')) Object.assign(config, { locked: true, mode: 'strict', source: { kind: 'env', profile: 'default', environmentValue: 'strict' } })
const catalog = { groups: [{ id: 'demo', name: '已配置的测试服务', models: [
  { id: 'routine-model', name: '执行模型（测试）' },
  { id: 'design-model', name: '审查模型（测试）', reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }] } },
] }], failures: [] }
if (process.argv.includes('--catalog-empty')) catalog.groups = []
const baseTask = { instructions: '检查指定文件', scope: '只改指定文件', outputs: ['src/result.js'], writes: ['src/result.js'], dependsOn: [], complexity: 'routine', complexityReason: '沿用现有测试结构补充确定的场景',
  modelRoute: { role: 'worker', source: 'configured', requested: { provider: 'demo', model: 'routine-model' }, resolved: { provider: 'demo', model: 'routine-model' }, actual: { provider: 'demo', model: 'routine-model' } },
  criteria: ['输出文件符合要求', '测试执行通过'], attempts: 1, model: { provider: 'demo', model: 'routine-model', source: 'observed' }, childId: 'isolated-child',
  checks: [{ tool: 'pwsh', arguments: { command: 'node --test', description: 'Run verification' },
    result: { passed: true, callId: 'isolated-check-1', summary: 'Tests: 4, passed: 4', exitCode: 0 } }], report: '已交付 src/result.js，测试通过。' }
const accepted = { ...baseTask, id: 'a', title: '修复登录失败提示', status: 'accepted',
  review: { findings: [{ criterion: 0, finding: '主 Agent 已核对输出文件', evidence: ['isolated-check-1'] }] } }
const plans = [{ sessionId: 'session-demo-login', sessionTitle: '登录失败问题修复', cwd: 'D:\\projects\\login-demo',
  source: { messageId: 'request-login', text: '修复登录失败提示，并补充账号锁定场景测试' }, goal: '修复提示并验证', status: 'review',
  routing: { route: 'delegate_parallel', reasons: ['medium_complexity', 'multiple_goals', 'parallel_candidates'], estimatedSteps: 5, parallelTasks: 2, confidence: 0.75 },
  activationBudget: { limit: 8, used: 2, remaining: 6 },
  createdAt: Date.now(), updatedAt: Date.now(), tasks: [accepted,
    { ...baseTask, id: 'b', title: '补充账号锁定测试', status: 'review', dependsOn: ['a'] },
  ] }, {
  sessionId: 'session-demo-research', sessionTitle: '接口调研总结', cwd: 'D:\\projects\\research-demo',
  source: { messageId: 'request-research', text: '整理接口调研结论并导出' }, goal: '接口调研总结', status: 'accepted',
  tasks: [{ ...accepted, title: '核对调研结论' }],
}]
if (nextRequest) {
  Object.assign(plans[0], { protocolVersion: 2, status: 'accepted', goal: '交付可视化调试工作台',
    source: { messageId: 'request-old', text: '开发便于交付人员操作的调试页面' }, tasks: [accepted] })
  plans[0].completion = buildCompletion(plans[0])
}
if (liveProgress) {
  const now = Date.now()
  Object.assign(plans[0], { protocolVersion: 2, status: 'running', sessionTitle: '接口调试工具实现', goal: '调整双接口并自动生成参数',
    source: { messageId: 'live-request', text: '工作台保留两个接口，参数自动生成，固定参数改为配置项' },
    decision: { mode: 'delegate', reason: '参数生成与固定配置可以独立执行，交给执行模型实现，主控核对接口约定并验证验收。', model: { model: 'demo/coordinator' }, at: now },
    decisionCurrent: true, messageResolution: { relation: 'new' },
    tasks: [{ ...baseTask, id: 'parameters', title: '实现双接口、自动参数与固定配置', status: 'running', report: '',
      complexityReason: '按已明确的接口参数规范实现配置与参数生成，完成后由主控验证',
      progress: { tool: 'read', at: now - 4000 }, supervision: { startedAt: now - 13 * 60000, lastActivityAt: now,
        activity: { kind: 'tool', tool: 'edit', at: now } } }],
  })
}
if (mixedRefusal || waitingDependencies) {
  const now = Date.now(), raw = 'WorkBuddy: Illegal API invocation from an unapproved channel (isolated preview)'
  Object.assign(plans[0], { sessionTitle: '文档评审流程演示', goal: '核对示例文章的事实、结构与用词',
    source: { messageId: 'mixed-request', text: '核对隔离示例文档，给出事实、结构与用词建议' },
    decision: { mode: 'delegate', reason: '分别核查文档事实、结构与用词，主控负责最后验收。', model: { model: 'demo/coordinator' }, at: now },
    tasks: [...['核对文档事实', '检查文章用词', '整理评审意见'].map((title, index) => ({ ...baseTask,
      id: 'active-' + index, title, status: 'running', report: '', checks: [],
      progress: { tool: 'read', at: now - 4000 }, supervision: { startedAt: now - 180000, lastActivityAt: now - 1000,
        activity: { kind: 'tool', tool: 'grep', at: now - 1000 } } })),
    { ...baseTask, id: 'refused', title: '检查文章结构', status: 'blocked', report: '', checks: [], error: raw,
      issue: { code: 'MODEL_SERVICE_REQUEST_REFUSED', message: '执行者模型的本次请求被服务商拒绝', details: raw,
        action: '核对服务商支持的调用方式与限制，处理后明确重试该任务。' } }],
  })
  if (waitingDependencies) plans[0].tasks[3] = { ...baseTask, id: 'summary', title: '汇总发布前评审', status: 'queued',
    dependsOn: ['active-0', 'active-1', 'active-2'], scope: '前三项验收后，汇总事实、结构与用词意见。', report: '', checks: [],
    modelRoute: { role: 'worker', source: 'configured', requested: { provider: 'demo', model: 'routine-model' }, resolved: null, actual: null } }
}
if (accordion) {
  const now = Date.now(), raw = 'WorkBuddy: Illegal API invocation from an unapproved channel (isolated preview)'
  const running = { startedAt: now - 180000, lastActivityAt: now - 1000, activity: { kind: 'tool', tool: 'grep', at: now - 1000 } }
  Object.assign(plans[0], { sessionTitle: '文章评审手风琴演示', goal: '核对文章事实、改写建议与发布意见',
    source: { messageId: 'accordion-request', text: '核对示例文章的事实、结构、改写建议和发布意见' },
    decision: { mode: 'delegate', reason: '按评审范围分工，执行与审查分别进行，主控负责实际验证和最终验收。', model: { model: 'demo/coordinator' }, at: now },
    tasks: [{ ...baseTask, id: 'facts', title: '核对文章事实', status: 'running', report: '', checks: [],
      scope: '对照公开功能说明核查文章事实与遗漏。', progress: { tool: 'read', at: now - 4000 }, supervision: running },
    { ...baseTask, id: 'rewrite', title: '复核改写建议', status: 'review', report: '', checks: [], complexity: 'complex',
      execution: { status: 'DONE', summary: '执行者已提交改写建议，等待独立审查和主控验收。' },
      dispatcherModel: { provider: 'demo', model: 'design-model', reasoningEffort: 'high', source: 'dispatch', attempt: 1 },
      audit: { status: 'running', modelRoute: { role: 'reviewer', source: 'dispatcher', requested: { provider: 'demo', model: 'design-model' }, actual: { provider: 'demo', model: 'design-model' } },
        progress: { tool: 'read', at: now - 3000 }, supervision: { ...running, activity: { kind: 'model', at: now - 1000 } } } },
    { ...baseTask, id: 'structure', title: '核查章节结构', status: 'blocked', report: '', checks: [], error: raw,
      issue: { code: 'MODEL_SERVICE_REQUEST_REFUSED', message: '执行者模型的本次请求被服务商拒绝', details: raw,
        action: '核对服务商支持的调用方式与限制，处理后明确重试该任务。' } },
    { ...baseTask, id: 'publication', title: '确认发布意见', status: 'review',
      execution: { status: 'DONE', summary: '发布意见已返回，读取检查已有结果，尚未由主控逐条验收。' } }],
  })
}
if (coordinationConflict) {
  plans[0].goal = '生成独立接口调试页面'
  plans[0].source.text = '交付可直接打开的接口调试页面，并核对真实文件和运行结果'
  plans[0].tasks[0].title = '生成调试页面并验证接口参数'
  plans[0].coordinationIssue = { code: 'COORDINATION_TOOL_CONFLICT', tool: 'team_task_update', callId: 'isolated-conflict', role: 'coordinator',
    message: '不能通过团队看板将托管任务标为完成；尚未收到执行者正式报告。',
    nextAction: '原执行者继续工作；收到报告通知后，主控验证真实文件并逐项验收。', at: Date.now() }
}
const directSession = { sessionId: plans[0].sessionId, source: { messageId: 'direct-demo', text: '调整分享文章的案例，并核对生成的文档' },
  execution: { running: !process.argv.includes('--direct-ended'), startedAt: Date.now(), toolCalls: 2,
    model: { model: 'demo/coordinator' }, activity: { kind: 'waiting_model_response' },
    lastResult: { tool: 'read', target: 'D:/demo/articles/agentrix-article.md', at: Date.now() },
    unresolvedChanges: [{ callId: 'demo-edit-failed', target: 'D:/demo/articles/agentrix-article.md',
      reason: 'Error: old_string was not found in D:/demo/articles/agentrix-article.md' }] } }
if (process.argv.includes('--direct-healthy')) directSession.execution.unresolvedChanges = []
if (process.argv.includes('--decision-direct') || process.argv.includes('--decision-delegate')) {
  const mode = process.argv.includes('--decision-delegate') ? 'delegate' : 'direct'
  directSession.route = { route: 'delegate', reasons: ['multiple_goals'] }
  directSession.decision = { mode, reason: mode === 'direct' ? '已定位两处相邻文字，主控直接修改并读取核对，避免重复传递上下文。' : '需要逐份核对多份文档，交给执行模型处理，主控保留独立上下文验证验收。',
    requestId: 'direct-demo', revisionId: 'direct-demo', model: { model: 'demo/coordinator' }, at: Date.now() }
  directSession.decisionCurrent = true
}
if (process.argv.includes('--model-relationship')) {
  delete directSession.route
  directSession.requestBindingVersion = 2
  directSession.messageResolution = { relation: 'new', messageId: 'direct-demo', requestId: 'direct-demo' }
  directSession.pendingMessages = [{ messageId: 'next-demo', text: '另外开一个新任务：核对另一份文档，原任务继续保留。' }]
  directSession.decisionCurrent = false
}
if (process.argv.includes('--long-progress')) {
  directSession.execution.activity = { kind: 'tool', tool: 'grep', target: 'src/api-client.js' }
  directSession.execution.toolCalls = 12
  directSession.source.text = '先检查项目中已有的接口调用方式，再开发一个便于交付人员使用的接口调试工具。工具应支持选择接口、填写连接地址、自动生成常用参数、查看完整请求与响应，并保存测试记录。目前没有可用的联网环境，请把本地可验证的部分和需要现场联调的部分分别说明。交付人员不熟悉代码，需要清晰的操作引导、错误原因和下一步建议。最后提供可直接运行的产物、使用说明和验证结果。'
  if (directSession.decision) directSession.decision.reason = '这是一个需要先明确范围的开发需求。主控将先核对接口文档、现有调用代码与配置方式，确认请求参数、认证方式和异常处理，再制定实施计划。准备工作需要共享同一份上下文，先由主控直接完成；确定可独立执行的模块后，再决定是否委派，并保留实际验证和最终验收。'
}
if (process.argv.includes('--supplement')) {
  Object.assign(plans[0], { protocolVersion: 2, status: 'running', goal: '开发面向交付人员的可视化调试页面',
    routing: { route: 'direct', reasons: ['scope_small'] },
    inputs: [{ id: 'demo-input-1', text: '交付人员不懂技术，请提供操作引导。', status: 'received', at: Date.now() },
      { id: 'demo-input-2', text: '默认配置要便于使用。', status: 'forwarded', taskId: 'ui', resolution: '已同步给原执行者，不新建代理。', additionalCriteria: ['提供可直接使用的默认配置'], at: Date.now() }],
    tasks: [{ ...baseTask, id: 'ui', title: '开发可视化调试页面', status: 'running', complexity: 'complex',
      complexityReason: '重构页面并适配接口，需要编译和启动验证', checks: [], report: '', progress: { tool: 'read', at: Date.now() } }],
  })
}
if (process.argv.includes('--coordinator-quota')) {
  plans[0].coordinatorIssue = { code: 'MODEL_SERVICE_QUOTA', role: 'coordinator', message: '主控模型服务额度不足；已保留执行报告与验证证据',
    details: '429: exceed quota limit（隔离测试）', action: '恢复服务商额度，或手动调整主控模型后明确继续验证验收；不会自动重开执行者。' }
  plans[0].status = 'blocked'
  plans[0].completion = buildCompletion(plans[0], plans[0].coordinatorIssue.message)
}
if (invalid) {
  plans[0].status = 'blocked'
  Object.assign(plans[0].tasks[1], { status: 'blocked', attempts: 0, childId: null, report: '',
    model: { provider: 'retired-demo', model: 'routine-model', source: 'configured' }, modelRoute: { role: 'worker', source: 'configured', requested: { provider: 'retired-demo', model: 'routine-model' }, resolved: null, actual: null }, error: '执行模型配置已失效',
    issue: { code: 'MODEL_CONFIG_INVALID', tier: 'worker', role: 'worker', message: '执行模型配置已失效' } })
}
if (process.argv.includes('--audit')) {
  const task = plans[0].tasks[1]
  Object.assign(task, { complexity: 'complex', complexityReason: '涉及接口约定和异常路径，需要独立审查',
    model: { provider: 'demo', model: 'routine-model', source: 'observed' },
    modelRoute: { role: 'worker', source: 'configured', requested: { provider: 'demo', model: 'routine-model' }, resolved: { provider: 'demo', model: 'routine-model' }, actual: { provider: 'demo', model: 'routine-model' } },
    execution: { status: 'DONE', summary: '已提交实现与测试，等待审查和主控验收', reportPath: 'C:/isolated-test/reports/b/worker-1.md' },
    audit: { status: 'completed', forAttempt: 1, attempts: 1, specVerdict: 'fail', qualityVerdict: 'pass',
      modelRoute: { role: 'reviewer', source: 'configured', requested: { provider: 'demo', model: 'design-model' }, actual: { provider: 'demo', model: 'design-model' } },
      report: '需求核对发现缺少账号锁定提示；现有代码结构与测试质量通过。' },
    issues: [{ id: 'b-1-1', criterion: 0, severity: 'important', status: 'open', finding: '账号锁定场景未显示约定提示', evidence: ['src/result.js:42'] }] })
  plans[0].activationBudget = { limit: 8, used: 3, remaining: 5 }
}
if (process.argv.includes('--legacy')) delete plans[0].source
if (process.argv.includes('--receipts')) {
  Object.assign(plans[0], { protocolVersion: 2, status: 'cancelled' })
  Object.assign(plans[0].tasks[1], { status: 'cancelled', stop: { reason: '用户取消剩余测试，交付物尚未验收', source: 'coordinator', at: Date.now() } })
  Object.assign(plans[1], { protocolVersion: 2 })
  plans.push({ ...plans[1], sessionId: 'session-empty-preview', goal: '等待接口资料后继续验证', status: 'blocked',
    tasks: [{ ...baseTask, id: 'blocked-a', title: '接口联调', status: 'blocked', error: '缺少接口测试地址，尚未完成联调与验收', review: null }] })
  plans.push({ ...plans[0], sessionId: 'session-stopped-preview', goal: '响应式布局取消后的真实状态',
    tasks: [{ ...plans[0].tasks[1], title: '响应式布局', stop: { reason: '用户取消本次修改，未做主控验收', source: 'coordinator', at: Date.now() } }] })
  for (const plan of plans) plan.completion = buildCompletion(plan)
}
const bootstrap = `
window.__ModuleLoader__ = {load({factory}) {
  const plugin = factory(() => window.React);
  const root = ReactDOM.createRoot(document.getElementById('root'));
  const navRoot = ReactDOM.createRoot(document.getElementById('sidebar'));
  const overlayRoot = ReactDOM.createRoot(document.getElementById('overlay'));
  const entries = new Map(); let dictionaries, selected='session-demo-login', panel=${process.argv.includes('--config') ? "'dsh-delegation-first'" : 'null'}, activeView='${liveProgress ? 'chat' : 'delegation-acceptance'}', pending='';
  const drafts = new Map();
  const state = {status:'ready', value:${JSON.stringify(catalog)}, error:null};
  const listeners = new Set();
  const directory = {store:{getSnapshot:()=>state, subscribe:fn=>{listeners.add(fn);return ()=>listeners.delete(fn)}},
    load:async()=>state.value, refresh(){for(const fn of listeners)fn();}};
  const openView = id => { activeView=id; renderView(); };
  function LiveChat() {
    return React.createElement('div',{className:'preview-other-view','data-fixture-view':'chat'},
      React.createElement('p',null,${JSON.stringify(mixedRefusal || accordion || waitingDependencies ? plans[0].source.text : '工作台保留两个接口，参数自动生成，固定参数改为配置项')}),
      React.createElement('p',null,${JSON.stringify(coordinationConflict ? '主控曾输出“已交付”，下方程序状态显示真实进度。' : '主控正在核对当前方案与执行结果。')}));
  }
  function Composer() {
    const dock=entries.get('conversation.input.dock');
    return React.createElement('div', {'data-composer-seat':'', 'data-conversation-region':'composer', className:'preview-composer'},
      pending ? React.createElement('section', {['data-'+pending+'-key']:'fixture', role:'status'}, '隔离交互：'+pending,
        React.createElement('button', {type:'button', onClick:()=>{pending='';renderView()}}, '结束测试交互')) : React.createElement(React.Fragment,null,
        ${liveProgress ? "dock?React.createElement(dock.component,{...dock.options.inject(selected),session:{running:true}}):null," : ''}
        React.createElement('div', {className:'preview-task-dock'}, '任务 · 1 进行中 · 4 待处理'),
        React.createElement('textarea', {key:selected, 'aria-label':'测试聊天草稿', placeholder:'发消息或创建任务',
          defaultValue:drafts.get(selected)||'', onChange:event=>drafts.set(selected,event.target.value)})));
  }
  function ConversationShell() {
    const acceptance = entries.get('conversation.view');
    const content = ${liveProgress} && activeView==='chat' ? React.createElement(LiveChat) : activeView==='delegation-acceptance' ? React.createElement(acceptance.component,{sessionId:selected,openView})
      : React.createElement('div', {className:'preview-other-view', 'data-fixture-view':activeView,
          ...(activeView==='trajectory'?{'data-conversation-composer-overlay':''}:{})},
          React.createElement('h2',null,activeView==='chat'?'对话':activeView==='trajectory'?'轨迹':activeView==='context'?'上下文':activeView),
          React.createElement('p',null,'隔离宿主页签：'+selected));
    return React.createElement('section', {className:'preview-conversation', 'data-phase':'active'},
      React.createElement('nav', {className:'preview-tabs', 'aria-label':'会话页签'},
        ...[['chat','对话'],['trajectory','轨迹'],['context','上下文'],['delegation-acceptance','任务验收']].map(([id,label])=>
          React.createElement('button',{key:id,type:'button','aria-current':activeView===id?'page':undefined,onClick:()=>openView(id)},label))),
      React.createElement('div', {'data-conversation-scroll':'', className:'preview-scroll'},
        React.createElement('div', {'data-slot':'conversation.session',style:{display:'contents'}},
          React.createElement('div',{className:'preview-view-area'},content)),React.createElement(Composer)));
  }
  const renderView=()=>root.render(panel===null?React.createElement(ConversationShell):React.createElement(entries.get('main').component));
  plugin.apply({effect:fn=>fn(), modelDirectories:{catalog:directory},
    layout:{selectPanel:id=>{panel=id;renderView()}},
    locale:{register:(ns,d)=>{dictionaries=d}, bind:()=>key=>dictionaries.zh[key]??key},
    slots:{inject:(name,fn)=>fn(), entries:name=>name==='conversation.view'
      ? [{options:{id:'fleet'}},{options:{id:'share'}},{options:{id:'chat'}},entries.get(name)] : [],
      register:(options,component)=>{
        entries.set(options.name,{options,component});
        if(options.name==='shell.overlay')overlayRoot.render(React.createElement(component));
        if(options.name==='sidebar.panellist')navRoot.render(React.createElement('button',{
          type:'button',onClick:()=>{panel='dsh-delegation-first';renderView()}
        },React.createElement(component),options.label()));
        return ()=>{};
      }}});
  document.querySelectorAll('[data-session]').forEach(button=>button.onclick=()=>{selected=button.dataset.session;panel=null;renderView()});
  document.querySelectorAll('[data-pending]').forEach(button=>button.onclick=()=>{pending=button.dataset.pending;renderView()});
  document.querySelector('[data-return-conversation]').onclick=()=>{panel=null;renderView()};
  renderView();
}};`
const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>DSH Agentrix · 隔离界面验证</title>
<style>html,body{margin:0;height:100%;font-family:Arial,"Microsoft YaHei",sans-serif}body{display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2,#f5f6f7);color:var(--dsw-alias-label-primary,#1f2329)}.layout{flex:1;min-height:0;display:grid;grid-template-columns:230px minmax(0,1fr)}#root{height:100%;min-height:0;overflow:hidden}#sidebar{padding:16px;background:#f5f6f7}#sidebar button{display:flex;align-items:center;gap:10px;padding:12px;font:inherit}.notice{padding:8px 16px;font-size:12px;background:#fff6df;color:#765b16}.sessions{display:flex;flex-wrap:wrap;gap:8px;padding:8px 16px}.sessions button{padding:6px 12px;cursor:pointer}
.preview-conversation{height:100%;display:flex;flex-direction:column;overflow:hidden}.preview-tabs{display:flex;flex-wrap:wrap;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e6eb);flex:none}.preview-tabs button{font:inherit;color:inherit;background:transparent;border:0;padding:6px;cursor:pointer}.preview-tabs button[aria-current=page]{color:var(--dsw-alias-state-business-primary,#4f6ef7);box-shadow:0 2px currentColor}.preview-scroll{--dsh-composer-height:160px;display:flex;flex:1;min-height:0;flex-direction:column;overflow-y:auto;position:relative}.preview-view-area{display:flex;flex-direction:column;flex:1 0 auto;min-height:auto}.preview-composer{box-sizing:border-box;flex:none;position:sticky;bottom:0;z-index:9;margin-top:auto;padding:16px;background:linear-gradient(transparent,var(--dsw-alias-bg-layer-2,#f5f6f7) 24px)}.preview-task-dock{background:var(--dsw-alias-bg-layer-1,#fff);padding:8px;border-radius:8px;margin-bottom:8px;font-size:13px}.preview-composer textarea{box-sizing:border-box;width:100%;height:80px;padding:12px;resize:none;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:12px;color:inherit;background:var(--dsw-alias-bg-layer-1,#fff);font:14px/1.6 inherit}.preview-composer section{padding:20px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:8px}.preview-other-view{flex:1;padding:24px}.preview-scroll:has([data-conversation-composer-overlay]){overflow:hidden auto}.preview-scroll:has([data-conversation-composer-overlay])>[data-slot="conversation.session"]>.preview-view-area{flex:1 1 0;min-height:0;overflow:hidden}.preview-scroll:has([data-conversation-composer-overlay])>.preview-composer{position:absolute;left:0;right:0;bottom:0}.preview-scroll:has([data-fixture-view=context])>.preview-composer:not(:has([data-approval-key],[data-question-key],[data-plan-review-key])){display:none}@media(max-width:720px){.layout{grid-template-columns:1fr}#sidebar{display:none}.notice,.sessions{padding:6px 12px}.sessions button{font-size:12px;padding:4px}}
${process.argv.includes('--dark') ? ':root{--dsw-alias-bg-layer-1:#141414;--dsw-alias-bg-layer-2:#232323;--dsw-alias-label-primary:#f3f3f3;--dsw-alias-label-secondary:#a1a1a1;--dsw-alias-border-l1:#303030;--dsw-alias-button-primary-fill:#4d6bfe}body{background:#141414;color:#f3f3f3}#sidebar{background:#1d1d1d}#sidebar button,.sessions button{background:#232323;color:#f3f3f3;border:1px solid #303030}' : ''}
${process.argv.includes('--fidelity') ? 'body{background:#e9ebef}.notice,.sessions,#sidebar{display:none}.layout{display:block;width:980px;max-width:100%;height:760px;margin:24px auto;background:#fff;border:1px solid #d8dce2;border-radius:14px;box-shadow:0 18px 48px rgba(24,32,44,.13);overflow:hidden;box-sizing:border-box}#root{height:100%;overflow:hidden}@media(max-width:1040px){.layout{height:720px}}' : ''}</style>
<div class="notice">隔离界面验证 · 全部为测试数据 · 未连接 DSH</div>
<nav class="sessions" aria-label="测试会话"><button data-session="session-demo-login">登录需求</button><button data-session="session-demo-research">调研需求</button><button data-session="session-empty-preview">空会话</button>${process.argv.includes('--receipts') ? '<button data-session="session-stopped-preview">停止回执</button>' : ''}</nav>
<nav class="sessions" aria-label="宿主交互测试"><button data-pending="approval">审批测试</button><button data-pending="question">提问测试</button><button data-pending="plan-review">计划确认测试</button><button data-return-conversation>返回测试会话</button></nav>
<div class="layout"><nav id="sidebar"></nav><div id="root"></div></div><div id="overlay"></div>
<script src="/react.js"></script><script src="/react-dom.js"></script><script>${bootstrap}</script><script src="/client.js"></script></html>`
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname === '/') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html); return }
    if (url.pathname === '/client.js') { response.setHeader('content-type', 'text/javascript'); response.end(await readFile(new URL('../client.js', import.meta.url))); return }
    if (['/react.js', '/react-dom.js'].includes(url.pathname)) { response.setHeader('content-type', 'text/javascript');
      const name = url.pathname.slice(1)
      response.end(await readFile(path.join(assetDirectory, name)).catch(() => readFile(path.join(assetDirectory, name.replace('.js', '.production.min.js'))))); return }
    response.setHeader('content-type', 'application/json; charset=utf-8')
    if (url.pathname.endsWith('/api/config')) {
      if (process.argv.includes('--config-read-error')) { response.statusCode = 503; response.end(JSON.stringify({ ok: false, error: '配置服务暂不可用（隔离测试）' })); return }
      if (request.method === 'POST') {
        let raw = ''; for await (const chunk of request) raw += chunk
        const patch = JSON.parse(raw)
        if (config.locked) { response.statusCode = 409; response.end(JSON.stringify({ ...config, ok: false, error: '环境变量已锁定' })); return }
        if (patch.revision && patch.revision !== config.revision) { response.statusCode = 409; response.end(JSON.stringify({ ...config, ok: false, code: 'CONFIG_CONFLICT', error: '配置已在别处更新' })); return }
         if (patch.maxParallel < 1 || patch.maxParallel > 4) { response.statusCode = 400; response.end(JSON.stringify({ ok: false, error: 'maxParallel 必须是 1~4 的整数' })); return }
         if (patch.maxActivations < 1 || patch.maxActivations > 32) { response.statusCode = 400; response.end(JSON.stringify({ ok: false, error: 'maxActivations 必须是 1~32 的整数' })); return }
        config = { ...config, ...patch, revision: 'preview-' + ++configRevision, updatedAt: Date.now() }; console.log('UI_CONFIG_SAVED')
      }
      response.end(JSON.stringify(config)); return
    }
    if (url.pathname.endsWith('/api/state')) {
      if (loadError) { response.statusCode = 503; response.end(JSON.stringify({ ok: false, error: '本地任务服务暂不可用（隔离测试）' })); return }
      const sessionId = url.searchParams.get('sessionId')
      if (process.argv.includes('--slow') && sessionId === plans[0].sessionId) await new Promise(resolve => setTimeout(resolve, 1500))
      response.end(JSON.stringify({ ok: true, sessionId, mode: config.mode, coordinationPolicyVersion: COORDINATION_POLICY_VERSION, requestBindingVersion: process.argv.includes('--model-relationship') ? 2 : undefined, runtimePolicyVersion: nextRequest || liveProgress ? 2 : undefined, plans: directProgress ? [] : plans.filter(plan => plan.sessionId === sessionId), sessions: directProgress ? [directSession].filter(row => row.sessionId === sessionId) : liveProgress ? [
        { sessionId: plans[0].sessionId, source: plans[0].source, turnStats: { direct: 0, delegated: 1, denied: 0 } },
      ] : nextRequest ? [
        { sessionId: plans[0].sessionId, source: { messageId: 'request-new', text: '核查代码实际调用了哪些密码接口' }, route: { route: 'direct', reasons: ['scope_small'] },
          turnStats: { direct: 0, delegated: 0, denied: 0 } },
      ] : process.argv.includes('--supplement') ? [
        { sessionId: plans[0].sessionId, difficulty: { level: 'simple', score: 0, signals: [] }, route: { route: 'direct', reasons: ['scope_small'] } },
      ] : [], storageError: null })); return
    }
    response.statusCode = 404; response.end('{}')
  } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ ok: false, error: error.message })) }
})
server.listen(Number(process.argv[3]) || 0, '127.0.0.1', () => console.log(`PREVIEW_URL=http://127.0.0.1:${server.address().port}`))
process.on('SIGINT', () => server.close())
