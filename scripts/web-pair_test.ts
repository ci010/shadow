import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createWebPairing, loadPairConnection, parsePairArguments, runWebPair } from './web-pair.ts'
import { DesktopConnectionStore } from '../desktop/src/control/publication.ts'
import {
  assertProtectedWindowsFile, dpapi, parseConnectionDescriptor, readBoundedLocalFile,
  requireLoopbackOrigin,
} from '../desktop/src/control/connection.ts'

const apiBase = 'http://127.0.0.1:18800'
const token = 'synthetic-management-credential_'.padEnd(43, 'a')
const connection = resolve('scripts', 'fixtures', 'connection.json')
const credentialPath = resolve('scripts', 'fixtures', 'launch-token')

test('runtime pairing help requires no credential or configuration access', async () => {
  for (const flag of ['--help', '-h']) {
    const output: string[] = []
    await runWebPair([flag], (text) => output.push(text))
    assert.equal(output.length, 1)
    assert.match(output[0]!, /web pair --connection/)
    assert.match(output[0]!, /--credential-file/)
    assert.ok(!output[0]!.includes(token))
  }
})

test('CLI requires one explicit local source and never accepts credential arguments', () => {
  assert.deepEqual(parsePairArguments(['--connection', connection]), { connection })
  assert.deepEqual(parsePairArguments(['--url', `${apiBase}/`, '--credential-file', credentialPath]), { url: apiBase, credentialFile: credentialPath })
  for (const args of [
    [], ['--connection'], ['--connection', 'relative'], ['--url', apiBase],
    ['--connection', connection, '--url', apiBase],
    ['--connection', connection, '--connection', connection],
    ['--token', token], ['--url', apiBase, '--credential', token],
  ]) assert.throws(() => parsePairArguments(args), (error: Error) => !error.message.includes(token))
})

test('loopback targets are canonical literal HTTP origins without URLs carrying secrets', () => {
  assert.equal(requireLoopbackOrigin('http://[::1]:3123'), 'http://[::1]:3123')
  for (const url of [
    'https://127.0.0.1:3123', 'http://localhost:3123', 'http://127.1:3123',
    'http://2130706433:3123', 'http://example.com', 'http://0.0.0.0:3123',
    'http://127.0.0.1:3123/x', 'http://127.0.0.1:3123/?x=secret',
    'http://127.0.0.1:3123/#secret', 'http://secret@127.0.0.1:3123', 'http://127.0.0.1:3123/../',
  ]) assert.throws(() => requireLoopbackOrigin(url))
})

test('connection descriptors validate metadata, bounds, expiry, and protection scheme', () => {
  const now = Date.now()
  const descriptor = {
    version: 1, kind: 'desktop', apiBase, credentialPath,
    credentialProtection: 'windows-dpapi-current-user', expiresAt: new Date(now + 60_000).toISOString(),
  }
  assert.deepEqual(parseConnectionDescriptor(descriptor, now), descriptor)
  for (const patch of [
    { version: 2 }, { credentialProtection: 'plaintext' }, { credentialPath: 'relative' },
    { expiresAt: new Date(now).toISOString() }, { expiresAt: new Date(now + 600_000).toISOString() },
    { launchToken: token }, { apiBase: 'http://example.com' },
  ]) assert.throws(() => parseConnectionDescriptor({ ...descriptor, ...patch }, now))
  const service = { version: 1, serviceName: 'ShadowService', role: 'main', apiBase, port: 18800, credentialPath, configPath: connection }
  assert.deepEqual(parseConnectionDescriptor(service), service)
})

test('control file reads are bounded and redact failures', async (t) => {
  const directory = resolve('scripts', 'fixtures', `web-pair-${randomUUID()}`)
  await mkdir(directory, { mode: 0o700 })
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'fixture')
  await writeFile(path, token, { mode: 0o600 })
  assert.equal((await readBoundedLocalFile(path)).toString(), token)
  await assert.rejects(readBoundedLocalFile(path, 10), /Invalid control file/)
  await assert.rejects(loadPairConnection({ connection: path }),
    (error: Error) => !error.message.includes(token) && error.message.includes('Cannot load'))
})

