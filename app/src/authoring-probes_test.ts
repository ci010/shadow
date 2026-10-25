import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { type TestContext } from 'node:test'
import { createRenderer, defineComponent, reactive } from 'vue'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { parseProbeResponse, visibleProbeRequests, useAuthoringProbes } from './authoring-probes.ts'
import type { PublicationSource } from './publication-requests.ts'

const revision = `sha256:${'a'.repeat(64)}`
const probe = (projectId = 'a', id = 'probe-a') => ({
  id, projectId, changeId: 'change-a', title: 'Check support connection', revision, sourceSessionId: 'web:topic',
  createdAt: '2026-09-19T01:00:00.000Z', expiresAt: '2099-09-19T02:00:00.000Z',
  toolName: 'support_lookup', sourceHash: revision,
  address: { projectId, botInstanceId: 'support', platform: 'discord', conversationId: 'support-room' },
  arguments: { query: 'fixture' },
  grants: [{ id: 'http-a', kind: 'http', origin: 'https://example.com',
    routes: [{ method: 'GET', path: '/health' }], credential: { secretRef: 'support-token', header: 'Authorization', prefix: 'Bearer ' } }],
  maxCalls: 1, status: 'pending',
})
const settle = () => new Promise(resolve => setImmediate(resolve))
function harness(t: TestContext, initial: Partial<PublicationSource> = {}) {
  const calls: Array<{ url: string; init: RequestInit; finish: (response: Response) => void; fail: (error: Error) => void }> = []
  t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) =>
    new Promise<Response>((finish, fail) => calls.push({ url, init, finish, fail })))
  const source = reactive({
    apiBase: 'http://127.0.0.1/projects/a', projectId: 'a', sessionId: 'web:topic',
    active: true, canSubmit: true, stage: 'idle', ...initial,
  })
  let state!: ReturnType<typeof useAuthoringProbes>
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
    parentNode: () => null, nextSibling: () => null,
  })
  const app = renderer.createApp(defineComponent({
    setup() { state = useAuthoringProbes(() => source); return () => null },
  }))
  app.mount({})
  t.after(() => app.unmount())
  return { source, state, calls }
}

test('probe parser uses the shared schema, rejects duplicate IDs and validates nested Project/GET scope', () => {
  assert.deepEqual(parseProbeResponse({ requests: [probe()] }, 'a'), [probe()])
  const withSource = { ...probe(), source: { path: 'skills/support/support_lookup.ts', code: 'export default async () => ({ ok: true })' } }
  assert.deepEqual(parseProbeResponse({ requests: [withSource] }, 'a'), [withSource])
  for (const value of [
    {}, { requests: [probe()], extra: true }, { requests: [probe(), probe()] },
    { requests: [probe('b')] }, { requests: [{ ...probe(), address: probe('b').address }] },
    { requests: [{ ...probe(), sourceHash: 'not-a-hash' }] },
    { requests: [{ ...probe(), grants: [{ ...probe().grants[0], routes: [{ method: 'POST', path: '/write' }] }] }] },
    { requests: [{ ...probe(), secret: 'must-not-be-present' }] },
  ]) assert.throws(() => parseProbeResponse(value, 'a'))
  const requests = parseProbeResponse({ requests: [probe(), { ...probe('a', 'other'), sourceSessionId: 'web:other' }] }, 'a')
  assert.equal(visibleProbeRequests(requests, 'web:topic').length, 1)
  assert.equal(visibleProbeRequests(requests, 'web:chat-admin').length, 0)
  assert.equal(visibleProbeRequests(requests, 'web:unrelated').length, 0)
})

test('read-only and hidden surfaces do not fetch or approve; topic renders only its own test', async t => {
  const { source, state, calls } = harness(t, { canSubmit: false })
  assert.equal(calls.length, 0)
  assert.equal(await state.approve(), false)
  source.canSubmit = true
  calls[0]!.finish(Response.json({ requests: [probe(), { ...probe('a', 'other'), sourceSessionId: 'web:other' }] }))
  await settle()
  assert.equal(state.requests.value.length, 1)
  assert.equal(calls.length, 1, 'Loading does not approve')
  source.active = false
  assert.equal(state.request.value, null)
  assert.equal(await state.cancel(), false)
})

