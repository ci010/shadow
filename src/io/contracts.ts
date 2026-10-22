import { z } from 'zod'

export const IO_VERSION = 1
export const IO_MAX_CHUNK_BYTES = 1024 * 1024
export const IO_MAX_BUFFER_BYTES = 8 * 1024 * 1024
export const IO_LEASE_MS = 15_000
export const IO_FINALIZE_MS = 5_000
export const IO_MAX_RUNS = 8
export const IO_MAX_CLIENTS = 32
export const IO_MAX_UI_NODES = 256
export const IO_MAX_ARTIFACTS = 1024

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
const text = z.string().max(4000)
const finite = z.number().finite()

export const ioSourceSchema = z.object({
  id,
  kind: z.enum(['microphone', 'camera', 'screen', 'file', 'form']),
  mode: z.enum(['pcm', 'frames', 'recording']).optional(),
  intervalMs: z.number().int().min(100).max(60_000).optional(),
  width: z.number().int().min(64).max(1920).optional(),
  height: z.number().int().min(64).max(1080).optional(),
  audio: z.boolean().optional(),
  accept: z.string().max(256).optional(),
}).strict().superRefine((source, ctx) => {
  const modes = source.kind === 'microphone' ? ['pcm', 'recording']
    : ['camera', 'screen'].includes(source.kind) ? ['frames', 'recording'] : []
  if (source.mode && !modes.includes(source.mode)) ctx.addIssue({ code: 'custom', message: 'Invalid mode for source' })
})

export interface IoUiNode {
  id: string
  type: 'column' | 'row' | 'text' | 'button' | 'input' | 'select' | 'table' | 'canvas' | 'media'
  text?: string
  value?: string | number | boolean
  sourceId?: string
  options?: string[]
  rows?: string[][]
  min?: number
  max?: number
  step?: number
  inputType?: 'text' | 'number' | 'checkbox'
  commands?: Array<{ op: 'clear' | 'line' | 'rect' | 'text'; x: number; y: number; x2?: number; y2?: number; text?: string; color?: string }>
  children?: IoUiNode[]
}

const drawingSchema = z.object({
  op: z.enum(['clear', 'line', 'rect', 'text']),
  x: finite.min(-10_000).max(10_000),
  y: finite.min(-10_000).max(10_000),
  x2: finite.min(-10_000).max(10_000).optional(),
  y2: finite.min(-10_000).max(10_000).optional(),
  text: text.optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
}).strict()

const nodeSchema: z.ZodType<IoUiNode> = z.lazy(() => z.object({
  id, type: z.enum(['column', 'row', 'text', 'button', 'input', 'select', 'table', 'canvas', 'media']),
  text: text.optional(),
  value: z.union([text, finite, z.boolean()]).optional(),
  sourceId: id.optional(),
  options: z.array(text).max(100).optional(),
  rows: z.array(z.array(text).max(20)).max(200).optional(),
  min: finite.optional(), max: finite.optional(), step: finite.positive().optional(),
  inputType: z.enum(['text', 'number', 'checkbox']).optional(),
  commands: z.array(drawingSchema).max(2048).optional(),
  children: z.array(nodeSchema).max(IO_MAX_UI_NODES).optional(),
}).strict())

export function parseIoUi(value: unknown): IoUiNode[] {
  let count = 0
  const ids = new Set<string>()
  const walk = (nodes: unknown, depth: number): void => {
    if (depth > 12 || !Array.isArray(nodes)) throw new TypeError('Invalid or excessively deep UI tree')
    for (const node of nodes) {
      if (++count > IO_MAX_UI_NODES || !node || typeof node !== 'object') throw new TypeError('Invalid or oversized UI tree')
      if ('id' in node && typeof node.id === 'string') {
        if (ids.has(node.id)) throw new TypeError('UI IDs must be unique')
        ids.add(node.id)
      }
      if ('children' in node) walk(node.children, depth + 1)
    }
  }
  walk(value, 0)
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 256 * 1024) throw new TypeError('UI tree exceeds 256 KiB')
  return z.array(nodeSchema).parse(value)
}

