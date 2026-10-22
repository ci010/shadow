import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MemoryDomains } from './domains.ts'
import type { MemoryDomain } from './contracts.ts'
import { MemorySourceSchema } from './contracts.ts'

const ref = (domain: MemoryDomain) => ({ id: domain.id, revision: domain.revision })
function setup(t: TestContext) {
  const directory = mkdtempSync(join(process.cwd(), '.memory-domains-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = new MemoryDomains('project-a', directory)
  const epoch = randomUUID()
  const own = store.createDomain('Customer A', 'conversation', { sessionId: 'discord:a', epoch })
  const secret = store.createDomain('Private canary title', 'project-private')
  const shared = store.createDomain('Help', 'shared')
  return { store, directory, epoch, own, secret, shared }
}

test('memory scopes filter names, content and counts before discovery and reject forged grants', t => {
  const { store, epoch, own, secret } = setup(t)
  const internal = store.open({ sessionId: 'owner', epoch: randomUUID(), read: [ref(secret)], write: ref(secret), assertCurrent() {} })
  const item = store.save(internal, { title: 'PRIVATE_TITLE_CANARY', content: 'PRIVATE_BODY_CANARY', expectedVersion: '' })
  const customer = store.open({ sessionId: 'discord:a', epoch, read: [ref(own)], write: ref(own), assertCurrent() {} })
  assert.deepEqual(store.list(customer), [])
  assert.deepEqual(store.search(customer, 'CANARY'), { matches: [], hasMore: false })
  assert.equal(store.context(customer), '')
  assert.throws(() => store.read(customer, item.id), /unavailable/)
  assert.throws(() => store.read({ ...customer }, item.id), /unavailable/)
  assert.throws(() => store.open({ sessionId: 'discord:b', epoch, read: [ref(own)], write: ref(own), assertCurrent() {} }), /unavailable/)
})

test('derived memories retain all observed source restrictions, including discovery', t => {
  const { store, epoch, own, secret } = setup(t)
  const internal = store.open({ sessionId: 'owner', epoch: randomUUID(), read: [ref(secret)], write: ref(secret), assertCurrent() {} })
  store.save(internal, { title: 'PRIVATE_TITLE', content: 'private data', expectedVersion: '' })
  const mixed = store.open({ sessionId: 'discord:a', epoch, read: [ref(own), ref(secret)], write: ref(own), assertCurrent() {} })
  store.list(mixed)
  const derived = store.save(mixed, { title: 'Summary', content: 'Do not launder this', expectedVersion: '' })
  const customer = store.open({ sessionId: 'discord:a', epoch, read: [ref(own)], write: ref(own), assertCurrent() {} })
  assert.throws(() => store.read(customer, derived.id), /unavailable/)
  assert.deepEqual(store.list(customer), [])
})

test('fixed reviewed publications can be shared, cannot be edited, and revoke cached contexts', t => {
  const { store, epoch, own, secret, shared } = setup(t)
  const publication = store.publish({ domainId: shared.id, title: 'Help', content: 'Approved answer',
    actor: 'owner', requestId: randomUUID(), sources: [{ domain: ref(secret) }] })
  const customer = store.open({ sessionId: 'discord:a', epoch, read: [ref(own), ref(store.domain(shared.id))], write: ref(own), assertCurrent() {} })
  assert.equal(store.read(customer, publication.id).content, 'Approved answer')
  assert(!JSON.stringify(store.read(customer, publication.id)).includes(secret.id), 'private publication provenance is owner-only')
  assert.throws(() => store.save(customer, { id: publication.id, title: 'Changed', content: 'new', expectedVersion: publication.version }), /unavailable/)
  const summary = store.save(customer, { title: 'Conversation', content: 'Approved answer was used', expectedVersion: '' })
  store.revokePublication(publication.id)
  assert.throws(() => store.context(customer), /unavailable/)
  const fresh = store.open({ sessionId: 'discord:a', epoch, read: [ref(own), ref(store.domain(shared.id))], write: ref(own), assertCurrent() {} })
  assert.throws(() => store.read(fresh, summary.id), /unavailable/)
})

test('content and catalog survive restart and manual content substitution fails closed', t => {
  const { store, directory, epoch, own } = setup(t)
  const access = store.open({ sessionId: 'discord:a', epoch, read: [ref(own)], write: ref(own), assertCurrent() {} })
  const saved = store.save(access, { title: 'Own', content: 'version one', expectedVersion: '' })
  const reopened = new MemoryDomains('project-a', directory)
  const next = reopened.open({ sessionId: 'discord:a', epoch, read: [ref(own)], write: ref(own), assertCurrent() {} })
  assert.equal(reopened.read(next, saved.id).content, 'version one')
  writeFileSync(join(directory, 'content', `${saved.contentHash}.md`), 'PRIVATE_SUBSTITUTION_CANARY')
  assert.throws(() => reopened.read(next, saved.id), /approved version/)
  assert.throws(() => new MemoryDomains('another-project', directory), /another project/)
})

test('provenance is complete and shared subgraphs do not cause exponential authorization work', { timeout: 15_000 }, t => {
  const { store, epoch, own } = setup(t)
  assert.equal(MemorySourceSchema.safeParse({ domain: ref(own), resourceId: randomUUID() }).success, false)
  assert.equal(MemorySourceSchema.safeParse({ domain: ref(own), sessionId: 'discord:a' }).success, false)
  const access = store.open({ sessionId: 'discord:a', epoch, read: [ref(own)], write: ref(own), assertCurrent() {} })
  for (let index = 0; index < 40; index++) {
    const resource = store.save(access, { title: `Lesson ${index}`, kind: 'skill', content: `Bounded lesson ${index}`, expectedVersion: '' })
    store.read(access, resource.id)
  }
  assert.equal(store.list(access).length, 40)
  assert.match(store.context(access), /Bounded lesson/)
  assert(store.list(access).every(resource => resource.kind === 'skill'))
})

test('an idempotent approved publication cannot replace its sources under the same approval identity', t => {
  const { store, secret, shared } = setup(t)
  const input = { domainId: shared.id, title: 'Answer', content: 'Reviewed answer', actor: 'owner', requestId: randomUUID(),
    sources: [{ domain: ref(secret) }] }
  const first = store.publish(input)
  assert.equal(store.publish(input).id, first.id)
  assert.throws(() => store.publish({ ...input, sources: [] }), /another operation/)
  assert.throws(() => store.publish({ ...input, resourceKind: 'skill' }), /another operation/)
})

test('derived bundles commit atomically, retain provenance and recover exact immutable versions', t => {
  const { store, epoch, own } = setup(t)
  const open = () => store.open({ sessionId: 'discord:a', epoch, read: [ref(own)], write: ref(own), assertCurrent() {} })
  const access = open()
  store.observe(access, { domain: ref(own), sessionId: 'discord:a', epoch })
  const inputs = [
    { id: randomUUID(), title: 'Source', content: 'SOURCE_SNAPSHOT_CANARY', kind: 'history' as const },
    { id: randomUUID(), title: 'Private personality proposal', content: 'SOUL_DRAFT_CANARY', kind: 'soul-draft' as const },
  ]
  const first = store.deriveMany(access, inputs)
  assert.deepEqual(store.deriveMany(access, inputs), first)
  assert.equal(store.context(access), '', 'Audit snapshots and personality drafts never become automatic instructions')
  const next = open()
  store.read(next, first[0]!.id)
  const replacement = { id: first[0]!.id, title: 'Updated source', content: 'New version',
    kind: 'history' as const, expectedVersion: first[0]!.version }
  const updated = store.deriveMany(next, [replacement])[0]!
  assert.notEqual(updated.version, first[0]!.version)
  assert.deepEqual(store.deriveMany(next, [replacement])[0], updated)
  assert.equal(store.read(open(), first[0]!.id, first[0]!.version).content, 'SOURCE_SNAPSHOT_CANARY')
  const newId = randomUUID()
  assert.throws(() => store.deriveMany(open(), [
    { id: newId, title: 'Must not commit', content: 'No partial write', kind: 'decision' },
    { ...replacement, content: 'Stale write' },
  ]), /changed since/)
  assert(!store.ownerResources().some(resource => resource.id === newId))
  store.revokeDomain(own.id)
  assert.throws(() => store.deriveMany(access, inputs), /unavailable/)
})
