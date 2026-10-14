import { isAbsolute } from 'node:path'
import { copyDataMigration, planDataMigration, rollbackDataMigration } from './data-migration.ts'

/** Reachable from dist/src/index.js with Electron's bundled Node runtime. */
export async function runDataMigrationCli(args: readonly string[]): Promise<void> {
  const pathIndex = args.indexOf('--data-dir')
  const root = pathIndex < 0 ? undefined : args[pathIndex + 1]
  const plan = args.includes('--plan')
  const copy = args.includes('--copy')
  const rollback = args.includes('--rollback')
  const offline = args.includes('--offline')
  const remaining = args.filter((_, i) => i !== pathIndex && i !== pathIndex + 1)
  if (!root || !isAbsolute(root) || pathIndex !== 0 || [plan, copy, rollback].filter(Boolean).length !== 1 ||
      remaining.some(a => !['--plan', '--copy', '--rollback', '--offline', '--progress'].includes(a)) ||
      new Set(remaining).size !== remaining.length || (plan && offline) || ((copy || rollback) && !offline)) {
    throw new Error('Use data-migration --data-dir <absolute-root> --plan OR --copy --offline OR --rollback --offline. Quit ALL writers first; --offline does not detect writers.')
  }
  const result = plan ? await planDataMigration(root) : rollback ? await rollbackDataMigration(root, { offline: true }) : await copyDataMigration(root, { offline: true, onProgress: args.includes('--progress') ? event => console.error(JSON.stringify({ type: 'migration-progress', ...event })) : undefined })
  console.info(JSON.stringify(result))
}
