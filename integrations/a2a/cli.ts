import { mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { A2aStore } from '../../src/a2a/store.ts'
import { A2aService } from '../../src/a2a/service.ts'
import { a2aAuthenticator, registerA2aRoutes } from '../../src/a2a/routes.ts'
import { lockA2aDirectory, readA2aConfig } from '../../src/a2a/cli-support.ts'
import { CodingBridgeConfigSchema, type CodingBridgeConfig } from './config.ts'
import { codingRunner, officialCodingSdks, type CodingSdks } from './providers.ts'

export async function startCodingBridge(config: CodingBridgeConfig, sdks: Partial<CodingSdks>) {
  if (!(await stat(config.cwd)).isDirectory()) throw new Error('Coding bridge cwd must be an existing local directory.')
  const authenticate = a2aAuthenticator(config.server.callers)
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 })
  const path = relative(await realpath(config.cwd), await realpath(config.stateDirectory))
  if (!path || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)) {
    throw new Error('Coding bridge stateDirectory must be outside its coding workdir.')
  }
  const unlock = lockA2aDirectory(config.stateDirectory)
  let service: A2aService | undefined
  let released = false
  const release = () => { if (!released) { unlock(); released = true } }
  try {
    const store = new A2aStore(config.stateDirectory)
    store.init()
    service = new A2aService(config.projectId, { ...config.server, agentType: config.backend.type },
      store, codingRunner(config, sdks))
    const app = new Hono()
    const project = new Hono()
    registerA2aRoutes(project, service, authenticate)
    app.route(`/projects/${config.projectId}`, project)
    const listening = Promise.withResolvers<void>()
    let port = config.port
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, info => { port = info.port; listening.resolve() })
    server.once('error', error => listening.reject(error))
    let closing: Promise<void> | undefined
    const close = () => closing ??= (async () => {
      const closed = server.listening
        ? new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : Promise.resolve()
      const results = await Promise.allSettled([service!.close(), closed])
      release()
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (errors.length) throw new AggregateError(errors, 'Coding bridge shutdown failed.')
    })()
    try { await listening.promise }
    catch (error) {
      await close()
      throw error
    }
    return { port, close }
  } catch (error) {
    try { await service?.close() } finally { release() }
    throw error
  }
}

async function main() {
  const raw = await readA2aConfig()
  if (raw === undefined) return
  const config = CodingBridgeConfigSchema.parse(raw)
  const server = await startCodingBridge(config, await officialCodingSdks.load(config.backend.type))
  const shutdown = () => { void server.close().catch(error => { console.error('[a2a:bridge] Shutdown failed', error); process.exitCode = 1 }) }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  console.error(`[a2a:bridge] ${config.backend.type} listening on 127.0.0.1:${server.port}; A2A endpoint ${config.server.url}`)
}

if (import.meta.main) {
  await main().catch(error => { console.error('[a2a:bridge] Startup failed', error); process.exitCode = 1 })
}
