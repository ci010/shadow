import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { sanitizeCpuProfile } from './startup-profile.ts'
import { consumeStartupProfileArm } from '../../scripts/startup-profile.ts'

async function fixture(): Promise<string> {
  await mkdir('.test-data', { recursive: true })
  return mkdtemp(resolve('.test-data/startup-profile-'))
}

test('one-shot capture is consumed only when enabled and never by a build', async () => {
  const root = await fixture()
  try {
    await mkdir(join(root, '.logs'))
    await writeFile(join(root, '.logs/startup-profile.arm'), '')
    assert.equal(consumeStartupProfileArm(root, { SHADOW_STARTUP_PROFILE: '0' }), undefined)
    assert.equal(consumeStartupProfileArm(root, {}), join(root, '.logs/startup-profiles'))
    assert.equal(consumeStartupProfileArm(root, {}), undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('CPU profile sanitizer keeps source symbols but drops paths and unexpected metadata', () => {
  const profile = sanitizeCpuProfile({ startTime: 1, endTime: 2, nodes: [{
    id: 1, hitCount: 2, children: [],
    callFrame: { functionName: 'secret/token=abc', scriptId: '1', url: 'file:///private/home/dist/src/runtime/main/host.js', lineNumber: 1, columnNumber: 2 },
    deoptReason: 'private payload',
  }, {
    id: 2, callFrame: { functionName: 'readFile', scriptId: '2', url: 'file:///private/config.json', lineNumber: 0, columnNumber: 0 },
  }] })
  assert.equal(profile.nodes[0].callFrame.url, 'dist/src/runtime/main/host.js')
  assert.equal(profile.nodes[0].callFrame.functionName, '(redacted)')
  assert.equal(profile.nodes[1].callFrame.url, '(external)')
  assert.doesNotMatch(JSON.stringify(profile), /private|secret|deoptReason/)
})

test('preload records before entry, saves CPU before forced kill, bounds retention and rejects payloads', { timeout: 20_000 }, async () => {
  const directory = await fixture()
  let child: ReturnType<typeof spawn> | undefined
  try {
    for (let i = 0; i < 4; i++) await mkdir(join(directory, `capture-100000000000${i}-1`))
    await writeFile(join(directory, 'unrelated.txt'), 'preserve')
    const moduleUrl = pathToFileURL(resolve('src/runtime/startup-profile.ts')).href
    child = spawn(process.execPath, ['--import', 'tsx', '--import', pathToFileURL(resolve('src/runtime/startup-profile-preload.ts')).href,
      '--input-type=module', '--eval', `
        const { profileStartupPhase, startupProjectOrdinal } = await import(${JSON.stringify(moduleUrl)});
        profileStartupPhase('host-catalog', 'started');
        profileStartupPhase('secret payload', 'started');
        profileStartupPhase('ownership-jsonl', 'completed', { projectOrdinal: startupProjectOrdinal('private-project-id'), count: 3 });
        setTimeout(() => console.log('checkpoint'), 2400);
        setInterval(() => { let n = 0; for (let i = 0; i < 100000; i++) n += Math.sqrt(i); }, 10);
      `], { env: { ...process.env, SHADOW_STARTUP_PROFILE_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr!.on('data', chunk => { stderr += String(chunk) })
    const exited = once(child, 'exit')
    const output = await Promise.race([once(child.stdout!, 'data'), exited.then(() => { throw new Error(`fixture exited: ${stderr}`) })])
    assert.match(String(output[0]), /checkpoint/)
    child.kill('SIGKILL')
    await exited
    const dirs = (await readdir(directory)).filter(name => name.startsWith('capture-'))
    assert.equal(dirs.length, 3)
    const current = dirs.sort().at(-1)!
    const files = await readdir(join(directory, current))
    assert.ok(files.includes('cpu-1.cpuprofile'), 'CPU chunk must survive forced termination')
    const phases = await readFile(join(directory, current, 'phases.jsonl'), 'utf8')
    const entries = phases.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(entries[0].phase, 'bootstrap')
    assert.ok(entries.find(entry => entry.phase === 'host-catalog'))
    assert.ok(entries.find(entry => entry.phase === 'ownership-jsonl' && entry.projectOrdinal === 1 && entry.count === 3))
    assert.doesNotMatch(phases, /private-project-id|secret payload/)
    assert.equal(typeof entries[0].cpuUserUs, 'number')
    assert.equal(await readFile(join(directory, 'unrelated.txt'), 'utf8'), 'preserve')
  } finally {
    child?.kill('SIGKILL')
    await rm(directory, { recursive: true, force: true })
  }
})
