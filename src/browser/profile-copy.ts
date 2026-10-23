import { open, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

const locks = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile', 'LOCK'])
const omitted = new Set(['Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'GrShaderCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Crashpad', 'BrowserMetrics', 'DevToolsActivePort'])
const files = ['Cookies', 'Login Data', 'Web Data', 'Preferences', 'Secure Preferences']
const directories = ['Local Storage', 'Session Storage', 'IndexedDB', 'Network']
export interface ProfileSource { userDataDir: string; profileDirectory: string }
export interface ProfileCopyWarning { stage: string; code: string; item: string; osCode?: string }
export interface ProfileCopyReport {
  status: 'ready' | 'ready_with_warnings'
  copiedFiles: number
  absent: string[]
  warnings: ProfileCopyWarning[]
  loginData: 'not_migrated' | 'unverified'
  message: string
}
const safeItem = (item: string) => item.replace(/[\u0000-\u001f\u007f]/g, '?').split(sep).join('/')
const osCode = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException)?.code
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : undefined
}
export class ProfileCopyError extends Error {
  constructor(readonly stage: string, readonly code: string, readonly item: string, readonly osCode?: string) {
    super(`Profile copy failed: stage=${stage} code=${code} item=${JSON.stringify(item)}${osCode ? ` osCode=${osCode}` : ''}. Original profile was not modified.`)
  }
}
const within = (root: string, path: string) => { const rel = relative(root, path); return !rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) }

/** Read-only, selected-profile allowlist. Source failures degrade independently;
 * destination failures, cancellation and invalid source boundaries remain fatal.
 * No snapshot/credential portability guarantee, even when every file copies.
 */
