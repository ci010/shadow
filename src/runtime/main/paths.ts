import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

export async function resolveSelfCodeRoot(workspace: string): Promise<string> {
  const candidates = [
    resolve(workspace, 'src'),
    resolve(workspace, '..', 'src'),
  ]

  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isDirectory()) return candidate
    } catch {
      // Ignore missing candidates.
    }
  }

  return candidates[1]
}

export function resolveUiDistDirectory(moduleDirectory: string | undefined): string | undefined {
  // Preserve the source and emitted layouts relative to the Main host module.
  return moduleDirectory ? resolve(moduleDirectory, '..', '..', '..', 'app', 'dist') : undefined
}
