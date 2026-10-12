import assert from 'node:assert/strict'
import test from 'node:test'
import { borderDistance, REVEAL_REACH, REVEAL_TARGETS } from './reveal-border.ts'

test('perimeter proximity includes outside edges/corners and excludes distant centres', () => {
  const rect = { left: 100, top: 100, right: 400, bottom: 300 }
  assert.equal(borderDistance(90, 180, rect), 10)
  assert.equal(borderDistance(100, 180, rect), 0)
  assert.equal(borderDistance(103, 180, rect), 3)
  assert.equal(borderDistance(97, 96, rect), 5)
  assert.equal(borderDistance(250, 200, rect), 100)
  assert.ok(borderDistance(20, 180, rect) > REVEAL_REACH)
})

test('only deliberate card and input-region classes opt in', () => {
  assert.equal(REVEAL_TARGETS, '.reveal-border, .provider-card, .work-item-card, .composer-box, .chat-working, .context-chip, .session-work-triggers > button, .chat-bubble.chat-user, .chat-bubble.chat-assistant, .message-preview-card')
  assert.doesNotMatch(REVEAL_TARGETS, /panel|\[class|input/)
})
