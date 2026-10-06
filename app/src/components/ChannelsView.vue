<template>
  <section class="channels-view" aria-labelledby="channels-title">
    <header class="channels-heading">
      <div><h2 id="channels-title">Bots</h2><p>Connect multiple bots to this project's Home chats. Each connection runs independently.</p></div>
      <button :disabled="loading || !!saving" @click="refresh()">Refresh status</button>
    </header>
    <p v-if="!available" role="status">Channel settings are managed by Main administrators.</p>
    <p v-else-if="loading && !channels.length" role="status">Loading channel connections...</p>
    <div v-if="listError" class="channel-error" role="alert"><p>{{ listError }}</p><button @click="refresh()">Retry</button></div>
    <p v-if="notice" class="channel-notice" role="status">{{ notice }}</p>
    <form v-if="available" class="bot-create" @submit.prevent="addBot">
      <label>Platform<select v-model="newPlatform" :disabled="!!saving"><option v-for="item in channelDefinitions" :key="item.id" :value="item.id">{{ item.label }}</option></select></label>
      <label>Bot name<input v-model="newName" maxlength="100" required :disabled="!!saving" placeholder="Name this connection" /></label>
      <button :disabled="!!saving || !newName.trim()">Add bot</button>
    </form>
    <p v-if="!loading && !listError && !channels.length" class="channel-notice">No bots yet. Add a bot, then configure its credentials to connect it.</p>
    <div class="channel-list">
      <article v-for="channel in channels" :key="channel.id" class="channel-row" :data-channel="channel.id">
        <header class="channel-heading">
          <span class="channel-icon" :class="channel.platform === 'discord' ? 'i-simple-icons-discord' : channel.platform === 'qq' ? 'i-lucide-message-circle' : 'i-lucide-send'" aria-hidden="true" />
          <div class="channel-copy"><h3>{{ channel.displayName }}</h3><p>{{ definition(channel.platform).label }} &middot; {{ definition(channel.platform).description }}</p></div>
          <span class="channel-state" :data-state="channel.state"><span class="channel-dot" aria-hidden="true" />{{ channelStateLabel(botChannel(channel)) }}</span>
          <div class="channel-actions">
            <button v-if="channel.platform === 'discord'" :aria-expanded="accessBot === channel.id" @click="accessBot = accessBot === channel.id ? undefined : channel.id">Discord access</button>
            <button :disabled="!!saving" :aria-expanded="expanded === channel.id" :aria-controls="`channel-${channel.id}-editor`" @click="configure(channel)">{{ channel.configured ? 'Configure' : 'Set up' }}</button>
            <button v-if="channel.enabled" :disabled="!!saving" @click="changeConnection(channel, false)">Disconnect</button>
            <button v-else-if="channel.configured" :disabled="!!saving" @click="changeConnection(channel, true)">Connect</button>
            <button :disabled="!!saving" @click="removeBot(channel)">Remove</button>
          </div>
        </header>
        <p v-if="channel.message" class="channel-message" :class="{ 'channel-error': channel.state === 'error' }">{{ channel.message }}</p>
        <p v-if="errors[channel.id]" class="channel-error" role="alert">{{ errors[channel.id] }}</p>
        <p v-if="saving === channel.id" role="status">Updating {{ channel.displayName }} connection...</p>
        <form v-if="expanded === channel.id" :id="`channel-${channel.id}-editor`" class="channel-editor" @submit.prevent="saveConfiguration(channel, true)">
          <fieldset :disabled="!!saving">
            <legend class="sr-only">{{ channel.displayName }} connection settings</legend>
            <label class="channel-field bot-name">Bot name<input v-model="drafts[channel.id]!.displayName" maxlength="100" required /></label>
            <div class="channel-instructions">
              <strong>Before you connect</strong>
              <ol><li v-for="instruction in definition(channel.platform).instructions" :key="instruction">{{ instruction }}</li></ol>
              <button type="button" class="portal-link" @click="openPortal(channel)">Open {{ definition(channel.platform).label }} developer portal <span class="i-lucide-arrow-up-right" aria-hidden="true" /></button>
            </div>
            <div class="channel-fields">
              <template v-for="field in definition(channel.platform).fields.filter(field => !field.advanced)" :key="field.key">
                <label :class="field.kind === 'checkbox' ? 'channel-checkbox' : 'channel-field'">
                  <template v-if="field.kind === 'checkbox'"><input v-model="drafts[channel.id]![field.key]" type="checkbox" :name="field.key" /><span>{{ field.label }}<small v-if="field.hint" class="checkbox-hint">{{ field.hint }}</small></span></template>
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
                <label v-for="field in definition(channel.platform).fields.filter(field => field.advanced)" :key="field.key" class="channel-field">
                  <span>{{ field.label }}</span>
                  <textarea v-if="field.kind === 'list'" :value="String(drafts[channel.id]![field.key] ?? '')" @input="drafts[channel.id]![field.key] = ($event.target as HTMLTextAreaElement).value" :name="field.key" rows="3" spellcheck="false" />
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
        <DiscordAccess v-if="available && accessBot === channel.id && channel.platform === 'discord'" :api-base="apiBase" :project-id="projectId" :bot="channel" :active="active" />
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { ChannelId } from '../../../src/channels/setup-contract.ts'
import { channelDefinitions, channelStateLabel, type ChannelDraft } from '../channel-settings.ts'
import { botChannel, botDraft, botPatch, createBotSettingsClient, type BotInstanceStatus } from '../bot-settings.ts'
import DiscordAccess from './DiscordAccess.vue'