export async function copyUserProfile(source: ProfileSource, destination: string, signal?: AbortSignal, operations: { open: typeof open } = { open }): Promise<ProfileCopyReport> {
  if (!isAbsolute(source.userDataDir) || !/^(Default|Profile [0-9]+)$/.test(source.profileDirectory)) throw new Error('Select an absolute user data root and a Default or Profile N directory explicitly.')
  let created = false
  const report: ProfileCopyReport = { status: 'ready', copiedFiles: 0, absent: [], warnings: [], loginData: 'not_migrated', message: '' }
  const fatal = (stage: string, item: string, error: unknown, code = 'IO_ERROR') => new ProfileCopyError(stage, code, safeItem(item), osCode(error))
  const warn = (stage: string, item: string, error: unknown, code = 'SOURCE_READ_FAILED') => {
    signal?.throwIfAborted()
    report.warnings.push({ stage, item: safeItem(item), code, osCode: osCode(error) })
  }
  const required = async <T>(stage: string, item: string, fn: () => Promise<T>): Promise<T> => {
    signal?.throwIfAborted()
    try { return await fn() } catch (error) { signal?.throwIfAborted(); throw fatal(stage, item, error) }
  }
  try {
    signal?.throwIfAborted()
    const rootInfo = await required('validate-source', '.', () => lstat(source.userDataDir))
    const root = await required('validate-source', '.', () => realpath(source.userDataDir))
    // Reject linked ancestors too, not just the final profile entry.
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || relative(root, source.userDataDir) !== '') throw fatal('validate-source', '.', null, 'UNSUPPORTED_SOURCE')
    const profile = join(root, source.profileDirectory)
    const info = await required('validate-source', source.profileDirectory, () => lstat(profile))
    if (!info.isDirectory() || info.isSymbolicLink() || !within(root, await realpath(profile))) throw fatal('validate-source', source.profileDirectory, null, 'UNSUPPORTED_SOURCE')
    const canonicalDestination = join(await required('validate-destination', '.', () => realpath(dirname(destination))), basename(destination))
    if (within(root, canonicalDestination)) throw fatal('validate-destination', '.', null, 'DESTINATION_INSIDE_SOURCE')
    await required('create-destination', '.', () => mkdir(destination, { mode: 0o700 }))
    created = true
    await required('create-directory', source.profileDirectory, () => mkdir(join(destination, source.profileDirectory), { mode: 0o700 }))
    const copy = async (item: string, expected?: 'file' | 'directory'): Promise<void> => {
      signal?.throwIfAborted()
      const src = join(root, item), dst = join(destination, item)
      let info
      try { info = await lstat(src) } catch (error) {
        if (expected && osCode(error) === 'ENOENT') report.absent.push(safeItem(item))
        else warn('inspect-entry', item, error)
        return
      }
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (expected === 'file' && !info.isFile()) || (expected === 'directory' && !info.isDirectory())) {
        warn('validate-entry', item, null, 'UNSUPPORTED_OR_LINKED_ENTRY'); return
      }
      try { if (!within(root, await realpath(src)) || relative(await realpath(src), src) !== '') { warn('validate-entry', item, null, 'SOURCE_OUTSIDE_BOUNDARY'); return } }
      catch (error) { warn('validate-entry', item, error); return }
      if (info.isDirectory()) {
        let names
        try { names = await readdir(src) } catch (error) { warn('enumerate-directory', item, error); return }
        await required('create-directory', item, () => mkdir(dst, { mode: 0o700 }))
        for (const name of names) if (!omitted.has(name) && !locks.has(name)) await copy(join(item, name))
        return
      }
      let input
      try { input = await operations.open(src, 'r') } catch (error) { warn('open-source', item, error); return }
      let complete = false
      try {
        // Refuse a replaced file before reading it. Never follow a known link.
        let opened, current
        try { opened = await input.stat(); current = await lstat(src) } catch (error) { warn('inspect-source', item, error); return }
        if (current.isSymbolicLink() || opened.ino !== info.ino || opened.dev !== info.dev || current.ino !== info.ino) { warn('validate-entry', item, null, 'SOURCE_CHANGED'); return }
        const output = await required('open-destination', item, () => operations.open(dst, 'wx', 0o600))
        try {
          const buffer = Buffer.alloc(256 * 1024)
          while (true) {
            signal?.throwIfAborted()
            let bytesRead
            try { ({ bytesRead } = await input.read(buffer, 0, buffer.length, null)) } catch (error) { warn('read-source', item, error); return }
            if (!bytesRead) break
            await required('write-destination', item, async () => {
              let offset = 0
              while (offset < bytesRead) {
                const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset, null)
                if (!bytesWritten) throw new Error('Zero length write')
                offset += bytesWritten
              }
            })
          }
          let current
          try { current = await lstat(src) } catch (error) { warn('verify-source', item, error); return }
          if (current.size !== info.size || current.mtimeMs !== info.mtimeMs || current.ctimeMs !== info.ctimeMs) { warn('verify-source', item, null, 'SOURCE_CHANGED'); return }
          complete = true
        } finally { await required('close-destination', item, () => output.close()) }
      } finally {
        try { await input.close() } catch (error) { warn('close-source', item, error) }
        if (!complete) await required('cleanup-entry', item, () => rm(dst, { force: true }))
      }
      if (complete) { report.copiedFiles++; if (/(Cookies|Login Data|Local Storage|Session Storage|IndexedDB)(\/|\\|$)/.test(item)) report.loginData = 'unverified' }
    }
    for (const name of files) {
      await copy(join(source.profileDirectory, name), 'file')
      // SQLite sidecars can contain recent committed state; still no atomic snapshot guarantee.
      for (const suffix of ['-wal', '-shm', '-journal']) if (['Cookies', 'Login Data', 'Web Data'].includes(name)) await copy(join(source.profileDirectory, name + suffix), 'file')
    }
    for (const name of directories) await copy(join(source.profileDirectory, name), 'directory')
    await copy('Local State', 'file')
    signal?.throwIfAborted()
    if (report.loginData === 'not_migrated') warn('summary', '.', null, 'LOGIN_DATA_NOT_MIGRATED')
    report.status = report.warnings.length ? 'ready_with_warnings' : 'ready'
    report.message = report.loginData === 'not_migrated' ? 'No login data was migrated. The usable managed copy may require signing in again.' : 'Key data copied best-effort; login inheritance is unverified. Missing, changing or encrypted data may require signing in again.'
    return report
  } catch (error) {
    if (created) {
      try { await rm(destination, { recursive: true, force: true }) } catch (cleanup) { throw fatal('cleanup-destination', '.', cleanup, 'CLEANUP_FAILED') }
    }
    signal?.throwIfAborted()
    throw error
  }
}
