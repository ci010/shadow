import { createHash } from 'node:crypto'
import type { McpServerConfig } from '../config/schema.ts'
import type { McpToolInfo } from './client.ts'
import { parseMcpServerConfig } from './config.ts'

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort()
    .filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .map(key => [key, ordered((value as Record<string, unknown>)[key])]))
}

export function mcpMetadataFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex')
}

export interface McpReadOnlyPolicy {
  readOnly: boolean | undefined
  source: 'reviewed-override' | 'stale-review' | 'trusted-hint' | 'untrusted-hint' | 'unknown'
  fingerprint: string
}

export function mcpReadOnlyPolicy(config: McpServerConfig, tool: McpToolInfo): McpReadOnlyPolicy {
  const { trustReadOnlyHints, readOnlyOverrides, name } = parseMcpServerConfig(config.name, config)
  // Public review identities must not expose hashes of credentials or private connection arguments.
  const fingerprint = mcpMetadataFingerprint({ server: name, tool })
  const override = Object.hasOwn(readOnlyOverrides ?? {}, tool.name) ? readOnlyOverrides![tool.name] : undefined
  if (override) {
    return override.fingerprint === fingerprint
      ? { readOnly: override.readOnly, source: 'reviewed-override', fingerprint }
      : { readOnly: undefined, source: 'stale-review', fingerprint }
  }
  if (typeof tool.readOnlyHint === 'boolean') {
    return trustReadOnlyHints === true
      ? { readOnly: tool.readOnlyHint, source: 'trusted-hint', fingerprint }
      : { readOnly: undefined, source: 'untrusted-hint', fingerprint }
  }
  return { readOnly: undefined, source: 'unknown', fingerprint }
}
