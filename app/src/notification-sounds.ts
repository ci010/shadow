import { t } from './i18n.ts'
import { computed, inject, readonly, ref, type InjectionKey } from 'vue'

export type NotificationSound = 'yield' | 'idle'
export interface SoundPreferences { enabled: boolean; yield: boolean; idle: boolean; volume: number }
export const SOUND_PREFERENCES_KEY = 'shadow:notification-sounds:v1'
const defaults: SoundPreferences = { enabled: true, yield: true, idle: true, volume: 0.35 }

export function parseSoundPreferences(value: unknown): SoundPreferences {
  if (!value || typeof value !== 'object') throw new Error(t('Invalid notification sound preferences.'))
  const prefs = value as Record<string, unknown>
  if (typeof prefs.enabled !== 'boolean' || typeof prefs.yield !== 'boolean' || typeof prefs.idle !== 'boolean'
    || typeof prefs.volume !== 'number' || !Number.isFinite(prefs.volume) || prefs.volume < 0 || prefs.volume > 1) {
    throw new Error(t('Invalid notification sound preferences.'))
  }
  return { enabled: prefs.enabled, yield: prefs.yield, idle: prefs.idle, volume: prefs.volume }
}

export function createNotificationSounds(options: {
  storage: Pick<Storage, 'getItem' | 'setItem'>
  audio?: () => AudioContext
  now?: () => number
}) {
  const preferences = ref({ ...defaults })
  const ready = ref(false)
  const storageError = ref('')
  const audioError = ref('')
  const error = computed(() => [storageError.value, audioError.value].filter(Boolean).join(' '))
  let context: AudioContext | undefined
  let disposed = false
  let pending: NotificationSound | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastPlayed = -Infinity
  const voices = new Set<{ oscillator: OscillatorNode; gain: GainNode }>()
  const now = options.now ?? Date.now

  function stop() {
    clearTimeout(timer)
    timer = undefined
    pending = undefined
    for (const { oscillator, gain } of voices) {
      oscillator.stop()
      oscillator.disconnect()
      gain.disconnect()
    }
    voices.clear()
  }
  function load() {
    try {
      const raw = options.storage.getItem(SOUND_PREFERENCES_KEY)
      preferences.value = raw === null ? { ...defaults } : parseSoundPreferences(JSON.parse(raw))
      storageError.value = ''
      stop()
    } catch {
      preferences.value = { ...defaults, enabled: false }
      storageError.value = t('Could not read saved sound preferences. Adjust the settings to save them again.')
    }
  }
  load()

  function setPreferences(patch: Partial<SoundPreferences>) {
    const next = parseSoundPreferences({ ...preferences.value, ...patch })
    preferences.value = next
    stop()
    try {
      options.storage.setItem(SOUND_PREFERENCES_KEY, JSON.stringify(next))
      storageError.value = ''
    } catch {
      storageError.value = t('Sound settings changed for this window, but could not be saved on this device.')
    }
  }
  async function unlock(): Promise<boolean> {
    if (disposed || !preferences.value.enabled) return false
    try {
      if (!context || context.state === 'closed') {
        context = (options.audio ?? (() => new AudioContext()))()
        context.onstatechange = () => { ready.value = context?.state === 'running' }
      }
      if (context.state !== 'running') await context.resume()
      if (disposed) return false
      ready.value = context.state === 'running'
      audioError.value = ready.value ? '' : t('Sound is blocked by the browser. Use Preview to enable audio.')
      return ready.value
    } catch {
      audioError.value = t('Could not enable notification sounds. Check browser audio permissions and try Preview again.')
      ready.value = false
      return false
    }
  }
  function play(kind: NotificationSound) {
    if (disposed || !context || context.state !== 'running' || !preferences.value.enabled || preferences.value.volume === 0) return
    try {
      const start = context.currentTime + 0.01
      const tones = kind === 'yield' ? [659.25, 880] : [659.25, 523.25]
      for (const [index, frequency] of tones.entries()) {
        const oscillator = context.createOscillator()
        const gain = context.createGain()
        const voice = { oscillator, gain }
        const time = start + index * 0.16
        oscillator.type = 'sine'
        oscillator.frequency.setValueAtTime(frequency, time)
        gain.gain.setValueAtTime(0, time)
        gain.gain.linearRampToValueAtTime(preferences.value.volume * 0.12, time + 0.012)
        gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.18)
        oscillator.connect(gain)
        gain.connect(context.destination)
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); voices.delete(voice) }
        oscillator.start(time)
        oscillator.stop(time + 0.2)
        voices.add(voice)
      }
      audioError.value = ''
      lastPlayed = now()
    } catch {
      stop()
      audioError.value = t('Could not play the notification sound. Try Preview again.')
    }
  }
  function notify(kind: NotificationSound) {
    if (disposed || !ready.value || !preferences.value.enabled || !preferences.value[kind]
      || preferences.value.volume === 0) return
    const cooldown = 1500 - (now() - lastPlayed)
    if (kind === 'idle' && cooldown > 0) return
    if (!pending || kind === 'yield') pending = kind
    if (timer !== undefined) return
    timer = setTimeout(() => {
      const kind = pending
      timer = undefined
      pending = undefined
      if (kind && preferences.value[kind]) play(kind)
    }, Math.max(120, cooldown))
  }
  async function preview(kind: NotificationSound) {
    stop()
    if (await unlock()) play(kind)
  }
  function dispose() {
    disposed = true
    ready.value = false
    stop()
    if (context && context.state !== 'closed') {
      context.onstatechange = null
      void context.close().catch(cause => console.error('[sounds] Could not close audio output.', cause))
    }
  }
  return { preferences: readonly(preferences), ready: readonly(ready), error, setPreferences, load, unlock, notify, preview, dispose }
}

export type NotificationSounds = ReturnType<typeof createNotificationSounds>
export const notificationSoundsKey: InjectionKey<NotificationSounds> = Symbol('notification-sounds')
export function useNotificationSounds() { return inject(notificationSoundsKey, null) }
