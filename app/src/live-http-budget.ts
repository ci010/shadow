import { sharedTransport } from './shared-read.ts'
import { hostBase } from './api-url.ts'

// One FIFO per Main (not per Project). Pace starts even when responses are fast;
// cancellation removes undispatched reads, and empty lanes retain no owners.
const lanes = new Map<string, { active: number; jobs: Set<{ start(): void; stagger: boolean }>; timer?: ReturnType<typeof setTimeout> }>()
const concurrency = 4
const spacingMs = 40

export function budgetLiveHttp<T>(base: string, signal: AbortSignal, load: (signal: AbortSignal) => Promise<T>, stagger = true): Promise<T> {
  signal.throwIfAborted()
  const key = base ? hostBase(base) : ''
  let lane = lanes.get(key)
  if (!lane) { lane = { active: 0, jobs: new Set() }; lanes.set(key, lane) }
  const current = lane
  function pump() {
    if (current.timer !== undefined) return
    const job = current.jobs.values().next().value
    if (!job) {
      if (!current.active && lanes.get(key) === current) lanes.delete(key)
      return
    }
    if (current.active >= concurrency) return
    current.jobs.delete(job)
    current.active++
    if (job.stagger) current.timer = setTimeout(() => { current.timer = undefined; pump() }, spacingMs)
    job.start()
    if (!job.stagger) pump()
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      current.jobs.delete(job)
      reject(signal.reason)
      pump()
    }
    function start() {
      signal.removeEventListener('abort', abort)
      void sharedTransport(load, signal).then(resolve, reject).finally(() => {
        current.active--; pump()
      })
    }
    const job = { start, stagger }
    current.jobs.add(job)
    signal.addEventListener('abort', abort, { once: true })
    pump()
  })
}
