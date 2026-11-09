// Provider-reported token fields remain separate; no pricing or tokenizer guesses.
const fields = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
const clone = value => JSON.parse(JSON.stringify(value))

export function createUsageLedger() {
  const current = new Map()
  function request(sessionId, source) {
    let entry = current.get(sessionId)
    if (!source?.messageId) return entry ?? null
    if (entry?.requestId !== source.messageId) {
      entry = { sessionId, requestId: source.messageId, observedSince: Date.now(), complete: true,
        roles: [], cursors: {}, messageIds: [] }
      current.set(sessionId, entry)
    }
    return entry
  }
  function row(entry, target) {
    if (!target.provider || !target.model) entry.complete = false
    let result = entry.roles.find(item => item.sessionId === target.sessionId && item.provider === target.provider && item.model === target.model)
    if (!result) {
      result = { ...target, requests: 0, responses: 0, ...Object.fromEntries(fields.map(key => [key, null])) }
      entry.roles.push(result)
    }
    return result
  }
  return {
    request,
    observeRequest(entry, target) {
      if (!entry) return
      entry.activeTargets ??= {}
      entry.activeTargets[target.sessionId] = target
      row(entry, target).requests++
    },
    observeMessage(entry, target, event) {
      if (!entry) return false
      target = entry.activeTargets?.[target.sessionId] ?? target
      if (Number.isInteger(event.seq)) {
        if (event.seq <= (entry.cursors[target.sessionId] ?? -1)) return false
        entry.cursors[target.sessionId] = event.seq
      } else {
        const id = event.id ?? event.data?.id
        if (!id) { entry.complete = false; return false }
        const key = target.sessionId + ':' + id
        if (entry.messageIds.includes(key)) return false
        entry.messageIds.push(key)
      }
      const result = row(entry, target), usage = event.data?.usage
      if (!usage) { entry.complete = false; return true }
      if (result.responses >= result.requests) entry.complete = false
      result.responses++
      for (const key of fields) {
        if (Number.isFinite(usage[key]) && usage[key] >= 0) result[key] = (result[key] ?? 0) + usage[key]
        else if (key === 'inputTokens' || key === 'outputTokens') entry.complete = false
      }
      return true
    },
    snapshot: () => [...current.values()].map(clone),
    restore(entries = []) {
      for (const entry of entries) if (typeof entry?.sessionId === 'string' && typeof entry.requestId === 'string' && Array.isArray(entry.roles)) {
        current.set(entry.sessionId, { ...entry, cursors: entry.cursors ?? {}, messageIds: entry.messageIds ?? [] })
      }
    },
  }
}