test('DPAPI sends material on stdin and exclusively uses CurrentUser scope', async () => {
  const input = Buffer.from(token)
  const ciphertext = Buffer.from('synthetic cipher')
  assert.deepEqual(await dpapi('Protect', input, async (script, stdin) => {
    assert.match(script, /::Protect\(/)
    assert.match(script, /::CurrentUser/)
    assert.doesNotMatch(script, /LocalMachine/)
    assert.ok(!script.includes(token))
    assert.equal(stdin, input.toString('base64'))
    return ciphertext.toString('base64')
  }), ciphertext)
  assert.deepEqual(await dpapi('Unprotect', ciphertext, async (script, stdin) => {
    assert.match(script, /::Unprotect\(/)
    assert.equal(stdin, ciphertext.toString('base64'))
    return input.toString('base64')
  }), input)
  await assert.rejects(dpapi('Unprotect', ciphertext, async () => 'invalid!'))
  await assertProtectedWindowsFile(credentialPath, async (script, stdin) => {
    assert.equal(stdin, credentialPath)
    assert.match(script, /GetAccessRules/)
    assert.match(script, /Broad ACL/)
    return 'ok'
  })
  await assert.rejects(assertProtectedWindowsFile(credentialPath, async () => ''))
})

test('pairing uses Bearer only over the selected origin, rejects redirects, prints only code and safe URL', async () => {
  const output = await createWebPairing({ apiBase, token }, async (input, init) => {
    assert.equal(input, `${apiBase}/local/v1/web-pairing`)
    assert.equal(init?.method, 'POST')
    assert.equal(init?.redirect, 'error')
    assert.deepEqual(init?.headers, { Authorization: `Bearer ${token}` })
    assert.ok(init?.signal)
    return Response.json({ version: 1, code: 'AB12-CD34-EF56-7890', expiresAt: new Date(Date.now() + 60_000).toISOString(), url: `${apiBase}/` })
  })
  assert.match(output, /Open http:\/\/127\.0\.0\.1:18800\//)
  assert.match(output, /One-use pairing code: AB12-CD34-EF56-7890/)
  assert.ok(!output.includes(token))
})

test('pairing errors never echo credentials, response text, or unsafe response URLs', async () => {
  for (const response of [
    () => new Response(token, { status: 403 }),
    () => new Response('', { status: 302, headers: { Location: 'http://example.com' } }),
    () => new Response('x'.repeat(4097)),
    () => Response.json({ version: 1, code: token, expiresAt: new Date(Date.now() + 60_000).toISOString(), url: apiBase }),
    () => Response.json({ version: 1, code: 'VALID-CODE', expiresAt: new Date(Date.now() + 60_000).toISOString(), url: `${apiBase}/#${token}` }),
    () => Response.json({ version: 1, code: 'VALID-CODE', expiresAt: new Date(Date.now() + 60_000).toISOString(), url: 'http://127.0.0.1:99' }),
    () => { throw new Error(token) },
  ]) await assert.rejects(createWebPairing({ apiBase, token }, async () => response()),
    (error: Error) => !error.message.includes(token) && error.message.startsWith('Could not create'))
})

test('CLI loads live desktop, service and explicit-file synthetic credentials without changing them', async (t) => {
  const directory = resolve('scripts', 'fixtures', `web-pair-${randomUUID()}`)
  await mkdir(directory, { mode: 0o700 })
  t.after(() => rm(directory, { recursive: true, force: true }))
  const publication = await new DesktopConnectionStore(directory).publish({ apiBase, launchToken: token })
  assert.deepEqual(await loadPairConnection({ connection: publication.path }), { apiBase, token })
  const plainPath = join(directory, 'control', 'web-access', 'service-token')
  const servicePath = join(directory, 'control', 'web-access', 'service.json')
  await writeFile(plainPath, token, { mode: 0o600 })
  await writeFile(servicePath, JSON.stringify({
    version: 1, serviceName: 'ShadowService', role: 'main', apiBase, port: 18800,
    credentialPath: plainPath, configPath: join(directory, 'unused-config.json'),
  }), { mode: 0o600 })
  assert.deepEqual(await loadPairConnection({ connection: servicePath }), { apiBase, token })
  assert.deepEqual(await loadPairConnection({ url: apiBase, credentialFile: plainPath }), { apiBase, token })
  await publication.remove()
})

test('runtime web pair entry bypasses config startup and emits only the browser pairing result', async (t) => {
  const directory = resolve('scripts', 'fixtures', `web-pair-entry-${randomUUID()}`)
  await mkdir(directory, { mode: 0o700 })
  t.after(() => rm(directory, { recursive: true, force: true }))
  let origin = ''
  let requests = 0
  const server = createServer((request, response) => {
    requests++
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/local/v1/web-pairing')
    assert.equal(request.headers.authorization, `Bearer ${token}`)
    assert.equal(request.headers.origin, undefined)
    assert.equal(request.headers['sec-fetch-site'], undefined)
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ version: 1, code: 'AB12-CD34-EF56-7890', expiresAt: new Date(Date.now() + 60_000).toISOString(), url: `${origin}/` }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  origin = `http://127.0.0.1:${address.port}`
  const publication = await new DesktopConnectionStore(directory).publish({ apiBase: origin, launchToken: token })
  const result = await promisify(execFile)(process.execPath, [
    '--import', import.meta.resolve('tsx'),
    fileURLToPath(new URL('../src/index.ts', import.meta.url)),
    'web', 'pair', '--connection', publication.path,
  ], {
    cwd: directory, timeout: 15_000, windowsHide: true,
    // This must not be read: web pair dispatch precedes service/config loading.
    env: { ...process.env, WINDOWS_USE_LAUNCH_TOKEN_FILE: join(directory, 'does-not-exist') },
  })
  assert.equal(requests, 1)
  assert.match(result.stdout, /One-use pairing code: AB12-CD34-EF56-7890/)
  assert.ok(result.stdout.includes(origin))
  assert.ok(!`${result.stdout}${result.stderr}`.includes(token))
  await publication.remove()
})
