/** Fixed source vocabulary, exact dist/src/index.js entry, or bounded Vite chunk basename only. Never return exception text, function names or private paths.
 * Keep the desktop receiver's independent allowlist in sync (covered end-to-end).
 */
const SOURCES = [
  'sessions/session-store-jsonl', 'sessions/fresh-automation-state',
  'sessions/session-metadata', 'sessions/session-name', 'sessions/task-record',
  'sessions/initiative-metadata', 'sessions/topic-contract', 'sessions/session-identity',
  'sessions/session-store', 'sessions/work-policy', 'sessions/locality',
  'sessions/retirement-contract', 'projects/ownership', 'cron/contracts',
  'channels/integration-contract',
] as const

export function storageValidationFrames(error: unknown): string[] {
  try {
    const stack = (error as { stack?: unknown })?.stack
    if (typeof stack !== 'string') return []
    const frames: string[] = []
    // Bound inspection as well as output. The first line is an error message, not a frame.
    for (const line of stack.slice(0, 16_384).split('\n').slice(1, 33)) {
      if (!/^\s+at /.test(line)) continue
      const normalized = line.replaceAll('\\', '/')
      const match = /(?:^|\/)src\/([a-z/-]+)\.(ts|js):([1-9]\d{0,5}):([1-9]\d{0,5})\)?$/.exec(normalized)
      // Production uses sourcemap:false and _chunks/[name]-[hash].js.
      // Strip the entire installation prefix; never preserve arbitrary directories.
      const bundle = /(?:^|\/)dist\/_chunks\/([A-Za-z0-9_][A-Za-z0-9_-]{0,79}-[A-Za-z0-9_-]{8}\.js):([1-9]\d{0,5}):([1-9]\d{0,5})\)?$/.exec(normalized)
      // The default multi-entry build also inlines validators into this exact entry.
      const entry = /(?:^|\/)dist\/src\/index\.js:([1-9]\d{0,5}):([1-9]\d{0,5})\)?$/.exec(normalized)
      const frame = entry ? `dist/src/index.js:${entry[1]}:${entry[2]}`
        : match && SOURCES.some(source => source === match[1])
        ? `src/${match[1]}.${match[2]}:${match[3]}:${match[4]}`
        : bundle ? `dist/_chunks/${bundle[1]}:${bundle[2]}:${bundle[3]}` : undefined
      if (!frame) continue
      if (!frames.includes(frame)) frames.push(frame)
      if (frames.length === 4) break
    }
    return frames
  } catch { return [] }
}
