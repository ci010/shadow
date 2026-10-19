<template>
  <section class="channels-view" aria-labelledby="channels-title">
    <header class="channels-heading">
      <div><h2 id="channels-title">{{ t('Bots') }}</h2><p>{{ t('Connect multiple bots to this project\'s Home chats. Each connection runs independently.') }}</p></div>
      <button :disabled="loading || !!saving" @click="refresh()">{{ t('Refresh status') }}</button>
    </header>
    <p v-if="!available" role="status">{{ t('Channel settings are managed by Main administrators.') }}</p>
    <p v-else-if="loading && !channels.length" role="status">{{ t('Loading channel connections...') }}</p>
    <div v-if="listError" class="channel-error" role="alert"><p>{{ listError }}</p><button @click="refresh()">{{ t('Retry') }}</button></div>
    <p v-if="notice" class="channel-notice" role="status">{{ notice }}</p>
    <p v-if="reviewLinkError" class="channel-error" role="alert">{{ reviewLinkError }}</p>
    <form v-if="available" class="bot-create" @submit.prevent="addBot">
      <label>{{ t('Role') }}<UiSelect v-model="newPurpose" required :disabled="!!saving"><option value="" disabled>{{ t('Select a role') }}</option><option value="personal">{{ t('Personal assistant — owner-only Project entry') }}</option><option value="service">{{ t('Service Bot — explicitly restricted Agent') }}</option></UiSelect></label>
      <label>{{ t('Platform') }}<UiSelect v-model="newPlatform" :disabled="!!saving"><option v-for="item in channelDefinitions" :key="item.id" :value="item.id" :disabled="item.id === 'wechat' && newPurpose !== 'personal'">{{ item.id === 'wechat' ? t('WeChat (personal Bots only)') : item.label }}</option></UiSelect></label>
      <label>{{ t('Bot name') }}<input v-model="newName" maxlength="100" required :disabled="!!saving" :placeholder="t('Name this connection')" /></label>
      <button :disabled="!!saving || !newName.trim() || !newPurpose">{{ t('Add bot') }}</button>
    </form>
    <p>{{ t('WeChat supports personal Bots only.') }}</p>
    <p v-if="!loading && !listError && !channels.length" class="channel-notice">{{ t('No bots yet. Add a bot, then configure its credentials to connect it.') }}</p>
    <div class="channel-list">
      <article v-for="channel in channels" :key="channel.id" class="channel-row" :data-channel="channel.id">
        <header class="channel-heading">
          <span class="channel-icon" :class="channel.platform === 'discord' ? 'i-simple-icons-discord' : channel.platform === 'qq' ? 'i-lucide-message-circle' : 'i-lucide-send'" aria-hidden="true" />
          <div class="channel-copy"><h3>{{ channel.displayName }}</h3><p>{{ definition(channel.platform).label }} &middot; {{ definition(channel.platform).description }}</p></div>
          <span class="channel-state" :data-state="channel.state"><span class="channel-dot" aria-hidden="true" />{{ channelStateLabel(botChannel(channel)) }}</span>
          <div class="channel-actions">
            <button v-if="channel.platform === 'discord' && channel.purpose === 'service'" :aria-expanded="accessBot === channel.id" @click="accessBot = accessBot === channel.id ? undefined : channel.id">{{ t('Discord access') }}</button>
            <button :disabled="!!saving" :aria-expanded="expanded === channel.id" :aria-controls="`channel-${channel.id}-editor`" @click="configure(channel)">{{ channel.configured ? t('Configure') : t('Set up') }}</button>
            <button v-if="channel.enabled" :disabled="!!saving" @click="changeConnection(channel, false)">{{ t('Disconnect') }}</button>
            <button v-else-if="channel.configured" :disabled="!!saving" @click="changeConnection(channel, true)">{{ t('Connect') }}</button>
            <button :disabled="!!saving" @click="removeBot(channel)">{{ t('Remove') }}</button>
          </div>
        </header>
        <p>{{ channel.purpose === 'personal' ? t('Personal assistant: verified owner direct messages only. Project skills and approved permissions apply; management remains Web-only where required.') : channel.purpose === 'service' ? t('Service Bot: explicit published Agent, skills, tools and resources required. Owner DMs do not become personal sessions.') : t('Legacy / unclassified: business requests blocked until explicitly configured.') }}</p>
        <div v-if="!channel.enabled">
          <small>{{ t('Role changes require disconnecting and no existing conversation history. Create a new Bot for an existing connection with history.') }}</small>
          <button v-if="channel.purpose !== 'personal'" @click="changePurpose(channel, 'personal')">{{ t('Configure as personal assistant') }}</button>
          <button v-if="channel.purpose !== 'service' && channel.platform !== 'wechat'" @click="changePurpose(channel, 'service')">{{ t('Configure as service Bot') }}</button>
        </div>
        <section v-if="channel.purpose === 'personal'" class="owner-setup" :class="{ 'owner-setup--ready': channel.ownerVerified }" :aria-label="t('Personal Bot setup')">
          <header class="owner-setup-heading">
            <div><span class="setup-eyebrow">{{ t('Personal Bot setup') }}</span><h4>{{ channel.ownerVerified ? t('Owner paired') : t('One more step: pair your account') }}</h4></div>
            <span class="setup-badge">{{ channel.ownerVerified ? t('Owner paired') : t('Pairing required') }}</span>
          </header>
          <p class="setup-summary">{{ channel.ownerVerified ? t('Only your verified account can chat with this personal Bot. Connect the platform before sending messages.') : t('A platform connection alone cannot receive assistant requests. Pair your own account below to unlock private chat.') }}</p>
          <ol class="setup-steps">
            <li :class="{ 'step-done': channel.state === 'connected', 'step-current': channel.state !== 'connected' }"><span class="step-number">1</span><div><strong>{{ t('Connect platform') }}</strong><small>{{ channelStateLabel(botChannel(channel)) }}</small></div></li>
            <li :class="{ 'step-done': channel.ownerVerified, 'step-current': channel.state === 'connected' && !channel.ownerVerified }"><span class="step-number">2</span><div><strong>{{ t('Pair your account') }}</strong><small>{{ channel.ownerVerified ? t('Verified owner bound') : t('Required before chatting') }}</small></div></li>
            <li :class="{ 'step-current': channel.ownerVerified && channel.state === 'connected' }"><span class="step-number">3</span><div><strong>{{ t('Start a private chat') }}</strong><small>{{ channel.ownerVerified && channel.state === 'connected' ? t('Ready for your messages') : t('Available after connection and pairing') }}</small></div></li>
          </ol>
          <div v-if="!channel.ownerVerified" class="setup-next">
            <template v-if="channel.state !== 'connected'">
              <strong>{{ t('First, connect this Bot') }}</strong>
              <p>{{ t('Open configuration to save credentials and connect. Then return here to pair your account.') }}</p>
              <button class="channel-primary" :disabled="!!saving" @click="configure(channel)">{{ t('Configure') }}</button>
            </template>
            <template v-else>
              <strong>{{ t('Next: verify that this account is yours') }}</strong>
              <p v-if="!pairings[channel.id]">{{ t('Generate a temporary command, send it to this Bot in your own private chat, then return here to confirm your account.') }}</p>
              <button v-if="!pairings[channel.id]" class="channel-primary" :disabled="!!saving" @click="pairOwner(channel)">{{ t('Start owner pairing') }}</button>
              <template v-else>
                <p>{{ t('Copy the command below and send it in your own private chat with this Bot within five minutes. No reply in the platform is expected; return here after sending.') }}</p>
                <BotPairingCommand :challenge="pairings[channel.id]!" />
                <div class="setup-confirm-actions"><button class="channel-primary" :disabled="!!saving" @click="confirmOwner(channel)">{{ t('I sent it — verify my account') }}</button><button :disabled="!!saving" @click="pairOwner(channel)">{{ t('Generate a new command') }}</button></div>
                <small>{{ t('You will review the platform user ID before binding. Only confirm your own account.') }}</small>
              </template>
            </template>
          </div>
          <button v-else :disabled="!!saving" @click="revokeOwner(channel)">{{ t('Revoke owner and disconnect') }}</button>
        </section>
        <section v-if="channel.platform === 'discord' && channel.purpose === 'service'" class="owner-setup service-setup" :aria-label="t('Service Bot setup')">
          <header class="owner-setup-heading">
            <div><span class="setup-eyebrow">{{ t('Service Bot setup') }}</span><h4>{{ t('Connect, invite, assign, then review') }}</h4></div>
            <span class="setup-badge">{{ t('Explicit access required') }}</span>
          </header>
          <p class="setup-summary">{{ t('Connected means signed in to Discord, not installed in a server or ready to serve. Invite this Bot first, then assign an Agent and approve access. Owner pairing is only for personal Bots.') }}</p>
          <ol class="setup-steps">
            <li :class="{ 'step-done': channel.state === 'connected', 'step-current': channel.state !== 'connected' }"><span class="step-number">1</span><div><strong>{{ t('Connect platform') }}</strong><small>{{ channelStateLabel(botChannel(channel)) }}</small></div></li>
            <li :class="{ 'step-current': accessBot !== channel.id && channel.state === 'connected' }"><span class="step-number">2</span><div><strong>{{ t('Invite to a Discord server') }}</strong><small>{{ t('Server installation is not verified here') }}</small></div></li>
            <li :class="{ 'step-current': accessBot === channel.id && accessPage === 'channels' }"><span class="step-number">3</span><div><button type="button" @click="openAccess(channel.id)">{{ t('Publish and assign an Agent') }}</button><small>{{ t('Choose tools, resources and participants') }}</small></div></li>
            <li :class="{ 'step-current': accessBot === channel.id && accessPage === 'reviews' }"><span class="step-number">4</span><div><button type="button" @click="openAccess(channel.id, 'reviews')">{{ t('Review and approve access') }}</button><small>{{ t('Open Discord access to load current assignments') }}</small></div></li>
          </ol>
          <div class="setup-next setup-install">
            <button class="channel-primary" @click="openAccess(channel.id)">{{ t('I have invited the Bot — continue to assignments') }}</button>
            <small>{{ t('Opening configuration does not verify installation or grant access.') }}</small>
            <strong>{{ t('Invite this Bot from the Developer Portal') }}</strong>
            <p>{{ t('An application ID verified for this Bot is not available in this view, so Shadow cannot safely generate an invite link. Never paste a Bot token into an invite URL.') }}</p>
            <ol>
              <li>{{ t('Open the application that owns this Bot in the Discord Developer Portal. Under Installation, enable Guild Install if needed and copy its Install Link. If no link is provided, use OAuth2 URL Generator with the bot scope and Guild Install.') }}</li>
              <li>{{ t('Open that link, choose your server, and authorize with a server account allowed to manage the server. Request only the channel permissions this Bot needs, such as View Channels and Send Messages; do not select Administrator.') }}</li>
              <li>{{ t('Return to Discord access, sync the directory and choose the server and channels. If the server is missing, check installation, the selected application and Discord permissions. Installation alone does not enable Agent access.') }}</li>
            </ol>
            <a class="portal-link" href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer" @click.prevent="openPortal(channel)">{{ t('Open Discord Developer Portal') }} ↗</a>
            <a class="portal-link" href="https://discord.com/developers/docs/resources/application#installation-context" target="_blank" rel="noopener noreferrer" @click.prevent="openExternal(channel, 'https://discord.com/developers/docs/resources/application#installation-context')">{{ t('Discord installation documentation') }} ↗</a>
          </div>
          <div class="setup-next">
            <template v-if="channel.state !== 'connected'">
              <strong>{{ t('First, connect this Bot') }}</strong>
              <p v-if="channel.secrets.token">{{ t('A Bot token is saved, but this Bot is not connected. Check the connection error below. Leave the token blank to keep it, or enter a replacement in Configure. Saved access settings remain available separately.') }}</p>
              <p v-else>{{ t('Save a Bot token and connect before discovering Discord channels and people. Saved access settings remain available separately.') }}</p>
              <button class="channel-primary" :disabled="!!saving" @click="configure(channel)">{{ t('Configure') }}</button>
            </template>
            <template v-else>
              <strong>{{ t('After inviting: configure service access') }}</strong>
              <p>{{ t('Use Discord access to sync servers, publish Agents, assign channels or DMs, and review permissions. Connection status does not verify assignments or server installation.') }}</p>
              <button class="channel-primary" :aria-expanded="accessBot === channel.id" @click="accessBot = accessBot === channel.id ? undefined : channel.id">{{ t('Discord access') }}</button>
            </template>
          </div>
        </section>
        <div v-if="channel.platform === 'wechat' && channel.enabled && !channel.ownerVerified">
          <button :disabled="!!saving" @click="wechatLogin(channel, 'login')">{{ t('Generate WeChat login QR code') }}</button>
          <button :disabled="!!saving" @click="wechatLogin(channel, 'wait')">{{ t('Check WeChat login') }}</button>
          <img v-if="wechatQr[channel.id]" :src="wechatQr[channel.id]" :alt="t('WeChat login QR code')" width="240" referrerpolicy="no-referrer" />
        </div>
        <p v-if="channel.message" class="channel-message" :class="{ 'channel-error': channel.state === 'error' }">{{ channel.message }}</p>
        <p v-if="errors[channel.id]" class="channel-error" role="alert">{{ errors[channel.id] }}</p>
        <p v-if="saving === channel.id" role="status">{{ t('Updating') }} {{ channel.displayName }} {{ t('connection...') }}</p>
        <form v-if="expanded === channel.id" :id="`channel-${channel.id}-editor`" class="channel-editor" @submit.prevent="saveConfiguration(channel, true)">
          <fieldset :disabled="!!saving">
            <legend class="sr-only">{{ channel.displayName }} {{ t('connection settings') }}</legend>
            <label class="channel-field bot-name">{{ t('Bot name') }}<input v-model="drafts[channel.id]!.displayName" maxlength="100" required /></label>
            <details class="channel-instructions" :open="!channel.configured">
              <summary>{{ t('Before you connect') }}</summary>
              <ol><li v-for="instruction in setupInstructions(channel)" :key="instruction">{{ instruction }}</li></ol>
              <button v-if="definition(channel.platform).portal" type="button" class="portal-link" @click="openPortal(channel)">{{ t('Open') }} {{ definition(channel.platform).label }} {{ t('developer portal') }} <span class="i-lucide-arrow-up-right" aria-hidden="true" /></button>
            </details>
            <div class="channel-fields">
              <template v-for="field in definition(channel.platform).fields.filter(field => !field.advanced)" :key="field.key">
                <label :class="field.kind === 'checkbox' ? 'channel-checkbox' : 'channel-field'">
                  <template v-if="field.kind === 'checkbox'"><input v-model="drafts[channel.id]![field.key]" type="checkbox" :name="field.key" /><span>{{ field.label }}<small v-if="field.hint" class="checkbox-hint">{{ field.hint }}</small></span></template>
                  <template v-else>
                    <span>{{ field.label }}<span v-if="field.required"> *</span></span>
                    <UiSelect v-if="field.kind === 'select'" v-model="drafts[channel.id]![field.key]" :name="field.key"><option v-for="option in field.options" :key="option" :value="option">{{ option === 'mention' ? t('Mentions and direct messages') : option === 'all' ? t('All messages') : option }}</option></UiSelect>
                    <input v-else v-model="drafts[channel.id]![field.key]" :type="field.kind" :name="field.key" :autocomplete="field.kind === 'password' ? 'new-password' : 'off'" :spellcheck="false"
                      :placeholder="field.kind === 'password' && channel.secrets[field.key] ? t('Saved — leave blank to keep') : undefined" />
                    <small v-if="field.hint">{{ field.hint }}</small>
                    <small v-if="field.kind === 'password'">{{ channel.secrets[field.key] ? t('A credential is saved. Enter a value only to replace it.') : t('Credentials are saved on Main and never returned to this form.') }}</small>
                  </template>
                </label>
              </template>
            </div>
            <details class="channel-advanced">
              <summary>{{ t('Advanced settings and access') }}</summary>
              <div class="channel-fields">
                <label v-for="field in definition(channel.platform).fields.filter(field => field.advanced)" :key="field.key" class="channel-field">
                  <span>{{ field.label }}</span>
                  <textarea v-if="field.kind === 'list'" :value="String(drafts[channel.id]![field.key] ?? '')" @input="drafts[channel.id]![field.key] = ($event.target as HTMLTextAreaElement).value" :name="field.key" rows="3" spellcheck="false" />
                  <UiSelect v-else-if="field.kind === 'select'" v-model="drafts[channel.id]![field.key]" :name="field.key"><option v-for="option in field.options" :key="option" :value="option">{{ option === 'mention' ? t('Mentions and direct messages') : option === 'all' ? t('All messages') : option }}</option></UiSelect>
                  <input v-else v-model="drafts[channel.id]![field.key]" :type="field.kind" :name="field.key"
                    :autocomplete="field.kind === 'password' ? 'new-password' : 'off'" :spellcheck="false"
                    :placeholder="field.kind === 'password' && channel.secrets[field.key] ? t('Saved — leave blank to keep') : undefined" />
                  <small v-if="field.hint">{{ field.hint }}</small>
                </label>
              </div>
            </details>
            <div class="channel-form-actions">
              <button class="channel-primary" type="submit">{{ channel.enabled ? t('Save and reconnect') : t('Save and connect') }}</button>
              <button v-if="!channel.enabled" type="button" @click="saveConfiguration(channel, false)">{{ t('Save without connecting') }}</button>
              <button type="button" @click="cancelConfiguration(channel)">{{ t('Cancel') }}</button>
            </div>
          </fieldset>
        </form>
        <DiscordAccess v-if="available && accessBot === channel.id && channel.platform === 'discord' && channel.purpose === 'service'" :requested-page="accessPage" :navigation-key="accessNavigation" :api-base="apiBase" :project-id="projectId" :bot="channel" :active="active"
          :requested-review-id="requestedReviewId" />
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import UiSelect from './UiSelect.vue'
import BotPairingCommand from './BotPairingCommand.vue'
import { t } from '../i18n.ts'
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { ChannelId } from '../../../src/channels/setup-contract.ts'
import { channelDefinitions, channelStateLabel, type ChannelDraft } from '../channel-settings.ts'
import { botChannel, botDraft, botPatch, createBotSettingsClient, wechatLoginQr, type BotInstanceStatus } from '../bot-settings.ts'
import DiscordAccess from './DiscordAccess.vue'

