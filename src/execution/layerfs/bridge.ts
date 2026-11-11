import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { ToolNoEffectError, ToolOutcomeUnknownError } from '../../tools/tool.ts'
import { IMPORT_TIMEOUT, importTimeoutMs } from './import-timeout.ts'

export const layerfsName = (project: string) => `shadow-${createHash('sha256').update(project).digest('hex').slice(0, 40)}`
const allowedEnvironment = new Set(['LAYERFS_HOME', 'LAYERFS_STORE_PATH', 'LAYERFS_DOCKER', 'LAYERFS_IMAGE', 'LAYERFS_VOLUME', 'LAYERFS_DAEMON', 'LAYERFS_NATIVE', 'LAYERFS_WORKER_ENDPOINT', 'LAYERFS_CONTAINER_PREFIX', 'LAYERFS_DAEMON_HOST', 'LAYERFS_STORE_POLICY'])
export interface LayerConfig { sdkModule: string; env: Record<string, string> }
export class LayerFSConfigurationError extends ToolNoEffectError {
  constructor(readonly code: string, message: string) {
    super(`${message} No SDK or worker was started. Ask the operator to configure LayerFS for this Project in the Shadow backend; read v:skills/layerfs/setup.md. Installing or updating Shadow alone does not provision LayerFS.`)
    this.name = 'LayerFSConfigurationError'
  }
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
export async function configuration(project: string): Promise<LayerConfig> {
  const path = process.env.SHADOW_LAYERFS_CONFIG
  if (!path) throw new LayerFSConfigurationError('CONFIG_NOT_SET', 'LayerFS disabled: SHADOW_LAYERFS_CONFIG is not set; it must name an absolute operator-owned JSON file in the backend environment.')
  if (!isAbsolute(path)) throw new LayerFSConfigurationError('CONFIG_PATH_INVALID', 'SHADOW_LAYERFS_CONFIG must name an absolute operator-owned JSON file.')
  let text: string
  try { text = await readFile(path, 'utf8') } catch {
    throw new LayerFSConfigurationError('CONFIG_UNREADABLE', 'The operator-configured LayerFS JSON file could not be read.')
  }
  let document: unknown
  try { document = JSON.parse(text) } catch {
    // JSON parser diagnostics may include configuration bytes; never return them.
    throw new LayerFSConfigurationError('CONFIG_INVALID', 'The operator-configured LayerFS file is not valid JSON.')
  }
  if (!record(document) || !record(document.projects)) throw new LayerFSConfigurationError('CONFIG_INVALID', 'LayerFS configuration requires a projects object.')
  const projects = document.projects
  if (!Object.hasOwn(projects, project)) throw new LayerFSConfigurationError('PROJECT_NOT_CONFIGURED', 'No explicit LayerFS SDK/environment configuration for this Project.')
  const config = projects[project]
  if (!record(config) || typeof config.sdkModule !== 'string' || !isAbsolute(config.sdkModule) || !record(config.env)) throw new LayerFSConfigurationError('CONFIG_INVALID', 'LayerFS requires an absolute SDK module path and an environment object for this Project.')
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(config.env)) {
    if (!allowedEnvironment.has(key) || typeof value !== 'string') throw new LayerFSConfigurationError('CONFIG_INVALID', 'Invalid LayerFS environment setting.')
    env[key] = value
  }
  if (!env.LAYERFS_HOME || !env.LAYERFS_STORE_PATH) throw new LayerFSConfigurationError('CONFIG_INVALID', 'Explicit private LAYERFS_HOME and LAYERFS_STORE_PATH are required.')
  for (const [id, other] of Object.entries(projects)) {
    if (id === project) continue
    if (!record(other) || !record(other.env)) throw new LayerFSConfigurationError('CONFIG_INVALID', 'Each configured LayerFS Project requires an environment object.')
    for (const key of ['LAYERFS_HOME', 'LAYERFS_STORE_PATH', 'LAYERFS_VOLUME']) {
      if (env[key] && env[key] === other.env[key]) throw new LayerFSConfigurationError('PROJECT_STORAGE_SHARED', `LayerFS Projects must not share ${key}.`)
    }
  }
  if (process.platform !== 'linux' && !env.LAYERFS_WORKER_ENDPOINT) throw new LayerFSConfigurationError('WORKER_REQUIRED', 'LayerFS requires a provisioned Linux worker (Docker on macOS, WSL on Windows).')
  return { sdkModule: config.sdkModule, env }
}

