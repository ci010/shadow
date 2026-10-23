import {
  type Attributes,
  type Context,
  context,
  type Span,
  type SpanOptions,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api'

export function getTracer() {
  return trace.getTracer('shadow-bot', '0.1.0')
}

function handleSpanResult<T>(span: Span, operation: () => T): T {
  try {
    const result = operation()
    if (result instanceof Promise) {
      return result
        .then((value) => {
          span.end()
          return value
        })
        .catch((err) => {
          if (err instanceof Error) {
            span.recordException(err)
          }
          span.setStatus({ code: SpanStatusCode.ERROR })
          span.end()
          throw err
        }) as T
    }

    span.end()
    return result
  } catch (err) {
    if (err instanceof Error) {
      span.recordException(err)
    }
    span.setStatus({ code: SpanStatusCode.ERROR })
    span.end()
    throw err
  }
}

export function uspan(name: string, options?: SpanOptions) {
  const span = getTracer().startSpan(name, options)
  const ctx = trace.setSpan(context.active(), span)
  return {
    span,
    context: ctx,
    [Symbol.dispose]: () => {
      span.end()
    },
  }
}

export function activeSpan<T>(
  name: string,
  fn: (span: Span) => T,
  options?: SpanOptions,
  ctx?: Context,
): T {
  return getTracer().startActiveSpan(
    name,
    { ...options },
    ctx ?? context.active(),
    (span) => handleSpanResult(span, () => fn(span)),
  )
}

/**
 * Method decorator that wraps the method in an OTEL span.
 * Works with both sync and async methods.
 * Uses Stage 3 decorator syntax.
 *
 * Automatically includes fields marked with @Attr as span attributes.
 *
 * @example
 * class MyClass {
 *   @Attr() channel: string
 *   @Attr('chat.id') chatId: string
 *
 *   @Span('myOperation')
 *   async doWork() { ... }  // span has 'channel' and 'chat.id' attributes
 * }
 */
export function Span<This extends object, Args extends any[], Return>(
  name: string,
  options?: SpanOptions | ((...args: Args) => SpanOptions),
) {
  return function (
    target: (this: This, ...args: Args) => Return,
    _ctx: ClassMethodDecoratorContext<
      This,
      (this: This, ...args: Args) => Return
    >,
  ): (this: This, ...args: Args) => Return {
    return function (this: This, ...args: Args): Return {
      const spanOptions = typeof options === 'function' ? options(...args) : options
      return getTracer().startActiveSpan(
        name,
        { ...spanOptions },
        (span) => handleSpanResult(span, () => target.apply(this, args)),
      )
    }
  }
}

export function spanAttributes(attributes: Attributes) {
  trace.getActiveSpan()?.setAttributes(attributes)
}

export function event(name: string) {
  trace.getActiveSpan()?.addEvent(name)
}
