import { z } from 'zod'

const id = z.string().min(1).max(1024)
export const inputTextSchema = z.string().trim().min(1).max(4000)
export const inputRequestSchema = z.object({
  kind: z.literal('input'), id, sessionId: id, question: inputTextSchema,
  recipient: z.object({ kind: z.enum(['user', 'parent', 'caller']), sessionId: id }).strict(),
  origin: z.object({ physicalId: id, toolCallId: id.optional() }).strict(),
  createdAt: z.string().datetime(), deadline: z.string().datetime().nullable(),
}).strict()
export type InputRequest = z.infer<typeof inputRequestSchema>
export interface InputAnswer {
  requestId: string
  text: string
  answeredBy: 'user' | 'parent' | 'caller'
  answeredAt: string
}
export interface InputRecord {
  version: 1
  request: InputRequest
  answer?: InputAnswer
  closed?: { status: 'cancelled' | 'failed'; message: string; at: string }
}

export function parseInputRequest(value: unknown, sessionId: string): InputRequest {
  const request = inputRequestSchema.parse(value)
  if (request.sessionId !== sessionId || (request.recipient.kind !== 'parent' && request.recipient.sessionId !== sessionId)) {
    throw new TypeError('Input request does not belong to this session.')
  }
  return request
}
