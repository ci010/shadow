import { pathToFileURL } from 'node:url'

// UtilityProcess does not run Node's --import preloads. This isolated entry is
// used only for armed development captures, before the backend module graph.
try {
  const [, , encodedPreloads, entry, ...argv] = process.argv
  if (!encodedPreloads || !entry) throw new Error('Missing profiling bootstrap arguments')
  const preloads: unknown = JSON.parse(encodedPreloads)
  if (!Array.isArray(preloads) || !preloads.every(value => typeof value === 'string')) {
    throw new Error('Invalid profiling bootstrap preloads')
  }
  process.argv = [process.execPath, entry, ...argv]
  for (const preload of preloads) await import(preload)
  const backend = await import(pathToFileURL(entry).href)
  // The imported index's import.meta.main is false: dispatch explicitly once.
  await backend.runRootProcessEntry()
} catch (error) {
  console.error('[main] Fatal error', error)
  process.exit(1)
}
