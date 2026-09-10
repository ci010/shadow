export interface CommandContext {
  commandName: string
  args: string
  rawCommand: string
  workspace: string
  cwd: string
  channel: string
  senderId: string
}

export type CommandHandler = (ctx: CommandContext) => Promise<string | null>

export class CommandHandlerManager {
  private commands = new Map<string, CommandHandler>()

  register(commandName: string, handler: CommandHandler): void {
    this.commands.set(commandName.toLowerCase(), handler)
  }

  unregister(commandName: string): void {
    this.commands.delete(commandName.toLowerCase())
  }

  async handle(
    rawCommand: string,
    context: Omit<CommandContext, 'commandName' | 'args' | 'rawCommand'>,
  ): Promise<string | null> {
    const parsed = this.parse(rawCommand)
    if (!parsed) return null

    const handler = this.commands.get(parsed.commandName.toLowerCase())
    if (!handler) return null

    return await handler({
      ...context,
      commandName: parsed.commandName,
      args: parsed.args,
      rawCommand,
    })
  }

  private parse(command: string): { commandName: string; args: string } | null {
    const trimmed = command.trim()
    if (!trimmed) return null

    const match = trimmed.match(/^([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+([\s\S]*))?$/)
    if (!match) return null

    return {
      commandName: match[1],
      args: (match[2] ?? '').trim(),
    }
  }
}
