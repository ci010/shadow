import type { AgentTypeDefinition } from './types.ts'
import { parseFrontmatter } from '../../utils/frontmatter.ts'

/**
 * Parse an AGENT.md file into an AgentTypeDefinition.
 * Understands optional YAML frontmatter between `---` fences.
 */
export function parseAgentFile(
  content: string,
  fallbackName: string,
  dirPath: string,
): AgentTypeDefinition {
  const { frontmatter: fm, body } = parseFrontmatter(content)

  if (Object.keys(fm).length === 0 && body === content.replace(/\r\n/g, '\n')) {
    return {
      name: fallbackName,
      description: content.slice(0, 200),
      prompt: content,
      ephemeral: false,
      source: 'workspace',
      dirPath,
    }
  }

  return {
    name: typeof fm.name === 'string' ? fm.name : fallbackName,
    description: typeof fm.description === 'string' ? fm.description : '',
    prompt: body,
    allowedTools: toStringArray(fm.allowedTools),
    blockedTools: toStringArray(fm.blockedTools),
    ephemeral: fm.ephemeral === true,
    skills: typeof fm.skills === 'boolean' ? fm.skills : undefined,
    soul: typeof fm.soul === 'boolean' ? fm.soul : undefined,
    root: typeof fm.root === 'boolean' ? fm.root : undefined,
    source: 'workspace',
    dirPath,
    model: typeof fm.model === 'string' ? fm.model : undefined,
    temperature: typeof fm.temperature === 'number' ? fm.temperature : undefined,
    maxTokens: typeof fm.maxTokens === 'number' ? fm.maxTokens : undefined,
    thinking: fm.thinking && typeof fm.thinking === 'object' && 'type' in fm.thinking
      ? fm.thinking as { type: 'enabled' | 'disabled' }
      : undefined,
    reasoningEffort: fm.reasoningEffort === 'high' || fm.reasoningEffort === 'max'
      ? fm.reasoningEffort
      : undefined,
  }
}

/** Coerce a YAML value (string[] or comma-separated string) into string[] | undefined. */
function toStringArray(val: unknown): string[] | undefined {
  if (Array.isArray(val)) return val.map(String).filter(Boolean)
  if (typeof val === 'string' && val) {
    return val.replace(/[\[\]]/g, '').split(',').map((t) => t.trim()).filter(Boolean)
  }
  return undefined
}
