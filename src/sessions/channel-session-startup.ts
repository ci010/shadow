import { createHash } from 'node:crypto'
import { readFile, open, rename, writeFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { channelMigrationReceipt, channelStoreFingerprint, migrateChannelSessions, type ChannelMigrationManifest } from './channel-session-migration.ts'

/** Explicit operator plan, consumed only during host boot, before ownership/store reads.
 * No environment toggle and no implicit migration of an arbitrary Project. */
export interface ChannelStartupPlan {
  version: 1
  projectId: string
  manifest: ChannelMigrationManifest
  /** Acknowledge that every other writer must be stopped before this host boots. */
  exclusiveRestart: true
}
async function exists(path: string) {
  try { await stat(path); return true } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e }
}
function digest(manifest: ChannelMigrationManifest) { return createHash('sha256').update(JSON.stringify(manifest)).digest('hex') }
/** No live-runtime retry is permitted. Interrupted swaps are completed from the
 * verified staged store; the original is always retained at .pre-canonical. */
export async function installChannelSessionsAtStartup(directory: string, projectId: string): Promise<boolean> {
  directory = resolve(directory)
  const planPath = `${directory}.channel-migration-plan.json`
  if (!await exists(planPath)) return false
  const plan = JSON.parse(await readFile(planPath, 'utf8')) as ChannelStartupPlan
  if (plan.version !== 1 || plan.exclusiveRestart !== true || plan.projectId !== projectId || plan.manifest?.projectId !== projectId) throw new Error('Invalid channel startup migration plan')
  const manifestHash = digest(plan.manifest)
  const matches = async (path: string) => {
    if (!await exists(`${path}/${channelMigrationReceipt}`)) return false
    const receipt = JSON.parse(await readFile(`${path}/${channelMigrationReceipt}`, 'utf8'))
    if (receipt.manifestHash !== manifestHash || receipt.projectId !== projectId) throw new Error('Channel startup migration receipt mismatch')
    return true
  }
  if (await matches(directory)) return false
  const lockPath = `${directory}.channel-startup-install.lock`
  const lock = await open(lockPath, 'wx')
  // Retain a stale lock after process death: an operator must inspect it and the
  // retained stores before explicitly removing it. Never guess writer liveness.
  try {
    const staged = `${directory}.canonical-staged`, backup = `${directory}.canonical-backup`, retired = `${directory}.pre-canonical`
    const journal = `${directory}.channel-install-journal.json`
    if (await exists(journal)) {
      const previous = JSON.parse(await readFile(journal, 'utf8'))
      if (previous.manifestHash !== manifestHash || previous.projectId !== projectId || previous.stagedFingerprint !== await channelStoreFingerprint(staged) || !await matches(staged)) throw new Error('Interrupted channel installation needs operator repair')
      if (await exists(directory)) {
        if (await exists(retired)) throw new Error('Ambiguous interrupted channel installation')
        await rename(directory, retired)
      } else if (!await exists(retired)) throw new Error('Original channel store missing')
      await rename(staged, directory)
      return true
    }
    if (await exists(staged) || await exists(backup) || await exists(retired)) throw new Error('Channel installation paths already exist; review before retry')
    await migrateChannelSessions({ directory, manifest: plan.manifest, output: staged, backup, runtimeStopped: true })
    if (!await matches(staged)) throw new Error('Verified channel staging receipt missing')
    await writeFile(journal, JSON.stringify({ version: 1, projectId, manifestHash, stagedFingerprint: await channelStoreFingerprint(staged) }), { flag: 'wx' })
    await rename(directory, retired)
    await rename(staged, directory)
    return true
  } finally {
    await lock.close()
    const { unlink } = await import('node:fs/promises')
    await unlink(lockPath)
  }
}
