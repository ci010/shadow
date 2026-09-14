<template>
  <section class="channels-view" aria-labelledby="channels-title">
    <header class="channels-heading">
      <div><h2 id="channels-title">Channels</h2><p>Connect your bots so messages reach Shadow from the apps you use.</p></div>
      <button :disabled="loading || !!saving" @click="refresh()">Refresh status</button>
    </header>
    <p v-if="!available" role="status">Channel settings are managed by Main administrators.</p>
    <p v-else-if="loading && !channels.length" role="status">Loading channel connections...</p>
    <div v-if="listError" class="channel-error" role="alert"><p>{{ listError }}</p><button @click="refresh()">Retry</button></div>
    <p v-if="notice" class="channel-notice" role="status">{{ notice }}</p>
    <div class="channel-list">
      <article v-for="channel in channels" :key="channel.id" class="channel-row" :data-channel="channel.id">
        <header class="channel-heading">
          <span class="channel-icon" :class="channel.id === 'discord' ? 'i-simple-icons-discord' : channel.id === 'qq' ? 'i-lucide-message-circle' : 'i-lucide-send'" aria-hidden="true" />
          <div class="channel-copy"><h3>{{ channel.label }}</h3><p>{{ definition(channel.id).description }}</p></div>
          <span class="channel-state" :data-state="channel.state"><span class="channel-dot" aria-hidden="true" />{{ channelStateLabel(channel) }}</span>
          <div class="channel-actions">
            <button :disabled="!!saving" :aria-expanded="expanded === channel.id" :aria-controls="`channel-${channel.id}-editor`" @click="configure(channel)">{{ channel.configured ? 'Configure' : 'Set up' }}</button>
            <button v-if="channel.enabled" :disabled="!!saving" @click="changeConnection(channel, false)">Disconnect</button>
            <button v-else-if="channel.configured" :disabled="!!saving" @click="changeConnection(channel, true)">Connect</button>
          </div>
        </header>
        <p v-if="channel.message" class="channel-message" :class="{ 'channel-error': channel.state === 'error' }">{{ channel.message }}</p>
        <p v-if="errors[channel.id]" class="channel-error" role="alert">{{ errors[channel.id] }}</p>
        <p v-if="saving === channel.id" role="status">Updating {{ channel.label }} connection...</p>
        <form v-if="expanded === channel.id" :id="`channel-${channel.id}-editor`" class="channel-editor" @submit.prevent="saveConfiguration(channel, true)">
          <fieldset :disabled="!!saving">
            <legend class="sr-only">{{ channel.label }} connection settings</legend>
            <div class="channel-instructions">
              <strong>Before you connect</strong>
              <ol><li v-for="instruction in definition(channel.id).instructions" :key="instruction">{{ instruction }}</li></ol>
              <button type="button" class="portal-link" @click="openPortal(channel.id)">Open {{ channel.label }} developer portal <span class="i-lucide-arrow-up-right" aria-hidden="true" /></button>
            </div>
            <div class="channel-fields">
              <template v-for="field in definition(channel.id).fields.filter(field => !field.advanced)" :key="field.key">
                <label :class="field.kind === 'checkbox' ? 'channel-checkbox' : 'channel-field'">
                  <template v-if="field.kind === 'checkbox'"><input v-model="drafts[channel.id]![field.key]" type="checkbox" :name="field.key" />{{ field.label }}</template>
                  <template v-else>
                    <span>{{ field.label }}<span v-if="field.required"> *</span></span>
                    <select v-if="field.kind === 'select'" v-model="drafts[channel.id]![field.key]" :name="field.key"><option v-for="option in field.options" :key="option" :value="option">{{ option === 'mention' ? 'Mentions and direct messages' : option === 'all' ? 'All messages' : option }}</option></select>
                    <input v-else v-model="drafts[channel.id]![field.key]" :type="field.kind" :name="field.key" :autocomplete="field.kind === 'password' ? 'new-password' : 'off'" :spellcheck="false"
                      :placeholder="field.kind === 'password' && channel.secrets[field.key] ? 'Saved — leave blank to keep' : undefined" />
                    <small v-if="field.hint">{{ field.hint }}</small>
                    <small v-if="field.kind === 'password'">{{ channel.secrets[field.key] ? 'A credential is saved. Enter a value only to replace it.' : 'Credentials are saved on Main and never returned to this form.' }}</small>
                  </template>
                </label>
              </template>
            </div>
            <details class="channel-advanced">
              <summary>Advanced settings and access</summary>
              <div class="channel-fields">
                <label v-for="field in definition(channel.id).fields.filter(field => field.advanced)" :key="field.key" class="channel-field">
                  <span>{{ field.label }}</span>
                  <textarea v-if="field.kind === 'list'" v-model="drafts[channel.id]![field.key]" :name="field.key" rows="3" spellcheck="false" />
                  <input v-else v-model="drafts[channel.id]![field.key]" :type="field.kind" :name="field.key"
                    :autocomplete="field.kind === 'password' ? 'new-password' : 'off'" :spellcheck="false"
                    :placeholder="field.kind === 'password' && channel.secrets[field.key] ? 'Saved — leave blank to keep' : undefined" />
                  <small v-if="field.hint">{{ field.hint }}</small>
                </label>
              </div>
            </details>
            <div class="channel-form-actions">
              <button class="channel-primary" type="submit">{{ channel.enabled ? 'Save and reconnect' : 'Save and connect' }}</button>
              <button v-if="!channel.enabled" type="button" @click="saveConfiguration(channel, false)">Save without connecting</button>
              <button type="button" @click="cancelConfiguration(channel)">Cancel</button>
            </div>
          </fieldset>
        </form>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { ChannelId, ChannelSetupStatus } from '../../../src/channels/setup-contract.ts'
