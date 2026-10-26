<template>
  <section v-if="active && (drafts.length || receipt || error)" class="bot-publication-review" aria-label="Bot publication approval">
    <h3>{{ t('Bot publication approval') }}</h3>
    <p>{{ t('No change is applied until you approve the review.') }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="receipt" role="status" class="publication-receipt">{{ receipt }}</p>
    <article v-for="draft in drafts" :key="draft.id">
      <h4>{{ draft.change.kind === 'bot.save' ? draft.change.package.id : draft.id }}</h4>
      <p>{{ draft.status }} · {{ draft.hash }} · {{ t('Expires') }} {{ draft.expiresAt }}</p>
      <p>{{ t('Candidate') }} — {{ t('Exact reviewed data and previous configuration') }}</p>
      <details><summary>{{ t('Candidate') }}</summary><pre>{{ JSON.stringify(draft.change, null, 2) }}</pre></details>
      <details><summary>{{ t('Currently published') }}</summary><pre>{{ JSON.stringify(packages, null, 2) }}</pre></details>
      <p>{{ t('Review sourceFolders and discordHistory in BOT.md, including Folder IDs, channels, thread/history scope and tools. The candidate is frozen; subsequent directory edits are not included.') }}</p>
      <label><input type="checkbox" v-model="acknowledged[draft.hash]" />{{ t('I reviewed the exact text, audience and permission changes.') }}</label>
      <button :disabled="busy || !acknowledged[draft.hash] || draft.baseRevision !== revision || Date.parse(draft.expiresAt) <= Date.now()" @click="decide(draft, 'commit')">{{ t('Approve and apply') }}</button>
      <button :disabled="busy" @click="decide(draft, 'cancel')">{{ t('Cancel review') }}</button>
    </article>
  </section>
</template>
<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import { t } from '../i18n.ts'
import { apiUrl } from '../api-url.ts'
import { IntegrationOverviewSchema, type IntegrationDraft } from '../../../src/channels/integration-contract.ts'
const props = defineProps<{apiBase:string; projectId:string; active:boolean}>()
const drafts = ref<IntegrationDraft[]>([])
const packages = ref<unknown>({})
const revision = ref(-1)
const acknowledged = ref<Record<string,boolean>>({})
const error = ref('')
const busy = ref(false)
const receipt = ref('')
let decided: {id:string; action:'commit'|'cancel'} | undefined
let mutation: AbortController | undefined
let timer: ReturnType<typeof setInterval> | undefined
let generation = 0
let controller: AbortController | undefined
async function refresh() {
  if (!props.active || controller || busy.value) return
  const current = generation
  const abort = new AbortController(); controller = abort
  try {
    const response = await fetch(apiUrl(props.apiBase, '/api/integrations/discord'), {cache:'no-store', redirect:'error', signal:abort.signal})
    if (!response.ok) throw new Error('Bot review unavailable')
    const overview = IntegrationOverviewSchema.parse(await response.json())
    if (current !== generation || overview.projectId !== props.projectId) return
    revision.value = overview.revision; packages.value = overview.packages
    if (decided) {
      const result = overview.drafts.find(d => d.id === decided!.id)
      if (decided.action === 'commit' && result?.status === 'applied' && result.change.kind === 'bot.save') {
        const published = overview.packages[result.change.package.id]
        if (!published) throw new Error('Published BOT version is unavailable; refresh authoritative status before retrying.')
        receipt.value = `${result.status} · ${result.change.package.id} · ${published.revision} · ${result.hash} · configuration ${overview.revision}`
        decided = undefined
      } else if (decided.action === 'cancel' && result?.status === 'cancelled') {
        receipt.value = `${result.status} · ${result.hash} · configuration ${overview.revision}`
        decided = undefined
      }
    }
    drafts.value = overview.drafts.filter(d => d.actor.kind === 'owner' && d.change.kind === 'bot.save' && d.status === 'pending')
  } catch (e) { if (current === generation && !abort.signal.aborted) error.value = e instanceof Error ? e.message : 'Bot review unavailable' }
  finally { if (controller === abort) controller = undefined }
}
async function decide(draft:IntegrationDraft, action:'commit'|'cancel') {
  if (busy.value || !props.active || !drafts.value.some(d => d.id === draft.id && d.hash === draft.hash)) return
  if (action === 'commit' && (!acknowledged.value[draft.hash] || draft.baseRevision !== revision.value || Date.parse(draft.expiresAt) <= Date.now())) return
  busy.value = true
  const abort = new AbortController(); mutation = abort
  const current = generation
  try {
    const response = await fetch(apiUrl(props.apiBase, `/api/integrations/discord/drafts/${encodeURIComponent(draft.id)}/${action}`), {
      method:'POST', redirect:'error', signal:abort.signal, headers:{'Content-Type':'application/json'}, body:JSON.stringify(action === 'commit' ? {hash:draft.hash} : {}),
    })
    if (!response.ok) throw new Error('Review is stale or publication failed; refresh status before retrying.')
    if (current === generation) { acknowledged.value = {}; error.value = ''; decided = {id:draft.id,action} }
  } catch (e) { if (current === generation) error.value = e instanceof Error ? e.message : 'Publication failed' }
  finally { if (current === generation) { mutation = undefined; busy.value = false; await refresh() } }
}
function stop() { generation++; mutation?.abort(); mutation = undefined; busy.value = false; receipt.value = ''; decided = undefined; controller?.abort(); controller = undefined; clearInterval(timer); drafts.value = []; acknowledged.value = {}; error.value = '' }
watch(() => [props.active,props.apiBase,props.projectId], () => { stop(); if (props.active) { void refresh(); timer = setInterval(() => void refresh(),3000) } }, {immediate:true})
onUnmounted(stop)
</script>
<style scoped>
.bot-publication-review { max-height: 360px; overflow:auto; margin:8px auto; padding:14px; border:1px solid var(--c-border); width:calc(100% - 40px); max-width:860px; overflow-wrap:anywhere; }
pre { white-space:pre-wrap; } article { margin-bottom:14px; }
</style>
