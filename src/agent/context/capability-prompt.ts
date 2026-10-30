import type { SessionPromptContext } from './builder.ts'
import { executionModeAllowsTool } from '../../sessions/execution-mode.ts'
import { isToolAllowed } from '../../utils/tool-allow.ts'

/** Explicit prompt fragments, not heuristic rewriting of role/user prose.
 * Blocks cannot nest. Tools and modes are both ceilings on a fragment.
 */
export function capabilityPrompt(text: string, ctx: SessionPromptContext): string {
  const mode = ctx.mode ?? ctx.agent.defaultMode
  return text.replace(/<!-- capability:([^>]+) -->([\s\S]*?)<!-- \/capability -->/g,
    (_block, condition: string, body: string) => {
      const [tools, modes] = condition.trim().split(';').map(value => value.trim())
      if (modes && !modes.split(',').map(value => value.trim()).includes(mode)) return ''
      if (tools !== '*' && !tools.split(',').map(value => value.trim()).every(name =>
        executionModeAllowsTool(mode, name) && isToolAllowed(ctx.agent, name))) return ''
      return body.trim()
    })
}

// These built-in workflows consist of coordination capabilities, rather than
// ordinary task execution. Omit their discovery hints when that capability is absent.
const WORKFLOW_TOOLS: Record<string, string> = {
  orchestration: 'subagent', cron: 'cron_add', 'event-sources': 'event_source', initiative: 'work', a2a: 'subagent',
}

export function capabilityDiscovery(text: string, ctx: SessionPromptContext): string {
  const mode = ctx.mode ?? ctx.agent.defaultMode
  return text.replace(/^.*<skill name="([^"]+)">.*<\/skill>.*(?:\r?\n|$)/gm, (entry, name: string) => {
    const tool = WORKFLOW_TOOLS[name]
    if (!tool) return entry
    // Remote A2A delegation only implements task, which one-shot workers cannot create.
    if (name === 'a2a' && mode !== 'session') return ''
    return executionModeAllowsTool(mode, tool) && isToolAllowed(ctx.agent, tool) ? entry : ''
  })
}
