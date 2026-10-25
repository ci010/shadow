import { isAbsolute, join, resolve } from 'node:path'

/** Pure description of the current application data layout. */
export function appDataPaths(dataDir: string) {
  const root = resolve(dataDir)
  return {
    root,
    config: join(root, 'app.json'),
    catalog: join(root, 'projects.json'),
    projects: join(root, 'projects'),
    devices: join(root, 'devices'),
    telemetry: join(root, 'telemetry'),
    hostTelemetry: join(root, 'telemetry', 'host.db'),
  }
}

export function projectDataPaths(home: string) {
  const root = resolve(home)
  return {
    root,
    config: join(root, 'config'),
    memory: join(root, 'memory'),
    state: join(root, 'state'),
    workdirs: join(root, 'workdirs'),
    cache: join(root, 'cache'),
    tmp: join(root, 'tmp'),
  }
}

/**
 * Logical storage names retained by service APIs and historical references.
 * Service readers/writers use this table. Browser profiles,
 * capture artifacts and app bundles are durable state, NOT disposable caches.
 */
export const PROJECT_STORAGE_ENTRIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '.sessions': ['state', 'sessions'],
  '.events': ['state', 'events'],
  '.channel-stream': ['state', 'channel-stream'],
  '.cron': ['state', 'cron'],
  '.learning': ['state', 'learning'],
  '.eval': ['state', 'eval'],
  '.a2a': ['state', 'a2a'],
  '.browser': ['state', 'browser'],
  '.io': ['state', 'io'],
  '.microapps': ['state', 'microapps'],
  '.plans': ['state', 'plans'],
  '.knowledge-maintenance': ['state', 'knowledge-maintenance'],
  '.mcp-tool-index': ['cache', 'mcp-tool-index'],
  '.tmp': ['tmp'],
  '.otel.db': ['state', 'telemetry', 'otel.db'],
  '.otel.db-wal': ['state', 'telemetry', 'otel.db-wal'],
  '.otel.db-shm': ['state', 'telemetry', 'otel.db-shm'],
  '.otel.db-journal': ['state', 'telemetry', 'otel.db-journal'],
  'conventions.sqlite': ['state', 'conventions.sqlite'],
  'conventions.sqlite-wal': ['state', 'conventions.sqlite-wal'],
  'conventions.sqlite-shm': ['state', 'conventions.sqlite-shm'],
  'conventions.sqlite-journal': ['state', 'conventions.sqlite-journal'],
  'initiatives.sqlite': ['state', 'initiatives.sqlite'],
  'initiatives.sqlite-wal': ['state', 'initiatives.sqlite-wal'],
  'initiatives.sqlite-shm': ['state', 'initiatives.sqlite-shm'],
  'initiatives.sqlite-journal': ['state', 'initiatives.sqlite-journal'],
  'folders.v2.json': ['state', 'folders.v2.json'],
  'HEARTBEAT.pulse': ['state', 'HEARTBEAT.pulse'],
  'wechat': ['state', 'wechat'],
  'uploads': ['workdirs', 'legacy-uploads'],
  'github-integration.json': ['config', 'github-integration.json'],
  'user-actions.v1.json': ['config', 'user-actions.v1.json'],
  '.audio-cpp.json': ['config', 'audio-cpp.json'],
  '.diffusion-cpp.json': ['config', 'diffusion-cpp.json'],
  '.chrome-devtools.json': ['config', 'chrome-devtools.json'],
  '.env': ['config', '.env'],
  'SOUL.md': ['config', 'SOUL.md'],
  'AGENTS.md': ['config', 'AGENTS.md'],
  'agents': ['config', 'agents'],
  'skills': ['config', 'skills'],
  'memory': ['memory'],
})

/** Resolve service-owned paths; general user-relative paths still use effective cwd. */
export function projectStoragePath(home: string, ...segments: string[]): string {
  if (!segments.length || segments.some(isAbsolute)) return resolve(home, ...segments)
  const pieces = segments.flatMap(segment => segment.split(/[\\/]/))
  const [entry, ...rest] = pieces
  const location = entry !== undefined && Object.hasOwn(PROJECT_STORAGE_ENTRIES, entry) ? PROJECT_STORAGE_ENTRIES[entry] : undefined
  return location ? resolve(home, ...location, ...rest) : resolve(home, ...segments)
}