test('explicit approval is single flight and pinned; completed receipts retain their run ID across passive stale reads', async t => {
  const { state, calls } = harness(t)
  calls[0]!.finish(Response.json({ requests: [probe()] }))
  await settle()
  const write = state.approve()
  assert.equal(await state.approve(), false)
  assert.equal(await state.cancel(), false)
  assert.equal(calls[1]!.url, 'http://127.0.0.1/projects/a/api/agent-resources/probe-requests/probe-a')
  assert.equal(calls[1]!.init.method, 'POST')
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { revision })
  calls[1]!.finish(Response.json({ result: { requestId: 'probe-a', revision, status: 'completed', runId: 'run-a' } }))
  assert.equal(await write, true)
  assert.equal(state.request.value?.runId, 'run-a')
  assert.match(state.notice.value, /not full business acceptance/)
  const refresh = state.refresh()
  calls[2]!.finish(Response.json({ requests: [probe()] }))
  await refresh
  assert.equal(state.request.value?.status, 'completed')
  assert.equal(await state.approve(), false)
})

test('cancel sends DELETE without executing the tool', async t => {
  const { state, calls } = harness(t)
  calls[0]!.finish(Response.json({ requests: [probe()] }))
  await settle()
  const write = state.cancel()
  assert.equal(calls[1]!.init.method, 'DELETE')
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { revision })
  calls[1]!.finish(Response.json({ result: { requestId: 'probe-a', revision, status: 'cancelled' } }))
  assert.equal(await write, true)
  assert.equal(state.request.value?.status, 'cancelled')
})

test('failed runs are final receipts, not invitations to repeat approval', async t => {
  const { state, calls } = harness(t)
  calls[0]!.finish(Response.json({ requests: [probe()] }))
  await settle()
  const write = state.approve()
  calls[1]!.finish(Response.json({ result: { requestId: 'probe-a', revision, status: 'failed', runId: 'run-failed', error: 'Connection refused' } }))
  assert.equal(await write, true)
  assert.equal(state.request.value?.error, 'Connection refused')
  assert.equal(await state.approve(), false)
  assert.match(state.notice.value, /new approval/)
})

test('completed receipts can carry notification warnings without authorizing another run', async t => {
  const { state, calls } = harness(t)
  calls[0]!.finish(Response.json({ requests: [probe()] }))
  await settle()
  const write = state.approve()
  calls[1]!.finish(Response.json({ result: {
    requestId: 'probe-a', revision, status: 'completed', runId: 'run-a', error: 'Completion notification unavailable',
  } }))
  assert.equal(await write, true)
  assert.equal(state.request.value?.status, 'completed')
  assert.equal(state.request.value?.error, 'Completion notification unavailable')
  assert.match(state.notice.value, /test completed/)
  assert.equal(await state.approve(), false)
})

test('stale, unauthorized, mismatched and uncertain decisions require explicit reload; polling never unlocks them', async t => {
  for (const failure of ['stale', 'unauthorized', 'mismatch', 'network']) {
    await t.test(failure, async t => {
      const { state, calls } = harness(t)
      calls[0]!.finish(Response.json({ requests: [probe()] }))
      await settle()
      const write = state.approve()
      if (failure === 'network') calls[1]!.fail(new Error('Connection lost'))
      else calls[1]!.finish(failure === 'mismatch'
        ? Response.json({ result: { requestId: 'wrong', revision, status: 'completed' } })
        : Response.json({ error: failure }, { status: failure === 'stale' ? 409 : 403 }))
      assert.equal(await write, false)
      assert.equal(state.needsReload.value, true)
      assert.equal(await state.approve(), false)
      const refresh = state.refresh()
      calls[2]!.finish(Response.json({ requests: [{ ...probe(), status: 'running', runId: 'run-a' }] }))
      await refresh
      assert.equal(state.needsReload.value, true)
      const reload = state.reload()
      calls[3]!.finish(Response.json({ requests: [{ ...probe(), status: 'completed', runId: 'run-a' }] }))
      await reload
      assert.equal(state.needsReload.value, false)
      assert.equal(await state.approve(), false)
    })
  }
})

test('navigation, Project change and permission loss abort writes and discard late results', async t => {
  for (const reason of ['navigation', 'project', 'permission']) {
    await t.test(reason, async t => {
      const { source, state, calls } = harness(t)
      calls[0]!.finish(Response.json({ requests: [probe()] }))
      await settle()
      const write = state.approve()
      if (reason === 'navigation') source.sessionId = 'web:elsewhere'
      if (reason === 'project') source.projectId = 'b'
      if (reason === 'permission') source.canSubmit = false
      assert.equal(calls[1]!.init.signal!.aborted, true)
      calls[1]!.finish(Response.json({ result: { requestId: 'probe-a', revision, status: 'completed' } }))
      assert.equal(await write, false)
      assert.equal(state.request.value, null)
      assert.equal(state.notice.value, '')
    })
  }
})

