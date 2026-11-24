import { z } from 'zod'
import { DiscordChannelSchema, FeishuChannelSchema, QQChannelSchema, WeChatChannelSchema } from '../config/schema.ts'

/** Legacy application channel configuration is retained for reading old config
 * files. Project Connections accept only transport options, never BOT policy. */
const business = { allowFrom: true, adminChats: true, trustedChats: true } as const
export const connectionSchemas = {
  qq: QQChannelSchema.omit({ ...business, triggerMode: true }).strict(),
  feishu: FeishuChannelSchema.omit(business).strict(),
  discord: DiscordChannelSchema.omit({ ...business, triggerMode: true }).strict(),
  wechat: WeChatChannelSchema.omit(business).strict(),
}
export function parseConnectionConfig(platform: keyof typeof connectionSchemas, raw: unknown) {
  return connectionSchemas[platform].parse(raw)
}
export const BotConnectionPolicy = z.object({
  allowFrom: z.array(z.string().min(1).max(512)).max(1000).optional(),
  adminChats: z.array(z.string().min(1).max(16384)).max(1000).optional(),
  trustedChats: z.array(z.string().min(1).max(16384)).max(1000).optional(),
  triggerMode: z.enum(['mention', 'all']).optional(),
}).strict()
