import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { DiscordChannel } from './discord.ts'
import { Bus } from '../bus/bus.ts'
import { workspacePath } from '../utils/paths.ts'
import type { InboundMessage } from '../bus/events.ts'
import type { DiscordIngress, DiscordIngressResult } from './integration-contract.ts'

const code = `export function run({event}) {
  const text = event.data.content;
  return {action: text.includes('AD:') ? 'emit' : text === 'ignore' ? 'ignore' : 'buffer'};
}`
function fixture(t: { after(fn: () => unknown): void }, enabled = true, includeBots = false, noName = false, storage?: {workspace: string; id: string}) {
  const adapter = new DiscordChannel(new Bus(), { token: 'fixture', triggerMode: 'mention', reactionEmoji: '', ...(storage ? {workspace:storage.workspace} : {}) })
  t.after(() => adapter.stop())
  Object.assign(adapter, { botUserId: '900' })
  const received: InboundMessage[] = []
  let revision = 'revision-1', allowed = true
  const admissions: DiscordIngress[] = []
  const discarded: string[] = []
  adapter.setDiscordIntegration({
    ...(storage ? {processorStorageId:storage.id} : {}),
    admit: async input => {
      admissions.push(input)
      if (!allowed) throw new Error('admission revoked')
      return { admissionId: `proof-${admissions.length}`, botUserId: '900', trigger: 'mention',
        location: { id: '201', name: noName ? null : 'fixture', type: 0, guildId: '100', guildName: 'fixture', parentId: null, parentName: null, recipientId: null },
        ...(enabled ? { processor: { code, delayMs: 2000, includeBots }, processorRevision: revision } : {}),
      } satisfies DiscordIngressResult
    },
    discard(id) { discarded.push(id) }, confirm: async () => {}, invalidate() {},
  })
  adapter.setReceiver(async message => {
    received.push(message)
    return { status: 'accepted', sessionId: 'discord:201', inputId: message.messageId }
  })
  let counter = 0
  const send = (content: string, sender = '500', id = String(++counter), guild = true, bot = false, attachments: unknown[] = []) =>
    (adapter as unknown as { handleDispatch(event: string, data: Record<string, unknown>): Promise<void> }).handleDispatch('MESSAGE_CREATE', {
      id, channel_id: '201', ...(guild ? { guild_id: '100' } : {}), content, attachments,
      mentions: content.includes('<@900>') ? [{ id: '900' }] : [],
      author: { id: sender, username: `user-${sender}`, bot },
    })
  return { adapter, received, send, admissions, discarded, forgetGatewayIdentity() { Object.assign(adapter, { botUserId: null }) }, revoke() { allowed = false }, change() { revision = 'revision-2' } }
}

test('managed Discord ordinary raw messages batch; urgent emit and ignore do not double wake', async t => {
  const f = fixture(t)
  await delay(120)
  assert.equal(f.admissions.length, 0, 'idle has zero execution, polling or inference')
  await f.send('question 1')
  await f.send('question 2')
  assert.equal(f.received.length, 0, 'ordinary unmentioned input reaches processor before mention gate')
  await f.send('AD: suspicious link')
  assert.equal(f.received.length, 1, 'urgent path immediately publishes once')
  assert.equal(f.received[0]!.silent, false)
  assert.match(f.received[0]!.channelAdmissionId!, /^proof-/)
  await f.send('ignore')
  await delay(2300)
  assert.equal(f.received.length, 2)
  assert.match(f.received[1]!.content, /question 1/)
  assert.match(f.received[1]!.content, /question 2/)
  assert.equal(f.received[1]!.senderId, '500')
  await f.send('AD: duplicate', '500', '3')
  assert.equal(f.received.length, 2, 'bounded raw ID dedupe')
})

test('sender authority is not merged; revisions and revoked admissions drop pending work', async t => {
  const f = fixture(t)
  await f.send('question a', '500')
  await f.send('question b', '501')
  await delay(2300)
  assert.equal(f.received.length, 2)
  for (const message of f.received) {
    assert.equal(message.content, message.senderId === '500' ? 'question a' : 'question b')
  }
  await f.send('stale revision')
  f.change()
  await delay(2300)
  assert.equal(f.received.length, 2)
  await f.send('revoked sender')
  f.revoke()
  await delay(2300)
  assert.equal(f.received.length, 2)
})

test('without an approved processor default mention and DM behavior remains unchanged', async t => {
  const f = fixture(t, false)
  await f.send('ordinary')
  await f.send('private', '500', '2', false)
  assert.equal(f.received.length, 2)
  assert.equal(f.received[0]!.silent, true)
  assert.equal(f.received[1]!.silent, false)
  await f.send('<@900> question', '500', '3')
  assert.equal(f.received[2]!.silent, false)
})


