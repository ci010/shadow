import process from 'node:process'
import { runRootProcessEntry } from './runtime/main/cli.ts'

export { runBackendCli, runRootProcessEntry } from './runtime/main/cli.ts'
export { startMainRuntime } from './runtime/main/start.ts'
export { createOrganizationRuntime } from './runtime/main/organization-runtime.ts'
export type { MainRuntimeHandle, MainRuntimeOptions } from './runtime/main/contracts.ts'

if (import.meta.main) {
  runRootProcessEntry().catch((err) => {
    console.error('[main] Fatal error', err)
    process.exit(1)
  })
}
