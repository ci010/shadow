import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeMainDirectoryPath } from './runtime-config.js'

export function defaultMainDirectory(homeDirectory: string = homedir()): string {
  return normalizeMainDirectoryPath(join(normalizeMainDirectoryPath(homeDirectory), '.shadow'))
}
