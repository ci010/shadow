import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Hono } from 'hono'
import type { Tool, ToolResult } from '../tools/tool.ts'
import type { FolderRegistry } from '../folders/registry.ts'
import { BotDeployments } from '../bots/deployments.ts'
import { parseBot, type BotDefinition } from '../bots/sdk.ts'
import { DirectoryBots } from './bot-runtime.ts'
import { snapshotBotDirectory, sourceUsesGit } from './bot-directory.ts'

type Options = {
  inventory?:()=>unknown
  projectId: string; deployments: BotDeployments; runtime: DirectoryBots
  folders: Pick<FolderRegistry,'acquireAccess'|'requireAvailable'|'list'>
  ask: Tool<ToolResult>; canAuthor: (sessionId:string) => boolean
  validate: (files:Record<string,string>,signal:AbortSignal) => Promise<void>
  pending: Map<string, unknown>
  publish: <T>(id:string,change:()=>Promise<T>, candidate?:BotDefinition) => Promise<T>; changed: (ids:string[]) => void
}
const proposal = z.object({action:z.literal('propose'),folderId:z.string().min(1).max(128),directory:z.string().max(1024).default(''),expectedRevision:z.string().optional(),summary:z.string().trim().min(1).max(800)}).strict()

function location(binding: ReturnType<typeof parseBot>['bindings'][number]): string {
  return binding.platform === 'discord' ? `Discord ${binding.target.kind === 'dm' ? 'DM '+binding.target.userId : binding.target.guildId+'/'+binding.target.channelId}` : `${binding.platform} ${binding.botInstanceId}/${binding.conversationId}`
}
function authorities(bot: ReturnType<typeof parseBot> | undefined): Set<string> {
  if(!bot)return new Set()
  const facts:string[]=[`mode ${bot.mode}`, ...(bot.mode === 'personal' ? [`personal connection ${bot.connection}; role ${bot.agent}; ordinary verified-owner tools/context`] : [])]
  facts.push(...bot.tools.flatMap(tool=>tool.imports.map(name=>`tool ${tool.name}: service module ${name}`)))
  for(const name of bot.allowedModules)facts.push(`BOT module ceiling ${name}`)
  for(const id of bot.sourceFolders ?? [])facts.push(`BOT source-folder ceiling ${id}`)
  for(const id of bot.readDomains ?? [])facts.push(`BOT memory-domain ceiling ${id}`)
  if(bot.discordHistory)facts.push(`BOT history ceiling ${bot.discordHistory.guildId}/${bot.discordHistory.channelIds.join(',')} threads=${bot.discordHistory.threads} preEpoch=${bot.discordHistory.preEpoch}`)
  for(const binding of bot.bindings){
    const target=location(binding)
    facts.push(`${target}: ${binding.enabled ? 'enabled' : 'disabled'}`)
    for(const name of binding.tools)facts.push(`${target}: tool ${name}`)
    for(const grant of binding.grants ?? [])facts.push(`${target}: ${grant.kind === 'http' ? grant.routes.map(route=>`${route.method} ${grant.origin}${route.path}`).join(', ') : 'inbox '+grant.sessionId}`)
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

export function botPackageTool(options: Options): Tool {
  return {name:'bot_package',optIn:true,
    description:'Manage unified directory BOTs for QQ, Feishu and Discord. status lists deployed revisions and registered folders. propose snapshots a local registered source directory, validates data without executing code, then asks one exact-content owner confirmation. Supply a concise user-facing summary. No review history or embedded source snapshots. Edit source and propose again to update.',
    parameters:{type:'object',properties:{action:{type:'string',enum:['status','propose']},folderId:{type:'string'},directory:{type:'string'},expectedRevision:{type:'string'},summary:{type:'string'}},required:['action'],additionalProperties:false},
    execute:async(raw,context) => {
      context.signal.throwIfAborted()
      if (context.projectId !== options.projectId || context.channel !== 'web' || context.inputSource !== 'user' || context.admin !== true || context.isGroup || context.channelAddress || context.remoteWorkdir || context.memoryAccess || context.tools.executionMode !== 'session' || !options.canAuthor(context.sessionId)) throw new Error('Use an authenticated owner conversation in this Project.')
      if (raw.action === 'status') {
        z.object({action:z.literal('status')}).strict().parse(raw)
        return JSON.stringify({projectId:options.projectId,deployments:options.deployments.list(),folders:options.folders.list(),inventory:options.inventory?.(),format:'BOT.md {id, config: bot.json} + data-only bot.json + tool modules'})
      }
      const input = proposal.parse(raw)
      const parts = input.directory ? input.directory.split('/') : []
      if (parts.some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..')) throw new Error('Choose a relative BOT directory without traversal.')
      const release = options.folders.acquireAccess()
      let frozen: ReturnType<BotDeployments['freeze']>, gitSource = false
      try {
        const folder = await options.folders.requireAvailable(input.folderId)
        if (folder.kind === 'remote') throw new Error('BOT source must be a registered local Folder; no Main fallback is permitted.')
        let path = folder.path
        if (lstatSync(path).isSymbolicLink()) throw new Error('BOT source symlinks are forbidden.')
        for (const part of parts) {path=join(path,part);if(lstatSync(path).isSymbolicLink())throw new Error('BOT source symlinks are forbidden.')}
        frozen = options.deployments.freeze(snapshotBotDirectory(path))
        gitSource = sourceUsesGit(path)
      } finally {release()}
      const bot = parseBot(frozen.files)
      const current = options.deployments.read(bot.id)?.deployment
      if (current?.revision !== input.expectedRevision) throw new Error('BOT active revision changed. Read status before proposing.')
      await options.validate(frozen.files,context.signal)
      const facts = {projectId:options.projectId,bot:bot.id,source:{folderId:input.folderId,directory:input.directory},sourceGit:gitSource,
        exactContent:frozen.revision,fileCount:Object.keys(frozen.files).length,
        mode:bot.mode,connection:bot.connection,agent:bot.agent,bindings:bot.bindings,toolDeclarations:bot.tools.map(({name,description,parameters,imports})=>({name,description,parameters,imports})),
        modules:bot.allowedModules,readDomains:bot.readDomains ?? [],sourceFolders:bot.sourceFolders ?? [],discordHistory:bot.discordHistory ?? null,
        storage:'BOT- and binding-scoped mutable data, separate from immutable deployment files',
        execution:bot.mode === 'personal' ? 'Normal verified-owner session, ordinary role tools/context; BOT prompt only, no custom modules' : 'Restricted child runtime, no raw credentials/platform clients; no source executes during deployment'}
      const approve = `Deploy ${bot.id}`
      options.pending.set(frozen.revision,facts)
      const before = current ? parseBot(options.deployments.read(bot.id)!.files) : undefined
      const oldAuthority=authorities(before),newAuthority=authorities(bot)
      const added=[...newAuthority].filter(value=>!oldAuthority.has(value)),removed=[...oldAuthority].filter(value=>!newAuthority.has(value))
      const targets=[...new Set([...(before?.bindings ?? []),...bot.bindings].map(location))]
      let result: ToolResult
      try {
        result = await options.ask.execute({kind:'decision',question:`Agent summary: ${input.summary.replace(/\s+/g,' ')}\nAffected: ${targets.join('; ') || 'no channel bindings'}.\nAdded permissions: ${added.join('; ') || 'none'}.\nRemoved permissions: ${removed.join('; ') || 'none'}.\nDeploy this frozen BOT version? Optional exact source/permission details are in Channels → BOT deployments.`,options:[approve,'Cancel deployment'],default_option:'Cancel deployment'},context)
      } finally { options.pending.delete(frozen.revision) }
      const answer = typeof result === 'string' ? JSON.parse(result) as Record<string,unknown> : undefined
      if (!answer || answer.option !== approve || answer.answeredBy !== 'user' || answer.custom) return JSON.stringify({status:'cancelled',bot:bot.id,activeUnchanged:true})
      context.signal.throwIfAborted()
      // Recheck live authority after the human delay; approval never blesses future permission changes.
      const deployment = await options.publish(bot.id,async () => {
        await options.validate(frozen.files,context.signal)
        return options.deployments.deploy({id:bot.id,source:{folderId:input.folderId,directory:input.directory},files:frozen.files,revision:frozen.revision,expectedRevision:input.expectedRevision,signal:context.signal})
      }, bot)
      options.changed([...new Set([...(before?.bindings ?? []),...bot.bindings].flatMap(binding=>binding.platform === 'discord' ? [binding.id] : []))])
      return JSON.stringify({status:'deployed',deployment})
    },
  }
}

/** Read-only owner inventory. Publication is the single native ask confirmation in bot_package. */
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
