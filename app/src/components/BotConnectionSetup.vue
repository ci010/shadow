<template>
  <section class="bot-connection" :aria-label="t('Platform connection')">
    <p v-if="!enabled" role="status">{{ t('Private connection setup requires an authorized Main administrator and HTTPS or loopback access.') }}</p>
    <template v-else>
      <div class="connection-selectors">
        <label>{{ t('Platform') }}<UiSelect v-model="platform" :disabled="busy"><option value="" disabled>{{ t('Choose a platform') }}</option><option v-for="item in channelDefinitions" :key="item.id" :value="item.id">{{ item.label }}</option></UiSelect></label>
        <label v-if="platform">{{ t('Connection in this Project') }}<UiSelect v-model="selection" :disabled="busy || loading || !!listError"><option value="" disabled>{{ t('Choose an existing connection or create one') }}</option><option v-for="bot in matching" :key="bot.id" :value="`connection:${bot.id}`">{{ bot.displayName }} · {{ purposeLabel(bot.purpose) }} · {{ bot.id }}</option><option value="new">{{ t('Create a new connection') }}</option></UiSelect></label>
        <button type="button" :disabled="busy || loading" @click="refresh">{{ t('Refresh status') }}</button>
      </div>
      <p v-if="loading" role="status">{{ t('Loading channel connections...') }}</p>
      <p v-if="listError" class="error" role="alert">{{ listError }}</p>
      <p v-if="platform && !loading && !listError && !matching.length" class="muted">{{ t('No connections for this platform in this Project. Create one to continue.') }}</p>
      <form v-if="selection === 'new'" class="new-connection" @submit.prevent="createConnection">
        <label>{{ t('Role') }}<UiSelect v-model="purpose" :disabled="locked" required><option value="" disabled>{{ t('Select a role') }}</option><option value="personal">{{ t('Personal — verified owner only') }}</option><option v-if="platform !== 'wechat'" value="service">{{ t('Service — explicit BOT permissions') }}</option></UiSelect></label>
        <p class="muted">{{ t('Personal connections require owner pairing. Service connections stay restricted to deployed BOT permissions. Reusing a connection never changes its role or owner.') }}</p>
        <button type="submit" class="btn-primary" :disabled="locked || !purpose">{{ t('Create connection') }}</button>
      </form>
      <article v-if="selected" :key="selected.id" class="selected-connection">
        <header><strong>{{ selected.displayName }}</strong><span class="connection-state" :data-state="selected.state">{{ channelStateLabel(botChannel(selected)) }}</span></header>
        <p class="muted">{{ purposeLabel(selected.purpose) }} · <span class="connection-id">{{ selected.id }}</span></p>
        <p v-if="selected.purpose === 'legacy'" role="status">{{ t('Legacy / unclassified: business requests blocked until explicitly configured.') }}</p>
        <p v-if="selected.message" class="muted">{{ selected.message }}</p>
        <div class="actions">
          <button v-if="selected.enabled" type="button" :disabled="locked" @click="setConnection(false)">{{ t('Disconnect') }}</button>
          <button v-else-if="selected.configured || selected.platform === 'wechat'" type="button" class="btn-primary" :disabled="locked || selected.purpose === 'legacy'" @click="setConnection(true)">{{ t('Connect') }}</button>
          <button v-if="fields.length && selected.configured && !editing" type="button" :disabled="locked" @click="editing = true">{{ t('Update private credentials') }}</button>
        </div>
        <form v-if="fields.length && (!selected.configured || editing)" class="private-fields" @submit.prevent="saveCredentials(true)">
          <fieldset :disabled="locked">
            <legend>{{ t('Private credentials') }}</legend>
            <p class="muted">{{ t('Enter credentials only here, never in chat. Blank fields keep saved values. Other settings are handled in conversation.') }}</p>
            <label v-for="field in fields" :key="field.key">{{ field.label }}
              <input v-model="draft[field.key]" :name="field.key" :type="field.kind === 'password' ? 'password' : 'text'" :autocomplete="field.kind === 'password' ? 'new-password' : 'off'" :spellcheck="false" :placeholder="hasSaved(field.key) ? t('Saved — leave blank to keep') : undefined" />
            </label>
            <div class="actions"><button class="btn-primary" type="submit" :disabled="selected.purpose === 'legacy'">{{ selected.enabled ? t('Save and reconnect') : t('Save and connect') }}</button><button v-if="!selected.enabled" type="button" @click="saveCredentials(false)">{{ t('Save without connecting') }}</button><button type="button" @click="clearCredentials">{{ t('Cancel') }}</button></div>
          </fieldset>
        </form>
        <template v-if="selected.platform === 'wechat' && selected.enabled && !selected.ownerVerified">
          <div class="actions"><button type="button" :disabled="locked" @click="wechat('login')">{{ t('Generate WeChat login QR code') }}</button><button type="button" :disabled="locked" @click="wechat('wait')">{{ t('Check WeChat login') }}</button></div>
          <img v-if="qr" :src="qr" :alt="t('WeChat login QR code')" width="240" referrerpolicy="no-referrer" />
        </template>
        <section v-if="selected.purpose === 'personal'" class="owner-pairing" :aria-label="t('Pair your account')">
          <p v-if="selected.ownerVerified" role="status">{{ selected.state === 'connected' ? t('Ready for your messages') : t('Owner paired. Connect the platform to chat.') }}</p>
          <p v-else-if="selected.state !== 'connected'" class="muted">{{ t('Connect this Bot, then pair your own account here before using private chat.') }}</p>
          <template v-else>
            <p class="muted">{{ t('Generate a temporary command, send it to this Bot in your own private chat, then return here to confirm your account.') }}</p>
            <button v-if="!challenge" type="button" class="btn-primary" :disabled="locked" @click="pairOwner">{{ t('Start owner pairing') }}</button>
            <template v-else>
              <BotPairingCommand :challenge="challenge" />
              <div class="actions"><button type="button" class="btn-primary" :disabled="locked" @click="confirmOwner">{{ t('I sent it — verify my account') }}</button><button type="button" :disabled="locked" @click="pairOwner">{{ t('Generate a new command') }}</button></div>
              <small>{{ t('You will review the platform user ID before binding. Only confirm your own account.') }}</small>
            </template>
          </template>
          <button v-if="selected.ownerVerified && !compact" type="button" :disabled="locked" @click="revokeOwner">{{ t('Revoke owner and disconnect') }}</button>
        </section>
        <p v-if="selected.purpose === 'service'" class="muted">{{ t('Connection does not grant service access. Ask in chat to configure BOT files, audience and permissions, then review the exact deployment confirmation. Owner pairing is only for personal Bots.') }}</p>
        <details v-if="definition?.portal" class="platform-help">
          <summary>{{ t('Platform help') }}</summary>
          <p>{{ t('Platform installation and permissions are not verified by connection status. Ask in chat for the platform steps; never share a token in chat or an invite URL.') }}</p>
          <p v-if="platform === 'discord'">{{ t('In Discord Developer Portal, use the application’s Guild Install link with only the required channel permissions. Do not select Administrator. Guilds, channels, participants and grants belong in BOT files, not this connection form.') }}</p>
          <button type="button" @click="openPortal">{{ t('Open developer portal') }}</button>
        </details>
        <details v-if="!compact && selected.purpose === 'service' && ['qq', 'feishu'].includes(selected.platform)" class="platform-help">
          <summary>{{ t('Pending group authorization') }}</summary>
          <p>{{ t('Discovery is not authorization. Received text is shown here without running an Agent. At most 20 messages per group are kept for 7 days; attachments are not downloaded and old messages are not backfilled.') }}</p>
          <button type="button" :disabled="busy" @click="loadGroups">{{ t('Refresh pending groups') }}</button>
          <p v-if="groups?.length === 0">{{ t('No groups observed yet. Shadow can only show events delivered by the platform. Ordinary delivered group messages can discover a group; no mention or command is required. Platform permissions and sender allowlists still apply.') }}</p>
          <ul><li v-for="group in groups" :key="group.conversationId"><RouterLink :to="{ name: 'chat', params: { projectId }, query: { serviceGroup: JSON.stringify([selected.id, group.conversationId]) } }">{{ group.name || t('Unnamed group') }}</RouterLink></li></ul>
        </details>
        <details v-if="!compact && selected.purpose === 'service' && selected.platform === 'discord'" class="platform-help" @toggle="serviceStatusOpen = ($event.target as HTMLDetailsElement).open">
          <summary>{{ t('Saved service access') }}</summary>
          <BotServiceStatus v-if="serviceStatusOpen" :key="selected.id" :api-base="apiBase" :project-id="projectId" :bot-id="selected.id" />
        </details>
        <button v-if="!compact" type="button" class="remove-connection" :disabled="locked" @click="removeConnection">{{ t('Remove connection') }}</button>
      </article>
      <p v-if="busy" role="status">{{ t('Updating connection...') }}</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <p v-if="needsRefresh" class="muted">{{ t('Refresh status before retrying. A failed response does not prove the change was not applied.') }}</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import UiSelect from './UiSelect.vue'
