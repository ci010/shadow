import { copyFile, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { agentDesktopDirectory, agentDesktopTarget, verifyAgentDesktopAssets } from './agent-desktop-integrity.ts'

/** All six desktop targets require the official CLI and their adjacent helpers.
 * Copy an allowlist only: never old addon/guard, session state, sources or caches. */
export async function copyAgentDesktopAssets(root: string, output: string, options: {
  platform?: string; arch?: string
} = {}, verify: (root: string, platform: string, arch: string) => ReturnType<typeof verifyAgentDesktopAssets> = verifyAgentDesktopAssets): Promise<boolean> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const target = agentDesktopTarget(platform, arch)
  try { await verify(root, platform, arch) } catch (error) {
    throw new Error(`Missing or invalid official agent-desktop CLI for ${platform}-${arch}. Explicitly run node scripts/download-agent-desktop.ts ${platform} ${arch}, then rebuild. Existing invalid assets must be relocated explicitly; no addon repair or system dependency installation is performed.`, { cause: error })
  }
  // Prepared JS may originate on Linux. Keep only this runner's target assets
  // in the controlled packaging output; never prune the source cache.
  const outputArtifacts = join(output, 'integrations/agent-desktop/artifacts')
  await mkdir(outputArtifacts, { recursive: true })
  if (await realpath(outputArtifacts) === await realpath(join(root, 'integrations/agent-desktop/artifacts'))) throw new Error('Desktop packaging output must be separate from the source cache')
  for (const entry of await readdir(outputArtifacts)) {
    if (entry !== `${platform}-${arch}`) await rm(join(outputArtifacts, entry), { recursive: true, force: true })
  }
  const destination = agentDesktopDirectory(output, platform, arch)
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  for (const file of [...target.files, 'manifest.integrity.json']) {
    await copyFile(join(agentDesktopDirectory(root, platform, arch), file), join(destination, file))
  }
  // Legal notices are maintained in source, not shipped in official CLI archives.
  const notices = join(output, 'integrations/agent-desktop')
  await mkdir(notices, { recursive: true })
  for (const file of ['LICENSE', 'NOTICE']) await copyFile(join(root, 'integrations/agent-desktop', file), join(notices, file))
  await verify(output, platform, arch)
  return true
}
