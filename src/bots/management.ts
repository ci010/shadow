import { stringify } from 'yaml'
import { writePrivateFile } from '../utils/private-file.ts'
import { assignChannelSource } from './channel-assignment.ts'
import { parseChannelSource, type ChannelSource } from '../channels/passive-contract.ts'
import { lstatSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Hono } from 'hono'
import type { Tool, ToolResult } from '../tools/tool.ts'
import type { FolderRegistry } from '../folders/registry.ts'
import { BotDeployments } from './deployments.ts'
import { parseBotPackage, bindingSubscription, botSubscriptionKey, subscribedBindings, parseBot, type BotDefinition } from './sdk.ts'
import { DirectoryBots } from './runtime.ts'
import { snapshotBotDirectory, sourceUsesGit } from './directory.ts'
import { botProposalBaseline } from './format.ts'

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
const proposal = z.object({action:z.literal('propose'),folderId:z.string().min(1).max(128),directory:z.string().max(1024).default(''),expectedRevision:z.string().optional(),sourceRevision:z.string().regex(/^[a-f0-9]{64}$/).optional(),summary:z.string().trim().min(1).max(800)}).strict()
const sourceRequest = z.object({action:z.literal('source'),folderId:z.string().min(1).max(128),directory:z.string().max(1024).default(''),channelSessionId:z.string().max(8192).optional()}).strict()
const createRequest = z.object({ action: z.literal('create'), folderId: z.string().min(1).max(128), directory: z.string().min(1).max(1024), id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/), prompt: z.string().trim().min(1).max(128000), summary: z.string().trim().min(1).max(800) }).strict()
const assignment = proposal.extend({action:z.literal('assign'),scope:z.enum(['conversation','parent']).default('conversation'),channelSessionId:z.string().min(1).max(8192),sourceRevision:z.string().regex(/^[a-f0-9]{64}$/),bindingJson:z.string().max(128000)}).strict()

function location(binding: ReturnType<typeof parseBot>['bindings'][number]): string {
  return binding.platform === 'discord' ? `Discord ${binding.target.kind === 'dm' ? 'DM '+binding.target.userId : binding.target.guildId+'/'+binding.target.channelId}` : `${binding.platform} ${binding.botInstanceId}/${binding.conversationId}`
}
function authorities(bot: ReturnType<typeof parseBot> | undefined): Set<string> {
  if(!bot)return new Set()
  const facts:string[]=[`mode ${bot.mode}`, ...(bot.mode === 'personal' ? [`personal connection ${bot.connection}; role ${bot.agent}; ordinary verified-owner tools/context`] : [])]
  facts.push(...subscribedBindings(bot).map(binding => `input subscription ${botSubscriptionKey(bindingSubscription(binding))}`))
  facts.push(...bot.tools.flatMap(tool=>tool.imports.map(name=>`tool ${tool.name}: service module ${name}`)))
  for(const operation of bot.hostCapabilities ?? [])facts.push(`BOT host capability ${operation} (invoking binding only)`)
  for(const name of bot.allowedModules)facts.push(`BOT module ceiling ${name}`)
  for(const id of bot.sourceFolders ?? [])facts.push(`BOT source-folder ceiling ${id}`)
  for(const id of bot.readDomains ?? [])facts.push(`BOT memory-domain ceiling ${id}`)
  if(bot.discordHistory)facts.push(`BOT history ceiling ${bot.discordHistory.guildId}/${bot.discordHistory.channelIds.join(',')} threads=${bot.discordHistory.threads} preEpoch=${bot.discordHistory.preEpoch}`)
  for(const binding of bot.bindings){
    const target=location(binding)
    facts.push(`${target}: ${binding.enabled ? 'enabled' : 'disabled'}`)
    facts.push(`${target}: trigger ${binding.trigger}`)
    for(const name of binding.tools)facts.push(`${target}: tool ${name}`)
    for(const grant of binding.grants ?? [])facts.push(`${target}: ${grant.kind === 'http' ? grant.routes.map(route=>`${route.method} ${grant.origin}${route.path}`).join(', ') : 'inbox '+grant.sessionId+' (raw content)'}`)
    if(binding.platform==='discord'){
      facts.push(`${target}: participants ${binding.participants.everyone ? 'everyone' : [...binding.participants.userIds.map(id=>'user '+id),...binding.participants.roleIds.map(id=>'role '+id)].join(', ')}`)
      for(const folder of binding.sourceFolders ?? [])facts.push(`${target}: folder ${folder}`)
      for(const domain of binding.readDomains)facts.push(`${target}: domain ${domain}`)
      if(binding.discordHistory)facts.push(`${target}: history ${binding.discordHistory.guildId}/${binding.discordHistory.channelIds.join(',')} threads=${binding.discordHistory.threads} preEpoch=${binding.discordHistory.preEpoch}`)
      if(binding.observation)facts.push(`${target}: observation ${binding.observation.enabled?'enabled':'disabled'} sources=${binding.observation.channelIds.join(',')}`)
      if(binding.inheritThreads)facts.push(`${target}: inherited threads`)
      if(binding.manage)facts.push(`${target}: configuration management`)
    }else{
      for(const folder of binding.readFolders)facts.push(`${target}: folder ${folder}`)
      if(binding.allowFrom)facts.push(`${target}: allowed senders ${binding.allowFrom.join(',') || 'nobody'}`)
      else facts.push(`${target}: inherited channel admission`)
    }
  }
  return new Set(facts)
}

