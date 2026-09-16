import type { SessionConfig } from '../../sessions/session-store.ts'
import type { SessionManager } from '../../sessions/session-manager.ts'
import type { SlashCommandHandler } from '../index.ts'
import { parseYieldPolicy } from '../../sessions/yield-contract.ts'

const CONFIG_KEYS = [
  'triggerMode',
  'model',
  'temperature',
  'maxTokens',
  'defaultShell',
  'yield',
] as const
type ConfigKey = typeof CONFIG_KEYS[number]

export function createConfigCommand(
  sessions: SessionManager,
): SlashCommandHandler {
  return {
    name: 'config',
    description: 'Read or change per-session config for the current session.',
    adminOnly: true,
    async execute(ctx, args): Promise<string> {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const action = (parts.shift() ?? 'get').toLowerCase()

      switch (action) {
        case 'get':
          return await formatConfigResponse(ctx.sessionId, sessions)
        case 'set': {
          const key = parseKey(parts.shift())
          if (!key) {
            return `Error: invalid config key. Allowed keys: ${
              CONFIG_KEYS.join(', ')
            }`
          }
          const rawValue = parts.join(' ')
          if (!rawValue) {
            return 'Error: set requires a value.'
          }
          const patch = parseConfigValue(key, rawValue)
          if (typeof patch === 'string') return patch
          if (key === 'yield') await sessions.applySessionConfigPatch(ctx.sessionId, { set: patch, unset: [] }, true)
          else await sessions.setSessionConfig(ctx.sessionId, patch)
          return [
            `Updated ${key} for ${ctx.sessionId}.`,
            '',
            await formatConfigResponse(ctx.sessionId, sessions),
          ].join('\n')
        }
        case 'unset': {
          const key = parseKey(parts.shift())
          if (!key) {
            return `Error: unset requires one of: ${CONFIG_KEYS.join(', ')}`
          }
          await sessions.unsetSessionConfig(ctx.sessionId, key)
          return [
            `Unset ${key} for ${ctx.sessionId}.`,
            '',
            await formatConfigResponse(ctx.sessionId, sessions),
          ].join('\n')
        }
        case 'reset':
          await sessions.resetSessionConfig(ctx.sessionId)
          return [
            `Reset all session config for ${ctx.sessionId}.`,
            '',
            await formatConfigResponse(ctx.sessionId, sessions),
          ].join('\n')
        default:
          return 'Error: use `/config get`, `/config set <key> <value>`, `/config unset <key>`, or `/config reset`.'
      }
    },
  }
}

async function formatConfigResponse(
  sessionKey: string,
  sessions: SessionManager,
): Promise<string> {
  const config = await sessions.getSessionConfig(sessionKey)

  return [
    `Session config for ${sessionKey}:`,
    '',
    '```json',
    JSON.stringify(config, null, 2),
    '```',
  ].join('\n')
}

function parseKey(raw: string | undefined): ConfigKey | null {
  if (!raw) return null
  return CONFIG_KEYS.includes(raw as ConfigKey) ? raw as ConfigKey : null
}

function parseConfigValue(
  key: ConfigKey,
  rawValue: string,
): Partial<SessionConfig> | string {
  switch (key) {
    case 'yield': {
      try {
        return { yield: parseYieldPolicy({ timeoutMs: rawValue === 'wait' || rawValue === 'null' ? null : Number(rawValue) }) }
      } catch (error) {
        if (!(error instanceof TypeError)) throw error
        return `Error: use \`/config set yield wait\` or a positive integer timeout in milliseconds. ${error.message}`
      }
    }
    case 'triggerMode':
      if (rawValue !== 'all' && rawValue !== 'mention') {
        return 'Error: triggerMode must be `all` or `mention`.'
      }
      return { triggerMode: rawValue }
    case 'model':
      return { model: rawValue }
    case 'temperature': {
      const value = Number(rawValue)
      if (!Number.isFinite(value)) {
        return 'Error: temperature must be a finite number.'
      }
      return { temperature: value }
    }
    case 'maxTokens': {
      const value = Number(rawValue)
      if (!Number.isInteger(value) || value <= 0) {
        return 'Error: maxTokens must be a positive integer.'
      }
      return { maxTokens: value }
    }
    case 'defaultShell': {
      const value = rawValue.trim().toLowerCase()
      if (
        !['cmd', 'sh', 'bash', 'git-bash', 'powershell', 'pwsh', 'node']
          .includes(value)
      ) {
        return 'Error: defaultShell must be one of `cmd`, `sh`, `bash`, `git-bash`, `powershell`, `pwsh`, or `node`.'
      }
      return { defaultShell: value as SessionConfig['defaultShell'] }
    }
  }
}
