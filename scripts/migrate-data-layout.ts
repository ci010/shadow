#!/usr/bin/env node
/** Manual offline utility; never imported by runtime startup. */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { copyDataMigration, planDataMigration } from '../src/storage/data-migration.ts'

export async function main(args = process.argv.slice(2)) {
  const allowed = new Set(['--plan', '--copy', '--offline', '--data-dir', '--help'])
  let dataDir: string | undefined
  const flags = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!allowed.has(arg) || flags.has(arg)) throw new Error(`Unknown or duplicate argument: ${arg}`)
    flags.add(arg)
    if (arg === '--data-dir') {
      dataDir = args[++i]
      if (!dataDir || dataDir.startsWith('--')) throw new Error('--data-dir requires an explicit directory')
    }
  }
  if (flags.has('--help')) {
    console.log('Usage: node --import tsx scripts/migrate-data-layout.ts --data-dir <root> [--plan | --copy --offline]\nDefault --plan is read-only/preliminary, not a consistency guarantee. Before --copy, STOP ALL Shadow/backend/desktop/device writers and other programs writing this root. --offline only acknowledges this obligation; it cannot prove writers stopped. Source is retained unchanged. Never manually remove an interrupted .layout-migration/copy.lock without reviewing receipt/staging/publication and rollback. Windows long paths are supported; POSIX permission modes are retained, but custom ACLs require separate review.')
    return
  }
  if (!dataDir) throw new Error('--data-dir is required; no implicit production directory')
  if (flags.has('--copy') && flags.has('--plan')) throw new Error('Choose --plan or --copy')
  if (flags.has('--offline') && !flags.has('--copy')) throw new Error('--offline applies only to --copy')
  console.log(JSON.stringify(flags.has('--copy')
    ? await copyDataMigration(resolve(dataDir), { offline: flags.has('--offline') })
    : await planDataMigration(resolve(dataDir)), null, 2))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
