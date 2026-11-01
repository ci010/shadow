import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

const source = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')

test('chat retains BOT/native approval and private credentials without retired resource review cards', async () => {
  const chat = await source('./components/ChatTab.vue')
  assert.match(chat, /<YieldQuestion\b/)
  assert.match(chat, /<BotChatSetup\b/)
  assert.match(chat, /<CredentialRequest\b/)
  assert.doesNotMatch(chat, /PublicationRequest|AuthoringProbeRequest|publication-requests|authoring-probes/)
  for (const path of [
    './components/PublicationRequest.vue', './components/AuthoringProbeRequest.vue',
    './publication-requests.ts', './authoring-probes.ts',
  ]) {
    await assert.rejects(access(new URL(path, import.meta.url)), { code: 'ENOENT' })
  }
})

test('private credential entry owns its source contract and uses the dedicated endpoint', async () => {
  const credentials = await source('./credential-requests.ts')
  assert.match(credentials, /src\/credentials\/request-contract\.ts/)
  assert.match(credentials, /interface CredentialRequestSource/)
  assert.match(credentials, /\/api\/credential-requests/)
  assert.doesNotMatch(credentials, /agent-authoring|agent-resources|PublicationSource|publication-requests/)
})
