import type { InboundMessage } from '../bus/events.ts'
import type { LlmRuntimeConfig } from '../agent/llm-config.ts'

export interface SlashCommandContext {
  sessionId: string
  msg: InboundMessage
  admin: boolean
  llm: LlmRuntimeConfig
}

export interface SlashCommandHandler {
  name: string
  description: string
  adminOnly: boolean
  coordinatorOnly?: boolean
  execute(ctx: SlashCommandContext, args: string): Promise<string>
}

export class CommandDispatcher {
  private handlers = new Map<string, SlashCommandHandler>()

  register(handler: SlashCommandHandler): void {
    this.handlers.set(handler.name.toLowerCase(), handler)
  }

  getHandlers(context?: Pick<SlashCommandContext, 'admin' | 'sessionId'>): SlashCommandHandler[] {
    return Array.from(this.handlers.values()).filter(handler => !context || (
      (!handler.adminOnly || context.admin) && (!handler.coordinatorOnly || context.sessionId === 'web:orchestrator')
    )).sort((a, b) =>
      a.name.localeCompare(b.name)
    )
  }

  async dispatch(
    raw: string,
    ctx: SlashCommandContext,
  ): Promise<string | null> {
    if (!raw.trimStart().startsWith('/')) return null

    const parsed = this.parse(raw)
    if (!parsed) {
      return 'Error: invalid slash command. Use /help to list available commands.'
    }

    const handler = this.handlers.get(parsed.name.toLowerCase())
    if (!handler) {
      return `Error: unknown command "/${parsed.name}". Use /help to list available commands.`
    }

    if (handler.adminOnly && !ctx.admin) {
      return 'Permission denied: slash commands require an admin session.'
    }

    return await handler.execute(ctx, parsed.args)
  }

  private parse(raw: string): { name: string; args: string } | null {
    const trimmed = raw.trim()
    const match = trimmed.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+([\s\S]*))?$/)
    if (!match) return null

    return {
      name: match[1],
      args: (match[2] ?? '').trim(),
    }
  }
}
