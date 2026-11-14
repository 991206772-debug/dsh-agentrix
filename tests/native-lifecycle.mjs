// Real installed AgentLoop, ToolRuntime and SubagentRuntime; scripted local adapter only.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { apply } from '../index.js'

const moduleRoot = process.env.DSH_MODULE_ROOT
if (!moduleRoot) throw new Error('DSH_MODULE_ROOT is required')
const native = async name => import(pathToFileURL(path.join(moduleRoot, name, 'lib/index.js')).href)
const { Context } = await native('cordis')
const { SessionStore } = await native('dsh-session')
const { SessionProjectionRegistry } = await native('dsh-session-projection')
const { AgentRegistry } = await native('dsh-agent')
const { AgentLoop } = await native('dsh-agent-loop')
const { SystemPrompt } = await native('dsh-system-prompt')
const { ToolRuntime, defineTool } = await native('dsh-tools')
const { NativeToolExecutor } = await native('dsh-tool-executor-native')
const { LlmRuntime, LlmAdapter, LlmError, createUserMessage } = await native('dsh-llm')
const { SubagentRuntime } = await native('dsh-subagent')
const Spawn = await native('dsh-subagent-spawn-in-process')
const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-completion-native-'))
const truncateOutput = process.argv.includes('--truncate-output')
const coordinatorReview = process.argv.includes('--coordinator-review')
const requirementContract = process.argv.includes('--requirements')
const continuous = process.argv.includes('--continuous')
const benchmark = process.argv.includes('--benchmark')
const baseline = process.argv.includes('--benchmark-baseline')
const explicitWait = process.argv.includes('--wait-supplement') || process.argv.includes('--wait-cancel')
const supplement = explicitWait || process.argv.includes('--supplement') || process.argv.includes('--supplement-cancel')
const cancelSupplement = process.argv.includes('--supplement-cancel') || process.argv.includes('--wait-cancel')
const nativeDefault = process.argv.includes('--native-default')
const switchCoordinator = process.argv.includes('--switch-coordinator')
const coordinatorQuota = process.argv.includes('--coordinator-quota')
const requestRefusal = process.argv.includes('--request-refusal')
const messageInbox = process.argv.includes('--message-inbox')
const finalDelivery = process.argv.includes('--final-delivery')
const reasoningOnly = process.argv.includes('--reasoning-only')
const nextRequest = process.argv.includes('--next-request') || messageInbox
const directUnresolved = process.argv.includes('--direct-unresolved')
const directRecovery = process.argv.includes('--direct-recovery') || directUnresolved
const decisionCancellation = process.argv.includes('--decision-cancel')
const decisionRecovery = process.argv.includes('--decision-recovery') || decisionCancellation
const longVerification = process.argv.includes('--long-verification')
const coordinationConflict = process.argv.includes('--coordination-conflict')
const ergonomics = process.argv.includes('--ergonomics')
const roleTools = process.argv.includes('--role-tools') || ergonomics
const dependentStages = process.argv.includes('--dependent-stages') || ergonomics
const activeNewRequest = process.argv.includes('--active-new-request')
const earlyEvidence = process.argv.includes('--early-evidence')
const progressReview = process.argv.includes('--progress-review')
const progressCorrection = '已有自检证据，核对剩余要求后及时提交报告，不重复校准同一指标。'
let followingRequest = false
let inboxPhase = 0
const workerGate = Promise.withResolvers()
const conflictExecutions = new Map(), releases = new Map()
let directEdits = 0
const firstReads = new Map()
const fixturePath = path.join(directory, coordinationConflict ? 'input.txt' : 'result.txt')
const deliverablePath = path.join(directory, 'result.txt')
const notePath = path.join(directory, 'new-note.txt')
let parentWaiting = false
const supplementText = '交付操作员不懂技术，需要页面操作引导。'
const refusalMessage = 'WorkBuddy: Illegal API invocation from an unapproved channel — this request was refused'
const workerReport = '读取 result.txt 可验证 verified，等待主控实际验收。' + (benchmark ? '\n证据：result.txt 包含 verified。'.repeat(500) : '')
process.env.DSH_HOME = directory
delete process.env.DSH_DELEGATION_FIRST
const ctx = new Context(), routes = new Map(), requests = [], events = [], phases = new Map()
ctx.provide('webServer', { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } })
ctx.provide('workingDirectory', { get: () => directory, async set() {} })
ctx.plugin(SessionProjectionRegistry)
ctx.plugin(SessionStore)
ctx.plugin(AgentRegistry)
ctx.plugin(SystemPrompt)
ctx.plugin(LlmRuntime)
ctx.plugin(ToolRuntime)
ctx.plugin(AgentLoop)
ctx.plugin(SubagentRuntime)
ctx.plugin(Spawn)
const tick = () => new Promise(resolve => setTimeout(resolve, 10))
async function until(predicate, label) {
  for (let i = 0; i < (longVerification ? 7500 : 500); i++) { if (await predicate()) return; await tick() }
  throw new Error('Timed out: ' + label)
}
let parent, handle, nextCall = 0
class ScriptedAdapter extends LlmAdapter {
  async resolveModel(provider, model, signal) {
    const info = await super.resolveModel(provider, model, signal)
    return (nativeDefault || switchCoordinator) && ['coordinator', 'changed-coordinator'].includes(model) ? { ...info,
      reasoning: { efforts: [{ id: 'max', name: 'Max' }, { id: 'high', name: 'High' }, { id: 'low', name: 'Low' }], defaultEffort: nativeDefault ? 'max' : 'high' } } : info
  }
  async *stream(request) {
    const role = request.sessionId === parent?.id ? 'coordinator' : request.model === 'low-worker' ? 'worker' : 'reviewer'
    if (dependentStages && role === 'coordinator') parentWaiting = false
    if (roleTools) {
      const names = request.tools.map(tool => tool.name)
      if (role === 'coordinator') {
        for (const name of ['delegation_report', 'delegation_checkpoint']) assert.ok(!names.includes(name), 'coordinator must not see worker-only tool ' + name)
        assert.ok(names.includes('delegation_plan'))
        if (ergonomics) {
          const availability = (await state()).sessions.find(session => session.sessionId === parent.id)?.delegationAvailability
          assert.equal(availability?.status, 'available', 'phase-hidden tools must not report unavailable during actual native requests')
          assert.deepEqual(availability.missingTools, [])
          assert.ok(!JSON.stringify(request.messages.filter(message => message.role === 'system')).includes('当前会话的委派入口不可用'), 'the coordinator prompt must agree with real delegation capability')
        }
      } else {
        for (const name of ['delegation_decide', 'delegation_plan', 'delegation_run', 'delegation_status', 'delegation_verify', 'delegation_review', 'delegation_cancel']) assert.ok(!names.includes(name), 'managed child must not see coordinator-only tool ' + name)
        assert.ok(names.includes('delegation_report'))
        if (ergonomics) {
          const properties = request.tools.find(tool => tool.name === 'delegation_report').parameters.properties
          for (const field of ['specVerdict', 'qualityVerdict', 'issues', 'resolutions']) assert.equal(Boolean(properties[field]), role === 'reviewer', 'report fields follow the actual child role')
        }
        if (role === 'reviewer') assert.ok(names.every(name => ['read', 'grep', 'glob', 'delegation_checkpoint', 'delegation_report'].includes(name)), 'reviewer sees only read and reporting tools')
      }
    }
    requests.push({ sessionId: request.sessionId, role, model: request.model, reasoningEffort: request.reasoningEffort, inputCharacters: JSON.stringify(request.messages ?? []).length })
    const phase = phases.get(request.sessionId) ?? 0
    phases.set(request.sessionId, phase + 1)
    let block
    if (request.sessionId === parent?.id) {
      if (decisionRecovery || directRecovery) {
        const target = path.join(directory, 'result.txt')
        const step = phase - 1
        if (decisionRecovery) {
          if (phase === 0) block = tool('edit', { file_path: target, old_string: 'verified', new_string: 'updated' })
          else if (phase === 1) {
            assert.equal(await readFile(target, 'utf8'), 'verified', 'missing decision must prevent the write')
            assert.match(JSON.stringify(request.messages), /delegation-decision-recovery/, 'correction reaches the very next request, without ending the turn')
            assert.match(JSON.stringify(request.messages), /尚无已确认需求.*new/s)
            assert.ok(!request.tools.some(tool => tool.name === 'edit'), 'business tools stay hidden during correction')
            block = tool('delegation_decide', { mode: 'direct', reason: '只有一处已定位文字，主控修改后直接读取验证即可。' })
          } else if (phase === 2) {
            assert.ok(request.tools.some(tool => tool.name === 'edit'), 'saving the actual decision restores business tools')
            block = tool('edit', { file_path: target, old_string: 'verified', new_string: 'updated' })
          } else if (phase === 3) block = tool('read', { path: target })
          else block = { type: 'text', text: '已核对修改结果。' }
        } else if (phase === 0) block = tool('delegation_decide', { mode: 'direct', reason: '本次仅核对一个隔离文件，主控直接修改并读取验证即可。' })
        else if (step === 0) block = tool('edit', { file_path: target, old_string: 'missing', new_string: 'updated' })
        else if (step === 1 || step === 5) block = tool('read', { path: target })
        else if (step === 2) block = tool('write', { file_path: path.join(directory, 'other.txt'), content: 'generated another deliverable' })
        else if (step === 4 && !directUnresolved) {
          assert.match(JSON.stringify(request.messages), /本次文件修改仍有失败记录/)
          block = tool('edit', { file_path: target, old_string: 'verified', new_string: 'updated' })
        } else block = { type: 'text', text: step === 3 ? '文件已经全部更新完成。' : directUnresolved ? '原文件修改未完成，需要处理。' : '已修复并核对原文件。' }
        yield { type: 'block-start', index: 0, blockType: block.type }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 5 } }
        yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
        return
      }
      if (followingRequest) {
        const system = JSON.stringify(request.messages.filter(message => message.role === 'system'))
        assert.ok(system.includes('## Agentrix') && system.includes('delegation_decide') && system.includes('stop仅取消且须原因'), 'the native coordinator discipline is present')
        if (messageInbox) {
          let answer
          if (inboxPhase === 0) answer = tool('delegation_decide', { relation: 'new', mode: 'direct', reason: '第二项需求直接核对答复。' })
          else if (inboxPhase === 1) {
            assert.match(JSON.stringify(request.messages), /存在多条待关联消息/)
            assert.match(JSON.stringify(request.messages), /本会话待关联消息/)
            answer = tool('delegation_status', {})
          } else {
            const outputs = []
            const collect = value => {
              if (typeof value === 'string') {
                try { const parsed = JSON.parse(value); if (parsed.context?.sessionId === parent.id && parsed.nextAction) outputs.push(parsed) } catch {}
              } else if (value && typeof value === 'object') Object.values(value).forEach(collect)
            }
            collect(request.messages)
            const current = outputs.at(-1)
            assert.ok(current, 'recovery must use rendered model tool output, not the internal state API')
            assert.equal(current.plan?.status ?? 'accepted', 'accepted')
            const pending = current.context.pendingMessages
            if (inboxPhase === 2) assert.deepEqual(pending.map(message => message.text).sort(), ['核对另一份代码用了哪些接口', '继续', '继续执行'].sort())
            if (pending.length) {
              assert.equal(current.nextAction.type, 'resolve_message')
              const message = pending[0], relation = message.text.startsWith('核对另一份代码') ? 'new' : 'continue'
              answer = tool('delegation_decide', { messageId: message.messageId, relation,
                ...(relation === 'new' ? { mode: 'direct', reason: '第二项需求直接核对答复。' } : {}) })
            } else {
              assert.equal(current.context.planMatchesRequest, false)
              assert.equal(current.nextAction.type, 'handle_request')
              assert.equal(current.context.source.text, '核对另一份代码用了哪些接口')
              answer = { type: 'text', text: '已按补充继续核对第二项需求。' }
            }
          }
          inboxPhase++
          yield { type: 'block-start', index: 0, blockType: answer.type }
          yield { type: 'block-end', index: 0, block: answer }
          yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 5 } }
          yield { type: 'finish', reason: { kind: answer.type === 'tool-call' ? 'tool-calls' : 'stop' } }
          return
        }
        const message = (await state()).sessions[0]?.pendingMessages?.[0]
        if (!message) assert.ok(!system.includes('当前计划：高模型规划、低模型执行、高模型审查与验收'), 'after confirmation the previous plan must not be injected as the current request')
        const answer = message ? tool('delegation_decide', { relation: 'new', messageId: message.messageId, mode: 'direct', reason: '第二项需求只需主控核对已有上下文并答复。' }) : { type: 'text', text: '已核对第二项需求，无需委派。' }
        yield { type: 'block-start', index: 0, blockType: answer.type }
        yield { type: 'block-end', index: 0, block: answer }
        yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 5 } }
        yield { type: 'finish', reason: { kind: answer.type === 'tool-call' ? 'tool-calls' : 'stop' } }
        return
      }
      const plan = (await state())?.plans?.[0], task = plan?.tasks?.[0]
      if (coordinationConflict && task) {
        const names = request.tools.map(tool => tool.name)
        for (const name of ['team_task_create', 'team_task_update', 'wait_agent', 'subagent']) assert.ok(!names.includes(name), name + ' must be hidden from the managed coordinator')
        assert.ok(names.includes('team_task_list'), 'read-only board observation remains available')
      }
      if (requestRefusal) {
        if (!plan) block = tool('delegation_plan', { goal: '一个请求被拒绝时，另一同模型任务继续', decisionReason: '并行核对两个隔离任务，失败项保留原因，不取消正常执行者。', start: true,
          tasks: ['a', 'b'].map(id => ({ id, title: '隔离任务 ' + id, instructions: '只读取隔离文件并正式报告', scope: '隔离目录',
            outputs: [deliverablePath], writes: [], complexity: 'routine', criteria: ['文件包含 verified'], checks: [{ tool: 'read', arguments: { path: deliverablePath } }] })) })
        else if (phase === 1) {
          await until(async () => { const tasks = (await state()).plans[0].tasks; return tasks[0].status === 'blocked' && tasks[1].status === 'running' }, 'one refused request and another running worker')
          block = tool('delegation_cancel', { reason: '同模型其他任务必然也会失败，取消全部任务' })
        } else if (phase === 2) {
          const current = (await state()).plans[0]
          assert.equal(current.tasks[0].issue.code, 'MODEL_SERVICE_REQUEST_REFUSED')
          assert.equal(current.tasks[1].status, 'running')
          assert.equal(current.cancelled, false)
          assert.equal(current.completion, null, 'service refusal must not create a terminal receipt while another worker runs')
          assert.equal(releases.get(current.tasks[0].childId), 1)
          assert.equal(releases.get(current.tasks[1].childId), undefined)
          workerGate.resolve()
          block = tool('delegation_wait', {})
        } else if (phase === 3) block = tool('delegation_cancel', {})
        else block = { type: 'text', text: '服务拒绝原因已保留；另一任务已交报告，尚未验收，不自动重试失败项。' }
      }
      else if (dependentStages) {
        const current = plan?.tasks.find(task => task.status !== 'accepted')
        if (!plan) block = tool('delegation_plan', { goal: '依次验证三个阶段', decisionReason: '每个阶段由执行者检查，主控验证验收后再开始下一阶段。', tasks: ['a', 'b', 'c'].map((id, index, ids) => ({
          id, title: '检查阶段 ' + id, instructions: '读取隔离文件并提交报告', scope: '隔离目录', outputs: [deliverablePath], writes: [],
          dependsOn: index ? [ids[index - 1]] : [], complexity: ergonomics && index === 2 ? 'complex' : 'routine', criteria: ergonomics ? ['文件包含 verified', '读取证据可定位'] : ['文件包含 verified'], checks: [{ tool: 'read', arguments: { path: deliverablePath } }],
        })) })
        else if (phase === 1) block = tool('delegation_run', {})
        else if (current?.status === 'review' && !current.pendingAcceptance && (!current.checks[0].result || !current.audit || current.audit.status === 'completed')) block = !current.checks[0].result
          ? tool('delegation_verify', { taskId: current.id, checkIndex: 0 })
          : tool('delegation_review', { taskId: current.id, verdict: 'accept', findings: ergonomics ? current.criteria.map((_text, index) => ({ criterionId: 'C' + (index + 1), finding: '已实际读取并核对', evidence: [current.checks[0].result.ref] })) : [{ criterion: 0, finding: '已实际读取并核对', evidence: [current.checks[0].result.callId] }] })
        else if (ergonomics) {
          const names = request.tools.map(tool => tool.name)
          if (current?.status === 'running') assert.ok(!names.includes('delegation_verify') && !names.includes('delegation_review'), 'unavailable acceptance tools are not advertised while waiting')
          block = tool('delegation_wait', {})
        }
        else block = { type: 'text', text: '等待当前阶段的原执行者返回报告。' }
      }
      else if (activeNewRequest && phase >= 3) {
        const pending = (await state()).sessions[0]?.pendingMessages?.[0]
        if (pending) block = tool('delegation_decide', { relation: 'new', messageId: pending.messageId, mode: 'direct', reason: '新需求只改独立便签，与原任务产物不重叠，主控直接处理。' })
        else if (phase === 4) block = tool('write', { file_path: notePath, content: 'new demand verified' })
        else if (phase === 5) block = tool('read', { path: notePath })
        else if (phase === 6) block = tool('write', { file_path: deliverablePath, content: 'must be blocked' })
        else if (phase === 7) block = { type: 'text', text: '新便签已生成并读取核对，原任务继续。' }
        else if (task.status === 'review' && task.audit?.status === 'completed') block = !task.checks[0].result
          ? tool('delegation_verify', { taskId: 'a', checkIndex: 0 })
          : tool('delegation_review', { taskId: 'a', verdict: 'accept', findings: [{ criterion: 0, finding: '原任务产物已实际核对', evidence: [task.checks[0].result.callId] }] })
        else block = { type: 'text', text: plan.completion ? '原任务已验收，新便签也已核对。' : '等待原任务的报告与独立审查通知。' }
      }
      else if (!task) block = tool('delegation_plan', { goal: '高模型规划、低模型执行、高模型审查与验收', decisionReason: '核对工作由执行模型完成，主控保留独立上下文做验证和验收。',
        ...(requirementContract ? { directory, requirements: [{ id: 'R1', text: '文件包含 verified', evidence: 'execution' }] } : {}),
        tasks: [{ id: 'a', title: '检查隔离产物', instructions: coordinationConflict ? '读取 input.txt 后生成 result.txt 并正式报告' : '只读取隔离文件并正式报告', scope: '隔离目录', outputs: [deliverablePath], writes: coordinationConflict || activeNewRequest ? [deliverablePath] : [], complexity: 'complex', ...(coordinatorReview ? { reviewPolicy: 'coordinator', reviewReason: '隔离只读核对，由主控验证验收即可。' } : {}), criteria: ['文件包含 verified'],
          ...(requirementContract ? { requirementIds: ['R1'] } : {}),
          checks: [{ tool: 'read', arguments: { path: deliverablePath } },
            ...(requirementContract ? [{ tool: 'pwsh', arguments: { command: "if ((Get-Content -Raw -LiteralPath './result.txt') -notmatch 'verified') { exit 1 }", workdir: directory } }] : [])] }] })
      else if (phase === 1) block = tool('delegation_run', {})
      else if (coordinationConflict && phase === 2) block = tool('write', { file_path: deliverablePath, content: 'unverified coordinator output' })
      else if (coordinationConflict && phase === 3) block = tool('delegation_verify', { taskId: 'a', checkIndex: 0 })
      else if (coordinationConflict && phase === 4) block = tool('delegation_report', { status: 'DONE', summary: '已交付', report: '主控冒充执行者提交成果' })
      else if (coordinationConflict && phase === 5) block = tool('team_task_create', { title: '检查隔离产物' })
      else if (coordinationConflict && phase === 6) block = tool('team_task_update', { taskId: 'shadow-task', status: 'completed' })
      else if (coordinationConflict && phase === 7) block = tool('wait_agent', { agentId: task.childId })
      else if (coordinationConflict && phase === 8) block = tool('team_task_list', {})
      else if (coordinationConflict && phase === 9) block = { type: 'text', text: '已交付，任务全部完成。' }
      else if (supplement && (await state()).sessions[0]?.pendingMessages?.length) block = tool('delegation_decide', { relation: 'update', mode: 'delegate', reason: '将补充的操作引导纳入原任务，沿用原执行者完成。' })
      else if (supplement && plan.inputs?.some(input => ['queued', 'received'].includes(input.status))) block = tool('delegation_control', {
        taskId: 'a', action: 'steer', message: '将交付人员的操作引导纳入任务', inputIds: plan.inputs.filter(input => ['queued', 'received'].includes(input.status)).map(input => input.id),
        additionalCriteria: ['提供面向交付操作员的页面引导'],
      })
      else if (explicitWait && phase === 2) block = tool('delegation_wait', {})
      else if (progressReview && task.status === 'running' && task.supervision.pending) block = tool('delegation_control', {
        taskId: 'a', action: 'steer', message: progressCorrection,
      })
      else if (progressReview && task.status === 'running') block = tool('delegation_wait', {})
      else if (earlyEvidence && task.status === 'running' && task.execution) block = tool('delegation_wait', {})
      else if (task.status === 'running' && task.supervision?.pending) block = tool('delegation_control', {
        taskId: task.id, action: 'steer', message: '核对现有证据；隔离样例的重复读取用于持续执行回放，原代理按原要求继续并提交报告。',
      })
      else if (continuous && task.status === 'running') block = tool('delegation_wait', {})
      else if (phase === 2 || truncateOutput && phase < 5) block = { type: reasoningOnly ? 'reasoning' : 'text', text: '保留当前输出，继续原计划。' }
      else if (coordinatorQuota) {
        await until(async () => (await state()).plans[0].tasks[0].audit?.status === 'completed', 'review report returned before scripted coordinator quota error')
        throw new LlmError('429: exceed quota limit', 'QUOTA')
      }
      else if (task.status === 'review' && !task.checks[0].result) block = tool('delegation_verify', { taskId: 'a', ...(requirementContract ? {} : { checkIndex: 0 }) })
      else if (task.status === 'review') block = tool('delegation_review', { taskId: 'a', verdict: 'accept',
        ...(finalDelivery ? { delivery: { summary: '隔离正文已验收并交付。', inlineFiles: [fixturePath] } } : {}),
        findings: task.criteria.map((_criterion, criterion) => ({ criterion, ...(requirementContract ? { status: 'pass' } : {}), finding: '已读取隔离文件并核对要求', evidence: (requirementContract ? task.checks : [task.checks[0]]).map(check => check.result.callId) })) })
      else if ((truncateOutput || supplement) && task.status === 'running') block = { type: 'text', text: '等待原子代理报告和独立审查返回。' }
      else throw new Error('Unexpected coordinator request after terminal tool: ' + task.status)
    } else if (requestRefusal && request.model === 'low-worker') {
      const current = (await state()).plans[0].tasks.find(task => task.childId === request.sessionId)
      if (current.id === 'a') {
        await until(async () => (await state()).plans[0].tasks[1].status === 'running', 'second worker started before service refusal')
        throw new LlmError(refusalMessage, 'AUTH')
      }
      block = phase === 0 ? tool('read', { path: fixturePath }) : tool('delegation_report', { status: 'DONE', summary: '同模型的正常请求已交报告', report: workerReport })
    } else if (progressReview && request.model === 'low-worker') {
      if (phase === 0) block = tool('read', { path: fixturePath })
      else if (phase === 1) block = tool('delegation_checkpoint', { phase: 'verification', summary: '实际文件已读，自检证据具备。',
        nextStep: '核对剩余要求后提交报告。', evidence: [firstReads.get(request.sessionId)], requestReview: true })
      else if (phase === 2) {
        await until(async () => (await state()).plans[0].tasks[0].supervision.lastCorrection?.message === progressCorrection, 'original coordinator steers the original child')
        block = tool('read', { path: fixturePath })
      } else {
        assert.ok(JSON.stringify(request.messages).includes(progressCorrection), 'same native child receives the correction before reporting')
        block = tool('delegation_report', { status: 'DONE', summary: '原代理按纠偏提交实际成果', report: workerReport })
      }
    } else if (dependentStages && request.model === 'low-worker') block = phase === 0
      ? tool('read', { path: fixturePath }) : tool('delegation_report', { status: 'DONE', summary: '当前阶段已检查', report: workerReport })
    else if (earlyEvidence && request.model === 'low-worker') {
      if (phase < 20) block = tool('read', { path: fixturePath })
      else if (phase === 20) block = tool('delegation_checkpoint', { phase: 'investigation', summary: '已核对早期文件证据', nextStep: '提交完整报告', evidence: [firstReads.get(request.sessionId)] })
      else block = tool('delegation_report', { status: 'DONE', summary: '早期证据仍可引用', report: workerReport })
    }
    else if (coordinationConflict && request.model === 'low-worker') {
      const names = request.tools.map(tool => tool.name)
      for (const name of ['team_task_create', 'team_task_update', 'wait_agent', 'subagent']) assert.ok(!names.includes(name), name + ' must be hidden from the managed worker')
      if (phase === 0) block = tool('read', { path: fixturePath })
      else if (phase === 1) block = tool('write', { file_path: deliverablePath, content: 'verified' })
      else if (phase === 2) block = tool('delegation_report', { status: 'DONE', summary: '原执行者已生成实际文件', report: workerReport })
      else throw new Error('Unexpected worker request after report')
    } else if ((supplement || switchCoordinator || activeNewRequest) && request.model === 'low-worker' && phase === 0) block = tool('read', { path: path.join(directory, 'result.txt') })
    else if (supplement && request.model === 'low-worker') {
      assert.ok(JSON.stringify(request.messages).includes(supplementText), 'the original native worker must receive the human supplement')
      block = tool('delegation_report', { status: 'DONE', summary: '已核对补充要求', report: workerReport })
    } else if (continuous && request.model === 'low-worker' && phase < 85) block = tool('read', { path: path.join(directory, 'result.txt') })
    else if (continuous && request.model === 'low-worker') block = tool('delegation_report', { status: 'DONE', summary: '隔离产物已检查', report: workerReport })
    else if (truncateOutput && phase < 3) block = { type: 'text', text: '本段输出被模型截断，继续检查已有产物。' }
    else if (role === 'reviewer' && ergonomics && phase === 0) block = tool('read', { path: fixturePath })
    else if (role === 'reviewer' && phase === (truncateOutput ? 3 : ergonomics ? 1 : 0)) block = tool('delegation_report', { status: 'DONE', summary: '需求与质量均通过', report: '已核对隔离产物与任务要求，等待主控实际验证。', specVerdict: 'pass', qualityVerdict: 'pass', issues: [] })
    else if (request.model === 'low-worker' && phase === 0) block = { type: 'text', text: '工作已完成，但这次故意漏交正式报告。' }
    else if (phase === (truncateOutput ? 3 : 1)) block = tool('delegation_report', { status: 'DONE', summary: '隔离产物已检查', report: workerReport })
    else throw new Error('Unexpected child request after report')
    yield { type: 'block-start', index: 0, blockType: block.type }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 200, outputTokens: 10 } }
    const truncated = truncateOutput && (request.sessionId === parent?.id ? phase >= 2 && phase < 5 : phase < 3)
    yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : truncated ? 'max-tokens' : 'stop' } }
  }
}
function tool(name, args) { return { type: 'tool-call', id: 'scripted-' + ++nextCall, name, arguments: JSON.stringify(args) } }
async function state() {
  let body
  await routes.get('/dsh-delegation-first/api/state')({ method: 'GET', url: '/dsh-delegation-first/api/state?sessionId=root' }, { writeHead() {}, end(value) { body = JSON.parse(value) } })
  return body
}
try {
  await until(() => ctx.get('agentLoop') && ctx.get('subagents'), 'native services')
  ctx.tools.setExecutor(new NativeToolExecutor(ctx))
  ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter())
  if (requirementContract) ctx.tools.register(defineTool({ name: 'pwsh', description: 'Assert the isolated output content',
    parameters: { command: { type: 'string' }, workdir: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args) {
      assert.equal(args.workdir, directory)
      const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', args.command], {
        cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 10000,
      })
      return { exitCode: result.status, text: result.stdout + result.stderr }
    } }))
  ctx.tools.register(defineTool({ name: 'read', description: 'Read isolated fixture', parameters: { path: { type: 'string' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args, exec) {
      assert.ok([fixturePath, deliverablePath, ...(activeNewRequest ? [notePath] : [])].includes(args.path))
      if ((earlyEvidence || progressReview) && exec.agent.id !== 'root' && !firstReads.has(exec.agent.id)) firstReads.set(exec.agent.id, exec.callId)
      if (longVerification && exec.agent.id === 'root') {
        const started = Date.now()
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 61_000)
          exec.signal.addEventListener('abort', () => { clearTimeout(timer); reject(exec.signal.reason) }, { once: true })
        })
        assert.ok(Date.now() - started >= 61_000)
        assert.equal(exec.signal.aborted, false)
      }
      if (dependentStages && exec.agent.id !== 'root') await until(() => parentWaiting, 'coordinator waiting for this dependency stage')
      if ((supplement || switchCoordinator || coordinationConflict || activeNewRequest || requestRefusal) && exec.agent.id !== 'root' && requests.some(request => request.sessionId === exec.agent.id && request.model === 'low-worker')) await workerGate.promise
      return { text: await readFile(args.path, 'utf8') }
    } }))
  if (coordinationConflict) {
    for (const name of ['team_task_create', 'team_task_update', 'wait_agent', 'subagent', 'team_task_list']) ctx.tools.register(defineTool({
      name, description: 'Isolated board and native dispatch fixture', parameters: {
        title: { type: 'string' }, taskId: { type: 'string' }, status: { type: 'string' }, agentId: { type: 'string' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'board fixture' }] },
      execute() { conflictExecutions.set(name, (conflictExecutions.get(name) ?? 0) + 1); return {} },
    }))
  }
  if (coordinationConflict || activeNewRequest) {
    ctx.tools.register(defineTool({ name: 'write', description: 'Create isolated deliverable', parameters: {
      file_path: { type: 'string' }, content: { type: 'string' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'file generated' }] },
      async execute(args, exec) {
        if (activeNewRequest) assert.equal(args.file_path, notePath, 'the previous demand deliverable remains protected')
        else { assert.notEqual(exec.agent.id, 'root', 'managed coordinator must not write the worker deliverable'); assert.equal(args.file_path, deliverablePath) }
        await writeFile(args.file_path, args.content); return { ok: true }
      } }))
  }
  if (coordinationConflict || dependentStages || activeNewRequest || requestRefusal || progressReview) {
    const start = ctx.subagents.startActivation.bind(ctx.subagents)
    ctx.subagents.startActivation = async (...args) => {
      const activation = await start(...args), dispose = activation.dispose.bind(activation)
      activation.dispose = async () => { releases.set(activation.childId, (releases.get(activation.childId) ?? 0) + 1); return dispose() }
      return activation
    }
  }
  if (directRecovery || decisionRecovery) {
    ctx.tools.register(defineTool({ name: 'edit', description: 'Edit isolated fixture', parameters: {
      file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'file edited' }] },
      async execute(args) {
        directEdits++
        assert.equal(args.file_path, path.join(directory, 'result.txt'))
        const content = await readFile(args.file_path, 'utf8')
        if (!content.includes(args.old_string)) throw new Error('old_string was not found')
        await writeFile(args.file_path, content.replace(args.old_string, args.new_string))
        return { ok: true }
      } }))
    ctx.tools.register(defineTool({ name: 'write', description: 'Write another isolated deliverable', parameters: {
      file_path: { type: 'string' }, content: { type: 'string' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'another file generated' }] },
      async execute(args) {
        assert.equal(args.file_path, path.join(directory, 'other.txt'))
        await writeFile(args.file_path, args.content); return { ok: true }
      } }))
  }
  await writeFile(fixturePath, 'verified')
  ctx.on('agent/turn-stopping', ({ agent }) => { if (agent.id === 'root') parentWaiting = true }, { global: true })
  if (ergonomics || explicitWait) ctx.on('session/event', (session, event) => {
    if (session.id === 'root' && event.type === 'tool/call' && event.data.name === 'delegation_wait') parentWaiting = true
  }, { global: true })
  apply(ctx)
  if (decisionCancellation) ctx.on('tools/post-execute', async (exec, result, next) => {
    if (exec.name === 'edit' && result.isError) parent.cancel({ kind: 'user' })
    return next()
  }, { global: true, prepend: true })
  await until(() => routes.has('/dsh-delegation-first/api/state'), 'plugin routes')
  await state()
  let configStatus
  await routes.get('/dsh-delegation-first/api/config')({ method: 'POST', async *[Symbol.asyncIterator]() {
    // Missing-decision recovery applies only to modes with an explicit operation gate.
    yield Buffer.from(JSON.stringify({ ...(decisionRecovery ? { mode: 'fixed', threshold: 20 } : {}),
      models: { worker: { provider: 'scripted', model: 'low-worker' }, reviewer: { provider: 'scripted', model: 'high-reviewer' } } }))
  } }, { writeHead(status) { configStatus = status }, end() {} })
  assert.equal(configStatus, 200)
  ctx.on('session/event', (session, event) => events.push({ id: session.id, type: event.type, reason: event.data?.reason,
    ...(event.type === 'request/header' ? { header: event.data.header } : {}) }), { global: true })
  handle = await ctx.agents.create({ sessionId: 'root', meta: { cwd: directory }, agentOptions: { provider: 'scripted', model: 'coordinator' } })
  parent = handle.agent
  parent.followup(createUserMessage({ content: [{ type: 'text', text: '执行隔离任务并验证' }], source: { kind: 'user' } }))
  if (activeNewRequest) {
    await until(() => parentWaiting, 'original demand running')
    const original = (await state()).plans[0].source.messageId
    const message = createUserMessage({ content: [{ type: 'text', text: '另一个新需求：生成一份独立便签，不修改原任务产物。' }], source: { kind: 'user' } })
    parent.steer(message)
    await until(() => events.some(event => event.id === 'root' && event.type === 'turn/end'), 'independent direct demand completed')
    const running = await state()
    assert.equal(running.sessions[0].source.messageId, message.id)
    assert.equal(running.plans[0].source.messageId, original)
    assert.equal(running.plans[0].tasks[0].status, 'running')
    assert.equal(running.plans[0].completion, null)
    assert.equal(running.plans[0].recovery.used, 0)
    assert.equal(await readFile(notePath, 'utf8'), 'new demand verified')
    assert.equal(await readFile(deliverablePath, 'utf8'), 'verified')
    assert.equal(releases.size, 0)
    workerGate.resolve()
  }
  if (coordinationConflict) {
    await until(() => parentWaiting || events.some(event => event.id === 'root' && event.type === 'turn/end'), 'coordinator claimed delivery while the worker is still running')
    assert.ok(parentWaiting, JSON.stringify({ requests, events }))
    const running = (await state()).plans[0]
    assert.equal((await state()).coordinationPolicyVersion, 7)
    assert.equal(running.status, 'running')
    assert.equal(running.completion, null)
    assert.equal(running.tasks[0].execution, null)
    assert.equal(running.tasks[0].checks[0].result, null)
    assert.equal(running.tasks[0].status, 'running')
    assert.equal(running.activationBudget.used, 1)
    assert.equal(running.recovery.used, 0)
    assert.equal(releases.size, 0)
    assert.deepEqual([...conflictExecutions], [['team_task_list', 1]], 'only the read-only board observer can execute')
    assert.equal(running.coordinationIssue.tool, 'wait_agent')
    assert.equal(running.coordinationIssue.resolvedAt, undefined)
    await assert.rejects(readFile(deliverablePath), { code: 'ENOENT' })
    let failures
    await until(async () => {
      const journal = (await readFile(path.join(running.archive.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      failures = journal.filter(event => event.type === 'plan.coordination_failed')
      return failures.length === 6
    }, 'coordination failures persisted')
    assert.deepEqual(failures.map(event => event.coordinationIssue.tool), ['write', 'delegation_verify', 'delegation_report', 'team_task_create', 'team_task_update', 'wait_agent'])
    assert.equal(new Set(failures.map(event => event.coordinationIssue.callId)).size, 6, 'guard and transport observers deduplicate each actual call')
    workerGate.resolve()
  }
  if (switchCoordinator) {
    await until(() => parentWaiting, 'coordinator awaiting original worker')
    const dispatched = (await state()).plans[0].tasks[0]
    assert.equal(dispatched.dispatcherModel.model, 'coordinator')
    assert.equal(dispatched.dispatcherModel.reasoningEffort, 'high')
    parent.model.select({ provider: 'scripted', model: 'changed-coordinator', reasoningEffort: 'low' })
    workerGate.resolve()
  }
  if (supplement) {
    await until(() => parentWaiting, 'coordinator waiting hook')
    await tick()
    assert.equal((await state()).plans[0].tasks[0].status, 'running')
    parent.steer(createUserMessage({ content: [{ type: 'text', text: supplementText }], source: { kind: 'user' } }))
    if (cancelSupplement) parent.cancel({ kind: 'user' })
    else {
      await until(async () => (await state()).plans[0].inputs?.[0]?.status === 'forwarded', 'original coordinator forwarding supplement')
      const changed = (await state()).plans[0]
      assert.equal(changed.inputs.length, 1)
      assert.equal(changed.recovery.used, 0, 'human input must not consume completion-recovery allowance')
      assert.equal(changed.activationBudget.used, 1, 'the original worker is reused')
    }
    workerGate.resolve()
  }
  await until(async () => activeNewRequest ? (await state()).plans[0]?.completion?.outcome === 'completed' : events.some(event => event.id === 'root' && event.type === 'turn/end'), 'coordinator completion')
  if (cancelSupplement) await until(async () => {
    const stopped = (await state()).plans[0]
    return stopped.completion?.outcome === 'blocked' && stopped.tasks[0].release?.status === 'released'
  }, 'host interruption cleanup and receipt')
  const plan = (await state()).plans[0]
  if (roleTools) assert.ok(plan, JSON.stringify(events.filter(event => event.type === 'turn/end')))
  if (decisionRecovery) {
    await until(() => parent.status === 'idle', 'decision recovery settled')
    const result = await state()
    assert.equal(result.plans.length, 0)
    if (decisionCancellation) {
      assert.equal(result.sessions[0].decision, null)
      assert.equal(directEdits, 0)
      assert.equal(await readFile(path.join(directory, 'result.txt'), 'utf8'), 'verified')
      assert.equal(requests.length, 1)
      assert.equal(events.filter(event => event.id === 'root' && event.type === 'turn/end').at(-1).reason.kind, 'aborted')
      assert.equal(parent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === 'delegation-decision-recovery').length, 0)
      console.log('PASS: native cancellation skips decision correction, never executes the denied edit and never wakes another model or agent')
    } else {
      assert.equal(result.sessions[0].decision.mode, 'direct')
      assert.equal(result.sessions[0].decisionCurrent, true)
      assert.equal(await readFile(path.join(directory, 'result.txt'), 'utf8'), 'updated')
      assert.equal(requests.length, 5)
      assert.ok(requests.every(request => request.sessionId === 'root'))
      assert.equal(events.filter(event => event.id === 'root' && event.type === 'turn/end').length, 1)
      assert.equal(directEdits, 1, 'the denied call never runs and only the model-requested retry edits the file')
      assert.equal(parent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === 'delegation-decision-recovery').length, 1)
      console.log('PASS: native missing decision immediately corrects the same coordinator; tools restore after the real decision, one write succeeds, no new agent or human continuation')
    }
  } else if (directRecovery) {
    await until(() => parent.status === 'idle', 'direct request settled')
    const result = await state(), execution = result.sessions[0].execution
    assert.equal(result.plans.length, 0)
    assert.equal(result.coordinatorProgressVersion, 1)
    assert.equal(execution.repairUsed, 1)
    assert.equal(execution.running, false)
    assert.equal(execution.unresolvedChanges.length, directUnresolved ? 1 : 0)
    assert.equal(await readFile(path.join(directory, 'result.txt'), 'utf8'), directUnresolved ? 'verified' : 'updated')
    assert.equal(await readFile(path.join(directory, 'other.txt'), 'utf8'), 'generated another deliverable')
    assert.equal(requests.length, directUnresolved ? 6 : 8)
    assert.ok(requests.every(request => request.sessionId === 'root'))
    assert.equal(events.filter(event => event.id === 'root' && event.type === 'turn/end').length, 1)
    assert.equal(result.sessions[0].delegationAvailability.status, 'available')
    console.log('PASS: native direct edit failure survives read and unrelated file success; same coordinator repairs once; unresolved mode=' + directUnresolved)
  } else if (dependentStages || activeNewRequest) {
    assert.equal(plan.completion.outcome, 'completed')
    assert.equal(plan.recovery.used, 0)
    assert.equal(plan.activationBudget.used, dependentStages ? ergonomics ? 4 : 3 : 2)
    for (const task of plan.tasks.flatMap(task => task.audit ? [task, task.audit] : [task])) {
      assert.equal(task.release.status, 'released')
      assert.equal(releases.get(task.childId), 1)
      assert.equal(task.attempts, 1)
    }
    if (dependentStages) {
      assert.ok(plan.tasks.every(task => task.status === 'accepted'))
      if (ergonomics) {
        assert.ok(requests.filter(request => request.role === 'coordinator').length <= 13, 'no status polling requests while the same workers run')
        assert.equal(plan.tasks[2].audit.status, 'completed')
        assert.equal(plan.tasks[2].audit.modelRoute.actual.model, 'coordinator')
        console.log('PASS: role-specific native schemas, phase-hidden tools keep API and coordinator prompt available, three event waits, criterion/evidence references, independent audit and exact-once receipt/release')
      } else assert.equal(requests.filter(request => request.role === 'coordinator').length, 11)
      assert.equal(requests.filter(request => request.role === 'worker').length, 6)
    }
    console.log('PASS: native ' + (dependentStages ? 'three dependency stages wait, report, verify and accept without completion recovery or replacement workers' : 'new direct demand writes and verifies an unrelated file while the original child continues; overlapping write is denied; the original plan later receives actual acceptance'))
  } else if (cancelSupplement) {
    await until(() => parent.status === 'idle', 'cancelled coordinator cleanup')
    assert.equal(plan.cancelled, false)
    assert.equal(plan.completion.outcome, 'blocked')
    assert.equal(plan.interruption.source, 'host')
    assert.equal(plan.tasks[0].release.status, 'released')
    assert.equal(plan.activationBudget.used, 1)
    assert.equal(new Set(requests.filter(request => request.sessionId !== 'root').map(request => request.sessionId)).size, 1)
    console.log('PASS: native host stop interrupts execution, preserves the plan, releases the original child once and does not automatically reopen work')
  } else if (requestRefusal) {
    await until(() => parent.status === 'idle', 'refusal receipt settled')
    assert.equal(plan.cancelled, false)
    assert.equal(plan.completion.outcome, 'blocked')
    assert.deepEqual(plan.tasks.map(task => task.status), ['blocked', 'review'])
    assert.equal(plan.tasks[0].issue.code, 'MODEL_SERVICE_REQUEST_REFUSED')
    assert.equal(plan.tasks[0].issue.details, refusalMessage)
    assert.equal(plan.tasks[0].issue.provider, 'scripted')
    assert.equal(plan.tasks[0].issue.model, 'low-worker')
    assert.equal(plan.tasks[1].execution.commitState, 'committed')
    assert.equal(plan.activationBudget.used, 2)
    const failedTurn = events.find(event => event.id === plan.tasks[0].childId && event.type === 'turn/end')
    assert.equal(failedTurn.reason.kind, 'error')
    assert.equal(failedTurn.reason.error.message, refusalMessage)
    assert.equal(new Set(requests.filter(request => request.role === 'worker').map(request => request.sessionId)).size, 2)
    for (const task of plan.tasks) {
      assert.equal(task.attempts, 1)
      assert.equal(task.modelRoute.actual.model, 'low-worker')
      assert.equal(task.release.status, 'released')
      assert.equal(releases.get(task.childId), 1)
    }
    console.log('PASS: native service-refused request retains its turn/end cause while another same-model worker reports normally; implicit cancel preserves it, no replacement child starts, and each resource releases once')
  } else if (coordinatorQuota) {
    assert.equal(plan.coordinatorIssue.code, 'MODEL_SERVICE_QUOTA')
    assert.equal(plan.coordinatorIssue.model, 'coordinator')
    assert.equal(plan.completion.outcome, 'blocked')
    assert.equal(plan.tasks[0].status, 'review')
    assert.equal(plan.tasks[0].execution.commitState, 'committed')
    assert.equal(plan.tasks[0].audit.status, 'completed', 'the scripted quota scenario starts after the independent report has returned')
    assert.match(await readFile(plan.tasks[0].execution.reportPath, 'utf8'), /verified/)
    assert.equal(plan.activationBudget.used, 2)
    assert.equal(new Set(requests.filter(request => request.sessionId !== 'root').map(request => request.sessionId)).size, 2)
    console.log('PASS: native coordinator QUOTA error preserves returned worker and review reports without automatic redispatch or fabricated acceptance')
  } else {
  assert.equal(plan.completion?.outcome, 'completed', JSON.stringify(plan))
  if (requirementContract) {
    assert.equal(plan.completion.scope, 'plan')
    assert.equal(plan.completion.coverage.status, 'verified')
    assert.equal(plan.completion.coverage.items[0].id, 'R1')
    assert.equal(plan.tasks[0].checks[1].result.evidenceKind, 'execution')
    assert.equal(plan.tasks[0].checks[1].result.exitCode, 0)
    assert.equal(plan.tasks[0].checks[1].result.artifacts.status, 'tracked')
    console.log('PASS: native requirement coverage uses an actual command assertion and current output fingerprint')
  }
  assert.equal(plan.tasks[0].execution.commitState, 'committed')
  assert.equal(plan.tasks[0].recovery?.used ?? 0, truncateOutput || continuous || supplement || switchCoordinator || coordinationConflict || earlyEvidence || progressReview ? 0 : 1)
  assert.equal(plan.tasks[0].release.status, 'released')
  assert.equal(plan.tasks[0].modelRoute.role, 'worker')
  assert.equal(plan.tasks[0].modelRoute.actual.model, 'low-worker')
   if (coordinatorReview) {
     assert.equal(plan.tasks[0].reviewPolicy, 'coordinator')
     assert.equal(plan.tasks[0].audit, undefined)
     assert.equal(plan.activationBudget.used, 1)
     assert.equal(new Set(requests.filter(request => request.sessionId !== 'root').map(request => request.sessionId)).size, 1)
   } else {
   assert.equal(plan.tasks[0].audit.modelRoute.role, 'reviewer')
  assert.equal(plan.tasks[0].audit.modelRoute.actual.model, 'coordinator')
  assert.equal(plan.tasks[0].audit.modelRoute.source, 'dispatcher')
  assert.equal(plan.tasks[0].audit.release.status, 'released')
  assert.equal(new Set(requests.filter(request => request.sessionId !== 'root').map(request => request.sessionId)).size, 2)
   }
  assert.equal(requests.filter(request => request.model === 'low-worker').length, earlyEvidence ? 22 : coordinationConflict ? 3 : continuous ? 86 : truncateOutput || progressReview ? 4 : 2)
   assert.equal(requests.filter(request => request.role === 'reviewer').length, coordinatorReview ? 0 : truncateOutput ? 4 : 1)
  if (!switchCoordinator) assert.ok(requests.filter(request => request.sessionId === 'root').every(request => request.model === 'coordinator'))
  else {
    assert.ok(requests.some(request => request.role === 'coordinator' && request.model === 'changed-coordinator' && request.reasoningEffort === 'low'))
    assert.ok(requests.filter(request => request.role === 'reviewer').every(request => request.model === 'coordinator' && request.reasoningEffort === 'high'))
    console.log('PASS: native chat model changed during execution; review keeps the dispatcher model and high effort while coordinator continues on the new selection')
  }
  if (!baseline) {
     assert.equal((await state()).runtimePolicyVersion, 4)
    assert.equal(plan.usage.roles.reduce((sum, row) => sum + row.requests, 0), requests.length)
    for (const row of plan.usage.roles) {
      assert.equal(row.inputTokens, row.responses * 100)
      assert.equal(row.cacheReadTokens, row.responses * 200)
      assert.equal(row.outputTokens, row.responses * 10)
    }
  }
  console.log('METRICS ' + JSON.stringify({ requests: requests.length,
    byModel: Object.fromEntries([...new Set(requests.map(request => request.model))].map(model => [model, requests.filter(request => request.model === model).length])),
    inputCharacters: requests.reduce((sum, request) => sum + request.inputCharacters, 0) }))
  if (finalDelivery) {
    const journal = parent.session.snapshotEvents(), delivery = plan.delivery
    const messages = journal.filter(event => event.type === 'deliverables/presented' && event.data.source?.kind === 'delegation-delivery')
    assert.equal(messages.length, 1)
    assert.equal(delivery.status, 'delivered')
    assert.equal(messages[0].data.messageId, delivery.messageId)
    assert.equal(messages[0].data.source.receiptId, plan.completion.id)
    assert.equal(delivery.documents[0].content, 'verified')
    const ended = journal.findLast(event => event.type === 'turn/end')
    const lastText = journal.findLast(event => event.type === 'assistant/message' && event.data.turn === ended.data.turn &&
      event.data.message.content.some(block => block.type === 'text' && block.text.trim()))
    assert.equal(delivery.anchorSeq, lastText?.seq ?? ended.seq, 'delivery must use the actual native chat footer anchor, including tool-only endings')
    if (reasoningOnly) assert.equal(lastText, undefined)
    assert.ok(messages[0].seq < ended.seq, 'delivery must be committed before turn/end')
    assert.ok(parent.session.snapshotEvents().some(event => event.type === 'deliverables/presented' && event.data.messageId === delivery.messageId), 'native delivery remains reconstructable in the event log')
    let exposed
    await routes.get('/dsh-delegation-first/api/delivery')({ method: 'GET', url: '/dsh-delegation-first/api/delivery?sessionId=root&seq=' + delivery.anchorSeq },
      { writeHead(code) { assert.equal(code, 200) }, end(body) { exposed = JSON.parse(body) } })
    assert.equal(exposed.delivery.messageId, delivery.messageId)
    assert.equal(exposed.delivery.documents[0].content, 'verified')
    console.log('PASS: native final delivery commits one identified delivery record after acceptance and before turn/end, retains inline text, and adds no model call')
  }
  const coordinatorCalls = requests.filter(request => request.sessionId === 'root').length
  if (truncateOutput) assert.ok(coordinatorCalls >= 7 && coordinatorCalls <= 8, 'the original coordinator resumes each truncated output and may wait once for the child')
  else if (progressReview) assert.ok(coordinatorCalls >= 6 && coordinatorCalls <= 8, 'only bounded progress supervision adds coordinator calls')
  else if (continuous || earlyEvidence) assert.ok(coordinatorCalls >= 5 && coordinatorCalls <= 8, 'one repeated-observation inquiry and report-confirmation wait add bounded supervision rather than completion recovery')
  else assert.equal(coordinatorCalls, coordinationConflict ? 12 : supplement ? 8 : 5, 'only the scripted operations and existing recovery use the original coordinator')
  if (progressReview) {
    assert.equal(plan.tasks[0].attempts, 1)
    assert.equal(plan.tasks[0].supervision.used, 0)
    assert.equal(plan.tasks[0].supervision.pending, null)
    assert.equal(plan.tasks[0].supervision.lastCorrection.message, progressCorrection)
    assert.equal(plan.activationBudget.used, coordinatorReview ? 1 : 2)
    assert.equal(releases.get(plan.tasks[0].childId), 1)
    assert.equal(new Set(requests.filter(request => request.role === 'worker').map(request => request.sessionId)).size, 1)
    console.log('PASS: native checkpoint wakes the original coordinator, sends an evidence-based correction to the same child, then verifies and accepts with no replacement or spent failure correction')
  }
  if (coordinationConflict) {
    assert.deepEqual([...conflictExecutions], [['team_task_list', 1]])
    assert.ok(plan.coordinationIssue.resolvedAt)
    assert.equal(plan.activationBudget.used, 2)
    assert.equal(releases.get(plan.tasks[0].childId), 1)
    assert.equal(releases.get(plan.tasks[0].audit.childId), 1)
    const available = ctx.tools.schemas(parent).map(tool => tool.name)
    for (const name of ['team_task_create', 'team_task_update', 'wait_agent', 'subagent']) assert.ok(available.includes(name), 'scoped restriction is released after the final receipt')
    const journal = (await readFile(path.join(plan.archive.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(journal.filter(event => event.type === 'plan.receipt').length, 1)
    console.log('PASS: native conflicting writes, premature verification, forged report, board completion and wait are rejected; false delivery text leaves the original worker running; actual report, verification and acceptance generate one receipt and release each child once')
  }
  if (supplement) {
    assert.equal(plan.inputs[0].status, 'forwarded')
    assert.equal(plan.tasks[0].criteria.length, 2)
    console.log('PASS: native queued user input wakes the waiting coordinator, is forwarded to the same running worker, updates criteria and is verified and accepted')
  }
  if (nativeDefault) {
    assert.equal(plan.tasks[0].audit.modelRoute.requested.reasoningEffort, 'max')
    assert.equal(plan.tasks[0].audit.modelRoute.actual.reasoningEffort, 'max')
    const header = events.find(event => event.id === plan.tasks[0].audit.childId && event.type === 'request/header').header
    assert.equal(header.config.reasoningEffort, 'max')
    console.log('PASS: native adapter default reasoning max is accepted from the logged request header; adapterDefaults present=' + Object.hasOwn(header, 'adapterDefaults'))
  }
   if (truncateOutput && !coordinatorReview) assert.equal(plan.tasks[0].audit.recovery.used, 0)
  if (truncateOutput) console.log('PASS: three max-tokens responses per role continue on the same coordinator, worker and reviewer; accepted receipt generated with no replacement child or report-recovery consumption')
  if (continuous) {
    assert.ok(plan.tasks[0].supervision.notices.REQUEST_VOLUME)
    assert.equal(plan.tasks[0].attempts, 1)
    assert.equal(plan.activationBudget.used, 2)
    console.log('PASS: 86 worker requests on one native child; request reminder adds no coordinator call, replacement agent or correction')
  }
  if (earlyEvidence) {
    assert.deepEqual(plan.tasks[0].supervision.checkpoint.evidence, [firstReads.get(plan.tasks[0].childId)])
    assert.equal(plan.tasks[0].supervision.evidence.length, 16)
    assert.equal(plan.tasks[0].supervision.evidenceIndex, undefined)
    console.log('PASS: native checkpoint references the first of 20 successful reads; recent UI data stays at 16 entries and the worker submits its report normally')
  }
  assert.ok(events.some(event => event.id !== 'root' && event.type === 'turn/end'))
  if (roleTools) {
    assert.equal((await state()).sessions[0].delegationAvailability.status, 'available')
    console.log('PASS: installed host exposes role-appropriate tools before requests while coordinator delegation availability stays correct')
  }
   console.log('PASS: real AgentLoop + ToolRuntime + SubagentRuntime: configured worker, ' + (coordinatorReview ? 'explicit coordinator review without an extra reviewer' : 'review with dispatcher model') + ', same-child report recovery, caller delivery, verification, acceptance, receipt and cleanup')
  if (nextRequest) {
    await until(() => parent.status === 'idle', 'first request settled')
    followingRequest = true
    const firstRequest = plan.source.messageId, receipt = plan.completion.id, calls = requests.length
    const completedTurns = events.filter(event => event.id === 'root' && event.type === 'turn/end').length
    const newMessage = createUserMessage({ content: [{ type: 'text', text: '核对另一份代码用了哪些接口' }], source: { kind: 'user' } })
    if (messageInbox) {
      parent.session.append('user/message', newMessage, { surfaceOp: 'append' })
      parent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      parent.followup(createUserMessage({ content: [{ type: 'text', text: '继续执行' }], source: { kind: 'user' } }))
    } else parent.followup(newMessage)
    await until(() => parent.status === 'idle' && events.filter(event => event.id === 'root' && event.type === 'turn/end').length > completedTurns, 'second request completed')
    const following = await state()
    assert.equal(following.sessions[0].source.messageId, newMessage.id, JSON.stringify({ source: following.sessions[0].source, firstRequest,
      resolution: following.sessions[0].messageResolution, pending: following.sessions[0].pendingMessages, inboxPhase,
      turns: events.filter(event => event.id === 'root' && event.type === 'turn/end').map(event => event.reason) }))
    assert.notEqual(following.sessions[0].source.messageId, firstRequest)
    assert.equal(following.plans[0].source.messageId, firstRequest)
    assert.equal(following.plans[0].completion.id, receipt)
    assert.equal(following.requestUsage[0].requestId, newMessage.id)
    assert.equal(requests.length, calls + (messageInbox ? 6 : 2), 'new request confirmation and answer use the same coordinator without old-task recovery or replacement child')
    assert.ok(events.filter(event => event.id === 'root' && event.type === 'turn/end').every(event => event.reason.kind === 'completed'))
    console.log('PASS: native second request gets its own source and usage, excludes the previous plan from system context, and preserves the original accepted receipt')
    if (messageInbox) {
      assert.equal(following.sessions[0].pendingMessages.length, 0)
      assert.equal(inboxPhase, 6)
      assert.equal(following.plans[0].activationBudget.used, 2)
      console.log('PASS: native ambiguous decision returns candidates; rendered status and decision outputs recover a new request plus two continuations without scanning histories or reopening children')
    }
  }
  }
} finally {
  workerGate.resolve()
  await handle?.dispose()
  await ctx.fiber.dispose()
  while (ctx.fiber.inertia) await ctx.fiber.inertia
  await rm(directory, { recursive: true, force: true })
}
