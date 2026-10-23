import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@opentelemetry/api'
import {
  captureProjectTelemetry,
  getProjectTelemetryScope,
  runWithProjectTelemetry,
} from '../otel/project-context.ts'

const storage = new AsyncLocalStorage<ProjectScope>()

/** A runtime generation, not a mutable "active project" selector. */
export interface ProjectScope {
  readonly projectId: string
  readonly closed: boolean
  /** Wrap composition, requests and producers; async work and timers inherit this scope. */
  run<T>(callback: () => T): T
  /** Capture callbacks at registration; EventEmitter invocation alone does not retain context. */
  bind<A extends unknown[], R>(callback: (...args: A) => R): (...args: A) => R
  /** Retire this generation only after its producers and telemetry have drained. */
  close(): void
}

export function getProjectScope(parent?: Context): ProjectScope | undefined {
  return getProjectTelemetryScope(parent) ?? storage.getStore()
}

export function createProjectScope(projectId: string): ProjectScope {
  if (typeof projectId !== 'string' || !projectId.trim() || projectId !== projectId.trim()) {
    throw new TypeError('A nonempty projectId is required')
  }
  let closed = false
  const scope: ProjectScope = Object.freeze({
    projectId,
    get closed() { return closed },
    run<T>(callback: () => T): T {
      if (closed) throw new Error(`Project runtime is closed: ${projectId}`)
      const previous = getProjectScope()
      return storage.run(scope, () => runWithProjectTelemetry(scope, previous === scope, callback))
    },
    bind<A extends unknown[], R>(callback: (...args: A) => R): (...args: A) => R {
      const captured = getProjectScope() === scope ? captureProjectTelemetry() : undefined
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
