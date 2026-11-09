/** Pinned layerfs-node/src/project.rs init_failure message, not generic SDK text.
 * jobs.js drops structured detail, so only its exact no-cleanup-suffix form is
 * accepted. Unknown/localized/augmented messages deliberately have no detail.
 */
export function importRefusal(error: unknown, source: unknown): { reason: 'Changed' | 'Mtime' | 'NotDirectory' | 'Mode'; path: string; mode?: string } | undefined {
  if (!error || typeof error !== 'object' || typeof source !== 'string') return
  const e = error as { code?: unknown; message?: unknown }
  if (e.code !== 'InvalidInput' || typeof e.message !== 'string' || e.message.length > 8192) return
  const match = /^project\.init refused (\/[^\r\n\0]+): (the entry changed while Init read it|the modification time is out of range|the source is not a directory|mode ([0-7]{4}) has bits LayerFS cannot store \(set-user-ID, set-group-ID, or sticky on a file\))$/.exec(e.message)
  if (!match) return
  let root = source.replaceAll('\\', '/')
  const unc = /^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+(\/.*)$/i.exec(root)
  if (unc) root = unc[1]!
  else if (/^[A-Za-z]:\//.test(root)) root = '/mnt/' + root[0]!.toLowerCase() + root.slice(2)
  if (!root.startsWith('/') || root.startsWith('//') || root.split('/').includes('..')) return
  root = root.replace(/\/$/, '')
  const path = match[1] === root ? '.' : match[1]!.startsWith(root + '/') ? match[1]!.slice(root.length + 1) : undefined
  if (!path || path.length > 240 || !/^[A-Za-z0-9_./ @()+-]+$/.test(path) || path.split('/').some(p => p === '..' || !p)) return
  const reason = match[3] ? 'Mode' : match[2] === 'the entry changed while Init read it' ? 'Changed' : match[2] === 'the modification time is out of range' ? 'Mtime' : 'NotDirectory'
  return { reason, path, ...(match[3] ? { mode: match[3] } : {}) }
}
