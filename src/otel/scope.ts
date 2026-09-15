import { AsyncLocalStorage } from 'node:async_hooks'
import { context, createContextKey, trace, type Context } from '@opentelemetry/api'

const organizationContextKey = createContextKey('shadow.organization-runtime')
const storage = new AsyncLocalStorage<OrganizationScope>()

/** A runtime generation, not a mutable "active organization" selector. */
export interface OrganizationScope {
  readonly organizationId: string
  readonly closed: boolean
  /** Wrap composition, requests and producers; async work and timers inherit this scope. */
  run<T>(callback: () => T): T
  /** Capture callbacks at registration; EventEmitter invocation alone does not retain context. */
  bind<A extends unknown[], R>(callback: (...args: A) => R): (...args: A) => R
  /** Retire this generation only after its producers and telemetry have drained. */
  close(): void
}

export function getOrganizationScope(parent: Context = context.active()): OrganizationScope | undefined {
  return parent.getValue(organizationContextKey) as OrganizationScope | undefined ?? storage.getStore()
}

export function createOrganizationScope(organizationId: string): OrganizationScope {
  if (typeof organizationId !== 'string' || !organizationId.trim() || organizationId !== organizationId.trim()) {
    throw new TypeError('A nonempty organizationId is required')
  }
  let closed = false
  const scope: OrganizationScope = Object.freeze({
    organizationId,
    get closed() { return closed },
    run<T>(callback: () => T): T {
      if (closed) throw new Error(`Organization runtime is closed: ${organizationId}`)
      const previous = getOrganizationScope()
      const parent = previous === scope ? context.active() : trace.deleteSpan(context.active())
      return storage.run(scope, () => context.with(parent.setValue(organizationContextKey, scope), callback))
    },
    bind<A extends unknown[], R>(callback: (...args: A) => R): (...args: A) => R {
      const captured = getOrganizationScope() === scope ? context.active() : undefined
      return function (this: unknown, ...args: A): R {
        return scope.run(() => captured
          ? context.with(captured, () => callback.apply(this, args))
          : callback.apply(this, args))
      }
    },
    close() { closed = true },
  })
  return scope
}
