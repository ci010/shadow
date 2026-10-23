import assert from 'node:assert/strict'
import test from 'node:test'
import { open, mkdir, readFile, readdir, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { copyUserProfile } from './profile-copy.ts'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { validateManagedBrowser } from './managed-browsers.ts'
import { superviseChromeChild, nativeChromeRuntime, SharedChrome, type ManagedChromeChoice, type ManagedChromeProcess, type SharedChromeRuntime } from './shared-chrome.ts'

export async function syntheticChrome(home: string) {
  const source = join(home, 'source')
  await mkdir(join(source, 'Default'), { recursive: true })
  await mkdir(join(source, 'Profile 1'))
  await mkdir(join(source, 'Default', 'Cache'))
  await writeFile(join(source, 'Default', 'Preferences'), 'synthetic-preferences')
  await writeFile(join(source, 'Default', 'Cache', 'unused'), 'cache')
  await writeFile(join(source, 'Profile 1', 'Preferences'), 'other-profile')
  await writeFile(join(source, 'Local State'), 'opaque-synthetic-local-state')
  const executablePath = join(home, 'fake-chrome')
  await writeFile(executablePath, 'never-executed')
  const choice: ManagedChromeChoice = { browser: 'chrome', executablePath, userDataDir: source, profileDirectory: 'Default' }
  const processes: (ManagedChromeProcess & { exited: boolean; args: string[]; stops: number })[] = []
  const runtime: SharedChromeRuntime = {
    async validateExecutable() {}, // synthetic process boundary; never execute the fixture file
    launch(_path, args) {
      const process = { exited: false, args, stops: 0, async stop() { this.stops++; this.exited = true } }
      processes.push(process)
      return process
    },
    async endpoint() { return `ws://127.0.0.1:${9500 + processes.length}/devtools/browser/synthetic` },
  }
  return { source, choice, processes, runtime, manager: new SharedChrome(join(home, 'managed'), runtime) }
}

test('one copied-profile process per Project, concurrent initialization deduplicated; crash reuses copy', async () => withTempWorkspace(async home => {
  const f = await syntheticChrome(home)
  const endpoints = await Promise.all(Array.from({ length: 12 }, () => f.manager.ensure(f.choice)))
  assert.equal(new Set(endpoints).size, 1)
  assert.equal(f.processes.length, 1)
  const args = f.processes[0].args
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'))
  assert.ok(args.includes('--remote-debugging-port=0'))
  assert.ok(args.includes('--disable-sync'))
  assert.ok(args.includes('--disable-extensions'))
  const directory = args.find(arg => arg.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length)
  assert.notEqual(directory, f.source)
  assert.equal(await readFile(join(directory, 'Default', 'Preferences'), 'utf8'), 'synthetic-preferences')
  assert.equal(await readFile(join(directory, 'Local State'), 'utf8'), 'opaque-synthetic-local-state')
  assert.deepEqual((await readdir(directory)).sort(), ['Default', 'Local State'])
  assert.deepEqual(await readdir(join(directory, 'Default')), ['Preferences'])
  await writeFile(join(directory, 'Default', 'Preferences'), 'managed-user-changes')
  f.processes[0].exited = true
  await f.manager.ensure(f.choice)
  assert.equal(f.processes.length, 2)
  assert.deepEqual(f.processes[1].args, args)
  assert.equal(await readFile(join(directory, 'Default', 'Preferences'), 'utf8'), 'managed-user-changes')
  assert.equal(await readFile(join(f.source, 'Default', 'Preferences'), 'utf8'), 'synthetic-preferences')
  await assert.rejects(f.manager.ensure({ ...f.choice, profileDirectory: 'Profile 1' }), /already selected/)
  await f.manager.shutdown()
  assert.equal(f.processes[1].stops, 1)
  await assert.rejects(f.manager.ensure(f.choice), /closed/)
  assert.equal(await readFile(join(directory, 'Default', 'Preferences'), 'utf8'), 'managed-user-changes')
}))

test('separate Project managers never share processes or overwrite old copies', async () => withTempWorkspace(async home => {
  const f = await syntheticChrome(home)
  const second = new SharedChrome(join(home, 'other-project'), f.runtime)
  await Promise.all([f.manager.ensure(f.choice), second.ensure(f.choice)])
  assert.equal(f.processes.length, 2)
  assert.notDeepEqual(f.processes[0].args, f.processes[1].args)
  await f.manager.shutdown()
  assert.equal(f.processes.find(process => process.args.some(arg => arg.includes('other-project')))!.stops, 0)
  await second.shutdown()
  const restart = new SharedChrome(join(home, 'managed'), f.runtime)
  await restart.ensure(f.choice)
  assert.equal((await readdir(join(home, 'managed'))).length, 2)
  await restart.shutdown()
}))

test('copy ignores runtime lock markers but refuses missing source/existing destination and does not remove user data', async () => withTempWorkspace(async home => {
  const f = await syntheticChrome(home)
  const destination = join(home, 'copy')
  await mkdir(destination)
  await writeFile(join(destination, 'keep'), 'user-data')
  await assert.rejects(copyUserProfile(f.choice, destination), /copy failed/)
  assert.equal(await readFile(join(destination, 'keep'), 'utf8'), 'user-data')
  await writeFile(join(f.source, 'SingletonLock'), 'synthetic-lock')
  await f.manager.ensure(f.choice)
  assert.equal(f.processes.length, 1)
  await f.manager.shutdown()
  assert.equal(await readFile(join(f.source, 'SingletonLock'), 'utf8'), 'synthetic-lock')
  await assert.rejects(copyUserProfile({ ...f.choice, userDataDir: join(home, 'absent') }, join(home, 'missing-copy')), /copy failed/)
  await assert.rejects(copyUserProfile({ ...f.choice, profileDirectory: '../Default' }, join(home, 'bad')), /Select an absolute/)
  await assert.rejects(copyUserProfile(f.choice, join(f.source, 'nested')), /copy failed/)
}))

test('shutdown during initialization stops only the managed child and publishes no late endpoint', async () => withTempWorkspace(async home => {
  const f = await syntheticChrome(home)
  const started = Promise.withResolvers<void>()
  f.runtime.endpoint = async (_dir, _process, signal) => {
    started.resolve()
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    return 'never'
  }
  const pending = f.manager.ensure(f.choice)
  const rejected = assert.rejects(pending, /closed/)
  await started.promise
  await f.manager.shutdown()
  await rejected
  assert.equal(f.processes[0].exited, true)
}))

test('unusable or non-loopback endpoint cannot be published; retry keeps existing copy', async () => withTempWorkspace(async home => {
  const f = await syntheticChrome(home)
  f.runtime.endpoint = async () => 'ws://example.com:9222/devtools/browser/test'
  await assert.rejects(f.manager.ensure(f.choice), /loopback/)
  assert.equal(f.processes[0].exited, true)
  f.runtime.endpoint = async () => 'ws://127.0.0.1:9555/devtools/browser/test'
  await f.manager.ensure(f.choice)
  assert.deepEqual(f.processes[0].args, f.processes[1].args)
  await f.manager.shutdown()
}))

test('selected profile links are rejected without reading outside data or damaging destination', async () => withTempWorkspace(async home => {
  const f = await syntheticChrome(home)
  const outside = join(home, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'keep'), 'synthetic-external-data')
  await symlink(outside, join(f.source, 'Default', 'Network'), 'junction')
  const report = await copyUserProfile(f.choice, join(home, 'copy'))
  assert.ok(report.warnings.some(w => w.code === 'UNSUPPORTED_OR_LINKED_ENTRY'))
  assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'synthetic-external-data')
  assert.equal(await readFile(join(home, 'copy', 'Local State'), 'utf8'), 'opaque-synthetic-local-state')
  await rm(join(f.source, 'Default', 'Network'))
}))

