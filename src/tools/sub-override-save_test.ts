import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink, link, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SubOverrideStore } from '../agent/context/sub-override.ts'
import type { ExecutionContext } from './context.ts'
import { SubOverrideSaveTool } from './sub-override-save.ts'

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'shadow-sub-draft-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, store: new SubOverrideStore(root), dir: join(root, 'sub-prompt-drafts') }
}

test('sub draft saves are immutable and content-addressed, including after reload', async t => {
  const { root, store, dir } = await fixture(t)
  const one = await store.save('# First draft')
  assert.equal(await store.save('# First draft'), one)
  const two = await store.save('# Second draft')
  assert.notEqual(one, two)
  assert.equal(await new SubOverrideStore(root).read(one), '# First draft')
  assert.deepEqual((await readdir(dir)).sort(), [`${one}.md`, `${two}.md`].sort())
  await assert.rejects(store.read('../elsewhere'), /Invalid/)
  await assert.rejects(store.read('0'.repeat(64)), /not found/)
  await assert.rejects(store.save('界'.repeat(6000)), /16 KiB/)
  await writeFile(join(dir, `${one}.md`), 'modified')
  await assert.rejects(store.read(one), /integrity/)
  await assert.rejects(store.save('# First draft'), /integrity/)
})

test('sub draft paths reject linked directories and non-owned file aliases', async t => {
  const { root, store, dir } = await fixture(t)
  const outside = join(root, 'outside')
  await mkdir(outside)
  await symlink(outside, dir, 'junction')
  await assert.rejects(store.save('draft'), /Unsafe sub draft directory/)
  assert.deepEqual(await readdir(outside), [])
  await rm(dir)
  const one = await store.save('draft')
  const path = join(dir, `${one}.md`)
  const alias = join(outside, 'draft.md')
  await link(path, alias)
  await assert.rejects(store.read(one), /Unsafe sub draft file/)
  if (process.platform !== 'win32') {
    await rm(path)
    await symlink(alias, path)
    await assert.rejects(store.read(one), /Unsafe sub draft file/)
  }
})

test('only the authorized direct Project owner turn can save and saving never enables', async t => {
  const { root, store } = await fixture(t)
  const tools = { executionMode: 'session' } as { executionMode: string; dynamicOwner?: object }
  tools.dynamicOwner = tools
  const context = { tools, projectId: 'p', sessionId: 'web:owner', channel: 'web', inputSource: 'user', admin: true,
    soleDirectToolCall: true, toolCallName: 'sub_override_save', signal: new AbortController().signal } as unknown as ExecutionContext
  const tool = new SubOverrideSaveTool(store, 'p', ctx => ctx.sessionId === 'web:owner')
  for (const patch of [{ projectId: 'other' }, { admin: false }, { inputSource: 'session' }, { scriptInvocation: true },
    { recoveringToolCall: true }, { soleDirectToolCall: false }, { sessionId: 'web:not-owner' }, { layerfsWorkdir: { workspace: 'other' } }]) {
    await assert.rejects(tool.execute({ markdown: 'draft' }, { ...context, ...patch } as ExecutionContext), /authorized/)
  }
  await assert.rejects(tool.execute({ markdown: 'draft', enable: true }, context), /enable/)
  assert.deepEqual(await readdir(root), [])
  const receipt = JSON.parse(await tool.execute({ markdown: 'draft' }, context))
  assert.equal(receipt.enabled, false)
  assert.equal(await store.read(receipt.revision), 'draft')
})
