import { z } from 'zod'
import { discordPermissions, DiscordPermission as Permission } from './discord-permissions.ts'
import type { DiscordDirectory, DiscordInspection, DiscordLocation, DiscordMember } from './integration-contract.ts'

export type DiscordApi = (path: string, init?: RequestInit) => Promise<unknown>
const id = z.string().regex(/^[0-9]{1,20}$/)
const user = z.object({ id, username: z.string(), global_name: z.string().nullable().optional(), bot: z.boolean().optional() })
const role = z.object({ id, name: z.string(), permissions: z.string().regex(/^[0-9]+$/) })
const overwrite = z.object({ id, type: z.union([z.literal(0), z.literal(1)]), allow: z.string(), deny: z.string() })
const channelSchema = z.object({
  id, type: z.number().int(), name: z.string().optional(), guild_id: id.optional(),
  parent_id: id.nullable().optional(), permission_overwrites: z.array(overwrite).optional(),
  recipients: z.array(user).optional(),
  thread_metadata: z.object({ archived: z.boolean(), locked: z.boolean() }).optional(),
})
const memberSchema = z.object({ user, roles: z.array(id), nick: z.string().nullable().optional(),
  communication_disabled_until: z.string().datetime({ offset: true }).nullable().optional() })
const guildSchema = z.object({ id, name: z.string(), owner_id: id })
const thread = (type: number) => [10, 11, 12].includes(type)
// Forum parents are assignment containers only. Conversation inspection below still
// admits messages/history solely in supported text channels and public threads.
const supported = (type: number) => [0, 5, 10, 11, 15].includes(type)
const has = (permissions: bigint, bits: bigint) => (permissions & bits) === bits

export async function discordBotIdentity(api: DiscordApi, signal: AbortSignal): Promise<string> {
  const bot = user.parse(await api('/users/@me', { signal }))
  if (bot.bot !== true) throw new Error('Discord connection is not a Bot identity.')
  return bot.id
}

export async function discordMembers(api: DiscordApi, guildId: string, query: string, signal: AbortSignal): Promise<DiscordMember[]> {
  id.parse(guildId)
  z.string().trim().min(1).max(100).parse(query)
  const values = z.array(memberSchema).max(25).parse(await api(
    `/guilds/${guildId}/members/search?query=${encodeURIComponent(query.trim())}&limit=25`, { signal }))
  if (new Set(values.map(member => member.user.id)).size !== values.length) throw new Error('Discord returned duplicate member IDs.')
  return values.filter(member => !member.user.bot).map(member => ({
    id: member.user.id, name: member.nick ?? member.user.global_name ?? member.user.username, username: member.user.username,
  }))
}

async function guildFacts(api: DiscordApi, guildId: string, botId: string, signal: AbortSignal) {
  id.parse(guildId)
  const [rawGuild, rawRoles, rawBot] = await Promise.all([
    api(`/guilds/${guildId}`, { signal }), api(`/guilds/${guildId}/roles`, { signal }),
    api(`/guilds/${guildId}/members/${botId}`, { signal }),
  ])
  const guild = guildSchema.parse(rawGuild), roles = z.array(role).parse(rawRoles), bot = memberSchema.parse(rawBot)
  if (guild.id !== guildId || bot.user.id !== botId || bot.user.bot === false) throw new Error('Discord returned another server or Bot membership.')
  if (new Set(roles.map(role => role.id)).size !== roles.length) throw new Error('Discord returned duplicate role IDs.')
  return { guild, roles, bot }
}

