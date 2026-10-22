import { z } from 'zod'
import { t } from './i18n.ts'
import { workRecordSchema } from '../../src/initiatives/work-contract.ts'

const agreementSchema = workRecordSchema.extend({
  contextChanged: z.boolean().optional(),
  authority: z.object({ manager: z.string().nullable(), executor: z.string().nullable(), active: z.boolean() }),
  history: z.array(z.object({ kind: z.string(), actor: z.string(), at: z.string(), data: z.unknown() })),
})
const viewSchema = z.object({
  selected: z.string().optional(),
  records: z.array(agreementSchema),
  effects: z.array(z.object({ id: z.string(), sessionId: z.string(), tool: z.string(), status: z.string() })),
})
export type WorkAgreement = z.infer<typeof agreementSchema>
export type WorkView = z.infer<typeof viewSchema>
export function parseWorkView(value: unknown): WorkView {
  const result = viewSchema.safeParse(value)
  if (!result.success) throw new Error(t('Invalid work alignment response.'))
  return result.data
}
