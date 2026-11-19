import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Keep ordinary JS dependency installs independent of desktop release assets.
 * pnpm dev explicitly prepares the pinned CLI for the host; standalone builds
 * prepare it separately and fail closed if the assets are missing or invalid. */
export async function prepareNativeAfterInstall(
  _root: string,
  _env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  arch: string = process.arch,
  dependencies = { info: console.info },
): Promise<void> {
  dependencies.info(`[shadow postinstall] No desktop native build or automatic download. pnpm dev prepares assets automatically. Before standalone build or packaging, run node scripts/download-agent-desktop.ts ${platform} ${arch} to prepare the pinned official CLI and required helpers. No system dependencies or OS permissions are changed.`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareNativeAfterInstall(process.cwd())
}
