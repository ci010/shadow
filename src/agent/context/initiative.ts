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
        'Initiative items are the shared source of work status. Your todo is a view of assigned items, not a separate checklist.',
        'Use the initiative SQL tool for current state before claiming or changing work; this prompt is a snapshot.',
        'A recorded in_progress status is not proof that its session is still executing. Review activity and handoff needs.',
        '',
        summary,
      ].join('\n')
    },
  }
}
