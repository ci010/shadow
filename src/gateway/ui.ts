import type { Hono } from 'hono'
import { extname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { readFile as nodeReadFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import type { GatewayPlugin } from './types.ts'
import { isBackendPath } from './route-kind.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

async function readFile(path: string): Promise<Uint8Array | null> {
  try {
    // Node's Buffer is a Uint8Array — safe to return as-is for Response bodies.
    return await nodeReadFile(path)
  } catch {
    return null
  }
}

/**
 * Hono plugin that serves the built frontend (`app/dist/`) as static files
 * with SPA history-mode fallback to `index.html`.
 *
 * - In production, register this so a single port serves both API and UI.
 * - In development, the frontend is served by `vite` and proxies API calls
 *   back to the gateway; this plugin will detect the missing `dist/` and
 *   silently no-op.
 *
 * MUST be registered LAST so its catch-all `*` route doesn't shadow API
 * routes. Backend-only path prefixes (`/v1/*`, `/api/*`, `/debug/*`) are
 * explicitly skipped so missing API endpoints still 404 normally.
 */
export function uiPlugin(distDir: string): GatewayPlugin {
  const root = resolve(distDir)
  let exists = false
  try {
    exists = statSync(root).isDirectory()
  } catch {
    exists = false
  }

  return (app: Hono) => {
    if (!exists) {
      console.info(
        `[gateway] UI dist not found at ${root} \u2014 frontend not served (run \`pnpm build:app\` to build, or use the Vite dev server)`,
      )
      return
    }
    console.info(`[gateway] Serving frontend from ${root}`)

    app.get('*', async (c) => {
      const path = new URL(c.req.url).pathname

      // Don't shadow backend routes \u2014 let them 404 normally.
      if (isBackendPath(path)) {
        return c.notFound()
      }

      // Resolve requested file inside dist; reject path traversal.
      const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '')
      const filePath = normalize(join(root, rel))
      const scopedPath = relative(root, filePath)
      if (isAbsolute(scopedPath) || scopedPath === '..' || scopedPath.startsWith('../') || scopedPath.startsWith('..\\')) {
        return c.text('Forbidden', 403)
      }

      let body = await readFile(filePath)
      let ext = extname(filePath).toLowerCase()
      let entryPage = filePath === join(root, 'index.html')

      // SPA fallback: unknown route \u2192 index.html
      if (!body) {
        if (path.startsWith('/assets/') || path.startsWith('/pwa/') || path === '/manifest.webmanifest' || path === '/sw.js') return c.notFound()
        body = await readFile(join(root, 'index.html'))
        ext = '.html'
        entryPage = true
      }
      if (!body) return c.notFound()

      // Keep file:// assets relative on disk, but resolve HTTP history routes
      // from the gateway root rather than e.g. /chat/assets/.
      const responseBody = entryPage
        ? new TextDecoder().decode(body).replace(/\b(src|href)="\.\//g, '$1="/')
        : body as BodyInit
      return new Response(responseBody, {
        status: 200,
        headers: {
          'Content-Type': MIME[ext] ?? 'application/octet-stream',
          ...(path === '/sw.js' || path === '/manifest.webmanifest' ? { 'Cache-Control': 'no-cache' } : {}),
        },
      })
    })
  }
}
