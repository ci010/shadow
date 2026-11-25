import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { withTempWorkspace } from '../testing/workspace.ts'
import { BotInstanceStore } from './bot-store.ts'

test('Connections persist and expose only transport identity and configuration', async () => {
  await withTempWorkspace(async root => {
    const path = join(root, 'connections.json')
    const store = new BotInstanceStore({ projectId: 'p', path })
    const connection = store.create('wechat', 'WeChat', { enabled: false })
    const document = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(document, { version: 4, bots: [{ id: connection.id, projectId: 'p', platform: 'wechat', displayName: 'WeChat', config: { enabled: false } }] })
    const reloaded = new BotInstanceStore({ projectId: 'p', path })
    assert.deepEqual(reloaded.get(connection.id), connection)
    for (const key of ['purpose', 'verifiedOwner', 'ownerVerified', 'legacySessionId']) assert.equal(Object.hasOwn(reloaded.status(connection.id), key), false)
    for (const field of [{ purpose: 'personal' }, { verifiedOwner: {} }, { legacySessionId: true }]) {
      writeFileSync(path, JSON.stringify({ ...document, bots: [{ ...document.bots[0], ...field }] }))
      assert.throws(() => new BotInstanceStore({ projectId: 'p', path }))
    }
    for (const version of [1, 2, 5]) {
      const previous: string = JSON.stringify({ ...document, version })
      writeFileSync(path, previous)
      assert.throws(() => new BotInstanceStore({ projectId: 'p', path }), /require version 4/)
      assert.equal(readFileSync(path, 'utf8'), previous, 'unsupported documents must not be rewritten')
    }
  })
})

for (const populated of [false, true]) {
  test(`${populated ? 'Nonempty' : 'Empty'} v3 starts with a separate writable roleless store`, async t => {
    const warn = t.mock.method(console, 'warn', () => {})
    await withTempWorkspace(async root => {
      const path = join(root, 'bots.v1.json')
      const bots = populated ? [{
        id: 'legacy-id', projectId: 'p', platform: 'discord', displayName: 'Legacy',
        purpose: 'personal', verifiedOwner: { userId: 'legacy-owner' },
        config: { enabled: true, token: 'legacy-secret' },
      }] : []
      const legacy = JSON.stringify({ version: 3, bots }) + '\n'
      writeFileSync(path, legacy)
      const store = new BotInstanceStore({ projectId: 'p', path })
      assert.deepEqual(store.list(), [])
      assert.equal(readFileSync(path, 'utf8'), legacy)
      assert.equal(warn.mock.callCount(), populated ? 1 : 0)
      if (populated) {
        const warning = String(warn.mock.calls[0]?.arguments[0])
        assert.ok(warning.includes(path))
        assert.match(warning, /Recreate Connections in Settings/)
        assert.doesNotMatch(warning, /legacy-secret|legacy-owner/)
        assert.throws(() => store.get('legacy-id'), /unknown_bot/)
      }
      const connection = store.create('wechat', 'New Connection', { enabled: false })
      assert.notEqual(connection.id, 'legacy-id')
      assert.deepEqual(new BotInstanceStore({ projectId: 'p', path }).list(), [connection])
      assert.equal(readFileSync(path, 'utf8'), legacy)
    })
  })
}
