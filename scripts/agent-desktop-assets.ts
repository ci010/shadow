import { copyFile, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

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
  try {
    for (const file of files) {
      const info = await stat(join(source, file))
      if (!info.isFile() || info.size === 0) throw new Error(`Invalid agent-desktop release asset: ${file}`)
    }
  } catch (error) {
    const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
    throw new Error(`agent-desktop native assets are missing or invalid for ${platform}-${arch}. From integrations/agent-desktop, run node scripts/fetch.mjs and node scripts/build.mjs ${triple} in a VS developer shell; then rebuild the backend. See integrations/agent-desktop/README.md.`, { cause: error })
  }
  for (const file of files) {
    const target = join(output, 'integrations/agent-desktop', file)
    await mkdir(join(target, '..'), { recursive: true })
    await copyFile(join(source, file), target)
  }
  return true
}
