import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { projectDataPaths } from '../../utils/data-paths.ts'
import { ToolNoEffectError } from '../../tools/tool.ts'
import { isTerminalBootstrapEvidence, type RemoteBootstrapTerminalProof } from './remote-jobs.ts'
import type { RemoteLayerFSTarget } from './remote-client.ts'
const journalSchema = z.object({ version: z.literal(1), projectId: z.string(), sessionId: z.string(), executionId: z.string(), phase: z.string(), step: z.string(), code: z.string().optional(),
  approval: z.object({ sessionId: z.string(), physicalId: z.string(), requestId: z.string() }).strict(), provisioningStarted: z.boolean().optional(), diagnostic: z.object({ launcherExited: z.boolean(), reason: z.string() }).passthrough().optional(),
}).passthrough()
/** Read only exact target-owned bootstrap evidence. Never cancels, starts, cleans or repairs. */
export async function inspectRemoteBootstrapTerminal(home: string, target: RemoteLayerFSTarget, targetJobId: string, active: boolean): Promise<RemoteBootstrapTerminalProof> {
  const id = z.string().regex(/^layerfs-target:[a-f0-9-]{36}$/).parse(targetJobId).slice('layerfs-target:'.length)
  const directory = join(projectDataPaths(home).state, 'layerfs', 'bootstrap')
  const read = async (path: string) => {
    try {
      const metadata = await lstat(path)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65536) throw new ToolNoEffectError('Invalid target bootstrap journal; guard retained')
      const journal = journalSchema.parse(JSON.parse(await readFile(path, 'utf8')))
      if (journal.projectId !== target.projectScope || journal.approval.sessionId !== journal.sessionId) throw new ToolNoEffectError('Foreign target bootstrap journal; guard retained')
      return journal.executionId === 'bg:' + id ? { journal, path } : undefined
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  let found = await read(join(directory, 'bootstrap.json'))
  if (!found) {
    const history = join(directory, 'history')
    let names: string[] = []
    try { names = (await readdir(history)).filter(name => /^[a-f0-9]{32}-[a-z_]+\.json$/.test(name)).sort() }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (names.length > 256) throw new ToolNoEffectError('Target bootstrap history exceeds bounded reconciliation; inspect retained target journals before selecting exact terminal evidence. Guard retained.')
    for (const name of names) { found = await read(join(history, name)); if (found) break }
  }
  if (!found) throw new ToolNoEffectError('Exact target bootstrap job journal unavailable. Main guard retained; inspect target bootstrap_status and retained request receipt. Never replay provisioning.')
  const { journal, path } = found
  const facts = { phase: journal.phase, active, provisioningStarted: journal.provisioningStarted, launcherExited: journal.diagnostic?.launcherExited, diagnosticReason: journal.diagnostic?.reason }
  const terminal = isTerminalBootstrapEvidence(facts)
  return { ...target, ...facts, targetJobId, approval: journal.approval, step: journal.step, code: journal.code, journal: path, terminal,
    reason: terminal ? 'Verified terminal target journal; retained artifacts are not rollback or cleanup.' : 'Target provisioning is active or unconfirmed. Guard retained. Inspect this target journal/status and authoritative cleanup evidence; cancellation/disconnect are not terminal proof.', noReplay: true }
}