test('native endpoint discovery reads only synthetic managed file, validates port/path, and observes cancellation/exit', async () => withTempWorkspace(async home => {
  const process = { exited: false, async stop() {} }
  await writeFile(join(home, 'DevToolsActivePort'), '9510\n/devtools/browser/synthetic-id\n')
  assert.equal(await nativeChromeRuntime.endpoint(home, process, new AbortController().signal), 'ws://127.0.0.1:9510/devtools/browser/synthetic-id')
  process.exited = true
  await assert.rejects(nativeChromeRuntime.endpoint(home, process, new AbortController().signal), /exited/)
  process.exited = false
  await writeFile(join(home, 'DevToolsActivePort'), '65536\n//external-host/path\n')
  const controller = new AbortController()
  const pending = nativeChromeRuntime.endpoint(home, process, controller.signal)
  controller.abort()
  await assert.rejects(pending, /abort/i)
}))
test('native child kill errors never certify exit or permit a replacement', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 12345, kill(this: EventEmitter) { this.emit('error', new Error('synthetic-kill-failure')); return false } })
  const managed = superviseChromeChild(child as unknown as ChildProcess)
  await assert.rejects(managed.stop(), /exit is unconfirmed/)
  assert.equal(managed.exited, false)
  child.emit('exit', 0)
  assert.equal(managed.exited, true)
  await managed.stop()
})

