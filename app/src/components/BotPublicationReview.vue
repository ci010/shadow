<template>
  <section v-if="active && (drafts.length || receipt || error || statusError)" class="bot-publication-review" :aria-label="t('Bot publication approval')">
    <header class="review-heading"><span class="eyebrow">{{ t('Human approval required') }}</span><h3>{{ t('Bot publication approval') }}</h3><p>{{ t('No change is applied until you approve the review.') }}</p></header>
    <p v-if="statusError" role="alert" class="review-error">{{ statusError }}</p>
    <p v-if="error" role="alert" class="review-error">{{ error }}</p>
    <div v-if="receipt" role="status" class="publication-receipt"><strong>{{ t('Review complete') }}</strong><p>{{ t(receipt.startsWith('applied') ? 'Publication applied successfully.' : 'Review cancelled. No candidate changes were applied.') }}</p><details><summary>{{ t('Decision receipt') }}</summary><p>{{ receipt }}</p></details></div>
    <article v-for="draft in drafts" :key="draft.id">
      <header class="card-heading"><div><span class="eyebrow">{{ draft.change.kind === 'bot.save' ? draft.change.package.id : draft.id }}</span><h4>{{ summaries[draft.id]?.name || (draft.change.kind === 'bot.save' ? draft.change.package.id : draft.id) }}</h4></div><span class="status-badge">{{ t(draft.baseRevision !== revision ? 'Configuration changed' : Date.parse(draft.expiresAt) <= now ? 'Expired' : 'Awaiting approval') }}</span></header>
      <p class="frozen-note">{{ t('This version is frozen. Later directory edits are not included in this approval.') }}</p>
      <p v-if="draft.warning" class="draft-warning">{{ draft.warning }}</p><p v-if="draft.change.kind === 'bot.save' && draft.change.adoptLegacy" class="draft-warning">{{ t('Legacy adoption requested. Inspect the exact candidate and current configuration.') }}</p>
      <div class="version-line"><code :title="draft.hash">{{ draft.hash.slice(0, 12) }}</code><span>{{ t('Expires') }} <time :datetime="draft.expiresAt">{{ formatDate(draft.expiresAt) }}</time></span></div>
      <section class="change-summary"><h5>{{ t('Changes to published package') }}</h5><p>{{ t('File comparison only. Missing fields or files do not imply revoked permissions; review the full snapshots below.') }}</p><ul><li v-for="change in fileChanges(draft)" :key="change.path"><span>{{ t(change.kind) }}</span> <code>{{ change.path }}</code></li></ul></section>
      <section class="permission-summary"><h5>{{ t('Frozen permissions and audience') }}</h5><p class="summary-caution">{{ t('Agent limits and each destination scope are shown separately. Effective access remains subject to runtime authorization.') }}</p>
        <p v-if="!summaries[draft.id]" class="review-error">{{ t('Permission summary unavailable. Inspect the exact frozen files before approving.') }}</p>
        <div v-for="(group, index) in summaries[draft.id]?.groups" :key="index" class="permission-group"><h6>{{ index === 0 ? t('Agent permission ceiling') : t('Destination binding') + ' · ' + group.title }}</h6><dl><template v-for="row in group.rows" :key="row.label"><dt>{{ t(row.label) }}</dt><dd>{{ row.value }}</dd></template></dl></div>
      </section>
      <details class="technical"><summary>{{ t('Technical details and exact snapshots') }}</summary><dl><dt>{{ t('Review hash') }}</dt><dd><code>{{ draft.hash }}</code></dd><dt>{{ t('Base revision') }}</dt><dd>{{ draft.baseRevision }}</dd><dt>{{ t('Created') }}</dt><dd>{{ draft.createdAt }}</dd><dt>{{ t('Expires') }}</dt><dd>{{ draft.expiresAt }}</dd></dl><h5>{{ t('Candidate') }}</h5><pre>{{ JSON.stringify(draft, null, 2) }}</pre><h5>{{ t('Currently published') }}</h5><pre>{{ JSON.stringify(draft.change.kind === 'bot.save' && draft.change.adoptLegacy ? {package:currentPackage(draft), ...legacyConfiguration} : currentPackage(draft), null, 2) }}</pre></details>
      <footer><label class="acknowledgement"><input type="checkbox" v-model="acknowledged[draft.hash]" :disabled="busy" /><span>{{ t('I reviewed the exact text, audience and permission changes.') }}</span></label><p :id="`approval-reason-${draft.hash}`" class="action-hint" role="status">{{ approvalHint(draft) }}<span v-if="draft.baseRevision !== revision"> {{ t('Reviewed revision {base}; current configuration {current}.', {base:draft.baseRevision,current:revision}) }}</span></p><div class="actions"><button class="approve" :disabled="!!approvalBlock(draft)" :aria-describedby="`approval-reason-${draft.hash}`" @click="decide(draft, 'commit')">{{ t('Approve and apply') }}</button><button :disabled="busy" @click="decide(draft, 'cancel')">{{ t('Cancel review') }}</button></div></footer>
    </article>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue'
