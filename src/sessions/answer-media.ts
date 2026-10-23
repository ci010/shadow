import { z } from 'zod'

export const MAX_ANSWER_ATTACHMENTS = 32
export const answerMediaSchema = z.array(z.string().min(1).max(4096)).min(1).max(MAX_ANSWER_ATTACHMENTS)
