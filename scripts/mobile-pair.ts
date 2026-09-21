import { pathToFileURL } from 'node:url'
import { runMobilePair } from '../src/runtime/mobile-pairing-cli.ts'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runMobilePair(process.argv.slice(2)) }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'Mobile pairing failed')
    process.exitCode = 1
  }
}
