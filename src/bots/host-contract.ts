import { z } from 'zod'

export const BotHostCapabilities = z.array(z.enum(['wake', 'watermark', 'messages', 'work', 'send'])).max(5)
export const BotHostScopeSchema = z.object({
  projectId: z.string().min(1).max(512), botId: z.string().min(1).max(128),
  revision: z.string().min(1).max(512), bindingKey: z.string().min(1).max(2048),
  sessionId: z.string().min(1).max(512),
  address: z.object({ projectId: z.string(), botInstanceId: z.string(), platform: z.enum(['discord', 'qq', 'feishu']), conversationId: z.string().min(1).max(512), legacySessionId: z.literal(true).optional() }).strict(),
}).strict()
export type BotHostScope = z.infer<typeof BotHostScopeSchema>
export type BotHostCapability = z.infer<typeof BotHostCapabilities>[number]
export const BotWakeSchema = BotHostScopeSchema.extend({ intervalMinutes: z.number().int().min(1).max(10080) }).strict()
export type BotWake = z.infer<typeof BotWakeSchema>
