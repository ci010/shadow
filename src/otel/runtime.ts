import { context, propagation, trace, type Attributes } from '@opentelemetry/api'
import {
  NodeTracerProvider,
  type ReadableSpan,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node'
import { format } from 'node:util'
import type { OtelStore, OtlpSpan } from './store.ts'

export interface NodeTelemetryHandle {
  shutdown(): Promise<void>
}

export interface NodeTelemetryOptions {
  serviceName?: string
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
  stores: Map<OtelStore, number>
  restoreConsole(): void
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
  if (!current) {
    const stores = new Map<OtelStore, number>()
    const serviceName = options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'shadow'
    const resource = { attributes: attributes({ 'service.name': serviceName }) }
    const scope = { name: 'shadow-console', version: '0.1.0' }
    const processor: SpanProcessor = {
      onStart(span) {
        const { traceId, spanId } = span.spanContext()
        for (const target of stores.keys()) {
          target.registerLiveSpan(traceId, spanId, () => spanSnapshot(span, false))
        }
      },
      onEnd(span: ReadableSpan) {
        const spanContext = span.spanContext()
        for (const target of stores.keys()) {
          try {
            target.ingestTraces({
              resourceSpans: [{
                resource: {
                  attributes: attributes({
                    ...span.resource.attributes,
                    'service.name': serviceName,
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
            target.endLiveSpan(spanContext.traceId, spanContext.spanId)
          }
        }
      },
      forceFlush: () => Promise.resolve(),
      shutdown: () => {
        for (const target of stores.keys()) target.clearLiveSpans()
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
        const spanContext = trace.getActiveSpan()?.spanContext()
        for (const target of stores.keys()) {
          try {
            const timestamp = String(BigInt(Date.now()) * 1_000_000n)
            target.ingestLogs({
              resourceLogs: [{
                resource,
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
      }
      console[level] = wrapped
      restorers.push(() => {
        if (console[level] === wrapped) console[level] = original
      })
    }
    current = {
      provider,
      stores,
      restoreConsole: () => { for (const restore of restorers) restore() },
    }
  }

  const state = current
  state.stores.set(store, (state.stores.get(store) ?? 0) + 1)
  let shutdownPromise: Promise<void> | undefined
  return {
    shutdown() {
      shutdownPromise ??= (async () => {
        const remaining = (state.stores.get(store) ?? 1) - 1
        if (remaining > 0) state.stores.set(store, remaining)
        else {
          state.stores.delete(store)
          store.clearLiveSpans()
        }
        if (state.stores.size > 0) return
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