import { t, formatDateTime, type MessageKey } from '../i18n.ts'
import { summarizeBot } from '../bot-publication-summary.ts'
import { apiUrl } from '../api-url.ts'
import { IntegrationOverviewSchema, type IntegrationDraft, type IntegrationOverview } from '../../../src/channels/integration-contract.ts'
const props = defineProps<{apiBase:string; projectId:string; active:boolean}>()
const drafts = ref<IntegrationDraft[]>([])
const packages = ref<IntegrationOverview['packages']>({})
const now = ref(Date.now())
const legacyConfiguration = ref<Pick<IntegrationOverview, 'agents' | 'bindings'>>({agents:[],bindings:[]})
const summaries = computed(() => Object.fromEntries(drafts.value.map(d => [d.id, summarizeBot(d)])))
function currentPackage(draft: IntegrationDraft) { return draft.change.kind === 'bot.save' ? packages.value[draft.change.package.id] ?? null : null }
function fileChanges(draft: IntegrationDraft) {
  if (draft.change.kind !== 'bot.save') return []
  const before = currentPackage(draft)?.active.source ?? {}
  const after = draft.change.package.source
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().map(path => ({path, kind: !(path in before) ? 'Added' as const : !(path in after) ? 'Absent from candidate' as const : before[path] !== after[path] ? 'Modified' as const : 'Unchanged' as const}))
}
function formatDate(value: string) { return formatDateTime(value, {dateStyle:'medium',timeStyle:'short'}) }
function approvalHint(draft: IntegrationDraft) {
  const reason = approvalBlock(draft)
  if (reason) return t(reason)
  return t(error.value ? 'The last decision failed. Status is verified; you may retry this frozen version.' : 'Ready to approve this frozen version.')
}
const revision = ref(-1)
const acknowledged = ref<Record<string,boolean>>({})
const error = ref('')
const statusError = ref('')
const verifiedAt = ref(0)
const statusVerified = ref(false)
// A slow or failed status request must not leave a previously valid card looking approvable.
const STATUS_MAX_AGE_MS = 10_000
function approvalBlock(draft: IntegrationDraft, clock = now.value): MessageKey | undefined {
  if (busy.value) return 'Applying your decision…'
  if (Date.parse(draft.expiresAt) <= clock) return 'This review expired. Create a fresh review to continue.'
  if (draft.baseRevision !== revision.value) return 'Configuration changed. Create a fresh review before approving.'
  if (!statusVerified.value || clock - verifiedAt.value > STATUS_MAX_AGE_MS) return 'Current status could not be verified. Approval is paused until status refresh succeeds.'
  if (!acknowledged.value[draft.hash]) return 'Check the acknowledgement above to enable approval.'
  return undefined
}
const busy = ref(false)
const receipt = ref('')
let decided: {id:string; action:'commit'|'cancel'} | undefined
let mutation: AbortController | undefined
let timer: ReturnType<typeof setInterval> | undefined
let generation = 0
let lastRefresh = 0
let controller: AbortController | undefined
async function refresh() {
  if (!props.active || controller || busy.value) return
  const current = generation
  const abort = new AbortController(); controller = abort
  try {
    const response = await fetch(apiUrl(props.apiBase, '/api/integrations/discord'), {cache:'no-store', redirect:'error', signal:abort.signal})
    if (!response.ok) throw new Error(t('Bot review unavailable'))
    const overview = IntegrationOverviewSchema.parse(await response.json())
    if (current !== generation) return
    if (overview.projectId !== props.projectId) throw new Error(t('Bot review unavailable'))
    statusVerified.value = true; verifiedAt.value = Date.now(); statusError.value = '';
    now.value = Date.now(); revision.value = overview.revision; packages.value = overview.packages; legacyConfiguration.value = {agents:overview.agents,bindings:overview.bindings}
    if (decided) {
      const result = overview.drafts.find(d => d.id === decided!.id)
      if (decided.action === 'commit' && result?.status === 'applied' && result.change.kind === 'bot.save') {
        const published = overview.packages[result.change.package.id]
        if (!published) throw new Error(t('Published BOT version is unavailable; refresh authoritative status before retrying.'))
        receipt.value = `${result.status} · ${result.change.package.id} · ${published.revision} · ${result.hash} · configuration ${overview.revision}`
        decided = undefined
      } else if (decided.action === 'cancel' && result?.status === 'cancelled') {
        receipt.value = `${result.status} · ${result.hash} · configuration ${overview.revision}`
        decided = undefined
      }
    }
    drafts.value = overview.drafts.filter(d => d.actor.kind === 'owner' && d.change.kind === 'bot.save' && d.status === 'pending')
  } catch (e) { if (current === generation && !abort.signal.aborted) { statusVerified.value = false; statusError.value = t('Could not refresh authoritative Bot status. Approval is paused; automatic refresh will retry.') } }
  finally { if (controller === abort) controller = undefined }
}
async function decide(draft:IntegrationDraft, action:'commit'|'cancel') {
  if (busy.value || !props.active || !drafts.value.some(d => d.id === draft.id && d.hash === draft.hash)) return
  if (action === 'commit' && approvalBlock(draft, Date.now())) { now.value = Date.now(); return }
  busy.value = true
  const abort = new AbortController(); mutation = abort
  const current = generation
  try {
    const response = await fetch(apiUrl(props.apiBase, `/api/integrations/discord/drafts/${encodeURIComponent(draft.id)}/${action}`), {
      method:'POST', redirect:'error', signal:abort.signal, headers:{'Content-Type':'application/json'}, body:JSON.stringify(action === 'commit' ? {hash:draft.hash} : {}),
    })
    if (!response.ok) throw new Error(t('Review is stale or publication failed; refresh status before retrying.'))
    if (current === generation) { acknowledged.value = {}; error.value = ''; decided = {id:draft.id,action} }
  } catch (e) { if (current === generation) { acknowledged.value = {}; error.value = e instanceof Error ? e.message : t('Publication failed') } }
  finally { if (current === generation) { mutation = undefined; busy.value = false; await refresh() } }
}
function stop() { generation++; mutation?.abort(); mutation = undefined; busy.value = false; receipt.value = ''; decided = undefined; controller?.abort(); controller = undefined; clearInterval(timer); drafts.value = []; packages.value = {}; legacyConfiguration.value = {agents:[],bindings:[]}; revision.value = -1; acknowledged.value = {}; error.value = ''; statusError.value = ''; statusVerified.value = false; verifiedAt.value = 0; lastRefresh = 0 }
watch(() => [props.active,props.apiBase,props.projectId], () => { stop(); if (props.active) { void refresh(); timer = setInterval(() => { now.value = Date.now(); if (now.value - lastRefresh >= 3000) { lastRefresh = now.value; void refresh() } },1000) } }, {immediate:true})
onUnmounted(stop)
</script>
<style scoped>
.bot-publication-review { box-sizing:border-box; margin:16px auto; width:calc(100% - 40px); max-width:860px; color:var(--c-text); font-size:13px; line-height:1.6; overflow-wrap:anywhere; }
.review-heading { padding:4px 2px 16px; }
h3,h4,h5,h6,p { margin:0; } h3 { font-size:20px; letter-spacing:-.4px; } h4 { font-size:22px; letter-spacing:-.5px; line-height:1.3; margin-top:4px; } h5 { font-size:14px; margin-bottom:8px; } h6 { font-size:12px; margin-bottom:12px; }
p { color:var(--c-text-secondary); } .eyebrow { font-size:11px; font-weight:600; color:var(--c-text-secondary); letter-spacing:.06em; }
article { border:1px solid var(--c-border); border-radius:16px; background:var(--c-bg-card); margin-bottom:20px; overflow:hidden; }
.card-heading { display:flex; gap:16px; justify-content:space-between; align-items:flex-start; padding:24px 24px 12px; }
.status-badge { border:1px solid var(--c-border); background:var(--c-bg-muted); border-radius:20px; padding:4px 10px; font-size:11px; white-space:nowrap; }
.draft-warning { margin:12px 24px 0; padding:12px; border:1px solid var(--c-border); border-radius:8px; } .frozen-note { padding:0 24px; } .version-line { display:flex; flex-wrap:wrap; gap:8px 20px; padding:12px 24px 20px; color:var(--c-text-secondary); font-size:12px; }
.change-summary,.permission-summary { margin:0 24px 20px; } .change-summary { background:var(--c-bg-soft); padding:16px; border-radius:10px; } .change-summary p,.summary-caution { font-size:12px; } ul { list-style:none; padding:0; margin:12px 0 0; } li { display:flex; gap:12px; padding:4px 0; } li span { min-width:80px; color:var(--c-text-secondary); font-size:12px; }
.permission-group { border-top:1px solid var(--c-border); margin-top:16px; padding-top:16px; } dl { display:grid; grid-template-columns:minmax(120px, 1fr) minmax(0, 2fr); gap:8px 20px; margin:0; } dt { color:var(--c-text-secondary); } dd { margin:0; white-space:pre-wrap; }
.technical { margin:0 24px 24px; border-top:1px solid var(--c-border); padding-top:16px; } summary { cursor:pointer; font-weight:600; } .technical dl { margin:16px 0; } .technical h5 { margin-top:16px; } pre { white-space:pre-wrap; font-size:11px; padding:14px; background:var(--c-bg-muted); border-radius:8px; }
footer { border-top:1px solid var(--c-border); padding:20px 24px; background:var(--c-bg-soft); } .acknowledgement { display:flex; gap:10px; align-items:flex-start; cursor:pointer; } input { width:16px; height:16px; margin:3px 0 0; accent-color:var(--c-primary-bg); flex-shrink:0; } .action-hint { font-size:12px; margin:10px 0 16px 26px; } .actions { display:flex; flex-wrap:wrap; gap:10px; }
button { border:1px solid var(--c-border); border-radius:var(--radius-control,8px); padding:9px 16px; min-height:38px; font:inherit; font-weight:600; cursor:pointer; background:var(--c-bg-card); color:var(--c-text); } button.approve { background:var(--c-primary-bg); color:var(--c-text-on-primary); border-color:transparent; } button:hover:not(:disabled) { background:var(--c-bg-muted); } button.approve:hover:not(:disabled) { background:var(--c-primary-bg-hover); } button:disabled { opacity:.5; cursor:not-allowed; } button:focus-visible, summary:focus-visible,input:focus-visible { outline:2px solid var(--c-blue); outline-offset:3px; }
.review-error { color:var(--c-error); padding:12px 0; } .publication-receipt { padding:20px; margin-bottom:16px; border:1px solid var(--c-border); border-radius:12px; background:var(--c-bg-card); } .publication-receipt p { margin-top:6px; }
@media(max-width:540px) { .bot-publication-review { width:calc(100% - 24px); } .card-heading { padding:18px 16px 12px; flex-wrap:wrap; } .frozen-note { padding:0 16px; } .version-line { padding:12px 16px 16px; } .change-summary,.permission-summary,.technical { margin-left:16px; margin-right:16px; } footer { padding:16px; } dl { grid-template-columns:1fr; gap:2px; } dd { margin-bottom:10px; } .actions button { flex:1; } }
</style>
