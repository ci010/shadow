import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir, platform } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SessionManager } from './session-manager.ts'
import type { SessionState } from './session-store.ts'
import { RETIREMENT_INACTIVITY_DAYS, retirementProposalSchema } from './retirement-contract.ts'
import { sessionWorkspacePath } from '../utils/paths.ts'

export function inside(root: string, path: string): boolean {
  const part = relative(resolve(root), resolve(path))
  return !!part && !part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part)
}

/** Reject symlinks/junctions in every existing component, including the root. */
export async function plainPath(path: string): Promise<void> {
  let current = resolve(path)
  for (;;) {
    const info = await lstat(current)
    if (info.isSymbolicLink() || info.isFile() && info.nlink > 1) throw new Error('Linked retirement path is protected')
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}

const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
export function safeDeliveryName(name: string): boolean {
  return !!name && !/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(name) &&
    !/[. ]$/.test(name) && !/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name)
}
export interface DraftFile { path: string; hash: string; text: string }

export async function inspectDrafts(root: string): Promise<DraftFile[]> {
  try { await lstat(root) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  await plainPath(root)
  const files: DraftFile[] = []
  let size = 0
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      await plainPath(path)
      if (entry.isDirectory()) await visit(path)
      else {
        if (!entry.isFile()) throw new Error('Non-regular draft is protected')
        const info = await lstat(path)
        size += info.size
        if (files.length >= 100 || size > 80_000) throw new Error('Draft inventory exceeds closeout inspection limit')
        const bytes = await readFile(path)
        files.push({ path: relative(root, path), hash: digest(bytes),
          text: bytes.includes(0) ? '[binary: preserve byte-for-byte]' : bytes.toString('utf8') })
      }
    }
  }
  await visit(root)
  return files
}

/** Existing Project wiki, not per-session memory, event logs, or compaction. */
export async function inspectWiki(workspace: string): Promise<Array<{ path: string; content: string }>> {
  const root = join(workspace, 'memory')
  const pages: Array<{ path: string; content: string }> = []
  let size = 0
  const visit = async (directory: string): Promise<void> => {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    await plainPath(directory)
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || directory === root && ['sessions', 'events'].includes(entry.name.toLowerCase())) continue
      const path = join(directory, entry.name)
      await plainPath(path)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        size += (await lstat(path)).size
        if (size > 80_000 || pages.length >= 100) throw new Error('Wiki exceeds safe closeout inspection limit')
        pages.push({ path, content: await readFile(path, 'utf8') })
      }
    }
  }
  await visit(root)
  return pages
}

