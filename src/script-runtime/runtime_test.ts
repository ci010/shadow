import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { compileBackend } from '../../scripts/backend-bundle.ts'
import { executeScript, ScriptCallError, startScript, type ScriptOptions } from './runtime.ts'
import { encodeJson } from './json-boundary.ts'
import { assertImportPolicy, importedModules } from './module-policy.ts'

const execute = (code: string, options: Partial<ScriptOptions> = {}) => executeScript({
  code, args: {}, entry: 'run', policy: { kind: 'restricted', imports: [] },
  signal: new AbortController().signal, ...options,
})
const restricted = (imports: string[], mode: 'live' | 'test' | 'probe' = 'live') =>
  ({ kind: 'restricted', imports, mode }) as const
const host = { kind: 'host' } as const

test('shared worker copies JSON and offers no restricted host globals', async () => {
  const args = { nested: { value: 2 } }
  assert.deepEqual((await execute(`
    export function run(args) { args.nested.value++; return args; }
  `, { args })).value, { nested: { value: 3 } })
  assert.equal(args.nested.value, 2)
  assert.deepEqual((await execute(`export default () =>
    [typeof process, typeof require, typeof fetch, typeof console, typeof setTimeout, typeof Buffer];
  `)).value, Array(6).fill('undefined'))
  assert.equal((await execute('export const run = (x: number): number => x + 1', {
    filename: 'entry.ts', args: 2,
  })).value, 3)
  await assert.rejects(execute('export const run = () => undefined'), /invalid_json/)
  await assert.rejects(execute('export const main = () => 1'), /invalid_entry/)
})

test('exact restricted imports, including caught dynamic denials, are enforced', async () => {
  for (const mode of ['live', 'test', 'probe'] as const) {
    assert.equal((await execute(`
      import { basename } from 'node:path';
      export async function run() {
        const [a, b] = await Promise.all([import('node:path'), import('node:path')]);
        return a === b && basename('/a/b') === 'b';
      }
    `, { policy: restricted(['node:path'], mode) })).value, true)
  }
  for (const specifier of ['node:fs', 'path', 'node:path/posix', 'tsx', './fixture.js', 'file:///fixture.js', 'data:text/javascript,export default 1']) {
    await assert.rejects(execute(`import x from ${JSON.stringify(specifier)}; export const run = () => 1`, {
      policy: restricted(['node:path']),
    }), /import_denied/)
  }
  for (const body of [
    `try { await import('node:fs'); } catch {} return true`,
    `import('node:fs').catch(() => {}); return true`,
  ]) {
    await assert.rejects(execute(`export async function run() { ${body} }`), /import_denied/)
  }
  for (const mode of ['test', 'probe'] as const) {
    await assert.rejects(execute('export const run = () => 1', {
      policy: restricted(['node:fs'], mode),
    }), /effectsful/)
  }
  assert.throws(() => assertImportPolicy(['node:path'], []), /not allowed/)
  assert.throws(() => assertImportPolicy(['node:path', 'node:path'], ['node:path']), /Duplicate/)
  assert.deepEqual(importedModules(['node:path', '@shadow/read']), ['read'])
})

