import type { BrowserLaunchOptions } from './chrome-manager.ts'
import type { SessionTools } from '../tools/registry.ts'

export type BrowserTarget =
  | { mode: 'launch'; options: BrowserLaunchOptions }
  | { mode: 'attach'; endpoint: string; argument: string }

export interface BrowserInstance {
  id: string
  target: BrowserTarget
  tools: SessionTools
  owner: SessionTools
  active: boolean
  ready: boolean
  importArgs?: string[]
  fileRoot?: string
}

export function attachmentTarget(endpoint: string): BrowserTarget {
  const url = new URL(endpoint)
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username || url.password || url.hash) {
    throw new Error('CDP attachment requires an explicit loopback HTTP(S) or WebSocket URL without credentials or fragments')
  }
  const websocket = url.protocol === 'ws:' || url.protocol === 'wss:'
  if (!websocket && (url.pathname !== '/' || url.search)) {
    throw new Error('An HTTP CDP endpoint must be an origin, without a path or query')
  }
  return { mode: 'attach', endpoint: url.href, argument: `--${websocket ? 'wsEndpoint' : 'browserUrl'}=${url.href}` }
}

/** Each instance owns a separate adapter registry, preserving canonical MCP names and schemas. */
export class SessionBrowsers {
  private readonly owners = new WeakMap<SessionTools, Map<string, BrowserInstance>>()
  private readonly instances = new WeakMap<SessionTools, BrowserInstance>()

  private state(tools: SessionTools): Map<string, BrowserInstance> {
    const owner = tools.dynamicOwner
    let state = this.owners.get(owner)
    if (!state) {
      state = new Map()
      this.owners.set(owner, state)
      const owned = state
      owner.onReset(async () => {
        this.owners.delete(owner)
        const results = await Promise.allSettled([...owned.values()].map(instance => this.dispose(instance)))
        owned.clear()
        const failures = results.filter(result => result.status === 'rejected')
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Browser instance cleanup failed')
      })
    }
    return state
  }

  list(tools: SessionTools): BrowserInstance[] {
    return [...(this.owners.get(tools.dynamicOwner)?.values() ?? [])]
  }

  create(tools: SessionTools, target: BrowserTarget): BrowserInstance {
    const instance: BrowserInstance = {
      id: crypto.randomUUID(), target, tools: tools.dynamicOwner.createIsolated(),
      owner: tools.dynamicOwner, active: true, ready: false,
    }
    this.state(tools).set(instance.id, instance)
    this.instances.set(instance.tools, instance)
    return instance
  }

  forTools(tools: SessionTools): BrowserInstance | undefined { return this.instances.get(tools) }

  resolve(tools: SessionTools, id?: string): BrowserInstance | string {
    if (tools.ownerSignal.aborted) return 'Error: borrowed browser resources have expired; return to the owning session.'
    const current = this.forTools(tools)
    if (current) return current.active && (id === undefined || id === current.id)
      ? current : 'Error: browser instance is closed or does not match the requested ID.'
    const instances = this.list(tools)
    if (id !== undefined) {
      return instances.find(instance => instance.id === id) ?? 'Error: unknown browser instance for this session. Use browser_setup with action "list".'
    }
    if (instances.length > 1) return 'Error: multiple browser instances are open; supply instance explicitly. Use browser_setup with action "list".'
    if (!instances.length && tools.dynamicOwner !== tools) {
      return 'Error: no browser instance is available to borrow. Ask the owning session to initialize its browser first.'
    }
    return instances[0] ?? this.create(tools, { mode: 'launch', options: {} })
  }

  async close(tools: SessionTools, instance: BrowserInstance): Promise<void> {
    this.owners.get(tools.dynamicOwner)?.delete(instance.id)
    await this.dispose(instance)
  }

  private async dispose(instance: BrowserInstance): Promise<void> {
    instance.active = false
    await instance.tools.resetDynamicAndWait()
  }
}
