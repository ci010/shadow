<template>
  <details @toggle="load">
    <summary>{{ t('BOT directory releases') }}</summary>
    <p>{{ t('Freeze one independently versioned BOT directory. Updating or restoring a BOT preserves other packages. Discord, QQ and Feishu use one exact owner review per package; draft edits never change a running Release.') }}</p>
    <p>{{ t('No external platform installation or command registration is performed. Rolling back local configuration does not reverse external actions.') }}</p>
    <button :disabled="busy" @click="load">{{ t('Refresh status') }}</button>
    <label>{{ t('BOT package') }} <select v-model="packageId"><option value="">{{ t('Select a Release') }}</option><option v-for="item in packages" :key="item.platform + item.id" :value="item.platform + ':' + item.id">{{ item.platform }} / {{ item.id }}</option></select></label>
    <p>{{ t('Active Release') }}: <code>{{ selected?.activeRelease }}</code></p>
    <form @submit.prevent="review()">
      <label>{{ t('Registered local folder ID') }} <input v-model="folderId" required /></label>
      <label>{{ t('Relative BOT directory (empty for folder root)') }} <input v-model="directory" /></label>
      <button :disabled="busy || !state">{{ t('Freeze and review Release') }}</button>
    </form>
    <details><summary>{{ t('Connection and folder references') }}</summary><pre>{{ JSON.stringify(state?.inventory, null, 2) }}</pre></details>
    <label>{{ t('Retained Release') }} <select v-model="retained"><option value="">{{ t('Select a Release') }}</option><option v-for="item in selected?.retained" :key="item.revision" :value="item.revision">{{ item.revision }}</option></select></label>
    <button :disabled="busy || !retained" @click="review(retained)">{{ t('Review rollback') }}</button>
    <details v-if="discordDraft" open><summary>{{ t('Exact reviewed data and previous configuration') }}</summary><p>{{ discordDraft.hash }} · {{ discordDraft.baseRevision }}</p><pre>{{ JSON.stringify(discordDraft.change, null, 2) }}</pre><pre>{{ JSON.stringify(discordDraft.change.adoptLegacy ? { agents: state?.discord?.agents, bindings: state?.discord?.bindings } : state?.discord?.packages?.[discordDraft.change.package.id], null, 2) }}</pre><label><input v-model="acknowledged" type="checkbox" />{{ t('I reviewed the exact text, audience and permission changes.') }}</label><button :disabled="busy || !acknowledged" @click="decideDiscord('commit')">{{ t('Approve and apply') }}</button><button :disabled="busy" @click="decideDiscord('cancel')">{{ t('Cancel review') }}</button></details>
    <p v-if="error" role="alert">{{ error }}</p>
    <PublicationRequest :key="version" :api-base="apiBase" :project-id="projectId" session-id="owner:bot-package" :active="active" :can-submit="true" />
  </details>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { t } from '../i18n.ts'
import { apiUrl } from '../api-url.ts'
import type { IntegrationDraft, IntegrationOverview } from '../../../src/channels/integration-contract.ts'
import PublicationRequest from './PublicationRequest.vue'
const props = defineProps<{ apiBase: string; projectId: string; active: boolean }>()
const state = ref<{ activeRelease: string; draftRevision: string; retained: { revision: string }[]; inventory: unknown; packages: Package[]; discordPackages: Package[]; discord?: IntegrationOverview }>()
type Package = {id:string;activeRelease:string;retained:{revision:string}[]}
const packageId = ref('')
const packages = computed(()=>[...(state.value?.packages ?? []).map(p=>({...p,platform:'service'})),...(state.value?.discordPackages ?? []).map(p=>({...p,platform:'discord'}))])
const selected = computed(()=>packages.value.find(p=>`${p.platform}:${p.id}`===packageId.value))
const discordDraft = ref<(IntegrationDraft & {change: Extract<IntegrationDraft['change'],{kind:'bot.save'}>})>()
const acknowledged = ref(false)
const folderId = ref(''), directory = ref(''), retained = ref(''), error = ref('')
const busy = ref(false), version = ref(0)
let generation = 0
watch(() => props.projectId, () => { generation++; discordDraft.value=undefined; acknowledged.value=false; packageId.value=''; state.value = undefined; folderId.value = ''; directory.value = ''; retained.value = ''; error.value = '' })
async function load() {
  const current = generation
  try {
    const response = await fetch(apiUrl(props.apiBase, '/api/bot-package'))
    if (!response.ok) throw new Error(t('Could not load BOT releases.'))
    const result = await response.json()
    if (current === generation) state.value = result
  } catch (cause) { if (current === generation) error.value = String(cause) }
}
async function review(release?: string) {
  if (!state.value || busy.value) return
  const current = generation
  busy.value = true; error.value = ''
  try {
    const response = await fetch(apiUrl(props.apiBase, '/api/bot-package/review'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(release ? { ...(selected.value?.platform === 'discord' ? {discordRelease:release,discordRevision:state.value.discord?.revision} : {release}), packageId:selected.value?.id, expectedRevision: state.value.draftRevision } : { discordRevision: state.value.discord?.revision, folderId: folderId.value, directory: directory.value, expectedRevision: state.value.draftRevision }) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || t('BOT review failed.'))
    if (current === generation) { version.value++; discordDraft.value = result.discordDraft; acknowledged.value = false; await load() }
  } catch (cause) { if (current === generation) error.value = String(cause) }
  finally { busy.value = false }
}
async function decideDiscord(action: 'commit'|'cancel') {
  if (!discordDraft.value || busy.value) return
  busy.value=true
  const current=generation
  try {
    const response=await fetch(apiUrl(props.apiBase, `/api/integrations/discord/drafts/${discordDraft.value.id}/${action}`),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action==='commit'?{hash:discordDraft.value.hash}:{})})
    const result=await response.json()
    if(!response.ok) throw new Error(result.message || result.error)
    if(current===generation){discordDraft.value=undefined;acknowledged.value=false;await load()}
  } catch(cause){if(current===generation)error.value=String(cause)} finally{busy.value=false}
}
</script>
<style scoped>
details { margin: 12px 0; padding: 12px; border: 1px solid var(--c-border); border-radius: 8px; }
form, label { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
pre, code { overflow-wrap: anywhere; white-space: pre-wrap; }
</style>
