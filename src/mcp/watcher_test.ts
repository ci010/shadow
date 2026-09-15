import assert from 'node:assert/strict'
import test from 'node:test'
import { McpWatcher } from './watcher.ts'

test('catalog updates are serialized without dropping a later configuration', async () => {
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const updates: string[] = []
  const watcher = new McpWatcher(async servers => {
    updates.push(servers[0].name)
    if (updates.length === 1) {
      entered.resolve()
      await resume.promise
    }
  })
  const first = watcher.load([{ name: 'first', transport: 'stdio', command: 'synthetic' }])
  await entered.promise
  const second = watcher.load([{ name: 'second', transport: 'stdio', command: 'synthetic' }])
  const third = watcher.load([{ name: 'third', transport: 'stdio', command: 'synthetic' }])
  assert.deepEqual(updates, ['first'])
  resume.resolve()
  await Promise.all([first, second, third])
  assert.deepEqual(updates, ['first', 'second', 'third'])
  await watcher.stop()
})

test('a failed catalog update reaches its caller and does not poison queued or future updates', async () => {
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const updates: string[] = []
  const watcher = new McpWatcher(async servers => {
    updates.push(servers[0].name)
    if (updates.length === 1) {
      entered.resolve()
      await resume.promise
      throw new Error('synthetic cleanup failure')
    }
  })
  const first = assert.rejects(
    watcher.load([{ name: 'failed', transport: 'stdio', command: 'synthetic' }]),
    /synthetic cleanup failure/,
  )
  await entered.promise
  const second = watcher.load([{ name: 'queued', transport: 'stdio', command: 'synthetic' }])
  resume.resolve()
  await Promise.all([first, second])
  await watcher.load([{ name: 'later', transport: 'stdio', command: 'synthetic' }])
  assert.deepEqual(updates, ['failed', 'queued', 'later'])
  await watcher.stop()
})
