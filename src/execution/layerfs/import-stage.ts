import { classifyLayerFSName } from './import-review.ts'

/** Fixed, default-WSL-user helper (that configured user may itself be root). Never accepts shell text or a destination.
 * Windows runtime scans the returned same-distro UNC path; the root worker
 * translates it to the Linux path. All attempts (including partials) are kept.
 */
export const importStageScript = String.raw`
const fs = await import('node:fs/promises');
const { constants } = await import('node:fs');
const { createHash, randomBytes } = await import('node:crypto');
const { execFileSync } = await import('node:child_process');
const classify = ${classifyLayerFSName.toString()};
const [source, namespace, policy] = process.argv.slice(1);
const refuse = () => { throw new Error('StageRefused'); };
if (!/^[a-zA-Z]:[\\/]/.test(source) || source.includes('\0') || source.split(/[\\/]/).some(p => p === '..' || p === '.') || !/^[a-f0-9]{32}$/.test(namespace) || !['curated','whole_tree'].includes(policy)) refuse();
const root = execFileSync('wslpath', ['-a', '-u', source], { encoding: 'utf8', timeout: 5000 }).trim();
if (!root.startsWith('/') || root.includes('\0') || root.split('/').includes('..')) refuse();
const deadline = performance.now() + 600000;
const check = () => { if (performance.now() >= deadline) refuse(); };
const plain = async path => {
 let current = '/';
 for (const part of path.split('/').filter(Boolean)) {
  current += (current === '/' ? '' : '/') + part;
  const s = await fs.lstat(current);
  if (!s.isDirectory() || s.isSymbolicLink()) refuse();
 }
};
await plain(root); await plain('/var/tmp');
// Only Linux ext filesystems, not DrvFS/9p/FUSE/network-backed destinations.
if (Number((await fs.statfs('/var/tmp')).type) !== 0xef53) refuse();
const envelope = '/var/tmp/shadow-layerfs-stage-' + namespace + '-' + randomBytes(16).toString('hex');
await fs.mkdir(envelope, { mode: 0o700 });
const destination = envelope + '/source';
await fs.mkdir(destination, { mode: 0o700 });
const stamp = s => [s.dev,s.ino,s.mode,s.nlink,s.size,s.mtimeNs].join(':');
async function scan(copy) {
 const records = []; let entries = 0, bytes = 0;
 async function walk(relative, depth, credentialAncestor) {
  check(); if (depth > 128 || ++entries > 100000) refuse();
  const path = relative ? root + '/' + relative : root;
  const before = await fs.lstat(path, { bigint: true });
  if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile()) || (before.mode & 0o6000n) !== 0n || (before.isFile() && (before.mode & 0o1000n) !== 0n)) refuse();
  const name = path.split('/').pop();
  const classification = classify(name, before.isDirectory(), policy, credentialAncestor);
  if (classification.blocker) refuse();
  if (before.isDirectory()) {
   if (copy && relative) await fs.mkdir(destination + '/' + relative, { mode: 0o700 });
   const names = [];
   for await (const entry of await fs.opendir(path)) {
    check(); if (names.length + entries >= 100000) refuse(); names.push(entry.name);
   }
   names.sort();
   for (const name of names) {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) refuse();
    await walk(relative ? relative + '/' + name : name, depth + 1, credentialAncestor || classification.warning === 'credential_related_name_requires_content_review');
   }
   records.push(createHash('sha256').update(JSON.stringify([relative,stamp(before),names])).digest('hex'));
  } else {
   bytes += Number(before.size); if (!Number.isSafeInteger(bytes) || bytes > 16 * 1024 ** 3 || before.nlink !== 1n) refuse();
   const input = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
   let output; const hash = createHash('sha256'); let size = 0;
   try {
    if (stamp(await input.stat({ bigint: true })) !== stamp(before)) refuse();
    if (copy) output = await fs.open(destination + '/' + relative, 'wx', Number(before.mode & 0o777n));
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
     check(); const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
     if (!bytesRead) break;
     size += bytesRead; if (size > Number(before.size)) refuse();
     hash.update(buffer.subarray(0,bytesRead));
     if (output) { let offset = 0; while (offset < bytesRead) { const result = await output.write(buffer, offset, bytesRead - offset); if (!result.bytesWritten) refuse(); offset += result.bytesWritten; } }
    }
    if (size !== Number(before.size) || stamp(await input.stat({ bigint: true })) !== stamp(before)) refuse();
   } finally { await input.close(); await output?.close(); }
   records.push(createHash('sha256').update(JSON.stringify([relative,stamp(before),hash.digest('hex')])).digest('hex'));
  }
  if (stamp(await fs.lstat(path,{ bigint:true })) !== stamp(before)) refuse();
  if (copy) {
   const target = relative ? destination + '/' + relative : destination;
   await fs.chmod(target, Number(before.mode & (before.isDirectory() ? 0o1777n : 0o777n)));
   await fs.utimes(target, Number(before.atimeNs) / 1e9, Number(before.mtimeNs) / 1e9);
  }
 }
 await walk('',0,false);
 return createHash('sha256').update(records.sort().join('\n')).digest('hex');
}
const copied = await scan(true);
if (copied !== await scan(false)) refuse();
check();
process.stdout.write(JSON.stringify({ destination }));
`