test('late polling and old navigation responses cannot replace current state', async t => {
  const { source, state, calls } = harness(t)
  source.sessionId = 'web:chat-admin'
  calls[1]!.finish(Response.json({ requests: [{ ...probe(), sourceSessionId: source.sessionId }] }))
  await settle()
  calls[0]!.finish(Response.json({ requests: [] }))
  await settle()
  assert.equal(state.request.value?.id, 'probe-a')
  const refresh = state.refresh()
  const write = state.cancel()
  assert.equal(calls[2]!.init.signal!.aborted, true)
  calls[3]!.finish(Response.json({ result: { requestId: 'probe-a', revision, status: 'cancelled' } }))
  await write
  calls[2]!.finish(Response.json({ requests: [probe()] }))
  await refresh
  assert.equal(state.request.value?.status, 'cancelled')
})

test('expired approvals and restored running requests cannot execute again', async t => {
  const { state, calls } = harness(t)
  calls[0]!.finish(Response.json({ requests: [{ ...probe(), expiresAt: '2026-09-19T01:01:00.000Z' }] }))
  await settle()
  assert.equal(await state.approve(), false)
  assert.match(state.error.value, /expired/)
  assert.equal(calls.length, 1)
  const reload = state.reload()
  calls[1]!.finish(Response.json({ requests: [{ ...probe(), status: 'running', runId: 'run-a' }] }))
  await reload
  assert.equal(await state.approve(), false)
  assert.equal(await state.cancel(), false)
})

