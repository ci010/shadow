import assert from 'node:assert/strict'
import { test } from 'node:test'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AUDIO_ACCEPTANCE_PROMPT, AcceptanceControlError, acceptanceOperatorAttempt, acceptanceBudgetError, acceptanceCallBudget, acceptanceMessage, acceptanceProviderFailure, acceptanceRuntimeDirectory, acceptanceRuntimeEnv, exportAcceptanceBundles, loadAcceptancePrompt, runAcceptance, writeAcceptanceArtifact } from './microapp-a2a.ts'
import { CopilotProvider } from '../src/providers/copilot.ts'
import { withTempWorkspace } from '../src/testing/workspace.ts'
import { MicroAppStore, bundleRevision } from '../src/microapps/store.ts'

test('operator rejections are explicit recoverable results, without retrying or swallowing uncertain failures', async () => {
  let calls = 0
  const result = await acceptanceOperatorAttempt('review-1', 'approve', async () => {
    calls++
    throw new AcceptanceControlError('Stale app revision; inspect again')
  })
  assert.deepEqual(result, { id: 'review-1', action: 'approve', done: false, error: 'Stale app revision; inspect again' })
  assert.equal(calls, 1)
  assert.deepEqual(await acceptanceOperatorAttempt('review-2', 'review-work', async () => { calls++ }),
    { id: 'review-2', action: 'review-work', done: true })
  for (const error of [new TypeError('fetch failed'), new Error('Invalid response'), new DOMException('Cancelled', 'AbortError')]) {
    await assert.rejects(acceptanceOperatorAttempt('uncertain', 'approve', async () => { calls++; throw error }), actual => actual === error)
  }
  assert.equal(calls, 5)
})

test('focused acceptance budgets can lower but never disable or raise the live call ceiling', () => {
  assert.equal(acceptanceCallBudget(), 100)
  for (const value of ['1', '20', '100']) assert.equal(acceptanceCallBudget(value), Number(value))
  for (const value of ['', ' ', '0', '-1', '1.5', '101', 'Infinity', 'NaN', '1e2', '0x10', '9007199254740993']) {
    assert.throws(() => acceptanceCallBudget(value), /integer from 1 to 100/)
  }
})

test('live admission stops at either exact budget boundary, even with requests left', () => {
  assert.equal(acceptanceBudgetError(99, 100, 1000, 999), undefined)
  assert.equal(acceptanceBudgetError(100, 100, 1000, 999), 'live_test_call_budget_exhausted')
  assert.equal(acceptanceBudgetError(66, 100, 1000, 1000), 'live_test_deadline_exhausted')
  assert.equal(acceptanceBudgetError(0, 100, 1000, 1001), 'live_test_deadline_exhausted')
  assert.equal(acceptanceBudgetError(0, 1, undefined, 1000), undefined)
  assert.equal(acceptanceBudgetError(1, 1), 'live_test_call_budget_exhausted')
})

test('acceptance runtime never inherits normal dev credentials, dataroot or package/model caches', () => {
  const directory = join(process.cwd(), '.test-data', 'synthetic-isolation')
  const env = acceptanceRuntimeEnv(directory, {
    Path: 'synthetic-tools', SYSTEMROOT: 'synthetic-windows', SHADOW_HOME: 'private-dev-data',
    HOME: 'private-home', npm_config_cache: 'private-cache', HF_HOME: 'private-models', PRIVATE_TOKEN: 'private',
  })

  assert.equal(env.Path, 'synthetic-tools')
  assert.equal(env.SYSTEMROOT, 'synthetic-windows')
  for (const [key, value] of Object.entries(env)) {
    if (key === 'Path' || key === 'SYSTEMROOT') continue
    assert.ok(value?.startsWith(directory), key)
  }
  assert.equal(env.SHADOW_HOME, undefined)
  assert.equal(env.PRIVATE_TOKEN, undefined)
  assert.equal(env.npm_config_userconfig, join(directory, 'profile', 'empty.npmrc'))
  assert.equal(env.HF_HOME, join(directory, 'profile', 'huggingface'))
})

test('acceptance can use a short runtime root without nesting or deleting artifact output', () => {
  const output = resolve('.test-data', 'long-artifact-directory')
  assert.equal(acceptanceRuntimeDirectory(output), join(output, 'runtime'))
  const runtime = join('.test-data', 'short-runtime')
  assert.equal(acceptanceRuntimeDirectory(output, runtime), resolve(runtime))
  assert.equal(acceptanceRuntimeDirectory(output, `${output}-runtime`), `${output}-runtime`)
  for (const overlapping of [output, join(output, 'runtime'), resolve(output, '..'), resolve(output, '..', '..')]) {
    assert.throws(() => acceptanceRuntimeDirectory(output, overlapping), /separate, non-nested/)
  }
})

test('acceptance startup only cleans its newly created runtime root and preserves existing data', async t => withTempWorkspace(async home => {
  const providerError = new Error('Synthetic provider startup failure')
  const provider = t.mock.method(CopilotProvider.prototype, 'listModels', async () => { throw providerError })
  const previous = process.env.SHADOW_MICROAPP_LIVE
  process.env.SHADOW_MICROAPP_LIVE = '1'
  try {
    const output = join(home, 'evidence'), runtime = join(home, 'short')
    await assert.rejects(runAcceptance(output, 'Fixture', undefined, 101, runtime), /integer from 1 to 100/)
    await assert.rejects(access(output), { code: 'ENOENT' })
    await assert.rejects(runAcceptance(output, 'Fixture', undefined, 1, runtime), error => error === providerError)
    await assert.rejects(access(runtime), { code: 'ENOENT' })
    await access(output)
    await mkdir(runtime)
    await writeFile(join(runtime, 'keep.txt'), 'existing data')
    await assert.rejects(runAcceptance(join(home, 'other-evidence'), 'Fixture', undefined, 1, runtime), { code: 'EEXIST' })
    assert.equal(await readFile(join(runtime, 'keep.txt'), 'utf8'), 'existing data')
    assert.equal(provider.mock.callCount(), 1, 'Existing roots are rejected before provider access')
  } finally {
    if (previous === undefined) delete process.env.SHADOW_MICROAPP_LIVE
    else process.env.SHADOW_MICROAPP_LIVE = previous
  }
}))

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
