import { z } from 'zod'
import { inlineInputQuestionsSchema, inlineInputAnswersSchema, type InputRequest } from '../../src/sessions/input-request.ts'
import { answerMediaSchema, MAX_ANSWER_ATTACHMENTS } from '../../src/sessions/answer-media.ts'

const questionsSchema = inlineInputQuestionsSchema
const callSchema = z.union([
  questionsSchema.element.transform(question => [question]),
  z.object({ questions: questionsSchema }).strict().transform(value => value.questions),
])
const answersSchema = inlineInputAnswersSchema
  .refine(answers => answers.reduce((count, answer) => count + ('text' in answer ? answer.media?.length ?? 0 : 0), 0) <= MAX_ANSWER_ATTACHMENTS)
const receiptSchema = z.object({
  requestId: z.string().min(1), text: z.string().min(1), answeredBy: z.literal('user'), answeredAt: z.string().datetime(),
  answers: answersSchema, media: answerMediaSchema.optional(),
}).strict()

export type InlineAskQuestion = z.infer<typeof questionsSchema>[number]
export type InlineAskAnswer = z.infer<typeof answersSchema>[number]
export type InlineAskReceipt = z.infer<typeof receiptSchema>
export type InlineAskRequest = InputRequest & { questions: InlineAskQuestion[] }
export function isInlineAskRequest(request: InputRequest | object | null | undefined): request is InlineAskRequest {
  return !!request && 'questions' in request && Array.isArray(request.questions)
}
export function parseInlineAskCall(args: unknown): InlineAskQuestion[] | undefined {
  return callSchema.safeParse(args).data
}
export function validateInlineAnswers(questions: readonly InlineAskQuestion[], value: unknown): InlineAskAnswer[] | undefined {
  const parsed = answersSchema.safeParse(value)
  if (!parsed.success || parsed.data.length !== questions.length || !parsed.data.every((answer, index) =>
    !('option' in answer) || questions[index]!.options.includes(answer.option))) return
  return parsed.data
}
export function parseInlineAskReceipt(questions: readonly InlineAskQuestion[], value: unknown): InlineAskReceipt | undefined {
  const parsed = receiptSchema.safeParse(value)
  if (parsed.success && validateInlineAnswers(questions, parsed.data.answers)) return parsed.data
}
export function matchesInlineAnswers(actual: readonly InlineAskAnswer[], expected: readonly InlineAskAnswer[]): boolean {
  return actual.length === expected.length && actual.every((answer, index) => {
    const sent = expected[index]!
    return 'option' in answer ? 'option' in sent && answer.option === sent.option
      : 'text' in sent && answer.text === sent.text && JSON.stringify(answer.media ?? []) === JSON.stringify(sent.media ?? [])
  })
}
export function inlineAnswerTarget(answers: readonly (InlineAskAnswer | undefined)[], focused?: number): number {
  if (focused !== undefined && focused >= 0 && focused < answers.length) return focused
  return answers.findIndex(answer => !answer)
}
