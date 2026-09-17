import { getCurrentInstance, inject, type InjectionKey } from 'vue'
import { hostBase } from '../api-url.ts'
import { createLiveClient, type LiveClient, type LiveStatus } from '../live-client.ts'

export function createLiveClientPool() {
  const clients = new Map<string, LiveClient>()
  const statuses = new Map<string, LiveStatus>()
  const observers = new Set<(statuses: readonly LiveStatus[]) => void>()
  const notify = () => {
    const current = [...statuses.values()].filter(status => status.phase !== 'idle')
    for (const observer of observers) observer(current)
  }
  return {
    client(base: string) {
      const host = hostBase(base)
      let client = clients.get(host)
      if (!client) {
        client = createLiveClient(host, { status: status => { statuses.set(host, status); notify() } })
        clients.set(host, client)
      }
      return client
    },
    observe(observer: (statuses: readonly LiveStatus[]) => void) {
      observers.add(observer)
      notify()
      return () => observers.delete(observer)
    },
    retry() { for (const client of clients.values()) client.retry() },
    dispose() {
      observers.clear()
      for (const client of clients.values()) client.dispose()
      clients.clear()
      statuses.clear()
    },
  }
}

const poolKey: InjectionKey<ReturnType<typeof createLiveClientPool>> = Symbol.for('shadow.live-client-pool')
export function useLiveClientPool() {
  const instance = getCurrentInstance()
  if (!instance) throw new Error('Live updates require a Vue application context.')
  const existing = inject(poolKey, undefined)
  if (existing) return existing
  const pool = createLiveClientPool()
  instance.appContext.provides[poolKey] = pool
  instance.appContext.app.onUnmount(() => pool.dispose())
  return pool
}

export function liveProjectId(base: string): string {
  const match = new URL(base).pathname.match(/\/projects\/([^/]+)\/?$/)
  return match ? decodeURIComponent(match[1]) : 'default'
}