import { channelDefinitions, channelDraft, channelPatch, channelStateLabel, createChannelSettingsClient, type ChannelDraft } from '../channel-settings.ts'

const props = defineProps<{ apiBase: string; available: boolean; active: boolean }>()
const channels = ref<ChannelSetupStatus[]>([])
const drafts = ref<Partial<Record<ChannelId, ChannelDraft>>>({})
const errors = ref<Partial<Record<ChannelId, string>>>({})
const expanded = ref<ChannelId>()
const loading = ref(false)
const listError = ref('')
const notice = ref('')
const saving = ref<ChannelId>()
const definition = (id: ChannelId) => channelDefinitions.find(item => item.id === id)!
let poll: ReturnType<typeof setTimeout> | undefined
let request: AbortController | undefined
let mutation: AbortController | undefined

function stopPolling() { clearTimeout(poll); request?.abort(); request = undefined }
function scheduleRefresh() {
  clearTimeout(poll)
  if (props.active && props.available) poll = setTimeout(() => { void refresh(true) }, 5000)
}
async function refresh(background = false) {
  stopPolling()
  if (!props.active || !props.available || saving.value) return
  const controller = new AbortController()
  request = controller
  if (!background) loading.value = true
  try {
    const result = await createChannelSettingsClient(props.apiBase).list(controller.signal)
    if (controller.signal.aborted) return
    channels.value = result
    listError.value = ''
  } catch (error) {
    if (!controller.signal.aborted) listError.value = error instanceof Error ? error.message : 'Could not load channels. Refresh to retry.'
  } finally {
    if (request === controller) { loading.value = false; request = undefined; scheduleRefresh() }
  }
}
function configure(channel: ChannelSetupStatus) {
  drafts.value[channel.id] ??= channelDraft(channel)
  expanded.value = expanded.value === channel.id ? undefined : channel.id
}
function cancelConfiguration(channel: ChannelSetupStatus) {
  drafts.value[channel.id] = channelDraft(channel)
  errors.value[channel.id] = ''
  expanded.value = undefined
}
async function update(channel: ChannelSetupStatus, config: Record<string, unknown>, resetDraft = true) {
  if (saving.value || !props.available) return
  stopPolling()
  const controller = new AbortController()
  mutation = controller
  saving.value = channel.id
  errors.value[channel.id] = ''
  notice.value = ''
  try {
    const result = await createChannelSettingsClient(props.apiBase).save(channel.id, config, controller.signal)
    if (controller.signal.aborted) return
    channels.value = channels.value.map(item => item.id === result.id ? result : item)
    if (resetDraft) drafts.value[channel.id] = channelDraft(result)
    notice.value = `${channel.label} settings saved. ${channelStateLabel(result)}.`
  } catch (error) {
    if (!controller.signal.aborted) errors.value[channel.id] = error instanceof Error ? error.message : 'Could not update the channel. Refresh its status before retrying.'
  } finally {
    if (mutation === controller) { mutation = undefined; saving.value = undefined; scheduleRefresh() }
  }
}
async function saveConfiguration(channel: ChannelSetupStatus, enabled: boolean) {
  try { await update(channel, channelPatch(channel, drafts.value[channel.id]!, enabled)) }
  catch (error) { errors.value[channel.id] = error instanceof Error ? error.message : 'Check the channel settings.' }
}
async function changeConnection(channel: ChannelSetupStatus, enabled: boolean) {
  await update(channel, { enabled }, false)
}
async function openPortal(id: ChannelId) {
  try {
    const url = definition(id).portal
    if (window.shadowDesktop) await window.shadowDesktop.openExternal(url)
    else window.open(url, '_blank', 'noopener,noreferrer')
  } catch { errors.value[id] = `Could not open the browser. Open ${definition(id).portal} manually.` }
}
watch(() => [props.apiBase, props.available], () => {
  stopPolling()
  mutation?.abort()
  mutation = undefined
  saving.value = undefined
  channels.value = []
  drafts.value = {}
  errors.value = {}
  expanded.value = undefined
  notice.value = ''
  listError.value = ''
  void refresh()
})
watch(() => props.active, active => { if (active) void refresh(); else stopPolling() }, { immediate: true })
onBeforeUnmount(() => { stopPolling(); mutation?.abort() })
</script>

