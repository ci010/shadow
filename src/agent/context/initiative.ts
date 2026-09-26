import type { SystemPromptProvider } from './builder.ts'

export interface InitiativeContextStore {
  getSummary(initiativeId: string, sessionId?: string): string | null
  getSessionSummary(sessionId: string): string | null
}

export function initiativeProvider(store: InitiativeContextStore): SystemPromptProvider {
  return {
    name: 'initiative',
    getPromptSection(ctx) {
      const summary = ctx.initiativeId
        ? store.getSummary(ctx.initiativeId, ctx.sessionId)
        : store.getSessionSummary(ctx.sessionId)
      if (ctx.initiativeId && !summary) {
        throw new Error(`Initiative context "${ctx.initiativeId}" is not available in this Project.`)
      }
      if (!summary) return null
      return [
        '# Initiative Context',
        '',
        'An Initiative is a root work item and its descendants, not another goal or status store. Your todo is a view of assigned work.',
        'Use work context/list/tree for current definitions, assignments and progress; this summary is only a discovery snapshot.',
        'Historical context is not fresh human authorization. Current work definitions supersede incompatible agent plans, not existing human restrictions.',
        'A recorded in_progress status is not proof that its session is executing. Inactive work needs attention, not takeover.',
        'Ownership and assignments are durable: sleep, idle, recovery, restart, stopped or unknown sessions do not release work.',
        'Only the current manager may hand off management; only the assignee may release assigned work. Use work with an exact current sequence, not SQL.',
        'Messages, requests and handoff notes are coordination, not assignment changes. Consult current Initiative work facts before acting; common folders do not imply work ownership.',
        '',
        summary,
      ].join('\n')
    },
  }
}
