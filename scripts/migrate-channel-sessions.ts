import { readFile, writeFile } from 'node:fs/promises'
import { migrateChannelSessions, type ChannelMigrationManifest } from '../src/sessions/channel-session-migration.ts'

const args = process.argv.slice(2)
const allowed = new Set(['--sessions', '--manifest', '--output', '--backup', '--runtime-stopped', '--prepare-startup'])
const values = new Map<string, string>()
for (let index = 0; index < args.length; index++) {
  const key = args[index]!
  if (!allowed.has(key) || values.has(key)) throw new Error(`Unknown/duplicate argument ${key}`)
  if (key === '--runtime-stopped' || key === '--prepare-startup') values.set(key, 'true')
  else {
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`)
    values.set(key, value)
  }
}
if (!values.has('--sessions') || !values.has('--manifest')) throw new Error('Usage: pnpm exec tsx scripts/migrate-channel-sessions.ts --sessions ABSOLUTE_DIRECTORY --manifest MANIFEST.json [--output NEW_DIRECTORY --backup NEW_BACKUP_DIRECTORY --runtime-stopped]')
if (values.has('--prepare-startup') && (values.has('--output') || values.has('--backup') || values.has('--runtime-stopped'))) throw new Error('prepare-startup cannot be combined with apply options')
const manifest = JSON.parse(await readFile(values.get('--manifest')!, 'utf8')) as ChannelMigrationManifest
const report = await migrateChannelSessions({ directory: values.get('--sessions')!, manifest,
  output: values.get('--output'), backup: values.get('--backup'), runtimeStopped: values.has('--runtime-stopped') })
console.log(JSON.stringify(report, null, 2))

if (values.has('--prepare-startup')) {
  if (values.has('--output') || values.has('--backup') || values.has('--runtime-stopped')) throw new Error('prepare-startup cannot be combined with apply options')
  const { resolve } = await import('node:path')
  const planPath = `${resolve(values.get('--sessions')!)}.channel-migration-plan.json`
  await writeFile(planPath, JSON.stringify({ version: 1, projectId: manifest.projectId, exclusiveRestart: true, manifest }, null, 2), { flag: 'wx' })
  console.log(`Prepared explicit startup plan: ${planPath}. Stop every other writer before the next host boot.`)
}
