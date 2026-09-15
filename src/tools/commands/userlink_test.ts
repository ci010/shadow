import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Bus } from '../../bus/bus.ts'
import type { ChannelAddress, OutboundMessage } from '../../bus/events.ts'
import { IdentityManager } from '../../agent/identity.ts'
import { createTempWorkspace } from '../../testing/workspace.ts'
import { createUserLinkCommandHandler } from './userlink.ts'
import type { CommandContext } from './command-handler.ts'

function context(workspace: string, address: ChannelAddress, senderId: string, args: string): CommandContext {
  return {
    commandName: 'userlink', rawCommand: `userlink ${args}`, args, workspace, cwd: workspace,
    channel: address.platform, senderId, organizationId: address.organizationId, channelAddress: address, inputSource: 'user',
  }
}

test('userlink persists exact target bot, resolves explicit ambiguity and confirms only from the addressed account', async t => {
  const workspace = await createTempWorkspace()
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const identity = new IdentityManager(join(workspace, 'a'), 'a')
  const foreign = new IdentityManager(join(workspace, 'b'), 'b')
  const address = { organizationId: 'a', botInstanceId: 'bot-a', platform: 'qq', conversationId: 'same-chat' }
  const target = { ...address, botInstanceId: 'bot-b' }
  await identity.observeInboundAccount('qq', 'alice', 'same-chat', 'Alice', address)
  await identity.observeInboundAccount('qq', 'bob', 'same-chat', 'Bob', address)
  await identity.observeInboundAccount('qq', 'bob', 'same-chat', 'Bob', target)
  await foreign.observeInboundAccount('qq', 'bob', 'same-chat', 'Bob', { ...target, organizationId: 'b' })
  const originalSibling = await identity.lookupByAccount('qq', 'bob', address)
  const bus = new Bus()
  const outbound: OutboundMessage[] = []
  bus.on('message.outbound', message => { outbound.push(message) })
  const handler = createUserLinkCommandHandler(join(workspace, 'a'), identity, bus)
  assert.match(await handler(context(workspace, address, 'alice', 'verify qq bob')) ?? '', /Ambiguous target/)
  assert.equal(outbound.length, 0)
  assert.match(await handler(context(workspace, address, 'alice', 'verify qq bob bot-b')) ?? '', /Verification request sent/)
  assert.equal(outbound.length, 1)
  assert.deepEqual(outbound[0].channelAddress, target)
  assert.equal(outbound[0].chatId, 'same-chat')
  const code = /userlink confirm (\w+)/.exec(outbound[0].content)![1]
  const saved = JSON.parse(await readFile(join(workspace, 'a', 'memory', 'identities', 'index.json'), 'utf8'))
  assert.deepEqual(saved.pendingLinks[code].targetAddress, target)
  assert.deepEqual(saved.pendingLinks[code].requesterAddress, address)
  assert.equal(saved.pendingLinks[code].organizationId, 'a')
  const reloaded = new IdentityManager(join(workspace, 'a'), 'a')
  for (const wrong of [address, { ...target, conversationId: 'other' }, { ...target, organizationId: 'b' }]) {
    await assert.rejects(reloaded.confirmLink('qq', 'bob', code, wrong), /organization|target bot/)
  }
  await assert.rejects(reloaded.confirmLink('qq', 'alice', code, target), /different account/)
  await assert.rejects(reloaded.confirmLink('qq', 'bob', code), /target bot/)
  await assert.rejects(foreign.confirmLink('qq', 'bob', code, { ...target, organizationId: 'b' }), /Invalid confirmation/)
  const confirm = createUserLinkCommandHandler(join(workspace, 'a'), reloaded, bus)
  assert.match(await confirm(context(workspace, target, 'bob', `confirm ${code}`)) ?? '', /SUCCESS/)
  assert.deepEqual(await reloaded.lookupByAccount('qq', 'bob', target), await reloaded.lookupByAccount('qq', 'alice', address))
  assert.deepEqual(await reloaded.lookupByAccount('qq', 'bob', address), originalSibling)
  await assert.rejects(reloaded.confirmLink('qq', 'bob', code, target), /Invalid confirmation/)
})

test('scoped userlink supports an unambiguous new target and refuses unknown or synthetic sources without fallback', async t => {
  const workspace = await createTempWorkspace()
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const identity = new IdentityManager(workspace, 'org')
  const address = { organizationId: 'org', botInstanceId: 'source', platform: 'discord', conversationId: 'chat' }
  const target = { ...address, botInstanceId: 'target', platform: 'qq' }
  const bus = new Bus()
  const outbound: OutboundMessage[] = []
  bus.on('message.outbound', message => { outbound.push(message) })
  const handler = createUserLinkCommandHandler(workspace, identity, bus)
  const ctx = context(workspace, address, 'alice', 'verify qq bob')
  assert.match(await handler(ctx) ?? '', /Target bot address is unavailable/)
  await identity.observeInboundAccount('qq', 'bob', 'chat', 'Bob', target)
  assert.match(await handler({ ...ctx, channelAddress: undefined }) ?? '', /Source bot address is unavailable/)
  assert.match(await handler({ ...ctx, inputSource: 'event' }) ?? '', /user-originated input/)
  assert.match(await handler({ ...ctx, args: 'verify qq bob nonexistent' }) ?? '', /Target bot address is unavailable/)
  assert.equal(outbound.length, 0)
  assert.match(await handler(ctx) ?? '', /Verification request sent/)
  assert.deepEqual(outbound[0].channelAddress, target)
})
