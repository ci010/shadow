import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('composer setup offers host-side configuration without submitting a conversation turn', async () => {
  const component = await readFile(new URL('./components/AudioSetupButton.vue', import.meta.url), 'utf8')
  const chat = await readFile(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
  assert.match(component, /setupChoice = 'local'/)
  assert.match(component, /setupChoice = 'remote'/)
  assert.match(component, /project-audio configure-remote/)
  assert.match(component, /recordMicrophone/)
  assert.match(component, /audioStatusResource\(livePool, props.apiBase\)/)
  const resource = await readFile(new URL('./audio-status-resource.ts', import.meta.url), 'utf8')
  assert.match(resource, /\/api\/audio\/status/)
  assert.match(component, /emit\('transcript'/)
  assert.doesNotMatch(chat.match(/<AudioSetupButton[^>]*>/)![0], /@request=|sendMessage/)
})
