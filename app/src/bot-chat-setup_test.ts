import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { privateCredentialTransport } from './credential-requests.ts'
const card = readFileSync(new URL('./components/BotChatSetup.vue', import.meta.url), 'utf8')
const chat = readFileSync(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
const editor = readFileSync(new URL('./components/ChannelsView.vue', import.meta.url), 'utf8')
test('Chat embeds the trusted editor without settings navigation and uses lifecycle-scoped private inputs', () => {
  assert.match(chat, /<BotChatSetup :api-base="apiBase"/)
  assert.match(card, /<ChannelsView :key="request.id"/)
  assert.match(card, /privateCredentialTransport\(props.apiBase\)/)
  assert.match(card, /next.projectId === props.projectId && next.sessionId === props.sessionId/)
  assert.match(card, /onBeforeUnmount\(stop\)/)
  assert.match(card, /controller\?\.abort\(\)/)
  assert.match(editor, /window.confirm\(t\('Bind platform user/)
  assert.match(editor, /field.kind === 'password' \? 'new-password'/)
  assert.match(editor, /drafts.value = \{\}/)
})
test('Private chat setup transport rejects nonloopback cleartext', () => {
  assert.equal(privateCredentialTransport('http://example.com'), false)
  assert.equal(privateCredentialTransport('http://127.0.0.1:3000/projects/p'), true)
  assert.equal(privateCredentialTransport('https://example.com/projects/p'), true)
})