test('other-bot advertisements require reviewed opt-in; self and bot-loop bursts stay suppressed', async t => {
  const off = fixture(t)
  await off.send('AD: other bot', '800', 'bot1', true, true)
  assert.equal(off.received.length, 0)
  const on = fixture(t, true, true)
  await on.send('AD: other bot', '800', 'bot1', true, true)
  assert.equal(on.received.length, 1)
  await on.send('AD: own echo', '900', 'self', true, true)
  on.forgetGatewayIdentity()
  await on.send('AD: self without gateway cache', '900', 'self2', true, true)
  await on.send('AD: repeated bot echo', '800', 'bot2', true, true)
  assert.equal(on.received.length, 1, 'self is always ignored; same bot has a hard 60s cooldown')
  on.revoke()
  await assert.rejects(on.send('AD: unauthorized bot', '801', 'bot3', true, true), /revoked/)
  assert.equal(on.received.length, 1)
})


test('processed deadline aborts name preparation that ignores cancellation without late model delivery', async t => {
  const f = fixture(t, true, false, true)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<string>()
  t.mock.method(f.adapter as unknown as { resolveChannelName(): Promise<string> }, 'resolveChannelName', () => {
    entered.resolve(); return release.promise
  })
  const start = Date.now()
  const work = f.send('AD: delayed name')
  const failed = assert.rejects(work)
  await entered.promise
  await failed
  assert(Date.now() - start < 3000, 'dependency ignoring signal cannot keep the operation outstanding')
  assert.equal(f.received.length, 0)
  assert.equal(f.discarded.length, f.admissions.length, 'aborted final admission is released')
  release.resolve('late name')
  await delay(30)
  assert.equal(f.received.length, 0, 'late preparation never resumes delivery')
})

test('stop aborts attachment preparation and drains even if downloader ignores cancellation', async t => {
  const f = fixture(t)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<string | null>()
  t.mock.method(f.adapter as unknown as { downloadAttachment(): Promise<string | null> }, 'downloadAttachment', () => {
    entered.resolve(); return release.promise
  })
  const work = f.send('AD: delayed attachment', '500', 'attachment', true, false, [{ id: 'file' }])
  const failed = assert.rejects(work)
  await entered.promise
  const start = Date.now()
  await f.adapter.stop()
  await failed
  assert(Date.now() - start < 500, 'stop does not await an uncooperative dependency')
  assert.equal(f.received.length, 0)
  assert.equal(f.discarded.length, f.admissions.length)
  release.reject(new Error('late attachment rejection must remain observed'))
  await delay(30)
  assert.equal(f.received.length, 0)
})

test('managed adapter burst survives durable inbox restart with fresh admissions and no repeated stop rewrite', async t => {
  const {mkdtemp, rm, readdir, readFile} = await import('node:fs/promises')
  const {tmpdir} = await import('node:os')
  const path = await import('node:path')
  const workspace = await mkdtemp(path.join(tmpdir(), 'discord-processor-restart-'))
  // Cleanup must run after both adapter hooks.
  const cleanup: (() => Promise<void>)[] = []
  const scope = {after(fn: () => unknown) {cleanup.push(async () => {await fn()})}}
  t.after(async () => {for (const stop of cleanup) await stop(); await rm(workspace, {recursive:true,force:true})})
  const storage = {workspace, id:'reviewed-service-bot'}
  const first = fixture(scope, true, false, false, storage)
  await Promise.all(['question a', 'question b', 'question c'].map((text, i) => first.send(text, '500', String(i + 1))))
  assert.equal(first.received.length, 0)
  await first.adapter.stop()
  const second = fixture(scope, true, false, false, storage)
  await delay(2500)
  assert.equal(first.received.length, 0)
  assert.equal(second.received.length, 1)
  for (const question of ['question a', 'question b', 'question c']) assert.match(second.received[0]!.content, new RegExp(question))
  assert(second.admissions.length >= 4, 'every recovered item plus final input gets live admission')
  await second.send('question a', '500', '1')
  assert.equal(second.received.length, 1, 'persisted duplicate ID is not reprocessed')
  await first.adapter.stop()
  const files = await readdir(workspacePath(workspace, '.events'))
  const journal = JSON.parse(await readFile(workspacePath(workspace, '.events', files[0]!), 'utf8'))
  assert.equal(journal.rows.length, 0, 'repeated stop on old instance cannot overwrite new journal')
})