import BotPairingCommand from './BotPairingCommand.vue'
import BotServiceStatus from './BotServiceStatus.vue'
import { t } from '../i18n.ts'
import { privateCredentialTransport } from '../credential-requests.ts'
import { channelDefinitions, channelStateLabel, type ChannelDraft } from '../channel-settings.ts'
import { botChannel, botConnectionDraft, botConnectionFields, botConnectionPatch, createBotSettingsClient, wechatLoginQr, type BotInstanceStatus } from '../bot-settings.ts'
import type { ChannelId } from '../../../src/channels/setup-contract.ts'

const props = defineProps<{ apiBase: string; projectId: string; active: boolean; available: boolean; compact?: boolean }>()
const enabled = computed(() => props.active && props.available && !!props.projectId && privateCredentialTransport(props.apiBase))
const channels = ref<BotInstanceStatus[]>([])
const platform = ref<ChannelId | ''>('')
const selection = ref('')
const purpose = ref<'' | 'personal' | 'service'>('')
const matching = computed(() => channels.value.filter(bot => bot.platform === platform.value))
const selected = computed(() => matching.value.find(bot => `connection:${bot.id}` === selection.value))
const definition = computed(() => channelDefinitions.find(item => item.id === platform.value))
const fields = computed(() => platform.value ? botConnectionFields(platform.value) : [])
const draft = ref<ChannelDraft>({})
const editing = ref(false), serviceStatusOpen = ref(false)
const loading = ref(false)
const busy = ref(false)
const needsRefresh = ref(false)
const locked = computed(() => busy.value || loading.value || needsRefresh.value || !!listError.value)
const listError = ref(''), error = ref(''), notice = ref('')
const challenge = ref(''), qr = ref('')
const groups = ref<Awaited<ReturnType<ReturnType<typeof createBotSettingsClient>['pendingGroups']>>>()
let read: AbortController | undefined, mutation: AbortController | undefined
let generation = 0
const purposeLabel = (value: BotInstanceStatus['purpose']) => value === 'personal' ? t('Personal — verified owner only') : value === 'service' ? t('Service — explicit BOT permissions') : t('Legacy / unclassified')
function hasSaved(key: string) { return selected.value?.secrets[key] === true || !!selected.value?.config[key] }
function clearCredentials() { draft.value = platform.value ? botConnectionDraft(platform.value) : {}; editing.value = false }
function resetSelection() { clearCredentials(); challenge.value = ''; qr.value = ''; groups.value = undefined; serviceStatusOpen.value = false; error.value = ''; notice.value = '' }
watch(platform, () => { selection.value = ''; purpose.value = ''; resetSelection() }, { flush: 'sync' })
watch(selection, () => { purpose.value = ''; resetSelection() }, { flush: 'sync' })
function stop() {
  generation++; read?.abort(); mutation?.abort(); read = mutation = undefined
  channels.value = []; platform.value = ''; selection.value = ''; purpose.value = ''; resetSelection()
  loading.value = busy.value = needsRefresh.value = false; listError.value = ''
}
async function refresh() {
  if (!enabled.value || busy.value) return
  read?.abort(); const controller = new AbortController(); read = controller; loading.value = true
  try {
    const result = await createBotSettingsClient(props.apiBase, props.projectId).list(controller.signal)
    if (controller.signal.aborted) return
    const uncertainCreation = needsRefresh.value && selection.value === 'new'
    channels.value = result; listError.value = ''; needsRefresh.value = false; error.value = ''
    // A lost create response may already have created a connection. Require a
    // fresh choice from the authoritative list, never replay creation blindly.
    if (uncertainCreation || (selection.value && selection.value !== 'new' && !selected.value)) selection.value = ''
  } catch { if (!controller.signal.aborted) listError.value = t('Could not load connections. Check your Project access and refresh status.') }
  finally { if (read === controller) { read = undefined; loading.value = false } }
}
type Client = ReturnType<typeof createBotSettingsClient>
async function run(action: (client: Client, signal: AbortSignal, current: () => boolean) => Promise<void>) {
  if (!enabled.value || locked.value) return
  read?.abort(); read = undefined
  const version = generation, controller = new AbortController(); mutation = controller; busy.value = true; error.value = ''; notice.value = ''
  const current = () => version === generation && !controller.signal.aborted
  try { await action(createBotSettingsClient(props.apiBase, props.projectId), controller.signal, current) }
  catch { if (current()) { error.value = t('Could not confirm the connection action. Private values have been cleared. Refresh status before retrying.'); needsRefresh.value = true } }
  finally { if (mutation === controller) { clearCredentials(); mutation = undefined; busy.value = false } }
}
function accept(bot: BotInstanceStatus) { channels.value = channels.value.map(item => item.id === bot.id ? bot : item); notice.value = t('Connection status updated. This does not approve a BOT deployment.') }
async function createConnection() {
  if (!platform.value || !purpose.value || (platform.value === 'wechat' && purpose.value !== 'personal')) return
  const id = platform.value, role = purpose.value, name = definition.value!.label
  await run(async (client, signal, current) => {
    const bot = await client.create(id, name, signal, role)
    if (current()) { channels.value.push(bot); selection.value = `connection:${bot.id}` }
  })
}
async function setConnection(value: boolean) {
  const bot = selected.value; if (!bot) return
  await run(async (client, signal, current) => { const result = await client.save(bot.id, { config: { enabled: value } }, signal); if (current()) accept(result) })
}
async function saveCredentials(value: boolean) {
  const bot = selected.value; if (!bot) return
  let patch: ReturnType<typeof botConnectionPatch>
  try { patch = botConnectionPatch(bot, draft.value, value) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : t('Check the channel settings.'); return }
  await run(async (client, signal, current) => { const result = await client.save(bot.id, patch, signal); if (current()) accept(result) })
}
async function pairOwner() {
  const bot = selected.value; if (!bot || bot.purpose !== 'personal') return
  await run(async (client, signal, current) => { const result = await client.challenge(bot.id, signal); if (current()) challenge.value = result.challenge })
}
async function confirmOwner() {
  const bot = selected.value, command = challenge.value; if (!bot || !command || bot.purpose !== 'personal') return
  await run(async (client, signal, current) => {
    const { candidate } = await client.candidate(bot.id, signal)
    if (!current()) return
    if (!candidate) { error.value = t('No private-chat candidate yet, or challenge expired.'); return }
    if (!window.confirm(t('Bind platform user {candidate} as the sole owner? Verify this is your own platform account.', { candidate }))) return
    await client.confirm(bot.id, command, signal)
    if (current()) { challenge.value = ''; const result = await client.list(signal); if (current()) channels.value = result }
  })
}
async function revokeOwner() {
  const bot = selected.value; if (!bot || !window.confirm(t('Revoke owner and disconnect? Existing conversations are retained.'))) return
  await run(async (client, signal, current) => { await client.revoke(bot.id, signal); const result = await client.list(signal); if (current()) { channels.value = result; challenge.value = '' } })
}
async function wechat(operation: 'login' | 'wait') {
  const bot = selected.value; if (!bot) return
  await run(async (client, signal, current) => {
    const result = await client.wechat(bot.id, operation, signal)
    if (!current()) return
    if (operation === 'login') qr.value = wechatLoginQr(result)
    if (result.connected === true) { qr.value = ''; const list = await client.list(signal); if (current()) channels.value = list }
  })
}
async function loadGroups() {
  const bot = selected.value; if (!bot) return
  await run(async (client, signal, current) => { const result = await client.pendingGroups(bot.id, signal); if (current()) groups.value = result })
}
async function removeConnection() {
  const bot = selected.value; if (!bot || !window.confirm(t('Disconnect and remove {displayName}? Existing chats will be retained.', { displayName: bot.displayName }))) return
  await run(async (client, signal, current) => { await client.remove(bot.id, signal); if (current()) { channels.value = channels.value.filter(item => item.id !== bot.id); selection.value = '' } })
}
async function openPortal() {
  const url = definition.value?.portal; if (!url) return
  try { if (window.shadowDesktop?.openExternal) await window.shadowDesktop.openExternal(url); else window.open(url, '_blank', 'noopener,noreferrer') }
  catch { error.value = t('Could not open the browser. Open {portal} manually.', { portal: url }) }
}
watch([() => props.apiBase, () => props.projectId, enabled], () => { stop(); if (enabled.value) void refresh() }, { immediate: true, flush: 'sync' })
onBeforeUnmount(stop)
</script>

