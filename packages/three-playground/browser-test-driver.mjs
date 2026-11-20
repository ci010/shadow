import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// A real Chromium target exercises both worker startup and inherited CSP. No
// test-only settings that weaken browser security are passed to the executable.
export async function launchBrowser(executable) {
  const bundle = (await build({
    absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
    stdin: { contents: `import { buildPlayground } from './index.ts';
      globalThis.runBuild = async ({files, assets, timeoutMs, cancelAfter, mutateInputs}) => {
        const controller = new AbortController();
        const timer = cancelAfter === undefined ? undefined : setTimeout(() => controller.abort(), cancelAfter);
        let output;
        try {
          const snapshot = { files, assets: Object.fromEntries(Object.entries(assets).map(([name, bytes]) => [name, Uint8Array.from(bytes).buffer])) };
          const pending = buildPlayground(snapshot, {timeoutMs, signal: controller.signal});
          if (mutateInputs) {
            files['main.mjs'] = 'throw new Error("newer edit")';
            for (const data of Object.values(snapshot.assets)) new Uint8Array(data).fill(4);
          }
          const { glb, objectCount } = await pending;
          output = { bytes: Array.from(new Uint8Array(glb)), objectCount };
        } catch (e) { output = { error: { name: e.name, message: e.message, phase: e.phase, guestStack: e.guestStack } }; }
        finally { clearTimeout(timer); }
        return { ...output, frameCount: document.querySelectorAll('iframe').length };
      };`, resolveDir: fileURLToPath(new URL('.', import.meta.url)) },
    bundle: true, write: false, platform: 'browser', format: 'iife',
  })).outputFiles[0].contents;
  const profile = await mkdtemp(join(tmpdir(), 'shadow-playground-'));
  let leaked = 0;
  const server = createServer((request, response) => {
    if (request.url === '/') response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><script src="/test.js"></script>');
    else if (request.url === '/test.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle);
    else if (request.url?.startsWith('/sentinel')) { leaked++; response.end('export {};'); }
    else response.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = spawn(executable, ['--headless', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', origin], { stdio: 'ignore' });
  let spawnError, socket;
  browser.on('error', error => { spawnError = error; });
  async function close() {
    socket?.close();
    if (browser.pid && browser.exitCode === null && browser.signalCode === null) {
      const stopped = once(browser, 'exit');
      browser.kill();
      await stopped;
    }
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  }
  try {
    let target;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError) throw spawnError;
      if (browser.exitCode !== null) throw new Error(`Chromium exited: ${browser.exitCode}`);
      try {
        const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
        const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = pages.find(page => page.url === `${origin}/`);
        if (target) break;
      } catch { /* Chromium is still starting. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!target) throw new Error('Chromium test target did not start');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let seq = 0;
    async function evaluate(expression) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const onMessage = ({ data }) => {
          const message = JSON.parse(data);
          if (message.id !== id) return;
          clearTimeout(timer);
          socket.removeEventListener('message', onMessage);
          if (message.error || message.result.exceptionDetails) reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
          else resolve(message.result.result.value);
        };
        const timer = setTimeout(() => {
          socket.removeEventListener('message', onMessage);
          reject(new Error('Browser evaluation did not settle'));
        }, 15000);
        socket.addEventListener('message', onMessage);
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      });
    }
    let ready;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = await evaluate(`typeof globalThis.runBuild === 'function'`); }
      catch (error) { if (!error.message.includes('context')) throw error; }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error('Chromium test page did not initialize');
    return { close, origin, leaked: () => leaked, run: data => evaluate(`runBuild(${JSON.stringify(data)})`) };
  } catch (error) {
    await close();
    throw error;
  }
}
