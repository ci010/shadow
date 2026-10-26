import { createHash } from 'node:crypto'
import { z } from 'zod'
import { stringify } from 'yaml'
import { parseFrontmatter } from '../utils/frontmatter.ts'
import { DiscordPackageSchema, DiscordBindingSchema, IntegrationAgentInputSchema } from './integration-contract.ts'

export type DiscordPackage = z.infer<typeof DiscordPackageSchema>
const uuid = (text: string) => {
  const hex = createHash('sha256').update(text).digest('hex')
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`
}
export function compileDiscordPackage(raw: DiscordPackage) {
  const input = DiscordPackageSchema.parse(raw)
  if (Buffer.byteLength(JSON.stringify(input)) > 2 * 1024 * 1024) throw new Error('BOT package exceeds snapshot limit.')
  const parsed = parseFrontmatter(input.source['BOT.md'] ?? '')
  const fm = z.object({ name: z.literal(input.id), platform: z.literal('discord'), botInstanceId: z.string().min(1),
    agentId: z.string().uuid().optional(), agentMarkdown: z.string().max(512_000).optional(), description: z.string().optional(), channels: z.array(z.string()).max(64),
    tools: IntegrationAgentInputSchema.shape.tools.default([]), readDomains: IntegrationAgentInputSchema.shape.readDomains.default([]),
  }).strict().parse(parsed.frontmatter)
  if (new Set(fm.channels).size !== fm.channels.length) throw new Error('Duplicate channel reference.')
  const agentId = fm.agentId ?? uuid(`discord-bot-package:${input.id}`)
  const skills = Object.entries(input.source).filter(([path]) => /^skills\/[a-z][a-z0-9_-]{0,63}\/SKILL\.md$/.test(path)).map(([path, content]) => {
    const parsed = parseFrontmatter(content)
    if (Object.keys(parsed.frontmatter).some(key => !['name','description'].includes(key))) throw new Error('Discord package skills are prompt-only; executable tools must use the closed Discord registry.')
    return { name: path.split('/')[1]!, content: parsed.body }
  })
  const allowed = new Set(['BOT.md', ...fm.channels, ...Object.keys(input.source).filter(path => /^skills\/[a-z][a-z0-9_-]{0,63}\/SKILL\.md$/.test(path))])
  if (Object.keys(input.source).some(path => !allowed.has(path))) throw new Error('Unsupported Discord BOT source. SDKs, initialize and external dependencies are not supported.')
  if (fm.agentMarkdown !== undefined) {
    const original = parseFrontmatter(fm.agentMarkdown)
    if (original.frontmatter.name !== input.id || original.body !== parsed.body) throw new Error('Frozen Discord Agent identity or prompt differs.')
  }
  const agent = IntegrationAgentInputSchema.parse({ id: agentId, name: input.id, displayName: fm.description ?? input.id,
    markdown: fm.agentMarkdown ?? `---\n${stringify({name: input.id, defaultMode: 'session', allowedTools: fm.tools})}---\n${parsed.body}`,
    execution: 'restricted', tools: fm.tools, readDomains: fm.readDomains, skills })
  const bindings = fm.channels.flatMap(path => {
    if (!/^channels\/[a-zA-Z0-9_-]+\.json$/.test(path) || !Object.hasOwn(input.source,path)) throw new Error('Missing or unsafe channel reference.')
    return z.array(DiscordBindingSchema.omit({agentId:true, epochRevision:true})).max(200).parse(JSON.parse(input.source[path]!)).map(binding => {
      if (binding.botInstanceId !== fm.botInstanceId) throw new Error('A BOT package must target its single declared connection.')
      return {...binding, agentId}
    })
  })
  if (new Set(bindings.map(b=>b.id)).size !== bindings.length) throw new Error('Duplicate binding ID.')
  return { agent, bindings }
}