test('isolated approval cards render at desktop and narrow widths with explicit actions and visible receipts', {
  timeout: 60_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
    ? 'Electron browser smoke requires a display server.' : false,
}, async t => {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const directory = resolve(root, '.test-artifacts', `authoring-approvals-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const publication = {
    id: 'publication-a', projectId: 'a', sessionId: 'web:chat-admin', revision,
    baseRevision: `sha256:${'b'.repeat(64)}`, createdAt: '2026-09-19T01:00:00.000Z',
    files: [{ path: 'agents/support/AGENT.md', before: null, after: 'Synthetic fixture prompt.' }],
    previousBindings: [], bindings: [],
    change: { id: 'change-a', title: 'Support connection and prompt update', sourceSessionId: 'web:topic' },
    checks: [
      { id: 'preview-a', kind: 'preview', status: 'completed', revision },
      { id: 'test-a', kind: 'test', status: 'completed', revision },
      { id: 'scenario-a', kind: 'scenario', status: 'passed', revision },
      { id: 'stale-a', kind: 'stale-check-must-not-appear', status: 'passed', revision: `sha256:${'c'.repeat(64)}` },
    ],
    impact: { affectedBindings: ['discord:support-room'], permissionsChanged: true, toolsChanged: true, promptsChanged: true },
  }
  const vite = await createServer({
    configFile: false, envFile: false, root: resolve(root, 'app'), logLevel: 'error',
    plugins: [{
      name: 'isolated-authoring-approval-fixture',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/authoring-approval-fixture') return next()
          response.setHeader('Content-Type', 'text/html')
          response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/authoring-approval-fixture.ts"></script></body></html>')
        })
      },
      resolveId(id) { if (id === '/authoring-approval-fixture.ts') return '\0authoring-approval-fixture' },
      load(id) {
        if (id !== '\0authoring-approval-fixture') return
        return `
          import { createApp, h } from 'vue';
          import Publication from '/src/components/PublicationRequest.vue';
          import Probe from '/src/components/AuthoringProbeRequest.vue';
          import '/src/styles.css';
          const publication = ${JSON.stringify(publication)};
          const probe = ${JSON.stringify({ ...probe(), source: { path: 'skills/support/support_lookup.ts', code: 'export default async () => ({ fixture: true })' } })};
          window.decisions = [];
          window.fetch = async (url, init = {}) => {
            if (String(url).includes('publication-requests')) {
              if (!init.method) return Response.json({ request: publication, requests: [publication] });
              window.decisions.push(init.method);
              publication.status = 'waiting';
              return Response.json({ result: { requestId: publication.id, revision: publication.revision, status: 'waiting' } });
            }
            if (!init.method) return Response.json({ requests: [probe] });
            window.decisions.push(init.method);
            probe.status = init.method === 'DELETE' ? 'cancelled' : 'completed';
            probe.runId = 'recorded-fixture-run';
            return Response.json({ result: { requestId: probe.id, revision: probe.revision, status: probe.status, runId: probe.runId } });
          };
          const props = { apiBase: location.origin, projectId: 'a', sessionId: 'web:topic', active: true, canSubmit: true };
          createApp({ render: () => h('main', { style: 'height:100dvh;display:flex;flex-direction:column;justify-content:flex-end;padding-bottom:12px;box-sizing:border-box' }, [
            h(Publication, props), h(Probe, props),
          ]) }).mount('#app');
        `
      },
    }, vue()],
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { include: ['vue'], entries: [] },
    cacheDir: resolve(directory, 'vite-cache'),
  })
  t.after(() => vite.close())
  await vite.listen()
  const address = vite.httpServer!.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  assert.equal((await fetch(`${origin}/authoring-approval-fixture`)).status, 200)
  const main = resolve(directory, 'main.cjs')
  await writeFile(main, `
    const { app, BrowserWindow } = require('electron');
    const assert = require('node:assert/strict');
    app.setPath('userData', ${JSON.stringify(resolve(directory, 'profile'))});
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false } });
      const js = source => win.webContents.executeJavaScript(source);
      await win.loadURL(${JSON.stringify(`${origin}/authoring-approval-fixture`)});
      for (let i = 0; i < 100; i++) {
        if (await js("document.querySelectorAll('section').length === 2 && document.querySelectorAll('button').length === 4")) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(await js('window.decisions.length'), 0, 'Rendering must not authorize');
      for (const width of [1100, 360]) {
        win.setContentSize(width, 850);
        await new Promise(resolve => setTimeout(resolve, 100));
        const state = await js(\`(() => {
          const cards = [...document.querySelectorAll('section')];
          return { count: cards.length, text: document.body.innerText,
            overflow: document.documentElement.scrollWidth > innerWidth,
            cardsFit: cards.every(card => { const r = card.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.height > 0; }),
            buttonsFit: [...document.querySelectorAll('button')].every(button => { const r = button.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.height >= 34; }),
            detailsClosed: [...document.querySelectorAll('details')].every(detail => !detail.open) };
        })()\`);
        assert.equal(state.count, 2);
        assert.equal(state.overflow, false);
        assert.equal(state.cardsFit, true);
        assert.equal(state.buttonsFit, true);
        assert.equal(state.detailsClosed, true);
        assert.match(state.text, /Permissions change/);
        assert.match(state.text, /https:\\/\\/example.com/);
        assert.match(state.text, /GET \\/health/);
        assert.match(state.text, /support-token/);
        assert.match(state.text, /No native network access/);
      }
      await js("[...document.querySelectorAll('.publication-review details')].find(detail => detail.querySelector('summary').textContent.includes('Checks')).open = true");
      const checks = await js("document.querySelector('.publication-review').innerText");
      assert.match(checks, /Checks for this revision \\(3\\)/);
      assert.match(checks, /not a behavior evaluation/);
      assert.match(checks, /not a live integration test/);
      assert.match(checks, /Simulated agent scenario/);
      assert.equal(checks.includes('stale-check-must-not-appear'), false);
      await js("document.querySelector('.probe-review details').open = true");
      assert.equal(await js("document.querySelector('.probe-review').innerText.includes('skills/support/support_lookup.ts')"), true);
      assert.equal(await js("document.querySelector('.probe-review').innerText.includes('export default async () => ({ fixture: true })')"), true);
      await js("document.querySelector('.probe-confirm').click()");
      for (let i = 0; i < 20; i++) {
        if (await js("document.body.innerText.includes('recorded-fixture-run')")) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(await js('window.decisions.length'), 1);
      assert.equal(await js("document.body.innerText.includes('recorded-fixture-run')"), true);
      assert.equal(await js("document.querySelector('.probe-confirm') === null"), true);
      await js("document.querySelector('.publication-confirm').click()");
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(await js("document.querySelector('.publication-confirm').disabled"), true);
      assert.equal(await js('window.decisions.length'), 2);
      console.log('AUTHORING_APPROVAL_BROWSER_OK');
      win.destroy();
      app.quit();
    }).catch(error => { console.error(error); app.exit(1); });
  `)
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[name] = directory
  const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
  const child = spawn(desktopRequire('electron') as string, [main], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timeout = setTimeout(() => child.kill(), 45_000)
  t.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /AUTHORING_APPROVAL_BROWSER_OK/)
})
