import { type ReadResources } from './read-scope.ts'
import { stringify } from 'yaml'
import { channelSourceAddresses } from './channel-assignment.ts'
import { parseChannelSource, type ChannelSource } from '../channels/passive-contract.ts'
import { lstatSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Hono } from 'hono'
import type { Tool, ToolResult } from '../tools/tool.ts'
import type { FolderRegistry } from '../folders/registry.ts'
import { BotDeployments } from './deployments.ts'
import { parseBotPackage, botReadResources, bindingSubscription, botSubscriptionKey, subscribedBindings, parseBot, type BotDefinition } from './sdk.ts'
import { DirectoryBots } from './runtime.ts'
import { snapshotBotDirectory, sourceUsesGit } from './directory.ts'
import { botProposalBaseline } from './format.ts'
import type { SessionManager } from '../sessions/session-manager.ts'

type InspectContext = (bot: BotDefinition, revision: string, binding?: BotDefinition['bindings'][number]) => ReturnType<SessionManager['inspectBotContext']>

type Options = {
  channelSource?: (sessionId: string) => ChannelSource
  inventory?:()=>unknown
  projectId: string; deployments: BotDeployments; runtime: DirectoryBots
  folders: Pick<FolderRegistry,'acquireAccess'|'requireAvailable'|'list'>
  ask: Tool<ToolResult>; canAuthor: (sessionId:string) => boolean
  validate: (files:Record<string,string>,signal:AbortSignal) => Promise<void>
  pending: Map<string, unknown>
  publish: <T>(id:string,change:()=>Promise<T>, candidate?:BotDefinition) => Promise<T>; changed: (ids:string[]) => void
}
const reloadRequest = z.object({action:z.literal('reload'),folderId:z.string().min(1).max(128),directory:z.string().max(1024).default(''),summary:z.string().trim().min(1).max(800)}).strict()
const sourceRequest = z.object({action:z.literal('source'),folderId:z.string().min(1).max(128),directory:z.string().max(1024).default(''),channelSessionId:z.string().max(8192).optional()}).strict()
const createRequest = z.object({ action: z.literal('create'), folderId: z.string().min(1).max(128), directory: z.string().min(1).max(1024), id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/), prompt: z.string().trim().min(1).max(128000), summary: z.string().trim().min(1).max(800) }).strict()

function location(binding: ReturnType<typeof parseBot>['bindings'][number]): string {
  return binding.platform === 'discord' ? `Discord ${binding.target.kind === 'dm' ? 'DM '+binding.target.userId : binding.target.guildId+'/'+binding.target.channelId}` : `${binding.platform} ${binding.botInstanceId}/${binding.conversationId}`
}
function resourceFacts(prefix: string, scope?: ReadResources): string[] {
  const facts = [
    ...(scope?.knowledge ? [`${prefix} Project Knowledge metadata and scoped relations (v:knowledge)`] : []),
    ...(scope?.wiki ? [`${prefix} shared Project Wiki content (v:memory)`] : []),
    ...(scope?.folders ?? []).map(id => `${prefix} registered folder ${id}`),
  ]
  return facts.length ? facts : [`${prefix} none`]
}

