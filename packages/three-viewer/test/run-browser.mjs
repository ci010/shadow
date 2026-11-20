// Run from the repository root with CHROMIUM pointing to an installed Chromium binary.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

if (!process.env.CHROMIUM) throw new Error('Set CHROMIUM to the Chromium executable path');
const base = process.env.SHADOW_SESSION_DATA_DIR ?? tmpdir();
await mkdir(base, { recursive: true });
const scratch = await mkdtemp(join(base, 'three-viewer-test-'));
let browser, ws;
try {
  execFileSync('pnpm', ['exec', 'esbuild', 'packages/three-viewer/test/browser.ts', '--bundle', `--outfile=${join(scratch, 'smoke.js')}`], { stdio: 'inherit' });
  await writeFile(join(scratch, 'index.html'), '<body><canvas width="320" height="240"></canvas><pre></pre><script src="smoke.js"></script>');
  browser = spawn(process.env.CHROMIUM, ['--headless', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-first-run',
    `--user-data-dir=${join(scratch, 'profile')}`, '--remote-debugging-port=0', pathToFileURL(join(scratch, 'index.html')).href], { stdio: 'ignore' });
  const deadline = Date.now() + 20000;
  async function wait(fn) {
    while (Date.now() < deadline) {
      const value = await fn();
      if (value) return value;
      if (browser.exitCode !== null) throw new Error(`Chromium exited: ${browser.exitCode}`);
      await sleep(100);
    }
    throw new Error('Browser test timed out');
  }
  const port = await wait(() => readFile(join(scratch, 'profile', 'DevToolsActivePort'), 'utf8').then(s => s.split('\n')[0]).catch(() => undefined));
  const url = await wait(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json()).find(x => x.type === 'page')?.webSocketDebuggerUrl);
  ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const result = await wait(() => new Promise((resolve, reject) => {
    const request = ++id;
    const timer = setTimeout(() => reject(new Error('CDP evaluation timed out')), 2000);
    const handler = event => {
      const message = JSON.parse(event.data);
      if (message.id !== request) return;
      clearTimeout(timer); ws.removeEventListener('message', handler);
      if (message.error) reject(message.error); else resolve(message.result?.result?.value?.[0] ? message.result.result.value : undefined);
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id: request, method: 'Runtime.evaluate', params: {
      expression: '[document.body?.dataset.result,document.querySelector("pre")?.textContent]', returnByValue: true,
    } }));
  }));
  if (result[0] !== 'passed') throw new Error(result[1]);
  console.log('ThreeViewer Chromium/WebGL smoke test passed');
} finally {
  ws?.close();
  if (browser && browser.exitCode === null) {
    const exited = new Promise(resolve => browser.once('exit', resolve));
    browser.kill(); await Promise.race([exited, sleep(2000)]);
  }
  await rm(scratch, { recursive: true, force: true });
}
