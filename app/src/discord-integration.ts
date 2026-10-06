import { z } from 'zod'
import { apiUrl } from './api-url.ts'
import {
  DiscordDirectorySchema, DiscordMemberSchema, IntegrationChangeSchema, IntegrationDraftSchema, IntegrationOverviewSchema, IntegrationPreviewSchema,
  type DiscordBinding, type IntegrationChange,
} from '../../src/channels/integration-contract.ts'
import { MemoryResourceSchema } from '../../src/memory/contracts.ts'

export function createDiscordIntegrationClient(base: string, projectId: string, request: typeof fetch = fetch) {
  async function json(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const response = await request(apiUrl(base, `/api/integrations/discord${path}`), {
      method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    })
    let value: unknown
    try { value = await response.json() }
    catch { throw new Error('Main returned an unreadable response. Refresh before retrying a change.') }
    signal.throwIfAborted()
    if (!response.ok) {
      const error = z.object({ message: z.string().optional() }).safeParse(value)
      throw new Error(response.status === 401 || response.status === 403
        ? error.success && error.data.message || 'This operation requires the Project owner or an explicitly authorized Discord manager.'
        : error.success && error.data.message || 'Could not confirm the operation. Refresh configuration before retrying.')
    }
    return value
  }
  return {
    async overview(signal: AbortSignal) {
      const overview = IntegrationOverviewSchema.parse(await json('', signal))
      if (overview.projectId !== projectId) throw new Error('Main returned another Project. No configuration was loaded.')
      return overview
    },
    async directory(botId: string, signal: AbortSignal, guildId?: string, after?: string) {
      const params = new URLSearchParams({ ...(guildId ? { guildId } : {}), ...(after ? { after } : {}) })
      const value = DiscordDirectorySchema.extend({ botInstanceId: z.literal(botId) }).parse(
        await json(`/directory/${encodeURIComponent(botId)}?${params}`, signal))
      if (value.guildId !== (guildId ?? null)) throw new Error('Discord returned a different server. Refresh the directory.')
      return value
    },
    async members(botId: string, guildId: string, query: string, signal: AbortSignal) {
      const params = new URLSearchParams({ guildId, query })
      return z.object({ members: z.array(DiscordMemberSchema), notice: z.string() }).strict().parse(
        await json(`/members/${encodeURIComponent(botId)}?${params}`, signal))
    },
    async propose(change: IntegrationChange, baseRevision: number, signal: AbortSignal) {
      const candidate = IntegrationChangeSchema.parse(change)
      const draft = IntegrationDraftSchema.parse(await json('/drafts', signal, { change: candidate, baseRevision }))
      if (draft.baseRevision !== baseRevision || draft.status !== 'pending' || draft.actor.kind !== 'owner' ||
        JSON.stringify(draft.change) !== JSON.stringify(candidate)) throw new Error('Main returned a different review. Nothing was confirmed; refresh before continuing.')
      return draft
    },
    async commit(id: string, hash: string, signal: AbortSignal) {
      const draft = IntegrationDraftSchema.parse(await json(`/drafts/${encodeURIComponent(id)}/commit`, signal, { hash }))
      if (draft.id !== id || draft.hash !== hash || draft.status !== 'applied') throw new Error('Main did not confirm this exact review. Refresh its status before retrying.')
      return draft
    },
    async cancel(id: string, signal: AbortSignal) {
      return z.object({ cancelled: z.literal(true) }).strict().parse(await json(`/drafts/${encodeURIComponent(id)}/cancel`, signal, {}))
    },
    async resource(id: string, signal: AbortSignal) {
      const value = z.object({ resource: MemoryResourceSchema, content: z.string() }).strict().parse(await json(`/resources/${encodeURIComponent(id)}`, signal))
      if (value.resource.id !== id) throw new Error('Main returned a different memory resource.')
      return value
    },
    async agentFile(id: string, signal: AbortSignal) {
      return z.object({ id: z.literal(id), markdown: z.string().max(128_000) }).strict()
        .parse(await json(`/agents/${encodeURIComponent(id)}/file`, signal))
    },
    async preview(botId: string, chatId: string, senderId: string, signal: AbortSignal) {
      const result = IntegrationPreviewSchema.parse(await json('/preview', signal, { botId, chatId, senderId }))
      if (result.projectId !== projectId || result.botInstanceId !== botId || result.senderId !== senderId || result.location.id !== chatId) {
        throw new Error('Main returned a preview for another audience. No preview was loaded.')
      }
      return result
    },
  }
}

export function bindingLabel(binding: DiscordBinding, channels: readonly { id: string; name: string }[]) {
  const target = binding.target
  return target.kind === 'dm' ? `Direct message · ${target.userId}`
    : channels.find(channel => channel.id === target.channelId)?.name ?? `Unavailable channel · ${target.channelId}`
}

export function discordIds(value: string): string[] {
  const ids = [...new Set(value.split(/[\s,]+/).filter(Boolean))]
  if (ids.some(id => !/^[0-9]{1,20}$/.test(id))) throw new Error('Use selected Discord people or numeric user IDs; names are not authorization identifiers.')
  return ids
}
