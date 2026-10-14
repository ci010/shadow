import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export class DataLayoutStartupError extends Error {
  readonly code = 'DATA_LAYOUT_NOT_READY'
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

/** Read-only gate: a desktop singleton or free gateway port is NOT a writer lease.
 * Old backends do not participate in a common lock, so startup cannot safely copy.
 */
export async function assertDataLayoutReady(dataDir: string): Promise<void> {
  const root = resolve(dataDir)
  const control = join(root, '.layout-migration')
  if (await exists(join(control, 'copy.lock'))) {
    throw new DataLayoutStartupError('Data-layout migration is in progress or interrupted. Keep all writers stopped; inspect the receipt/staging before releasing its lock. See docs/data-migration.md.')
  }
  if (await exists(join(control, 'receipt.json'))) {
    const receipt = JSON.parse(await readFile(join(control, 'receipt.json'), 'utf8'))
    if (![1, 2].includes(receipt.version) || receipt.root !== root || !receipt.source || !receipt.target ||
        !await exists(join(root, 'app.json')) || !await exists(join(root, 'projects.json'))) {
      throw new DataLayoutStartupError('Invalid or incomplete data-layout migration receipt; refusing startup. See docs/data-migration.md.')
    }
    // Targets legitimately change after first launch. Do not replay copy or compare
    // the original receipt fingerprints against a now-active installation.
    return
  }
  if (await exists(join(`${root}.projects`, 'projects.v2.json'))) {
    throw new DataLayoutStartupError('Legacy standalone workspace catalog detected; automatic same-root migration is unsupported. Keep writers stopped and arrange an explicit supported data-root migration. See docs/data-migration.md.')
  }
  for (const entry of ['config', 'cluster', 'workspace', 'workspace.projects']) {
    if (await exists(join(root, entry))) {
      throw new DataLayoutStartupError('Legacy data layout detected; startup refused before creating new data. Quit ALL Desktop/Main/service/dev writers, then use the bundled backend data-migration --data-dir <absolute-root> --plan and --copy --offline. Offline is an operator acknowledgement, not writer detection. See docs/data-migration.md.')
    }
  }
}

export interface DataLayoutDetection {
  status: 'ready' | 'migration-required' | 'blocked'
  reason?: string
}

/** Read-only startup/UI classification. Detection is never a writer lease. */
export async function detectDataLayout(dataDir: string): Promise<DataLayoutDetection> {
  try {
    await assertDataLayoutReady(dataDir)
    return { status: 'ready' }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      status: error instanceof DataLayoutStartupError && reason.startsWith('Legacy data layout detected;')
        ? 'migration-required' : 'blocked',
      reason,
    }
  }
}
