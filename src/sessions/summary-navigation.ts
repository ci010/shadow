/** Navigation is a view, not an archive deletion. Full summary and per-job run
 * pagination remain authoritative historical access paths. Unknown statuses are
 * conservatively visible. Only fresh automation branches can be omitted. */
export function navigationSummary<T extends {
  sessionId: string; mode?: unknown; parentSessionId?: unknown; contextParentSessionId?: unknown
  automation?: unknown; executionStatus?: unknown; waitingForCall?: unknown; hasBackgroundTasks?: unknown
}>(rows: T[]): T[] {
  const byId = new Map(rows.map(row => [row.sessionId, row]))
  const owners = new Map<string, { jobId: string; startedAt: string }>()
  const children = new Map<string, string[]>()
  const roots = new Set<string>()
  for (const row of rows) {
    const automation = row.automation
    // Existing-context automations are ordinary conversations. Missing/legacy
    // classification is not permission to hide a row or its descendants.
    if (automation && typeof automation === 'object' && 'contextMode' in automation
      && automation.contextMode === 'fresh' && 'jobId' in automation && typeof automation.jobId === 'string'
      && automation.jobId.trim() && 'startedAt' in automation && typeof automation.startedAt === 'string'
      && Number.isFinite(Date.parse(automation.startedAt))) {
      owners.set(row.sessionId, { jobId: automation.jobId, startedAt: automation.startedAt })
      roots.add(row.sessionId)
    }
    if ((row.mode === 'task' || row.mode === 'call') && typeof row.parentSessionId === 'string') {
      const list = children.get(row.parentSessionId) ?? []
      list.push(row.sessionId); children.set(row.parentSessionId, list)
    }
  }
  const queue = [...owners.keys()]
  for (let i = 0; i < queue.length; i++) for (const child of children.get(queue[i]!) ?? []) {
    if (!owners.has(child) && byId.get(child)?.automation === undefined) {
      owners.set(child, owners.get(queue[i]!)!); queue.push(child)
    }
  }
  const latest = new Map<string, T>()
  for (const row of rows) if (roots.has(row.sessionId)) {
    const owner = owners.get(row.sessionId)!
    const previous = latest.get(owner.jobId)
    const previousOwner = previous && owners.get(previous.sessionId)!
    if (!previous || owner.startedAt > previousOwner!.startedAt
      || owner.startedAt === previousOwner!.startedAt && row.sessionId < previous.sessionId) latest.set(owner.jobId, row)
  }
  const keep = new Set<string>()
  const pending: string[] = []
  const add = (id: string) => { if (!keep.has(id) && byId.has(id)) { keep.add(id); pending.push(id) } }
  for (const row of rows) {
    if (!owners.has(row.sessionId) || row.waitingForCall || row.hasBackgroundTasks
      || !['completed', 'failed', 'cancelled'].includes(String(row.executionStatus))) add(row.sessionId)
  }
  for (const row of latest.values()) add(row.sessionId)
  // Preserve both delegation and context lineage, including transitive ancestors
  // of ordinary conversations forked from an otherwise hidden old run.
  for (let i = 0; i < pending.length; i++) {
    const row = byId.get(pending[i]!)!
    for (const parent of [row.parentSessionId, row.contextParentSessionId]) if (typeof parent === 'string') add(parent)
  }
  return rows.filter(row => keep.has(row.sessionId))
}
