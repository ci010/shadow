<template>
  <article :lang="locale" class="bot-review" :aria-label="t('Bot publication approval')">
    <details :open="actionable || undefined">
      <summary class="history-heading"><strong>{{ name }}</strong> · <code>{{ version.slice(0, 20) }}</code> · <span class="status-badge">{{ statusLabel }}</span><time v-if="review.decidedAt" :datetime="review.decidedAt"> · {{ formatDateTime(review.decidedAt) }}</time></summary>
      <div class="review-content">
        <header class="card-heading"><div><span class="eyebrow">{{ t(actionable ? 'Human approval required' : 'Review complete') }}</span><h3>{{ t('Bot publication approval') }}</h3><h4>{{ name }}</h4></div><span class="status-badge">{{ statusLabel }}</span></header>
        <p class="frozen-note">{{ t('This version is frozen. Later directory edits are not included in this approval.') }}</p>
        <p v-if="draft?.warning" class="draft-warning">{{ draft.warning }}</p>
        <div class="version-line"><code :title="version">{{ version.slice(0,20) }}</code><span v-if="draft">{{ t('Expires') }} <time :datetime="draft.expiresAt">{{ formatDateTime(draft.expiresAt) }}</time></span></div>
        <section v-if="changes.length" class="change-summary"><h5>{{ t('Changes to published package') }}</h5><p>{{ t('File comparison only. Missing fields or files do not imply revoked permissions; review the full snapshots below.') }}</p><ul><li v-for="change in changes" :key="change.path"><span>{{ t(change.kind) }}</span><code>{{ change.path }}</code></li></ul></section>
        <section class="permission-summary"><h5>{{ t('Frozen permissions and audience') }}</h5><p class="summary-caution">{{ t('Agent limits and each destination scope are shown separately. Effective access remains subject to runtime authorization.') }}</p>
          <p v-if="draft && !summary" class="review-error">{{ t('Permission summary unavailable. Inspect the exact frozen files before approving.') }}</p>
          <pre v-if="request">{{ JSON.stringify({previousBindings:request.previousBindings,bindings:request.bindings,impact:request.impact}, null, 2) }}</pre>
          <section v-for="(group,index) in summary?.groups" :key="index" class="permission-group"><h6>{{ index === 0 ? t('Agent permission ceiling') : t('Destination binding') + ' · ' + group.title }}</h6><dl><template v-for="row in group.rows" :key="row.label"><dt>{{ t(row.label) }}</dt><dd>{{ row.value }}</dd></template></dl></section>
        </section>
        <details class="technical"><summary>{{ t('Technical details and exact snapshots') }}</summary><pre>{{ JSON.stringify({candidate:review.candidate,previousSource:review.previousSource}, null, 2) }}</pre></details>
        <p v-if="review.status === 'waiting' && request" class="frozen-note">{{ t('Approved; waiting for active conversations to finish. No further approval is needed.') }}</p>
        <footer v-if="actionable && canSubmit">
          <label class="acknowledgement"><input v-model="acknowledged" type="checkbox" :disabled="busy || submitted" /><span>{{ t('I reviewed the exact text, audience and permission changes.') }}</span></label>
          <p :id="reasonId" class="action-hint" role="status">{{ approvalHint }} <span v-if="stale">{{ revisionHint }}</span></p>
          <p v-if="error" class="review-error" role="alert">{{ error }}</p>
          <div class="actions"><button v-if="pending" class="approve" :disabled="!!approvalBlock" :aria-describedby="reasonId" @click="decide('commit')">{{ t('Approve and apply') }}</button><button :disabled="busy || submitted" :aria-describedby="reasonId" @click="decide('cancel')">{{ t('Cancel review') }}</button></div>
        </footer>
      </div>
    </details>
    <p v-if="!actionable && (expired || stale)" class="historical-reason" role="status">{{ approvalHint }} <span v-if="stale">{{ revisionHint }}</span></p>
  </article>
