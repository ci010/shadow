import { copyFile, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Allowlist only reviewed release artifacts; never copy Rust sources, target/,
 * refs_store, downloaded upstream checkout, or other private native state. */
export async function copyAgentDesktopAssets(root: string, output: string, options: {
  required?: boolean; platform?: string; arch?: string; warn?: (message: string) => void
} = {}): Promise<boolean> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const required = options.required ?? process.env.SHADOW_COMPUTER_BACKEND === 'agent-desktop'
  const warn = options.warn ?? console.warn
  if (platform !== 'win32' || !['x64', 'arm64'].includes(arch)) {
    if (required) throw new Error('agent-desktop native packaging supports only win32-x64 and win32-arm64.')
    return false
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
    if (required || !(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw new Error(`agent-desktop native assets are missing or invalid for ${platform}-${arch}; build integrations/agent-desktop before native packaging.`, { cause: error })
    }
    warn(`[build] Optional agent-desktop addon/guard assets absent for ${platform}-${arch}; packaged native backend will fail closed. Default PowerShell backend is unchanged.`)
    return false
  }
  for (const file of files) {
    const target = join(output, 'integrations/agent-desktop', file)
    await mkdir(join(target, '..'), { recursive: true })
    await copyFile(join(source, file), target)
  }
  return true
}
