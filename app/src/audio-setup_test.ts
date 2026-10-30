import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { audioSetupRequest } from './audio-setup.ts'

test('first-use audio choices request explicit Agent workflows without capture, upload or silent fallback', () => {
  const local = audioSetupRequest('local'), remote = audioSetupRequest('remote')
  assert.match(local, /audio assess/)
  assert.match(local, /specific pinned model/)
  assert.match(local, /unsuitable recommend remote/)
  assert.match(local, /never auto-switch/)
  assert.match(local, /audio setup/)
  assert.match(local, /Before any downloads ask/)
  assert.match(remote, /I select a remote API/)
  assert.match(remote, /never ask for or echo API keys/)
  for (const value of [local, remote]) assert.match(value, /Do not record a microphone or upload audio/)
})

test('composer audio button presents both choices and routes setup through ordinary session send', async () => {
  const component = await readFile(new URL('./components/AudioSetupButton.vue', import.meta.url), 'utf8')
  const chat = await readFile(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
  assert.match(component, /request\('local'\)/)
  assert.match(component, /request\('remote'\)/)
  assert.match(component, /recordMicrophone/)
  assert.match(component, /audioStatusResource\(livePool, props.apiBase\)/)
  const resource = await readFile(new URL('./audio-status-resource.ts', import.meta.url), 'utf8')
  assert.match(resource, /\/api\/audio\/status/)
  assert.match(component, /emit\('transcript'/)
  assert.match(chat, /<AudioSetupButton[\s\S]*?@request="sendMessage\(\$event\)"/)
})
