import type { z } from 'zod'
export const desktopErrorCodes: z.ZodType<string>
export const diagnosticReasons: ReadonlySet<string>
export const nativeResponse: z.ZodType<{ result: unknown } | { error: { code: string; reason?: string } }>
