import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { terminateProcessTree } from '../execution/processes/manager.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { startAppProcess, type AppProcess } from './process.ts'

test('Python app backends and isolated workers use explicit UTF-8 without relying on the Windows locale', async t => withTempWorkspace(async directory => {
  try { await promisify(childProcess.execFile)('python', ['--version']) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { t.skip('Python is not installed'); return }
    throw error
  }
  await writeFile(join(directory, 'server.py'), `
import http.server, json, os, sys
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        value = json.dumps({"utf8": sys.flags.utf8_mode, "text": "\\u4e2d\\u6587\\u65e5\\u672c\\u8a9e"}, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.end_headers()
        self.wfile.write(value)
http.server.HTTPServer(("127.0.0.1", int(os.environ["SHADOW_APP_PORT"])), Handler).serve_forever()
`)
  const run = await startAppProcess({ runtime: 'python', entry: 'server.py', args: [] }, directory, directory,
    'http://127.0.0.1:1', 'synthetic-app-token', AbortSignal.timeout(15000))
  try {
    assert.deepEqual(await (await fetch(run.origin + '/health')).json(), { utf8: 1, text: '\u4e2d\u6587\u65e5\u672c\u8a9e' })
    const isolated = await promisify(childProcess.execFile)('python', ['-I', '-X', 'utf8', '-c',
      'import sys; assert sys.flags.isolated == 1; assert sys.flags.utf8_mode == 1; print("\\u4e2d\\u6587\\u65e5\\u672c\\u8a9e")'],
    { env: { ...process.env, PYTHONUTF8: '0', PYTHONIOENCODING: 'ascii' }, encoding: 'utf8', timeout: 10000 })
    assert.equal(isolated.stdout.trim(), '\u4e2d\u6587\u65e5\u672c\u8a9e')
  } finally { await run.stop() }
}))

test('startup recognizes split dependency signatures after large output without exposing payloads or tokens', async () => withTempWorkspace(async directory => {
  const secret = 'synthetic-sensitive-payload'
  await writeFile(join(directory, 'server.mjs'), `
    const prefix = '${secret}'.repeat(20000) + process.env.SHADOW_APP_TOKEN + '\\nModuleNotFound';
    process.stderr.write(prefix, () => setTimeout(() =>
      process.stderr.write('Error: private-package-name\\n', () => process.exit(7)), 30));
  `)
  await assert.rejects(startAppProcess({ runtime: 'node', entry: 'server.mjs', args: [] }, directory, directory,
    'http://127.0.0.1:1', 'synthetic-app-token', AbortSignal.timeout(15000)), error => {
    assert(error instanceof Error)
    assert.match(error.message, /code 7/)
    assert.match(error.message, /missing or unloadable dependency/)
    assert.doesNotMatch(error.message, /synthetic-sensitive-payload|synthetic-app-token|private-package-name/)
    assert.ok(error.message.length < 500)
    return true
  })
}))

test('native syntax errors produce a fixed hint rather than the source line from stderr', async () => withTempWorkspace(async directory => {
  await writeFile(join(directory, 'server.mjs'), 'const payload = "synthetic-source-secret"; const invalid = ;')
  await assert.rejects(startAppProcess({ runtime: 'node', entry: 'server.mjs', args: [] }, directory, directory,
    'http://127.0.0.1:1', 'synthetic-app-token', AbortSignal.timeout(15000)), error => {
    assert(error instanceof Error)
    assert.match(error.message, /invalid source syntax/)
    assert.doesNotMatch(error.message, /synthetic-source-secret|const payload|synthetic-app-token/)
    return true
  })
}))

