import { shallowRef, shallowReadonly } from 'vue'
import { createResource, ResourceRegistry, type ResourceOptions } from './engine.ts'

/** Reactive selectors subscribe to the engine; they never own a mutable server copy. */
export function resourceViews(maxInactive = 0) {
  const registry = new ResourceRegistry({ maxInactive })
  const views = new Map<string, { users: number; view: ReturnType<typeof viewOf<unknown>>; stop: () => void }>()
  function viewOf<T>(resource: ReturnType<typeof createResource<T>>) {
    const state = shallowRef(resource.state)
    const stop = resource.subscribe(next => { state.value = next })
    return { state: shallowReadonly(state), resource, stop }
  }
  return {
    acquire<T>(key: string, load: (signal: AbortSignal) => Promise<T>, options: ResourceOptions<T> = {}, activate?: (invalidate: () => void) => () => void) {
      const lease = registry.acquire(key, () => createResource(load, 0, options))
      let entry = views.get(key)
      if (!entry) {
        const view = viewOf(lease.resource)
        entry = { users: 0, view: view as ReturnType<typeof viewOf<unknown>>, stop: () => {} }
        views.set(key, entry)
        entry.stop = activate?.(() => lease.resource.invalidate()) ?? (() => {})
      }
      entry.users++
      const view = entry.view as ReturnType<typeof viewOf<T>>
      let released = false
      return { state: view.state,
        read: () => released ? Promise.resolve() : lease.resource.read(),
        refresh: () => released ? Promise.resolve() : lease.resource.refresh(),
        invalidate: (reason?: string) => { if (!released) lease.resource.invalidate(reason) },
        release() {
          if (released) return
          released = true
          const last = --entry!.users === 0
          if (last) entry!.stop()
          lease.release()
          if (last) { view.stop(); views.delete(key) }
        },
      }
    },
    dispose() {
      for (const entry of views.values()) entry.stop()
      registry.dispose()
      for (const entry of views.values()) entry.view.stop()
      views.clear()
    },
  }
}
