import type { MemoryStore } from '../memory.ts'
import type { SessionPromptContext, SystemPromptProvider } from './builder.ts'

/**
 * Composes the memory block injected into the system prompt.
 *
 * Section order follows MEM.md: **Conventions → Keywords → Events
 * (this session + related) → Working Set → Summary**. The long-term keyword
 * index is main-agent-only (sub-agents skip it); everything else is shared.
 */
export function memoryProvider(
  memory: MemoryStore,
  projectOf: (sessionId: string) => string | undefined,
): SystemPromptProvider {
  return {
    name: 'memory',
    getPromptSection: async (ctx: SessionPromptContext) => {
      const conventions = await memory.readConventions(
        ctx.sessionId,
        ctx.projectName,
      )
      // Long-term keyword index is main-agent-only (sub-agents skip it).
      const isMain = !ctx.agent.ephemeral && ctx.agent.name !== 'sub'
      const keywords = isMain ? await memory.readKeywords() : ''
      const events = await memory.readEvents(ctx.sessionId, {
        currentProject: ctx.projectName,
        projectOf,
      })
      const workingSet = await memory.readWorkingSet(ctx.sessionId)
      const sessionMemory = await memory.readSessionMemory(ctx.sessionId)

      const sections = [
        conventions,
        keywords,
        events,
        workingSet,
        sessionMemory,
      ].filter((section) => section.trim())
      if (!sections.length) return null
      return sections.join('\n\n')
    },
  }
}
