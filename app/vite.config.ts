import { defineConfig, normalizePath, type Plugin, type ProxyOptions } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import type { EventEmitter } from 'node:events'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { TLSSocket } from 'node:tls'
import { SCOPED_BACKEND_PATTERN } from '../src/gateway/route-kind.ts'
import { parseRuntimeEndpointMessage } from '../desktop/src/control/runtime-endpoint.ts'

// Default backend gateway (the Shadow bot). Override with VITE_API_TARGET if
// you run the bot on a non-default host/port.
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:3123'

export function desktopBackendRouting(
  enabled = process.env.SHADOW_DESKTOP_DEV_IPC === '1',
  messages: Pick<EventEmitter, 'on' | 'off'> = process,
): { plugin: Plugin; proxy: Record<string, ProxyOptions> } {
  // The shared URL object survives Vite's shallow copies of proxy options.
  const target = { protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1:1', port: 1 }
  let ready = false
  const proxy = Object.fromEntries([
    SCOPED_BACKEND_PATTERN, '/v1', '/api', '/nodes/v1', '/local/v1',
    '/host/v1', '/pair/v1', '/debug',
  ].map((path) => [path, {
    target: enabled ? target : API_TARGET,
    changeOrigin: true,
    ws: path !== '/v1',
    configure(server) {
      const forwardBrowserOrigin = (proxyRequest: ClientRequest, request: IncomingMessage) => {
        const protocol = request.socket instanceof TLSSocket ? 'https:' : 'http:'
        // Only translate same-origin browser requests alongside changeOrigin's Host rewrite.
        // Missing, null and cross-origin values must still reach the backend's origin checks.
        if (request.headers.origin !== `${protocol}//${request.headers.host}`) return
        const backendProtocol = enabled ? target.protocol : new URL(API_TARGET).protocol
        proxyRequest.setHeader('Origin', new URL(`${backendProtocol}//${proxyRequest.getHeader('host')}`).origin)
      }
      server.on('proxyReq', forwardBrowserOrigin)
      server.on('proxyReqWs', forwardBrowserOrigin)
      if (!enabled) return
      const web = server.web
      const ws = server.ws
      Object.defineProperties(server, {
        web: { value: (...args: Parameters<typeof web>) => {
          if (ready) return web.apply(server, args)
          const response = args[1]
          response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' })
          response.end(JSON.stringify({ error: 'Desktop backend is not ready. Retry shortly.' }))
        } },
        ws: { value: (...args: Parameters<typeof ws>) => {
          if (ready) return ws.apply(server, args)
          args[1].end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 1\r\n\r\n')
        } },
      })
    },
  } satisfies ProxyOptions]))
  return {
    proxy,
    plugin: {
      name: 'shadow-desktop-backend',
      configureServer(server) {
        if (!enabled) return
        const receive = (value: unknown) => {
          const message = parseRuntimeEndpointMessage(value)
          if (!message) return
          ready = message.type === 'shadow:runtime-ready'
          if (message.type === 'shadow:runtime-ready') {
            const url = new URL(message.apiBase)
            Object.assign(target, {
              protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/gu, ''), host: url.host, port: Number(url.port || 80),
            })
          }
        }
        const disconnected = () => { ready = false }
        messages.on('message', receive)
        messages.on('disconnect', disconnected)
        server.httpServer?.once('close', () => {
          messages.off('message', receive)
          messages.off('disconnect', disconnected)
        })
      },
    },
  }
}

const routing = desktopBackendRouting()

export default defineConfig({
  base: './',
  plugins: [routing.plugin, vue(), UnoCSS({
    configFile: fileURLToPath(new URL('./unocss.config.ts', import.meta.url)),
  })],
  server: {
    host: process.env.VITE_DEV_HOST ?? '0.0.0.0',
    port: 5273,
    strictPort: true,
    proxy: routing.proxy,
    fs: {
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.pin',
        ...(process.env.SHADOW_BROWSER_PIN_FILE ? [normalizePath(resolve(process.env.SHADOW_BROWSER_PIN_FILE))] : [])],
    },
  },
})