// A fresh process prevents the SDK singleton/environment/worker binding from crossing Projects.
// Never retry a call: killing a bridge does not prove that the daemon stopped its operation.
export const runner = String.raw`
import { pathToFileURL } from 'node:url';
import { Writable } from 'node:stream';
async function execute(client, ws, command, message, requestedLimit) {
 const outputLimit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 && requestedLimit <= 8388608 ? requestedLimit : 65536;
 const captured = {}; const sinks = {};
 for (const name of ['stdout', 'stderr']) {
   const chunks = []; let size = 0;
   sinks[name] = new Writable({ write(chunk, encoding, done) { const take = Math.max(0, outputLimit - size); if (take) chunks.push(Buffer.from(chunk.subarray(0, take))); size += chunk.length; if (a.managedExec && process.connected) { process.send?.({type:'output', text: Buffer.from(chunk.subarray(Math.max(0, chunk.length - 65536))).toString('utf8')}, () => done()); } else done(); } });
   captured[name] = () => ({ text: message === '__shadow_utf8_read__' && name === 'stdout' ? new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) : Buffer.concat(chunks).toString('utf8'), bytes: size, truncated: size > outputLimit });
 }
 const receipt = await client.workspace.exec(ws, command, message, sinks);
 return { ...receipt, stdout: captured.stdout(), stderr: captured.stderr() };
}
let input = ''; for await (const chunk of process.stdin) input += chunk;
const { sdkModule, project, action, args: a } = JSON.parse(input);
// Liveness only: a heartbeat does not claim that native Init is progressing.
const beat = () => { if (process.connected) process.send?.({ type: 'layerfs-import-heartbeat' }, () => {}); };
const heartbeat = action === 'create' ? setInterval(beat, ${IMPORT_TIMEOUT.heartbeatMs}) : undefined;
if (heartbeat) beat();
let cancelRequested = false;
process.on('message', msg => { if (msg?.type === 'cancel') cancelRequested = true; });
let client;
try {
 const { LayerFS } = await import(pathToFileURL(sdkModule).href);
 client = action === 'create' ? await LayerFS.init(project, a.source, a.importTimeoutMs) : await LayerFS.open(project);
 const ws = ['status', 'read', 'write', 'exec', 'commit', 'close'].includes(action) ? JSON.parse(Buffer.from(a.workspace.replace(/^layerfs:/, ''), 'base64url').toString()) : undefined;
 let result;
 switch(action) {
 case 'create': result = client.created; break;
 case 'list': result = await client.project.list_sandboxes(100, a.offset || 0); break;
 case 'branches': result = await client.project.list_branches(100, a.offset || 0); break;
 case 'history': result = await client.branch.list_commits(a.branch, 100, a.offset || 0); break;
 case 'fork': case 'load': result = await client.branch.fork(a.branch, a.ref); break;
 case 'mount': {
   const { sandbox } = await client.sandbox.create();
   // If mount fails, retain the sandbox for inspection; do not blindly repeat create.
   const mounted = await client.workspace.mount(sandbox, a.branch);
   result = { ...mounted, workspace: 'layerfs:' + Buffer.from(JSON.stringify({ project, sandbox: mounted.sandbox, path: mounted.path })).toString('base64url'), routing: 'Pass workspace to ordinary read/write/exec; path is inside the sandbox, never a host cwd.' }; break;
 }
 case 'status': result = await client.sandbox.list_workspaces(ws.sandbox, 100, 0); break;
 case 'exec': {
   let command = a.command;
   if (a.managedExec) {
     const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
     const dir = '/tmp/shadow-exec-' + a.execToken;
     // No host PID is used. The session leader kills its OWN group on a token
     // marker. The marker may arrive before startup; it is never cleared.
     const supervisor = 'while :; do if [ -f ' + quote(dir + '/cancel') + ' ]; then kill -KILL 0; exit 125; fi; sleep 0.05; done';
     command = 'for helper in setsid sh sleep kill mkdir cat rm; do command -v "$helper" >/dev/null || exit 126; done; setsid -w sh -c true || exit 126; umask 077; mkdir -p ' + quote(dir) + ' || exit 126; setsid -w sh -c ' + quote(supervisor + ' & sh -c ' + quote(command) + '; code=$?; printf %s "$code" > ' + quote(dir + '/exit') + '; kill -KILL 0') + '; if [ -f ' + quote(dir + '/exit') + ' ]; then code=$(cat ' + quote(dir + '/exit') + '); else code=137; fi; rm -rf -- ' + quote(dir) + '; exit "$code"';
     const cancelCommand = async msg => {
       if (msg?.type !== 'cancel') return;
       try {
         const r = await execute(client, ws, 'umask 077; mkdir -p ' + quote(dir) + ' && : > ' + quote(dir + '/cancel'), undefined, 1024);
         if ((r.code ?? r.exitCode) !== 0) throw Error('cancel marker refused');
       } catch { process.send?.({type:'cancel-unknown'}); }
     };
     process.on('message', cancelCommand);
     if (cancelRequested) void cancelCommand({type:'cancel'});
   }
   result = await execute(client, ws, command, a.message, a.captureLimit); break;
 }
 case 'read': case 'write': {
   const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
   const path = './' + a.path.replace(/^\//, '');
   const command = action === 'read' ? 'test -f ' + quote(path) + ' && (test ! -s ' + quote(path) + ' || grep -Iq . ' + quote(path) + ') && sed -n ' + quote(a.start + ',' + a.end + 'p') + ' ' + quote(path) : 'mkdir -p -- ' + quote(path.slice(0, path.lastIndexOf('/')) || '.') + ' && printf %s ' + quote(a.content) + ' > ' + quote(path);
   result = await execute(client, ws, command, action === 'read' ? '__shadow_utf8_read__' : a.message); break;
 }
 case 'commit': result = await client.workspace.commit(ws, a.message); break;
 case 'close': result = await client.workspace.unmount(ws, false, false); break;
 case 'diff': result = await client.branch.diff_branches(a.ref, a.branch, 100, a.offset || 0, { hunks: false }); break;
 case 'merge': result = await client.branch.merge(a.ref, a.branch, a.name, a.message); break;
 case 'publish': result = await client.branch.publish(a.branch, a.ref); break;
 default: throw new Error('Unsupported action');
 }
 console.log(JSON.stringify({ ok: true, result }));
} catch(e) { console.log(JSON.stringify({ ok: false, error: { message: String(e.message || e), code: e.code, detail: e.detail } })); }
finally {
 try { if (client) await client.close(); }
 finally { clearInterval(heartbeat); if (process.connected) process.disconnect(); }
}
`

