import assert from 'node:assert/strict'
import test from 'node:test'
import { observeComposerMicrophoneGesture } from './composer-microphone-gesture.js'
import { createMediaCaptureApi } from './media-capture-preload.js'
import { MEDIA_CAPTURE_CHANNELS } from './media-capture-contract.js'

// Fake host event dispatch, not renderer-provided activation flags. Production
// observes native Event.isTrusted in the isolated preload world.
function host() {
  let now = 100, hidden = false, focused = true, enabled = true
  const listeners = new Map<string, Set<(event: any) => void>>()
  class Element { disabled = false; closest() { return this } }
  const button = new Element()
  const target = {
    Element,
    addEventListener(type: string, cb: any) { const set = listeners.get(type) ?? new Set(); set.add(cb); listeners.set(type, set) },
    removeEventListener(type: string, cb: any) { listeners.get(type)?.delete(cb) },
  }
  const doc = { ...target, get hidden() { return hidden }, hasFocus: () => focused, querySelector: () => enabled ? button : null }
  const observed = observeComposerMicrophoneGesture(target as unknown as Window, doc as unknown as Document, () => now)
  const event = (type: string, extra: Record<string, unknown> = {}) => {
    const value = { type, isTrusted: true, button: 0, target: button, key: 'Shift', ctrlKey: true, shiftKey: true, ...extra }
    for (const cb of listeners.get(type) ?? []) cb(value)
  }
  return { observed, event, button, time: (value: number) => { now = value }, hide: () => { hidden = true; event('visibilitychange') }, blur: () => { focused = false; event('blur') }, disable: () => { enabled = false } }
}
const mic = { runId: 'composer-test', capabilities: ['microphone'] as const, durationMs: 65_000 }

test('composer approval accepts native click, touch down and exact modifier chord, single use without transient activation', async () => {
  for (const type of ['click', 'pointerdown', 'keydown']) {
    const h = host(), calls: unknown[][] = []
    const api = createMediaCaptureApi({ invoke: async (...args) => { calls.push(args); return { expiresAt: 65_100 } } }, () => false, h.observed.consume)
    await assert.rejects(api.arm(mic), /Start button/)
    h.event(type)
    await api.armComposerMicrophone!(mic)
    assert.deepEqual(calls, [[MEDIA_CAPTURE_CHANNELS.arm, mic]])
    await assert.rejects(api.armComposerMicrophone!(mic), /trusted composer gesture/)
    h.observed.dispose()
  }
})
test('composer approval never widens capability or duration and does not accept synthetic, repeat or conflicting chords', async () => {
  const h = host(), calls: unknown[] = []
  const api = createMediaCaptureApi({ invoke: async value => { calls.push(value); return {} } }, () => false, h.observed.consume)
  for (const extra of [{ isTrusted: false }, { repeat: true }, { isComposing: true }, { altKey: true }, { metaKey: true }, { key: 'P' }, { ctrlKey: false }, { shiftKey: false }]) {
    h.event('keydown', extra)
    await assert.rejects(api.armComposerMicrophone!(mic), /trusted composer gesture/)
  }
  h.event('click', { isTrusted: false }); assert.equal(h.observed.consume(), false)
  h.event('pointerdown', { button: 1 }); assert.equal(h.observed.consume(), false)
  h.button.disabled = true; h.event('click'); assert.equal(h.observed.consume(), false)
  h.disable(); h.event('keydown'); assert.equal(h.observed.consume(), false)
  for (const request of [{ ...mic, capabilities: ['camera'] as const }, { ...mic, capabilities: ['microphone', 'screen'] as const }, { ...mic, durationMs: 65_001 }]) {
    await assert.rejects(api.armComposerMicrophone!(request), /bounded microphone/)
  }
  assert.equal(calls.length, 0)
  h.observed.dispose()
})
test('unconsumed gestures expire, end on release/cancel/navigation/visibility/blur and cannot survive disposal', () => {
  for (const type of ['pointerup', 'pointercancel', 'keyup', 'pagehide']) {
    const h = host(); h.event('pointerdown'); h.event(type); assert.equal(h.observed.consume(), false); h.observed.dispose()
  }
  const h = host(); h.event('click'); h.time(1100); assert.equal(h.observed.consume(), false)
  h.event('keydown'); h.hide(); assert.equal(h.observed.consume(), false); h.observed.dispose()
  const other = host(); other.event('keydown'); other.blur(); assert.equal(other.observed.consume(), false); other.observed.dispose()
  const last = host(); last.event('click'); last.observed.dispose(); last.event('click'); assert.equal(last.observed.consume(), false)
})
