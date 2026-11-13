
// A separate process owns the upstream singleton and the WSL worker for one Project.
// This uses the pinned 73d974d public Runtime API, never a shell installer or sweep.
import { nativeSourceProbe } from './native-source.ts'

export const managedRunner = `const nativeSourceProbe = ${JSON.stringify(nativeSourceProbe)};\n` + String.raw`
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
let execServer;
const execProfiles = new Map();
async function execContext(input) {
 if (!execServer) {
 execServer = createServer(async (req, res) => {
  const respond = (status, value) => { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(value)); };
  const token = req.headers.authorization?.replace(/^Bearer /,'');
  if (req.method !== 'POST' || !execProfiles.has(token)) { respond(403, {ok:false,code:'Unauthorized'}); return; }
  try {
   let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 65536) fail('RequestTooLarge'); }
   const {action,input} = JSON.parse(body);
   if (!['official_project','configuration'].includes(action)) fail('InvalidAction');
   const result = await execute(action,input,execProfiles.get(token));
   respond(200,{ok:true,result});
  } catch(error) { respond(400,{ok:false,code:safeCode(error),message:String(error?.message ?? 'SDK call failed').replaceAll(token,'[redacted]').slice(0,4096)}); }
 });
 await new Promise((resolve,reject) => { execServer.once('error',reject); execServer.listen(0,'127.0.0.1',resolve); });
 }
 const token = randomBytes(32).toString('hex');
 execProfiles.set(token,input?.sourceToken);
 return {port:execServer.address().port,token,sdkModule:deployment.sdkModule};
}
import { join, posix } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
async function sourceIdentity(input) {
 if (!runtime || !/^\/var\/lib\/shadow-layerfs-sources\/[a-f0-9]{64}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input?.path)) fail('SourceScopeRequired');
 const w = deployment.settings.wsl;
 const {stdout} = await promisify(execFile)('wsl.exe', ['--distribution',w.distribution,'--user','root','--exec',w.node,'-e',nativeSourceProbe,input.path], {windowsHide:true,timeout:8000,maxBuffer:65536});
 return JSON.parse(stdout);
}
import { mkdir, writeFile } from 'node:fs/promises';
let runtime, deployment, healthQuery;
const attemptedProjects = new Set();
let queue = Promise.resolve(), queued = 0;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const safeCode = error => /Project\(Deadline\)/.test(String(error?.message || '')) ? 'ImportDeadline'
 : /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error?.code || '') ? error.code : 'Unknown';
const unchecked = () => ({ worker: 'unknown', answering: false, docker: 'unknown', ready: false,
 sandboxVerified: false, health: 'not_checked' });
const sourceChecks = new Map();
async function authorizeSource(token) {
 if (!token || !process.connected) fail('SourceScopeRequired');
 const id = randomBytes(16).toString('hex');
 return new Promise((resolve,reject) => {
  const timer = setTimeout(() => {sourceChecks.delete(id);reject(Object.assign(Error('Source authorization unavailable'),{code:'SourceScopeRequired'}));},10000);
  sourceChecks.set(id, message => {clearTimeout(timer);sourceChecks.delete(id);if(message.ok===true&&typeof message.source==='string')resolve(message.source);else reject(Object.assign(Error('Registered source binding changed or access refused'),{code:'SourceScopeRequired'}));});
  process.send({type:'authorize-source',id,token});
 });
}
async function execute(action, input, sourceToken) {
 if (action === 'open') {
  if (runtime) fail('AlreadyOpen');
  deployment = input;
  const { LayerFSRuntime } = await import(pathToFileURL(input.runtimeModule).href);
  runtime = await LayerFSRuntime.open(input.settings);
  await runtime.worker.start();
  return inspect();
 }
 if (!runtime) fail('NotConnected');
 if (action === 'context') return execContext(input);
 if (action === 'official_project') {
  const {method,args} = input ?? {};
  if (!Array.isArray(args)) fail('InvalidArguments');
  if (method === 'list' && args.length === 0) return runtime.project.list();
  if (method === 'get_init' && args.length === 1 && typeof args[0] === 'string') return runtime.project.get_init(args[0]);
  if (method !== 'start_init' || args.length !== 3) fail('InvalidMethod');
  const [name,source,options] = args;
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name) || typeof source !== 'string' || !source || source.includes('\0') || !options || Object.keys(options).some(k => !['image','timeout'].includes(k)) || !/^sha256:[a-f0-9]{64}$/.test(options.image) || !Number.isSafeInteger(options.timeout) || options.timeout < 1000) fail('InvalidArguments');
  if (source !== await authorizeSource(sourceToken)) fail('SourceScopeMismatch');
  if (attemptedProjects.has(name)) fail('ImportAlreadyAttempted');
  // Admission remains consumed even if the caller loses its response. No retry engine.
  attemptedProjects.add(name);
  const admissions = join(deployment.settings.home, 'shadow-init-admissions');
  await mkdir(admissions, {recursive:true,mode:0o700});
  try { await writeFile(join(admissions,name + '.json'), JSON.stringify({project:name}), {flag:'wx',mode:0o600}); }
  catch(error) { if (error.code === 'EEXIST') fail('ImportAlreadyAttempted'); throw error; }
  // Pinned Windows host prepare/scan uses node:fs and host node:path before
  // dispatching to WSL. Only transport the already-authorized Linux binding;
  // the official worker maps this same-distro UNC back to the original path.
  const distro = deployment.settings.wsl.distribution;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(distro) || !/^\/var\/lib\/shadow-layerfs-sources\/[a-f0-9]{64}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(source)) fail('SourceScopeRequired');
  const transportSource = '\\\\wsl.localhost\\' + distro + source.replaceAll('/', '\\');
  return runtime.project.start_init(name,transportSource,options);
 }
 if (action === 'configuration') {
  if (typeof input?.project !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.project)) fail('InvalidProject');
  const project = (await runtime.project.list()).find(p => p.name === input.project);
  if (!project?.initialized || !project.volume || !/^sha256:[a-f0-9]{64}$/.test(project.image)) fail('NotInitialized');
  const volume = (await runtime.volume.list()).find(v => v.name === project.volume);
  if (!volume || volume.owner !== 'this' || volume.project !== project.name || volume.live !== true) fail('ResourceOwnershipMismatch');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(project.volume)) fail('InvalidVolume');
  const s = deployment.settings;
  return { sdkModule: deployment.sdkModule, env: {
   LAYERFS_HOME: s.wsl.home, LAYERFS_DOCKER: '/var/run/docker.sock',
   LAYERFS_IMAGE: project.image || s.image, LAYERFS_DAEMON: posix.join(s.bundle, 'layerfs-daemon'),
   LAYERFS_VOLUME: project.volume,
   LAYERFS_STORE_PATH: '/var/lib/docker/volumes/' + project.volume + '/_data/global/store.sqlite',
   LAYERFS_CONTAINER_PREFIX: s.containerPrefix,
   LAYERFS_WORKER_ENDPOINT: join(s.home, 'worker', 'endpoint.json')
  } };
 }
 if (action === 'close') { await shutdown(); return { closed: true }; }
 fail('InvalidAction');
}
async function shutdown() {
 if (execServer) { const server=execServer;execServer=undefined;await new Promise(resolve=>server.close(resolve));execProfiles.clear(); }
 if (runtime) { const current=runtime;runtime=undefined;await current.close(); }
}
async function inspect() {
 const s = await runtime.status();
 // Never return endpoint secrets, SDK errors, logs, arbitrary Docker output or paths.
 return { worker: s.worker?.state === 'running' ? 'running' : 'unknown', answering: s.worker?.answering === true,
  docker: s.docker?.level === 'ok' ? 'ok' : 'down',
  ready: s.worker?.answering === true && s.docker?.level === 'ok', sandboxVerified: false,
  ...(Number.isSafeInteger(s.worker?.active) && s.worker.active >= 0 ? { activeCalls: s.worker.active } : {}) };
}
async function status() {
 // Diagnostics must not queue behind Init or probe partially initialized SDK state.
 if (queued || !runtime) return unchecked();
 healthQuery ??= inspect().finally(() => { healthQuery = undefined; });
 let timer;
 try { return await Promise.race([healthQuery, new Promise(resolve => { timer = setTimeout(() => resolve(unchecked()), 3000); })]); }
 finally { clearTimeout(timer); }
}
const send = message => { if (process.connected) process.send?.(message, () => {}); };
process.on('message', message => {
 if (message?.type === 'source-authorization') { sourceChecks.get(message.id)?.(message); return; }
 const { id, action, input } = message;
 // These paths never start workers or admit another Init.
 // Explicit initialized-project metadata is independent of another project's
 // Init queue. It cannot start a runtime or admit a mutation.
 if (action === 'configuration' && typeof input?.project === 'string') {
  void execute(action, input).then(result => send({ id, ok: true, result }), error => send({ id, ok: false, code: safeCode(error) }));
  return;
 }
 // Source reauthorization can occur while an Init HTTP call awaits its IPC
 // answer; it must not queue behind unrelated long-running SDK operations.
 if (action === 'source_identity') {
  void sourceIdentity(input).then(result => send({id,ok:true,result}), () => send({id,ok:false,code:'SourceScopeRequired'}));
  return;
 }
 if (action === 'status') {
  void status().then(result => send({ id, ok: true, result }), () => send({ id, ok: true, result: unchecked() }));
  return;
 }
 queued++;
 queue = queue.then(async () => {
  try { const result = await execute(action, input); send({ id, ok: true, result }); }
  catch (error) { send({ id, ok: false, code: safeCode(error) }); }
  finally { queued--; }
 });
});
process.on('disconnect', () => {
 void queue.then(shutdown).then(() => process.exit(0), () => process.exit(1));
});
`
