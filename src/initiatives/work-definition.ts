import { z } from 'zod'

export const WORK_DEFINITION_MAX_LENGTH = 8000
export const workDefinitionSchema = z.string().transform(value => value.replace(/\r\n?/g, '\n').trim())
  .pipe(z.string().min(1).max(WORK_DEFINITION_MAX_LENGTH))

export const WORK_DEFINITION_GUIDANCE = 'Write free Markdown describing the desired outcome, how to tell it is met, relevant boundaries, and source evidence when available. No fixed headings are required. Cite only real sources; note uncertainty instead of inventing evidence. Keep shared progress in summary and transient planning in the session. Definition text is not validated evidence or authorization.'
