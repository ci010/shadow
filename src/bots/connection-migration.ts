import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, rmSync, rmdirSync } from 'node:fs'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { z } from 'zod'
import { BotDeployments, freezeDirectory, freeze, type BotDeployment } from './deployments.ts'
import { parseBotPackage } from './sdk.ts'
import { BotConnectionPolicy, parseConnectionConfig, splitLegacyConnectionConfig } from '../channels/connection-config.ts'
import { writePrivateFile } from '../utils/private-file.ts'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const connection = z.object({ id: z.string().min(1).max(128), projectId: z.string().min(1), platform: z.enum(['qq', 'feishu', 'discord', 'wechat']),
  displayName: z.string().min(1), config: z.record(z.unknown()), purpose: z.enum(['personal', 'service', 'legacy']).default('legacy'),
  legacySessionId: z.literal(true).optional(), verifiedOwner: z.object({ senderId: z.string(), chatId: z.string(), verifiedAt: z.string() }).strict().optional() }).strict()
const document = z.object({ version: z.union([z.literal(2), z.literal(3)]), bots: z.array(connection).max(1000) }).strict()
export const MigrationProjectSchema = z.object({
  projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/), home: z.string().min(1), connections: z.string().min(1), deployments: z.string().min(1),
  sources: z.array(z.object({ folderId: z.string().min(1), directory: z.string(), path: z.string().min(1) }).strict()),
  privateFiles: z.array(z.string().min(1)).optional(),
  discordKinds: z.record(z.enum(['channel', 'thread'])).optional(),
}).strict()
export const MigrationManifestSchema = z.object({ version: z.literal(1), projects: z.array(MigrationProjectSchema).min(1) }).strict()
export type MigrationProject = z.infer<typeof MigrationProjectSchema>
const FileChange = z.object({ path: z.string(), before: z.string(), after: z.string() }).strict()
const BotChange = z.object({ id: z.string(), before: z.unknown(), originalFiles: z.record(z.string()), files: z.record(z.string()), revision: z.string() }).strict()
const JournalSchema = z.object({ version: z.literal(1), projectId: z.string(), connections: z.string(), deployments: z.string(), state: z.enum(['prepared', 'completed', 'restoring', 'restored']),
  files: z.array(FileChange), bots: z.array(BotChange), privateFiles: z.array(z.object({ path: z.string(), encoding: z.literal('base64'), contents: z.string() }).strict()),
}).strict()
function noLinks(path: string) {
  for (let cursor = resolve(path);; cursor = dirname(cursor)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Migration refuses linked paths')
    if (dirname(cursor) === cursor) break
  }
}
function regular(path: string): string {
  noLinks(path)
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw new Error('Migration requires bounded regular files')
  return readFileSync(path, 'utf8')
}
function openStore(project: MigrationProject) {
  regular(join(project.deployments, '.store.json')) // no create-on-read during dry-run
  // Use the deployment store's isolated local Git plumbing. Offline forbids
  // runtime/source/platform execution, not maintaining its private history.
  // In particular, never downgrade an existing Git-managed store to bounded.
  return new BotDeployments({ projectId: project.projectId, directory: project.deployments })
}
function plan(project: MigrationProject) {
  const before = regular(project.connections), raw = document.parse(JSON.parse(before))
  if (new Set(raw.bots.map(bot => bot.id)).size !== raw.bots.length || raw.bots.some(bot => bot.projectId !== project.projectId)) throw new Error('Migration Project ownership mismatch')
  const split = new Map(raw.bots.map(bot => {
    const value = splitLegacyConnectionConfig(bot.config)
    if (Array.isArray(value.policy.allowFrom) && !value.policy.allowFrom.length) delete value.policy.allowFrom // legacy [] meant unrestricted
    BotConnectionPolicy.parse(value.policy); parseConnectionConfig(bot.platform, value.transport)
    return [bot.id, value] as const
  }))
  const store = openStore(project), active = store.list(), referenced = new Set<string>()
  const transform = (files: Record<string, string>, isActive: boolean) => {
    const { bot, configPath } = parseBotPackage(files)
    const ids = new Set(bot.mode === 'personal' ? [bot.connection!] : bot.bindings.map(binding => binding.botInstanceId))
    for (const binding of bot.bindings) if (raw.bots.find(item => item.id === binding.botInstanceId)?.platform !== binding.platform) throw new Error('BOT Connection platform mismatch')
    for (const binding of bot.bindings) if (binding.platform === 'discord' && binding.target.kind === 'channel') {
      const kind = project.discordKinds?.[`${binding.botInstanceId}/${binding.target.channelId}`]
      if (kind !== 'channel') throw new Error(kind === 'thread' ? 'Legacy thread assignment requires an explicit migration decision; not promoted to parent' : 'Discord target kind requires offline verified receiver evidence')
    }
    const config = JSON.parse(files[configPath]!), policies = { ...bot.connectionPolicies }
    for (const id of ids) {
      const value = split.get(id)
      if (!value) throw new Error('BOT references an unknown Connection')
      if (isActive) referenced.add(id)
      if (!Object.keys(value.policy).length) continue
      if (policies[id] && JSON.stringify(policies[id]) !== JSON.stringify(value.policy)) throw new Error('BOT already has a different Connection policy; explicit reconciliation required')
      policies[id] = BotConnectionPolicy.parse(value.policy)
    }
    if (!Object.keys(policies).length) return files
    config.connectionPolicies = policies
    const result = { ...files, [configPath]: JSON.stringify(config, null, 2) + '\n' }; parseBotPackage(result)
    return result
  }
  const bots: z.infer<typeof BotChange>[] = []
  for (const deployment of active) {
    if (!project.sources.some(source => source.folderId === deployment.source.folderId && source.directory === deployment.source.directory)) throw new Error('Active BOT source mapping is required')
    const current = store.read(deployment.id)!, files = transform(current.files, true), frozen = freeze(files)
    if (frozen.revision !== deployment.revision) bots.push({ id: deployment.id, before: deployment, originalFiles: current.files, files, revision: frozen.revision })
  }
  const files: z.infer<typeof FileChange>[] = []
  for (const source of project.sources) {
    const snapshot = freezeDirectory(source.path), updated = transform(snapshot.files, false)
    for (const [name, after] of Object.entries(updated)) if (after !== snapshot.files[name]) files.push({ path: join(source.path, name), before: snapshot.files[name]!, after })
  }
  // Unbound Connections (including personal) need no collector BOT. Their old
  // transport filters disappear; without a deployed BOT production admits no model.
  const after = JSON.stringify({ ...raw, version: 3, bots: raw.bots.map(bot => ({ ...bot, config: split.get(bot.id)!.transport })) }, null, 2) + '\n'
  if (raw.version !== 3 || raw.bots.some(bot => Object.keys(split.get(bot.id)!.policy).length)) files.push({ path: project.connections, before, after }) // transport switches LAST
  return { files, bots }
}
export interface MigrationOptions {
  assertOffline(project: MigrationProject): void
  action: 'plan' | 'apply' | 'restore'
  checkpoint?: (stage: string) => void
}