const props = defineProps<{ apiBase: string; projectId: string; available: boolean; active: boolean }>()
const channels = ref<BotInstanceStatus[]>([])
const drafts = ref<Partial<Record<string, ChannelDraft>>>({})
const errors = ref<Partial<Record<string, string>>>({})
const expanded = ref<string>()
const accessBot = ref<string>()
const newPlatform = ref<ChannelId>('qq')
const newName = ref('')
const loading = ref(false)
const listError = ref('')
const notice = ref('')
const saving = ref<string>()
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
    const result = await createBotSettingsClient(props.apiBase, props.projectId).list(controller.signal)
    if (controller.signal.aborted) return
    channels.value = result
    listError.value = ''
  } catch (error) {
    if (!controller.signal.aborted) listError.value = error instanceof Error ? error.message : 'Could not load channels. Refresh to retry.'
  } finally {
    if (request === controller) { loading.value = false; request = undefined; scheduleRefresh() }
  }
}
function configure(channel: BotInstanceStatus) {
  drafts.value[channel.id] ??= botDraft(channel)
  expanded.value = expanded.value === channel.id ? undefined : channel.id
}
function cancelConfiguration(channel: BotInstanceStatus) {
  drafts.value[channel.id] = botDraft(channel)
  errors.value[channel.id] = ''
  expanded.value = undefined
}
async function update(channel: BotInstanceStatus, patch: { displayName?: string; config?: Record<string, unknown> }, resetDraft = true) {
  if (saving.value || !props.available) return
  stopPolling()
  const controller = new AbortController()
  mutation = controller
  saving.value = channel.id
  errors.value[channel.id] = ''
  notice.value = ''
  try {
    const result = await createBotSettingsClient(props.apiBase, props.projectId).save(channel.id, patch, controller.signal)
    if (controller.signal.aborted) return
    channels.value = channels.value.map(item => item.id === result.id ? result : item)
    if (resetDraft) drafts.value[channel.id] = botDraft(result)
    notice.value = `${channel.displayName} settings saved. ${channelStateLabel(botChannel(result))}.`
  } catch (error) {
    if (!controller.signal.aborted) errors.value[channel.id] = error instanceof Error ? error.message : 'Could not update the channel. Refresh its status before retrying.'
  } finally {
    if (mutation === controller) { mutation = undefined; saving.value = undefined; scheduleRefresh() }
  }
}
async function saveConfiguration(channel: BotInstanceStatus, enabled: boolean) {
  try { await update(channel, botPatch(channel, drafts.value[channel.id]!, enabled)) }
  catch (error) { errors.value[channel.id] = error instanceof Error ? error.message : 'Check the channel settings.' }
}
async function changeConnection(channel: BotInstanceStatus, enabled: boolean) {
  await update(channel, { config: { enabled } }, false)
}
async function openPortal(channel: BotInstanceStatus) {
  try {
    const url = definition(channel.platform).portal
    if (window.shadowDesktop?.openExternal) await window.shadowDesktop.openExternal(url)
    else window.open(url, '_blank', 'noopener,noreferrer')
  } catch { errors.value[channel.id] = `Could not open the browser. Open ${definition(channel.platform).portal} manually.` }
}
async function addBot() {
  if (saving.value || !props.available) return
  stopPolling()
  const controller = new AbortController()
  mutation = controller
  saving.value = 'create'
  listError.value = ''
  try {
    const bot = await createBotSettingsClient(props.apiBase, props.projectId).create(newPlatform.value, newName.value, controller.signal)
    if (controller.signal.aborted) return
    channels.value.push(bot)
    configure(bot)
    newName.value = ''
    notice.value = `${bot.displayName} added. Configure credentials before connecting.`
  } catch (cause) { if (!controller.signal.aborted) listError.value = cause instanceof Error ? cause.message : 'Could not add the bot. Refresh before retrying.' }
  finally { if (mutation === controller) { mutation = undefined; saving.value = undefined; scheduleRefresh() } }
}
async function removeBot(bot: BotInstanceStatus) {
  if (saving.value || !props.available || !confirm(`Disconnect and remove ${bot.displayName}? Existing chats will be retained.`)) return
  stopPolling()
  const controller = new AbortController()
  mutation = controller
  saving.value = bot.id
  errors.value[bot.id] = ''
  try {
    await createBotSettingsClient(props.apiBase, props.projectId).remove(bot.id, controller.signal)
    if (controller.signal.aborted) return
    channels.value = channels.value.filter(item => item.id !== bot.id)
    delete drafts.value[bot.id]
    if (expanded.value === bot.id) expanded.value = undefined
    notice.value = `${bot.displayName} removed.`
  } catch (cause) { if (!controller.signal.aborted) errors.value[bot.id] = cause instanceof Error ? cause.message : 'Could not remove the bot. Refresh before retrying.' }
  finally { if (mutation === controller) { mutation = undefined; saving.value = undefined; scheduleRefresh() } }
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
.bot-create { display: flex; align-items: end; flex-wrap: wrap; gap: 12px; margin-bottom: 24px; }
.bot-create label { display: grid; flex: 1 1 180px; gap: 8px; font-size: 13px; }
.bot-name { max-width: 500px; margin-bottom: 24px; }
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
.checkbox-hint { display: block; margin-top: 6px; color: var(--c-text-secondary); line-height: 1.6; }
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
