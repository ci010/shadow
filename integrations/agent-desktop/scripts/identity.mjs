// No desktop reads/actions: metadata plus native ABI/owner cleanup in an isolated Worker.
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
if (isMainThread) {
 const path = process.argv[2];
 if (!path) throw new Error('Pass the built .node path; this script never builds or enumerates');
 const worker = new Worker(new URL(import.meta.url), { workerData: resolve(path) });
 const timer = setTimeout(() => { console.error('Native no-UI probe timed out'); process.exit(2); }, 10000);
 worker.once('exit', () => clearTimeout(timer));
 worker.on('message', value => console.log(JSON.stringify(value)));
 worker.on('error', error => { console.error(error); process.exitCode = 1; });
 worker.on('exit', code => { if (code) process.exitCode = code; });
} else {
 const addon = createRequire(import.meta.url)(workerData);
 const value = JSON.parse(addon.identity());
 assert.equal(value.protocol, 1);
 assert.equal(value.backend, 'agent-desktop');
 assert.equal(value.revision, '5a2c9ad43e269164a8adc8978a733c40b1d38a8b');
 assert.equal(value.capabilities.input, true);
 assert.equal(value.capabilities.nodeBounds, true);
 assert.deepEqual(value.capabilities.actions, ["invoke", "set_value", "toggle", "select", "scroll", "click", "move", "drag", "wheel", "press_key", "type_text"]);
 assert.equal(value.capabilities.screenshot, true);
 assert.equal(value.capabilities.patch, "shadow-password-first-v4");
 assert.equal(value.capabilities.guard, "shadow-input-guard-v1");
 assert.equal(typeof addon.cancelInput, "function");
 // Deliberately impossible method: native dispatch rejects this BEFORE checking
 // desktop/targets or calling UIA. This only exercises the NAPI request ABI and
 // dedicated COM owner lifetime, not desktop observation or an input action.
 const rejected = JSON.parse(addon.request(JSON.stringify({ method: '__shadow_no_ui_probe__' })));
 assert.equal(rejected.error.code, 'unsupported_action');
 addon.cancelInput(); // Sticky cancellation only; no guard or input lease exists.
 const closed = JSON.parse(addon.request(JSON.stringify({ method: 'shutdown' })));
 assert.deepEqual(closed, { result: { released: true } });
 parentPort.postMessage({ ...value, noUiAbiProbe: 'passed', ownerShutdown: 'passed' });
}
