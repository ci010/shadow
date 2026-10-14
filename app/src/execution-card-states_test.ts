import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { isAnimatingStage } from './session-activity.ts'

test('execution cards breathe only during computation and use the shared composer animation', async () => {
  const source = await readFile(new URL('./components/ExecutionMessage.vue', import.meta.url), 'utf8')
  const composer = await readFile(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
  assert.match(source, /'execution-working': !execution\.blocked && isAnimatingStage\(execution\.stage\)/)
  for (const stage of ['running', 'llm', 'tool']) assert.equal(isAnimatingStage(stage), true)
  for (const stage of ['completed', 'failed', 'cancelled', 'pending', 'waiting', 'waiting-for-call', undefined]) assert.equal(isAnimatingStage(stage), false)
  const animation = 'animation: input-breathe 9s ease-in-out infinite;'
  assert.ok(source.includes(animation))
  assert.ok(composer.includes(animation))
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.execution-card\.execution-working \{ animation: none;/)
})

test('completed execution cards retain a theme success border, including when selected', async () => {
  const source = await readFile(new URL('./components/ExecutionMessage.vue', import.meta.url), 'utf8')
  assert.match(source, /'execution-completed': !execution\.blocked && execution\.stage === 'completed'/)
  assert.match(source, /\.execution-card\.execution-completed \{ border-color: color-mix\(in srgb, var\(--c-success\) 35%, var\(--c-chat-border\)\); \}/)
  const eventSource = await readFile(new URL('./components/ConversationEvent.vue', import.meta.url), 'utf8')
  const border = 'border-color: color-mix(in srgb, var(--c-success) 35%, var(--c-chat-border));'
  assert.ok(source.includes(border) && eventSource.includes(border), 'Execution and result cards share the same muted green')
})

test('failed execution cards retain a theme error border, including when selected', async () => {
  const source = await readFile(new URL('./components/ExecutionMessage.vue', import.meta.url), 'utf8')
  assert.match(source, /'execution-failed': execution\.stage === 'failed'/)
  assert.match(source, /\.execution-card\.execution-failed \{ border-color: var\(--c-error\); \}/)
})

test('task failure result notifications use an error border on the outer card', async () => {
  const source = await readFile(new URL('./components/ConversationEvent.vue', import.meta.url), 'utf8')
  assert.match(source, /'event-failed': presentation\.value\.failed/)
  assert.match(source, /\.system-event\.event-failed \{ border-color: color-mix\(in srgb, var\(--c-error\) 35%, var\(--c-chat-border\)\); \}/)
  assert.match(source, /\.system-event\.event-completed \{ border-color: color-mix\(in srgb, var\(--c-success\) 35%, var\(--c-chat-border\)\); \}/)
})
