import { context, propagation, trace, type Attributes } from '@opentelemetry/api'
import {
  NodeTracerProvider,
  type ReadableSpan,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node'
import { format } from 'node:util'
import type { OtelStore, OtlpSpan } from './store.ts'
import { createOrganizationScope, getOrganizationScope, type OrganizationScope } from '../organizations/scope.ts'

export interface NodeTelemetryHandle {
  readonly scope?: OrganizationScope
  shutdown(): Promise<void>
}

export interface NodeTelemetryOptions {
  serviceName?: string
  organizationId?: string
  scope?: OrganizationScope
}

type OtlpValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: OtlpValue[] } }

function attributeValue(value: unknown): OtlpValue {
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(attributeValue) } }
  }
  if (typeof value === 'boolean') return { boolValue: value }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value }
  }
  return { stringValue: String(value) }
}

function attributes(values: Attributes) {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ key, value: attributeValue(value) }))
}

function nanoseconds(time: [number, number]): string {
  return String(BigInt(time[0]) * 1_000_000_000n + BigInt(time[1]))
}

function spanSnapshot(span: ReadableSpan, ended: boolean): OtlpSpan {
  const spanContext = span.spanContext()
  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    name: span.name,
    // The SDK SpanKind enum starts at zero; OTLP reserves zero.
    kind: span.kind + 1,
    startTimeUnixNano: nanoseconds(span.startTime),
    ...(ended ? { endTimeUnixNano: nanoseconds(span.endTime) } : {}),
    status: span.status,
    attributes: attributes(span.attributes),
    events: span.events.map((event) => ({
      name: event.name,
      timeUnixNano: nanoseconds(event.time),
      attributes: attributes(event.attributes ?? {}),
    })),
  }
}

interface TelemetryState {
  provider: NodeTracerProvider
  targets: Map<OrganizationScope | undefined, TelemetryTarget>
  restoreConsole(): void
}

interface TelemetryTarget {
  store: OtelStore
  serviceName: string
  references: number
  active: boolean
  scope?: OrganizationScope
}

let current: TelemetryState | undefined

/**
 * Connect existing application spans and console output to the local OTLP store.
 * A shared provider avoids duplicate global registration for in-process runtimes.
 */
