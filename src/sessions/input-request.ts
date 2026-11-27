import { z } from 'zod'
import { workDecisionContextSchema } from '../initiatives/work-notes.ts'
import { answerMediaSchema } from './answer-media.ts'

const id = z.string().min(1).max(1024)
export const inputTextSchema = z.string().trim().min(1).max(4000)
const inlineOptionSchema = z.string().min(1).max(4000).refine(option => option.trim().length > 0)
export const inlineInputQuestionsSchema = z.array(z.object({
  content: inputTextSchema,
  options: z.tuple([inlineOptionSchema, inlineOptionSchema]).refine(([a, b]) => a.trim() !== b.trim()),
}).strict()).min(1).max(3)
const inlineInputAnswerSchema = z.union([
  z.object({ option: inlineOptionSchema }).strict(),
  z.object({ text: inputTextSchema, media: answerMediaSchema.optional() }).strict(),
])
export const inlineInputAnswersSchema = z.array(inlineInputAnswerSchema).min(1).max(3)
export const inputRequestSchema = z.object({
  kind: z.literal('input'), id, sessionId: id, question: inputTextSchema,
  questions: inlineInputQuestionsSchema.optional(),
  recipient: z.object({ kind: z.enum(['user', 'parent', 'caller']), sessionId: id }).strict(),
  origin: z.object({ physicalId: id, toolCallId: id.optional() }).strict(),
  createdAt: z.string().datetime(), deadline: z.string().datetime().nullable(),
  workContext: workDecisionContextSchema.optional(),
}).strict()
export type InputRequest = z.infer<typeof inputRequestSchema>
export interface InputAnswer {
  requestId: string
  text: string
  answeredBy: 'user' | 'parent' | 'caller'
  answeredAt: string
  media?: string[]
  answers?: z.infer<typeof inlineInputAnswersSchema>
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
  if (request.questions && (request.recipient.kind !== 'user' || request.question !== request.questions[0].content)) {
    throw new TypeError('An inline round requires a user recipient and matching fallback question.')
  }
  return request
}
