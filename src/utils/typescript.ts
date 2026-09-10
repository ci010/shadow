import { readFileSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

let registered = false

/**
 * Load user-authored TypeScript using the bundled Node runtime, not an external
 * compiler. Relative imports must include their extension; JSX and decorators
 * are not supported by Node's TypeScript transformer.
 */
export function registerTypeScriptLoader(): void {
  if (registered) return
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith('file:')) return nextLoad(url, context)
      const file = new URL(url)
      if (!/\.(?:ts|mts|cts)$/i.test(file.pathname)) {
        return nextLoad(url, context)
      }
      return {
        format: file.pathname.endsWith('.cts') ? 'commonjs' : 'module',
        source: stripTypeScriptTypes(readFileSync(file, 'utf8'), {
          mode: 'transform',
          sourceMap: true,
          sourceUrl: url,
        }),
        shortCircuit: true,
      }
    },
  })
  registered = true
}
