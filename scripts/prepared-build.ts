import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { directoryFingerprint, sourceFingerprint } from './release-manifest.ts'
import { runPnpm } from './processes.ts'

export type BuildSelection = 'desktop' | 'mobile' | 'all'
const receiptName = 'release-prepared.json'
const outputPaths = {
  desktop: ['dist', 'desktop/dist', 'app/dist'],
  mobile: ['app/dist-mobile'],
} as const

export function parseBuildSelection(value: string | undefined): BuildSelection {
  if (value !== 'desktop' && value !== 'mobile' && value !== 'all') {
    throw new Error('Select desktop, mobile or all.')
  }
  return value
}

function outputs(selection: BuildSelection): readonly string[] {
  return selection === 'all' ? [...outputPaths.desktop, ...outputPaths.mobile] : outputPaths[selection]
}

export async function recordPreparedBuild(root: string, selection: BuildSelection, expectedSource: string): Promise<void> {
  if (await sourceFingerprint(root) !== expectedSource) throw new Error('Source changed during shared build; rebuild.')
  const files = Object.fromEntries(await Promise.all(outputs(selection).map(async path =>
    [path, await directoryFingerprint(join(root, path))])))
  await writeFile(join(root, receiptName), JSON.stringify({ version: 1, selection, sourceHash: expectedSource, files }) + '\n')
}

export async function verifyPreparedBuild(root: string, target: 'desktop' | 'mobile'): Promise<string> {
  const value: unknown = JSON.parse(await readFile(join(root, receiptName), 'utf8'))
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
    || !('selection' in value) || (value.selection !== target && value.selection !== 'all')
    || !('sourceHash' in value) || typeof value.sourceHash !== 'string'
    || !('files' in value) || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) {
    throw new Error('Invalid or incompatible prepared build receipt. Run release:prepare for this target.')
  }
  if (await sourceFingerprint(root) !== value.sourceHash) throw new Error('Prepared build does not match current source; rebuild.')
  for (const path of outputPaths[target]) {
    if (!Object.hasOwn(value.files, path)
      || Reflect.get(value.files, path) !== await directoryFingerprint(join(root, path))) {
      throw new Error(`Prepared output changed or missing: ${path}; rebuild.`)
    }
  }
  return value.sourceHash
}

async function prepare(selection: BuildSelection): Promise<void> {
  const root = process.cwd()
  const source = await sourceFingerprint(root)
  // Both native families consume the same typechecked source revision.
  await runPnpm(['typecheck'])
  const builds: string[][] = []
  if (selection !== 'mobile') builds.push(['build'], ['--filter', '@shadow/desktop', 'build'], ['build:app'])
  if (selection !== 'desktop') builds.push(['--filter', '@shadow/mobile', 'build:web'])
  // Let every compiler settle before reporting failure or issuing a receipt.
  const results = await Promise.allSettled(builds.map(args => runPnpm(args)))
  const failures = results.filter(result => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Shared application build failed.')
  await recordPreparedBuild(root, selection, source)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const selection = parseBuildSelection(process.argv[3])
  if (process.argv[2] === 'prepare') await prepare(selection)
  else if (process.argv[2] === 'verify' && selection !== 'all') await verifyPreparedBuild(process.cwd(), selection)
  else throw new Error('Usage: prepared-build.ts prepare desktop|mobile|all OR verify desktop|mobile')
}