<style scoped>
.bot-connection { min-width: 0; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.connection-selectors { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; }
.connection-selectors label { flex: 1 1 180px; }
label { display: grid; gap: 6px; min-width: 0; }
.new-connection, .selected-connection { margin-top: 16px; }
.new-connection label { max-width: 400px; }
.selected-connection { border-top: 1px solid var(--c-border); padding-top: 12px; }
header, .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
header { justify-content: space-between; }
p { margin: 8px 0; }
.muted, small, .connection-state { color: var(--c-text-secondary); }
.connection-id { font-family: monospace; }
.connection-state[data-state="connected"] { color: var(--c-success); }
.connection-state[data-state="error"], .error { color: var(--c-error); }
.connection-state[data-state="restart-required"] { color: var(--c-warn); }
fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
legend { font-weight: 600; padding: 0; }
.private-fields { margin-top: 16px; }
.private-fields label { margin-block: 12px; }
input { width: 100%; min-width: 0; box-sizing: border-box; padding: 8px 10px; border: 1px solid var(--c-control-border); border-radius: var(--radius-control); color: var(--c-text); background: var(--c-bg-input); font: inherit; }
input::placeholder { color: var(--c-text-secondary); opacity: 1; }
button { min-height: 36px; padding: 7px 12px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); font: inherit; cursor: pointer; }
button:hover:not(:disabled) { background: var(--c-bg-muted); }
button.btn-primary { background: var(--c-primary-bg); color: var(--c-text-on-primary); }
button.btn-primary:hover:not(:disabled) { background: var(--c-primary-bg-hover); }
button:disabled { opacity: .6; cursor: not-allowed; }
button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.owner-pairing, .platform-help { margin-top: 12px; }
summary { cursor: pointer; padding-block: 8px; }
.platform-help { color: var(--c-text-secondary); }
.platform-help summary { color: var(--c-text); }
.remove-connection { margin-top: 16px; }
img { max-width: 100%; height: auto; }
@media (max-width: 700px), (pointer: coarse) { button, input, summary { min-height: 44px; box-sizing: border-box; } input { font-size: 16px; } }
</style>
