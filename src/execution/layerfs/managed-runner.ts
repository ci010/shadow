import { IMPORT_TIMEOUT } from './import-timeout.ts'
import { importStageScript } from './import-stage.ts'
import { importRefusal } from './import-diagnostic.ts'

// A separate process owns the upstream singleton and the WSL worker for one Project.
// This uses the pinned 73d974d public Runtime API, never a shell installer or sweep.
export const managedRunner = String.raw`
import { pathToFileURL } from 'node:url';
import { join, posix } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const stageScript = ${JSON.stringify(importStageScript)};
const refusal = ${importRefusal.toString()};
async function stageSource(source, policy) {
 if (process.platform !== 'win32') fail('UnsupportedManagedImportPlatform');
 const s = deployment.settings;
 const namespace = /^\/var\/lib\/shadow-layerfs\/([a-f0-9]{32})$/.exec(s.wsl.home)?.[1];
 if (!namespace || !/^[A-Za-z]:[\\/]/.test(source)) fail('StageRefused');
 const { stdout } = await promisify(execFile)('wsl.exe', ['--distribution', s.wsl.distribution,
  '--exec', s.wsl.node, '--input-type=module', '-e', stageScript, source, namespace, policy ?? 'curated'],
  { windowsHide: true, timeout: 615000, maxBuffer: 4096 });
 const result = JSON.parse(stdout);
 if (!result || typeof result !== 'object' || Object.keys(result).length !== 1 || typeof result.destination !== 'string' || !new RegExp('^/var/tmp/shadow-layerfs-stage-' + namespace + '-[a-f0-9]{32}/source$').test(result.destination)) fail('StageRefused');
 return '\\\\wsl.localhost\\' + s.wsl.distribution + result.destination.replaceAll('/', '\\');
}
const importTimeout = ${JSON.stringify(IMPORT_TIMEOUT)};
let runtime, deployment, importState, healthQuery;
let queue = Promise.resolve(), queued = 0;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const safeCode = error => /Project\(Deadline\)/.test(String(error?.message || '')) ? 'ImportDeadline'
 : /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error?.code || '') ? error.code : 'Unknown';
const counts = value => {
 const result = {};
 for (const key of ['entries', 'files', 'bytes']) if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) result[key] = value[key];
 return result;
};
const snapshot = () => importState ? { ...importState, elapsedMs: Math.max(0, (importState.endedAt ?? Date.now()) - importState.startedAt) } : { stage: 'not_started' };
const unchecked = () => ({ worker: 'unknown', answering: false, docker: 'unknown', ready: false,
 sandboxVerified: false, health: 'not_checked', ...(importState ? { operation: snapshot() } : {}) });
async function execute(action, input, progress) {
 if (action === 'open') {
  if (runtime) fail('AlreadyOpen');
  deployment = input;
  const { LayerFSRuntime } = await import(pathToFileURL(input.runtimeModule).href);
  runtime = await LayerFSRuntime.open(input.settings);
  await runtime.worker.start();
  return inspect();
 }
 if (!runtime) fail('NotConnected');
 if (action === 'create') {
  if (importState) fail('ImportAlreadyAttempted');
  const timeout = input.timeoutMs ?? importTimeout.defaultMs;
  if (!Number.isSafeInteger(timeout) || timeout < importTimeout.minMs || timeout > importTimeout.maxMs) fail('InvalidImportTimeout');
  importState = { stage: 'preparing', startedAt: Date.now() };
  const report = () => progress(snapshot());
  report();
  // Preparation/scan occurs BEFORE the SDK's own Init deadline. Heartbeats
  // attest only helper liveness, never completion or safety to repeat Init.
  const heartbeat = setInterval(report, importTimeout.heartbeatMs);
  let terminalFailure = false;
  try {
   const source = await stageSource(input.source, input.importPolicy);
   const job = await runtime.project.start_init(deployment.project, source, { timeout });
   if (typeof job?.id !== 'string' || !job.id || job.id.length > 128) fail('Unknown');
   importState.jobId = job.id;
   for (;;) {
    const state = await runtime.project.get_init(job.id);
    if (!state) fail('Unknown');
    const stage = ['scan', 'volume', 'import', 'done', 'failed'].includes(state.step) ? state.step : 'unknown';
    importState = { ...importState, stage, scanned: counts(state.scanned), totals: counts(state.totals), imported: counts(state.imported) };
    if (state.step === 'done' || state.step === 'failed') importState.endedAt = Date.now();
    if (state.step === 'failed') { terminalFailure = true; const diagnostic = refusal(state.error, source); if (diagnostic) importState.refusal = diagnostic; importState.code = safeCode(state.error); report(); fail(importState.code); }
    report();
    if (state.step === 'done') return { kind: 'Initialized', project: deployment.project };
    await pause(250);
   }
  } catch (error) {
   if (terminalFailure) importState = { ...importState, stage: 'failed', endedAt: Date.now(), code: safeCode(error) };
   else {
    // Missing job state or a lost observation does not prove the import ended.
    importState = { ...importState, stage: 'unknown', code: safeCode(error) };
    delete importState.endedAt;
   }
   report();
   if (!terminalFailure) fail('Unknown');
   throw error;
  } finally { clearInterval(heartbeat); }
 }
 if (action === 'configuration') {
  const project = (await runtime.project.list()).find(p => p.name === deployment.project);
  if (!project?.initialized || !project.volume) fail('NotInitialized');
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
 if (action === 'close') { await runtime.close(); return { closed: true }; }
 fail('InvalidAction');
}
async function inspect() {
 const s = await runtime.status();
 // Never return endpoint secrets, SDK errors, logs, arbitrary Docker output or paths.
 return { worker: s.worker?.state === 'running' ? 'running' : 'unknown', answering: s.worker?.answering === true,
  docker: s.docker?.level === 'ok' ? 'ok' : 'down',
  ready: s.worker?.answering === true && s.docker?.level === 'ok', sandboxVerified: false,
  ...(Number.isSafeInteger(s.worker?.active) && s.worker.active >= 0 ? { activeCalls: s.worker.active } : {}),
  ...(importState ? { operation: snapshot() } : {}) };
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
 const { id, action, input } = message;
 // These paths never start workers or admit another Init.
 if (action === 'import_status') { send({ id, ok: true, result: snapshot() }); return; }
 if (action === 'status') {
  void status().then(result => send({ id, ok: true, result }), () => send({ id, ok: true, result: unchecked() }));
  return;
 }
 queued++;
 queue = queue.then(async () => {
  try { const result = await execute(action, input, progress => send({ id, progress })); send({ id, ok: true, result }); }
  catch (error) { send({ id, ok: false, code: safeCode(error) }); }
  finally { queued--; }
 });
});
process.on('disconnect', () => {
 void queue.then(async () => { if (runtime) await runtime.close(); }).then(() => process.exit(0), () => process.exit(1));
});
`
