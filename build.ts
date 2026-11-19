import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { buildBackend } from './scripts/backend-build.ts'

const args = process.argv.slice(2)
const development = args[0] === '--development'
if (development) args.shift()
if (args.length && (args.length !== 2 || args[0] !== '--desktop-stage' || !args[1])) {
  throw new Error('Expected [--development] [--desktop-stage <directory>]')
}
const output = args[1] ? join(args[1], 'dist') : join(process.cwd(), 'dist')
// A staged build must never overwrite an existing bundle (even on failure).
if (args[1]) await mkdir(output)
await buildBackend(process.cwd(), output, { development })
console.log(`Built Node backend: ${join(output, 'src', 'index.js')}`)
