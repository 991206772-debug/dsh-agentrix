// Isolated UI fixture. No DSH connection, model request, or user profile writes.
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { DEFAULT_OPTIONS, OPTION_RANGES } from '../orchestrator.js'
import { buildCompletion } from '../completion.js'
const assetDirectory = process.argv[2]
if (!assetDirectory) throw new Error('Provide a directory containing react.js and react-dom.js')
const invalid = process.argv.includes('--invalid')
const loadError = process.argv.includes('--load-error')
let config = { ok: true, modelRouting: 'roles', mode: 'auto', threshold: 2, maxParallel: 2, maxAttempts: 2, maxActivations: 8, taskTimeoutMinutes: 15, locked: false,
  models: { worker: { provider: invalid ? 'retired-demo' : 'demo', model: 'routine-model' }, reviewer: { provider: 'demo', model: 'design-model' } }, file: 'C:/isolated-test/delegation-first/default.json',
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
  const entries = new Map(); let dictionaries, selected='session-demo-login';
  const state = {status:'ready', value:${JSON.stringify(catalog)}, error:null};
  const listeners = new Set();
  const directory = {store:{getSnapshot:()=>state, subscribe:fn=>{listeners.add(fn);return ()=>listeners.delete(fn)}},
    load:async()=>state.value, refresh(){for(const fn of listeners)fn();}};
  const renderView=()=>root.render(React.createElement(entries.get('conversation.view').component, {
    sessionId:selected, openView:id=>root.render(React.createElement('p',null,'隔离导航验证：'+selected+' → '+id))
  }));
  plugin.apply({effect:fn=>fn(), modelDirectories:{catalog:directory},
    layout:{selectPanel:()=>root.render(React.createElement(entries.get('main').component))},
    locale:{register:(ns,d)=>{dictionaries=d}, bind:()=>key=>dictionaries.zh[key]??key},
    slots:{inject:(name,fn)=>fn(), entries:name=>name==='conversation.view'
      ? [{options:{id:'fleet'}},{options:{id:'share'}},{options:{id:'chat'}},entries.get(name)] : [],
      register:(options,component)=>{
        entries.set(options.name,{options,component});
        if(options.name==='shell.overlay')overlayRoot.render(React.createElement(component));
        if(options.name==='sidebar.panellist')navRoot.render(React.createElement('button',{
          type:'button',onClick:()=>root.render(React.createElement(entries.get('main').component))
        },React.createElement(component),options.label()));
        return ()=>{};
      }}});
  document.querySelectorAll('[data-session]').forEach(button=>button.onclick=()=>{selected=button.dataset.session;renderView()});
  ${process.argv.includes('--config') ? "root.render(React.createElement(entries.get('main').component));" : 'renderView();'}
}};`
const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>DSH Agentrix · 隔离界面验证</title>
<style>html,body{margin:0;height:100%;font-family:Arial,"Microsoft YaHei",sans-serif}.layout{height:calc(100% - 76px);display:grid;grid-template-columns:230px 1fr}#root{height:100%;overflow:auto}#sidebar{padding:16px;background:#f5f6f7}#sidebar button{display:flex;align-items:center;gap:10px;padding:12px;font:inherit}.notice{padding:8px 16px;font-size:12px;background:#fff6df;color:#765b16}.sessions{display:flex;gap:8px;padding:8px 16px}.sessions button{padding:6px 12px;cursor:pointer}
${process.argv.includes('--dark') ? ':root{--dsw-alias-bg-layer-1:#141414;--dsw-alias-bg-layer-2:#232323;--dsw-alias-label-primary:#f3f3f3;--dsw-alias-label-secondary:#a1a1a1;--dsw-alias-border-l1:#303030;--dsw-alias-button-primary-fill:#4d6bfe}body{background:#141414;color:#f3f3f3}#sidebar{background:#1d1d1d}#sidebar button,.sessions button{background:#232323;color:#f3f3f3;border:1px solid #303030}' : ''}
${process.argv.includes('--fidelity') ? 'body{background:#e9ebef}.notice,.sessions,#sidebar{display:none}.layout{display:block;width:980px;max-width:100%;height:760px;margin:24px auto;background:#fff;border:1px solid #d8dce2;border-radius:14px;box-shadow:0 18px 48px rgba(24,32,44,.13);overflow:hidden;box-sizing:border-box}#root{height:100%;overflow:hidden}@media(max-width:1040px){.layout{height:720px}}' : ''}</style>
<div class="notice">隔离界面验证 · 全部为测试数据 · 未连接 DSH</div>
<nav class="sessions" aria-label="测试会话"><button data-session="session-demo-login">登录需求</button><button data-session="session-demo-research">调研需求</button><button data-session="session-empty-preview">空会话</button>${process.argv.includes('--receipts') ? '<button data-session="session-stopped-preview">停止回执</button>' : ''}</nav>
<div class="layout"><nav id="sidebar"></nav><div id="root"></div></div><div id="overlay"></div>
<script src="/react.js"></script><script src="/react-dom.js"></script><script>${bootstrap}</script><script src="/client.js"></script></html>`
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname === '/') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html); return }
    if (url.pathname === '/client.js') { response.setHeader('content-type', 'text/javascript'); response.end(await readFile(new URL('../client.js', import.meta.url))); return }
    if (['/react.js', '/react-dom.js'].includes(url.pathname)) { response.setHeader('content-type', 'text/javascript'); response.end(await readFile(path.join(assetDirectory, url.pathname.slice(1)))); return }
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
      response.end(JSON.stringify({ ok: true, sessionId, mode: config.mode, plans: plans.filter(plan => plan.sessionId === sessionId), sessions: [], storageError: null })); return
    }
    response.statusCode = 404; response.end('{}')
  } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ ok: false, error: error.message })) }
})
server.listen(Number(process.argv[3]) || 0, '127.0.0.1', () => console.log(`PREVIEW_URL=http://127.0.0.1:${server.address().port}`))
process.on('SIGINT', () => server.close())
