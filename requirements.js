const kinds = ['static', 'execution']

function acceptanceFor(task, requirements) {
  const ids = task.requirementIds ?? (requirements ? task.criteria.map(text => requirements.find(item => item.text === text)?.id) : null)
  if (ids && (!Array.isArray(ids) || ids.length !== task.criteria.length || ids.some(id => !requirements?.some(item => item.id === id)))) {
    throw new Error(`任务 ${task.id} 的 requirementIds 必须按 criteria 顺序逐条引用本计划的真实需求编号`)
  }
  if (task.acceptance === undefined && !ids) return {}
  const entries = task.acceptance ?? task.criteria.map((_, index) => ({
    criterionId: 'C' + (index + 1), evidence: requirements.find(item => item.id === ids[index]).evidence,
    checks: task.checks.map((_, checkIndex) => checkIndex),
  }))
  if (!Array.isArray(entries) || entries.length !== task.criteria.length) throw new Error(`任务 ${task.id} 的 acceptance 必须逐条覆盖 criteria`)
  const acceptance = task.criteria.map((_, index) => {
    const entry = entries.find(item => item?.criterionId === 'C' + (index + 1))
    if (!entry || !kinds.includes(entry.evidence) || !Array.isArray(entry.checks) || !entry.checks.length ||
      new Set(entry.checks).size !== entry.checks.length || entry.checks.some(check => !Number.isInteger(check) || !task.checks[check])) {
      throw new Error(`任务 ${task.id} 的 acceptance 需要唯一 criterionId、static/execution 证据类型及有效 checks 编号（从 0 开始）`)
    }
    const required = ids && requirements.find(item => item.id === ids[index])
    if (required?.evidence === 'execution' && entry.evidence !== 'execution') throw new Error(`需求 ${required.id} 需要 execution 实际执行证据，不能降为只读检查`)
    if (entry.evidence === 'execution' && !entry.checks.some(check => ['pwsh', 'bash'].includes(task.checks[check].tool))) {
      throw new Error(`任务 ${task.id} 的 ${entry.criterionId} 需要 execution 实际执行证据，read/grep/glob 不能证明已运行`)
    }
    return { criterionId: entry.criterionId, evidence: entry.evidence, checks: [...entry.checks] }
  })
  return { ...(ids ? { requirementIds: [...ids] } : {}), acceptance }
}

/** Preserve original requirement identities separately from the execution plan. */
export function normalizeRequirements(input, tasks) {
  let requirements
  if (input !== undefined) {
    if (!Array.isArray(input) || !input.length || input.length > 256) throw new Error('requirements 需要 1~256 项原始必需要求')
    requirements = input.map(item => {
      if (!item || typeof item.id !== 'string' || !/^[\w-]{1,64}$/.test(item.id) || typeof item.text !== 'string' || !item.text.trim() ||
        item.text.length > 4000 || !kinds.includes(item.evidence)) throw new Error('每项 requirements 必须包含固定 id、原要求 text 和 static/execution 证据类型')
      return { id: item.id, text: item.text.trim(), evidence: item.evidence }
    })
    if (new Set(requirements.map(item => item.id)).size !== requirements.length) throw new Error('原需求编号重复')
  }
  const normalized = tasks.map(task => ({ ...task, ...acceptanceFor(task, requirements) }))
  if (requirements) {
    const covered = new Set(normalized.flatMap(task => task.requirementIds))
    const missing = requirements.filter(item => !covered.has(item.id))
    if (missing.length) throw new Error('原需求未覆盖：' + missing.map(item => item.id + ' ' + item.text).join('；'))
  }
  return { ...(requirements ? { requirements } : {}), tasks: normalized }
}

export function preserveRequirements(previous, requirements) {
  for (const item of previous ?? []) {
    const current = requirements?.find(value => value.id === item.id)
    if (!current) throw new Error(`原需求 ${item.id} 不能从同一需求的新计划中删除；沿用原编号和要求，明确的新需求使用 relation:new`)
    if (current.text !== item.text || current.evidence !== item.evidence) throw new Error(`原需求 ${item.id} 的内容和证据要求不能改写；补充要求使用新编号`)
  }
}

export function requirementCoverage(plan) {
  if (!plan.requirements?.length) return { status: 'untracked', passed: 0, total: 0, items: [] }
  const items = plan.requirements.map(requirement => {
    const links = plan.tasks.flatMap(task => (task.requirementIds ?? []).flatMap((id, criterion) => id === requirement.id ? [{ task, criterion }] : []))
    const passed = links.filter(({ task, criterion }) => task.status === 'accepted' &&
      task.review?.findings?.some(finding => finding.criterion === criterion && finding.status === 'pass')).length
    return { ...requirement, status: !links.length ? 'uncovered' : passed === links.length ? 'pass' : passed ? 'partial' : 'pending',
      taskIds: [...new Set(links.map(({ task }) => task.id))] }
  })
  const passed = items.filter(item => item.status === 'pass').length
  return { status: passed === items.length ? 'verified' : passed || items.some(item => item.status === 'partial') ? 'partial' : 'pending',
    passed, total: items.length, items }
}

export function extendRequirements(plan, task, criteria) {
  for (const text of criteria) {
    const criterion = task.acceptance?.length ?? task.criteria.length
    const evidence = task.acceptance?.some(item => item.evidence === 'execution') ? 'execution' : 'static'
    if (plan.requirements) {
      let number = 1
      while (plan.requirements.some(item => item.id === 'R' + number)) number++
      const id = 'R' + number
      plan.requirements.push({ id, text, evidence })
      task.requirementIds.push(id)
    }
    if (task.acceptance) task.acceptance.push({ criterionId: 'C' + (criterion + 1), evidence, checks: task.checks.map((_, index) => index) })
  }
}
