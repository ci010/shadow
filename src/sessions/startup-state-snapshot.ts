import type { SessionState, SessionStore } from './session-store.ts'

/** Explicit startup-only snapshot. Never a process-global or steady-state cache. */
export function startupStateSnapshot(store: SessionStore, initial?: Record<string, SessionState>) {
  let enabled = true
  let generation = 0
  let snapshot = initial === undefined ? undefined : structuredClone(initial)
  let loading: Promise<Record<string, SessionState>> | undefined
  const clear = () => { generation++; snapshot = undefined; loading = undefined }
  const close = () => { enabled = false; clear() }
  const wrapped = new Proxy(store, {
    get(target, property) {
      if (property === 'listAllStates') return async () => {
        if (!enabled) return target.listAllStates()
        if (snapshot) return structuredClone(snapshot)
        const version = generation
        const pending = loading ??= target.listAllStates()
        try {
          const states = await pending
          if (enabled && version === generation) snapshot = structuredClone(states)
          return structuredClone(states)
        } finally { if (loading === pending) loading = undefined }
      }
      const value = Reflect.get(target, property, target)
      if (typeof value === 'function' && (property === 'saveState' || property === 'deleteState' || property === 'archiveState' || property === 'init' || property === 'close')) {
        return (...args: unknown[]) => {
          // Even failed mutations end reuse; an older read cannot refill it.
          close()
          return value.apply(target, args)
        }
      }
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { store: wrapped, close }
}
