import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { compileScript, compileStyle, compileTemplate, parse } from 'vue/compiler-sfc'
import { deleteConversation } from './session-deletion.ts'

const target = { apiBase: 'http://fixture/projects/one', sessionId: 'web:chat-one', name: 'First conversation' }

test('session deletion stays in its project and returns confirmed cascade identities', async () => {
  const signal = new AbortController().signal
  const result = await deleteConversation(target, signal, async (url, init) => {
    assert.equal(String(url), 'http://fixture/projects/one/api/sessions/web%3Achat-one')
    assert.equal(init?.method, 'DELETE')
    assert.equal(init?.signal, signal)
    return Response.json({ deleted: ['child', target.sessionId, 'child'] })
  })
  assert.deepEqual(result, ['child', target.sessionId])
})

test('failed or ambiguous deletions never become successful UI confirmations', async () => {
  for (const response of [
    Response.json({ error: 'failed' }, { status: 500 }),
    Response.json({ deleted: [] }),
    Response.json({ deleted: ['someone-else'] }),
    Response.json({ deleted: [target.sessionId, 42] }),
    new Response('<html>not a confirmation</html>'),
  ]) {
    await assert.rejects(deleteConversation(target, new AbortController().signal, async () => response), /confirm|confirmation/)
  }
})

test('deletion failures show Main explanation without treating a failed response as confirmation', async () => {
  await assert.rejects(deleteConversation(target, new AbortController().signal, async () => Response.json({
    error: 'history_conflict',
    message: 'This history is shared. Repair it before continuing.',
    deleted: [target.sessionId],
  }, { status: 409 })), {
    message: 'Could not delete this conversation. This history is shared. Repair it before continuing.',
  })
  for (const response of [
    new Response('<html>gateway unavailable</html>', { status: 503 }),
    Response.json({ message: '' }, { status: 500 }),
    Response.json({ message: { unsafe: 'not text' } }, { status: 409 }),
  ]) {
    await assert.rejects(deleteConversation(target, new AbortController().signal, async () => response), /Deletion was not confirmed/)
  }
})

test('both session deletion entrypoints use the same DOM confirmation instead of native confirm', async () => {
  for (const filename of ['ChatTab.vue', 'ProjectGroup.vue']) {
    const source = await readFile(new URL(`./components/${filename}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /\bconfirm\(/)
    assert.match(source, /<SessionDeleteDialog v-if="deletion"/)
    assert.match(source, /for \(const id of ids\) emit\('deleted', id\)/)
  }
  const filename = 'SessionDeleteDialog.vue'
  const source = await readFile(new URL(`./components/${filename}`, import.meta.url), 'utf8')
  const { descriptor, errors } = parse(source, { filename })
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: filename })
  assert.deepEqual(compileTemplate({ source: descriptor.template!.content, filename, id: filename,
    compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
  for (const style of descriptor.styles) assert.deepEqual(compileStyle({
    source: style.content, filename, id: filename, scoped: true,
  }).errors, [])
  assert.match(source, /showModal\(\)/)
  assert.match(source, /if \(busy\.value\) return/)
  assert.match(source, /delegated tasks and calls will be deleted, including their execution history/)
  assert.match(source, /Independent topics are kept; shared history may be retained to protect other conversations/)
})
