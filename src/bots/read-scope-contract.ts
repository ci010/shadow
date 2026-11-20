import { z } from 'zod'

export const RegisteredReadFoldersSchema = z.array(z.string().uuid()).max(16)
  .refine(ids => new Set(ids).size === ids.length, 'Unique source folders required')

/** Owner-authored whole views; absent fields grant nothing. Legacy folder fields
 * describe existing platform capabilities and keep their original backends. */
export const ReadResourcesSchema = z.object({
  folders: RegisteredReadFoldersSchema.optional(),
  knowledge: z.boolean().optional(),
  wiki: z.boolean().optional(),
}).strict()
export type ReadResources = z.infer<typeof ReadResourcesSchema>