function authorities(bot: ReturnType<typeof parseBot> | undefined): Set<string> {
  if(!bot)return new Set()
  const facts:string[]=[`mode ${bot.mode}`, ...(bot.mode === 'personal' ? [`explicit Personal inbox assignment; role ${bot.agent}; ordinary role tools/context`] : [])]
  facts.push(...subscribedBindings(bot).map(binding => `input subscription ${botSubscriptionKey(bindingSubscription(binding))}`))
  facts.push(...bot.tools.flatMap(tool=>tool.imports.map(name=>`tool ${tool.name}: service module ${name}`)))
  for(const operation of bot.hostCapabilities ?? [])facts.push(`BOT host capability ${operation} (invoking binding only)`)
  for(const name of bot.allowedModules)facts.push(`BOT module ceiling ${name}`)
  if (bot.mode === 'service') facts.push(...resourceFacts('BOT-wide read grant:', botReadResources(bot)))
  for(const id of bot.readDomains ?? [])facts.push(`BOT memory-domain ceiling ${id}`)
  if(bot.discordHistory)facts.push(`BOT history ceiling ${bot.discordHistory.guildId}/${bot.discordHistory.channelIds.join(',')} threads=${bot.discordHistory.threads} preEpoch=${bot.discordHistory.preEpoch}`)
  for(const binding of bot.bindings){
    const target=location(binding)
    facts.push(`${target}: ${binding.enabled ? 'enabled' : 'disabled'}`)
    facts.push(`${target}: trigger ${binding.trigger}`)
    facts.push(...resourceFacts(`${target}: inherits BOT-wide read grant:`, botReadResources(bot)))
    for(const name of binding.tools)facts.push(`${target}: tool ${name}`)
    for(const grant of binding.grants ?? [])facts.push(`${target}: ${grant.kind === 'http' ? grant.routes.map(route=>`${route.method} ${grant.origin}${route.path}`).join(', ') : 'inbox '+grant.sessionId+' (raw content)'}`)
    if(binding.platform==='discord'){
      facts.push(`${target}: participants ${binding.participants.everyone ? 'everyone' : [...binding.participants.userIds.map(id=>'user '+id),...binding.participants.roleIds.map(id=>'role '+id)].join(', ')}`)
      for(const domain of binding.readDomains)facts.push(`${target}: domain ${domain}`)
      if(binding.discordHistory)facts.push(`${target}: history ${binding.discordHistory.guildId}/${binding.discordHistory.channelIds.join(',')} threads=${binding.discordHistory.threads} preEpoch=${binding.discordHistory.preEpoch}`)
      if(binding.observation)facts.push(`${target}: observation ${binding.observation.enabled?'enabled':'disabled'} sources=${binding.observation.channelIds.join(',')}`)
      if(binding.inheritThreads)facts.push(`${target}: inherited threads`)
      if(binding.manage)facts.push(`${target}: configuration management`)
    }else{
      if(binding.allowFrom)facts.push(`${target}: allowed senders ${binding.allowFrom.join(',') || 'nobody'}`)
      else facts.push(`${target}: inherited channel admission`)
    }
  }
  return new Set(facts)
}

function disclosedBindings(bot: BotDefinition): unknown[] {
  return bot.bindings.map(binding => {
    return { ...binding, inheritedReadResources: botReadResources(bot) ?? null, grants: binding.grants?.map(grant => {
      if (grant.kind !== 'http') return grant
      const { credential, ...scope } = grant
      // Review destination/route authority, not secret refs or header values.
      return { ...scope, ...(credential ? { credential: { configured: true } } : {}) }
    }) }
  })
}

