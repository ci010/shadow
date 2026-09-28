import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AUDIO_ACCEPTANCE_PROMPT, acceptanceMessage, acceptanceProviderFailure, exportAcceptanceBundles, loadAcceptancePrompt, writeAcceptanceArtifact } from './microapp-a2a.ts'
import { withTempWorkspace } from '../src/testing/workspace.ts'
import { MicroAppStore, bundleRevision } from '../src/microapps/store.ts'

test('provider acceptance diagnostics retain safe network codes, not request payloads or credentials', () => {
  const cause = Object.assign(new Error('Secret URL and request body'), { code: 'ECONNRESET', headers: { authorization: 'synthetic-secret' } })
  assert.deepEqual(acceptanceProviderFailure(new TypeError('fetch failed', { cause })), {
    chain: [{ name: 'TypeError' }, { name: 'Error', code: 'ECONNRESET' }],
  })
  const unknown = Object.assign(new Error('secret'), { name: 'private-value', code: 'secret' })
  unknown.cause = unknown
  assert.deepEqual(acceptanceProviderFailure(unknown), { chain: Array.from({ length: 4 }, () => ({ name: 'OtherError' })) })
})

test('artifact replacement retries transient rename contention without resending a model request', async t => {
  const warnings: unknown[][] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args) })
  let attempts = 0
  await writeAcceptanceArtifact('synthetic-progress.json', '{"calls":59}', (path, content) => {
    assert.equal(path, 'synthetic-progress.json')
    assert.equal(content, '{"calls":59}')
    if (++attempts < 3) throw Object.assign(new Error('fixture'), { code: 'EPERM', syscall: 'rename' })
  })
  assert.equal(attempts, 3)
  assert.equal(warnings.length, 2)
})

test('artifact retries are bounded and do not swallow persistent or unrelated errors', async t => {
  t.mock.method(console, 'warn', () => {})
  let attempts = 0
  const locked = Object.assign(new Error('locked'), { code: 'EBUSY', syscall: 'rename' })
  await assert.rejects(writeAcceptanceArtifact('synthetic-progress.json', '{}', () => { attempts++; throw locked }), error => error === locked)
  assert.equal(attempts, 5)
  const denied = Object.assign(new Error('denied'), { code: 'EACCES', syscall: 'open' })
  attempts = 0
  await assert.rejects(writeAcceptanceArtifact('synthetic-progress.json', '{}', () => { attempts++; throw denied }), error => error === denied)
  assert.equal(attempts, 1)
})

test('acceptance uses the complete chosen prompt without adding hidden implementation hints', async () => withTempWorkspace(async home => {
  assert.equal(await loadAcceptancePrompt(), AUDIO_ACCEPTANCE_PROMPT)
  const path = join(home, 'request.txt'), text = 'Make a reusable virtual microphone app.'
  await writeFile(path, text)
  assert.equal(await loadAcceptancePrompt(path), text)
  await writeFile(path, ' ')
  await assert.rejects(loadAcceptancePrompt(path), /1–65536/)
  await writeFile(path, 'x'.repeat(65537))
  await assert.rejects(loadAcceptancePrompt(path), /1–65536/)
}))

test('guided acceptance keeps user inputs exact and distinguishes answers from later feedback', () => {
  const text = '我想在 VRChat 里输入中文，让别人听到日语，同时把别人说的话翻译成中文字幕。帮我做成一个能反复打开使用的小工具。'
  const initial = acceptanceMessage(text)
  assert.equal(initial.kind, 'initial')
  assert.deepEqual(initial.message.parts, [{ text }])
  assert.equal(initial.message.contextId, undefined)
  assert.equal(initial.message.taskId, undefined)
  const question = { parts: [{ text: '对方通常说什么语言？' }] }
  const waiting = { id: 'task-1', contextId: 'context-1',
    status: { state: 'TASK_STATE_INPUT_REQUIRED', message: question } }
  const answer = acceptanceMessage('主要是日语和英语。', waiting)
  assert.equal(answer.kind, 'answer')
  assert.deepEqual(answer.question, question)
  assert.equal(answer.message.taskId, waiting.id)
  assert.equal(answer.message.contextId, waiting.contextId)
  assert.notEqual(answer.message.messageId, initial.message.messageId)
  for (const state of ['COMPLETED', 'FAILED', 'CANCELED', 'REJECTED']) {
    const feedback = acceptanceMessage('保留两个方向，界面简单一些。', { ...waiting, status: { state: `TASK_STATE_${state}` } })
    assert.equal(feedback.kind, 'followup')
    assert.equal(feedback.message.taskId, undefined)
    assert.equal(feedback.message.contextId, waiting.contextId)
    assert.equal(feedback.question, undefined)
  }
})

test('guided acceptance rejects premature messages and invalid targets before sending', () => {
  for (const state of ['WORKING', 'SUBMITTED', 'AUTH_REQUIRED', 'UNSPECIFIED']) {
    assert.throws(() => acceptanceMessage('继续', {
      id: 'task-1', contextId: 'context-1', status: { state: `TASK_STATE_${state}` },
    }), /Wait for input-required or a terminal task/)
  }
  assert.throws(() => acceptanceMessage('继续', { id: 'task-1', status: { state: 'TASK_STATE_INPUT_REQUIRED' } }))
  for (const text of [undefined, '', '  ', '中'.repeat(21846)]) {
    assert.throws(() => acceptanceMessage(text), /1–65536 UTF-8 bytes/)
  }
})

test('acceptance preserves exact published app bytes, without records or grants', async () => withTempWorkspace(async home => {
  const store = new MicroAppStore(home), source = join(home, 'source'), output = join(home, 'evidence')
  await exportAcceptanceBundles(home, output)
  await store.init()
  await mkdir(source)
  await writeFile(join(source, 'index.html'), '<main>App</main>')
  await writeFile(join(source, 'audio.wav'), Buffer.from([0, 1, 255, 128]))
  const record = await store.publish(source, {
    version: 1, name: 'Example', description: 'Fixture', entry: 'index.html', files: ['index.html', 'audio.wav'],
  }, 'test-author', new AbortController().signal)
  await exportAcceptanceBundles(home, output)
  const exported = JSON.parse(await readFile(join(output, 'bundles', `${record.id}.json`), 'utf8'))
  assert.equal(bundleRevision(exported), record.revision)
  assert.deepEqual(Buffer.from(exported.files['audio.wav'], 'base64'), Buffer.from([0, 1, 255, 128]))
  assert.deepEqual(Object.keys(exported).sort(), ['files', 'manifest'])
  const snapshot = join(store.root, record.id, `${record.revision}.json`)
  exported.files['index.html'] = Buffer.from('changed').toString('base64')
  await writeFile(snapshot, JSON.stringify(exported))
  await assert.rejects(exportAcceptanceBundles(home, output), /App bundle changed/)
  await rm(snapshot)
  await assert.rejects(exportAcceptanceBundles(home, output), { code: 'ENOENT' })
}))