/** Only discovered OS paths, never a guessed localized directory or Desktop. */
export async function discoverDeliveryRoots(): Promise<Record<string, string>> {
  let paths: Record<string, string> = {}
  if (platform() === 'win32') {
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$k=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'; @{Documents=$k.Personal;Pictures=$k.'My Pictures';Videos=$k.'My Video';Music=$k.'My Music';Downloads=$k.'{374DE290-123F-4565-9164-39C4925E467B}'} | ConvertTo-Json -Compress`],
    { timeout: 10_000, windowsHide: true })
    const values: unknown = JSON.parse(stdout)
    if (values && typeof values === 'object') for (const [key, value] of Object.entries(values)) {
      if (typeof value === 'string') paths[key] = value.replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? `%${name}%`)
    }
  } else if (platform() === 'darwin') {
    paths = Object.fromEntries(['Documents', 'Pictures', 'Videos', 'Music', 'Downloads']
      .map(key => [key, join(homedir(), key === 'Videos' ? 'Movies' : key)]))
  } else {
    try {
      const text = await readFile(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'user-dirs.dirs'), 'utf8')
      for (const [key, name] of Object.entries({ DOCUMENTS: 'Documents', PICTURES: 'Pictures', VIDEOS: 'Videos', MUSIC: 'Music', DOWNLOAD: 'Downloads' })) {
        const match = text.match(new RegExp(`^XDG_${key}_DIR="([^"\\n]+)"$`, 'm'))
        if (match) paths[name] = match[1].replace(/^\$HOME(?=\/|$)/, homedir())
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const result: Record<string, string> = {}
  for (const [key, path] of Object.entries(paths)) {
    if (!isAbsolute(path)) continue
    try {
      await plainPath(path)
      if ((await lstat(path)).isDirectory()) result[key] = join(await realpath(path), 'Shadow')
    } catch { /* Unavailable OS folders are not delivery destinations. */ }
  }
  return result
}

export interface RetirementOptions {
  sessions: SessionManager
  workspace: string
  /** Must include effective crons, approvals and local/remote process receipts. */
  protected: (sessionId: string) => boolean
  folderPath: (state: SessionState) => string | undefined
}

export class SessionRetirement {
  private inspections = new Map<string, {
    assessor: string; expires: number; sessionId: string
    snapshot: NonNullable<Awaited<ReturnType<SessionManager['retirementSnapshot']>>>
    drafts: DraftFile[]; selected?: string; roots: Record<string, string>
    wiki: Array<{ path: string; content: string }>
    release: () => void
  }>()
  constructor(private readonly options: RetirementOptions) {}

  async candidates(signal: AbortSignal): Promise<string[]> {
    const result: string[] = []
    for (const entry of this.options.sessions.listSessions()) {
      signal.throwIfAborted()
      if (!this.options.protected(entry.sessionId) &&
        await this.options.sessions.retirementSnapshot(entry.sessionId, RETIREMENT_INACTIVITY_DAYS)) result.push(entry.sessionId)
    }
    return result
  }

  /** Evidence is bound to one ordinary automation execution, never accepted back from the model. */
  async inspect(sessionId: string, assessor: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const { sessions, workspace } = this.options
    if (this.options.protected(sessionId)) throw new Error('Session is protected')
    const snapshot = await sessions.retirementSnapshot(sessionId, RETIREMENT_INACTIVITY_DAYS)
    if (!snapshot) throw new Error('Session is not eligible')
    const root = sessionWorkspacePath(workspace, sessionId)
    const drafts = await inspectDrafts(root)
    const selected = this.options.folderPath(snapshot.state)
    if (snapshot.state.folderId && !selected) throw new Error('Selected Folder unavailable or remote')
    const roots = selected ? { Folder: selected } : await discoverDeliveryRoots()
    const wiki = await inspectWiki(workspace)
    signal.throwIfAborted()
    for (const [key, inspection] of this.inspections) if (inspection.expires <= Date.now() ||
      inspection.assessor === assessor && inspection.sessionId === sessionId) this.forget(key)
    if (this.inspections.size >= 100) throw new Error('Too many outstanding inspections')
    const token = randomUUID()
    const abort = () => this.forget(token)
    this.inspections.set(token, { assessor, sessionId, expires: Date.now() + 900_000, snapshot, drafts, selected, roots, wiki,
      release: () => signal.removeEventListener('abort', abort) })
    signal.addEventListener('abort', abort, { once: true })
    return { token, sessionId, roots, history: snapshot.records, drafts, wiki }
  }

  private forget(token: string): void {
    this.inspections.get(token)?.release()
    this.inspections.delete(token)
  }

  async apply(token: string, input: unknown, assessor: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const inspection = this.inspections.get(token)
    if (!inspection || inspection.assessor !== assessor || inspection.expires <= Date.now()) throw new Error('Inspection missing, expired or owned by another execution')
    this.forget(token)
    const { snapshot, drafts, selected, roots, wiki, sessionId } = inspection
    const { sessions, workspace } = this.options
    const root = sessionWorkspacePath(workspace, sessionId)
    const proposal = retirementProposalSchema.parse(input)
    if (proposal.outcome === 'blocked' || proposal.knowledge === 'unresolved') throw new Error(`Blocked: ${proposal.reason}`)
    if (proposal.outcome === 'continued' && !proposal.continuationSessionId) throw new Error('Continuation not specified')
    let continuationState: string | undefined
    const verifyContinuation = () => {
      if (proposal.outcome !== 'continued') return
      const target = sessions.getSessionState(proposal.continuationSessionId!)
      if (!target || target.retirement || target.mode !== 'session' || target.recovery || target.sessionId === sessionId ||
        target.projectId !== snapshot.state.projectId ||
        !JSON.stringify(snapshot.records).includes(target.sessionId)) throw new Error('Unverified continuation')
      const current = digest(JSON.stringify(target))
      if (continuationState && continuationState !== current) throw new Error('Continuation state changed')
      continuationState = current
    }
    verifyContinuation()
    if (proposal.outcome === 'continued') {
      const targetHistory = await sessions.getHistory(proposal.continuationSessionId!, { shallow: true })
      if (!JSON.stringify(targetHistory.messages).includes(sessionId)) throw new Error('Continuation has no durable source context')
    }
    const currentSnapshot = await sessions.retirementSnapshot(sessionId, RETIREMENT_INACTIVITY_DAYS)
    if (!currentSnapshot || currentSnapshot.fingerprint !== snapshot.fingerprint || this.options.protected(sessionId)) throw new Error('Retirement gates changed or proposal stale')
    if (this.options.folderPath(currentSnapshot.state) !== selected) throw new Error('Selected Folder changed')
    if (proposal.knowledge === 'already-preserved' && !proposal.knowledgeFiles.length) throw new Error('Knowledge proof missing')
    const knowledgeProofs = new Map<string, string>()
    for (const path of proposal.knowledgeFiles) {
      const page = wiki.find(page => page.path === path)
      if (!page) throw new Error('Knowledge must be inspected existing Project wiki')
      await plainPath(path)
      const hash = digest(await readFile(path))
      if (hash !== digest(page.content)) throw new Error('Inspected wiki changed')
      knowledgeProofs.set(path, hash)
    }
    if (proposal.knowledge === 'preserve' && !proposal.knowledgeEntries.length) throw new Error('Knowledge preservation missing')
    if (proposal.knowledge !== 'preserve' && proposal.knowledgeEntries.length) throw new Error('Inconsistent knowledge proposal')
    for (const page of proposal.knowledgeEntries) {
      if (!safeDeliveryName(page.name)) throw new Error('Unsafe wiki name')
      const existing = wiki.find(other => other.content.trim() === page.content.trim())
      if (existing) {
        await plainPath(existing.path)
        const hash = digest(await readFile(existing.path))
        if (hash !== digest(existing.content)) throw new Error('Inspected wiki changed')
        knowledgeProofs.set(existing.path, hash)
        continue
      }
      const directory = join(workspace, 'memory', 'retirement')
      await plainPath(workspace)
      for (const path of [join(workspace, 'memory'), directory]) {
        try { await mkdir(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        await plainPath(path)
      }
      const path = join(directory, page.name)
      const content = `${page.content.trim()}\n`
      await writeFile(path, content, { flag: 'wx' })
      await plainPath(path)
      const bytes = await readFile(path)
      if (bytes.toString('utf8') !== content) throw new Error('Wiki preservation verification failed')
      knowledgeProofs.set(path, digest(bytes))
    }
    if (proposal.files.length !== drafts.length || new Set(proposal.files.map(file => file.source)).size !== drafts.length) throw new Error('Incomplete draft delivery')
    const saved: Array<{ path: string; hash: string }> = []
    const allowed = Object.values(roots)
    for (const file of proposal.files) {
      const source = drafts.find(draft => draft.path === file.source)
      if (!source || !safeDeliveryName(basename(file.destination)) || !isAbsolute(file.destination) || !allowed.some(base => dirname(resolve(file.destination)) === resolve(base)) ||
        inside(workspace, file.destination)) throw new Error('Unsafe delivery path')
      const destinationRoot = dirname(file.destination)
      if (!selected) {
        await plainPath(dirname(destinationRoot))
        try { await mkdir(destinationRoot) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      }
      await plainPath(destinationRoot)
      const sourcePath = join(root, source.path)
      await plainPath(sourcePath)
      if (digest(await readFile(sourcePath)) !== source.hash) throw new Error('Draft changed')
      await copyFile(sourcePath, file.destination, constants.COPYFILE_EXCL)
      await plainPath(file.destination)
      if (digest(await readFile(file.destination)) !== source.hash) throw new Error('Delivery verification failed')
      saved.push({ path: file.destination, hash: source.hash })
    }
    await sessions.retireSession(sessionId, snapshot.fingerprint, RETIREMENT_INACTIVITY_DAYS, {
      retiredAt: new Date().toISOString(), fingerprint: snapshot.fingerprint, assessorSessionId: assessor, reason: proposal.reason,
    }, async () => {
      const recheck = () => {
        signal.throwIfAborted()
        if (this.options.protected(sessionId)) throw new Error('Retirement gates changed')
        if (this.options.folderPath(snapshot.state) !== selected) throw new Error('Folder changed')
        verifyContinuation()
      }
      recheck()
      if (JSON.stringify(await inspectDrafts(root)) !== JSON.stringify(drafts)) throw new Error('Draft inventory changed')
      for (const [path, hash] of [...saved.map(file => [file.path, file.hash] as const), ...knowledgeProofs]) {
        await plainPath(path)
        if (digest(await readFile(path)) !== hash) throw new Error('Preservation evidence changed')
      }
      return recheck
    })
    return 'retired (recoverable; no physical deletion)'
  }
}
