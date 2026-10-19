import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { createTempWorkspace } from '../testing/workspace.ts'
import { sessionWorkspacePath } from '../utils/paths.ts'
import type { ChatMessage } from '../providers/provider.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { resolveDurableMedia } from './durable-media.ts'
import { WebChannel } from './web.ts'

// Synthetic Documents path only: never read real user documents.
test('durable MEDIA declarations grant one file, not prose, code, tools, users, siblings or arbitrary absolute paths', async () => {
  const workspace = await createTempWorkspace()
  const root = join(workspace, 'Documents', 'Shadow')
  const file = join(root, '中文 报告', '报告.md')
  const sibling = join(root, 'secret.md')
  const outside = join(workspace, 'private.md')
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, '# 合成报告')
  await writeFile(sibling, 'not attached')
  await writeFile(outside, 'outside')
  const content = `Report: MEDIA:"${file}"`
  const history: ChatMessage[] = [{ role: 'assistant', content }]
  try {
    assert.equal(await resolveDurableMedia(file, history, [root]), file)
    assert.equal(await resolveDurableMedia(sibling, history, [root]), null)
    assert.equal(await resolveDurableMedia(outside, [{ role: 'assistant', content: `MEDIA:${outside}` }], [root]), null)
    for (const role of ['user', 'tool', 'system'] as const) {
      assert.equal(await resolveDurableMedia(file, [{ role, content }], [root]), null)
    }
    for (const text of [file, `\`MEDIA:${file}\``, `\`\`\`text\nMEDIA:${file}\n\`\`\``]) {
      assert.equal(await resolveDurableMedia(file, [{ role: 'assistant', content: text }], [root]), null)
    }
    assert.equal(await resolveDurableMedia(file, [], [root]), null)
    assert.equal(await resolveDurableMedia(file, history, []), null)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('durable media rejects junction escape and a redirected Shadow root', async () => {
  const workspace = await createTempWorkspace()
  const root = join(workspace, 'Shadow')
  const outside = join(workspace, 'outside')
  await mkdir(root)
  await mkdir(outside)
  await writeFile(join(outside, 'secret.md'), 'secret')
  await symlink(outside, join(root, 'escape'), 'junction')
  await symlink(outside, join(workspace, 'redirected'), 'junction')
  try {
    for (const [path, allowed] of [[join(root, 'escape', 'secret.md'), root], [join(workspace, 'redirected', 'secret.md'), join(workspace, 'redirected')]]) {
      assert.equal(await resolveDurableMedia(path!, [{ role: 'assistant', content: `MEDIA:${path}` }], [allowed!]), null)
    }
  } finally { await rm(workspace, { recursive: true, force: true }) }
})

test('media route serves historical durable Chinese attachments with GET/HEAD/range and preserves session isolation', async () => {
  const workspace = await createTempWorkspace()
  const root = join(workspace, 'Documents', 'Shadow')
  const file = join(root, '测试 报告.md')
  await mkdir(root, { recursive: true })
  await writeFile(file, 'synthetic report')
  await mkdir(sessionWorkspacePath(workspace, 'web:owner'), { recursive: true })
  await mkdir(sessionWorkspacePath(workspace, 'web:other'), { recursive: true })
  const manager = {
    getSessionState: (id: string) => ['web:owner', 'web:other'].includes(id) ? { sessionId: id } : null,
    getHistory: async (id: string) => ({ messages: id === 'web:owner' ? [{ role: 'assistant', content: `MEDIA:${file}` }] : [] }),
  } as unknown as SessionManager
  const channel = new WebChannel(new Bus(), { workspace, sessionManager: manager, durableMediaRoots: async () => [root] })
  const app = new Hono()
  await channel.start(app)
  const url = (chat: string) => `/api/media?chatId=${chat}&path=${encodeURIComponent(file)}&download=1`
  try {
    for (const method of ['GET', 'HEAD']) {
      const response = await app.request(url('owner'), { method })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('Content-Disposition')!, /attachment;/)
      assert.equal(await response.text(), method === 'HEAD' ? '' : 'synthetic report')
    }
    const range = await app.request(url('owner'), { headers: { Range: 'bytes=0-4' } })
    assert.equal(range.status, 206)
    assert.equal(await range.text(), 'synth')
    for (const chat of ['other', 'missing']) assert.equal((await app.request(url(chat))).status, 404)
    assert.equal((await app.request(`/api/media?sessionId=web%3Aowner&path=${encodeURIComponent(file)}`)).status, 404)
  } finally {
    await channel.stop()
    await rm(workspace, { recursive: true, force: true })
  }
})