export const ioDefinitionSchema = z.object({
  version: z.literal(IO_VERSION),
  title: z.string().trim().min(1).max(160),
  purpose: z.string().trim().min(1).max(2000),
  endpoint: z.string().url().max(2048).refine(value => {
    const url = new URL(value)
    return ['ws:', 'wss:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      !url.username && !url.password && !url.hash
  }, 'Use the loopback WebSocket endpoint of the agent-started backend'),
  sources: z.array(ioSourceSchema).min(1).max(8),
  limits: z.object({
    durationMs: z.number().int().min(1000).max(24 * 60 * 60 * 1000),
    maxBytes: z.number().int().min(1024).max(1024 * 1024 * 1024),
  }).strict(),
  ui: z.unknown().optional(),
}).strict()

export type IoSource = z.infer<typeof ioSourceSchema>
export type IoDefinition = Omit<z.infer<typeof ioDefinitionSchema>, 'ui'> & { ui: IoUiNode[] }

export function parseIoDefinition(value: unknown): IoDefinition {
  const parsed = ioDefinitionSchema.parse(value)
  if (new Set(parsed.sources.map(source => source.id)).size !== parsed.sources.length) throw new TypeError('Source IDs must be unique')
  const ui = parseIoUi(parsed.ui ?? [])
  if (new TextEncoder().encode(JSON.stringify({ ...parsed, ui })).byteLength > 256 * 1024) throw new TypeError('I/O definition exceeds 256 KiB')
  const sources = new Set(parsed.sources.map(source => source.id))
  const check = (nodes: IoUiNode[]): void => {
    for (const node of nodes) {
      if (node.sourceId && !sources.has(node.sourceId)) throw new TypeError('UI refers to an unknown source')
      if (node.children) check(node.children)
    }
  }
  check(ui)
  return { ...parsed, ui }
}

export type IoRunStatus = 'awaiting_consent' | 'running' | 'stopping' | 'completed' | 'denied' | 'cancelled' | 'failed' | 'interrupted'
export const IO_TERMINAL = new Set<IoRunStatus>(['completed', 'denied', 'cancelled', 'failed', 'interrupted'])

export interface IoArtifact {
  id: string
  sinkId?: string
  name: string
  mime: string
  size: number
  complete: boolean
  path?: string
}

export interface IoRun {
  version: 1
  id: string
  projectId: string
  sessionId: string
  revision: string
  definition: IoDefinition
  status: IoRunStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  clientId?: string
  bytes: number
  error?: string
  artifacts: IoArtifact[]
  backendStatus?: 'connecting' | 'ready' | 'disconnected'
  message?: string
  ui?: IoUiNode[]
}

export interface IoCapability {
  id: string
  kind: 'source' | 'sink' | 'processor'
  available: boolean
  reason?: string
  requiresGesture: boolean
}

export interface IoClient {
  id: string
  name: string
  capabilities: IoCapability[]
  lastSeen: number
}

export const ioClientSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  capabilities: z.array(z.object({
    id: z.string().min(1).max(64),
    kind: z.enum(['source', 'sink', 'processor']),
    available: z.boolean(),
    reason: z.string().max(512).optional(),
    requiresGesture: z.boolean(),
  }).strict()).max(32),
}).strict()

export interface IoPacket {
  type: 'data' | 'ui' | 'start' | 'end'
  sourceId?: string
  mime?: string
  base64?: string
  value?: unknown
  timestamp?: number
  id?: string
}

export const ioOutputSchema = z.object({
  mime: z.string().regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[ a-zA-Z0-9=,._-]+)?$/).max(128),
  base64: z.string().max(Math.ceil(IO_MAX_CHUNK_BYTES / 3) * 4).optional(),
  text: z.string().max(IO_MAX_CHUNK_BYTES).optional(),
}).strict().refine(output => (output.base64 === undefined) !== (output.text === undefined), 'Provide exactly one of base64 or text')
export type IoOutput = z.infer<typeof ioOutputSchema>

export interface IoRelayEffect {
  method: 'ui.render' | 'preview' | 'status' | 'artifact'
  args: unknown[]
}

export interface IoRelayUpdate {
  sequence: number
  effect: IoRelayEffect
}

export class IoError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503 = 400) {
    super(message)
    this.name = 'IoError'
  }
}
