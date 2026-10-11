import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import test from 'node:test'
import { superviseDesktopDevelopment } from './desktop-development.ts'

function child() {
  const messages: unknown[] = []
  const emitter = Object.assign(new EventEmitter(), {
    connected: true,
    send(message: unknown, callback: () => void) { messages.push(message); callback() },
    kill() { queueMicrotask(() => emitter.emit('exit', null, 'SIGTERM')); return true },
  })
  return { process: emitter as unknown as ChildProcess, emitter, messages }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function fixture() {
  const vite = child(); const electrons: ReturnType<typeof child>[] = []; const builds: ReturnType<typeof child>[] = []
  const signals = new EventEmitter() as NodeJS.Process
  const supervisor = superviseDesktopDevelopment({ vite: vite.process, signals, ready: async () => {},
    spawnElectron() { const next = child(); electrons.push(next); return next.process },
    spawnBuild() { const next = child(); builds.push(next); return next.process },
  })
  return { vite, electrons, builds, signals, supervisor }
}

test('restart waits for exit, rebuilds sequentially, keeps Vite and reconnects endpoints', async () => {
  const f = fixture(); const running = f.supervisor.run(); await tick()
  const old = f.electrons[0]!
  old.emitter.emit('message', { type: 'shadow:dev-restart', extra: true })
  old.emitter.emit('message', { type: 'shadow:dev-restart' })
  old.emitter.emit('message', { type: 'shadow:dev-restart' })
  await tick(); assert.equal(f.builds.length, 0); assert.equal(f.electrons.length, 1)
  old.emitter.emit('exit', 0, null); await tick()
  assert.equal(f.builds.length, 1)
  f.builds[0]!.emitter.emit('exit', 0, null); await tick()
  assert.equal(f.builds.length, 2)
  f.builds[1]!.emitter.emit('exit', 0, null); await tick()
  assert.equal(f.electrons.length, 2)
  f.electrons[1]!.emitter.emit('message', { type: 'shadow:runtime-ready', apiBase: 'http://127.0.0.1:1234' })
  assert.ok(f.vite.messages.some(value => (value as { type: string }).type === 'shadow:runtime-ready'))
  f.electrons[1]!.emitter.emit('exit', 0, null); await running
  assert.equal(old.emitter.listenerCount('message'), 0)
  assert.equal(f.signals.listenerCount('SIGINT'), 0)
})

test('failed rebuild shuts down without respawn', async () => {
  const f = fixture(); const running = f.supervisor.run(); const rejected = assert.rejects(running, /exited with code 7/)
  await tick(); f.electrons[0]!.emitter.emit('message', { type: 'shadow:dev-restart' })
  f.electrons[0]!.emitter.emit('exit', 0, null); await tick()
  f.builds[0]!.emitter.emit('exit', 7, null); await rejected
  assert.equal(f.electrons.length, 1)
})

test('signals during rebuild cancel ownership and prevent respawn', async () => {
  const f = fixture(); const running = f.supervisor.run(); await tick()
  f.electrons[0]!.emitter.emit('message', { type: 'shadow:dev-restart' })
  f.electrons[0]!.emitter.emit('exit', 0, null); await tick()
  f.signals.emit('SIGINT'); await running
  assert.equal(f.electrons.length, 1); assert.equal(f.builds.length, 1)
})

test('spawn errors and renderer readiness failures stop all children', async () => {
  const f = fixture(); const running = f.supervisor.run(); const rejected = assert.rejects(running, /spawn failed/)
  await tick(); f.electrons[0]!.emitter.emit('error', new Error('spawn failed')); await rejected
  const vite = child()
  await assert.rejects(superviseDesktopDevelopment({ vite: vite.process, ready: async () => { throw new Error('not ready') },
    spawnElectron() { throw new Error('unexpected') }, spawnBuild() { throw new Error('unexpected') },
  }).run(), /not ready/)
})
