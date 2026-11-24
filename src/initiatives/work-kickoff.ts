import { z } from 'zod'
import { workKeySchema } from './work-key.ts'

/** Internal Project inbox wire format. No caller-supplied reply, media, or authority. */
export const workKickoffSchema = z.strictObject({
  key: workKeySchema,
  target: z.string().regex(/^work-executor:[a-f0-9]{40}$/),
  revision: z.number().int().positive(),
  input: z.strictObject({
    id: z.string().regex(/^work-start:[a-f0-9]{40}$/),
    kind: z.literal('message'),
    timestamp: z.string().datetime(),
    policy: z.literal('queue'),
    source: z.strictObject({ kind: z.literal('event'), eventId: z.string(), type: z.literal('work-assignment'), source: z.literal('system') }),
    content: z.string().min(1).refine(text => Buffer.byteLength(text) <= 128 * 1024, 'Kickoff exceeds 128 KiB'),
  }),
}).refine(row => row.input.id === row.input.source.eventId && row.input.id.slice('work-start:'.length) === row.target.slice('work-executor:'.length), 'Invalid kickoff identity')

export type WorkKickoff = z.infer<typeof workKickoffSchema>
export type WorkKickoffReceipt = WorkKickoff & { physicalId?: string; state: 'pending' | 'recorded' | 'inspect' | 'invalid'; inspectReason?: string }
export type WorkKickoffStamp = Pick<WorkKickoff, 'key' | 'target' | 'revision'> & { id: string }
