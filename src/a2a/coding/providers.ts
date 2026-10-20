import { spawn, type SpawnOptions, type ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { A2aRunner } from '../service.ts'
import { CodingContexts } from './contexts.ts'
import { bridgeEnvironment, type CodingBridgeConfig } from './config.ts'

export type SpawnCli = (file: string, args: string[], options: SpawnOptions) => ChildProcess
export const spawnCli: SpawnCli = (file, args, options) => spawn(file, args, options)

/** Resolve only known official Claude package entrypoints, never shim contents. */
function claudeShimTarget(shim: string): { file: string; prefix: string[] } | undefined {
  const root = join(dirname(shim), 'node_modules', '@anthropic-ai', 'claude-code')
  const manifest = join(root, 'package.json')
  let entry = 'cli.js' // Older npm installs used this fixed JS layout.
  if (existsSync(manifest)) {
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.claude
      // A package manifest is data, not permission to launch arbitrary targets.
      if (pkg.name !== '@anthropic-ai/claude-code' || !['cli.js', 'bin/claude.exe'].includes(bin)) return
      entry = bin
    } catch { return }
  }
  const target = join(root, entry)
  if (!existsSync(target)) return
  return entry === 'cli.js' ? { file: process.execPath, prefix: [target] } : { file: target, prefix: [] }
}

/** Never execute a shell shim; resolve vetted sibling package entrypoints instead. */
export function resolveCli(config: CodingBridgeConfig, env: NodeJS.ProcessEnv): { file: string; prefix: string[] } {
  const name = config.executable ?? config.backend.type
  const path = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(Boolean).flatMap(dir =>
    process.platform === 'win32' ? [join(dir, `${name}.exe`), join(dir, `${name}.cmd`)] : [join(dir, name)])
  for (const file of candidates) {
    try { accessSync(file, process.platform === 'win32' || /\.m?js$/.test(file) ? constants.F_OK : constants.X_OK) } catch { continue }
    if (/\.(cmd|bat)$/i.test(file)) {
      if (config.backend.type === 'claude') {
        const target = claudeShimTarget(file)
        if (target) return target
      } else {
        const js = join(dirname(file), 'node_modules/@openai/codex/bin/codex.js')
        if (existsSync(js)) return { file: process.execPath, prefix: [js] }
      }
      throw new Error('CLI shell shim cannot be safely launched. Set executable to a native executable or official CLI .js entrypoint.')
    }
    if (extname(file) === '.js' || extname(file) === '.mjs') return { file: process.execPath, prefix: [file] }
    return { file, prefix: [] }
  }
  throw new Error(`User-installed ${config.backend.type} CLI not found; configure an absolute executable path or PATH. Shadow does not install or log in coding agents.`)
}

export function validateBackend(config: CodingBridgeConfig) {
  if (config.backend.type === 'copilot') throw new Error('Copilot CLI bridge is unsupported: verified CLI requires --allow-all-tools in prompt mode and cannot guarantee isolated MCP policy. No unrestricted fallback is enabled.')
}

/** Capture bounded structured output, wait for close (not exit), terminate the process tree. */
export async function runCli(file: string, args: string[], options: SpawnOptions, prompt: string, signal: AbortSignal, launch: SpawnCli) {
  signal.throwIfAborted()
  const child = launch(file, args, { ...options, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''; let stderr = ''; let failure: Error | undefined
  let stopping = false
  let cleanup: Promise<void> | undefined
  const stop = () => {
    if (stopping) return
    stopping = true
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true })
      cleanup = new Promise(resolve => {
        killer.on('error', error => { failure = error; child.kill('SIGKILL'); resolve() })
        killer.on('close', code => { if (code && child.exitCode === null) { failure = new Error('CLI process-tree cleanup failed.'); child.kill('SIGKILL') }; resolve() })
      })
    } else {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch (error) { failure = error as Error; child.kill('SIGKILL') }
    }
  }
  signal.addEventListener('abort', stop, { once: true })
  const append = (which: 'out' | 'err', chunk: Buffer | string) => {
    if (which === 'out') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8')
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 8 * 1024 * 1024) { failure = new Error('CLI output limit exceeded.'); stop() }
  }
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', chunk => append('out', chunk))
  child.stderr?.on('data', chunk => append('err', chunk))
  child.stdin?.on('error', error => { if (!stopping) failure = error })
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
      child.stdin?.end(prompt)
      if (signal.aborted) stop()
    })
    await cleanup
    if (failure) throw failure
    signal.throwIfAborted()
    // Do not return provider stderr: it can contain credentials or private tool output.
    if (code !== 0) throw new Error(`Coding CLI exited unsuccessfully (${code}); inspect operator CLI diagnostics locally.`)
    return stdout
  } finally { signal.removeEventListener('abort', stop) }
}

