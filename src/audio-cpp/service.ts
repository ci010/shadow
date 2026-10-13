import { openCliStream } from './cli-stream.ts'
import { AudioCppInstaller, setupSchema, type SetupRequest, type ArtifactDownloader } from './install.ts'
import { RemoteAudio, remoteSchema, type RemoteConfig } from './remote.ts'
import { assessCandidate, detectHardware, type Candidate } from './assessment.ts'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, open, readFile, realpath, rm, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, dirname, extname, join } from 'node:path'
import { z } from 'zod'
import { writePrivateFile } from '../config/store.ts'
import { workspacePath } from '../utils/paths.ts'
import { ToolNoEffectError } from '../tools/tool.ts'

const model = z.object({
  family: z.string().regex(/^[a-z][a-z0-9_]*$/),
  path: z.string().min(1),
  backend: z.enum(['cpu', 'cuda', 'vulkan', 'metal', 'hip', 'best']).default('cpu'),
  options: z.array(z.string()).default([]),
}).strict()
const configSchema = z.object({
  version: z.literal(1),
  binary: z.string().min(1).optional(),
  asr: model.optional(),
  tts: model.optional(),
  remoteAsr: remoteSchema.optional(), remoteTts: remoteSchema.optional(),
  routes: z.object({ asr: z.enum(['local', 'remote']).optional(), tts: z.enum(['local', 'remote']).optional() }).strict().optional(),
}).strict()
const loaderCatalog = z.union([
  z.array(z.object({ family: z.string().min(1) }).passthrough()).nonempty(),
  z.object({
    schema_version: z.literal(1),
    loaders: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.object({
      tasks: z.record(z.array(z.string().min(1))).refine(tasks => Object.keys(tasks).length > 0),
    }).passthrough()).refine(loaders => Object.keys(loaders).length > 0),
  }).passthrough(),
])
type AudioConfig = z.infer<typeof configSchema>
type Task = 'asr' | 'tts'
const MAX_OUTPUT = 1024 * 1024
const PROBE_TIMEOUT_MS = 30_000
const INFERENCE_TIMEOUT_MS = 30 * 60_000
const BLOCKED_FLAGS = new Set([
  '--task', '--family', '--model', '--backend', '--audio', '--text', '--out',
  '--text-out', '--out-dir', '--config', '--pipeline', '--request-sequence',
  '--batch-audio-dir', '--batch-text-dir', '--log-file',
])

function validateOptions(options: string[]): void {
  for (const arg of options) {
    if (!arg || arg.includes('\0') || arg.includes('\n') || arg.includes('\r')) throw new TypeError('Invalid audio.cpp option')
    if (arg.startsWith('-') && BLOCKED_FLAGS.has(arg.split('=')[0])) {
      throw new TypeError(`audio.cpp option ${arg} is owned by Shadow`)
    }
  }
}

