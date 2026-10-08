import { resolve } from 'node:path'

export function resolveUiDistDirectory(moduleDirectory: string | undefined): string | undefined {
  // Preserve the source and emitted layouts relative to the Main host module.
  return moduleDirectory ? resolve(moduleDirectory, '..', '..', '..', 'app', 'dist') : undefined
}