test('native validator refuses arbitrary executable without launching it', async () => withTempWorkspace(async home => {
  const path = join(home, 'not-a-browser.exe')
  await writeFile(path, 'synthetic')
  await assert.rejects(validateManagedBrowser(path, 'chrome', home), /recognized installation/)
}))
for (const browser of ['chrome', 'edge', 'brave', 'chromium'] as const) {
  test(`${browser}: managed selection is preserved at validation and launch, never substitutes Chrome`, async () => withTempWorkspace(async home => {
    const f = await syntheticChrome(home)
    const choice = { ...f.choice, browser }
    let validated = false
    f.runtime.validateExecutable = async (path, family, source) => {
      assert.equal(path, choice.executablePath)
      assert.equal(family, browser)
      assert.equal(source, choice.userDataDir)
      validated = true
    }
    const launch = f.runtime.launch
    f.runtime.launch = (path, args) => { assert.ok(validated); assert.equal(path, choice.executablePath); return launch(path, args) }
    await f.manager.ensure(choice)
    await assert.rejects(f.manager.ensure({ ...choice, browser: browser === 'edge' ? 'chrome' : 'edge' }), /already selected/)
    await f.manager.shutdown()
  }))
}

test('installation/source validation failure happens before any copy or process launch', async () => withTempWorkspace(async home => {
  const f = await syntheticChrome(home)
  f.runtime.validateExecutable = async () => { throw new Error('synthetic mismatched browser source') }
  await assert.rejects(f.manager.ensure(f.choice), /mismatched browser source/)
  assert.equal(f.processes.length, 0)
  await assert.rejects(readdir(join(home, 'managed')), { code: 'ENOENT' })
  assert.equal(await readFile(join(f.source, 'Default', 'Preferences'), 'utf8'), 'synthetic-preferences')
}))

for (const all of [false, true]) test(`source failures still launch and original report survives reuse/restart: all=${all}`, async () => withTempWorkspace(async home => {
  const f = await syntheticChrome(home)
  let attempts = 0
  f.runtime.copyOperations = { open: async (path, flags, mode) => {
    if (flags === 'r') {
      attempts++
      if (all || String(path).endsWith('Local State')) throw Object.assign(new Error('private'), { code: 'EBUSY' })
    }
    return open(path, flags, mode)
  } }
  await f.manager.ensure(f.choice)
  const report = f.manager.copyReport()
  assert.equal(f.processes.length, 1)
  assert.equal(report?.status, 'ready_with_warnings')
  assert.ok(report?.warnings.some(w => w.item === 'Local State' && w.osCode === 'EBUSY'))
  if (all) { assert.equal(report?.copiedFiles, 0); assert.match(report!.message, /No login data was migrated/) }
  const originalAttempts = attempts
  await f.manager.ensure(f.choice)
  f.processes[0].exited = true
  await f.manager.ensure(f.choice)
  assert.deepEqual(f.manager.copyReport(), report)
  assert.equal(attempts, originalAttempts)
  await f.manager.shutdown()
}))
test('cancelled source copy never launches browser', async () => withTempWorkspace(async home => {
  const f = await syntheticChrome(home), controller = new AbortController()
  f.runtime.copyOperations = { open: async (path, flags, mode) => { controller.abort(); return open(path, flags, mode) } }
  await assert.rejects(f.manager.ensure(f.choice, controller.signal), /abort/i)
  assert.equal(f.processes.length, 0)
  await f.manager.shutdown()
}))
