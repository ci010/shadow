/** Display-only inspection of frozen data. Never compiles or executes package code. */
import { z } from 'zod'
import { t, type MessageKey } from './i18n.ts'
import { parseFrontmatter } from '../../src/utils/frontmatter.ts'
import { IntegrationAgentInputSchema, DiscordBindingSchema, type IntegrationDraft } from '../../src/channels/integration-contract.ts'
const metadata = z.object({
  name: z.string(), platform: z.literal('discord'), botInstanceId: z.string(), description: z.string().optional(),
  channels: z.array(z.string()), tools: IntegrationAgentInputSchema.shape.tools.default([]),
  readDomains: IntegrationAgentInputSchema.shape.readDomains.default([]),
  sourceFolders: IntegrationAgentInputSchema.shape.sourceFolders, discordHistory: IntegrationAgentInputSchema.shape.discordHistory,
})
type Row = { label: MessageKey; value: string }
export function summarizeBot(draft: IntegrationDraft) {
  if (draft.change.kind !== 'bot.save') return undefined
  try {
    const source = draft.change.package.source
    const fm = metadata.parse(parseFrontmatter(source['BOT.md'] ?? '').frontmatter)
    const scope = (item: Pick<z.infer<typeof metadata>, 'sourceFolders' | 'discordHistory' | 'tools' | 'readDomains'>): Row[] => {
      const history = item.discordHistory
      return [
        { label: 'Source folder IDs', value: item.sourceFolders ? (item.sourceFolders.join(', ') || t('No source folders declared')) : t('Not specified in this snapshot') },
        { label: 'Tools', value: item.tools.join(', ') || t('No tools declared') },
        { label: 'Memory domain IDs', value: item.readDomains.join(', ') || t('No memory domains declared') },
        { label: 'History server ID', value: history?.guildId ?? t('Not specified in this snapshot') },
        { label: 'History channel IDs', value: history?.channelIds.join(', ') ?? t('Not specified in this snapshot') },
        { label: 'Public thread history', value: history ? ({none:t('No threads'), 'public-active':t('Active public threads'), 'public-archived':t('Active and archived public threads')}[history.threads]) : t('Not specified in this snapshot') },
        { label: 'Private thread history', value: t('Not granted by this scope') },
        { label: 'History before current epoch', value: history ? (history.preEpoch ? t('Allowed') : t('Not allowed')) : t('Not specified in this snapshot') },
      ]
    }
    const groups: {title:string; rows:Row[]}[] = [{ title: 'Agent permission ceiling', rows: [{label:'Connection',value:fm.botInstanceId}, ...scope(fm)] }]
    for (const path of fm.channels) {
      if (!/^channels\/[a-zA-Z0-9_-]+\.json$/.test(path)) throw new Error('Invalid channel path')
      const bindings = z.array(DiscordBindingSchema.omit({agentId:true, epochRevision:true})).max(200).parse(JSON.parse(source[path] ?? ''))
      for (const binding of bindings) groups.push({title: binding.id, rows: [
        ...(binding.target.kind === 'channel' ? [{label:'Server ID' as const, value:binding.target.guildId}, {label:'Channel ID' as const, value:binding.target.channelId}] : [{label:'DM user ID' as const,value:binding.target.userId}]),
        {label:'Enabled', value:binding.enabled ? t('Yes') : t('No')},
        {label:'Participant invocation policy', value:binding.participants.everyone ? t('Everyone') : t('Listed users and roles only')},
        {label:'Reply audience',value:t('Readers of the destination channel or DM; participant invocation policy does not restrict who can see replies.')},
        {label:'User IDs', value:binding.participants.userIds.join(', ') || '[]'},
        {label:'Role IDs', value:binding.participants.roleIds.join(', ') || '[]'},
        {label:'Trigger', value:binding.trigger === 'mention' ? t('mention') : t('all')},
        {label:'Inherit threads',value:binding.inheritThreads ? t('Yes') : t('No')},
        {label:'Management access',value:binding.manage ? t('Yes') : t('No')},
        {label:'Custom input processor',value:binding.processor ? t('Configured — inspect exact snapshot') : t('Not configured')},
        {label:'Observation scope',value:binding.observation ? t('Configured — inspect exact snapshot') : t('Not configured')},
        ...(binding.observation ? [
          {label:'Observation enabled' as const,value:binding.observation.enabled ? t('Yes') : t('No')},
          {label:'Observation server ID' as const,value:binding.observation.guildId},
          {label:'Observation channel IDs' as const,value:binding.observation.channelIds.join(', ')},
          {label:'Observation audience channel ID' as const,value:binding.observation.audienceChannelId},
        ] : []),
        ...scope(binding),
      ]})
    }
    return {name:fm.description || fm.name, groups}
  } catch { return undefined }
}
