import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Hono } from 'hono'
import type { Tool } from '../tools/tool.ts'
import type { AuthoringManagementOptions } from './management.ts'
import { parseFrontmatter } from '../utils/frontmatter.ts'
import type { IntegrationStore } from '../channels/integration-store.ts'
import { readBotSources, compileBotPackage, replaceBotPackage } from './bot-package.ts'

type BotPackageOptions = Pick<AuthoringManagementOptions, 'service' | 'validateLive' | 'publicationRequests' | 'inventory'> & { discord?: IntegrationStore }

const importSchema = z.object({ folderId: z.string().min(1), directory: z.string().max(1024).default(''), expectedRevision: z.string(), adoptLegacy: z.boolean().optional(), expectedActiveRelease: z.string().optional(), discordRevision: z.number().int().nonnegative().optional() }).strict()

export async function stageBotDirectory(options: BotPackageOptions, input: unknown) {
  const parsed = importSchema.parse(input)
  const parts = parsed.directory ? parsed.directory.split('/') : []
  if (parts.some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..')) throw new Error('Choose a relative BOT subdirectory without traversal.')
  const folders = options.service.options.folders
  const release = folders.acquireAccess()
  try {
    const folder = await folders.requireAvailable(parsed.folderId)
    if (folder.kind === 'remote') throw new Error('Remote BOT snapshot import is not implemented; no Main fallback is allowed.')
    let directory = folder.path
    for (const part of parts) {
      directory = join(directory, part)
      if (lstatSync(directory).isSymbolicLink()) throw new Error('BOT directory symlinks are forbidden.')
    }
    const source = readBotSources(directory)
    const metadata = parseFrontmatter(source['BOT.md'] ?? '').frontmatter
    if (metadata.platform === 'discord') {
      if (!options.discord || parsed.discordRevision === undefined) throw new Error('Discord package review requires the exact Discord configuration revision.')
      return { discordDraft: await options.discord.propose({kind:'owner',id:'shadow-owner'}, {kind:'bot.save', package:{id:metadata.name,source}, ...(parsed.adoptLegacy ? {adoptLegacy:true} : {})}, parsed.discordRevision, new AbortController().signal) }
    }
    const bundle = compileBotPackage(source)
    const store = options.service.options.store
    if (parsed.adoptLegacy && parsed.expectedActiveRelease !== store.snapshot().revision) throw new Error('Legacy adoption requires the exact active Release.')
    const aggregate = replaceBotPackage(store.snapshot().bundle, bundle, parsed.adoptLegacy)
    const candidate = store.candidate(aggregate)
    const validation = store.validate(candidate)
    if (!validation.valid) throw new Error(validation.errors.join('; '))
    await options.validateLive(candidate)
    return await store.stage({ expectedRevision: parsed.expectedRevision, bundle: aggregate, expectedActiveRelease: parsed.expectedActiveRelease })
  } finally { release() }
}

/** Project-bound chat entry point. Approval is deliberately absent from this contract. */
export function botPackageTool(options: BotPackageOptions & { canAuthor: (sessionId: string) => boolean; registeredFolders?: () => unknown }): Tool {
  return {
    name: 'bot_package', optIn: true,
    description: 'Freeze a registered local Folder BOT directory into an immutable owner review. status returns authoritative Project revisions and package status. propose never publishes; the human reviews and approves in chat.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['status', 'propose'] }, folderId: { type: 'string' }, directory: { type: 'string' },
      expectedRevision: { type: 'string' }, expectedActiveRelease: { type: 'string' }, discordRevision: { type: 'integer' }, adoptLegacy: { type: 'boolean' },
    }, required: ['action'], additionalProperties: false },
    execute: async (raw, context) => {
      context.signal.throwIfAborted()
      if (context.projectId !== options.service.options.projectId || context.channel !== 'web' || context.inputSource !== 'user' ||
        context.admin !== true || context.isGroup || context.channelAddress || context.remoteWorkdir || context.memoryAccess ||
        context.tools.executionMode !== 'session' || !options.canAuthor(context.sessionId)) throw new Error('Use an authenticated owner conversation in this Project.')
      const store = options.service.options.store
      if (raw.action === 'status') {
        z.object({action:z.literal('status')}).strict().parse(raw)
        return JSON.stringify({ projectId: options.service.options.projectId, draftRevision: store.draft().revision,
          activeRelease: store.snapshot().revision, packages: store.packageStatus(), discord: options.discord?.snapshot(), inventory: options.inventory(), folders: options.registeredFolders?.(), publicationRequests: options.publicationRequests.list() })
      }
      const { action, ...input } = z.object({action:z.literal('propose')}).passthrough().parse(raw)
      const staged = await stageBotDirectory(options, input)
      if ('discordDraft' in staged) return JSON.stringify({ ...staged, nextStep: 'The owner must inspect and approve the exact pending review in chat. No live configuration changed.' })
      const request = await options.publicationRequests.propose(undefined, staged.revision, context.sessionId, input.expectedActiveRelease as string | undefined)
      return JSON.stringify({request, nextStep:'The owner must inspect and approve the exact publication card in chat. No live configuration changed.'})
    },
  }
}