<style scoped>
.channels-view { min-width: 0; }
.channels-heading { display: flex; flex-wrap: wrap; align-items: start; justify-content: space-between; gap: 16px; margin-bottom: 28px; }
.channels-heading h2 { margin: 0 0 8px; font-size: 20px; }
.channels-heading p, .channel-copy p { margin: 0; color: var(--c-text-secondary); font-size: 14px; line-height: 1.6; }
.channels-heading p { max-width: 60ch; }
.channel-row { min-width: 0; border-top: 1px solid var(--c-border); padding: 22px 0; }
.channel-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; }
.channel-icon { width: 22px; height: 22px; flex: 0 0 22px; }
.channel-copy { flex: 1 1 240px; min-width: 0; }
.channel-copy h3 { margin: 0 0 4px; font-size: 16px; }
.channel-copy p { font-size: 13px; }
.channel-actions, .channel-form-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.channel-state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--c-text-secondary); }
.channel-dot { width: 6px; height: 6px; background: currentColor; }
.channel-state[data-state="connected"] { color: var(--c-git-added); }
.channel-state[data-state="error"], .channel-error { color: var(--c-error); }
.channel-state[data-state="connecting"], .channel-state[data-state="restart-required"] { color: var(--c-warn); }
.channel-message, .channel-error, .channel-notice { margin: 12px 0 0; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.channel-message { color: var(--c-text-secondary); }
.channel-message.channel-error { color: var(--c-error); }
.channel-editor { padding-top: 24px; margin-top: 20px; border-top: 1px solid var(--c-border); }
fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
.channel-instructions { margin-bottom: 24px; max-width: 70ch; font-size: 13px; line-height: 1.65; color: var(--c-text-secondary); }
.channel-instructions strong { color: var(--c-text); font-weight: 500; }
.channel-instructions ol { padding-left: 20px; margin: 8px 0; }
.channel-instructions li + li { margin-top: 6px; }
.channel-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px 16px; }
.channel-field { display: flex; flex-direction: column; gap: 8px; min-width: 0; font-size: 13px; }
.channel-field small { color: var(--c-text-secondary); font-size: 12px; line-height: 1.6; }
.channel-checkbox { display: flex; align-items: center; gap: 8px; font-size: 13px; }
input:not([type="checkbox"]), textarea, select { width: 100%; min-width: 0; border: 1px solid var(--c-border); border-radius: var(--radius-control); padding: 10px; color: var(--c-text); background: var(--c-bg-input); font: inherit; }
textarea { resize: vertical; }
input::placeholder { color: var(--c-text-secondary); opacity: 1; }
.channel-advanced { margin: 28px 0; font-size: 13px; }
.channel-advanced summary { cursor: pointer; padding: 6px 0; }
.channel-advanced .channel-fields { margin-top: 20px; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 8px 12px; border: 1px solid var(--c-border); border-radius: var(--radius-control); color: var(--c-text); background: var(--c-bg-soft); font: inherit; font-size: 13px; cursor: pointer; }
button span { width: 14px; height: 14px; }
button:hover:not(:disabled) { background: var(--c-bg-muted); }
button:disabled, fieldset:disabled { opacity: .6; }
button:disabled { cursor: not-allowed; }
button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.channel-primary { background: var(--c-primary-bg); color: var(--c-text-on-primary); }
.channel-primary:hover:not(:disabled) { background: var(--c-primary-bg-hover); }
.portal-link { padding: 6px 0; min-height: 30px; border: 0; background: transparent; color: var(--c-text); }
@media (max-width: 700px) {
  .channel-fields { grid-template-columns: minmax(0, 1fr); }
  .channel-copy { flex-basis: calc(100% - 40px); }
  .channel-state { flex: 1; }
  button { min-height: 44px; }
  .channel-row { padding: 20px 0; }
}
</style>
