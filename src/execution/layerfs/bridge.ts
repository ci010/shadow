import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { ToolOutcomeUnknownError } from '../../tools/tool.ts'

export const layerfsName = (project: string) => `shadow-${createHash('sha256').update(project).digest('hex').slice(0, 40)}`
const allowedEnvironment = new Set(['LAYERFS_HOME', 'LAYERFS_STORE_PATH', 'LAYERFS_DOCKER', 'LAYERFS_IMAGE', 'LAYERFS_VOLUME', 'LAYERFS_DAEMON', 'LAYERFS_NATIVE', 'LAYERFS_WORKER_ENDPOINT', 'LAYERFS_CONTAINER_PREFIX', 'LAYERFS_DAEMON_HOST', 'LAYERFS_STORE_POLICY'])
export interface LayerConfig { sdkModule: string; env: Record<string, string> }
export async function configuration(project: string): Promise<LayerConfig> {
  const path = process.env.SHADOW_LAYERFS_CONFIG
  if (!path || !isAbsolute(path)) throw new Error('LayerFS disabled: SHADOW_LAYERFS_CONFIG must name an absolute operator-owned JSON file.')
  const projects = JSON.parse(await readFile(path, 'utf8'))?.projects
  const config = projects?.[project]
  if (config?.env) for (const [id, other] of Object.entries(projects) as Array<[string, { env?: Record<string, string> }]>) {
    if (id === project) continue
    for (const key of ['LAYERFS_HOME', 'LAYERFS_STORE_PATH', 'LAYERFS_VOLUME']) {
      if (config.env[key] && config.env[key] === other.env?.[key]) throw new Error(`LayerFS Projects must not share ${key}.`)
    }
  }
  if (!config || !isAbsolute(config.sdkModule ?? '') || !config.env || typeof config.env !== 'object') throw new Error('No explicit LayerFS SDK/environment configuration for this Project.')
  for (const [key, value] of Object.entries(config.env)) {
    if (!allowedEnvironment.has(key) || typeof value !== 'string') throw new Error('Invalid LayerFS environment setting.')
  }
  if (!config.env.LAYERFS_HOME || !config.env.LAYERFS_STORE_PATH) throw new Error('Explicit private LAYERFS_HOME and LAYERFS_STORE_PATH are required.')
  if (process.platform !== 'linux' && !config.env.LAYERFS_WORKER_ENDPOINT) throw new Error('LayerFS requires a provisioned Linux worker (Docker on macOS, WSL on Windows).')
  return config
}

// A fresh process prevents the SDK singleton/environment/worker binding from crossing Projects.
// Never retry a call: killing a bridge does not prove that the daemon stopped its operation.
export const runner = String.raw`
import { pathToFileURL } from 'node:url';
import { Writable } from 'node:stream';
async function execute(client, ws, command, message) {
 const captured = {}; const sinks = {};
 for (const name of ['stdout', 'stderr']) {
   const chunks = []; let size = 0;
   sinks[name] = new Writable({ write(chunk, encoding, done) { const take = Math.max(0, 65536 - size); if (take) chunks.push(Buffer.from(chunk.subarray(0, take))); size += chunk.length; done(); } });
   captured[name] = () => ({ text: message === '__shadow_utf8_read__' && name === 'stdout' ? new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) : Buffer.concat(chunks).toString('utf8'), bytes: size, truncated: size > 65536 });
 }
 const receipt = await client.workspace.exec(ws, command, message, sinks);
 return { ...receipt, stdout: captured.stdout(), stderr: captured.stderr() };
}
let input = ''; for await (const chunk of process.stdin) input += chunk;
const { sdkModule, project, action, args: a } = JSON.parse(input);
let client;
try {
 const { LayerFS } = await import(pathToFileURL(sdkModule).href);
 client = action === 'create' ? await LayerFS.init(project, a.source, 300000) : await LayerFS.open(project);
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
 case 'exec': result = await execute(client, ws, a.command, a.message); break;
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
finally { if (client) await client.close(); }
`

export function runBridge(config: LayerConfig, project: string, action: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs = 330000): Promise<string> {
  signal.throwIfAborted()
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LAYERFS_')))
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', runner], { env: { ...env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', bytes = 0, settled = false
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); if (error) { child.kill(); reject(error) } else resolve(output) }
    const unknown = (reason: string) => finish(new ToolOutcomeUnknownError(`LayerFS outcome unknown (${reason}); inspect status/history before any manual retry. Daemon work may continue.`))
    const abort = () => unknown('cancelled')
    const timer = setTimeout(() => unknown('deadline'), timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data: Buffer) => {
      bytes += data.length
      if (bytes > 1024 * 1024) return unknown('output exceeds 1 MiB')
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
    child.stdin.on('error', () => unknown('bridge input failure'))
    child.stdin.end(JSON.stringify({ sdkModule: config.sdkModule, project, action, args }))
    if (signal.aborted) abort()
  })
}