test('virtual modules use the same JSON broker in live/test and abort broker work on completion', async () => {
  const code = `
    import lookup, { call } from '@shadow/lookup';
    const first = await lookup({ value: 1 });
    export async function run(args) { return [first, await call(args)]; }
  `
  for (const mode of ['live', 'test'] as const) {
    const signals: AbortSignal[] = []
    assert.deepEqual((await execute(code, {
      args: { value: 2 }, policy: restricted(['@shadow/lookup'], mode),
      callModule: async (name, input, signal) => {
        assert.equal(name, 'lookup')
        assert.equal(signal.aborted, false)
        signals.push(signal)
        return input.value
      },
    })).value, [1, 2])
    assert.ok(signals.every(signal => signal.aborted))
  }
  for (const [error, expected] of [
    [new Error('synthetic-secret'), /capability_failed/],
    [new ScriptCallError('http_status', 'synthetic-secret', 429), /http_status HTTP 429/],
    [new ScriptCallError('synthetic-secret', 'synthetic-secret'), /capability_failed/],
  ] as const) {
    await assert.rejects(execute(code, {
      policy: restricted(['@shadow/lookup']),
      callModule: async () => { throw error },
    }), error => {
      assert.match(String(error), expected)
      assert.doesNotMatch(String(error), /synthetic-secret/)
      return true
    })

  }
  await assert.rejects(execute(`
    import call from '@shadow/lookup';
    export async function run() { try { await call({}); } catch {} return true }
  `, { policy: restricted(['@shadow/lookup']), maxCalls: 0 }), /capability_limit/)
  await assert.rejects(execute(`
    import call from '@shadow/lookup';
    export async function run() { try { await call({ value: undefined }); } catch {} return true }
  `, { policy: restricted(['@shadow/lookup']) }), /invalid_json/)
})

test('guest catch handlers receive safe broker code/status without private host messages', async () => {
  for (const mode of ['live', 'test', 'probe'] as const) {
    const result = await execute(`
      import call from '@shadow/lookup';
      export async function run() {
        try { await call({}); } catch (error) {
          return {code:error.code, status:error.status, message:error.message};
        }
      }
    `, {
      policy: restricted(['@shadow/lookup'], mode),
      callModule: async () => { throw new ScriptCallError('http_status', 'PRIVATE_HOST_SECRET', 403) },
    })
    assert.deepEqual(result.value, { code: 'http_status', status: 403, message: 'Script module call failed: http_status HTTP 403.' })
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_HOST_SECRET/)
  }
})

test('ordinary tool module names retain uppercase, MCP separators and longer names', async () => {
  const name = `MCP__Server__${'Tool'.repeat(40)}`
  const code = `import call from '@shadow/${name}'; export const run = () => call({ value: 7 })`
  for (const policy of [restricted([`@shadow/${name}`]), host]) {
    assert.equal((await execute(code, {
      policy, toolNames: [name], callModule: async (actual, input) => {
        assert.equal(actual, name)
        return input.value
      },
    })).value, 7)
  }
  await assert.rejects(execute('export const run = () => 1', {
    policy: restricted([`@shadow/${'x'.repeat(257)}`]),
  }))
})

test('JSON boundary rejects getters, proxies, cycles, large and nonfinite data', async () => {
  let touched = false
  for (const value of [
    { get value() { touched = true; return 1 } }, new Proxy({}, { ownKeys() { touched = true; return [] } }),
    { value: Infinity }, { value: undefined }, { value: 1n }, new Date(), Array(2),
    'x'.repeat(256 * 1024),
  ]) assert.throws(() => encodeJson(value, 'test'))
  assert.equal(touched, false)
  for (const expression of [
    'NaN', 'new Date()', '({ get value() { throw Error("synthetic-secret") } })',
    'new Proxy({}, {})', '(()=>{const x = {}; x.x = x; return x})()',
  ]) await assert.rejects(execute(`export const run = () => ${expression}`), /invalid_json/)
  await assert.rejects(execute('export const run = () => { throw Error("synthetic-secret") }'), error => {
    assert.doesNotMatch(String(error), /synthetic-secret/)
    return true
  })
})

test('test mode exposes bounded guest diagnostics but never broker exceptions', async () => {
  await assert.rejects(execute('export function run( {', {
    policy: restricted([], 'test'),
  }), /guest_failed: SyntaxError:/)
  await assert.rejects(execute('export const run = () => missingValue', {
    policy: restricted([], 'test'),
  }), /ReferenceError: missingValue/)
  await assert.rejects(execute(`export const run = () => { throw Error('x'.repeat(10000)) }`, {
    policy: restricted([], 'test'),
  }), error => {
    assert.ok((error as Error).message.length < 4200)
    return true
  })
  for (const mode of ['live', 'probe'] as const) {
    await assert.rejects(execute(`export const run = () => { throw Error('synthetic-secret') }`, {
      policy: restricted([], mode),
    }), error => {
      assert.doesNotMatch(String(error), /synthetic-secret/)
      assert.match(String(error), /guest_failed/)
      return true
    })
  }
  await assert.rejects(execute(`import call from '@shadow/lookup'; export const run = () => call({})`, {
    policy: restricted(['@shadow/lookup'], 'test'),
    callModule: async () => { throw new SyntaxError('synthetic-broker-secret') },
  }), error => {
    assert.match(String(error), /capability_failed/)
    assert.doesNotMatch(String(error), /synthetic-broker-secret|SyntaxError/)
    return true
  })
})

