import type { SessionState } from '../../sessions/session-store.ts'
import type { SystemPromptProvider } from './builder.ts'

export function topicProvider(getState: (sessionId: string) => SessionState | null): SystemPromptProvider {
  return {
    name: 'topic',
    getPromptSection(ctx) {
      if (ctx.mode && ctx.mode !== 'session') return null
      const state = getState(ctx.sessionId)
      return [
        '# Task context',
        state?.topic ? `Topic brief (scope metadata, not an authorization): ${JSON.stringify(state.topic)}` : 'This conversation has no explicit topic brief yet.',
        'Use the current work agreement, when present, for versioned outcome and acceptance. Older briefs and historical first-message descriptions do not override it; missing scope is unknown, not unrestricted.',
      ].join('\n')
    },
  }
}
