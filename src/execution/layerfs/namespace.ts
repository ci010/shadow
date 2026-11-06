import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { projectDataPaths } from '../../utils/data-paths.ts'
import { writePrivateFile } from '../../utils/private-file.ts'
import { ToolOutcomeUnknownError } from '../../tools/tool.ts'
import { layerfsName } from './bridge.ts'

const idSchema = z.string().regex(/^[a-f0-9]{32}$/)
const activeSchema = z.object({ version: z.literal(1), projectId: z.string(), namespace: idSchema }).strict()
const descriptorSchema = activeSchema.extend({ previousNamespace: z.union([z.literal('legacy'), idSchema]), createdAt: z.string(),
  ownerSessionId: z.string(), evidence: z.enum(['stopped_distribution', 'no_layerfs_worker_process']), priorFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  importStage: z.enum(['failed', 'unknown']), importCode: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).optional() }).strict()
export interface LayerFSNamespace { id: string; project: string; directory: string }

/** A generation switch selects a new private runtime/Store namespace. Old files
 * are never renamed, rewritten or deleted; old mount IDs are no longer current.
 */
export class LayerFSNamespaces {
  readonly root: string
  private readonly pointer: string
  private legacyPreparation = false
  constructor(private readonly projectId: string, home: string) {
    this.root = join(projectDataPaths(home).state, 'layerfs')
    this.pointer = join(this.root, 'active-generation.json')
  }
  reference(id = 'legacy'): LayerFSNamespace {
    if (id !== 'legacy') idSchema.parse(id)
    return { id, project: layerfsName(id === 'legacy' ? this.projectId : `${this.projectId}\0${id}`),
      directory: id === 'legacy' ? this.root : join(this.root, 'generations', id) }
  }
  private async plain(path: string) {
    const rel = relative(this.root, path)
    if (rel.startsWith('..') || resolve(path) !== resolve(this.root, rel)) throw new ToolOutcomeUnknownError('LayerFS namespace path escaped its owner.')
    let current = this.root
    const pieces = rel ? rel.split(sep) : []
    for (let index = -1; index < pieces.length; index++) {
      if (index >= 0) current = join(current, pieces[index])
      let info
      try { info = await lstat(current) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      if (info.isSymbolicLink() || index < pieces.length - 1 && !info.isDirectory()) throw new ToolOutcomeUnknownError('LayerFS namespace contains a linked or non-directory ancestor; operator inspection required.')
    }
  }
  async current(): Promise<LayerFSNamespace> {
    try {
      await this.plain(this.pointer)
      const pointer = activeSchema.parse(JSON.parse(await readFile(this.pointer, 'utf8')))
      if (pointer.projectId !== this.projectId) throw Error('foreign namespace')
      const value = this.reference(pointer.namespace)
      await this.plain(join(value.directory, 'generation.json'))
      const descriptor = descriptorSchema.parse(JSON.parse(await readFile(join(value.directory, 'generation.json'), 'utf8')))
      if (descriptor.projectId !== this.projectId || descriptor.namespace !== value.id) throw Error('namespace mismatch')
      await this.plain(join(value.directory, 'worker-state.json'))
      if (!(await lstat(join(value.directory, 'worker-state.json'))).isFile()) throw Error('missing namespace state')
      return value
    } catch (error) {
      // Only a genuinely absent active pointer selects the legacy installation.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try { await lstat(this.pointer) } catch (missing) {
          if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing
          if (!this.legacyPreparation) {
            for (const name of ['namespace-history.json', 'generations']) {
              try { await lstat(join(this.root, name)) }
              catch (absent) { if ((absent as NodeJS.ErrnoException).code === 'ENOENT') continue; throw absent }
              throw new ToolOutcomeUnknownError('The active namespace pointer is missing but generation history/preparation exists. Legacy fallback and automatic selection are forbidden.')
            }
          }
          return this.reference()
        }
      }
      throw new ToolOutcomeUnknownError('Active LayerFS namespace cannot be reconciled; no fallback, restart or import was attempted.')
    }
  }
  async history() {
    let current = await this.current()
    const records: { namespace: string; project: string; importStage: string; importCode?: string; evidence: string; quarantinedAt: string }[] = []
    const seen = new Set<string>()
    while (current.id !== 'legacy' && records.length < 32) {
      if (seen.has(current.id)) throw new ToolOutcomeUnknownError('LayerFS quarantine history is cyclic; operator inspection required.')
      seen.add(current.id)
      await this.plain(join(current.directory, 'generation.json'))
      const descriptor = descriptorSchema.parse(JSON.parse(await readFile(join(current.directory, 'generation.json'), 'utf8')))
      if (descriptor.projectId !== this.projectId || descriptor.namespace !== current.id) throw new ToolOutcomeUnknownError('LayerFS quarantine history has a foreign identity.')
      const previous = this.reference(descriptor.previousNamespace)
      records.push({ namespace: previous.id, project: previous.project, importStage: descriptor.importStage, importCode: descriptor.importCode,
        evidence: descriptor.evidence, quarantinedAt: descriptor.createdAt })
      current = previous
    }
    return { records, truncated: current.id !== 'legacy' }
  }
  async fingerprint(namespace: LayerFSNamespace, installation: unknown): Promise<string> {
    if ((await this.current()).id !== namespace.id) throw new ToolOutcomeUnknownError('LayerFS namespace changed during inspection.')
    const digest = createHash('sha256').update(JSON.stringify([namespace.id, installation]))
    for (const name of ['worker-state.json', 'import-state.json', join('runtime', '.runtime', 'init-failures.jsonl')]) {
      const path = join(namespace.directory, name)
      await this.plain(path)
      let file
      try { file = await open(path, 'r') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { digest.update(JSON.stringify([name, null])); continue }; throw error }
      try {
        const info = await file.stat()
        if (!info.isFile()) throw new ToolOutcomeUnknownError('LayerFS import evidence is not a regular file.')
        const bytes = Buffer.alloc(Math.min(info.size, 65536))
        const read = await file.read(bytes, 0, bytes.length, Math.max(0, info.size - bytes.length))
        digest.update(JSON.stringify([name, info.size, info.mtimeMs, info.ctimeMs])).update(bytes.subarray(0, read.bytesRead))
      } finally { await file.close() }
    }
    return digest.digest('hex')
  }
  async prepare(previous: LayerFSNamespace, audit: Omit<z.infer<typeof descriptorSchema>, 'version' | 'projectId' | 'namespace' | 'previousNamespace' | 'createdAt'>): Promise<LayerFSNamespace> {
    // Retain a durable tombstone BEFORE generation writes. If the pointer is lost
    // or preparation crashes, a fresh process must never revive legacy state.
    // Only the current serialized recovery can inspect legacy while preparing.
    if ((await this.current()).id !== previous.id) throw new ToolOutcomeUnknownError('The namespace changed before generation preparation.')
    this.legacyPreparation = previous.id === 'legacy'
    const history = join(this.root, 'namespace-history.json')
    await this.plain(history)
    try { await writeFile(history, JSON.stringify({ version: 1, projectId: this.projectId, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const prior = JSON.parse(await readFile(history, 'utf8'))
      if (prior?.version !== 1 || prior.projectId !== this.projectId) throw new ToolOutcomeUnknownError('Namespace history ownership is invalid; selection refused.')
    }
    await this.plain(join(this.root, 'generations'))
    await mkdir(join(this.root, 'generations'), { recursive: true, mode: 0o700 })
    const next = this.reference(randomBytes(16).toString('hex'))
    await mkdir(next.directory, { mode: 0o700 })
    const descriptor = descriptorSchema.parse({ version: 1, projectId: this.projectId, namespace: next.id, previousNamespace: previous.id,
      createdAt: new Date().toISOString(), ...audit })
    await writeFile(join(next.directory, 'generation.json'), JSON.stringify(descriptor), { flag: 'wx', mode: 0o600 })
    await writeFile(join(next.directory, 'worker-state.json'), JSON.stringify({ phase: 'stopped' }), { flag: 'wx', mode: 0o600 })
    return next
  }
  endPreparation() { this.legacyPreparation = false }
  /** Caller holds the recovery lock and rechecks fingerprint + shutdown first. */
  select(next: LayerFSNamespace) {
    writePrivateFile(this.pointer, JSON.stringify(activeSchema.parse({ version: 1, projectId: this.projectId, namespace: next.id })))
    this.endPreparation()
  }
}
