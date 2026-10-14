import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

// Opt-in: starts only a disposable Electron main and synthetic utility child.
// No Shadow main/backend entry, config, data, listeners or existing processes.
test('real Electron utility fork runs compiled profiling preload before entry', {
  skip: process.env.SHADOW_TEST_ELECTRON_UTILITY_PROFILE !== '1', timeout: 30_000,
}, async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const temporary = join(root, '.tmp')
  await mkdir(temporary, { recursive: true })
  const directory = await mkdtemp(join(temporary, 'utility-profile-smoke-'))
  const profiles = join(directory, 'profiles')
  const entry = join(directory, 'synthetic.mjs')
  const main = join(directory, 'main.mjs')
  const result = join(directory, 'entry.json')
  const preload = join(root, 'dist/src/runtime/startup-profile-preload.js')
  // Use the actual built backend preload, not an Electron-as-Node substitute.
  try {
    await readFile(preload)
    await writeFile(entry, `
      import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const directory = process.env.SHADOW_STARTUP_PROFILE_DIR;
      const capture = readdirSync(directory).find(name => name.startsWith('capture-'));
      const phases = readFileSync(join(directory, capture, 'phases.jsonl'), 'utf8');
      if (!phases.includes('bootstrap')) throw new Error('Preload did not precede entry');
      writeFileSync(${JSON.stringify(result)}, JSON.stringify({argv: process.argv.slice(2), execArgv: process.execArgv, electron: process.versions.electron}));
      let calls = 0;
      export function runRootProcessEntry() {
      if (++calls !== 1 || import.meta.main) throw new Error('Duplicate or automatic entry dispatch');
      const report = JSON.parse(readFileSync(${JSON.stringify(result)}, 'utf8'));
      writeFileSync(${JSON.stringify(result)}, JSON.stringify({ ...report, calls, entry: process.argv[1], main: import.meta.main }));
      const until = Date.now() + 100;
      while (Date.now() < until) Math.sqrt(Math.random());
      setTimeout(() => process.exit(0), 2300);
      }
    `)
    await build({
      stdin: { contents: `
        import { app, utilityProcess } from 'electron';
        import { createUtilityProcessSpawn } from './utility-process.ts';
        app.setPath('userData', ${JSON.stringify(join(directory, 'user-data'))});
        app.whenReady().then(() => {
          const child = createUtilityProcessSpawn((...args) => utilityProcess.fork(...args))('unused',
            ['--import', process.env.SMOKE_FAIL_PRELOAD ? 'file:///missing-synthetic-preload.js' : ${JSON.stringify(pathToFileURL(preload).href)}, ${JSON.stringify(entry)}, 'synthetic', '--config', 'not-read.json'],
            { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SHADOW_STARTUP_PROFILE_DIR: ${JSON.stringify(profiles)} } });
          child.stdout.on('data', data => process.stdout.write(data));
          child.stderr.on('data', data => process.stderr.write(data));
          child.once('error', () => app.exit(1));
          child.once('exit', code => app.exit(code ?? 1));
        }).catch(error => { console.error(error); app.exit(1); });
      `, resolveDir: dirname(fileURLToPath(import.meta.url)), sourcefile: 'smoke-main.ts' },
      bundle: true, platform: 'node', format: 'esm', external: ['electron'], outfile: main,
    })
    await writeFile(join(directory, 'utility-profile-bootstrap.js'), await readFile(join(root, 'desktop/dist/utility-profile-bootstrap.js')))
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }))
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    const executable = createRequire(import.meta.url)('electron') as string
    const child = spawn(executable, [main], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const timer = setTimeout(() => child.kill(), 20_000)
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', resolve)
      })
      assert.equal(code, 0, output)
    } finally { clearTimeout(timer) }
    const report = JSON.parse(await readFile(result, 'utf8'))
    assert.ok(report.electron)
    assert.deepEqual(report.argv, ['synthetic', '--config', 'not-read.json'])
    assert.deepEqual(report.execArgv, [])
    assert.equal(report.calls, 1)
    assert.equal(report.entry, entry)
    assert.equal(report.main, false)
    const captures = await readdir(profiles)
    assert.equal(captures.length, 1)
    const capture = join(profiles, captures[0]!)
    const phases = (await readFile(join(capture, 'phases.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(phases[0].phase, 'bootstrap')
    assert.ok(phases.some(record => record.phase === 'cpu-chunk' && record.status === 'completed'))
    const cpuFiles = (await readdir(capture)).filter(name => name.endsWith('.cpuprofile'))
    assert.ok(cpuFiles.length >= 1)
    const cpu = JSON.parse(await readFile(join(capture, cpuFiles[0]!), 'utf8'))
    assert.ok(cpu.nodes.length > 0)
    assert.ok(cpu.samples.length > 0)
    console.log(`Electron ${report.electron}: preload before entry; ${cpuFiles.length} CPU chunk(s), ${phases.length} phase records`)
    await rm(result)
    const failed = spawn(executable, [main], { env: { ...env, SMOKE_FAIL_PRELOAD: '1' }, stdio: 'ignore' })
    const failureTimer = setTimeout(() => failed.kill(), 10_000)
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        failed.once('error', reject)
        failed.once('exit', resolve)
      })
      assert.equal(code, 1, 'bootstrap preload failure must exit nonzero')
      await assert.rejects(readFile(result), { code: 'ENOENT' })
    } finally { clearTimeout(failureTimer) }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