export async function discordDirectory(api: DiscordApi, signal: AbortSignal, guildId?: string, after?: string): Promise<DiscordDirectory> {
  if (after) id.parse(after)
  const botUserId = await discordBotIdentity(api, signal)
  const guilds = z.array(z.object({ id, name: z.string(), icon: z.string().nullable() })).max(200).parse(
    await api(`/users/@me/guilds?limit=200${after ? `&after=${after}` : ''}`, { signal }),
  )
  if (new Set(guilds.map(guild => guild.id)).size !== guilds.length || guilds.some(guild => after && BigInt(guild.id) <= BigInt(after))) {
    throw new Error('Discord returned an invalid server page.')
  }
  const result: DiscordDirectory = {
    botUserId, guilds, guildCursor: guilds.length === 200 ? guilds.reduce((last, guild) => BigInt(guild.id) > BigInt(last) ? guild.id : last, '0') : null,
    guildId: guildId ?? null, channels: [], roles: [], synchronizedAt: new Date().toISOString(),
    completeness: 'guild-page',
    notice: 'Only Bot-accessible resources are shown. Archived and private threads are not enumerated.',
  }
  if (!guildId) return result
  const [{ guild, roles, bot }, rawChannels, rawThreads] = await Promise.all([
    guildFacts(api, guildId, botUserId, signal),
    api(`/guilds/${id.parse(guildId)}/channels`, { signal }),
    api(`/guilds/${guildId}/threads/active`, { signal }),
  ])
  if (!result.guilds.some(entry => entry.id === guild.id)) result.guilds.push({ id: guild.id, name: guild.name, icon: null })
  const channels = z.array(channelSchema).parse(rawChannels)
  const threads = z.object({ threads: z.array(channelSchema) }).parse(rawThreads).threads
  const all = [...channels, ...threads]
  if (new Set(all.map(item => item.id)).size !== all.length) throw new Error('Discord returned duplicate channel IDs.')
  for (const channel of all) {
    if (channel.guild_id && channel.guild_id !== guildId) throw new Error('Discord channel belongs to another server.')
    const parent = thread(channel.type) ? channels.find(item => item.id === channel.parent_id) : channel
    if (!parent?.permission_overwrites) {
      if (thread(channel.type)) continue
      throw new Error('Discord channel permission metadata is unavailable.')
    }
    const bits = discordPermissions(guildId, botUserId, guild.owner_id, roles, bot, parent.permission_overwrites)
    const canView = has(bits, Permission.view)
    if (!canView) continue
    const writable = (!bot.communication_disabled_until || Date.parse(bot.communication_disabled_until) <= Date.now()) &&
      // For a forum, canSend means replying inside its posts, not creating a post.
      has(bits, thread(channel.type) || channel.type === 15 ? Permission.sendInThreads : Permission.send) &&
      (!thread(channel.type) || channel.thread_metadata?.archived === false && channel.thread_metadata.locked === false)
    result.channels.push({
      id: channel.id, name: channel.name ?? channel.id, type: channel.type, parentId: channel.parent_id ?? null,
      canView, canSend: writable, canReadHistory: has(bits, Permission.readHistory), supported: supported(channel.type),
    })
  }
  result.roles = roles.map(({ id, name }) => ({ id, name }))
  result.completeness = 'channels-and-active-threads'
  signal.throwIfAborted()
  return result
}

export async function inspectDiscordConversation(api: DiscordApi, chatId: string, senderId: string, signal: AbortSignal): Promise<DiscordInspection> {
  id.parse(chatId); id.parse(senderId)
  const [botUserId, rawChannel] = await Promise.all([
    discordBotIdentity(api, signal), api(`/channels/${chatId}`, { signal }),
  ])
  const channel = channelSchema.parse(rawChannel)
  if (channel.id !== chatId) throw new Error('Discord returned another conversation.')
  const location: DiscordLocation = {
    id: chatId, name: channel.name ?? null, type: channel.type,
    guildId: channel.guild_id ?? null, guildName: null, parentId: channel.parent_id ?? null, parentName: null, recipientId: null,
  }
  if (channel.type === 1 && !channel.guild_id) {
    const recipient = channel.recipients?.[0]
    if (channel.recipients?.length !== 1 || !recipient || recipient.id !== senderId || recipient.bot) throw new Error('Discord DM recipient does not match the sender.')
    location.recipientId = recipient.id
    location.name = recipient.global_name ?? recipient.username
    return { botUserId, location, actor: { id: recipient.id, name: location.name, roleIds: [] },
      canView: true, canSend: true, canReadHistory: true }
  }
  if (!channel.guild_id || ![0, 5, 10, 11].includes(channel.type)) {
    throw new Error('This Discord conversation type is not supported; private threads remain disabled.')
  }
  const [{ guild, roles, bot }, rawSender, parent] = await Promise.all([
    guildFacts(api, channel.guild_id, botUserId, signal),
    api(`/guilds/${channel.guild_id}/members/${senderId}`, { signal }),
    thread(channel.type) ? api(`/channels/${id.parse(channel.parent_id)}`, { signal }).then(value => channelSchema.parse(value)) : Promise.resolve(channel),
  ])
  const sender = memberSchema.parse(rawSender)
  if (sender.user.id !== senderId || sender.user.bot || parent.guild_id !== channel.guild_id ||
    thread(channel.type) && parent.id !== channel.parent_id || !parent.permission_overwrites) {
    throw new Error('Discord membership or channel permission metadata does not match.')
  }
  const botBits = discordPermissions(guild.id, botUserId, guild.owner_id, roles, bot, parent.permission_overwrites)
  const senderBits = discordPermissions(guild.id, senderId, guild.owner_id, roles, sender, parent.permission_overwrites)
  location.guildName = guild.name
  if (thread(channel.type)) location.parentName = parent.name ?? null
  const timeout = [sender, bot].some(member => member.communication_disabled_until &&
    Date.parse(member.communication_disabled_until) > Date.now())
  const writable = !thread(channel.type) || channel.thread_metadata?.archived === false && channel.thread_metadata.locked === false
  const sendPermission = thread(channel.type) ? Permission.sendInThreads : Permission.send
  const result: DiscordInspection = {
    botUserId, location,
    actor: { id: senderId, name: sender.nick ?? sender.user.global_name ?? sender.user.username, roleIds: sender.roles },
    canView: has(botBits, Permission.view) && has(senderBits, Permission.view),
    canSend: writable && !timeout && has(botBits, sendPermission) && has(senderBits, sendPermission),
    canReadHistory: has(botBits, Permission.readHistory) && has(senderBits, Permission.readHistory),
  }
  signal.throwIfAborted()
  return result
}
