import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

test('Python adhoc service replays the relay protocol and writes caller-selected valid WAV output', async () => {
  const result = await promisify(execFile)('python', [
    '-B', join(process.cwd(), 'src', 'skills', 'builtin', 'io', 'examples', 'microphone_test.py'),
  ], { cwd: process.cwd(), timeout: 30_000, maxBuffer: 64 * 1024 })
  assert.match(result.stderr, /Ran 4 tests/)
  assert.match(result.stderr, /\bOK\b/)
})
