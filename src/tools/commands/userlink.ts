import type { IdentityManager } from '../../agent/identity.ts'
import type { Bus } from '../../bus/bus.ts'
import { writeFile } from 'node:fs/promises'
import { readFileIfExists, workspacePath } from '../../utils/paths.ts'
import type { CommandContext, CommandHandler } from './command-handler.ts'

export function createUserLinkCommandHandler(
  workspace: string,
  identity: IdentityManager,
  bus: Bus,
): CommandHandler {
  return async (ctx: CommandContext): Promise<string | null> => {
    if (ctx.commandName.toLowerCase() !== 'userlink') return null

    if (!ctx.channel || !ctx.senderId) {
      return 'Error: userlink requires active inbound user context (channel + sender).'
    }

    const args = splitArgs(ctx.args)
    const subcommand = args[0]?.toLowerCase()

    if (subcommand === 'verify') {
      const targetChannel = args[1]
      const targetSenderId = args[2]
      if (!targetChannel || !targetSenderId) {
        return 'Error: usage is userlink verify <targetChannel> <targetSenderId>'
      }

      try {
        const challenge = await identity.createLinkChallenge(
          ctx.channel,
          ctx.senderId,
          targetChannel,
          targetSenderId,
        )

        if (!challenge.targetChatId) {
          return [
            `Error: target account ${targetChannel}:${targetSenderId} has no known chat session yet.`,
            'Ask that account to send one message first, then retry verification.',
          ].join('\n')
        }

        const content = [
          `Identity confirmation request: another channel claims to be you (profile: ${challenge.requesterProfileName}).`,
          `If this is correct, reply with: userlink confirm ${challenge.code}`,
          `Code expires at: ${challenge.expiresAt}`,
        ].join('\n')
        bus.emit('message.outbound', {
          channel: challenge.targetChannel,
          chatId: challenge.targetChatId,
          done: true,
          content,
          event: 'response',
        })

        return [
          `Verification request sent to ${challenge.targetChannel}:${challenge.targetSenderId}.`,
          `Waiting for confirmation code ${challenge.code}.`,
        ].join('\n')
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    if (subcommand === 'confirm') {
      const code = args[1]
      if (!code) {
        return 'Error: usage is userlink confirm <code>'
      }

      try {
        const linked = await identity.confirmLink(
          ctx.channel,
          ctx.senderId,
          code,
        )
        await ensureProfileFile(workspace, linked.profileName)
        return [
          'SUCCESS: Cross-channel identity link confirmed.',
          `  Profile: ${linked.profileName}`,
          `  Linked accounts: ${linked.requesterAccountKey} ↔ ${linked.targetAccountKey}`,
        ].join('\n')
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    const rawName = ctx.args.trim().replace(/^['"]|['"]$/g, '')
    if (!rawName) {
      return [
        'Error: usage is userlink <Name>',
        'Or: userlink verify <targetChannel> <targetSenderId>',
        'Or: userlink confirm <code>',
      ].join('\n')
    }

    const assigned = await identity.assignProfile(
      ctx.channel,
      ctx.senderId,
      rawName,
    )
    await ensureProfileFile(workspace, assigned.profileName)

    return [
      `SUCCESS: User profile linked.`,
      `  Name: ${assigned.profileName}`,
      `  Account: ${assigned.accountKey}`,
      `  Profile file: ${assigned.profilePath}`,
    ].join('\n')
  }
}

function splitArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let inQuote = false
  let quoteChar = ''

  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (inQuote) {
      if (char === quoteChar) {
        inQuote = false
      } else {
        current += char
      }
      continue
    }

    if (char === '"' || char === "'") {
      inQuote = true
      quoteChar = char
      continue
    }

    if (char === ' ' || char === '\t') {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (current) args.push(current)
  return args
}

async function ensureProfileFile(
  workspace: string,
  profileName: string,
): Promise<void> {
  const relativePath = `memory/identities/${profileName}.md`
  const absolutePath = workspacePath(workspace, relativePath)
  const existing = await readFileIfExists(absolutePath)
  if (existing?.trim()) return

  const content = [
    `# ${profileName}`,
    '',
    '## Summary',
    '- (fill in key traits here)',
    '',
    '## Preferences',
    '- (communication style, language, tone, etc.)',
    '',
    '## Facts',
    '- (stable facts learned from conversation)',
    '',
  ].join('\n')

  await writeFile(absolutePath, content)
}
