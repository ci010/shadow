import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Session } from 'node:inspector'

export type ProfilePhase = 'bootstrap' | 'ownership-project' | 'ownership-jsonl' | 'ownership-sqlite' | 'ownership-reserve'
type Status = 'started' | 'completed' | 'failed'
type Detail = { projectOrdinal?: number; count?: number }
type Marker = (phase: string, status: Status, detail?: Detail) => void
let marker: Marker | undefined
let finish: (() => void) | undefined
const projects = new Map<string, number>()

/** IDs are used only in memory, never written to the diagnostic files. */
export function startupProjectOrdinal(id: string): number | undefined {
  if (!marker) return undefined
  let ordinal = projects.get(id)
  if (ordinal === undefined && projects.size < 128) {
    ordinal = projects.size + 1
    projects.set(id, ordinal)
  }
  return ordinal
}

export function profileStartupPhase(phase: string, status: Status, detail?: Detail): void {
  marker?.(phase, status, detail)
}

export async function measureStartupProfile<T>(phase: ProfilePhase, operation: () => T | Promise<T>, detail?: Detail): Promise<T> {
  profileStartupPhase(phase, 'started', detail)
  try {
    const result = await operation()
    profileStartupPhase(phase, 'completed', detail)
    return result
  } catch (error) {
    profileStartupPhase(phase, 'failed', detail)
    throw error
  }
}

export function finishStartupProfile(): void { finish?.() }

/** CPU profiles contain source symbols/locations, not source, arguments, locals or heap data. */
export function sanitizeCpuProfile(profile: import('node:inspector').Profiler.Profile): import('node:inspector').Profiler.Profile {
  return {
    startTime: profile.startTime, endTime: profile.endTime,
    samples: profile.samples, timeDeltas: profile.timeDeltas,
    nodes: profile.nodes.map(node => {
      const url = node.callFrame.url.replaceAll('\\', '/')
      const source = url.match(/\/(dist\/src\/[a-zA-Z0-9_./-]+\.js)$/)?.[1]
      return {
        id: node.id, hitCount: node.hitCount, children: node.children,
        callFrame: {
          functionName: /^[a-zA-Z0-9_$ .<>()[\]-]{0,120}$/.test(node.callFrame.functionName) ? node.callFrame.functionName : '(redacted)',
          scriptId: node.callFrame.scriptId,
          url: source && !source.includes('..') ? source : /^node:[a-zA-Z0-9_./-]+$/.test(url) ? url : '(external)',
          lineNumber: node.callFrame.lineNumber, columnNumber: node.callFrame.columnNumber,
        },
      }
    }),
  }
}

/** Called only by the Node --import preload, before the application module graph. */
export function startStartupProfile(directory: string): void {
  if (marker) return
  let run: string
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    // Only our strictly named generation directories are eligible for retention.
    const generations = readdirSync(directory).filter(name => /^capture-\d{13}-\d+$/.test(name)).sort()
    for (const name of generations.slice(0, Math.max(0, generations.length - 2))) rmSync(join(directory, name), { recursive: true, force: true })
    run = join(directory, `capture-${Date.now()}-${process.pid}`)
    mkdirSync(run, { mode: 0o700 })
  } catch {
    console.warn('[startup-profile] Capture directory could not be prepared; startup will continue without profiling.')
    return
  }
  const started = performance.now()
  const cpu = process.cpuUsage()
  const resources = process.resourceUsage()
  let count = 0
  const emit = (phase: string, status: Status, detail: Detail = {}) => {
    // Fixed labels only; never persist arbitrary caller strings or payloads.
    if (!/^(?:bootstrap|capture|cpu-chunk|ownership-(?:project|jsonl|sqlite|reserve)|(?:host|project)-(?:catalog|ownership|cluster|gateway|projects|config|events|folders|sessions|io|channels|agent|cron|recovery|ready|agent-(?:mcp|skills|types|watchers|sessions)|session-(?:load|migrate|lineage|task-history|reports|recovery)))$/.test(phase) || count++ >= 4096) return
    const usage = process.resourceUsage()
    const usedCpu = process.cpuUsage(cpu)
    const memory = process.memoryUsage()
    const safeNumber = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
    try {
      appendFileSync(join(run, 'phases.jsonl'), JSON.stringify({
        version: 1, timestamp: new Date().toISOString(), phase, status,
        elapsedMs: Math.round(performance.now() - started), processUptimeMs: Math.round(process.uptime() * 1000),
        cpuUserUs: usedCpu.user, cpuSystemUs: usedCpu.system,
        rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, maxRssKiB: usage.maxRSS,
        fsRead: usage.fsRead - resources.fsRead, fsWrite: usage.fsWrite - resources.fsWrite,
        voluntaryContextSwitches: usage.voluntaryContextSwitches - resources.voluntaryContextSwitches,
        involuntaryContextSwitches: usage.involuntaryContextSwitches - resources.involuntaryContextSwitches,
        ...(safeNumber(detail.projectOrdinal) && detail.projectOrdinal! <= 128 ? { projectOrdinal: detail.projectOrdinal } : {}),
        ...(safeNumber(detail.count) ? { count: detail.count } : {}),
      }) + '\n', { mode: 0o600 })
    } catch { /* Diagnostics must never prevent startup. */ }
  }
  marker = emit
  emit('bootstrap', 'started')
  const session = new Session()
  let profiling = false
  let stopped = false
  let chunk = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  const checkpoint = (last: boolean) => {
    if (!profiling) return
    profiling = false
    session.post('Profiler.stop', (error, result) => {
      if (!error && result) {
        try {
          const data = JSON.stringify(sanitizeCpuProfile(result.profile))
          if (Buffer.byteLength(data) <= 8 * 1024 * 1024) {
            writeFileSync(join(run, `cpu-${++chunk}.cpuprofile`), data, { mode: 0o600 })
            emit('cpu-chunk', 'completed', { count: chunk })
          } else emit('cpu-chunk', 'failed')
        } catch { emit('cpu-chunk', 'failed') }
      } else emit('cpu-chunk', 'failed')
      if (last || stopped || chunk >= 10) { session.disconnect(); return }
      session.post('Profiler.start', error => { profiling = !error })
    })
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    clearTimeout(deadline)
    if (profiling) checkpoint(true)
    else { try { session.disconnect() } catch { /* Not connected. */ } }
    emit('capture', 'completed')
    marker = undefined
    finish = undefined
    projects.clear()
    process.off('exit', stop)
  }
  finish = stop
  try {
    session.connect() // In-process only: never opens a listening inspector endpoint.
    session.post('Profiler.enable')
    session.post('Profiler.setSamplingInterval', { interval: 2000 })
    session.post('Profiler.start', error => {
      profiling = !error
      if (error) emit('cpu-chunk', 'failed')
    })
  } catch { emit('cpu-chunk', 'failed') }
  // Bound overhead to startup; persist chunks rather than trusting an exit handler on Windows kill.
  timer = setInterval(() => checkpoint(false), 2000)
  timer.unref()
  deadline = setTimeout(stop, 20_000)
  deadline.unref()
  process.once('exit', stop)
}
