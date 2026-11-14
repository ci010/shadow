import { defineStore } from 'pinia'
import { hasInjectionContext, inject, markRaw, onScopeDispose, type InjectionKey } from 'vue'
import { hostBase } from '../api-url.ts'
import { createLiveClient, type LiveClient, type LiveStatus } from '../live-client.ts'

export function createLiveClientPool() {
  const clients = new Map<string, LiveClient>()
  const statuses = new Map<string, LiveStatus>()
  const observers = new Set<(statuses: readonly LiveStatus[]) => void>()
  const hostObservers = new Map<string, Set<(status: LiveStatus) => void>>()
  const disposers = new Set<() => void>()
  let disposed = false
  const notify = () => {
    const current = [...statuses.values()].filter(status => status.phase !== 'idle')
    for (const observer of observers) observer(current)
  }
  return {
    client(base: string) {
      if (disposed) throw new Error('Live client pool is disposed')
      const host = hostBase(base)
      let client = clients.get(host)
      if (!client) {
        client = createLiveClient(host, { status: status => {
          statuses.set(host, status)
          for (const observer of hostObservers.get(host) ?? []) observer(status)
          notify()
        } })
        clients.set(host, client)
      }
      return client
    },
    observeHost(base: string, observer: (status: LiveStatus) => void) {
      if (disposed) throw new Error('Live client pool is disposed')
      const host = hostBase(base)
      let listeners = hostObservers.get(host)
      if (!listeners) { listeners = new Set(); hostObservers.set(host, listeners) }
      listeners.add(observer)
      observer(statuses.get(host) ?? { phase: 'idle' })
      return () => {
        listeners.delete(observer)
        if (!listeners.size) hostObservers.delete(host)
      }
    },
    observe(observer: (statuses: readonly LiveStatus[]) => void) {
      if (disposed) throw new Error('Live client pool is disposed')
      observers.add(observer)
      notify()
      return () => observers.delete(observer)
    },
    onDispose(callback: () => void) {
      if (disposed) { callback(); return () => {} }
      disposers.add(callback)
      return () => { disposers.delete(callback) }
    },
    retry() { for (const client of clients.values()) client.retry() },
    dispose() {
      if (disposed) return
      disposed = true
      const failures: unknown[] = []
      observers.clear()
      hostObservers.clear()
      for (const callback of disposers) {
        try { callback() } catch (error) { failures.push(error) }
      }
      disposers.clear()
      for (const client of clients.values()) {
        try { client.dispose() } catch (error) { failures.push(error) }
      }
      clients.clear()
      statuses.clear()
      if (failures.length) throw new AggregateError(failures, 'Live resource cleanup failed')
    },
  }
}


/** Explicit transport substitution for embedded roots and deterministic fixtures.
 * This is a dependency, not an alternative resource-state owner. Its provider owns disposal. */
export const liveTransportKey: InjectionKey<ReturnType<typeof createLiveClientPool>> = Symbol.for('shadow.live-client-pool')

/** One transport pool per Pinia/Vue application, never a module-global connection. */
export const useLiveTransportStore = defineStore('resource-live', () => {
  const supplied = hasInjectionContext() ? inject(liveTransportKey, undefined) : undefined
  const pool = markRaw(supplied ?? createLiveClientPool())
  if (!supplied) onScopeDispose(() => pool.dispose())
  return { pool }
})
