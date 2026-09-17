import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc'
test('inline I/O compiles inside the existing conversation without a separate session launcher', async () => {
  const filename = new URL('./components/ChatTab.vue', import.meta.url).pathname
  const source = await readFile(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
  const { descriptor, errors } = parse(source, { filename })
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'io-chat' })
  const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'io-chat', compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  assert.ok(script.bindings.useIoConversation)
  assert.ok(script.bindings.IoRequestCard)
  assert.match(descriptor.template!.content, /<IoRequestCard v-for="run in ioAfter\.get\(idx\)"/)
  assert.match(source, /sessionId: activeSessionId\.value/)
  assert.doesNotMatch(source, /createConversationForIo|prepareIoConversation|IoLauncher|ioBridge\?\.open/)
})