export async function runAudioCpp(
  binary: string, args: string[], signal?: AbortSignal, timeoutMs = INFERENCE_TIMEOUT_MS,
): Promise<string> {
  signal?.throwIfAborted()
  return new Promise((resolveRun, reject) => {
    const timeout = AbortSignal.timeout(timeoutMs)
    const child = spawn(binary, args, {
      shell: false, windowsHide: true,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let exceeded = false
    const capture = (which: 'stdout' | 'stderr', chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_OUTPUT) {
        exceeded = true
        child.kill()
      } else if (which === 'stdout') stdout += chunk.toString('utf8')
      else stderr += chunk.toString('utf8')
    }
    child.stdout.on('data', (chunk: Buffer) => capture('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => capture('stderr', chunk))
    let processError: Error | undefined
    child.once('error', error => { processError = timeout.aborted && !signal?.aborted
      ? new Error(`audio.cpp timed out after ${timeoutMs} ms`, { cause: error }) : error })
    child.once('close', (code) => {
      if (processError) reject(processError)
      else if (exceeded) reject(new Error('audio.cpp output exceeded 1 MiB'))
      else if (code !== 0) reject(new Error(`audio.cpp exited ${code}: ${(stderr || stdout).slice(-4000)}`))
      else resolveRun(stdout)
    })
  })
}

async function existingFile(path: string): Promise<string> {
  const actual = await realpath(path)
  if (!(await stat(actual)).isFile()) throw new TypeError(`Not a file: ${path}`)
  return actual
}

export class AudioCppService {
  private readonly configPath: string
  private readonly tempPath: string
  private readonly installer: AudioCppInstaller
  private readonly root: string
  private setupPending: Promise<unknown> = Promise.resolve()
  private pending: Promise<unknown> = Promise.resolve()
  private inferenceBusy = false

  private acquireInference(): () => void {
    if (this.inferenceBusy) throw new Error('Local audio inference is busy')
    this.inferenceBusy = true
    return () => { this.inferenceBusy = false }
  }

  constructor(
    workspace: string,
    private readonly run: typeof runAudioCpp = runAudioCpp,
    downloader?: ArtifactDownloader,
    private readonly remote = new RemoteAudio(),
  ) {
    this.configPath = workspacePath(workspace, '.audio-cpp.json')
    this.tempPath = workspacePath(workspace, '.tmp')
    this.root = workspacePath(workspace, '.audio-cpp')
    this.installer = new AudioCppInstaller(this.root, downloader)
  }

  async read(): Promise<AudioConfig> {
    let data: string
    try {
      data = await readFile(this.configPath, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { version: 1 }
      throw error
    }
    return configSchema.parse(JSON.parse(data))
  }

  async binary(config?: AudioConfig): Promise<string | undefined> {
    config ??= await this.read()
    const requested = config.binary ?? process.env.AUDIOCPP_CLI_PATH
    if (requested) return existingFile(requested)
    const executable = process.platform === 'win32' ? 'audiocpp_cli.exe' : 'audiocpp_cli'
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
      if (!directory) continue
      try {
        return await existingFile(join(directory, executable))
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
    return undefined
  }

  async status() {
    const config = await this.read()
    const requested = config.binary ?? process.env.AUDIOCPP_CLI_PATH
    let binary: string | undefined
    let binaryError: string | undefined
    try { binary = await this.binary(config) } catch (error) {
      binaryError = error instanceof Error ? error.message : String(error)
    }
    const models = await Promise.all((['asr', 'tts'] as const).map(async task => {
      const entry = config[task]
      if (!entry) return [task, { status: 'not_configured' }] as const
      try {
        await access(entry.path, constants.R_OK)
        return [task, { status: 'path_accessible', ...entry }] as const
      } catch (error) {
        return [task, { status: 'missing', ...entry, error: error instanceof Error ? error.message : String(error) }] as const
      }
    }))
    return {
      status: binary ? 'available' : requested ? 'binary_error' : 'not_installed',
      binary: binary ?? requested ?? null,
      ...(binaryError ? { error: binaryError } : {}),
      configPath: this.configPath,
      models: { asr: models[0][1], tts: models[1][1] },
      routes: config.routes ?? {},
      remote: { asr: config.remoteAsr ?? null, tts: config.remoteTts ?? null },
      inferenceVerified: false,
      guide: 'v:skills/audio-cpp',
    }
  }

  configure(update: { binary?: string; task?: Task; family?: string; path?: string; backend?: string; options?: string[] }, signal?: AbortSignal): Promise<object> {
    const operation = this.pending.catch(() => {}).then(async () => {
      signal?.throwIfAborted()
      if (!update.binary && !update.task) throw new TypeError('Provide binary and/or task to configure')
      if (!update.task && (update.family || update.path || update.backend || update.options)) throw new TypeError('Model fields require task')
      const current = await this.read()
      const next: AudioConfig = { ...current }
      if (update.binary) {
        const binary = await existingFile(update.binary)
        const catalog = await this.run(binary, ['--list-loaders', '--json'], signal, PROBE_TIMEOUT_MS)
        try { loaderCatalog.parse(JSON.parse(catalog)) }
        catch (error) {
          if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error
          throw new ToolNoEffectError('audio.cpp returned an unsupported loader catalog; expected a nonempty family array or schema_version=1 with a loaders object. Configuration was not written.', { cause: error })
        }
        next.binary = binary
      }
      if (update.task) {
        const old = current[update.task]
        const selected = model.parse({
          family: update.family ?? old?.family,
          path: update.path ?? old?.path,
          backend: update.backend ?? old?.backend ?? 'cpu',
          options: update.options ?? old?.options ?? [],
        })
        validateOptions(selected.options)
        selected.path = await realpath(selected.path)
        const info = await stat(selected.path)
        if (!info.isFile() && !info.isDirectory()) throw new TypeError('Model path must be a file or directory')
        next[update.task] = selected
        next.routes = { ...next.routes, [update.task]: 'local' }
      }
      if (!await this.binary(next)) throw new Error('Configure an installed audiocpp_cli binary first; read v:skills/audio-cpp')
      signal?.throwIfAborted()
      await mkdir(dirname(this.configPath), { recursive: true })
      signal?.throwIfAborted()
      writePrivateFile(this.configPath, JSON.stringify(configSchema.parse(next), null, 2) + '\n')
      return this.status()
    })
    this.pending = operation
    return operation
  }

  async assess(candidate: Candidate) {
    await mkdir(this.root, { recursive: true })
    return assessCandidate(candidate, await detectHardware(this.root))
  }

  setup(request: SetupRequest, signal?: AbortSignal): Promise<object> {
    const operation = this.setupPending.catch(() => {}).then(async () => {
      const selected = setupSchema.parse(request)
      validateOptions(selected.options)
      const installed = await this.installer.install(selected, signal, async binary => {
        const catalog = loaderCatalog.parse(JSON.parse(await this.run(binary, ['--list-loaders', '--json'], signal, PROBE_TIMEOUT_MS)))
        const supported = Array.isArray(catalog)
          ? catalog.some(loader => loader.family === selected.model.family)
          : !!catalog.loaders[selected.model.family]?.tasks[selected.task]
        if (!supported) throw new Error('Installed CLI does not support the selected model family/task; configuration unchanged')
      })
      await this.run(installed.binary, ['--help', '--task', selected.task, '--family', selected.model.family, '--model', installed.path], signal, PROBE_TIMEOUT_MS)
      return this.configure({ ...installed, task: selected.task, family: selected.model.family, backend: selected.backend, options: selected.options }, signal)
    })
    this.setupPending = operation
    return operation
  }

  configureRemote(task: Task, request: RemoteConfig, signal?: AbortSignal): Promise<object> {
    const operation = this.pending.catch(() => {}).then(async () => {
      const remote = remoteSchema.parse(request)
      signal?.throwIfAborted()
      const current = await this.read()
      const next: AudioConfig = { ...current, [task === 'asr' ? 'remoteAsr' : 'remoteTts']: remote, routes: { ...current.routes, [task]: 'remote' } }
      await mkdir(dirname(this.configPath), { recursive: true })
      signal?.throwIfAborted()
      writePrivateFile(this.configPath, JSON.stringify(configSchema.parse(next), null, 2) + '\n')
      return this.status()
    })
    this.pending = operation
    return operation
  }

  async inspect(task: Task | undefined, signal?: AbortSignal): Promise<string> {
    const config = await this.read()
    const binary = await this.binary(config)
    if (!binary) throw new Error('audio.cpp CLI not installed; read v:skills/audio-cpp')
    const entry = task && config[task]
    const args = entry
      ? ['--help', '--task', task, '--family', entry.family, '--model', entry.path]
      : ['--list-loaders', '--json']
    return (await this.run(binary, args, signal, PROBE_TIMEOUT_MS)).slice(0, 30000)
  }

  async transcribe(input: string, signal?: AbortSignal, expectedRoute?: 'local' | 'remote'): Promise<string> {
    const release = this.acquireInference()
    try { return await this.transcribeImpl(input, signal, expectedRoute) } finally { release() }
  }

  private async transcribeImpl(input: string, signal?: AbortSignal, expectedRoute?: 'local' | 'remote'): Promise<string> {
    const config = await this.read()
    if (expectedRoute && (config.routes?.asr ?? 'local') !== expectedRoute) throw new Error('ASR route changed; retry after reviewing audio settings')
    if (config.routes?.asr === 'remote') {
      if (!config.remoteAsr) throw new Error('Remote ASR is not configured')
      return this.remote.transcribe(config.remoteAsr, await existingFile(input), signal)
    }
    const { binary, entry } = await this.ready('asr')
    const source = await existingFile(input)
    if (extname(source).toLowerCase() !== '.wav') throw new TypeError('audio.cpp CLI requires WAV; convert to WAV before ASR')
    await mkdir(this.tempPath, { recursive: true })
    const directory = await mkdtemp(join(this.tempPath, 'audio-cpp-'))
    const output = join(directory, 'transcript.txt')
    try {
      await this.run(binary, ['--task', 'asr', '--family', entry.family, '--model', entry.path,
        '--backend', entry.backend, '--audio', source, '--text-out', output, ...entry.options], signal)
      return await readFile(output, 'utf8')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  /** Snapshot the selected local SenseVoice configuration for partials AND final correction. */
  async openTranscriptionStream(signal: AbortSignal, partial: (delta: string) => void) {
    const unlock = this.acquireInference()
    try {
      const opened = await this.openTranscriptionStreamImpl(signal, partial)
      let correction: Promise<string> | undefined
      let released = false
      const release = async () => {
        await opened.stream.closed.catch(() => {})
        await correction?.catch(() => {})
        if (!released) { released = true; unlock() }
      }
      return { stream: opened.stream, correct: (input: string) => {
        if (released || correction) throw new Error('Audio correction already finished or started')
        correction = opened.correct(input)
        return correction
      }, release }
    } catch (error) { unlock(); throw error }
  }

  private async openTranscriptionStreamImpl(signal: AbortSignal, partial: (delta: string) => void) {
    const config = await this.read()
    if (config.routes?.asr === 'remote') throw new Error('Streaming requires the selected local ASR route')
    const binary = await this.binary(config)
    const entry = config.asr
    if (!binary || !entry || entry.family !== 'sense_asr') throw new Error('Streaming requires installed local sense_asr')
    await access(entry.path, constants.R_OK)
    validateOptions(entry.options)
    // Own all transport and chunking flags; the offline configuration often selects chunk-mode none.
    const options: string[] = []
    for (let i = 0; i < entry.options.length; i++) {
      const arg = entry.options[i]
      if (['--audio-chunk-mode', '--audio-chunk-seconds'].includes(arg.split('=')[0])) {
        if (!arg.includes('=')) i++
        continue
      }
      if (['--mode', '--input-format', '--input-rate', '--input-channels', '--log', '--segments-out', '--vad-chunks-out', '--turns-out', '--words-out', '--batch-manifest-out', '--batch-text-file'].includes(arg.split('=')[0])) {
        throw new Error('Configured options are incompatible with streaming ingress')
      }
      options.push(arg)
    }
    const base = ['--task', 'asr', '--family', entry.family, '--model', entry.path, '--backend', entry.backend]
    const stream = openCliStream(binary, [...base, ...options, '--mode', 'streaming', '--audio', '-',
      '--input-format', 's16le', '--input-rate', '16000', '--input-channels', '1',
      '--audio-chunk-mode', 'fixed', '--audio-chunk-seconds', '3'], signal, partial)
    return {
      stream,
      correct: async (input: string): Promise<string> => {
        signal.throwIfAborted()
        // Refuse a changed route/model rather than silently using stale or remote settings.
        const current = await this.read()
        if (JSON.stringify(current) !== JSON.stringify(config)) throw new Error('Audio configuration changed during capture')
        await mkdir(this.tempPath, { recursive: true })
        const directory = await mkdtemp(join(this.tempPath, 'audio-final-'))
        const output = join(directory, 'transcript.txt')
        try {
          await this.run(binary, [...base, '--audio', await existingFile(input), '--text-out', output, ...entry.options], signal, 120_000)
          return await readFile(output, 'utf8')
        } finally { await rm(directory, { recursive: true, force: true }) }
      },
    }
  }

  async speak(text: string, output: string, signal?: AbortSignal): Promise<string> {
    const release = this.acquireInference()
    try { return await this.speakImpl(text, output, signal) } finally { release() }
  }

  private async speakImpl(text: string, output: string, signal?: AbortSignal): Promise<string> {
    if (!text.trim() || text.length > 8000) throw new TypeError('Text must be 1..8000 characters')
    if (extname(output).toLowerCase() !== '.wav') throw new TypeError('TTS output must be a .wav file')
    try {
      await access(output)
      throw new Error(`Output already exists: ${output}`)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    let ownsOutput = false
    try {
      const config = await this.read()
      if (config.routes?.tts === 'remote') {
        if (!config.remoteTts) throw new Error('Remote TTS is not configured')
        const audio = await this.remote.speak(config.remoteTts, text, signal)
        const destination = await open(output, 'wx', 0o600)
        ownsOutput = true
        try { await destination.writeFile(audio) } finally { await destination.close() }
      } else {
        const { binary, entry } = await this.ready('tts')
        ownsOutput = true
        await this.run(binary, ['--task', 'tts', '--family', entry.family, '--model', entry.path,
          '--backend', entry.backend, '--text', text, '--out', output, ...entry.options], signal)
      }
      const file = await open(output, 'r')
      try {
        const header = Buffer.alloc(12)
        const { bytesRead } = await file.read(header, 0, header.length, 0)
        if (bytesRead !== header.length || header.toString('ascii', 0, 4) !== 'RIFF'
          || header.toString('ascii', 8, 12) !== 'WAVE' || (await file.stat()).size <= 44) {
          throw new Error('audio.cpp exited without producing a valid WAV')
        }
      } finally {
        await file.close()
      }
      return output
    } catch (error) {
      if (ownsOutput) await rm(output, { force: true }).catch(cleanupError => {
        throw new AggregateError([error, cleanupError], 'audio.cpp failed and partial WAV could not be removed')
      })
      throw error
    }
  }

  private async ready(task: Task): Promise<{ binary: string; entry: z.infer<typeof model> }> {
    const config = await this.read()
    const binary = await this.binary(config)
    if (!binary) throw new Error('audio.cpp CLI not installed; read v:skills/audio-cpp')
    const entry = config[task]
    if (!entry) throw new Error(`${task.toUpperCase()} model is not configured; read v:skills/audio-cpp`)
    await access(entry.path, constants.R_OK)
    return { binary, entry }
  }
}