test('startup inspection stops after readiness and a handled warning does not turn a healthy app into a failure', async () => withTempWorkspace(async directory => {
  await writeFile(join(directory, 'server.mjs'), `
    import {createServer} from 'node:http';
    process.stderr.write('SyntaxError: handled fixture warning\\n');
    createServer((_request,response)=>response.end('ready'))
      .listen(Number(process.env.SHADOW_APP_PORT),'127.0.0.1');
  `)
  const run = await startAppProcess({ runtime: 'node', entry: 'server.mjs', args: [] }, directory, directory,
    'http://127.0.0.1:1', 'synthetic-app-token', AbortSignal.timeout(15000))
  try {
    assert.equal(run.error, undefined)
    assert.equal(run.child.stderr!.listenerCount('data'), 0)
  } finally { await run.stop() }
}))

test('backend termination can be retried after a failed attempt instead of caching the rejection forever', async () => {
  await withTempWorkspace(async directory => {
    const data = join(directory, 'data')
    await mkdir(data)
    await writeFile(join(directory, 'server.mjs'), `
      import {createServer} from 'node:http';
      createServer((_request,response)=>response.end('ready'))
        .listen(Number(process.env.SHADOW_APP_PORT),'127.0.0.1');
    `)
    let attempts = 0
    const process = await startAppProcess({ runtime: 'node', entry: 'server.mjs', args: [] }, directory, data,
      'http://127.0.0.1:1', 'synthetic-test-token', AbortSignal.timeout(20000), { terminate: async (...args) => {
        if (++attempts === 1) throw new Error('Synthetic termination failure')
        return terminateProcessTree(...args)
      } })
    try {
      await assert.rejects(process.stop(), /Synthetic termination failure/)
      assert.equal(process.child.exitCode, null)
      await Promise.all([process.stop(), process.stop()])
      assert.equal(attempts, 2)
      await process.exited
      assert.notEqual(process.child.exitCode ?? process.child.signalCode, null)
    } finally { await process.stop() }
  })

  test('the owner retains a backend when cancellation during startup cannot finish cleanup', async () => {
    await withTempWorkspace(async directory => {
      const data = join(directory, 'data')
      await mkdir(data)
      await writeFile(join(directory, 'server.mjs'), 'setInterval(()=>{},1000)')
      const controller = new AbortController()
      const owner: { backend?: AppProcess } = {}
      let attempts = 0
      try {
        await assert.rejects(startAppProcess({ runtime: 'node', entry: 'server.mjs', args: [] }, directory, data,
          'http://127.0.0.1:1', 'synthetic-test-token', controller.signal, {
            onStarted: backend => { owner.backend = backend; controller.abort(new Error('Cancel startup')) },
            terminate: async (...args) => {
              if (++attempts === 1) throw new Error('Synthetic startup cleanup failure')
              return terminateProcessTree(...args)
            },
          }), /Synthetic startup cleanup failure/)
        assert.ok(owner.backend)
        assert.equal(owner.backend.child.exitCode, null)
        await owner.backend.stop()
        assert.equal(attempts, 2)
        await owner.backend.exited
        assert.notEqual(owner.backend.child.exitCode ?? owner.backend.child.signalCode, null)
      } finally { await owner.backend?.stop() }
    })

    test('a missing executable reports startup failure without making cleanup permanently fail', async t => {
      await withTempWorkspace(async directory => {
        const original = childProcess.spawn
        const mocked = t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof original>) =>
          original(join(directory, 'missing-runtime'), args[1], args[2]))
        syncBuiltinESMExports()
        const owner: { backend?: AppProcess } = {}
        try {
          await assert.rejects(startAppProcess({ runtime: 'node', entry: 'server.mjs', args: [] }, directory, directory,
            'http://127.0.0.1:1', 'synthetic-test-token', AbortSignal.timeout(10000),
            { onStarted: backend => { owner.backend = backend } }), /ENOENT/)
          assert.ok(owner.backend)
          assert.equal(owner.backend.child.pid, undefined)
          assert.match(owner.backend.error!, /ENOENT/)
          await owner.backend.stop()
          assert.equal((await owner.backend.exited).success, false)
        } finally {
          mocked.mock.restore()
          syncBuiltinESMExports()
          await owner.backend?.stop()
        }
      })
    })
  })
})