/** Owner-only local snapshot/review API. There is deliberately no activation endpoint here. */
export function botPackagePlugin(options: BotPackageOptions, authorize: (request: Request) => boolean | Promise<boolean>) {
  return (app: Hono) => {
    app.use('/api/bot-package*', async (context, next) => { context.header('Cache-Control', 'no-store'); await next() })
    app.get('/api/bot-package', async context => {
      if (!await authorize(context.req.raw)) return context.json({ error: 'Unauthorized' }, 401)
      const store = options.service.options.store
      return context.json({ draftRevision: store.draft().revision, activeRelease: store.snapshot().revision, retained: store.history(), packages: store.packageStatus(), discord: options.discord?.snapshot(), discordPackages: Object.entries(options.discord?.snapshot().packages ?? {}).map(([id,p])=>({id,activeRelease:p.revision,retained:p.history.map(source=>({revision:createHash('sha256').update(JSON.stringify(source)).digest('hex')}))})), inventory: options.inventory() })
    })
    app.post('/api/bot-package/review', async context => {
      if (!await authorize(context.req.raw)) return context.json({ error: 'Unauthorized' }, 401)
      try {
        const text = await context.req.text()
        if (text.length > 4096) return context.json({ error: 'Request too large' }, 413)
        const input = JSON.parse(text)
        const store = options.service.options.store
        let revision: string
        if (input.discordRelease) {
          const rollback = z.object({discordRelease:z.string(),packageId:z.string(),discordRevision:z.number().int().nonnegative(),expectedRevision:z.string()}).strict().parse(input)
          const retained = options.discord?.snapshot().packages[rollback.packageId]?.history.find(p=>createHash('sha256').update(JSON.stringify(p)).digest('hex') === rollback.discordRelease)
          if (!retained || !options.discord) throw new Error('Unknown Discord BOT Release')
          return context.json({discordDraft: await options.discord.propose({kind:'owner',id:'shadow-owner'}, {kind:'bot.save',package:retained},rollback.discordRevision,context.req.raw.signal)})
        }
        if (input.release) {
          const rollback = z.object({ release: z.string(), packageId: z.string(), expectedRevision: z.string() }).strict().parse(input)
          const retained = store.candidate(replaceBotPackage(store.snapshot().bundle, store.retainedPackage(rollback.packageId, rollback.release)))
          await options.validateLive(retained)
          revision = (await store.stage({ expectedRevision: rollback.expectedRevision, bundle: retained.bundle })).revision
        } else {
          const staged = await stageBotDirectory(options, input)
          if ('discordDraft' in staged) return context.json(staged)
          revision = staged.revision
        }
        const request = await options.publicationRequests.propose(undefined, revision, 'owner:bot-package', input.expectedActiveRelease)
        return context.json({ request })
      } catch (error) {
        return context.json({ error: error instanceof Error ? error.message : 'BOT review failed; active Release unchanged.' }, 400)
      }
    })
  }
}
