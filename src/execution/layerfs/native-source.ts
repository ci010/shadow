import { createHash } from 'node:crypto'
import { z } from 'zod'
import { ToolNoEffectError } from '../../tools/tool.ts'

/** Dedicated native source area, separate from the SDK Store and runtime home. */
export function nativeSourceRoot(project: string, runtime: string, macHome?: string) {
  if (macHome) return macHome + '/sources'
  return '/var/lib/shadow-layerfs-sources/' + createHash('sha256').update(JSON.stringify([project, runtime])).digest('hex')
}
export function nativeSourcePath(root: string, name: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name)) throw new ToolNoEffectError('Native source name must be one directory name, not a path or distribution.')
  return `${root}/${name}`
}
const evidenceSchema = z.array(z.object({ path: z.string(), real: z.string(), directory: z.boolean(), linked: z.boolean(), device: z.string(), inode: z.string(), uid: z.number(), mode: z.number(), filesystem: z.string() }).strict()).min(1)
export function verifyNativeSource(path: string, evidence: unknown, macUid?: number) {
  const entries = evidenceSchema.parse(evidence)
  const paths = ['/', ...path.split('/').filter(Boolean).map((_, i, parts) => '/' + parts.slice(0, i + 1).join('/'))]
  if (entries.length !== paths.length) throw new ToolNoEffectError('Incomplete native source filesystem evidence.')
  for (const [i, entry] of entries.entries()) {
    if (entry.path !== paths[i] || entry.real !== entry.path || entry.linked || !entry.directory) throw new ToolNoEffectError('Linked or rebound native source refused.')
    // WSL ext4 or macOS APFS only. Fail closed on foreign/unknown filesystems;
    // pathname checks alone are insufficient.
    if (entry.filesystem !== (macUid === undefined ? '61267' : '26')) throw new ToolNoEffectError('Platform-native source required (WSL ext4 or macOS APFS); DrvFS and foreign filesystems refused.')
    if ((entry.uid !== 0 && entry.uid !== macUid) || (entry.mode & 0o022) !== 0) throw new ToolNoEffectError('Native source ancestors must have approved host ownership and not be group/world writable.')
  }
  return JSON.stringify(entries)
}

// Fixed read-only probe executed by the existing runtime owner in its bound WSL
// distribution. No shell interpolation, arbitrary script or caller-chosen root.
export const nativeSourceProbe = `
const fs = require('node:fs/promises');
(async () => {
 const path = process.argv[1];
 const paths = ['/', ...path.split('/').filter(Boolean).map((_, i, parts) => '/' + parts.slice(0, i + 1).join('/'))];
 const result = [];
 for (const path of paths) {
  const s = await fs.lstat(path, {bigint:true});
  if (s.isSymbolicLink() || !s.isDirectory() || s.uid !== 0n || (s.mode & 18n) !== 0n) throw Error('Unsafe ancestor');
  const real = await fs.realpath(path);
  if (real !== path) throw Error('Linked ancestor');
  const f = await fs.statfs(path, {bigint:true});
  if (f.type !== 61267n) throw Error('Non-native ancestor');
  result.push({path,real,directory:s.isDirectory(),linked:s.isSymbolicLink(),device:String(s.dev),inode:String(s.ino),uid:Number(s.uid),mode:Number(s.mode),filesystem:String(f.type)});
 }
 process.stdout.write(JSON.stringify(result));
})().catch(() => { process.exitCode = 1; });
`

/** macOS source is host APFS, read-only mounted by official Init. No Linux root
 * ownership or ext4 assumptions. Rechecked before each admission; not an OS sandbox. */
export const macSourceProbe = nativeSourceProbe
  .replace("s.uid !== 0n", "(s.uid !== 0n && s.uid !== BigInt(process.getuid()))")
  .replace('f.type !== 61267n', 'f.type !== 26n')
