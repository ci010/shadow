import type { SessionManager } from '../sessions/session-manager.ts'
import type { TopicService } from '../sessions/topics.ts'
import type { SessionProfileService } from '../sessions/profile.ts'
import type { AutomationProfileService } from '../cron/profile.ts'
import { resolveAutomationSession } from '../cron/contracts.ts'
import type { VirtualFsHandler, VirtualFsListHandler } from './virtual-fs.ts'
/** Aggregate-only Project metadata. Discovery never scans event logs. */
export function createStatsHandler(sessions: SessionManager, topics: () => TopicService, profiles: SessionProfileService, automations: AutomationProfileService): { read: VirtualFsHandler; list: VirtualFsListHandler } {
  const authorize = (context: Parameters<VirtualFsHandler>[1]) => {
    topics().assertActor(context.projectId, context.sessionId)
    if (context.projectId !== profiles.projectId) throw new Error('Stats belong to the current Project.')
    context.signal.throwIfAborted()
  }
  const entries = () => {
    const rows = sessions.listSessions().filter(row => sessions.getSessionState(row.sessionId)?.projectId === profiles.projectId)
    const ids = new Set(automations.featureIds())
    for (const row of rows) { const state = sessions.getSessionState(row.sessionId); const automation = state && resolveAutomationSession(state); if (automation) ids.add(automation.jobId) }
    return [{ name: 'project', content: 'Current Project aggregate usage: rolling 24h and total.' }, ...rows.map(row => ({ name: `sessions/${encodeURIComponent(row.sessionId)}`, content: 'Logical conversation usage: own and including descendants, rolling 24h and total.' })), ...[...ids].map(id => ({ name: `automations/${encodeURIComponent(id)}`, content: 'Automation feature aggregate, rolling 24h.' }))]
  }
  return {
    list: (context) => { authorize(context); return entries() },
    read: async (path, context) => {
      authorize(context)
      if (!path) return 'On-demand aggregate statistics. Read v:stats/project, v:stats/sessions/<URL-encoded logical ID>, or v:stats/automations/<URL-encoded feature ID>. Search lists metadata only; read computes bounded statistics.\n' + entries().map(entry => `v:stats/${entry.name}`).join('\n')
      if (path === 'project') return JSON.stringify(await profiles.project(context.signal), null, 2)
      const match = /^(sessions|automations)\/([^/]+)$/.exec(path)
      if (!match) throw new Error('Invalid stats path.')
      let id: string
      try { id = decodeURIComponent(match[2]!) } catch { throw new Error('Invalid encoded stats ID.') }
      if (!id || /[\/\\\x00-\x1f]/.test(id) || id === '.' || id === '..') throw new Error('Invalid stats ID.')
      const result = match[1] === 'sessions' ? await profiles.query(id, context.signal) : await automations.query(id, context.signal)
      if (!result) throw new Error('Unknown current-Project statistics.')
      return JSON.stringify(result, null, 2)
    },
  }
}
