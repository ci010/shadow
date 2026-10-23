import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export type RendererTarget =
  | { readonly kind: 'url'; readonly url: string; readonly origin: string }
  | { readonly kind: 'file'; readonly filePath: string; readonly entryUrl: string; readonly origin: 'null' }

export function resolveRendererTarget(options: {
  readonly rendererDistPath: string
  readonly developmentUrl?: string
}): RendererTarget {
  if (options.developmentUrl !== undefined) {
    const url = new URL(options.developmentUrl)
    if (url.protocol !== 'http:' || !isLoopbackHost(url.hostname)) {
      throw new TypeError('Development renderer URL must use HTTP on loopback')
    }
    return { kind: 'url', url: url.toString(), origin: url.origin }
  }

  const filePath = join(options.rendererDistPath, 'index.html')
  return { kind: 'file', filePath, entryUrl: pathToFileURL(filePath).toString(), origin: 'null' }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}
/** Policies retain this stable reference while bootstrap moves between local recovery and Child UI. */
export function rendererTargetController(initial: RendererTarget): {
  readonly target: RendererTarget
  select(target: RendererTarget): void
} {
  let current = initial
  return {
    target: new Proxy(initial, { get: (_object, key) => Reflect.get(current, key) }),
    select(target) { current = target },
  }
}
