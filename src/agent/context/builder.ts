import type { SessionConfig } from '../../sessions/session-store.ts'
import type { SessionInput } from '../../sessions/input.ts'
import type { WorkdirRefV1 } from '../../sessions/locality.ts'
import type { AgentTypeDefinition } from '../types/types.ts'
import type { ExecShell } from '../../tools/shell.ts'
import { resolve } from 'node:path'
import type { ExecutionMode } from '../../sessions/execution-mode.ts'
import type { ChannelAddress } from '../../bus/events.ts'

// ── Session-scoped context for system prompt building ──────────────────

/**
 * Lean context for system prompt providers — contains only session-level
 * fields, not per-message execution state.
 */
export interface SessionPromptContext {
  projectId?: string
  channelAddress?: ChannelAddress
  mode?: ExecutionMode
  workRequired?: boolean
  /** Structural delegation owner, not a context-only fork source. */
  parentSessionId?: string
  behavior: SessionConfig
  channel: string
  sessionId: string
  chatId: string
  chatName?: string
  senderId?: string
  senderName?: string
  inputSource?: SessionInput['source']['kind']
  isGroup?: boolean
  admin?: boolean
  defaultExecShell?: ExecShell
  execNodeOnly?: boolean
  /** Resolved agent type definition (from agent-types registry) */
  agent: AgentTypeDefinition
  /** Stable Initiative ID for shared work context (from SessionState). */
  initiativeId?: string
  /** Fresh-context boundary for automatically injected transient memory. */
  contextResetAt?: string
  /** Selected registered folder, independent of the effective workdir capability. */
  folderId?: string
  /** Session id owning the shared working directory (subagents inherit the spawner's). */
  workspaceRoot?: string
  /** Node-bound capability selecting the session's effective working directory. */
  workdir?: WorkdirRefV1
}

// ── System prompt provider registry ─────────────────────────────────────

/**
 * A component that contributes a section to the system prompt.
 *
 * Providers are called during system prompt assembly and can return
 * a string section (or null/empty to skip). Ordering is determined
 * by registration order.
 */
export interface SystemPromptProvider {
  /** Unique name for logging / debugging. */
  readonly name: string
  /**
   * Produce a prompt section for the given session context.
   * Return null or empty string to contribute nothing.
   */
  getPromptSection(
    ctx: SessionPromptContext,
  ): Promise<string | null> | string | null
}

export interface SystemPromptSection {
  name: string
  content: string
  characters: number
}

/** Keep per-inference agreements ahead of cached task metadata and history. */
export function withCurrentWork(systemPrompt: string, work: string): string {
  const boundary = '\n\n---\n\n'
  const first = systemPrompt.indexOf(boundary)
  return first < 0
    ? `${work}${boundary}${systemPrompt}`
    : `${systemPrompt.slice(0, first)}${boundary}${work}${systemPrompt.slice(first)}`
}

/**
 * Assembles the full system prompt from registered providers.
 *
 * Sections are contributed by registered {@link SystemPromptProvider}s
 * and joined with `---` separators.
 */
export class ContextBuilder {
  private providers: SystemPromptProvider[] = []

  constructor(
    private readonly workspace: string,
  ) {
    this.workspace = resolve(workspace)
  }

  /**
   * Register a system prompt provider.
   * Sections appear in registration order.
   */
  register(provider: SystemPromptProvider): void {
    this.providers.push(provider)
  }

  /**
   * Build the system prompt string from all registered providers.
   */
  async buildSystemPrompt(
    ctx: SessionPromptContext,
  ): Promise<string> {
    return (await this.buildSystemPromptDetails(ctx)).systemPrompt
  }

  async buildSystemPromptDetails(
    ctx: SessionPromptContext,
  ): Promise<{ systemPrompt: string; sections: SystemPromptSection[] }> {
    const sections: SystemPromptSection[] = []
    for (const provider of this.providers) {
      const section = await provider.getPromptSection(ctx)
      const content = section?.trim()
      if (content) sections.push({ name: provider.name, content, characters: content.length })
    }

    return { systemPrompt: sections.map(section => section.content).join('\n\n---\n\n'), sections }
  }
}
