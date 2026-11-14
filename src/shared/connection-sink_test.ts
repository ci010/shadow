import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseConnectionSinkProjection } from './connection-sink.ts'
import { parseInputReferences } from './input-references.ts'

export const sinkFixture = {
  kind: 'connection-sink', id: 'connection:conn', projectId: 'p', connectionId: 'conn',
  connectionPath: 'v:connections/conn/overview.json', sinkPath: 'v:connections/conn/sink.json',
  sink: { kind: 'common-receipt', reacts: false, navigation: { kind: 'connection-content', projectId: 'p', connectionId: 'conn' } },
  receivers: [], bots: [], guidePath: 'v:bots/authoring',
} as const

test('inspection DTO rejects foreign identities, invented paths and reaction authority', () => {
  assert.deepEqual(parseConnectionSinkProjection(sinkFixture, 'p'), sinkFixture)
  for (const raw of [ { ...sinkFixture, credentials: 'secret' }, { ...sinkFixture, sinkPath: 'v:bots/connections/conn/sink' },
    { ...sinkFixture, connectionId: 'other' }, { ...sinkFixture, sink: { ...sinkFixture.sink, reacts: true } },
    { ...sinkFixture, sink: { ...sinkFixture.sink, navigation: { kind: 'connection-content', projectId: 'other', connectionId: 'conn' } } } ])
    assert.throws(() => parseConnectionSinkProjection(raw, 'p'))
  assert.throws(() => parseConnectionSinkProjection(sinkFixture, 'other'))
})
test('sink references carry only stable host-resolved identity and optional parent receiver', () => {
  const reference = { kind: 'connection-sink', projectId: 'p', connectionId: 'conn', receiverId: 'qq:group:1' }
  assert.deepEqual(parseInputReferences([reference]), [reference])
  for (const extra of [{ path: 'v:connections/other/sink.json' }, { navigation: {} }, { workflowId: 'fake' }, { selector: { kind: 'node' } }])
    assert.throws(() => parseInputReferences([{ ...reference, ...extra }]))
  assert.throws(() => parseInputReferences([{ ...reference, receiverId: '' }]))
})
