import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { Task, TaskState } from '@a2a-js/sdk'
import { writePrivateFile } from '../config/store.ts'

const id = z.string().uuid()
const taskSchema = z.object({
  id, contextId: id,
  status: z.object({ state: z.string(), timestamp: z.string().datetime() }).passthrough(),
}).passthrough()
const inboundSchema = z.object({
  version: z.literal(1), owner: z.string().min(1), sessionId: z.string().startsWith('a2a:'),
  messageId: z.string().min(1).max(256), fingerprint: z.string().length(64),
  replies: z.array(z.object({ messageId: z.string().min(1).max(256), fingerprint: z.string().length(64) }).strict()).max(64).optional(),
  task: taskSchema,
}).strict()
export interface InboundTask {
  version: 1
  owner: string
  sessionId: string
  messageId: string
  fingerprint: string
  replies?: { messageId: string; fingerprint: string }[]
  task: Task
}
export const OutboundCallSchema = z.object({
  version: z.literal(1), id, owner: z.string().min(1), agent: z.string().min(1),
  key: z.string().min(1), fingerprint: z.string().length(64), messageId: id,
  endpointUrl: z.string().url(), contextId: z.string().max(512).optional(), taskId: z.string().max(512).optional(),
  status: z.enum(['sending', 'submitted', 'input-required', 'auth-required', 'completed', 'failed', 'cancelled', 'rejected', 'uncertain']),
  notification: z.enum(['pending', 'delivering', 'delivered', 'uncertain']).optional(),
  notificationRevision: z.string().optional(),
  notificationError: z.string().optional(),
  trackingError: z.string().optional(),
  replyTo: id.optional(),
  conversationId: id.optional(),
  previous: id.optional(),
  result: z.unknown().optional(),
}).strict()
export type OutboundCall = z.infer<typeof OutboundCallSchema>
export const terminal = (task: Task): boolean => [
  TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED,
].includes(task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED)
export const interrupted = (task: Task): boolean => [
  TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED,
].includes(task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED)

export class A2aStore {
  readonly inbound = new Map<string, InboundTask>()
  readonly outbound = new Map<string, OutboundCall>()

  constructor(private readonly directory: string) {}

  init(): void {
    for (const kind of ['inbound', 'outbound'] as const) {
      const directory = join(this.directory, kind)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const files = readdirSync(directory).filter(name => name.endsWith('.json'))
      if (files.length > 10_000) throw new Error('A2A task storage limit exceeded.')
      for (const file of files) {
        id.parse(file.slice(0, -5))
        const text = readFileSync(join(directory, file), 'utf8')
        if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('A2A task record is too large.')
        const raw: unknown = JSON.parse(text)
        if (kind === 'inbound') {
          const parsed = inboundSchema.parse(raw)
          const task = Task.fromJSON(parsed.task)
          if (!task.status || task.status.state <= 0 || task.id !== file.slice(0, -5)) throw new Error('Invalid A2A task record.')
          this.inbound.set(task.id, { ...parsed, task })
        } else {
          const call = OutboundCallSchema.parse(raw)
          if (call.id !== file.slice(0, -5)) throw new Error('Invalid A2A call record.')
          this.outbound.set(call.id, call)
        }
      }
    }
  }

  saveTask(record: InboundTask): void {
    const raw = inboundSchema.parse({ ...record, task: Task.toJSON(record.task) })
    this.write('inbound', record.task.id, raw, this.inbound.has(record.task.id))
    this.inbound.set(record.task.id, structuredClone(record))
  }

  saveCall(call: OutboundCall): void {
    this.write('outbound', call.id, OutboundCallSchema.parse(call), this.outbound.has(call.id))
    this.outbound.set(call.id, structuredClone(call))
  }

  private write(kind: 'inbound' | 'outbound', key: string, record: unknown, exists: boolean): void {
    id.parse(key)
    if (!exists && this[kind].size >= 10_000) throw new Error('A2A task storage limit reached; archive records while stopped.')
    const text = JSON.stringify(record) + '\n'
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('A2A task record is too large.')
    try { writePrivateFile(join(this.directory, kind, `${key}.json`), text) }
    catch (error) {
      console.error('[a2a] Could not persist task record', error)
      throw new Error('A2A persistence failed. Consult Project diagnostics.', { cause: error })
    }
  }
}