test('host executes TS, native/local/npm imports, globals and virtual tool calls', async () => {
  const directory = join(process.cwd(), '.script-runtime-test-' + randomUUID())
  await mkdir(directory)
  try {
    await writeFile(join(directory, 'helper.ts'), 'export const value: number = 7')
    const result = await execute(`
      import { value } from './helper.ts';
      import { basename } from 'node:path';
      import { z } from 'zod';
      import lookup from '@shadow/lookup';
      console.log('hello');
      console.error('warning');
      export async function run(args: { name: string }) {
        const input = await lookup({ value });
        const second = await other({ value: input });
        return {
          value: z.number().parse(second),
          name: basename(args.name),
          env: process.env.SYNTHETIC_VALUE,
          nodeOptions: process.env.NODE_OPTIONS ?? null,
          globals: [typeof fetch, typeof setTimeout, Buffer.from('ok').toString()],
          helpers: await pipe('a\\nb\\n', lines, count)
        };
      }
    `, {
      policy: host, cwd: directory, filename: 'entry.ts', args: { name: '/a/b' },
      env: { SYNTHETIC_VALUE: 'explicit', NODE_OPTIONS: '--not-a-real-node-option' },
      toolNames: ['lookup', 'other'], callModule: async (_name, input) => input.value,
    })
    assert.deepEqual(result.value, {
      value: 7, name: 'b', env: 'explicit', nodeOptions: null,
      globals: ['function', 'function', 'ok'], helpers: 2,
    })
    assert.equal(result.stdout, 'hello\n')
    assert.equal(result.stderr, 'warning\n')
    await assert.rejects(execute('export const run = () => { throw Error("actionable host error") }', {
      policy: host,
    }), /actionable host error/)
    assert.equal((await execute('console.log("top-level");', { policy: host, entry: 'script' })).value, null)
    assert.equal((await execute('export const main = () => undefined', { policy: host, entry: 'script' })).value, null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('timeouts, cancellation, child exits and output floods settle after reaping', async () => {
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(execute('export const run = () => 1', { signal: aborted.signal }), /aborted/)
  await assert.rejects(execute('export const run = () => { while (true) {} }', { timeoutMs: 800 }), /deadline/)
  const run = startScript({
    code: 'setInterval(() => console.log("alive"), 20)',
    args: [], entry: 'script', policy: host, timeoutMs: null,
    signal: new AbortController().signal,
  })
  const rejected = assert.rejects(run.completion, /aborted/)
  for (let attempt = 0; attempt < 100 && !run.output().stdout.includes('alive'); attempt++) await delay(30)
  assert.match(run.output().stdout, /alive/)
  run.cancel()
  await rejected
  assert.throws(() => process.kill(run.pid!, 0))
  await assert.rejects(execute('process.exit(3)', { policy: host, entry: 'script' }), /without a result/)
  await assert.rejects(execute(`
    import fs from 'node:fs';
    export const run = () => { fs.writeSync(1, 'x'.repeat(100000)); return true }
  `, { policy: restricted(['node:fs']) }), /output limit/)
  const completed = startScript({
    code: 'setInterval(() => {}, 1000); export const run = () => 42',
    args: {}, entry: 'run', policy: host, signal: new AbortController().signal,
  })
  assert.equal((await completed.completion).value, 42)
  assert.throws(() => process.kill(completed.pid!, 0))
})

test('top-level host timers and detached calls drain before completion', async () => {
  const result = await execute(`
    setTimeout(() => console.log('timer done'), 50);
    lookup({}).then(value => console.log(value));
  `, {
    policy: host, entry: 'script', toolNames: ['lookup'],
    callModule: async () => { await delay(100); return 'call done' },
  })
  assert.match(result.stdout, /timer done/)
  assert.match(result.stdout, /call done/)
})

test('explicit successful host-script exits capture output and cancel outstanding tool calls', async () => {
  let brokerSignal: AbortSignal | undefined
  const result = await execute(`
    void lookup({});
    setTimeout(() => process.stdout.write('exiting', () => process.exit(0)), 100);
  `, {
    policy: host, entry: 'script', toolNames: ['lookup'],
    callModule: async (_name, _input, signal) => {
      brokerSignal = signal
      return new Promise(() => {})
    },
  })
  assert.equal(result.value, null)
  assert.equal(result.stdout, 'exiting')
  assert.equal(brokerSignal?.aborted, true)
  await assert.rejects(execute('process.exit(0)', { policy: host }), /without a result/)
})

test('host scripts can make more than 32 calls unless the caller sets a limit', async () => {
  const code = `
    export async function run() {
      for (let i = 0; i < 40; i++) await lookup({});
      return true;
    }
  `
  assert.equal((await execute(code, {
    policy: host, toolNames: ['lookup'], callModule: async () => null,
  })).value, true)
  await assert.rejects(execute(code, {
    policy: host, toolNames: ['lookup'], callModule: async () => null, maxCalls: 1,
  }), /capability_limit/)
})

test('host output capture stays bounded without stopping a logging daemon', async () => {
  let ready = false
  const run = startScript({
    code: `
      let count = 0;
      setInterval(() => {
        console.log('x'.repeat(8192));
        if (++count === 20) void report({});
      }, 2);
    `,
    args: {}, entry: 'script', policy: host, timeoutMs: null,
    signal: new AbortController().signal, toolNames: ['report'],
    callModule: async () => { ready = true; return null },
  })
  const completion = assert.rejects(run.completion, /aborted/)
  try {
    for (let attempt = 0; attempt < 100 && !ready; attempt++) await delay(30)
    assert.equal(ready, true)
    assert.equal(Buffer.byteLength(run.output().stdout), 64 * 1024)
  } finally {
    run.cancel()
    await completion
  }
})

test('host return and cancellation terminate native subprocess trees before settling', async () => {
  for (const cancel of [false, true]) {
    let descendant = 0
    const run = startScript({
      code: `
        import { spawn } from 'node:child_process';
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
        export async function run() {
          await report({pid: child.pid});
          ${cancel ? 'return new Promise(() => {})' : 'return true'}
        }
      `,
      args: {}, signal: new AbortController().signal, entry: 'run', policy: host,
      toolNames: ['report'], callModule: async (_name, input) => {
        descendant = Number(input.pid)
        return null
      },
    })
    const completion = cancel ? assert.rejects(run.completion, /aborted/) : run.completion
    if (cancel) {
      for (let attempt = 0; attempt < 100 && !descendant; attempt++) await delay(30)
      run.cancel()
    }
    await completion
    assert.ok(descendant > 0)
    assert.throws(() => process.kill(descendant, 0))
  }
})

test('restricted environment and launch flags never inherit Main secrets or NODE_OPTIONS', async () => {
  const previousSecret = process.env.SCRIPT_TEST_SECRET
  const previousOptions = process.env.NODE_OPTIONS
  process.env.SCRIPT_TEST_SECRET = 'synthetic-secret'
  process.env.NODE_OPTIONS = '--not-a-real-node-option'
  try {
    const result = (await execute(`
      import path from 'node:path';
      export function run() {
        const child = path.join.constructor('return process')();
        return { env: { ...child.env }, flags: child.execArgv };
      }
    `, { policy: restricted(['node:path']), env: { SCRIPT_TEST_SECRET: 'also ignored' } })).value as {
      env: Record<string, string>; flags: string[]
    }
    assert.ok(Object.keys(result.env).every(key =>
      ['SYSTEMROOT', 'WINDIR', 'TSX_DISABLE_CACHE', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase())))
    assert.ok(!result.flags.some(flag => flag.includes('--test') || flag.includes('--inspect')))
    assert.ok(result.flags.includes('--max-old-space-size=64'))
    const hostEnv = (await execute('export const run = () => ({ ...process.env })', { policy: host })).value
    assert.equal((hostEnv as Record<string, string>).SCRIPT_TEST_SECRET, undefined)
  } finally {
    if (previousSecret === undefined) delete process.env.SCRIPT_TEST_SECRET
    else process.env.SCRIPT_TEST_SECRET = previousSecret
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = previousOptions
  }
})

test('malformed IPC and timeout abort outstanding broker work and reap the child', async () => {
  await assert.rejects(execute(`
    process.send({ type: 'result', json: '{}', extra: 'invalid' });
    await new Promise(() => {});
  `, { policy: host, entry: 'script' }), /invalid IPC/)
  let signal: AbortSignal | undefined
  const run = startScript({
    code: `import lookup from '@shadow/lookup'; export const run = () => lookup({})`,
    policy: restricted(['@shadow/lookup']), args: {}, entry: 'run',
    signal: new AbortController().signal, timeoutMs: 1000,
    callModule: async (_name, _input, brokerSignal) => {
      signal = brokerSignal
      return new Promise(() => {})
    },
  })
  await assert.rejects(run.completion, /deadline/)
  assert.equal(signal?.aborted, true)
  assert.throws(() => process.kill(run.pid!, 0))
  await assert.rejects(execute('export const run = () => 1', {
    cwd: join(process.cwd(), '.missing-script-cwd-' + randomUUID()),
  }), /child process failed/)
})

test('compiled worker runs without tsx on plain Node and Electron RUN_AS_NODE', async () => {
  const directory = join(process.cwd(), '.script-runtime-compiled-' + randomUUID())
  await mkdir(directory)
  try {
    await compileBackend(process.cwd(), join(directory, 'compiled'), ['script-runtime/runtime', 'script-runtime/worker'])
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(join(directory, 'helper.ts'), 'export const value: number = 7')
    await writeFile(join(directory, 'smoke.mjs'), `
      import { executeScript } from './compiled/src/script-runtime/runtime.js';
      const signal = new AbortController().signal;
      const restricted = await executeScript({
        code: "import path from 'node:path'; import call from '@shadow/lookup'; export const run = () => call({value: path.basename('/a/b')})",
        args: {}, signal, entry: 'run', policy: {kind: 'restricted', imports: ['node:path', '@shadow/lookup']},
        callModule: async (_name, input) => input.value
      });
      const host = await executeScript({
        code: "import {value} from './helper.ts'; export const run = () => ({ value, flags: process.execArgv, electron: process.versions.electron ?? null })",
        args: {}, signal, entry: 'run', policy: {kind: 'host'}, filename: 'entry.ts', cwd: process.cwd()
      });
      console.log(JSON.stringify({restricted: restricted.value, host: host.value}));
    `)
    const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
    const electronPath = desktopRequire('electron') as string
    const electronVersion = (desktopRequire('electron/package.json') as { version: string }).version
    for (const [executable, version] of [
      [process.execPath, process.versions.electron ?? null], [electronPath, electronVersion],
    ] as const) {
      const { stdout } = await promisify(execFile)(executable, [join(directory, 'smoke.mjs')], {
        cwd: directory,
        env: { ...process.env, NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '1' },
        timeout: 20_000, windowsHide: true,
      })
      assert.deepEqual(JSON.parse(stdout), {
        restricted: 'b',
        host: {
          value: 7, electron: version,
          flags: ['--experimental-vm-modules', '--experimental-import-meta-resolve', '--no-warnings', '--max-old-space-size=64'],
        },
      })
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
