import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** A synthetic trusted desktop startup contract for tests of the built Vue bundle. */
export async function desktopFixturePreload(directory: string, origin: string): Promise<string> {
  const path = join(directory, 'desktop-fixture-preload.cjs')
  await writeFile(path, `require('electron').contextBridge.exposeInMainWorld('shadowDesktop', {
    bootstrap: {
      load: async () => ({ version: 1, revision: 1, mode: 'main', step: 'complete' }),
      ensureRuntime: async () => ({ ok: true, context: { version: 1, mode: 'main', localNodeId: 'fixture',
        mainConnection: 'connected', mainLatencyMs: null, apiBase: ${JSON.stringify(origin)} } }),
    },
  })`)
  return path
}
