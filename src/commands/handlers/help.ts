import type { CommandDispatcher, SlashCommandHandler } from '../index.ts'

export function createHelpCommand(
  dispatcher: CommandDispatcher,
): SlashCommandHandler {
  return {
    name: 'help',
    description: 'List all available slash commands.',
    adminOnly: true,
    async execute(): Promise<string> {
      const lines = [
        'Available slash commands:',
        '',
        ...dispatcher.getHandlers().map((handler) =>
          `- /${handler.name} — ${handler.description}`
        ),
      ]
      return lines.join('\n')
    },
  }
}
