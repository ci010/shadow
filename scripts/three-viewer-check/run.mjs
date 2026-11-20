import { createRequire } from 'node:module';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixtureEndpoints } from './snapshot.mjs';
import { marker, sessionId } from './constants.mjs';
import { sessionWorkspacePath } from '../../src/utils/paths.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const requireApp = createRequire(join(repo, 'app/package.json'));
const requireDesktop = createRequire(join(repo, 'desktop/package.json'));
const vite = await import(pathToFileURL(requireApp.resolve('vite')).href);
const viteFile = file => `/@fs/${encodeURI(vite.normalizePath(file))}`;
const scriptDir = join(repo, 'scripts/three-viewer-check');
const mode = process.argv[2] ?? 'product';
if (!['ui', 'product', 'baseline', 'worker', 'outline'].includes(mode)) throw new Error(`Unknown check mode: ${mode}`);
const fixture = await mkdtemp(join(tmpdir(), 'shadow-three-check-'));
let server, endpoints;
try {
  const fixtureWorkspace = join(fixture, 'workspace');
  const fixtureScene = join(sessionWorkspacePath(fixtureWorkspace, sessionId), dirname(marker));
  await cp(join(repo, dirname(marker)), fixtureScene, { recursive: true });
  const requireViewer = createRequire(join(repo, 'packages/three-viewer/package.json'));
  const threeRoot = dirname(dirname(requireViewer.resolve('three')));
  const uiPlugins = ['ui', 'outline'].includes(mode) ? [
    (await import(pathToFileURL(requireApp.resolve('@vitejs/plugin-vue')).href)).default(),
    (await import(new URL('../../app/pdf-viewer-assets.ts', import.meta.url))).pdfViewerAssets(),
  ] : [];
  endpoints = await fixtureEndpoints(fixtureWorkspace, fixtureScene, mode === 'ui');
  server = await vite.createServer({
    root: join(repo, 'app'), configFile: false, envDir: false, cacheDir: join(fixture, 'vite-cache'),
    optimizeDeps: { noDiscovery: true },
    resolve: { alias: [
      { find: /^vue$/, replacement: requireApp.resolve('vue/dist/vue.runtime.esm-bundler.js') },
      { find: /^@shadow\/three-viewer$/, replacement: join(repo, 'packages/three-viewer/src/index.ts') },
      { find: /^three\/(?:addons|examples\/jsm)\/(.*)$/, replacement: `${threeRoot}/examples/jsm/$1` },
      { find: /^three$/, replacement: `${threeRoot}/build/three.module.js` },
    ] },
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, fs: { allow: [scriptDir, join(repo, 'app'), join(repo, 'packages/three-viewer'), join(repo, 'packages/three-playground'), join(repo, 'src/gltf-capture-contract.ts'), join(repo, 'src/execution/filesystem'), threeRoot, join(repo, 'node_modules'), fixtureScene] } },
    plugins: [...uiPlugins, { name: 'three-check', configureServer(server) {
      server.middlewares.use(endpoints.handle);
      server.middlewares.use('/__three-check', async (req, res) => {
        try {
          const html = await server.transformIndexHtml('/__three-check', `<!doctype html><meta charset="utf-8"><div id="app"></div><script>window.cubeStandEntry = ${JSON.stringify(viteFile(join(fixtureScene, 'main.mjs')))}</script><script type="module" src="${viteFile(join(scriptDir, ({ ui: 'ui.mjs', outline: 'outline.mjs', product: 'product.mjs', baseline: 'browser.mjs', worker: 'worker.mjs' })[mode]))}"></script>`);
          res.setHeader('content-type', 'text/html'); res.end(html);
        } catch (error) { res.statusCode = 500; res.end(String(error)); }
      });
    } }],
  });
  await server.listen();
  const address = server.httpServer.address();
  const child = spawn(requireDesktop('electron'), [join(scriptDir, 'electron.cjs'), fixture, mode, fixtureScene, `http://127.0.0.1:${address.port}/__three-check`], { stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); signal ? reject(new Error(`Electron exited by ${signal}`)) : resolve(code); });
  });
  process.exitCode = code;
} finally {
  try { await endpoints?.close(); }
  finally {
    try { await server?.close(); }
    finally { await rm(fixture, { recursive: true, force: true }); }
  }
}
