import { z } from 'zod'

export const WORK_KEY_PATTERN = '^work:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
export const workKeySchema = z.string().length(41, 'Expected a canonical Work key (work:<uuid>).').regex(new RegExp(WORK_KEY_PATTERN), 'Expected a canonical Work key (work:<uuid>).')