export function initializeNodeTelemetry(
  store: OtelStore,
  options: NodeTelemetryOptions = {},
): NodeTelemetryHandle {
  const orgScope = options.scope ?? (options.organizationId === undefined
    ? undefined : createOrganizationScope(options.organizationId))
  if (!orgScope && getOrganizationScope()) {
    throw new Error('Organization telemetry requires explicit scope binding')
  }
  if (orgScope?.closed || (options.organizationId !== undefined && orgScope?.organizationId !== options.organizationId)) {
    throw new Error('Telemetry scope does not match the organization runtime')
  }
  const serviceName = options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'shadow'
  if (!current) {
    const targets = new Map<OrganizationScope | undefined, TelemetryTarget>()
    const owners = new WeakMap<object, TelemetryTarget>()
    const unbound = new WeakSet<OrganizationScope>()
    const findTarget = (scope = getOrganizationScope()) => {
      if (scope?.closed) return undefined
      const target = targets.get(scope)
      if (scope && !target && !unbound.has(scope)) {
        unbound.add(scope)
        process.stderr.write(`[otel] Organization runtime has no bound telemetry store: ${JSON.stringify(scope.organizationId)}\n`)
      }
      return target
    }
    const scope = { name: 'shadow-console', version: '0.1.0' }
    const processor: SpanProcessor = {
      onStart(span, parentContext) {
        const target = findTarget(getOrganizationScope(parentContext))
        if (!target) return
        owners.set(span, target)
        const { traceId, spanId } = span.spanContext()
        target.store.registerLiveSpan(traceId, spanId, () => spanSnapshot(span, false))
      },
      onEnd(span: ReadableSpan) {
        const target = owners.get(span)
        owners.delete(span)
        if (!target?.active || target.scope?.closed) return
        const spanContext = span.spanContext()
        try {
          target.store.ingestTraces({
            resourceSpans: [{
              resource: {
                attributes: attributes({
                  ...span.resource.attributes,
                  'service.name': target.serviceName,
                  ...(target.scope ? { 'organization.id': target.scope.organizationId } : {}),
                }),
              },
              scopeSpans: [{
                scope: {
                  name: span.instrumentationScope.name,
                  version: span.instrumentationScope.version,
                },
                spans: [spanSnapshot(span, true)],
              }],
            }],
          })
        } catch (error) {
          process.stderr.write(`[otel] Failed to persist span: ${String(error)}\n`)
        } finally {
          target.store.endLiveSpan(spanContext.traceId, spanContext.spanId)
        }
      },
      forceFlush: () => Promise.resolve(),
      shutdown: () => {
        for (const target of targets.values()) target.store.clearLiveSpans()
        return Promise.resolve()
      },
    }
    const provider = new NodeTracerProvider({ spanProcessors: [processor] })
    provider.register()

    const levels = {
      debug: 5,
      log: 9,
      info: 9,
      warn: 13,
      error: 17,
    } as const
    const restorers: Array<() => void> = []
    for (const level of Object.keys(levels) as Array<keyof typeof levels>) {
      const original = console[level]
      const wrapped = (...values: unknown[]) => {
        original.apply(console, values)
        const target = findTarget()
        if (!target) return
        const spanContext = trace.getActiveSpan()?.spanContext()
        try {
          const timestamp = String(BigInt(Date.now()) * 1_000_000n)
          target.store.ingestLogs({
            resourceLogs: [{
              resource: { attributes: attributes({
                'service.name': target.serviceName,
                ...(target.scope ? { 'organization.id': target.scope.organizationId } : {}),
              }) },
              scopeLogs: [{
                scope,
                logRecords: [{
                  timeUnixNano: timestamp,
                  observedTimeUnixNano: timestamp,
                  severityNumber: levels[level],
                  severityText: level.toUpperCase(),
                  body: { stringValue: format(...values) },
                  traceId: spanContext?.traceId,
                  spanId: spanContext?.spanId,
                  attributes: spanContext
                    ? attributes({ 'span.id': spanContext.spanId })
                    : [],
                }],
              }],
            }],
          })
        } catch (error) {
          process.stderr.write(`[otel] Failed to persist log: ${String(error)}\n`)
        }
      }
      console[level] = wrapped
      restorers.push(() => {
        if (console[level] === wrapped) console[level] = original
      })
    }
    current = {
      provider,
      targets,
      restoreConsole: () => { for (const restore of restorers) restore() },
    }
  }

  const state = current
  const existing = state.targets.get(orgScope)
  if (existing && existing.store !== store) {
    throw new Error('A telemetry scope may have only one store; bind each organization explicitly')
  }
  for (const target of state.targets.values()) {
    if (target.store === store && target.scope !== orgScope) {
      throw new Error('A telemetry store cannot be shared between scopes')
    }
    if (orgScope && target.scope?.organizationId === orgScope.organizationId && target.scope !== orgScope) {
      throw new Error('Organization telemetry is already registered with another runtime scope')
    }
  }
  const target = existing ?? { store, serviceName, references: 0, active: true, scope: orgScope }
  target.references++
  state.targets.set(orgScope, target)
  let shutdownPromise: Promise<void> | undefined
  return {
    scope: orgScope,
    shutdown() {
      shutdownPromise ??= (async () => {
        if (--target.references === 0) {
          target.active = false
          state.targets.delete(orgScope)
          store.clearLiveSpans()
        }
        if (state.targets.size > 0) return
        state.restoreConsole()
        if (current === state) {
          current = undefined
          trace.disable()
          context.disable()
          propagation.disable()
        }
        await state.provider.shutdown()
      })()
      return shutdownPromise
    },
  }
}
