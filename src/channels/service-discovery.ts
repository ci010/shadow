import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { writePrivateFile } from '../config/store.ts'

const identifier = z.string().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/)
const messageSchema = z.object({ id: identifier, sender: identifier, text: z.string().max(2000), state: z.enum(['received', 'not_enabled', 'not_triggered']).default('received'), receivedAt: z.number().int().nonnegative() }).strict()
export type GroupObservation = { id: string; sender: string; text: string; triggerEligible?: boolean; state?: 'received' | 'not_enabled' | 'not_triggered' }
const entrySchema = z.object({
  botInstanceId: identifier, platform: z.enum(['qq', 'feishu']), conversationId: identifier,
  messages: z.array(messageSchema).max(20).default([]),
  name: z.string().max(160).optional(), lastSeen: z.number().int().nonnegative(),
}).strict()
export type ServiceDiscovery = z.infer<typeof entrySchema>
const documentSchema = z.object({ version: z.literal(1), projectId: z.string(), entries: z.array(entrySchema).max(200) }).strict()
const retention = 30 * 24 * 60 * 60 * 1000

/** Bounded display-only observations, never an admission policy or Agent history. */
export class ServiceDiscoveryStore {
  private entries: ServiceDiscovery[] = []
  private lastWrite = 0
  constructor(readonly projectId: string, private path: string, private now = Date.now, private readonly changed: () => void = () => {}) {
    if (existsSync(path)) {
      const saved = documentSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
      if (saved.projectId !== projectId) throw new Error('Service discovery project mismatch')
      this.entries = saved.entries
    }
  }
  list(): ServiceDiscovery[] {
    return this.entries.filter(entry => entry.lastSeen > this.now() - retention).map(entry => ({ ...entry, messages: entry.messages.filter(message => message.receivedAt > this.now() - 7 * 24 * 60 * 60 * 1000).map(message => ({ ...message })) }))
  }
  observe(input: Omit<ServiceDiscovery, 'lastSeen' | 'messages'>, message?: GroupObservation): void {
    const parsed = entrySchema.safeParse({ ...input, lastSeen: this.now() })
    if (!parsed.success) return
    const entry = parsed.data
    const entries = this.list()
    const index = entries.findIndex(old => old.botInstanceId === entry.botInstanceId && old.platform === entry.platform && old.conversationId === entry.conversationId)
    const old = entries[index]
    entry.messages = old?.messages ?? []
    if (message) {
      const parsedMessage = messageSchema.safeParse({ id: message.id, sender: message.sender, text: message.text.slice(0, 2000), ...(message.state ? { state: message.state } : {}), receivedAt: this.now() })
      if (parsedMessage.success && !entry.messages.some(item => item.id === message.id)) {
        entry.messages = [...entry.messages, parsedMessage.data].slice(-20)
      }
    }
    if (old && !entry.name && old.name) entry.name = old.name
    if (old && JSON.stringify(old) === JSON.stringify(entry)) return
    if (index >= 0) entries.splice(index, 1)
    entries.unshift(entry)
    this.entries = entries.slice(0, 200)
    this.changed()
    // Bound disk activity even when an untrusted platform floods novel groups.
    // In-memory observations are current; persistence is sampled at most once/minute.
    if (this.lastWrite && this.now() - this.lastWrite < 60_000) return
    this.flush()
  }
  flush(): void {
    if (!this.entries.length) return
    this.entries = this.list()
    mkdirSync(dirname(this.path), { recursive: true })
    writePrivateFile(this.path, JSON.stringify({ version: 1, projectId: this.projectId, entries: this.entries }) + '\n')
    this.lastWrite = this.now()
  }
}
