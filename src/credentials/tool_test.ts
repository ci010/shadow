import assert from 'node:assert/strict'
import { test } from 'node:test'
import { credentialRequestTool } from './tool.ts'
import { CredentialRequests } from './requests.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'

function fixture() {
  const values: Record<string, string> = {}
  const requests = new CredentialRequests({ projectId: 'p', credentials: { names: () => Object.keys(values), put: (name, value) => { values[name] = value } } })
  const tools = new SessionTools(new Tools('.'), '.'); tools.setExecutionScope('session', [])
  const context = { projectId: 'p', sessionId: 'web:owner', channel: 'web', inputSource: 'user', admin: true,
    isGroup: false, signal: new AbortController().signal, tools } as ExecutionContext
  const tool = credentialRequestTool({ projectId: 'p', requests, canManage: id => id === 'web:owner' })
  return { requests, context, tool, values }
}
const args = { secretRef: 'service-key', purpose: 'Access the approved service' }

test('private credential tool returns only metadata and respects saved/cancelled outcomes', async () => {
  const f = fixture()
  try {
    const pending = f.tool.execute(args, f.context)
    assert.equal(f.requests.pending()?.sessionId, 'web:owner')
    f.requests.submit(f.requests.pending()!.id, 'synthetic-private-value')
    const result = await pending
    assert.equal(typeof result, 'string')
    assert.doesNotMatch(String(result), /synthetic-private-value/)
    assert.equal(JSON.parse(String(result)).status, 'saved')
    const cancelled = f.tool.execute(args, f.context)
    f.requests.cancel(f.requests.pending()!.id)
    assert.equal(JSON.parse(String(await cancelled)).status, 'cancelled')
    assert.deepEqual(f.values, { 'service-key': 'synthetic-private-value' })
  } finally { f.requests.stop() }
})

test('owner gate rejects forged role, channel, input, Project, group, remote and temporary scopes before prompting', async () => {
  const f = fixture()
  try {
    for (const overrides of [
      { admin: false }, { channel: 'qq' }, { sessionId: 'bot:p:qq:owner' }, { inputSource: 'event' },
      { inputSource: 'tool' }, { projectId: 'other' }, { sessionId: 'web:child' }, { isGroup: true },
      { channelAddress: { projectId: 'p', botInstanceId: 'b', platform: 'qq', conversationId: 'owner' } },
      { memoryAccess: {} }, { remoteWorkdir: {} },
    ]) {
      await assert.rejects(f.tool.execute(args, { ...f.context, ...overrides } as ExecutionContext), /direct owner turn/)
      assert.equal(f.requests.pending(), null)
    }
    for (const mode of ['task', 'call'] as const) {
      f.context.tools.setExecutionScope(mode, [])
      await assert.rejects(f.tool.execute(args, f.context), /direct owner turn/)
    }
    assert.deepEqual(f.values, {})
  } finally { f.requests.stop() }
})

test('strict tool input refuses secret values, legacy actions and aborted turns without opening a card', async () => {
  const f = fixture()
  try {
    for (const extra of [{ value: 'not-an-argument' }, { action: 'request_secret' }, { projectId: 'p' }]) {
      await assert.rejects(f.tool.execute({ ...args, ...extra }, f.context))
      assert.equal(f.requests.pending(), null)
    }
    await assert.rejects(f.tool.execute(args, { ...f.context, signal: AbortSignal.abort() }))
    assert.equal(f.requests.pending(), null)
  } finally { f.requests.stop() }
})
