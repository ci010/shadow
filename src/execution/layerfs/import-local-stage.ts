import { cp, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { importSelection } from './import-selection.ts'
import { LayerFSImportReview } from './import-review.ts'

/** Retained private staging tree, never source mutation; no installs or index updates. */
export async function stageLocalImport(source: string, signal: AbortSignal): Promise<string> {
  const review = new LayerFSImportReview()
  const before = await review.fingerprint(source, signal)
  const selection = await importSelection(source)
  const envelope = await mkdtemp(join(await realpath(tmpdir()), 'shadow-layerfs-stage-'))
  const destination = join(envelope, 'source')
  await cp(source, destination, { recursive: true, dereference: false, errorOnExist: true, force: false,
    filter: path => { signal.throwIfAborted(); const p = relative(source, path).split(sep).join('/'); return !p || selection.includes(p) } })
  if (before !== await review.fingerprint(source, signal)) throw new Error('Import source changed during staging; partial staging retained')
  await review.consume(undefined, destination, 'local-stage', undefined, signal)
  return destination
}
