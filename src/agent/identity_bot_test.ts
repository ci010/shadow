import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { IdentityManager } from './identity.ts'
import { createTempWorkspace } from '../testing/workspace.ts'

test('identity keeps default legacy profiles and confirmations, but never assigns legacy challenges to a new bot', async t => {
  const workspace = await createTempWorkspace()
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await mkdir(join(workspace, 'memory', 'identities'), { recursive: true })
  const old = {
    version: 2, accounts: { 'discord:alice': 'Alice', 'qq:bob': 'Bob' },
    accountChats: { 'qq:bob': 'room' }, pendingLinks: {
      LEGACY: { requesterAccount: 'discord:alice', targetAccount: 'qq:bob',
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() },
    },
  }
  await writeFile(join(workspace, 'memory', 'identities', 'index.json'), JSON.stringify(old))
  const foreign = new IdentityManager(workspace, 'new-org')
  await assert.rejects(foreign.confirmLink('qq', 'bob', 'LEGACY',
    { organizationId: 'new-org', botInstanceId: 'bot', platform: 'qq', conversationId: 'room' }), /Legacy confirmation/)
  const identity = new IdentityManager(workspace, 'default')
  const requester = { organizationId: 'default', botInstanceId: 'legacy-discord', platform: 'discord', conversationId: 'room', legacySessionId: true }
  const target = { ...requester, botInstanceId: 'legacy-qq', platform: 'qq' }
  await identity.observeInboundAccount('discord', 'alice', 'room', 'New Name', requester)
  await identity.observeInboundAccount('qq', 'bob', 'room', 'New Name', target)
  assert.match((await identity.lookupByAccount('discord', 'alice', requester)).personContext, /profile for Alice/)
  await assert.rejects(identity.confirmLink('qq', 'bob', 'LEGACY', { ...target, botInstanceId: 'new', legacySessionId: false }), /Legacy confirmation/)
  await identity.confirmLink('qq', 'bob', 'LEGACY', target)
  const challenge = await identity.createLinkChallenge('discord', 'alice', 'qq', 'bob', { requesterAddress: requester })
  assert.deepEqual(challenge.targetAddress, target)
  await identity.confirmLink('qq', 'bob', challenge.code, target)

  const legacy = new IdentityManager(join(workspace, 'unscoped'))
  await legacy.assignProfile('discord', 'alice', 'Alice', 'origin')
  await legacy.assignProfile('qq', 'bob', 'Bob', 'room')
  const unscoped = await legacy.createLinkChallenge('discord', 'alice', 'qq', 'bob')
  assert.equal(unscoped.targetChatId, 'room')
  assert.equal(unscoped.targetAddress, undefined)
  await legacy.confirmLink('qq', 'bob', unscoped.code)
})

test('identity serializes concurrent observations and isolates same sender/display name across bot instances', async t => {
  const workspace = await createTempWorkspace()
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const identity = new IdentityManager(workspace, 'org')
  const addresses = ['a', 'b', 'c'].map(botInstanceId =>
    ({ organizationId: 'org', botInstanceId, platform: 'qq', conversationId: 'same' }))
  const assigned = await Promise.all(addresses.map(address =>
    identity.observeInboundAccount('qq', 'same-sender', 'same', 'Same Name', address)))
  assert.equal(new Set(assigned.map(result => result?.profileName)).size, 3)
  const reloaded = new IdentityManager(workspace, 'org')
  await assert.rejects(reloaded.lookupByAccount('qq', 'same-sender'), /Source bot address is unavailable/)
  for (const address of addresses) {
    const challenge = await reloaded.createLinkChallenge('qq', 'same-sender', 'qq', 'same-sender',
      { requesterAddress: addresses[0], targetBotInstanceId: address.botInstanceId })
    assert.deepEqual(challenge.targetAddress, address)
  }
  await assert.rejects(reloaded.observeInboundAccount('discord', 'sender', 'same', undefined, addresses[0]), /platform address mismatch/)
  await assert.rejects(reloaded.observeInboundAccount('qq', 'sender', 'other', undefined, addresses[0]), /chat address mismatch/)
  await assert.rejects(new IdentityManager(workspace, 'foreign').lookupByAccount('qq', 'sender'), /organization mismatch/)
})

test('identity rejects malformed persisted addresses without overwriting identity history', async t => {
  const workspace = await createTempWorkspace()
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await mkdir(join(workspace, 'memory', 'identities'), { recursive: true })
  const path = join(workspace, 'memory', 'identities', 'index.json')
  const content = JSON.stringify({ accounts: { 'qq:sender': 'Keep' }, accountAddresses: { key: { organizationId: 'org' } } })
  await writeFile(path, content)
  await assert.rejects(new IdentityManager(workspace, 'org').lookupByAccount('qq', 'sender'))
  assert.equal(await readFile(path, 'utf8'), content)
})
