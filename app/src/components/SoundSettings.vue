<template>
  <section v-if="sounds" class="sound-settings" aria-labelledby="sound-settings-title">
    <h2 id="sound-settings-title">{{ t('Notification sounds') }}</h2>
    <p class="sound-help">{{ t('Short cues for conversations across Projects, even when you are on another page. Saved on this device only.') }}</p>
    <label class="sound-toggle"><input type="checkbox" :checked="preferences.enabled" @change="setEnabled">{{ t('Enable notification sounds') }}</label>
    <fieldset :disabled="!preferences.enabled">
      <div v-for="item in events" :key="item.kind" class="sound-event">
        <label class="sound-toggle">
          <input type="checkbox" :checked="preferences[item.kind]" @change="sounds.setPreferences({ [item.kind]: !preferences[item.kind] })">
          <span>{{ item.label }}<small>{{ item.description }}</small></span>
        </label>
        <button type="button" class="btn" :aria-label="t('Preview {value1} sound', { value1: item.label.toLowerCase() })" @click="sounds.preview(item.kind)">
          <span class="i-lucide-volume-2" aria-hidden="true" />{{ t('Preview') }}
        </button>
      </div>
      <label class="sound-volume" :for="volumeId">{{ t('Volume') }} <output :for="volumeId">{{ Math.round(preferences.volume * 100) }}%</output>
        <input :id="volumeId" type="range" min="0" max="100" step="5" :value="preferences.volume * 100" @input="setVolume">
      </label>
    </fieldset>
    <p v-if="sounds.error.value" class="sound-error" role="alert">{{ sounds.error.value }}</p>
    <p v-else-if="preferences.enabled && !sounds.ready.value" class="sound-help" role="status">{{ t('Use Preview to enable audio in this window. Browser and device mute settings still apply.') }}</p>
    <p class="sound-help">{{ t('No sounds on initial load or reconnect. Temporary tasks and calls are excluded, and simultaneous notifications are grouped. The app must remain open; closed or suspended browsers cannot play sounds.') }}</p>
  </section>
  <section v-if="browserNotifications" class="sound-settings browser-notification-settings" aria-labelledby="browser-notifications-title">
    <h2 id="browser-notifications-title">{{ t('System notifications') }}</h2>
    <p class="sound-help">{{ t('Notify you with the conversation name when a task completes while this page is not focused. Separate from notification sounds.') }}</p>
    <button type="button" class="btn" :disabled="browserNotifications.requesting.value"
      :aria-pressed="browserNotifications.active.value" @click="browserNotifications.setEnabled(!browserNotifications.active.value)">
      {{ browserNotifications.requesting.value ? t('Requesting notification permission...') : browserNotifications.active.value ? t('Disable system notifications') : t('Enable system notifications') }}
    </button>
    <p v-if="browserNotifications.error.value" class="sound-error" role="alert">{{ browserNotifications.error.value }}</p>
    <p class="sound-help">{{ t('Requires browser permission and HTTPS or localhost. Keep this app open; closed or suspended pages cannot report completion. Browser and system notification settings still apply.') }}</p>
  </section>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed, useId } from 'vue'
import { useNotificationSounds, type NotificationSound } from '../notification-sounds.ts'
import { useBrowserTaskNotifications } from '../browser-task-notifications.ts'
const sounds = useNotificationSounds()
const browserNotifications = useBrowserTaskNotifications()
const volumeId = `sound-volume-${useId()}`
const preferences = computed(() => sounds?.preferences.value ?? { enabled: false, yield: false, idle: false, volume: 0 })
const events: { kind: NotificationSound; label: string; description: string }[] = [
  { kind: 'yield', get label() { return t('Needs your answer') }, get description() { return t('A conversation asks you a question.') } },
  { kind: 'idle', get label() { return t('Session idle') }, get description() { return t('A working conversation returns to idle.') } },
]
function setEnabled() {
  sounds?.setPreferences({ enabled: !preferences.value.enabled })
  if (preferences.value.enabled) void sounds?.unlock()
}
function setVolume(event: Event) {
  if (event.target instanceof HTMLInputElement) sounds?.setPreferences({ volume: Number(event.target.value) / 100 })
}
</script>

<style scoped>
.sound-settings { max-width: 680px; }
.browser-notification-settings { margin-top: 32px; }
h2 { margin: 0 0 16px; font-size: 20px; }
.sound-help { color: var(--c-text-secondary); font-size: 14px; line-height: 1.6; }
fieldset { min-width: 0; padding: 0; margin: 20px 0; border: 0; }
.sound-toggle { display: flex; align-items: flex-start; gap: 12px; min-height: 44px; padding: 10px 0; font-size: 14px; cursor: pointer; }
.sound-toggle input { flex-shrink: 0; margin-top: 4px; accent-color: var(--c-blue); }
.sound-toggle small { display: block; margin-top: 4px; font-size: 13px; line-height: 1.5; color: var(--c-text-secondary); }
.sound-event { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-top: 1px solid var(--c-border); }
.sound-volume { display: grid; grid-template-columns: 1fr auto; gap: 12px; margin-top: 24px; font-size: 14px; }
.sound-volume input { grid-column: 1 / -1; width: 100%; min-height: 44px; margin: 0; accent-color: var(--c-blue); }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; flex-shrink: 0; min-height: 44px; padding: 8px 12px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); font: inherit; font-size: 13px; cursor: pointer; }
.btn span { width: 16px; height: 16px; }
.btn:hover:not(:disabled) { background: var(--c-bg-muted); }
fieldset:disabled { opacity: .6; }
fieldset:disabled .sound-toggle, .btn:disabled { cursor: default; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.sound-error { color: var(--c-error); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
@media (max-width: 420px) { .sound-event { flex-wrap: wrap; gap: 4px; } .sound-event .btn { margin-left: 25px; } }
</style>
