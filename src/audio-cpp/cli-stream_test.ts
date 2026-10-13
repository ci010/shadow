import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openCliStream } from './cli-stream.ts'

test('CLI line parser accepts partial_text only and waits for process close', async () => {
  const controller = new AbortController(); const partials: string[] = []
  const stream = openCliStream(process.execPath, ['-e', `process.stdout.write('log=ignored\\npartial_text=first\\n'); process.stdin.on('data', () => process.stdout.write('partial_text= second\\n')); process.stdin.on('end', () => process.stdout.write('text_output=not a delta\\n'))`], controller.signal, text => partials.push(text))
  await stream.write(Buffer.from([1, 0])); await stream.finish()
  assert.deepEqual(partials, ['first', ' second'])
})

test('CLI cancellation and unsuccessful startup close without dangling inference', async () => {
  const controller = new AbortController()
  const stream = openCliStream(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], controller.signal, () => {})
  controller.abort()
  await assert.rejects(stream.closed)
  const absent = openCliStream('shadow-definitely-not-an-audio-binary', [], new AbortController().signal, () => {})
  await assert.rejects(absent.closed, /ENOENT/)
})
