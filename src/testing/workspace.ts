import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

export function createTempWorkspace(): Promise<string> {
  return mkdtemp(join(process.cwd(), '.shadow-test-'))
}

/**
 * Run `fn` with a throwaway temp workspace directory, cleaned up afterwards.
 * Shared across memory/tool/hook tests.
 */
export async function withTempWorkspace(
  fn: (workspace: string) => Promise<void>,
): Promise<void> {
  const workspace = await createTempWorkspace()
  try {
    await fn(workspace)
  } finally {
    await rm(workspace, { recursive: true })
  }
}
