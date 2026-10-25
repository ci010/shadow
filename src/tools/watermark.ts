import { z } from 'zod'
import type { Tool, ToolParameters } from './tool.ts'
import type { ExecutionContext } from './context.ts'
import { Watermarks } from '../watermarks/store.ts'
const request = z.object({ action: z.enum(['inspect', 'prepare', 'claim', 'ack', 'retry']),
  consumer: z.string().min(1).max(256), source: z.string().optional(), from: z.string().nullable().optional(),
  to: z.string().nullable().optional(), id: z.string().optional(), attempt: z.string().optional(), error: z.string().optional() }).strict()
/** Sessions may manage only their own bookkeeping namespace. No source access is granted. */
export class WatermarkTool implements Tool {
  readonly name = 'watermark'
  readonly description = 'Durable session-owned incremental consumption bookkeeping. Inspect/prepare/claim/ack/retry. Does not read sources, authorize Discord, send messages, or provide exactly-once delivery. Ack only after successful processing.'
  readonly parameters: ToolParameters = { type: 'object', properties: {
    action: { type: 'string', enum: ['inspect', 'prepare', 'claim', 'ack', 'retry'] }, consumer: { type: 'string' },
    source: { type: 'string' }, from: { type: 'string', description: 'Opaque cursor; omit for initial null cursor.' }, to: { type: 'string', description: 'Opaque cursor; omit for initial null cursor.' },
    id: { type: 'string' }, attempt: { type: 'string' }, error: { type: 'string' },
  }, required: ['action', 'consumer'] }
  constructor(private workspace: string, private projectId: string) {}
  async execute(args: Record<string, unknown>, context?: ExecutionContext): Promise<string> {
    if (!context?.sessionId || context.projectId !== this.projectId) throw new Error('Project session required')
    const a = request.parse(args)
    const store = new Watermarks(this.workspace, this.projectId, JSON.stringify(['session', context.sessionId, a.consumer]))
    const required = (v: string | undefined) => z.string().min(1).parse(v)
    let result: unknown
    switch (a.action) {
      case 'inspect': result = store.inspect(); break
      case 'prepare': result = store.prepare(required(a.source), a.from ?? null, a.to ?? null); break
      case 'claim': result = store.claim(required(a.id), required(a.attempt)); break
      case 'ack': result = store.ack(required(a.id), required(a.attempt)); break
      case 'retry': result = store.retry(required(a.id), required(a.attempt), required(a.error)); break
    }
    return JSON.stringify(result)
  }
}
