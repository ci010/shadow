import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const native = 'integrations/agent-desktop'
const binaries = ['shadow-agent-desktop.node', 'shadow-input-guard.exe']
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')

/** Content based, not mtime based: worker/patch/guard changes invalidate old native releases. */
export async function nativeSourceFingerprint(root: string): Promise<string> {
  const files = ['Cargo.toml', 'Cargo.lock', 'build.rs'].map(file => `${native}/${file}`)
  async function walk(directory: string) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  for (const directory of ['src', 'patches', 'scripts']) await walk(`${native}/${directory}`)
  files.push('src/execution/computer/agent-desktop-worker.js', 'src/execution/computer/agent-desktop-errors.js',
    'src/execution/computer/stdio-transport.ts', 'src/execution/computer/windows-input.cs',
    'scripts/agent-desktop-input-guard.ts', 'scripts/agent-desktop-integrity.ts')
  const digest = createHash('sha256')
  for (const file of files.sort()) digest.update(file).update('\0').update(await readFile(join(root, file))).update('\0')
  return digest.digest('hex')
}

export async function recordNativeBuild(root: string, arch: string): Promise<void> {
  const directory = join(root, native, 'artifacts', `win32-${arch}`)
  const artifacts = Object.fromEntries(await Promise.all(binaries.map(async file => [file, hash(await readFile(join(directory, file)))])))
  await writeFile(join(directory, 'build-manifest.json'), JSON.stringify({ version: 1, arch, source: await nativeSourceFingerprint(root), artifacts }, null, 2) + '\n')
}

export async function verifyNativeBuild(root: string, arch: string): Promise<void> {
  const directory = join(root, native, 'artifacts', `win32-${arch}`)
  const manifest = JSON.parse(await readFile(join(directory, 'build-manifest.json'), 'utf8'))
  if (manifest.version !== 1 || manifest.arch !== arch || manifest.source !== await nativeSourceFingerprint(root)) {
    throw new Error('Stale agent-desktop source/worker build fingerprint')
  }
  for (const file of binaries) {
    if (manifest.artifacts?.[file] !== hash(await readFile(join(directory, file)))) throw new Error(`Stale agent-desktop binary: ${file}`)
  }
}
