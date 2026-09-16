import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@opentelemetry/api'
import {
  captureOrganizationTelemetry,
  getOrganizationTelemetryScope,
  runWithOrganizationTelemetry,
} from '../otel/organization-context.ts'

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

export function getOrganizationScope(parent?: Context): OrganizationScope | undefined {
  return getOrganizationTelemetryScope(parent) ?? storage.getStore()
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
      return storage.run(scope, () => runWithOrganizationTelemetry(scope, previous === scope, callback))
    },
    bind<A extends unknown[], R>(callback: (...args: A) => R): (...args: A) => R {
      const captured = getOrganizationScope() === scope ? captureOrganizationTelemetry() : undefined
      return function (this: unknown, ...args: A): R {
        return scope.run(() => captured
          ? captured(() => callback.apply(this, args))
          : callback.apply(this, args))
      }
    },
    close() { closed = true },
  })
  return scope
}
