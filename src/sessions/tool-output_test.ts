import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import type { ChatMessage } from '../providers/provider.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
import { ToolOutputProjection } from './tool-output.ts'

const output = 'a'.repeat(30_000_000) + 'END'

test('oversized historical tool text becomes one file-backed preview across requests, without mutating history', async () => withTempWorkspace(async home => {
  const projection = new ToolOutputProjection(home)
  const image = { type: 'image_url' as const, image_url: { url: 'fixture' } }
  const message: ChatMessage = { role: 'tool', name: 'exec', tool_call_id: 'pair', content: [
    { type: 'text', text: output.slice(0, 40_000) }, image, { type: 'text', text: output.slice(40_000) },
  ] }
  const [projected, again] = await Promise.all([projection.project(message), projection.project(message)])
  assert.equal(again, projected)
  assert.equal(projected.tool_call_id, 'pair')
  assert(Array.isArray(projected.content))
  assert.equal(projected.content[1], image)
  const preview = projected.content[0]
  assert(preview.type === 'text' && preview.text.length < 12_500)
  const path = /Full output saved to: (\.tmp\/[^\n]+)/.exec(preview.text)?.[1]
  assert(path)
  assert.equal(await readFile(projectStoragePath(home, path), 'utf8'), `${output.slice(0, 40_000)}\n${output.slice(40_000)}`)
  assert.equal((await readdir(projectStoragePath(home, '.tmp'))).length, 1)
  assert.equal(message.content?.length, 3)
  const user: ChatMessage = { role: 'user', content: output }
  assert.equal(await projection.project(user), user)
}))

test('transient text and unavailable scratch storage cannot leak unbounded output', async () => withTempWorkspace(async home => {
  const projection = new ToolOutputProjection(home)
  const message: ChatMessage = { role: 'tool', tool_call_id: 'pair', content: output.slice(0, 70_000) }
  const transient = await projection.project(message, true)
  assert.match(String(transient.content), /this observation is transient/)
  await assert.rejects(readdir(projectStoragePath(home, '.tmp')), { code: 'ENOENT' })
  await writeFile(projectStoragePath(home, '.tmp'), 'blocked')
  const failed = await projection.project(message)
  assert.match(String(failed.content), /Full output was NOT saved/)
  assert.doesNotMatch(String(failed.content), /Full output saved to:/)
  assert(String(failed.content).length < 12_500)
}))