</template>
<script setup lang="ts">
import { computed, ref, watch, useId, onUnmounted } from 'vue'
import type { BotReviewRecord } from '../../../src/agent-authoring/bot-review-contract.ts'
import { parsePublicationRequest } from '../../../src/agent-authoring/publication-contract.ts'
import { summarizeBot } from '../bot-publication-summary.ts'
import { t, i18n, formatDateTime, type MessageKey } from '../i18n.ts'
import { apiUrl } from '../api-url.ts'
const props = defineProps<{review:BotReviewRecord; apiBase:string; sessionId:string; canSubmit:boolean}>()
const emit = defineEmits<{updated:[]}>()
const locale = computed(() => i18n.global.locale.value)
const draft = computed(() => props.review.candidate.kind === 'discord' ? props.review.candidate.draft : undefined)
const request = computed(() => props.review.candidate.kind === 'service' ? parsePublicationRequest(props.review.candidate.request, props.review.projectId) : undefined)
const summary = computed(() => draft.value ? summarizeBot(draft.value) : undefined)
const name = computed(() => summary.value?.name || (draft.value?.change.kind === 'bot.save' ? draft.value.change.package.id : undefined) || request.value?.change?.title || [...new Set(request.value?.files.flatMap(file => /^bot\/([^/]+)\//.exec(file.path)?.[1] ?? []) ?? [])].join(', ') || 'Bot')
const changes = computed(() => {
  if (draft.value?.change.kind !== 'bot.save') return []
  const before = props.review.previousSource ?? {}, after = draft.value.change.package.source
  return [...new Set([...Object.keys(before),...Object.keys(after)])].sort().map(path => ({path,kind:!(path in before) ? 'Added' as const : !(path in after) ? 'Absent from candidate' as const : before[path] !== after[path] ? 'Modified' as const : 'Unchanged' as const}))
})
const version = computed(() => draft.value?.hash ?? request.value?.revision ?? '')
const requestScope = computed(() => JSON.stringify([props.apiBase,props.sessionId,props.canSubmit,props.review.projectId,props.review.id,props.review.origin,version.value,props.review.currentRevision]))
const pending = computed(() => props.review.status === 'pending')
const actionable = computed(() => pending.value || !!request.value && (props.review.status === 'waiting' || props.review.status === 'error'))
const submitted = ref(false)
const acknowledged = ref(false), busy = ref(false), error = ref(''), now = ref(Date.now())
const reasonId = `bot-review-reason-${useId()}`
const expired = computed(() => props.review.status === 'expired' || !!draft.value && Date.parse(draft.value.expiresAt) <= now.value)
const baseRevision = computed(() => draft.value?.baseRevision ?? request.value?.baseRevision)
const stale = computed(() => props.review.status === 'stale' || props.review.currentRevision !== undefined && baseRevision.value !== props.review.currentRevision && pending.value)
const revisionHint = computed(() => t('Reviewed revision {base}; current configuration {current}.', {base:String(baseRevision.value),current:String(props.review.currentRevision ?? t('Unavailable'))}))
const statusKeys:Record<BotReviewRecord['status'],MessageKey> = {pending:'Awaiting approval',waiting:'Applying your decision…',applied:'Applied',cancelled:'Cancelled',expired:'Expired',stale:'Configuration changed',error:'Publication failed',unavailable:'Unavailable'}
const statusLabel = computed(() => t(expired.value && pending.value ? 'Expired' : stale.value ? 'Configuration changed' : statusKeys[props.review.status]))
const approvalBlock = computed<MessageKey | undefined>(() => {
  if (busy.value) return 'Applying your decision…'
  if (submitted.value) return 'Publication outcome is not yet confirmed. Refresh authoritative status before another decision.'
  if (expired.value) return 'This review expired. Create a fresh review to continue.'
  if (stale.value) return 'Configuration changed. Create a fresh review before approving.'
  if (error.value || props.review.status === 'error') return 'Review is stale or publication failed; refresh status before retrying.'
  if (!pending.value) return 'Current status could not be verified. Approval is paused until status refresh succeeds.'
  if (props.review.currentRevision === undefined) return 'Current configuration revision unavailable. Refresh before approving.'
  if (!acknowledged.value) return 'Check the acknowledgement above to enable approval.'
  return undefined
})
const approvalHint = computed(() => t(approvalBlock.value ?? 'Ready to approve this frozen version.'))
let generation = 0
let mutation:AbortController|undefined
let expiryTimer:ReturnType<typeof setTimeout>|undefined
function reset() {
  generation++
  // Aborting this client wait does not undo a server-side commit. Reload reads host records.
  mutation?.abort(); mutation=undefined; clearTimeout(expiryTimer)
  busy.value=false;submitted.value=false;acknowledged.value=false;error.value='';now.value=Date.now()
}
watch(() => [props.review,requestScope.value,props.review.status], () => {
  reset()
  const current=generation
  if (draft.value && pending.value) expiryTimer=setTimeout(() => {
    if (current !== generation) return
    now.value=Date.now();emit('updated')
  },Math.max(0,Date.parse(draft.value.expiresAt)-Date.now())+10)
},{immediate:true,flush:'sync'})
onUnmounted(reset)
async function decide(action:'commit'|'cancel') {
  now.value=Date.now()
  if (!props.canSubmit || props.sessionId !== props.review.origin.sessionId || !actionable.value || busy.value || submitted.value || (action === 'commit' && !!approvalBlock.value)) return
  const current=generation, reviewed=props.review, scope=requestScope.value
  const abort=new AbortController();mutation=abort
  const currentView=()=>current===generation && reviewed===props.review && scope===requestScope.value && !abort.signal.aborted
  busy.value = true; error.value = ''
  try {
    const path = draft.value ? `/api/integrations/discord/drafts/${encodeURIComponent(props.review.id)}/${action}` : `/api/agent-resources/publication-requests/${encodeURIComponent(props.review.id)}`
    const body = draft.value ? action === 'commit' ? {hash:draft.value.hash} : {} : {revision:request.value!.revision,baseRevision:request.value!.baseRevision}
    const response = await fetch(apiUrl(props.apiBase,path), {signal:abort.signal,method:draft.value || action === 'commit' ? 'POST' : 'DELETE',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    if (!currentView()) return
    if (!response.ok) throw new Error(t('Review is stale or publication failed; refresh status before retrying.'))
    submitted.value = true
  } catch (e) { if (currentView()) error.value = e instanceof Error ? e.message : t('Publication failed') }
  finally { if (currentView()) {mutation=undefined;acknowledged.value=false;busy.value=false;emit('updated')} }
}
</script>
<style scoped>
.bot-review { box-sizing:border-box; margin:16px auto; width:calc(100% - 40px); max-width:860px; color:var(--c-text); font-size:13px; line-height:1.6; overflow-wrap:anywhere; }
h3,h4,h5,h6,p { margin:0; } h3 { font-size:20px; letter-spacing:-.4px; } h4 { font-size:22px; letter-spacing:-.5px; line-height:1.3; margin-top:4px; } h5 { font-size:14px; margin-bottom:8px; } h6 { font-size:12px; margin-bottom:12px; }
p { color:var(--c-text-secondary); } .eyebrow { font-size:11px; font-weight:600; color:var(--c-text-secondary); letter-spacing:.06em; }
.bot-review { border:1px solid var(--c-border); border-radius:var(--radius-surface); background:var(--c-bg-card); margin-bottom:20px; overflow:hidden; }
.card-heading { display:flex; gap:16px; justify-content:space-between; align-items:flex-start; padding:24px 24px 12px; }
.status-badge { border:1px solid var(--c-border); background:var(--c-bg-muted); border-radius:var(--radius-pill); padding:4px 10px; font-size:11px; white-space:nowrap; }
.draft-warning { margin:12px 24px 0; padding:12px; border:1px solid var(--c-border); border-radius:var(--radius-sm); } .frozen-note { padding:0 24px; } .version-line { display:flex; flex-wrap:wrap; gap:8px 20px; padding:12px 24px 20px; color:var(--c-text-secondary); font-size:12px; }
.change-summary,.permission-summary { margin:0 24px 20px; } .change-summary { background:var(--c-bg-soft); padding:16px; border-radius:var(--radius-surface); } .change-summary p,.summary-caution { font-size:12px; } ul { list-style:none; padding:0; margin:12px 0 0; } li { display:flex; gap:12px; padding:4px 0; } li span { min-width:80px; color:var(--c-text-secondary); font-size:12px; }
.permission-group { border-top:1px solid var(--c-border); margin-top:16px; padding-top:16px; } dl { display:grid; grid-template-columns:minmax(120px, 1fr) minmax(0, 2fr); gap:8px 20px; margin:0; } dt { color:var(--c-text-secondary); } dd { margin:0; white-space:pre-wrap; }
.technical { margin:0 24px 24px; border-top:1px solid var(--c-border); padding-top:16px; } summary { cursor:pointer; font-weight:600; } .technical dl { margin:16px 0; } .technical h5 { margin-top:16px; } pre { white-space:pre-wrap; font-size:11px; padding:14px; background:var(--c-bg-muted); border-radius:var(--radius-sm); }
footer { border-top:1px solid var(--c-border); padding:20px 24px; background:var(--c-bg-soft); } .acknowledgement { display:flex; gap:10px; align-items:flex-start; cursor:pointer; } input { width:16px; height:16px; margin:3px 0 0; accent-color:var(--c-primary-bg); flex-shrink:0; } .action-hint { font-size:12px; margin:10px 0 16px 26px; } .actions { display:flex; flex-wrap:wrap; gap:10px; }
button { border:1px solid var(--c-border); border-radius:var(--radius-control); padding:9px 16px; min-height:38px; font:inherit; font-weight:600; cursor:pointer; background:var(--c-bg-card); color:var(--c-text); } button.approve { background:var(--c-primary-bg); color:var(--c-text-on-primary); border-color:transparent; } button:hover:not(:disabled) { background:var(--c-bg-muted); } button.approve:hover:not(:disabled) { background:var(--c-primary-bg-hover); } button:disabled { opacity:.5; cursor:not-allowed; } button:focus-visible, summary:focus-visible,input:focus-visible { outline:2px solid var(--c-blue); outline-offset:3px; }
.review-error { color:var(--c-error); padding:12px 0; }
@media(max-width:540px) { .bot-review { width:calc(100% - 24px); } .card-heading { padding:18px 16px 12px; flex-wrap:wrap; } .frozen-note { padding:0 16px; } .version-line { padding:12px 16px 16px; } .change-summary,.permission-summary,.technical { margin-left:16px; margin-right:16px; } footer { padding:16px; } dl { grid-template-columns:1fr; gap:2px; } dd { margin-bottom:10px; } .actions button { flex:1; } }
.history-heading {padding:16px 24px;display:flex;gap:8px;align-items:center;flex-wrap:wrap} .historical-reason {padding:12px 24px;border-top:1px solid var(--c-border)}
</style>