function disclosedBindings(bot: BotDefinition): unknown[] {
  return bot.bindings.map(binding => ({ ...binding, grants: binding.grants?.map(grant => {
    if (grant.kind !== 'http') return grant
    const { credential, ...scope } = grant
    // Deployment files may reference private credential configuration. The owner
    // reviews destination/route authority here, not secret refs or header values.
    return { ...scope, ...(credential ? { credential: { configured: true } } : {}) }
  }) }))
}

export function botPackageTool(options: Options): Tool {
  return {name:'bot_package',optIn:true,
    description:'create creates a new Service BOT source in a new directory and publishes it with no subscriptions; link edits and publishes an existing BOT companion for a host-recorded group/channel, with exact sourceRevision/expectedRevision. Neither copies selectors into Connection or Workflow. Direct thread/DM assignment is forbidden. Manage unified directory BOTs for QQ, Feishu and Discord. Read v:bots/overview for read-only state first; status remains a compatibility inventory of deployed revisions and registered folders. propose snapshots a local registered source directory, validates data without executing code, then publishes the exact validated revision under the current owner authority. Supply a concise user-facing summary. No secondary binding database or separate activation approval. Edit source and propose again to update. source reads sourceRevision and resolves a passive channelSessionId from trusted host metadata. assign prepares an exact source edit for the referenced channel using explicit bindingJson permissions (no target identity keys). It never writes files or deploys. Apply the returned match/content with the ordinary authorized write tool in source.folderId, then propose with sourceRevision=candidateRevision to publish that exact source revision. QQ/Feishu policy: {enabled,trigger,allowFrom,tools,readFolders?}. Discord policy: {enabled,trigger,participants:{everyone,userIds,roleIds},tools,readDomains,inheritThreads,manage}. Unassign sets enabled:false. scope defaults to conversation and requires a top-level group/channel. Exact thread and DM assignment is forbidden; scope:parent requires a referenced public Discord thread and explicit inheritThreads:true, producing one parent-channel rule for new child events, never shared child context or history replay. Reference alone never grants authority; old inbox messages are not replayed.',
    parameters:{type:'object',properties:{action:{type:'string',enum:['status','source','create','link','assign','propose']},id:{type:'string'},prompt:{type:'string'},folderId:{type:'string'},directory:{type:'string'},expectedRevision:{type:'string'},summary:{type:'string'},scope:{type:'string',enum:['conversation','parent']},channelSessionId:{type:'string'},sourceRevision:{type:'string'},bindingJson:{type:'string'}},required:['action'],additionalProperties:false},
    execute:async(raw,context) => {
      context.signal.throwIfAborted()
      if (context.projectId !== options.projectId || context.channel !== 'web' || context.inputSource !== 'user' || context.admin !== true || context.isGroup || context.channelAddress || context.remoteWorkdir || context.memoryAccess || context.tools.executionMode !== 'session' || !options.canAuthor(context.sessionId)) throw new Error('Use an authenticated owner conversation in this Project.')
      if (raw.action === 'status') {
        z.object({action:z.literal('status')}).strict().parse(raw)
        return JSON.stringify({projectId:options.projectId,deployments:options.deployments.list(),folders:options.folders.list(),inventory:options.inventory?.(),format:'BOT.md {id, config: bot.json, mode, Service model/temperature/maxTokens/thinking/reasoningEffort OR Personal agent} + JSON connection/subscriptions/bindings/tools/allowedModules/skills/read scopes + tool modules; whole legacy JSON behavior supported temporarily, mixed/duplicate fields rejected',receivePolicy:'Service QQ/Feishu bindings own trigger: mention (default) or all. Connection triggerMode is not inherited. Existing Service packages without trigger narrow to mention; explicitly configure all if that behavior is intended.'})
      }
      if (raw.action === 'create') {
        const input = createRequest.parse(raw), parts = input.directory.split('/')
        if (parts.some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..')) throw new Error('Choose a relative BOT directory without traversal.')
        if (options.deployments.read(input.id)) throw new Error('BOT already exists; use link or propose with its exact revision')
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
        return botPackageTool(options).execute({ action: 'propose', folderId: input.folderId, directory: input.directory,
          summary: input.summary, sourceRevision: options.deployments.freeze(files).revision }, context)
      }
      const linking = raw.action === 'link'
      const input = raw.action === 'assign' || linking ? assignment.parse({ ...raw, action: 'assign' }) : raw.action === 'source' ? sourceRequest.parse(raw) : proposal.parse(raw)
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
          return JSON.stringify({ sourceRevision: frozen.revision, bot: parsed.bot.id, configPath: parsed.configPath, channelSource: target, note: 'Read-only origin evidence; choose permissions explicitly. Source edits and publication retain optimistic revision and live authority checks; no extra approval is required.' })
        }
        if (input.action === 'assign') {
          if (frozen.revision !== input.sourceRevision) throw new Error('BOT source changed; inspect it again before assignment')
          const activeId = parseBot(frozen.files).id
          if (options.deployments.read(activeId)?.deployment.revision !== input.expectedRevision) throw new Error('BOT active revision changed. Read status before assigning.')
          if (linking && !options.deployments.read(activeId)) throw new Error('Link requires an existing BOT; use create first')
          const updated = assignChannelSource(frozen.files, target!, JSON.parse(input.bindingJson), input.scope)
          await options.validate(updated.files, context.signal)
          context.signal.throwIfAborted()
          if (linking) {
            // Edit only the existing BOT companion; no Workflow/Connection copy of
            // its address, filter or binding is made. Revision guards stay exact.
            if (options.deployments.freeze(snapshotBotDirectory(path)).revision !== frozen.revision) throw new Error('BOT source changed before link')
            if (!options.canAuthor(context.sessionId)) throw new Error('BOT source owner authority changed.')
            writePrivateFile(join(path, updated.configPath), updated.content)
            frozen = options.deployments.freeze(updated.files)
            gitSource = sourceUsesGit(path)
          } else {
          return JSON.stringify({ status: 'assignment-prepared', scope: input.scope, source: { folderId: input.folderId, directory: input.directory }, channelSessionId: input.channelSessionId,
            sourceRevision: frozen.revision, candidateRevision: options.deployments.freeze(updated.files).revision,
            edit: { path: [...parts, updated.configPath].join('/'), match: frozen.files[updated.configPath], content: updated.content },
            next: 'Use the ordinary authorized write tool for this registered source folder and exact match/content; then bot_package propose with sourceRevision=candidateRevision, the same expectedRevision and summary. Preparation is not a write, deployment, permission or history-replay grant.' })
        }
        }
        if (!linking && input.sourceRevision && frozen.revision !== input.sourceRevision) throw new Error('BOT source changed; inspect it again before proposing')
        gitSource = sourceUsesGit(path)
      } finally {release()}
      const bot = parseBot(frozen.files)
      const current = options.deployments.read(bot.id)?.deployment
      if (current?.revision !== input.expectedRevision) throw new Error('BOT active revision changed. Read status before proposing.')
      await options.validate(frozen.files,context.signal)
      const baseline = current ? botProposalBaseline(options.deployments.read(bot.id)!.files) : undefined
      if (baseline && baseline.bot.id !== bot.id) throw new Error('BOT active identity mismatch.')
      const before = baseline?.bot
      const oldAuthority=authorities(before),newAuthority=authorities(bot)
      if (baseline?.removedProposalGrants?.length) for (const operation of before?.hostCapabilities ?? []) oldAuthority.delete(`BOT host capability ${operation} (invoking binding only)`)
      for (const grant of baseline?.removedProposalGrants ?? []) oldAuthority.add(`Retired proposal-inbox grant ${grant.id}: ${grant.repository}/${grant.inbox} (inactive; no Work authority)`)
      const repair = baseline && (baseline.removedBindingSkills.length || baseline.removedProposalGrants?.length) ? {
        activeInvalid: true, reason: 'Retired binding.skills selectors or proposal-inbox grants; the active package fails the current strict schema. Removed proposal grants never grant Work authority.',
        removedBindingSkills: baseline.removedBindingSkills, removedProposalGrants: baseline.removedProposalGrants ?? [],
        effect: 'Deployment restores a valid BOT definition and its enabled input subscriptions/runtime; it is not only a format change.',
        candidatePermissions: [...newAuthority], expectedRevision: current!.revision, exactContent: frozen.revision,
      } : undefined
      const added=[...newAuthority].filter(value=>!oldAuthority.has(value)),removed=[...oldAuthority].filter(value=>!newAuthority.has(value))
      const affected=[...new Set([...(before?.bindings ?? []),...bot.bindings].map(location))]
      const facts = {projectId:options.projectId,bot:bot.id,source:{folderId:input.folderId,directory:input.directory},sourceGit:gitSource,repair,
        expectedRevision:current?.revision ?? null,exactContent:frozen.revision,fileCount:Object.keys(frozen.files).length,
        affected,addedPermissions:added,removedPermissions:removed,candidatePermissions:[...newAuthority],
        credentialDisclosure:'Credential configuration is represented only by its presence; private references and header values are withheld. Origins, routes and body restrictions remain visible.',
        mode:bot.mode,connection:bot.connection,agent:bot.agent,bindings:disclosedBindings(bot),subscriptions:subscribedBindings(bot).map(bindingSubscription),subscriptionMigration:bot.subscriptions === undefined ? 'legacy bindings (same authority)' : 'explicit',toolDeclarations:bot.tools.map(({name,description,parameters,imports})=>({name,description,parameters,imports})),
        hostCapabilities:bot.hostCapabilities ?? [],modules:bot.allowedModules,readDomains:bot.readDomains ?? [],sourceFolders:bot.sourceFolders ?? [],discordHistory:bot.discordHistory ?? null,
        storage:'BOT- and binding-scoped mutable data, separate from immutable deployment files',
        execution:bot.mode === 'personal' ? 'Normal verified-owner session, ordinary role tools/context; BOT prompt only, no custom modules' : 'Restricted child runtime, no raw credentials/platform clients; no source executes during deployment'}
      // Direct authenticated authoring is the authorization. Exact revision,
      // live scope validation and the publication fence remain technical checks;
      // no second native ask/approval or pending activation state is introduced.
      context.signal.throwIfAborted()
      const deployment = await options.publish(bot.id,async () => {
        if (!options.canAuthor(context.sessionId)) throw new Error('BOT publication owner authority changed.')
        await options.validate(frozen.files,context.signal)
        if (!options.canAuthor(context.sessionId)) throw new Error('BOT publication owner authority changed.')
        return options.deployments.deploy({id:bot.id,source:{folderId:input.folderId,directory:input.directory},files:frozen.files,revision:frozen.revision,expectedRevision:input.expectedRevision,signal:context.signal})
      }, bot)
      options.changed([...new Set([...(before?.bindings ?? []),...bot.bindings].flatMap(binding=>binding.platform === 'discord' ? [binding.id] : []))])
      return JSON.stringify({status:'deployed',deployment,changes:facts})
    },
  }
}

/** Read-only owner inventory. Publication has no separate approval/pending state. */
export function botPackagePlugin(options: Pick<Options,'projectId'|'deployments'|'pending'>, authorize:(request:Request)=>boolean|Promise<boolean>) {
  return (app:Hono) => {
    app.get('/api/bot-package',async context => {
      context.header('Cache-Control','no-store')
      if (!await authorize(context.req.raw)) return context.json({error:'Unauthorized'},401)
      try { return context.json({projectId:options.projectId,deployments:options.deployments.list(),pending:[...options.pending].map(([revision,facts])=>({revision,facts}))}) }
      catch { return context.json({error:'BOT deployment unavailable; active content was not replaced.'},409) }
    })
  }
}