/** Explicit offline operation, never runtime startup. Private journal contains
 * original config/source/active snapshots and credential copies: never Git it.
 * Resume checks exact old/new identities. No sessions/runs/BOT data are rewritten,
 * no platform or source is executed. Private local Git history is maintained
 * through BotDeployments (no remotes/hooks/filters). Process recovery, not power-loss atomicity.
 * Caller must establish exclusive stopped-runtime ownership before entering.
 */
export async function migrateConnectionProjects(input: readonly MigrationProject[], options: MigrationOptions) {
  const projects = z.array(MigrationProjectSchema).min(1).parse(input), identities = new Set<string>()
  for (const p of projects) { if (identities.has(p.projectId)) throw new Error('Explicit unique Project list required'); identities.add(p.projectId) }
  const reports: Array<{ projectId: string; status: string; backup?: string; changedFiles: number; changedBots: number }> = []
  for (const project of projects) {
    options.assertOffline(project)
    for (const path of [project.home, project.connections, project.deployments, ...project.sources.map(s => s.path), ...(project.privateFiles ?? [])]) {
      if (!isAbsolute(path)) throw new Error('Migration requires absolute explicit paths')
      noLinks(path)
    }
    if (options.action === 'plan') {
      const result = plan(project)
      for (const path of project.privateFiles ?? []) regular(path)
      reports.push({ projectId: project.projectId, status: 'planned', changedFiles: result.files.length, changedBots: result.bots.length }); continue
    }
    const backup = join(project.home, '.connection-policy-migration'), journalPath = join(backup, 'journal.json'), lock = join(backup, '.lock')
    noLinks(backup); mkdirSync(backup, { recursive: true, mode: 0o700 }); mkdirSync(lock, { mode: 0o700 })
    try {
      let journal: z.infer<typeof JournalSchema>
      if (existsSync(journalPath)) {
        journal = JournalSchema.parse(JSON.parse(regular(journalPath)))
        if (journal.projectId !== project.projectId || journal.connections !== project.connections || journal.deployments !== project.deployments) throw new Error('Migration backup identity mismatch')
      } else {
        if (options.action === 'restore') throw new Error('No migration backup exists')
        const initial = plan(project)
        journal = { version: 1, projectId: project.projectId, connections: project.connections, deployments: project.deployments, state: 'prepared', ...initial,
          privateFiles: (project.privateFiles ?? []).map(path => { regular(path); return { path, encoding: 'base64' as const, contents: readFileSync(path).toString('base64') } }) }
        if (Buffer.byteLength(JSON.stringify(journal)) > 16 * 1024 * 1024) throw new Error('Migration private journal exceeds its bounded recovery limit')
        writeFileSync(journalPath, JSON.stringify(journal), { flag: 'wx', mode: 0o600 })
      }
      if (options.action === 'apply' && journal.state === 'restored') throw new Error('Migration was restored; archive its backup before planning a new migration')
      if (options.action === 'apply' && journal.state === 'restoring') throw new Error('Migration restore is incomplete; resume restore offline')
      if (options.action === 'restore' ? journal.state !== 'restored' : journal.state !== 'completed') {
        if (options.action === 'restore') {
          journal.state = 'restoring'; writePrivateFile(journalPath, JSON.stringify(journal))
        }
        options.checkpoint?.('backup-written')
        const store = openStore(project), restoring = options.action === 'restore'
        // Preflight every mutable source before changing any active deployment.
        for (const change of journal.files) if (![hash(change.before), hash(change.after)].includes(hash(regular(change.path)))) throw new Error('File changed after migration backup')
        for (const change of journal.bots) {
          const old = change.before as BotDeployment, current = store.read(change.id)
          const desired = restoring ? old.revision : change.revision, expected = restoring ? change.revision : old.revision
          if (current?.deployment.revision !== desired) {
            if (current?.deployment.revision !== expected) throw new Error('Active BOT changed after migration backup')
            await store.deploy({ id: change.id, source: old.source, files: restoring ? change.originalFiles : change.files, revision: desired, expectedRevision: expected })
          }
          options.checkpoint?.('bot-migrated')
        }
        for (const change of journal.files) {
          const desired = restoring ? change.before : change.after
          if (hash(regular(change.path)) !== hash(desired)) writePrivateFile(change.path, desired)
          options.checkpoint?.(change.path === project.connections ? 'connections-migrated' : 'source-migrated')
        }
        journal.state = restoring ? 'restored' : 'completed'; writePrivateFile(journalPath, JSON.stringify(journal))
      }
      reports.push({ projectId: project.projectId, status: journal.state, backup: journalPath, changedFiles: journal.files.length, changedBots: journal.bots.length })
    } finally { rmSync(lock, { recursive: true }) }
  }
  return reports
}

/** Startup refuses partial/locked migration state rather than observing a half
 * switched Connection/BOT authority. Does not migrate or repair anything. */
export function assertConnectionMigrationSettled(home: string, projectId: string): void {
  const root = join(home, '.connection-policy-migration')
  noLinks(root)
  if (existsSync(join(root, '.lock'))) throw new Error('Connection migration is locked; offline operator recovery required')
  const path = join(root, 'journal.json')
  if (existsSync(path)) {
    const journal = JournalSchema.parse(JSON.parse(regular(path)))
    if (journal.projectId !== projectId || (journal.state === 'prepared' || journal.state === 'restoring')) throw new Error('Connection migration is incomplete; resume or restore offline before startup')
  }
}

/** Explicit operator assertion of exclusivity is required before this call. */
export function recoverConnectionMigrationLock(project: MigrationProject): void {
  const lock = join(project.home, '.connection-policy-migration', '.lock')
  noLinks(lock)
  if (existsSync(lock)) {
    if (!lstatSync(lock).isDirectory()) throw new Error('Migration lock is not an owned empty directory')
    // Never recursively delete an unexpected object or another store's lock.
    rmdirSync(lock)
  }
}
