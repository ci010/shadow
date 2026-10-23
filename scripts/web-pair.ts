import { pathToFileURL } from 'node:url'
import { runWebPair } from '../src/runtime/web-pairing-cli.ts'

export { createWebPairing, loadPairConnection, parsePairArguments, runWebPair } from '../src/runtime/web-pairing-cli.ts'
export type { PairOptions } from '../src/runtime/web-pairing-cli.ts'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runWebPair(process.argv.slice(2)) } catch (error) {
    console.error(error instanceof Error ? error.message : 'Web pairing failed')
    process.exitCode = 1
  }
}
