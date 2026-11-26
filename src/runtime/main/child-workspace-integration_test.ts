import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { ConfigSchema } from '../../config/schema.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { startMainRuntime } from './start.ts'
import { InMemoryPairingNodeRegistry } from '../../cluster/registry.ts'
import { AtomicFileRegistrySnapshotAdapter } from '../../cluster/persistence.ts'
import { devicePublicKeyFingerprint, encodeBase64Url } from '../../cluster/device-challenge.ts'
import { DeviceCredentialProof } from '../../cluster/device-credentials.ts'
import { requestDeviceChallengeProtocol } from '../../cluster/device-challenge-client.ts'
import { DEVICE_UI_SESSION, DEVICE_UI_SESSION_CHALLENGE } from '../../cluster/direct-device-ui.ts'
import { MicroApps } from '../../microapps/service.ts'
import { projectPaths } from '../../projects/contracts.ts'
import { DesktopMicroApps, type MicroAppWindowInput } from '../../../desktop/src/micro-apps.ts'

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = (server.address() as import('node:net').AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve())); return port
}

test('real Main device ingress serves same project/session APIs to approved Child without web login', { timeout: 60_000 }, async t => {
  await withTempWorkspace(async root => {
    const keysToIsolate = ['GITHUB_COPILOT_TOKEN_DIR', 'GITHUB_COPILOT_ACCESS_TOKEN_FILE', 'GITHUB_COPILOT_API_KEY_FILE', 'GITHUB_COPILOT_MODELS_CACHE_FILE', 'VITE_DEV_URL', 'SHADOW_MOBILE_ORIGIN', 'SHADOW_MOBILE_PORT']
    const previous = new Map(keysToIsolate.map(key => [key, process.env[key]]))
    for (const key of keysToIsolate) delete process.env[key]
    process.env.GITHUB_COPILOT_TOKEN_DIR = join(root, 'empty-auth')
    t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
    const home = join(root, 'home'); await mkdir(home)
    const registryPath = join(root, 'device-state', 'registry.v1.json')
    const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))
    const fingerprint = await devicePublicKeyFingerprint(publicKey)
    const auth = { deviceId: 'device-1', nodeId: 'child-1', credentialId: 'credential-1' }
    const registry = new InMemoryPairingNodeRegistry(); const now = new Date()
    registry.createOffer('offer-1', now, new Date(now.getTime() + 60000))
    registry.presentOffer({ offerId: 'offer-1', pendingId: 'pending-1', ...auth,
      displayName: 'Fixture Child', deviceIdentityFingerprint: fingerprint, devicePublicKey: encodeBase64Url(publicKey) }, now)
    registry.approve({ pendingId: 'pending-1', expectedDeviceIdentityFingerprint: fingerprint, credentialId: auth.credentialId }, now)
    await new AtomicFileRegistrySnapshotAdapter(registryPath).save(registry.exportSnapshot(now))
    const rawConfig = { agent: { workspace: home, model: 'fixture@openai' },
      providers: { openai: { apiKey: 'fixture-unused', baseUrl: 'http://127.0.0.1:1/v1' } }, channels: {}, mcp: {} }
    const config = ConfigSchema.parse(rawConfig)
    const configPath = join(root, 'fixture.json'); await writeFile(configPath, JSON.stringify(rawConfig))
    // Publish a synthetic immutable bundle before Main reads its project store; approval still goes through real Child UI APIs below.
    const seed = new MicroApps('default', projectPaths(home, 'default').home, () => { throw new Error('No model expected') }, () => 'fixture')
    await seed.init()
    const source = join(root, 'app-source'); await mkdir(source)
    await writeFile(join(source, 'index.html'), '<!doctype html><title>Child app fixture</title><script type="module" src="/_shadow/sdk.js"></script>')
    const published = await seed.publish(source, { version: 1, name: 'Child fixture', description: 'Synthetic fixture', entry: 'index.html', files: ['index.html'] }, 'web:fixture', AbortSignal.timeout(5000))
    await writeFile(join(source, 'index.html'), `<!doctype html><title>Child native fixture</title><button id="save">Save</button><output>loading</output><script type="module">
      import {loadState,saveState} from '/_shadow/sdk.js';let state=await loadState();document.querySelector('output').textContent='state:'+state.version;
      document.querySelector('#save').onclick=async()=>{state=await saveState({child:true},state.version);document.querySelector('output').textContent='saved:'+state.version};
    </script>`)
    const nativePublished = await seed.publish(source, { version: 1, name: 'Child native fixture', description: 'Synthetic Electron Child fixture', entry: 'index.html', files: ['index.html'] }, 'web:fixture', AbortSignal.timeout(5000))
    await seed.shutdown()
    const port = await freePort(); const devicePort = port
    const mainBase = `http://127.0.0.1:${port}`, deviceBase = `http://127.0.0.1:${devicePort}`
    const runtime = await startMainRuntime(config, { configPath, clusterSnapshotPath: registryPath, localNodeId: 'fixture-main', gateway: { host: '127.0.0.1', port, launchCredential: 'fixture-main-secret' } })
    try {
      await runtime.ready
      const setup = await fetch(`${mainBase}/nodes/v1/network`, { method: 'PUT', headers: { Authorization: 'Bearer fixture-main-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, enabled: true, host: '127.0.0.1', port: devicePort, allowInsecureLocalTransport: true }) })
      assert.equal(setup.status, 200, await setup.text())
      const childBase = deviceBase // Same Main socket as desktop; no Child HTTP server is started.
      const issue = async () => {
        const proof = await requestDeviceChallengeProtocol(childBase, auth,
          new DeviceCredentialProof(async bytes => new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, new Uint8Array(bytes)))),
          fetch, AbortSignal.timeout(5000), DEVICE_UI_SESSION_CHALLENGE)
        const exchange = () => fetch(childBase + DEVICE_UI_SESSION, { method: 'POST', headers: { 'X-Shadow-Device-Proof': proof } })
        const grant = await exchange()
        assert.equal(grant.status, 200, await grant.clone().text())
        assert.equal((await exchange()).status, 401, 'one-use proof')
        return (await grant.json() as { token: string }).token
      }
      const token = await issue()
      const childRequest = (path: string, init: RequestInit = {}) => fetch(childBase + path, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: `ShadowDevice ${token}` } })
      assert.equal((await fetch(childBase + '/api/projects')).status, 401)
      const ownerHeaders = { Authorization: 'Bearer fixture-main-secret' }
      const ownerProjects = await (await fetch(`${mainBase}/api/projects`, { headers: ownerHeaders })).json()
      const projects = await childRequest('/api/projects'); assert.equal(projects.status, 200, await projects.clone().text())
      assert.deepEqual(await projects.json(), ownerProjects)
      const rename = await childRequest('/api/projects/default', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Changed from Child workspace' }) })
      assert.equal(rename.status, 200, await rename.clone().text())
      const changed = await (await fetch(`${mainBase}/api/projects`, { headers: ownerHeaders })).json()
      assert.equal(changed.projects.find((project: { id: string }) => project.id === 'default').name, 'Changed from Child workspace')
      for (const path of ['/projects/default/api/sessions', '/projects/default/api/microapps']) {
        const response = await childRequest(path)
        assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`)
        assert.deepEqual(await response.json(), await (await fetch(mainBase + path, { headers: ownerHeaders })).json())
      }
      const projectConfigRoute = '/projects/default/api/config'
      assert.equal((await childRequest(projectConfigRoute)).status, 200)
      const modelChange = await childRequest(projectConfigRoute + '/model-defaults', { method: 'PATCH',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ temperature: 0.6 }) })
      assert.equal(modelChange.status, 200, await modelChange.clone().text())
      const appPath = `/projects/default/api/microapps/${published.id}`
      const postApp = (action: string, body: unknown) => childRequest(`${appPath}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const windows: MicroAppWindowInput[] = []; let focused = 0
      const native = new DesktopMicroApps({ userDataPath: join(root, 'desktop'), executablePath: process.execPath, appPath: root,
        packaged: false, defaultIconPath: '', platform: 'win32', decodeIcon() { throw new Error('No icon expected') }, setUserTasks() { return true },
        onError(message) { assert.fail(message) }, async createWindow(input) { windows.push(input); return { focus() { focused++ }, close() { input.onClosed() } } } })
      native.setAuthorization({ apiBase: childBase, launchToken: '', deviceGrant: async () => token })
      const identity = { projectId: 'default', appId: published.id }
      try {
        assert.equal((await postApp('open', { revision: '0'.repeat(64) })).status, 409)
        const launchCheck = await (await postApp('open', { revision: published.revision })).json()
        const relayCheck = await postApp('relay', { revision: published.revision, runId: launchCheck.runId, path: '/', method: 'GET' })
        assert.equal(relayCheck.status, 200, await relayCheck.clone().text())
        await native.open(identity)
        assert.equal(windows.length, 1)
        const local = new URL(windows[0]!.url)
        const localOrigin = `${local.protocol}//${local.host}`
        const localFetch = (url: string, init?: RequestInit) => windows[0]!.relay!(new Request(url, init))
        assert.notEqual(localOrigin, childBase); assert.notEqual(localOrigin, mainBase)
        assert.match(windows[0]!.partition, /^shadow-microapp-default-/)
        assert.match(await (await localFetch(localOrigin)).text(), /Child app fixture/)
        assert.equal((await localFetch(localOrigin + '/_shadow/sdk.js')).status, 200)
        assert.equal((await localFetch(localOrigin + '/api/projects')).status, 404, 'isolated app origin does not expose host APIs')
        assert.equal((await localFetch(localOrigin + '/_shadow/state')).status, 401)
        const ticket = new URLSearchParams(local.hash.slice(1)).get('shadow_ticket')!
        const connect = () => localFetch(localOrigin + '/_shadow/connect', { method: 'POST', headers: { Authorization: `Bearer ${ticket}`, Origin: localOrigin } })
        const connected = await connect(); assert.equal(connected.status, 200)
        const { token } = await connected.json() as { token: string }
        assert.notEqual(token, 'fixture-main-secret'); assert.notEqual(token, 'fixture-child-secret')
        assert.equal((await connect()).status, 401, 'one-use ticket')
        assert.equal((await localFetch(localOrigin + '/_shadow/state', { headers: { Authorization: `Bearer ${token}`, Origin: 'http://evil.test' } })).status, 403)
        const state = await localFetch(localOrigin + '/_shadow/state', { headers: { Authorization: `Bearer ${token}` } })
        assert.equal(state.status, 200)
        const status = await (await localFetch(localOrigin + '/_shadow/status', { headers: { Authorization: `Bearer ${token}` } })).json() as { runId: string }
        const relayInput = { revision: published.revision, runId: status.runId, path: '/_shadow/state', method: 'GET', token }
        assert.equal((await postApp('relay', { ...relayInput, revision: '0'.repeat(64) })).status, 409)
        assert.equal((await postApp('relay', { ...relayInput, runId: crypto.randomUUID() })).status, 409)
        assert.equal((await postApp('relay', { ...relayInput, path: 'http://127.0.0.1:1/api/projects' })).status, 400)
        assert.equal((await postApp('relay', { ...relayInput, path: '//127.0.0.1:1/' })).status, 400)
        assert.equal((await localFetch(localOrigin + '/_shadow/state', { headers: { Authorization: 'Bearer fixture-child-secret' } })).status, 401)
        const saved = await localFetch(localOrigin + '/_shadow/state', { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 0, values: { from: 'Child' } }) })
        assert.equal(saved.status, 200)
        await native.open(identity); assert.equal(focused, 1); assert.equal(windows.length, 1)
        windows[0]!.onClosed()
        // open waits for the real remote stop before obtaining a fresh run and isolated origin.
        await native.open(identity); assert.equal(windows.length, 2)
        assert.notEqual(new URL(windows[1]!.url).host, local.host)
        assert.equal((await localFetch(localOrigin)).status, 410)
        assert.equal((await postApp('stop', {})).status, 200)
        await native.refresh()
        assert.equal(windows[1]!.signal.aborted, true, 'remote stop closes the local protocol window')
        assert.equal((await childRequest(`${appPath}/status`)).status, 200)
        assert.equal((await fetch(deviceBase + `${appPath}/relay`, { method: 'POST', body: '{}' })).status, 401)
      } finally { await native.shutdown() }
      if (process.platform !== 'linux' || process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
        const requireDesktop = createRequire(resolve('desktop/package.json'))
        const { build } = requireDesktop('esbuild') as typeof import('esbuild')
        const output = join(root, 'electron-child'); await mkdir(output)
        await Promise.all([
          build({ entryPoints: [resolve('desktop/tests/fixtures/microapps-native-smoke.ts')], outfile: join(output, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], logLevel: 'silent' }),
          build({ entryPoints: [resolve('desktop/src/preload.ts')], outfile: join(output, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], logLevel: 'silent' }),
        ])
        const env: NodeJS.ProcessEnv = { ...process.env, MICROAPPS_NATIVE_URL: childBase, MICROAPPS_NATIVE_CHILD_GRANT: token,
          MICROAPPS_NATIVE_OUTPUT: output, MICROAPPS_NATIVE_CHILD_ID: nativePublished.id, MICROAPPS_NATIVE_MAIN_URL: mainBase }
        for (const key of ['ELECTRON_RUN_AS_NODE', 'GATEWAY_LAUNCH_CREDENTIAL', 'WINDOWS_USE_LAUNCH_TOKEN', 'GATEWAY_ALLOWED_ORIGINS']) delete env[key]
        const electron = spawn(requireDesktop('electron') as string, [join(output, 'main.cjs')], { cwd: output, env, stdio: ['ignore', 'pipe', 'pipe'] })
        let log = ''; electron.stdout.on('data', chunk => { log += chunk }); electron.stderr.on('data', chunk => { log += chunk })
        const timer = setTimeout(() => electron.kill(), 45_000)
        try {
          const [code] = await once(electron, 'close')
          assert.equal(code, 0, log); assert.match(log, /NATIVE_CHILD_APPS_OK/)
          console.log('NATIVE_CHILD_APPS_OK (real Electron custom protocol + direct Main device grant)')
        } finally { clearTimeout(timer); if (electron.exitCode === null) electron.kill() }
      } else t.diagnostic('Native Child Electron check not run: no Linux display server')
      const form = new FormData()
      form.set('chatId', 'child-media')
      form.set('file', new File([new Uint8Array([137, 80, 78, 71, 0, 255, 1])], 'pasted.png', { type: 'image/png' }))
      const upload = await childRequest('/projects/default/api/chat/upload', { method: 'POST', body: form })
      assert.equal(upload.status, 200, await upload.clone().text())
      const attachment = await upload.json() as { path: string }
      const mediaPath = `/projects/default/api/media?chatId=child-media&path=${encodeURIComponent(attachment.path)}`
      const media = await childRequest(mediaPath)
      assert.equal(media.status, 200, await media.clone().text())
      const imageBytes = new Uint8Array([137, 80, 78, 71, 0, 255, 1])
      assert.equal(media.headers.get('Content-Type'), 'image/png')
      assert.deepEqual(new Uint8Array(await media.arrayBuffer()), imageBytes)
      const download = await childRequest(`${mediaPath}&download=1`)
      assert.equal(download.status, 200)
      assert.match(download.headers.get('Content-Disposition')!, /^attachment;/)
      assert.deepEqual(new Uint8Array(await download.arrayBuffer()), imageBytes)
      const ranged = await childRequest(mediaPath, { headers: { Range: 'bytes=0-3' } })
      assert.equal(ranged.status, 206)
      assert.equal(ranged.headers.get('Content-Range'), 'bytes 0-3/7')
      assert.deepEqual(new Uint8Array(await ranged.arrayBuffer()), imageBytes.slice(0, 4))
      const head = await childRequest(mediaPath, { method: 'HEAD' })
      assert.equal(head.status, 200)
      assert.equal(head.headers.get('Content-Length'), '7')
      assert.equal((await head.arrayBuffer()).byteLength, 0)
      assert.equal((await childRequest(`/projects/default/api/media?chatId=other-chat&path=${encodeURIComponent(attachment.path)}`)).status, 404)
      // Preview documents/subresources are Main capabilities with no workspace grant
      // on the sandboxed iframe, and stay tied to the issuing Child session.
      const previewFolder = join(root, 'preview-fixture')
      await mkdir(previewFolder)
      await writeFile(join(previewFolder, 'index.html'), '<script src="asset.js"></script><h1>Preview fixture</h1>')
      await writeFile(join(previewFolder, 'asset.js'), 'window.synthetic = true')
      const registration = await childRequest('/projects/default/api/folders/register', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: previewFolder }) })
      assert.equal(registration.status, 200, await registration.clone().text())
      const { folder } = await registration.json() as { folder: { id: string } }
      const preview = await childRequest(`/projects/default/api/folders/${folder.id}/html-preview?path=index.html`, { method: 'POST' })
      assert.equal(preview.status, 200, await preview.clone().text())
      const lease = await preview.json() as { url: string }
      const opaque = { headers: { Origin: 'null' } }
      const page = await fetch(mainBase + lease.url, opaque)
      assert.equal(page.status, 200)
      assert.match(page.headers.get('content-security-policy') ?? '', /sandbox allow-scripts;/)
      assert.match(await page.text(), /Preview fixture/)
      assert.equal((await fetch(mainBase + lease.url.replace('index.html', 'asset.js'), opaque)).status, 200)
      assert.equal((await fetch(mainBase + '/api/projects', opaque)).status, 401)
      assert.equal((await fetch(mainBase + `/nodes/v1/${auth.nodeId}/revoke`, { method: 'POST', headers: ownerHeaders })).status, 200)
      assert.equal((await fetch(mainBase + lease.url, opaque)).status, 404)
      assert.equal((await fetch(`${deviceBase}/api/projects`)).status, 401)
      assert.equal((await fetch(`${deviceBase}/api/projects`, { headers: { Cookie: 'shadow-session=old-browser-session' } })).status, 401)
      assert.equal((await fetch(`${deviceBase}/`)).status, 401)
      for (const [path, method] of [['/api/web-auth/session', 'GET'], ['/api/web-auth/pair', 'POST'], ['/local/v1/web-pairing', 'POST']]) {
        assert.equal((await fetch(deviceBase + path, { method, headers: ownerHeaders })).status, 404)
      }
      assert.equal((await fetch(`${deviceBase}/cluster/v1/ui/request`, { method: 'POST' })).status, 401)
    } finally { await runtime.shutdown() }
  })
})
