import { requireLoopbackOrigin } from './connection.js'

export type RuntimeEndpointMessage =
  | { type: 'shadow:runtime-ready'; apiBase: string }
  | { type: 'shadow:runtime-stopped' }

export function parseRuntimeEndpointMessage(value: unknown): RuntimeEndpointMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  if (data.type === 'shadow:runtime-stopped' && Object.keys(data).length === 1) return { type: data.type }
  if (data.type !== 'shadow:runtime-ready' || Object.keys(data).length !== 2) return null
  try {
    return { type: data.type, apiBase: requireLoopbackOrigin(data.apiBase) }
  } catch { return null }
}
