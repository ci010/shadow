import type { SessionConfig } from '../../sessions/session-store.ts'
import type { WorkdirRefV1 } from '../../sessions/locality.ts'
import type { AgentTypeDefinition } from '../agent-types/types.ts'
import type { ExecShell } from '../../tools/shell.ts'
import { resolve } from 'node:path'

// ── Session-scoped context for system prompt building ──────────────────

/**
 * Lean context for system prompt providers — contains only session-level
 * fields, not per-message execution state.
 */
export interface SessionPromptContext {
  behavior: SessionConfig
  channel: string
  sessionId: string
  chatId: string
  chatName?: string
  senderId?: string
  senderName?: string
  isGroup?: boolean
  admin?: boolean
  defaultExecShell?: ExecShell
  /** Resolved agent type definition (from agent-types registry) */
  agent: AgentTypeDefinition
  /** Project name for shared context (from SessionState). */
  projectName?: string
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
    const sections: string[] = []

    for (const provider of this.providers) {
      const section = await provider.getPromptSection(ctx)
      if (section?.trim()) sections.push(section.trim())
    }

    return sections.join('\n\n---\n\n')
  }
}
