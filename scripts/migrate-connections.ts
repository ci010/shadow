import { readFileSync } from 'node:fs'
import { MigrationManifestSchema, migrateConnectionProjects, recoverConnectionMigrationLock } from '../src/bots/connection-migration.ts'

// Operator-owned offline command. Never discovers Projects, reads global config,
// starts a runtime, connects a platform, or prints config/credentials.
const [action, manifestPath, ...flags] = process.argv.slice(2)
if (!['plan', 'apply', 'restore'].includes(action ?? '') || !manifestPath || flags.some(flag => !['--runtime-stopped', '--recover-lock'].includes(flag))) {
  console.error('Usage: pnpm exec node --import tsx scripts/migrate-connections.ts plan|apply|restore /absolute/private-manifest.json --runtime-stopped [--recover-lock]')
  process.exitCode = 2
} else {
  try {
    if (!flags.includes('--runtime-stopped')) throw new Error('Stop all owning runtimes before reading or writing migration files')
    const manifest = MigrationManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
    if (flags.includes('--recover-lock')) for (const project of manifest.projects) {
      // Explicit operator recovery only. Never guesses a stale lock by age.
      recoverConnectionMigrationLock(project)
    }
    const reports = await migrateConnectionProjects(manifest.projects, { action: action as 'plan' | 'apply' | 'restore', assertOffline: () => {} })
    console.log(JSON.stringify({ reports }))
  } catch (error) {
    // Zod issues may contain candidate values; never emit them or a stack with
    // private file data. Domain error strings are fixed and credential-free.
    const message = error instanceof Error && /^(Migration |BOT already|BOT references|Personal Connection|Legacy thread assignment|Discord target kind|Active BOT |File changed|No migration backup|Explicit unique|Stop all owning)/.test(error.message) ? error.message : 'Invalid offline state, manifest, source or connection format; inspect the private recovery journal if one exists'
    console.error(`Migration stopped: ${message}`)
    process.exitCode = 1
  }
}
