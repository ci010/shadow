import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { join, relative, isAbsolute, sep } from 'node:path'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { z } from 'zod'
import { writePrivateFile } from '../config/store.ts'
import type { Tool, ToolParameters } from '../tools/tool.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { A2aConfig } from './config.ts'
import { a2aProjectPath } from './config.ts'
import { a2aAuthenticator, registerA2aRoutes } from './routes.ts'
import { A2aStore } from './store.ts'
import { A2aService } from './service.ts'
import { CodingBridgeConfigSchema, bridgeEnvironment, type CodingBridgeConfig } from './coding/config.ts'
import { codingRunner, resolveCli, runCli } from './coding/providers.ts'

const name = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
const backend = z.discriminatedUnion('type', [
  z.object({ type: z.literal('codex'), sandbox: z.enum(['read-only', 'workspace-write']) }).strict(),
  z.object({ type: z.literal('claude'), tools: z.array(z.enum(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'NotebookEdit'])).max(32) }).strict(),
])
const executablePath = z.string().refine(isAbsolute, 'Executable must be an absolute local path.').optional()
class SetupError extends Error { constructor(readonly code: string, message: string) { super(message) } }
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('detect'), type: z.enum(['codex', 'claude']), executable: executablePath }).strict(),
  z.object({ action: z.literal('configure'), name, backend, cwd: z.string().min(1), executable: executablePath }).strict(),
  z.object({ action: z.literal('list') }).strict(),
  ...(['status', 'start', 'stop'] as const).map(action => z.object({ action: z.literal(action), name }).strict()),
])
type Saved = { config: CodingBridgeConfig; credential: string }

