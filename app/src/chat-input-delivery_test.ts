import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeInputDelivery } from './chat-input-delivery.ts'
import { reconcileTimelineKeys } from './conversation-timeline.ts'

test('Main queue and steer status win over a racing history read, then one normal bubble remains', () => {
  const saved = { role: 'user', content: 'same text', timestamp: 'saved', requestId: 'steer', timelineKey: undefined as string | undefined, delivery: undefined as string | undefined }
  const independent = { ...saved, requestId: 'different' }
  const steer = { ...saved, timestamp: 'pending', timelineKey: 'bubble', delivery: 'steer' }
  const queue = { ...steer, requestId: 'queue', delivery: 'queue' }
  assert.deepEqual(mergeInputDelivery([independent, saved], [steer, queue], []), [independent, steer, queue])
  const settled = mergeInputDelivery([independent, saved], [queue], [steer, queue])
  assert.deepEqual(settled, [independent, saved, queue])
  assert.equal(reconcileTimelineKeys(settled, [steer, queue])[1].timelineKey, 'bubble')
})

test('failed and unconfirmed submissions remain distinct without guessing a text match', () => {
  const failed = { role: 'user', content: 'same text', requestId: 'failed', delivery: 'failed' }
  const uncertain = { ...failed, requestId: undefined, delivery: 'unconfirmed' }
  const saved = { ...failed, requestId: 'different', delivery: undefined }
  const inMemoryHistory = { ...failed, delivery: undefined }
  assert.deepEqual(mergeInputDelivery([saved, inMemoryHistory], undefined, [failed, uncertain]), [saved, failed, uncertain])
})
