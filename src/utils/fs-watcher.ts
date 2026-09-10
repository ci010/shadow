/**
 * Recursive directory watcher for Node.js.
 *
 * - Accepts one or many paths.
 * - Yields `{ paths: string[] }` events whose paths are resolved against the
 *   watched root, matching what existing callers expect.
 * - Backed by `node:fs.watch`.
 *
 * Notes / caveats:
 * - `recursive: true` is supported natively on Windows/macOS and on Linux
 *   from Node 20+. Older Linux Node versions only watch the top level.
 * - The OS may emit duplicate events for a single change. Callers should
 *   debounce (the existing watchers already do via a 300–500 ms timer).
 */

import { type FSWatcher, watch as nodeWatch } from 'node:fs'
import { resolve } from 'node:path'

export interface FsEvent {
  paths: string[]
}

export class FsWatcher implements AsyncIterable<FsEvent> {
  private watchers: FSWatcher[] = []
  private closed = false
  private pending: Array<(event: FsEvent | null) => void> = []
  private queue: FsEvent[] = []

  constructor(paths: string[], opts?: { recursive?: boolean }) {
    const recursive = opts?.recursive ?? true
    for (const p of paths) {
      const root = resolve(p)
      try {
        const w = nodeWatch(
          root,
          { recursive, persistent: false },
          (_event, filename) => {
            const name = filename == null
              ? null
              : (typeof filename === 'string' ? filename : String(filename))
            const fullPath = name ? resolve(root, name) : root
            this.dispatch({ paths: [fullPath] })
          },
        )
        // Swallow watcher errors — the source path may disappear briefly
        // (e.g. atomic save). Consumers re-scan on each event anyway.
        w.on('error', () => {})
        this.watchers.push(w)
      } catch {
        // A missing source path is tolerated by the watcher loop.
      }
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const w of this.watchers) {
      try {
        w.close()
      } catch { /* already closed */ }
    }
    // Wake any pending consumers so their `for await` loop terminates.
    for (const resolveFn of this.pending) resolveFn(null)
    this.pending = []
  }

  private dispatch(event: FsEvent): void {
    if (this.closed) return
    const next = this.pending.shift()
    if (next) {
      next(event)
    } else {
      this.queue.push(event)
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<FsEvent> {
    return {
      next: (): Promise<IteratorResult<FsEvent>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false })
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise<FsEvent | null>((res) => {
          this.pending.push(res)
        }).then((event) => {
          if (!event) return { value: undefined, done: true }
          return { value: event, done: false }
        })
      },
      return: (): Promise<IteratorResult<FsEvent>> => {
        this.close()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}

/** Watch one or more paths using an asynchronous event iterator. */
export function watchFs(
  paths: string | string[],
  opts?: { recursive?: boolean },
): FsWatcher {
  return new FsWatcher(Array.isArray(paths) ? paths : [paths], opts)
}
