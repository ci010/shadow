import assert from 'node:assert/strict'
import test from 'node:test'
import { createNotificationSounds, parseSoundPreferences, SOUND_PREFERENCES_KEY } from './notification-sounds.ts'

test('sound preferences validate input, persist on this device, and follow storage changes', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  const sounds = createNotificationSounds({ storage })
  assert.deepEqual(sounds.preferences.value, { enabled: true, yield: true, idle: true, volume: 0.35 })
  sounds.setPreferences({ volume: 0.6, idle: false })
  assert.deepEqual(JSON.parse(values.get(SOUND_PREFERENCES_KEY)!), sounds.preferences.value)
  values.set(SOUND_PREFERENCES_KEY, JSON.stringify({ enabled: false, yield: false, idle: true, volume: 0 }))
  sounds.load()
  assert.equal(sounds.preferences.value.enabled, false)
  assert.equal(sounds.preferences.value.volume, 0)
  for (const invalid of [null, {}, { ...sounds.preferences.value, volume: 1.1 }, { ...sounds.preferences.value, yield: 'true' }]) {
    assert.throws(() => parseSoundPreferences(invalid), /Invalid/)
  }
  sounds.dispose()
})

test('corrupt or unavailable local preferences and failed audio are explicit, never fake success', async () => {
  const sounds = createNotificationSounds({
    storage: { getItem: () => 'invalid', setItem: () => { throw new Error('Storage unavailable') } },
    audio: () => { throw new Error('Audio unavailable') },
  })
  assert.equal(sounds.preferences.value.enabled, false)
  assert.match(sounds.error.value, /read saved/)
  sounds.setPreferences({ enabled: true })
  assert.match(sounds.error.value, /could not be saved/)
  assert.equal(await sounds.unlock(), false)
  assert.match(sounds.error.value, /Could not enable/)
  assert.equal(sounds.ready.value, false)
  sounds.dispose()
})

test('events do not create audio or accumulate a backlog before browser interaction', () => {
  let created = 0
  const sounds = createNotificationSounds({
    storage: { getItem: () => null, setItem() {} },
    audio: () => { created++; throw new Error('Must not create audio without a gesture') },
  })
  sounds.notify('yield')
  sounds.notify('idle')
  assert.equal(created, 0)
  assert.equal(sounds.error.value, '')
  sounds.dispose()
})


test('delegated completion is a lower single triangle note, unlike the root completion pair', async () => {
  const tones: { type: string; frequency: number }[] = []
  const audio = {
    state: 'running', currentTime: 0, destination: {}, close: async () => {},
    createOscillator() {
      const tone = { type: '', frequency: 0 }
      tones.push(tone)
      return {
        set type(value: string) { tone.type = value },
        frequency: { setValueAtTime(value: number) { tone.frequency = value } },
        connect() {}, disconnect() {}, start() {}, stop() {},
      }
    },
    createGain: () => ({ gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }),
  } as unknown as AudioContext
  const sounds = createNotificationSounds({ storage: { getItem: () => null, setItem() {} }, audio: () => audio })
  await sounds.preview('idle')
  assert.deepEqual(tones, [{ type: 'sine', frequency: 659.25 }, { type: 'sine', frequency: 523.25 }])
  tones.length = 0
  await sounds.preview('subagent')
  assert.deepEqual(tones, [{ type: 'triangle', frequency: 392 }])
  sounds.dispose()
})