/** Project-owned, localhost-only bridges. No credential is placed in process.env or public config. */
export class A2aSetup implements Tool {
  readonly name = 'a2a_setup'
  readonly description = 'Local admin-only setup of independent user-installed Codex/Claude CLI sessions. Detect (version only), configure explicit cwd/policy, list saved bridges, start, status, stop. No install/login or paid prompt. Setup grants no remote delegation rights. Read v:skills/a2a-setup.'
  readonly parameters: ToolParameters = {
    type: 'object', properties: {
      action: { type: 'string', enum: ['detect', 'configure', 'start', 'status', 'stop', 'list'] },
      name: { type: 'string' }, type: { type: 'string', enum: ['codex', 'claude'] },
      executable: { type: 'string', description: 'detect/configure only: explicit absolute native executable or official CLI JS entrypoint. No shell command or endpoint.' },
      cwd: { type: 'string', description: 'Must equal current authorized local working directory.' },
      backend: { type: 'object', description: 'Explicit policy: {type:codex,sandbox:read-only|workspace-write} or {type:claude,tools:[explicit CLI tool names]}. No default widening.' },
    }, required: ['action'], additionalProperties: false,
  }
  readonly readonly = (args: Record<string, unknown>) => args.action === 'list' || args.action === 'status' || args.action === 'detect'
  private readonly saved = new Map<string, Saved>()
  private readonly running = new Map<string, { close(): Promise<void> }>()
  private busy = false
  private closed = false
  private readonly pending = new Set<Promise<string>>()
  private closing?: Promise<void>
  constructor(private projectId: string, private directory: string, private config: A2aConfig,
    private setToken: (name: string, token?: string) => void,
    private assertOwner: (context: ExecutionContext) => void,
    private hooks: { beforeRegister?: (port: number) => Promise<void> } = {}) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, 'bridges.json')
    if (existsSync(path)) {
      const records = z.record(name, z.object({ config: CodingBridgeConfigSchema, credential: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).parse(JSON.parse(readFileSync(path, 'utf8')))
      for (const [key, value] of Object.entries(records)) {
        if (value.config.projectId !== projectId || value.config.stateDirectory !== join(directory, key) ||
          value.config.server.url !== `http://127.0.0.1:${value.config.port}${a2aProjectPath(projectId)}`) throw new Error('Invalid saved local bridge configuration.')
        this.saved.set(key, value)
      }
    }
    // Deliberately stopped after backend restart: an admin explicitly starts each saved bridge.
  }
  private resolve(config: CodingBridgeConfig) {
    try { return resolveCli(config, bridgeEnvironment([])) }
    catch { throw new SetupError('CLI_UNAVAILABLE', 'Installed CLI not found or launcher unsupported. Supply an absolute executable/official JS entrypoint, or ask the operator to install it separately. No install/login was attempted.') }
  }
  private persist() { writePrivateFile(join(this.directory, 'bridges.json'), JSON.stringify(Object.fromEntries(this.saved))) }
  private base(type: 'codex' | 'claude', cwd: string): CodingBridgeConfig {
    return { projectId: this.projectId, stateDirectory: this.directory, cwd, port: 0,
      server: { url: `http://127.0.0.1:0${a2aProjectPath(this.projectId)}`, callers: { shadow: 'LOCAL_BRIDGE_TOKEN' }, maxConcurrent: 1, timeoutMs: 120000 },
      backend: type === 'codex' ? { type, sandbox: 'read-only' } : { type, tools: [] }, environment: [] }
  }
  execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    const operation = this.executeOperation(args, context)
    this.pending.add(operation)
    void operation.finally(() => this.pending.delete(operation))
    return operation
  }
  private async executeOperation(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    try {
      if (this.closed) throw new SetupError('SETUP_CLOSED', 'Project setup is shutting down; no new bridge can be started.')
      if (context.projectId !== this.projectId || context.admin !== true || context.isGroup || context.channel !== 'web' || context.remoteWorkdir || context.tools.executionMode === 'call' || context.tools.dynamicOwner !== context.tools) throw new SetupError('SETUP_DENIED', 'Setup requires a local admin Web session, not a remote or borrowed context.')
      try { this.assertOwner(context) } catch { throw new SetupError('SETUP_DENIED', 'A durable owning session with authorized local folder access is required.') }
      const request = requestSchema.parse(args)
      context.signal.throwIfAborted()
      if (this.busy) throw new SetupError('BUSY', 'Another bridge setup operation is in progress.')
      this.busy = true
      try {
        if (request.action === 'detect') {
          const config = this.base(request.type, context.cwd ?? this.directory)
          config.executable = request.executable
          const executable = this.resolve(config)
          // Version output is not trusted or forwarded; no auth files are read and no prompt is sent.
          const output = await runCli(executable.file, [...executable.prefix, '--version'], { cwd: config.cwd, env: bridgeEnvironment([]) }, '', AbortSignal.any([context.signal, AbortSignal.timeout(10000)]), (await import('./coding/providers.ts')).spawnCli)
          const version = output.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0]
          return JSON.stringify({ installed: true, version: version ?? 'unrecognized', readiness: 'Authentication, policy compatibility and billing readiness not verified; no prompt or login was run.' })
        }
        if (request.action === 'list') return JSON.stringify({ bridges: [...this.saved].map(([name, value]) => ({ name, status: this.running.has(name) ? 'listening' : 'stopped', backend: value.config.backend, cwd: value.config.cwd, executable: value.config.executable, allocation: value.config.port === 0 ? 'unallocated' : 'allocated' })) })
        const key = request.name
        if (request.action === 'configure') {
          if (this.saved.has(key) || Object.hasOwn(this.config.agents, key)) throw new SetupError('NAME_EXISTS', 'Name already exists; stop/reuse it or select a new name. Existing policy is never overwritten.')
          if (!context.cwd || !isAbsolute(request.cwd) || await realpath(request.cwd) !== await realpath(context.cwd) || !(await stat(request.cwd)).isDirectory()) throw new SetupError('WORKDIR_MISMATCH', 'cwd must equal the current authorized local workdir.')
          const path = relative(await realpath(request.cwd), await realpath(this.directory))
          if (!path || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)) throw new SetupError('UNSAFE_STATE_DIRECTORY', 'Bridge state must be outside the coding workdir.')
          const config = { ...this.base(request.backend.type, await realpath(request.cwd)), backend: request.backend, executable: request.executable, stateDirectory: join(this.directory, key) }
          this.resolve(config)
          this.saved.set(key, { config, credential: randomBytes(32).toString('hex') })
          try { this.persist() } catch (error) { this.saved.delete(key); throw error }
          return JSON.stringify({ name: key, status: 'configured-stopped', restart: 'Saved policy persists; explicit start is required after every backend restart.' })
        }
        const saved = this.saved.get(key)
        if (!saved) throw new SetupError('UNKNOWN_BRIDGE', 'Unknown locally managed bridge.')
        if (request.action === 'status') return JSON.stringify({ name: key, status: this.running.has(key) ? 'listening' : 'stopped', backend: saved.config.backend, cwd: saved.config.cwd, readiness: 'No paid health prompt is run. start revalidates CLI and cwd; delegation reports provider failures.' })
        if (request.action === 'stop') {
          await this.running.get(key)?.close()
          this.running.delete(key); delete this.config.agents[key]; this.setToken(key)
          return JSON.stringify({ name: key, status: 'stopped' })
        }
        if (this.running.has(key)) return JSON.stringify({ name: key, status: 'listening' })
        if (Object.hasOwn(this.config.agents, key)) throw new SetupError('NAME_EXISTS', 'Configured target name collision.')
        if (!context.cwd || await realpath(context.cwd) !== await realpath(saved.config.cwd)) throw new SetupError('WORKDIR_MISMATCH', 'Start requires the saved authorized workdir selected in this session.')
        const config = saved.config
        if (!(await stat(config.cwd)).isDirectory()) throw new SetupError('WORKDIR_UNAVAILABLE', 'Saved cwd no longer exists.')
        const statePath = relative(await realpath(config.cwd), await realpath(this.directory))
        if (!statePath || !isAbsolute(statePath) && statePath !== '..' && !statePath.startsWith(`..${sep}`)) throw new SetupError('UNSAFE_STATE_DIRECTORY', 'State directory must remain outside cwd.')
        mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 })
        if (await realpath(config.stateDirectory) !== join(await realpath(this.directory), key)) throw new SetupError('UNSAFE_STATE_DIRECTORY', 'Bridge state must not be redirected.')
        const store = new A2aStore(config.stateDirectory); store.init()
        // Allocate on first start; persist the port so owned conversations retain their endpoint after restart.
        this.resolve(config)
        const runner = codingRunner(config)
        const app = new Hono(); const project = new Hono()
        let service: A2aService | undefined
        const listening = Promise.withResolvers<number>()
        // Agent card needs the selected port before the first inbound request.
        const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.port }, info => listening.resolve(info.port))
        server.once('error', error => listening.reject(error))
        const close = async () => {
          const results = await Promise.allSettled([service?.close(), server.listening ? new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : Promise.resolve()])
          const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
          if (failures.length) throw new AggregateError(failures, 'Bridge shutdown failed.')
        }
        try {
          const port = await listening.promise
          await this.hooks.beforeRegister?.(port)
          context.signal.throwIfAborted()
          if (this.closed) throw new SetupError('SETUP_CLOSED', 'Project setup shut down before bridge registration; listener was cleaned up.')
          config.port = port; config.server.url = `http://127.0.0.1:${port}${a2aProjectPath(this.projectId)}`
          service = new A2aService(this.projectId, { ...config.server, agentType: config.backend.type }, store, runner)
          registerA2aRoutes(project, service, a2aAuthenticator({ shadow: 'LOCAL_BRIDGE_TOKEN' }, { LOCAL_BRIDGE_TOKEN: saved.credential }))
          app.route(`/projects/${this.projectId}`, project)
          this.persist()
          this.config.agents[key] = { endpointUrl: config.server.url, cardUrl: `${config.server.url}/.well-known/agent-card.json` }
          this.setToken(key, saved.credential); this.running.set(key, { close })
          return JSON.stringify({ name: `a2a:${key}`, status: 'listening', restart: 'Explicit start required after backend restart; native chats are never adopted.' })
        } catch (error) { await close(); throw error }
      } finally { this.busy = false }
    } catch (error) {
      const code = error instanceof SetupError ? error.code : error instanceof z.ZodError ? 'INVALID_ARGUMENTS' : (error as NodeJS.ErrnoException)?.code === 'EADDRINUSE' ? 'PORT_IN_USE' : context.signal.aborted ? 'CANCELLED' : 'LOCAL_OPERATION_FAILED'
      const message = error instanceof SetupError ? error.message : code === 'INVALID_ARGUMENTS' ? 'Check the action schema, absolute paths and explicit permission policy.' : code === 'PORT_IN_USE' ? 'The saved local port is occupied. Stop its conflicting owner, then retry start; no endpoint fallback was used.' : code === 'CANCELLED' ? 'Setup was cancelled; inspect list/status before retrying.' : 'Local operation failed. Check local filesystem access and CLI version support; no provider diagnostics are returned.'
      return JSON.stringify({ error: { code, message } })
    }
  }
  close(): Promise<void> {
    this.closed = true
    return this.closing ??= (async () => {
      await Promise.allSettled([...this.pending])
      const results = await Promise.allSettled([...this.running].map(async ([name, bridge]) => {
        await bridge.close()
        delete this.config.agents[name]; this.setToken(name)
      }))
      this.running.clear()
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (failures.length) throw new AggregateError(failures, 'Local bridge shutdown failed.')
    })()
  }
}