const props = defineProps<{ apiBase: string; projectId: string; available: boolean; active: boolean; reviewBotId?: string; requestedReviewId?: string }>()
const channels = ref<BotInstanceStatus[]>([])
const drafts = ref<Partial<Record<string, ChannelDraft>>>({})
const errors = ref<Partial<Record<string, string>>>({})
const expanded = ref<string>()
const accessBot = ref<string>()
const accessPage = ref<'channels' | 'reviews'>('channels')
const accessNavigation = ref(0)
async function openAccess(botId: string, page: 'channels' | 'reviews' = 'channels') {
  accessNavigation.value++; accessPage.value = page; accessBot.value = botId
  await nextTick()
  const heading = document.getElementById(`discord-access-${botId}-title`)
  heading?.scrollIntoView({ block: 'start' }); heading?.focus({ preventScroll: true })
}
const reviewLinkError = ref('')
const newPlatform = ref<ChannelId>('qq')
const newName = ref('')
const newPurpose = ref<'' | 'personal' | 'service'>('')
const wechatQr = ref<Record<string, string>>({})
watch(newPurpose, purpose => { if (purpose !== 'personal' && newPlatform.value === 'wechat') newPlatform.value = 'qq' })
async function wechatLogin(bot: BotInstanceStatus, operation: 'login' | 'wait') {
  if (saving.value || !props.available) return
  stopPolling()
  const controller = new AbortController()
  mutation = controller
  saving.value = bot.id
  try {
    const result = await createBotSettingsClient(props.apiBase, props.projectId).wechat(bot.id, operation, controller.signal)
    if (controller.signal.aborted) return
    if (operation === 'login') wechatQr.value[bot.id] = wechatLoginQr(result)
    if (result.connected === true) delete wechatQr.value[bot.id]
    notice.value = typeof result.message === 'string' ? result.message : t('Scan the QR code with your own WeChat account and confirm, then check login.')
    errors.value[bot.id] = ''
  } catch { if (!controller.signal.aborted) errors.value[bot.id] = t('WeChat login failed. Connect an unbound personal Bot and retry.') }
  finally { if (mutation === controller) { mutation = undefined; saving.value = undefined; await refresh() } }
}
const pairings = ref<Record<string, string>>({})
async function changePurpose(bot: BotInstanceStatus, purpose: 'personal' | 'service') { await update(bot, { purpose }) }
async function pairOwner(bot: BotInstanceStatus) {
  errors.value[bot.id] = ''
  try { pairings.value[bot.id] = (await createBotSettingsClient(props.apiBase, props.projectId).challenge(bot.id)).challenge } catch { errors.value[bot.id] = t('Could not generate owner challenge. Connect the unbound personal Bot first.') }
}
async function confirmOwner(bot: BotInstanceStatus) {
  const client = createBotSettingsClient(props.apiBase, props.projectId)
  try {
    const { candidate } = await client.candidate(bot.id)
    if (!candidate) { errors.value[bot.id] = t('No private-chat candidate yet, or challenge expired.'); return }
    if (!window.confirm(t('Bind platform user {candidate} as the sole owner? Verify this is your own platform account.', { candidate }))) return
    await client.confirm(bot.id, pairings.value[bot.id]!)
    delete pairings.value[bot.id]
    errors.value[bot.id] = ''
    await refresh()
  } catch { errors.value[bot.id] = t('Owner confirmation failed; generate a new challenge.') }
}
async function revokeOwner(bot: BotInstanceStatus) {
  try { await createBotSettingsClient(props.apiBase, props.projectId).revoke(bot.id); await refresh() } catch { errors.value[bot.id] = t('Revocation not applied. Wait for active or queued work (including child agents) to finish or cancel it in Web, then retry.') }
}
const loading = ref(false)
const listError = ref('')
const notice = ref('')
const saving = ref<string>()
const definition = (id: ChannelId) => channelDefinitions.find(item => item.id === id)!
function setupInstructions(channel: BotInstanceStatus): string[] {
  const instructions = definition(channel.platform).instructions
  return channel.platform === 'discord' && channel.purpose === 'personal'
    ? [...instructions.slice(0, 2), t('Open configuration to save credentials and connect. Then return here to pair your account.')]
    : instructions
}
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
    if (!controller.signal.aborted) listError.value = error instanceof Error ? error.message : t('Could not load channels. Refresh to retry.')
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
async function update(channel: BotInstanceStatus, patch: { purpose?: 'personal' | 'service'; displayName?: string; config?: Record<string, unknown> }, resetDraft = true) {
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
    notice.value = t('{displayName} settings saved. {value2}.', { displayName: channel.displayName, value2: channelStateLabel(botChannel(result)) })
  } catch (error) {
    if (!controller.signal.aborted) errors.value[channel.id] = error instanceof Error ? error.message : t('Could not update the channel. Refresh its status before retrying.')
  } finally {
    if (mutation === controller) { mutation = undefined; saving.value = undefined; scheduleRefresh() }
  }
}
async function saveConfiguration(channel: BotInstanceStatus, enabled: boolean) {
  try { await update(channel, botPatch(channel, drafts.value[channel.id]!, enabled)) }
  catch (error) { errors.value[channel.id] = error instanceof Error ? error.message : t('Check the channel settings.') }
}
async function changeConnection(channel: BotInstanceStatus, enabled: boolean) {
  await update(channel, { config: { enabled } }, false)
}
async function openPortal(channel: BotInstanceStatus) {
  await openExternal(channel, definition(channel.platform).portal)
}
async function openExternal(channel: BotInstanceStatus, url: string) {
  try {
    if (window.shadowDesktop?.openExternal) await window.shadowDesktop.openExternal(url)
    else window.open(url, '_blank', 'noopener,noreferrer')
  } catch { errors.value[channel.id] = t('Could not open the browser. Open {portal} manually.', { portal: url }) }
}
async function addBot() {
  if (!newPurpose.value) return
  if (saving.value || !props.available) return
  stopPolling()
  const controller = new AbortController()
  mutation = controller
  saving.value = 'create'
  listError.value = ''
  try {
    const bot = await createBotSettingsClient(props.apiBase, props.projectId).create(newPlatform.value, newName.value, controller.signal, newPurpose.value)
    if (controller.signal.aborted) return
    channels.value.push(bot)
    configure(bot)
    newName.value = ''
    notice.value = t('{displayName} added. Configure credentials before connecting.', { displayName: bot.displayName })
  } catch (cause) { if (!controller.signal.aborted) listError.value = cause instanceof Error ? cause.message : t('Could not add the bot. Refresh before retrying.') }
  finally { if (mutation === controller) { mutation = undefined; saving.value = undefined; scheduleRefresh() } }
}
async function removeBot(bot: BotInstanceStatus) {
  if (saving.value || !props.available || !confirm(t('Disconnect and remove {displayName}? Existing chats will be retained.', { displayName: bot.displayName }))) return
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
    notice.value = t('{displayName} removed.', { displayName: bot.displayName })
  } catch (cause) { if (!controller.signal.aborted) errors.value[bot.id] = cause instanceof Error ? cause.message : t('Could not remove the bot. Refresh before retrying.') }
  finally { if (mutation === controller) { mutation = undefined; saving.value = undefined; scheduleRefresh() } }
}
watch([() => props.apiBase, () => props.projectId, () => props.available], () => {
  stopPolling()
  mutation?.abort()
  mutation = undefined
  saving.value = undefined
  wechatQr.value = {}
  channels.value = []
  drafts.value = {}
  errors.value = {}
  expanded.value = undefined
  accessBot.value = undefined
  reviewLinkError.value = ''
  notice.value = ''
  listError.value = ''
  void refresh()
})
watch([() => props.requestedReviewId, () => props.reviewBotId, () => props.active,
  () => channels.value.map(bot => `${bot.id}:${bot.platform}`).join('|'), loading], () => {
  if (!props.active || !props.requestedReviewId || loading.value || listError.value) return
  const bot = channels.value.find(bot => bot.platform === 'discord' && (!props.reviewBotId || bot.id === props.reviewBotId))
  reviewLinkError.value = bot ? '' : t('The linked Discord Bot is unavailable in this Project. Refresh the Bot list or ask for a new review link.')
  accessBot.value = bot?.id
}, { immediate: true })
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
.channel-instructions summary { cursor: pointer; color: var(--c-text); font-weight: 500; }
.channel-instructions ol { padding-left: 20px; margin: 8px 0; }
.channel-instructions li + li { margin-top: 6px; }
.channel-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px 16px; }
.channel-field { display: flex; flex-direction: column; gap: 8px; min-width: 0; font-size: 13px; }
.channel-field small { color: var(--c-text-secondary); font-size: 12px; line-height: 1.6; }
.channel-checkbox { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.checkbox-hint { display: block; margin-top: 6px; color: var(--c-text-secondary); line-height: 1.6; }
input:not([type="checkbox"]), textarea, .ui-select { width: 100%; min-width: 0; border: 1px solid var(--c-border); border-radius: var(--radius-control); padding: 10px; color: var(--c-text); background: var(--c-bg-input); font: inherit; }
textarea { resize: vertical; }
input::placeholder { color: var(--c-text-secondary); opacity: 1; }
.channel-advanced { margin: 28px 0; font-size: 13px; }
.channel-advanced summary { cursor: pointer; padding: 6px 0; }
.channel-advanced .channel-fields { margin-top: 20px; }
button:where(:not(.ui-select)) { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 8px 12px; border: 1px solid var(--c-border); border-radius: var(--radius-control); color: var(--c-text); background: var(--c-bg-soft); font: inherit; font-size: 13px; cursor: pointer; }
button:where(:not(.ui-select)) span { width: 14px; height: 14px; }
button:where(:not(.ui-select)):hover:not(:disabled) { background: var(--c-bg-muted); }
button:where(:not(.ui-select)):disabled, fieldset:disabled { opacity: .6; }
button:where(:not(.ui-select)):disabled { cursor: not-allowed; }
button:where(:not(.ui-select)):focus-visible, input:focus-visible, textarea:focus-visible, .ui-select:is(:focus-visible, :has(:focus-visible)), summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.channel-primary { background: var(--c-primary-bg); color: var(--c-text-on-primary); }
.channel-primary:hover:not(:disabled) { background: var(--c-primary-bg-hover); }
.portal-link { padding: 6px 0; min-height: 30px; border: 0; background: transparent; color: var(--c-text); }
@media (max-width: 700px) {
  .channel-fields { grid-template-columns: minmax(0, 1fr); }
  .channel-copy { flex-basis: calc(100% - 40px); }
  .channel-state { flex: 1; }
  button:where(:not(.ui-select)) { min-height: 44px; }
  .channel-row { padding: 20px 0; }
}
.owner-setup { margin-top: 20px; padding: 20px; border: 1px solid var(--c-blue); border-radius: var(--radius-control); background: var(--c-bg-soft); }
.owner-setup--ready { border-color: var(--c-border); }
.owner-setup-heading { display: flex; justify-content: space-between; align-items: start; flex-wrap: wrap; gap: 12px; }
.setup-eyebrow { font-size: 12px; color: var(--c-text-secondary); }
.owner-setup h4 { margin: 6px 0 0; font-size: 18px; }
.setup-badge { border: 1px solid var(--c-border); padding: 5px 10px; font-size: 12px; border-radius: var(--radius-control); color: var(--c-warn); }
.owner-setup--ready .setup-badge { color: var(--c-git-added); }
.setup-summary, .setup-next p { font-size: 13px; line-height: 1.7; color: var(--c-text-secondary); }
.setup-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; padding: 0; margin: 20px 0; list-style: none; }
.setup-steps li { display: flex; align-items: start; gap: 10px; padding: 12px; border: 1px solid var(--c-border); border-radius: var(--radius-control); }
.step-number { display: grid; place-items: center; flex: 0 0 26px; height: 26px; border: 1px solid var(--c-border); border-radius: 50%; font-size: 13px; }
.setup-steps strong { font-size: 13px; }
.setup-steps small, .setup-next > small { display: block; font-size: 12px; color: var(--c-text-secondary); margin-top: 6px; line-height: 1.6; }
.setup-steps .step-current { border-color: var(--c-blue); }
.step-current .step-number { color: var(--c-text-on-primary); background: var(--c-primary-bg); }
.step-done .step-number { color: var(--c-git-added); }
.setup-next { border-top: 1px solid var(--c-border); padding-top: 18px; }
.setup-next > strong { font-size: 14px; }
.setup-install { margin-bottom: 20px; }
.setup-install ol { padding-left: 20px; font-size: 13px; line-height: 1.7; color: var(--c-text-secondary); }
.setup-install li + li { margin-top: 8px; }
.setup-install .portal-link { display: inline-flex; margin-right: 20px; line-height: 1.7; }
.service-setup .setup-steps { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.setup-confirm-actions { display: flex; flex-wrap: wrap; gap: 8px; }
@media (max-width: 700px) { .setup-steps, .service-setup .setup-steps { grid-template-columns: 1fr; } .owner-setup { padding: 16px; } }
</style>