export function botPackageTool(options: Options): Tool {
  return {name:'bot_package',optIn:true,
    description:'Manage directory BOT source and deployment from authenticated owner Web Chat. create creates and publishes a new Service BOT with zero subscriptions. Edit BOT.md and its companion JSON using ordinary write, preserving other bindings/subscriptions, then reload to validate and publish one frozen snapshot. reload centrally checks current Project/Connection identity, permissions and conflicts again inside publication; source inspection is not a prerequisite and no revision argument is required. source optionally resolves a trusted host-recorded channelSessionId and returns binding/subscription addresses, not permissions or authorization. Choose permissions explicitly in source, subject to BOT ceilings; readResources belongs at BOT level. status is compatibility inventory. Source edits alone never activate; reload does not restart the host or replay old inbox messages.',
    parameters:{type:'object',properties:{action:{type:'string',enum:['status','source','create','reload']},id:{type:'string'},prompt:{type:'string'},folderId:{type:'string'},directory:{type:'string'},summary:{type:'string'},channelSessionId:{type:'string'}},required:['action'],additionalProperties:false},
    execute:async(raw,context) => {
      context.signal.throwIfAborted()
      if (context.projectId !== options.projectId || context.channel !== 'web' || context.inputSource !== 'user' || context.admin !== true || context.isGroup || context.channelAddress || context.remoteWorkdir || context.memoryAccess || context.tools.executionMode !== 'session' || !options.canAuthor(context.sessionId)) throw new Error('Use an authenticated owner conversation in this Project.')
      if (raw.action === 'status') {
        z.object({action:z.literal('status')}).strict().parse(raw)
        return JSON.stringify({projectId:options.projectId,deployments:options.deployments.list(),folders:options.folders.list(),inventory:options.inventory?.(),format:'BOT.md {id, config: bot.json, mode, Service model/temperature/maxTokens/thinking/reasoningEffort OR Personal agent} + JSON subscriptions/bindings/tools/allowedModules/skills/read scopes + tool modules; whole legacy JSON behavior supported temporarily, mixed/duplicate fields rejected',receivePolicy:'Service QQ/Feishu bindings own trigger: mention (default) or all. Connection triggerMode is not inherited. Existing Service packages without trigger narrow to mention; explicitly configure all if that behavior is intended.'})
      }
      if (raw.action === 'create') {
        const input = createRequest.parse(raw), parts = input.directory.split('/')
        if (parts.some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..')) throw new Error('Choose a relative BOT directory without traversal.')
        if (options.deployments.read(input.id)) throw new Error('BOT already exists; edit source and reload')
        const files = { 'BOT.md': `---\n${stringify({ id: input.id, config: 'bot.json', mode: 'service' })}---\n${input.prompt}\n`,
          'bot.json': JSON.stringify({ allowedModules: [], tools: [], bindings: [], subscriptions: [] }, null, 2) + '\n' }
        parseBot(files); await options.validate(files, context.signal)
        const release = options.folders.acquireAccess()
        try {
          const folder = await options.folders.requireAvailable(input.folderId)
          if (folder.kind === 'remote' || folder.kind === 'layerfs') throw new Error('BOT source must be a registered local Folder')
          let path = folder.path
          if (lstatSync(path).isSymbolicLink()) throw new Error('BOT source symlinks are forbidden.')
          for (const part of parts.slice(0, -1)) { path = join(path, part); if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error('BOT parent must be an existing local directory') }
          path = join(path, parts.at(-1)!)
          if (existsSync(path)) throw new Error('Create refuses to overwrite an existing BOT source directory')
          context.signal.throwIfAborted(); if (!options.canAuthor(context.sessionId)) throw new Error('BOT source owner authority changed.'); mkdirSync(path, { mode: 0o700 })
          for (const [name, content] of Object.entries(files)) writeFileSync(join(path, name), content, { flag: 'wx', mode: 0o600 })
        } finally { release() }
        // If publication fails the new private source remains for inspection/retry;
        // existing user files and active deployments have not been overwritten.
        return botPackageTool(options).execute({ action: 'reload', folderId: input.folderId, directory: input.directory,
          summary: input.summary }, context)
      }
      const input = raw.action === 'source' ? sourceRequest.parse(raw) : reloadRequest.parse(raw)
      const target = 'channelSessionId' in input && input.channelSessionId ? options.channelSource?.(input.channelSessionId) : undefined
      if ('channelSessionId' in input && input.channelSessionId && !target) throw new Error('Referenced passive channel session is unavailable in this Project')
      if (target) parseChannelSource(target, 'channelSessionId' in input ? input.channelSessionId : undefined, options.projectId)
      const parts = input.directory ? input.directory.split('/') : []
      if (parts.some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..')) throw new Error('Choose a relative BOT directory without traversal.')
      const release = options.folders.acquireAccess()
      let frozen: ReturnType<BotDeployments['freeze']>, gitSource = false
      try {
        const folder = await options.folders.requireAvailable(input.folderId)
        if (folder.kind === 'remote' || folder.kind === 'layerfs') throw new Error('BOT source must be a registered local Folder; no Main fallback is permitted.')
        let path = folder.path
        if (lstatSync(path).isSymbolicLink()) throw new Error('BOT source symlinks are forbidden.')
        for (const part of parts) {path=join(path,part);if(lstatSync(path).isSymbolicLink())throw new Error('BOT source symlinks are forbidden.')}
        frozen = options.deployments.freeze(snapshotBotDirectory(path))
        if (input.action === 'source') {
          const parsed = parseBotPackage(frozen.files)
          return JSON.stringify({ bot: parsed.bot.id, configPath: parsed.configPath, channelSource: target, addresses: target ? channelSourceAddresses(target, parsed.bot.bindings) : undefined, projectReadGrants: parsed.bot.mode === 'service' ? resourceFacts('Inherited BOT-wide read grant:', botReadResources(parsed.bot)) : undefined, note: 'Read-only origin evidence; choose permissions explicitly. No revision preflight is required. Operations use the source snapshot read at execution; live authority checks remain in force.' })
        }
        gitSource = sourceUsesGit(path)
      } finally {release()}
      const bot = parseBot(frozen.files)
      const current = options.deployments.read(bot.id)?.deployment
      await options.validate(frozen.files,context.signal)
      const active = options.deployments.read(bot.id)
      const baseline = active ? botProposalBaseline(active.files) : undefined
      const before = baseline?.bot
      if (before && before.id !== bot.id) throw new Error('BOT active identity mismatch.')
      const oldAuthority=authorities(before),newAuthority=authorities(bot)
      if (baseline?.removedProposalGrants?.length) for (const operation of before?.hostCapabilities ?? []) oldAuthority.delete(`BOT host capability ${operation} (invoking binding only)`)
      for (const grant of baseline?.removedProposalGrants ?? []) oldAuthority.add(`Retired proposal-inbox grant ${grant.id}: ${grant.repository}/${grant.inbox} (inactive; no Work authority)`)
      const repair = baseline && (baseline.removedBindingSkills.length || baseline.removedProposalGrants?.length) ? {
        activeInvalid: true, reason: 'Retired binding.skills selectors or proposal-inbox grants; the active package fails the current strict schema. Removed proposal grants never grant Work authority.',
        removedBindingSkills: baseline.removedBindingSkills, removedProposalGrants: baseline.removedProposalGrants ?? [],
        effect: 'Deployment restores a valid BOT definition and its enabled input subscriptions/runtime; it is not only a format change.',
        candidatePermissions: [...newAuthority], previousContent: current!.revision, exactContent: frozen.revision,
      } : undefined
      const added=[...newAuthority].filter(value=>!oldAuthority.has(value)),removed=[...oldAuthority].filter(value=>!newAuthority.has(value))
      const affected=[...new Set([...(before?.bindings ?? []),...bot.bindings].map(location))]
      const facts = {projectId:options.projectId,bot:bot.id,source:{folderId:input.folderId,directory:input.directory},sourceGit:gitSource,repair,
        previousContent:current?.revision ?? null,exactContent:frozen.revision,fileCount:Object.keys(frozen.files).length,
        affected,addedPermissions:added,removedPermissions:removed,candidatePermissions:[...newAuthority],
        credentialDisclosure:'Credential configuration is represented only by its presence; private references and header values are withheld. Origins, routes and body restrictions remain visible.',
        mode:bot.mode,agent:bot.agent,bindings:disclosedBindings(bot),subscriptions:subscribedBindings(bot).map(bindingSubscription),subscriptionMigration:bot.subscriptions === undefined ? 'legacy bindings (same authority)' : 'explicit',toolDeclarations:bot.tools.map(({name,description,parameters,imports})=>({name,description,parameters,imports})),
        hostCapabilities:bot.hostCapabilities ?? [],modules:bot.allowedModules,readDomains:bot.readDomains ?? [],readResources:botReadResources(bot) ?? null,discordHistory:bot.discordHistory ?? null,
        storage:'BOT- and binding-scoped mutable data, separate from immutable deployment files',
        execution:bot.mode === 'personal' ? 'Ordinary role tools/context and BOT prompt; no custom modules. Explicit inbox assignment does not establish owner identity.' : 'Restricted child runtime, no raw credentials/platform clients; no source executes during deployment'}
      // Direct authenticated authoring is the authorization. Snapshot integrity,
      // live scope validation and the publication fence remain technical checks;
      // no second native ask/approval or pending activation state is introduced.
      context.signal.throwIfAborted()
      const deployment = await options.publish(bot.id,async () => {
        if (!options.canAuthor(context.sessionId)) throw new Error('BOT publication owner authority changed.')
        await options.validate(frozen.files,context.signal)
        if (!options.canAuthor(context.sessionId)) throw new Error('BOT publication owner authority changed.')
        return options.deployments.deploy({id:bot.id,source:{folderId:input.folderId,directory:input.directory},files:frozen.files,revision:frozen.revision,expectedRevision:options.deployments.read(bot.id)?.deployment.revision,signal:context.signal})
      }, bot)
      options.changed([...new Set([...(before?.bindings ?? []),...bot.bindings].flatMap(binding=>binding.platform === 'discord' ? [binding.id] : []))])
      return JSON.stringify({status:'deployed',deployment,changes:facts})
    },
  }
}

/** Read-only owner inventory. Publication has no separate approval/pending state. */
export function botPackagePlugin(options: Pick<Options,'projectId'|'deployments'|'pending'>, authorize:(request:Request)=>boolean|Promise<boolean>, inspectContext?: InspectContext) {
  return (app:Hono) => {
    app.get('/api/bot-package/:id/runtime-context', async context => {
      context.header('Cache-Control', 'no-store')
      if (!await authorize(context.req.raw)) return context.json({ error: 'Unauthorized' }, 401)
      try {
        const snapshot = options.deployments.read(context.req.param('id'))
        if (!snapshot) return context.json({ error: 'BOT deployment unavailable.' }, 404)
        const { id, revision } = snapshot.deployment
        if (context.req.query('revision') !== revision) return context.json({ error: 'BOT deployment changed. Refresh the inventory.' }, 409)
        const envelope = { projectId: options.projectId, id, revision }
        let bot: BotDefinition
        try {
          bot = parseBot(snapshot.files)
          if (bot.id !== id) throw new Error('Identity mismatch')
        } catch { return context.json({ ...envelope, status: 'invalid-package' }) }
        const bindings = subscribedBindings(bot)
        const scopes = bindings.map((binding, index) => ({
          key: String(index), label: `${binding.platform} / ${binding.botInstanceId} / ${binding.platform === 'discord'
            ? binding.target.kind === 'channel' ? binding.target.channelId : binding.target.userId : binding.conversationId}`,
        }))
        const requested = context.req.query('scope')
        const overview = { ...envelope, status: 'ready' as const, mode: bot.mode, agent: bot.agent, scopes }
        if (requested === undefined) return context.json(overview)
        const index = scopes.findIndex(scope => scope.key === requested)
        if (index < 0) return context.json({ error: 'BOT context scope not found.' }, 404)
        const binding = bindings[index]
        if (binding && !binding.enabled) return context.json({ ...overview, scope: requested, result: 'disabled' })
        if (!inspectContext || binding?.platform === 'discord' && binding.target.kind !== 'channel') {
          return context.json({ ...overview, scope: requested, result: 'unsupported' })
        }
        let runtime: ReturnType<InspectContext>
        try { runtime = inspectContext(bot, revision, binding) }
        catch { /* Do not disclose authorization internals or another binding's details. */ }
        return context.json({ ...overview, scope: requested, result: runtime ? 'available' : 'unavailable', runtime })
      } catch { return context.json({ error: 'BOT deployment unavailable.' }, 409) }
    })
    app.get('/api/bot-package/:id/prompt', async context => {
      context.header('Cache-Control', 'no-store')
      if (!await authorize(context.req.raw)) return context.json({ error: 'Unauthorized' }, 401)
      try {
        const snapshot = options.deployments.read(context.req.param('id'))
        if (!snapshot) return context.json({ error: 'BOT deployment unavailable.' }, 404)
        if (context.req.query('revision') !== snapshot.deployment.revision) return context.json({ error: 'BOT deployment changed. Refresh the inventory.' }, 409)
        const requestedPath = context.req.query('path')
        const path = requestedPath ?? 'BOT.md'
        if (!/\.md$/i.test(path) || !Object.hasOwn(snapshot.files, path)) return context.json({ error: 'BOT Markdown unavailable.' }, 404)
        return context.json({ id: snapshot.deployment.id, revision: snapshot.deployment.revision,
          source: snapshot.deployment.source, ...(requestedPath !== undefined ? { path } : {}), prompt: snapshot.files[path] })
      } catch { return context.json({ error: 'BOT deployment unavailable.' }, 409) }
    })
    app.get('/api/bot-package',async context => {
      context.header('Cache-Control','no-store')
      if (!await authorize(context.req.raw)) return context.json({error:'Unauthorized'},401)
      if (context.req.query('documents') === 'markdown') {
        const { ids, warning } = options.deployments.diagnosticIds()
        let partial = !!warning
        const documents = ids.flatMap(id => {
          const { value, error } = options.deployments.inspect(id)
          if (error) partial = true
          if (!value) return []
          const paths = Object.keys(value.files).filter(path => /\.md$/i.test(path)).sort()
          return [{ id, revision: value.deployment.revision, paths }]
        })
        return context.json({ projectId: options.projectId, documents, partial })
      }
      try { return context.json({projectId:options.projectId,deployments:options.deployments.list(),pending:[...options.pending].map(([revision,facts])=>({revision,facts}))}) }
      catch { return context.json({error:'BOT deployment unavailable; active content was not replaced.'},409) }
    })
  }
}
