import { copyFile, mkdir, stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyNativeBuild } from './agent-desktop-integrity.ts'

/** Allowlist only reviewed release artifacts; never copy Rust sources, target/,
 * refs_store, downloaded upstream checkout, or other private native state.
 * Windows builds require the sole native backend; other platforms omit it. */
export async function copyAgentDesktopAssets(root: string, output: string, options: {
  platform?: string; arch?: string
} = {}): Promise<boolean> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  if (platform !== 'win32') return false
  if (!['x64', 'arm64'].includes(arch)) {
    throw new Error('agent-desktop native packaging supports only win32-x64 and win32-arm64.')
  }
  const source = join(root, 'integrations/agent-desktop')
  const name = 'shadow-agent-desktop.node'
  const artifact = join('artifacts', `${platform}-${arch}`, name)
  const guard = join('artifacts', `${platform}-${arch}`, 'shadow-input-guard.exe')
  const files = [artifact, guard, 'LICENSE', 'NOTICE']
  // Published bundles carry complete corresponding source/licenses into every package.
  const receipt = JSON.parse(await readFile(join(source, 'artifacts', `${platform}-${arch}`, 'build-manifest.json'), 'utf8').catch(() => '{}'))
  if (receipt.artifacts?.['provenance.json']) {
    files.splice(2, 2, ...['LICENSE', 'NOTICE', 'source.tar.gz', 'THIRD-PARTY-NOTICES.json', 'provenance.json'].map(name => join('artifacts', `${platform}-${arch}`, name)))
  }
  try {
    await verifyNativeBuild(root, arch)
    for (const file of files) {
      const info = await stat(join(source, file))
      if (!info.isFile() || info.size === 0) throw new Error(`Invalid agent-desktop release asset: ${file}`)
    }
  } catch (error) {
    throw new Error(`agent-desktop native assets are missing or invalid (or stale) for ${platform}-${arch}. Check access to the pinned release and rerun pnpm install.`, { cause: error })
  }
  for (const file of files) {
    const target = join(output, 'integrations/agent-desktop', file)
    await mkdir(join(target, '..'), { recursive: true })
    await copyFile(join(source, file), target)
  }
  return true
}