function parseOutput(text: string): any {
  try { return JSON.parse(text) } catch { throw new Error('CLI returned invalid structured output.') }
}

/** Injectable credential source keeps process-contract tests away from operator credentials. */
export type ReadCodexAuth = () => string | undefined
const readCodexAuth: ReadCodexAuth = () => {
  const auth = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')
  return existsSync(auth) ? readFileSync(auth, 'utf8') : undefined
}

export function codingRunner(config: CodingBridgeConfig, launch: SpawnCli = spawnCli, authSource: ReadCodexAuth = readCodexAuth): A2aRunner {
  validateBackend(config)
  const environment = bridgeEnvironment(config.environment)
  const executable = resolveCli(config, environment)
  const contexts = new CodingContexts({ ...config, executable: executable.prefix[0] ?? executable.file })
  const home = join(config.stateDirectory, 'codex')
  if (config.backend.type === 'codex') mkdirSync(home, { recursive: true, mode: 0o700 })
  return { async run(record, message, signal) {
    if (signal.aborted) return { status: 'cancelled', content: '' }
    const prompt = message.parts.map(part => part.content?.value).join('\n')
    const resume = contexts.get(record)
    const args: string[] = []
    const newSession = randomUUID()
    const env = { ...environment }
    if (config.backend.type === 'claude') {
      args.push('--restricted', '--print', '--output-format', 'json', '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--permission-mode', 'dontAsk', '--tools', config.backend.tools.join(','))
      if (config.backend.tools.length) args.push('--allowedTools', config.backend.tools.join(','))
      if (resume) args.push('--resume', resume)
      else args.push('--session-id', newSession)
    } else if (config.backend.type === 'codex') {
      // Reuse ordinary CLI authentication, but never its config/MCP servers or session inventory.
      const auth = authSource()
      if (auth !== undefined) {
        const { writePrivateFile } = await import('../../config/store.ts')
        writePrivateFile(join(home, 'auth.json'), auth)
      } else rmSync(join(home, 'auth.json'), { force: true })
      env.CODEX_HOME = home
      args.push('-c', 'approval_policy="never"', '-c', `sandbox_mode="${config.backend.sandbox}"`, '-c', 'sandbox_workspace_write.network_access=false', '-c', 'web_search="disabled"', 'exec')
      if (resume) args.push('resume')
      args.push('--json')
      if (config.model) args.push('--model', config.model)
      if (resume) args.push(resume)
      args.push('-')
    }
    if (config.backend.type === 'claude' && config.model) args.push('--model', config.model)
    try {
      const output = await runCli(executable.file, [...executable.prefix, ...args], { cwd: config.cwd, env, windowsHide: true }, prompt, signal, launch)
      let content: string | undefined
      if (config.backend.type === 'claude') {
        const result = parseOutput(output)
        if (result.type !== 'result' || result.subtype !== 'success' || result.is_error !== false || result.permission_denials?.length || typeof result.result !== 'string') throw new Error('Claude returned failure, denied permissions, or no final result.')
        if (typeof result.session_id !== 'string') throw new Error('Claude returned no session ID.')
        if (result.session_id !== (resume ?? newSession)) throw new Error('Claude resumed an unexpected session.')
        contexts.set(record, result.session_id)
        content = result.result
      } else {
        let completed = false; let sessionId: string | undefined
        for (const line of output.split(/\r?\n/).filter(Boolean)) {
          const event = parseOutput(line)
          if (event.type === 'thread.started') sessionId = event.thread_id
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') content = event.item.text
          if (event.type === 'turn.completed') completed = true
          if (event.type === 'turn.failed' || event.type === 'error') throw new Error('Codex reported an execution failure.')
        }
        if (!completed || typeof content !== 'string' || typeof sessionId !== 'string') throw new Error('Codex stopped without a completed turn, session ID and final text.')
        if (resume && sessionId !== resume) throw new Error('Codex resumed an unexpected session.')
        contexts.set(record, sessionId)
      }
      return { status: 'completed', content: content! }
    } catch (error) {
      if (signal.aborted && error === signal.reason) return { status: 'cancelled', content: '' }
      throw error
    }
  } }
}