/** For create, timeoutMs is a helper-silence watchdog, not an Init budget.
 * Managed ordinary exec has no receipt deadline: ExecTool owns its wait window
 * and BackgroundTaskManager owns the same promise after transfer. Other
 * operations retain their existing wall-clock receipt timeout.
 */
export function runBridge(config: LayerConfig, project: string, action: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs = action === 'create' ? IMPORT_TIMEOUT.silenceMs : 330000, lifecycle?: { observe: (text: string) => void }): Promise<string> {
  signal.throwIfAborted()
  if (lifecycle) args = { ...args, managedExec: true, execToken: randomUUID() }
  if (action === 'create') args = { ...args, importTimeoutMs: importTimeoutMs(args.importTimeoutMs) }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LAYERFS_')))
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', runner], { env: { ...env, ...config.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: action === 'create' || lifecycle ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'] })
    let output = '', bytes = 0, settled = false
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); if (error) { child.kill(); reject(error) } else resolve(output) }
    const unknown = (reason: string) => finish(new ToolOutcomeUnknownError(`LayerFS outcome unknown (${reason}); inspect status/history before any manual retry. Daemon work may continue.`))
    const abort = () => {
      if (!lifecycle) return unknown('cancelled')
      if (settled) return
      timer = setTimeout(() => unknown('sandbox cancellation not confirmed'), 10000)
      child.send({ type: 'cancel' }, error => { if (error) unknown('cancellation transport failed') })
    }
    let timer = lifecycle ? undefined : setTimeout(() => unknown(action === 'create' ? 'import helper heartbeat lost' : 'deadline'), timeoutMs)
    child.on('message', message => {
      if (lifecycle && message && typeof message === 'object') {
        const m = message as { type?: string; text?: string };
        if (m.type === 'output' && typeof m.text === 'string') lifecycle.observe(m.text);
        if (m.type === 'cancel-unknown') unknown('sandbox cancellation marker failed');
      }
      if (!settled && action === 'create' && message && typeof message === 'object'
        && Object.keys(message).length === 1 && (message as { type?: unknown }).type === 'layerfs-import-heartbeat') timer?.refresh()
    })
    signal.addEventListener('abort', abort, { once: true })
    for (const stream of [child.stdout!, child.stderr!]) stream.on('data', (data: Buffer) => {
      bytes += data.length
      if (bytes > (Number.isSafeInteger(args.captureLimit) && Number(args.captureLimit) > 65536 && Number(args.captureLimit) <= 8388608 ? 16 * 1024 * 1024 : 1024 * 1024)) return unknown('output exceeds protocol limit')
      if (stream === child.stdout) output += data.toString()
    })
    child.on('error', () => unknown('bridge process failure'))
    child.on('close', code => { if (code !== 0 || !output.trim()) unknown('bridge exited without receipt'); else {
      try {
        const receipt = JSON.parse(output)
        if (typeof receipt.ok !== 'boolean') return unknown('invalid receipt')
        if (receipt.error?.code === 'Unknown') return unknown('SDK reported Unknown')
        finish()
      } catch { unknown('invalid bridge output') }
    } })
    child.stdin!.on('error', () => unknown('bridge input failure'))
    child.stdin!.end(JSON.stringify({ sdkModule: config.sdkModule, project, action, args }))
    if (signal.aborted) abort()
  })
}
