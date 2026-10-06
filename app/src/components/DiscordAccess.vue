<template>
  <section class="discord-access" :aria-labelledby="`${uid}-title`">
    <header class="access-heading">
      <div><h4 :id="`${uid}-title`">Discord access</h4><p>Assign an Agent to each channel. Instructions can be reused; conversations stay separate.</p></div>
      <button :disabled="!!busy" @click="reload(true)">Refresh configuration</button>
    </header>
    <nav class="access-nav" aria-label="Discord configuration">
      <button v-for="page in pages" :key="page.id" :aria-current="tab === page.id ? 'page' : undefined" @click="tab = page.id">{{ page.label }}</button>
    </nav>
    <p v-if="error" class="access-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="access-notice" role="status">{{ notice }}</p>
    <p v-if="busy" role="status">{{ busy }}</p>
    <template v-if="overview">
      <p v-if="formRevision !== overview.revision" class="access-notice">Configuration changed. Refresh before creating another review; your unsaved form is preserved for comparison.</p>
      <p v-for="issue in overview.deploymentIssues" :key="issue.agentId" class="access-error" role="alert">{{ agentName(issue.agentId) }} is paused: {{ issue.message }}</p>
      <div v-if="tab === 'channels'">
        <div class="boundary-note"><strong>Closed until assigned.</strong> Unassigned channels and DMs do not enter an Agent. Legacy admin-chat settings and Discord administrator roles do not grant Shadow access.</div>
        <details v-if="legacy?.legacySessionId || legacy?.adminChats.length"><summary>Review previous Discord settings</summary><p>{{ legacy.notice }}</p><p class="muted">Choose the server below to resolve saved channel names. Migration copies no administrative permission automatically.</p><div class="choices"><button v-for="id in legacy.adminChats" :key="id" :disabled="!!busy || !directory?.channels.some(channel => channel.id === id && channel.supported && channel.canSend)" @click="prepareLegacy(id)">Review {{ directory?.channels.find(channel => channel.id === id)?.name ?? `saved channel ${id.slice(-6)}` }}</button></div></details>
        <div class="directory-toolbar">
          <label>Server<select v-model="guildId" :disabled="!!busy" @change="loadDirectory()"><option value="">Choose a server</option><option v-for="guild in guilds" :key="guild.id" :value="guild.id">{{ guild.name }} · {{ guild.id.slice(-6) }}</option></select></label>
          <button :disabled="!!busy || !connected" @click="loadDirectory()">Sync Discord directory</button>
          <button v-if="guildCursor" :disabled="!!busy" @click="loadDirectory(guildCursor)">More servers</button>
        </div>
        <p v-if="!connected" class="access-notice">Connect this Bot before discovering resources, previewing access, or enabling assignments. Saved configuration remains available.</p>
        <p v-if="directory" class="muted">{{ directory.notice }} Last synchronized {{ localTime(directory.synchronizedAt) }}.</p>
        <form @submit.prevent="proposeBindings">
          <fieldset :disabled="!!busy">
            <legend>Channel assignment</legend>
            <div class="form-grid">
              <label>Location type<select v-model="locationType" @change="selectedChannels = []; roleIds = []; userIds = ''"><option value="channel">Server channels</option><option value="dm">One person's direct messages</option></select></label>
              <label>Published Agent<select v-model="assignedAgentId" required @change="selectAgentPermissions"><option value="" disabled>Select an Agent</option><option v-for="agent in overview.agents" :key="agent.id" :value="agent.id">{{ agent.displayName }}</option></select></label>
            </div>
            <p v-if="!overview.agents.length">Publish an Agent in <button type="button" class="text-button" @click="tab = 'agents'">Agents</button> before assigning a channel.</p>
            <template v-if="locationType === 'channel'">
              <div class="form-grid search-field"><label>Find channels<input v-model="channelSearch" type="search" placeholder="Channel or parent name" /></label><label>Show<select v-model="channelFilter"><option value="all">All visible channels</option><option value="assigned">Assigned</option><option value="unassigned">Not assigned</option><option value="blocked">Cannot use</option></select></label></div>
              <div v-if="visibleChannels.length" class="channel-picker" aria-label="Channels to assign">
                <label v-for="channel in visibleChannels" :key="channel.id" class="picker-row">
                  <input v-model="selectedChannels" type="checkbox" :value="channel.id" :disabled="!channel.supported || !channel.canSend" />
                  <span><strong>{{ channel.type === 10 || channel.type === 11 ? 'Thread' : '#' }} {{ channel.name }}</strong><small>{{ channelParent(channel.parentId) }} · {{ channel.id.slice(-6) }}</small></span>
                  <span class="row-status">{{ !channel.supported ? 'Unsupported type' : !channel.canSend ? 'Cannot send' : existingChannel(channel.id) ? (existingChannel(channel.id)!.enabled ? agentName(existingChannel(channel.id)!.agentId) : 'Disabled') : 'Not assigned' }}</span>
                </label>
              </div>
              <p v-else class="muted">{{ guildId && directory?.guildId === guildId ? 'No matching Bot-visible channels. Check Discord permissions or change the search.' : 'Select a server and synchronize its channel directory.' }}</p>
            </template>
            <section class="people-section">
              <h5>{{ locationType === 'dm' ? 'DM recipient' : 'Who may use this Agent' }}</h5>
              <p v-if="locationType === 'channel'" class="muted">Participant controls decide who can invoke the Agent, not who can read Discord replies. Use a private channel for confidential work.</p>
              <label v-if="locationType === 'channel'" class="check-label"><input v-model="everyone" type="checkbox" />Everyone who can send in this channel</label>
              <p v-if="everyone && (assignedAgent?.execution === 'trusted' || selectedTools.includes('channel_config'))" class="access-error">Privileged Agents require selected users or roles, not everyone.</p>
              <div v-if="locationType === 'channel' && !everyone" class="choices">
                <label v-for="role in directory?.roles ?? []" :key="role.id" class="check-label"><input v-model="roleIds" type="checkbox" :value="role.id" />{{ role.name }}</label>
              </div>
              <div class="directory-toolbar">
                <label>Find a person in this server<input v-model="memberQuery" maxlength="100" placeholder="Display name or username" /></label>
                <button type="button" :disabled="!guildId || !memberQuery.trim() || !connected" @click="findMembers">Find people</button>
              </div>
              <p v-if="memberNotice" class="muted" role="status">{{ memberNotice }}</p>
              <div v-if="members.length" class="choices"><button v-for="member in members" :key="member.id" type="button" @click="addMember(member)">{{ member.name }} · @{{ member.username }}</button></div>
              <p v-if="namedUsers.length" class="muted">Selected: {{ namedUsers.join(', ') }}</p>
              <details><summary>Exact user IDs and users outside this server</summary><label>Allowed user IDs<textarea v-model="userIds" rows="2" placeholder="One ID per line" /></label><p class="muted">Discord cannot search all users by name. For a DM recipient outside a mutual server, copy their user ID in Discord. DMs never inherit roles.</p></details>
            </section>
            <div class="form-grid">
              <label>Respond to<select v-model="trigger"><option value="mention">Mentions and replies to the Bot</option><option value="all">Every authorized message</option></select></label>
              <label v-if="locationType === 'channel'" class="check-label"><input v-model="inheritThreads" type="checkbox" />New public threads inherit this assignment, not its history</label>
            </div>
            <h5>Tools available here</h5>
            <div class="choices"><label v-for="tool in assignedAgent?.tools ?? []" :key="tool" class="check-label"><input v-model="selectedTools" type="checkbox" :value="tool" />{{ toolLabel(tool) }}</label></div>
            <p v-if="selectedTools.includes('channel_config')" class="access-notice">This grants configuration management within the manager's approved tool and knowledge limits. Every change still requires human approval.</p>
            <h5>Additional readable knowledge</h5>
            <p class="muted">This conversation gets its own memory automatically. Project-private memory, SOUL, other customers, and old authorization contexts are excluded.</p>
            <div class="choices"><label v-for="domain in assignableDomains" :key="domain.id" class="check-label"><input v-model="selectedDomains" type="checkbox" :value="domain.id" />{{ domain.name }}</label><span v-if="!assignableDomains.length" class="muted">No knowledge domains approved for this Agent.</span></div>
            <div class="form-actions"><button class="primary" :disabled="!assignedAgentId || !connected || locationType === 'channel' && !selectedChannels.length">Review assignment{{ selectedChannels.length > 1 ? 's' : '' }}</button><small>No change is applied until you approve the review.</small></div>
          </fieldset>
        </form>
        <section class="saved-section">
          <h5>Saved assignments</h5>
          <p v-if="!botBindings.length" class="muted">No channels or DMs are assigned to this Bot.</p>
          <div v-for="binding in botBindings" :key="binding.id" class="saved-row">
            <div><strong>{{ locationLabel(binding) }}</strong><p>{{ agentName(binding.agentId) }} · {{ binding.enabled ? 'Enabled' : 'Disabled' }} · {{ binding.readDomains.length }} additional knowledge domains</p></div>
            <button type="button" :disabled="!!busy" @click="editBinding(binding)">Edit</button>
            <button v-if="binding.enabled" type="button" :disabled="!!busy" @click="propose({ kind: 'bindings.save', bindings: [{ ...binding, enabled: false }] })">Review disable</button>
            <button v-if="binding.enabled" type="button" :disabled="!!busy" @click="propose({ kind: 'bindings.save', bindings: [binding] })">Start fresh context</button>
          </div>
        </section>
        <details class="preview-section">
          <summary>Preview applied access for a person</summary>
          <p class="muted">Checks current membership and permissions, then shows exactly this Agent's prompt and tools. It does not call a model or execute tools.</p>
          <form class="form-grid" @submit.prevent="previewAccess">
            <label>Assigned conversation<select v-model="previewChatId" required><option value="">Select a conversation</option><option v-for="binding in botBindings.filter(item => item.enabled && item.target.kind === 'channel')" :key="binding.id" :value="binding.target.kind === 'channel' ? binding.target.channelId : ''">{{ locationLabel(binding) }}</option><option v-for="scope in dmScopes" :key="scope.sessionId" :value="scope.conversationId">{{ scope.location.name ?? 'Direct message' }}</option></select></label>
            <label>Person<select v-if="members.length" v-model="previewSender" required><option value="">Select a person</option><option v-for="member in members" :key="member.id" :value="member.id">{{ member.name }}</option></select><input v-else v-model="previewSender" required placeholder="Find a person above, or enter a user ID" /></label>
            <button :disabled="!!busy || !connected">Preview access</button>
          </form>
          <div v-if="preview" class="preview-result"><strong>{{ preview.agent }} · {{ preview.execution }}</strong><p>{{ preview.notice }}</p><p v-if="preview.newContextRequired">The next message starts a new context; earlier history is not reused.</p><p>Tools: {{ preview.tools.map(tool => toolLabel(tool.name)).join(', ') || 'None' }}</p><pre>{{ preview.systemPrompt }}</pre></div>
        </details>
      </div>

      <div v-else-if="tab === 'agents'">
        <p class="boundary-note">Agent instructions and skills are approved snapshots. The tool and knowledge selections below are the maximum a channel can receive; Markdown cannot grant more.</p>
        <div class="directory-toolbar"><label>Edit a published Agent<select :value="editingAgentId" @change="editAgent(($event.target as HTMLSelectElement).value)"><option value="">New Agent</option><option v-for="agent in overview.agents" :key="agent.id" :value="agent.id">{{ agent.displayName }}</option></select></label><button :disabled="!!busy" @click="editAgent('')">New Agent</button></div>
        <form @submit.prevent="proposeAgent">
          <fieldset :disabled="!!busy"><legend>Agent definition</legend>
            <div class="form-grid">
              <label>Display name<input v-model="agentDraft.displayName" required maxlength="100" placeholder="Customer support" /></label>
              <label>Stable name<input v-model="agentDraft.name" required pattern="[a-z][a-z0-9_-]{0,63}" :disabled="!!editingAgentId" placeholder="discord-support" /></label>
              <label>Execution<select v-model="agentDraft.execution" @change="restrictAgent"><option value="restricted">Restricted tools</option><option value="trusted">Trusted host execution</option></select></label>
              <label>Start instructions from<select @change="copyTemplate(($event.target as HTMLSelectElement).value)"><option value="">Choose an existing role</option><option v-for="template in overview.templates" :key="template.name" :value="template.name">{{ template.name }}</option></select></label>
            </div>
            <p v-if="agentDraft.execution === 'trusted'" class="access-error">Trusted execution is not a sandbox. Shell code can access host files and credentials beyond memory-domain controls. Use a private management audience and consider a separate Bot.</p>
            <label>AGENT.md<textarea v-model="agentDraft.markdown" required class="code-input" rows="12" spellcheck="false" /></label>
            <button v-if="editingAgentId" type="button" @click="loadAgentFile">Load current AGENT.md for review</button>
            <p class="muted">Use existing Agent frontmatter for model, temperature and token settings. The stable name cannot change after publication.</p>
            <h5>Maximum tool permissions</h5>
            <div class="choices"><label v-for="tool in overview.tools" :key="tool" class="check-label"><input v-model="agentDraft.tools" type="checkbox" :value="tool" :disabled="tool === 'exec' && agentDraft.execution === 'restricted'" />{{ toolLabel(tool) }}</label></div>
            <h5>Approved knowledge domains</h5>
            <div class="choices"><label v-for="domain in availableDomains" :key="domain.id" class="check-label"><input v-model="agentDraft.readDomains" type="checkbox" :value="domain.id" />{{ domain.name }}</label></div>
            <p v-if="!availableDomains.length" class="muted">Create a domain in Knowledge when this Agent needs shared reference material. It otherwise uses only conversation memory.</p>
            <h5>Approved skill instructions</h5>
            <div v-for="(skill, index) in agentDraft.skills" :key="index" class="skill-editor"><label>Skill name<input v-model="skill.name" required maxlength="100" /></label><label>Instructions<textarea v-model="skill.content" required rows="5" /></label><button type="button" @click="agentDraft.skills.splice(index, 1)">Remove skill</button></div>
            <button type="button" :disabled="agentDraft.skills.length >= 16" @click="agentDraft.skills.push({ name: '', content: '' })">Add instruction skill</button>
            <div class="form-actions"><button class="primary">Review Agent publication</button><small>Changed instructions or access start fresh contexts in affected channels.</small></div>
          </fieldset>
        </form>
      </div>

      <div v-else-if="tab === 'knowledge'">
        <p class="boundary-note"><strong>Shared only by explicit publication.</strong> A conversation cannot publish its own notes into another audience. Review the exact copy and destination below. Revoking a source does not retract an independently approved copy; revoke the publication itself.</p>
        <details v-if="botLearning.length">
          <summary>Conversation learning</summary>
          <p class="muted">Scheduled learning requires Read, Save conversation notes and Conversation-scoped learning. Each context has separate source versions and progress. Skills stay in that context; personality proposals never update global SOUL automatically. Retry paused work with /learn in an owner chat.</p>
          <div v-for="item in botLearning" :key="`${item.epoch}:${item.pipeline}`" class="saved-row">
            <div><strong>{{ domainNameFor(item.domainId) }} · {{ item.pipeline }}</strong><p>{{ item.status }} · {{ item.summary }}</p><small v-if="item.retryAt">Retry after {{ localTime(item.retryAt) }}</small></div>
          </div>
        </details>
        <form class="form-grid" @submit.prevent="propose({ kind: 'domain.create', name: domainName, domainKind })">
          <label>New domain name<input v-model="domainName" required maxlength="160" placeholder="Customer help articles" /></label>
          <label>Purpose<select v-model="domainKind"><option value="shared">Shared knowledge</option><option value="agent-private">Explicit Agent-private knowledge</option></select></label>
          <button :disabled="!!busy">Review new domain</button>
        </form>
        <p class="muted">Neither kind is public by default. Each Agent and channel needs an explicit read grant. Agent-private does not mean every conversation with the same Agent can read it.</p>
        <div v-for="domain in overview.domains.filter(item => item.kind === 'shared' || item.kind === 'agent-private')" :key="domain.id" class="saved-row"><div><strong>{{ domain.name }}</strong><p>{{ domain.kind }} · {{ domain.revoked ? 'Revoked' : 'Active' }}</p></div><button v-if="!domain.revoked" :disabled="!!busy" @click="propose({ kind: 'domain.revoke', domainId: domain.id })">Review revoke</button></div>
        <form class="publication-form" @submit.prevent="proposePublication">
          <fieldset :disabled="!!busy"><legend>Publish an approved copy</legend>
            <div class="form-grid">
              <label>Destination domain<select v-model="publicationDomain" required><option value="">Choose a domain</option><option v-for="domain in availableDomains" :key="domain.id" :value="domain.id">{{ domain.name }}</option></select></label>
              <label>Start from a saved resource<select v-model="sourceResource" @change="loadSource"><option value="">Write a new copy</option><option v-for="resource in overview.resources.filter(item => !item.revoked)" :key="resource.id" :value="resource.id">{{ resource.title }} · {{ domainNameFor(resource.domainId) }}</option></select></label>
            </div>
            <label>Title<input v-model="publicationTitle" required maxlength="200" /></label>
            <label>Resource type<select v-model="publicationKind"><option value="note">Knowledge note</option><option value="skill">Approved skill instructions</option></select></label>
            <label>Exact text to share<textarea v-model="publicationContent" required rows="10" /></label>
            <p class="muted">Read by channels you explicitly grant this domain to. Conversation notes and private source metadata are not automatically exposed.</p>
            <button class="primary" :disabled="!publicationDomain">Review knowledge publication</button>
          </fieldset>
        </form>
        <h5>Published copies</h5>
        <p v-if="!publications.length" class="muted">No knowledge has been published.</p>
        <div v-for="resource in publications" :key="resource.id" class="saved-row"><div><strong>{{ resource.title }}</strong><p>{{ domainNameFor(resource.domainId) }} · {{ resource.revoked ? 'Revoked' : 'Published' }}</p></div><button v-if="!resource.revoked" :disabled="!!busy" @click="propose({ kind: 'knowledge.revoke', resourceId: resource.id })">Review revoke</button></div>
      </div>

      <div v-else>
        <p class="boundary-note">Approval is bound to the exact content, resource permissions and configuration revision. Expired or conflicting reviews must be recreated. A model cannot approve its own change.</p>
        <p v-if="!overview.drafts.length" class="muted">No reviews yet. Propose an assignment, Agent or knowledge change, here or through an authorized chat.</p>
        <div v-for="draft in orderedDrafts" :key="draft.id" class="review-row">
          <header><div><h5>{{ changeTitle(draft.change) }}</h5><p>{{ draft.status }} · {{ localTime(draft.createdAt) }} · {{ draft.actor.kind === 'owner' ? 'Shadow owner' : 'Discord manager' }}</p></div><button @click="reviewId = reviewId === draft.id ? '' : draft.id" :aria-expanded="reviewId === draft.id">{{ reviewId === draft.id ? 'Hide review' : 'Open review' }}</button></header>
          <div v-if="reviewId === draft.id" class="review-body">
            <p class="access-notice">{{ draft.warning }}</p>
            <p>Affected assignments: {{ draft.affectedBindings.map(bindingName).join(', ') || 'None yet' }}</p>
            <template v-if="draft.change.kind === 'agent.save'"><strong>{{ draft.change.agent.displayName }} · {{ draft.change.agent.execution }}</strong><p>Tools: {{ draft.change.agent.tools.map(toolLabel).join(', ') || 'None' }}</p><p>Knowledge: {{ draft.change.agent.readDomains.map(domainNameFor).join(', ') || 'Conversation only' }}</p><pre>{{ draft.change.agent.markdown }}</pre></template>
            <template v-else-if="draft.change.kind === 'bindings.save'"><div v-for="binding in draft.change.bindings" :key="binding.id" class="review-assignment"><strong>{{ locationLabel(binding) }} → {{ agentName(binding.agentId) }}</strong><p>{{ binding.enabled ? 'Enable' : 'Disable' }} · {{ participantNames(binding) }} · {{ binding.trigger === 'all' ? 'Every message' : 'Mentions and replies' }}</p><p>Tools: {{ binding.tools.map(toolLabel).join(', ') || 'None' }}</p><p>Knowledge: {{ binding.readDomains.map(domainNameFor).join(', ') || 'Conversation only' }}</p></div></template>
            <template v-else-if="draft.change.kind === 'knowledge.publish'"><strong>{{ draft.change.title }} → {{ domainNameFor(draft.change.domainId) }}</strong><pre>{{ draft.change.content }}</pre></template>
            <details><summary>Exact reviewed data and previous configuration</summary><p>Candidate</p><pre>{{ JSON.stringify(draft.change, null, 2) }}</pre><p>Currently published</p><pre>{{ previousData(draft.change) }}</pre></details>
            <template v-if="draft.status === 'pending'"><p class="muted">Expires {{ localTime(draft.expiresAt) }}. {{ draft.baseRevision !== overview.revision ? 'Configuration changed; recreate this review.' : '' }}</p><label class="check-label"><input v-model="reviewAcknowledged" type="checkbox" />I reviewed the exact text, audience and permission changes.</label><div class="form-actions"><button class="primary" :disabled="!!busy || !reviewAcknowledged || draft.baseRevision !== overview.revision || Date.parse(draft.expiresAt) <= Date.now()" @click="commit(draft)">Approve and apply</button><button :disabled="!!busy" @click="cancel(draft)">Cancel review</button><button :disabled="!!busy" @click="propose(draft.change)">Create fresh review</button></div></template>
            <template v-else-if="draft.status === 'applying'"><p class="access-error">Approved, but application did not finish. Retry this exact approval. If an external Agent-file edit conflicts, it is preserved; abandon the interrupted review before reviewing the current file.</p><div class="form-actions"><button :disabled="!!busy" @click="commit(draft)">Retry approved change</button><button v-if="draft.change.kind === 'agent.save'" :disabled="!!busy" @click="cancel(draft)">Abandon conflicting review</button></div></template>
            <button v-else-if="draft.status === 'applied' && (draft.change.kind === 'agent.save' || draft.change.kind === 'bindings.save')" :disabled="!!busy" @click="propose(draft.change)">Review restoring this version</button>
          </div>
        </div>
        <details v-if="overview.audit.length"><summary>Applied change audit</summary><div v-for="entry in [...overview.audit].reverse()" :key="entry.id" class="audit-row">{{ localTime(entry.at) }} · {{ entry.kind }} · revision {{ entry.revision }} · {{ entry.actor }}</div></details>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { BotInstanceStatus } from '../bot-settings.ts'
import { bindingLabel, createDiscordIntegrationClient, discordIds } from '../discord-integration.ts'
import type { DiscordBinding, DiscordDirectory, DiscordMember, IntegrationAgentInput, IntegrationChange, IntegrationDraft, IntegrationOverview, IntegrationPreview } from '../../../src/channels/integration-contract.ts'
import type { MemorySource } from '../../../src/memory/contracts.ts'
import { useLiveClientPool } from '../composables/useLiveClient.ts'
import type { LiveSubscription } from '../live-client.ts'

const props = defineProps<{ apiBase: string; projectId: string; bot: BotInstanceStatus; active: boolean }>()
const uid = `discord-access-${props.bot.id}`
const pages = [{ id: 'channels', label: 'Channels & people' }, { id: 'agents', label: 'Agents' }, { id: 'knowledge', label: 'Knowledge' }, { id: 'reviews', label: 'Reviews' }] as const
const tab = ref<(typeof pages)[number]['id']>('channels')
const overview = ref<IntegrationOverview>()
const directory = ref<DiscordDirectory>()
const guilds = ref<DiscordDirectory['guilds']>([])
const guildCursor = ref<string | null>(null)
const guildId = ref('')
const busy = ref('')
const error = ref('')
const notice = ref('')
const connected = computed(() => props.bot.state === 'connected')
const locationType = ref<'channel' | 'dm'>('channel')
const channelSearch = ref('')
const channelFilter = ref('all')
const selectedChannels = ref<string[]>([])
const assignedAgentId = ref('')
const selectedTools = ref<DiscordBinding['tools']>([])
const selectedDomains = ref<string[]>([])
const everyone = ref(false)
const roleIds = ref<string[]>([])
const userIds = ref('')
const memberQuery = ref('')
const memberNotice = ref('')
const members = ref<DiscordMember[]>([])
const userNames = ref<Record<string, string>>({})
const trigger = ref<'mention' | 'all'>('mention')
const inheritThreads = ref(true)
const previewChatId = ref('')
const previewSender = ref('')
const preview = ref<IntegrationPreview>()
const editingAgentId = ref('')
const newAgent = (): IntegrationAgentInput => ({ id: crypto.randomUUID(), name: '', displayName: '', execution: 'restricted',
  tools: ['read', 'search', 'memory_save', 'learned_skill'], readDomains: [], skills: [],
  markdown: '---\ndescription: Discord assistant\ndefaultMode: session\n---\nHelp with questions in this channel using the approved knowledge. Keep customer details in conversation memory.' })
const agentDraft = ref(newAgent())
const domainName = ref('')
const domainKind = ref<'shared' | 'agent-private'>('shared')
const publicationDomain = ref('')
const sourceResource = ref('')
const publicationTitle = ref('')
const publicationContent = ref('')
const publicationSources = ref<MemorySource[]>([])
const publicationKind = ref<'note' | 'skill'>('note')
const reviewId = ref('')
const reviewAcknowledged = ref(false)
const formRevision = ref<number>()
const livePool = useLiveClientPool()
let liveSubscription: LiveSubscription | undefined
let refreshNeeded = false
let controller: AbortController | undefined
const client = () => createDiscordIntegrationClient(props.apiBase, props.projectId)
const botBindings = computed(() => overview.value?.bindings.filter(binding => binding.botInstanceId === props.bot.id) ?? [])
const botLearning = computed(() => overview.value?.learning.filter(item => item.botInstanceId === props.bot.id) ?? [])
const legacy = computed(() => overview.value?.legacy.find(item => item.botId === props.bot.id))
const assignedAgent = computed(() => overview.value?.agents.find(agent => agent.id === assignedAgentId.value))
const availableDomains = computed(() => overview.value?.domains.filter(domain => !domain.revoked && ['shared', 'agent-private'].includes(domain.kind)) ?? [])
const assignableDomains = computed(() => availableDomains.value.filter(domain => assignedAgent.value?.readDomains.includes(domain.id)))
const publications = computed(() => overview.value?.resources.filter(resource => resource.publication) ?? [])
const orderedDrafts = computed(() => [...overview.value?.drafts ?? []].reverse())
const dmScopes = computed(() => overview.value?.sessions.filter(scope => scope.botInstanceId === props.bot.id && scope.location.type === 1) ?? [])
const visibleChannels = computed(() => (directory.value?.channels ?? []).filter(channel => {
  const text = `${channel.name} ${channelParent(channel.parentId)}`.toLocaleLowerCase()
  return text.includes(channelSearch.value.toLocaleLowerCase()) &&
    (channelFilter.value === 'all' || channelFilter.value === 'assigned' && !!existingChannel(channel.id) ||
      channelFilter.value === 'unassigned' && !existingChannel(channel.id) || channelFilter.value === 'blocked' && (!channel.supported || !channel.canSend))
}))
const namedUsers = computed(() => userIds.value.split(/[\s,]+/).filter(Boolean).map(id => userNames.value[id] ?? id))
const labels: Record<string, string> = { read: 'Read scoped memory', search: 'Search scoped memory', memory_save: 'Save conversation notes',
  discord_history: 'Read current-context Discord history', discord_message_get: 'Read a Discord message', channel_config: 'Manage channel configuration',
  subagent: 'Bounded same-scope subagent', learned_skill: 'Conversation-scoped learning', exec: 'Host shell execution' }
const toolLabel = (name: string) => labels[name] ?? name
const localTime = (value: string) => new Date(value).toLocaleString()
const agentName = (id: string) => overview.value?.agents.find(agent => agent.id === id)?.displayName ?? 'Unavailable Agent'
const domainNameFor = (id: string) => overview.value?.domains.find(domain => domain.id === id)?.name ?? 'Unavailable domain'
const channelParent = (id: string | null) => directory.value?.channels.find(channel => channel.id === id)?.name ?? (id ? 'Parent channel' : 'Server channel')
const existingChannel = (id: string) => botBindings.value.find(binding => binding.target.kind === 'channel' && binding.target.channelId === id)
const locationLabel = (binding: DiscordBinding) => {
  const known = overview.value?.sessions.find(scope => scope.bindingId === binding.id && scope.conversationId === (binding.target.kind === 'channel' ? binding.target.channelId : scope.conversationId))
  return known?.location.name ?? bindingLabel(binding, directory.value?.channels ?? [])
}
const bindingName = (id: string) => { const binding = overview.value?.bindings.find(item => item.id === id); return binding ? locationLabel(binding) : 'New assignment' }
const participantNames = (binding: DiscordBinding) => binding.participants.everyone ? 'Everyone in this channel' :
  [...binding.participants.roleIds.map(id => directory.value?.roles.find(role => role.id === id)?.name ?? `Role ${id}`),
    ...binding.participants.userIds.map(id => userNames.value[id] ?? `User ${id}`)].join(', ')
const changeTitle = (change: IntegrationChange) => ({ 'agent.save': 'Publish Agent', 'bindings.save': 'Change channel assignments',
  'domain.create': 'Create knowledge domain', 'knowledge.publish': 'Publish knowledge copy', 'knowledge.revoke': 'Revoke published copy', 'domain.revoke': 'Revoke domain access' })[change.kind]

async function run(label: string, action: (signal: AbortSignal) => Promise<void>) {
  if (controller) return
  const current = new AbortController()
  controller = current; busy.value = label; error.value = ''; notice.value = ''
  try { await action(current.signal) }
  catch (cause) { if (!current.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Operation failed. Refresh before retrying.' }
  finally {
    if (controller === current) {
      controller = undefined; busy.value = ''
      if (refreshNeeded) { refreshNeeded = false; void reload() }
    }
  }
}
async function reload(manual = false) {
  let loaded = false
  await run('Loading configuration...', async signal => {
    overview.value = await client().overview(signal)
    if (manual || formRevision.value === undefined) formRevision.value = overview.value.revision
    loaded = true
  })
  return loaded
}
function invalidate() {
  preview.value = undefined; reviewAcknowledged.value = false
  if (controller) refreshNeeded = true
  else void reload()
}
async function loadDirectory(after?: string | null) {
  await run('Synchronizing Discord resources...', async signal => {
    const result = await client().directory(props.bot.id, signal, guildId.value || undefined, after ?? undefined)
    signal.throwIfAborted()
    guilds.value = [...new Map([...guilds.value, ...result.guilds].map(guild => [guild.id, guild])).values()]
    guildCursor.value = result.guildCursor
    directory.value = result
    if (!after) selectedChannels.value = []
  })
}
async function findMembers() {
  await run('Finding Discord members...', async signal => {
    const result = await client().members(props.bot.id, guildId.value, memberQuery.value, signal)
    signal.throwIfAborted(); members.value = result.members; memberNotice.value = result.notice
    for (const member of result.members) userNames.value[member.id] = member.name
  })
}
function addMember(member: DiscordMember) {
  userIds.value = locationType.value === 'dm' ? member.id : [...new Set([...userIds.value.split(/[\s,]+/).filter(Boolean), member.id])].join('\n')
  everyone.value = false; previewSender.value = member.id; userNames.value[member.id] = member.name
}
function selectAgentPermissions() {
  selectedTools.value = [...assignedAgent.value?.tools ?? []]
  selectedDomains.value = [...assignedAgent.value?.readDomains ?? []].filter(id => availableDomains.value.some(domain => domain.id === id))
}
async function propose(change: IntegrationChange) {
  await run('Validating a review...', async signal => {
    if (!overview.value) throw new Error('Refresh configuration before making a change.')
    const draft = await client().propose(change, formRevision.value ?? overview.value.revision, signal)
    overview.value = await client().overview(signal)
    reviewId.value = draft.id; reviewAcknowledged.value = false; tab.value = 'reviews'
    notice.value = 'Review created. Nothing has been applied.'
  })
}
async function proposeBindings() {
  error.value = ''
  try {
    if (!directory.value || !assignedAgent.value) throw new Error('Synchronize Discord and select a published Agent.')
    const people = discordIds(userIds.value)
    if (locationType.value === 'dm' && people.length !== 1) throw new Error('Select exactly one person for a DM assignment.')
    if (locationType.value === 'channel' && directory.value.guildId !== guildId.value) throw new Error('Synchronize this server before assigning its channels.')
    const targets: DiscordBinding['target'][] = locationType.value === 'dm'
      ? [{ kind: 'dm', userId: people[0]! }] : selectedChannels.value.map(channelId => ({ kind: 'channel', guildId: guildId.value, channelId }))
    const bindings = targets.map(target => {
      const previous = botBindings.value.find(binding => JSON.stringify(binding.target) === JSON.stringify(target))
      return { id: previous?.id ?? crypto.randomUUID(), botInstanceId: props.bot.id, botUserId: directory.value!.botUserId,
        target, enabled: true, agentId: assignedAgentId.value, trigger: trigger.value,
        participants: { everyone: locationType.value === 'channel' && everyone.value, userIds: people, roleIds: locationType.value === 'channel' ? [...roleIds.value] : [] },
        tools: [...selectedTools.value], readDomains: [...selectedDomains.value], inheritThreads: locationType.value === 'channel' && inheritThreads.value,
        manage: selectedTools.value.includes('channel_config') }
    })
    await propose({ kind: 'bindings.save', bindings })
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Check the channel assignment.' }
}
function editBinding(binding: DiscordBinding) {
  locationType.value = binding.target.kind; assignedAgentId.value = binding.agentId
  selectedChannels.value = binding.target.kind === 'channel' ? [binding.target.channelId] : []
  if (binding.target.kind === 'channel') guildId.value = binding.target.guildId
  selectedTools.value = [...binding.tools]; selectedDomains.value = binding.readDomains.filter(id => availableDomains.value.some(domain => domain.id === id))
  everyone.value = binding.participants.everyone; roleIds.value = [...binding.participants.roleIds]; userIds.value = binding.participants.userIds.join('\n')
  trigger.value = binding.trigger; inheritThreads.value = binding.inheritThreads
  notice.value = 'Editing this assignment. Synchronize its server if the directory is not loaded, then select its channel again.'
}
function prepareLegacy(id: string) {
  locationType.value = 'channel'; selectedChannels.value = [id]; everyone.value = false; roleIds.value = []
  const users = props.bot.config.allowFrom
  userIds.value = Array.isArray(users) ? users.join('\n') : ''
  notice.value = 'Legacy location selected. Choose an approved Agent and explicit users or roles; old administrative privileges were not copied.'
}
function editAgent(id: string) {
  editingAgentId.value = id
  const agent = overview.value?.agents.find(agent => agent.id === id)
  agentDraft.value = agent ? { id: agent.id, name: agent.name, displayName: agent.displayName, markdown: agent.markdown,
    execution: agent.execution, tools: [...agent.tools], readDomains: agent.readDomains.filter(id => availableDomains.value.some(domain => domain.id === id)), skills: agent.skills.map(skill => ({ ...skill })) } : newAgent()
}
async function loadAgentFile() {
  await run('Loading current Agent file for review...', async signal => {
    const result = await client().agentFile(editingAgentId.value, signal)
    agentDraft.value.markdown = result.markdown
    notice.value = 'Current file loaded into the draft. Its text and permissions are not deployed until you review and approve.'
  })
}
function restrictAgent() { if (agentDraft.value.execution === 'restricted') agentDraft.value.tools = agentDraft.value.tools.filter(tool => tool !== 'exec') }
function copyTemplate(name: string) {
  const template = overview.value?.templates.find(template => template.name === name)
  if (template) agentDraft.value.markdown = `---\ndescription: ${JSON.stringify(template.description)}\ndefaultMode: session\n${template.model ? `model: ${JSON.stringify(template.model)}\n` : ''}---\n${template.prompt}`
}
async function proposeAgent() { await propose({ kind: 'agent.save', agent: { ...agentDraft.value, tools: [...agentDraft.value.tools], readDomains: [...agentDraft.value.readDomains], skills: agentDraft.value.skills.map(skill => ({ ...skill })) } }) }
async function loadSource() {
  publicationSources.value = []
  if (!sourceResource.value) { publicationTitle.value = ''; publicationContent.value = ''; publicationKind.value = 'note'; return }
  await run('Loading the publication source...', async signal => {
    const { resource, content } = await client().resource(sourceResource.value, signal)
    const domain = overview.value?.domains.find(domain => domain.id === resource.domainId)
    if (!domain || domain.revoked || resource.revoked) throw new Error('Source is revoked or unavailable. Refresh and choose another source.')
    publicationTitle.value = resource.title; publicationContent.value = content
    publicationKind.value = resource.kind === 'skill' ? 'skill' : 'note'
    publicationSources.value = [{ domain: { id: domain.id, revision: domain.revision }, resourceId: resource.id, version: resource.version }]
  })
}
async function proposePublication() { await propose({ kind: 'knowledge.publish', domainId: publicationDomain.value, title: publicationTitle.value, content: publicationContent.value, sources: [...publicationSources.value], resourceKind: publicationKind.value }) }
async function previewAccess() {
  await run('Checking effective channel access...', async signal => { preview.value = undefined; preview.value = await client().preview(props.bot.id, previewChatId.value, previewSender.value, signal) })
}
async function commit(draft: IntegrationDraft) {
  await run('Applying the reviewed change...', async signal => {
    await client().commit(draft.id, draft.hash, signal)
    overview.value = await client().overview(signal); reviewAcknowledged.value = false; formRevision.value = overview.value.revision
    notice.value = 'Reviewed change applied. Affected conversations start a fresh context on their next message.'
  })
}
async function cancel(draft: IntegrationDraft) {
  await run('Cancelling review...', async signal => { await client().cancel(draft.id, signal); overview.value = await client().overview(signal); reviewAcknowledged.value = false })
}
function previousData(change: IntegrationChange) {
  return JSON.stringify(change.kind === 'agent.save' ? overview.value?.agents.find(agent => agent.id === change.agent.id) ?? null
    : change.kind === 'bindings.save' ? overview.value?.bindings.filter(binding => change.bindings.some(next => next.id === binding.id))
      : change.kind === 'knowledge.revoke' ? overview.value?.resources.find(resource => resource.id === change.resourceId)
        : 'No existing object is overwritten by this operation.', null, 2)
}
watch(reviewId, () => { reviewAcknowledged.value = false })
watch(() => [props.apiBase, props.projectId, props.bot.id, props.active], async () => {
  liveSubscription?.close(); liveSubscription = undefined; refreshNeeded = false; formRevision.value = undefined
  controller?.abort(); controller = undefined; busy.value = ''
  overview.value = undefined; directory.value = undefined; guilds.value = []; guildId.value = ''; guildCursor.value = null
  selectedChannels.value = []; members.value = []; userNames.value = {}; preview.value = undefined; error.value = ''; notice.value = ''
  tab.value = 'channels'; channelSearch.value = ''; channelFilter.value = 'all'; assignedAgentId.value = ''
  selectedTools.value = []; selectedDomains.value = []; everyone.value = false; roleIds.value = []; userIds.value = ''
  memberQuery.value = ''; memberNotice.value = ''; previewChatId.value = ''; previewSender.value = ''
  editingAgentId.value = ''; agentDraft.value = newAgent(); sourceResource.value = ''; publicationSources.value = []
  publicationTitle.value = ''; publicationContent.value = ''; publicationDomain.value = ''; publicationKind.value = 'note'; domainName.value = ''
  reviewId.value = ''; reviewAcknowledged.value = false
  if (!props.active) return
  liveSubscription = livePool.client(props.apiBase).subscribe({ kind: 'integrations', projectId: props.projectId }, {
    event: invalidate, reset: invalidate, reconnected: invalidate,
  })
  const loaded = await reload()
  if (props.active && connected.value && loaded) await loadDirectory()
}, { immediate: true })
onBeforeUnmount(() => { liveSubscription?.close(); controller?.abort() })
</script>

<style scoped>
.discord-access { margin-top: 24px; padding: 24px 0 8px; border-top: 1px solid var(--c-border); color: var(--c-text); font-size: 13px; line-height: 1.6; min-width: 0; }
.access-heading, .review-row header { display: flex; flex-wrap: wrap; align-items: start; justify-content: space-between; gap: 16px; }
h4 { font-size: 16px; margin: 0 0 6px; font-weight: 600; }
h5, legend { font-size: 14px; font-weight: 600; margin: 24px 0 10px; }
p { margin: 8px 0 14px; max-width: 74ch; overflow-wrap: anywhere; }
.access-heading p, .muted, small { color: var(--c-text-secondary); }
.access-nav { display: flex; flex-wrap: wrap; gap: 4px; margin: 24px 0; border-bottom: 1px solid var(--c-border); }
.access-nav button { border: 0; border-bottom: 2px solid transparent; background: transparent; }
.access-nav button[aria-current="page"] { border-bottom-color: var(--c-primary); color: var(--c-primary); }
.boundary-note { padding: 16px; background: var(--c-bg-soft); border: 1px solid var(--c-border); margin: 0 0 24px; max-width: 86ch; }
.access-error { color: var(--c-error); }
.access-notice { color: var(--c-text-secondary); }
.directory-toolbar { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin: 16px 0; }
.directory-toolbar label { flex: 1 1 220px; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: end; }
label:not(.check-label):not(.picker-row) { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
legend { padding: 0; margin-bottom: 14px; }
input:not([type="checkbox"]), select, textarea { width: 100%; box-sizing: border-box; min-width: 0; font: inherit; color: var(--c-text); background: var(--c-bg-input); border: 1px solid var(--c-border); border-radius: var(--radius-control); padding: 9px 10px; }
input::placeholder, textarea::placeholder { color: var(--c-text-secondary); opacity: 1; }
textarea { resize: vertical; }
input[type="checkbox"] { flex-shrink: 0; width: 16px; height: 16px; margin: 0; accent-color: var(--c-primary-bg); }
.check-label { display: inline-flex; align-items: center; gap: 8px; min-height: 32px; }
.choices { display: flex; flex-wrap: wrap; gap: 8px 20px; }
.search-field { margin: 20px 0 10px; max-width: 500px; }
.channel-picker { max-height: 340px; overflow: auto; border-top: 1px solid var(--c-border); }
.picker-row { display: flex; align-items: center; gap: 12px; padding: 10px 6px; border-bottom: 1px solid var(--c-border); cursor: pointer; }
.picker-row > span:first-of-type { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.picker-row small { display: block; }
.picker-row:has(input:checked) { background: var(--c-selection-bg); }
.row-status { color: var(--c-text-secondary); font-size: 12px; max-width: 35%; text-align: right; }
.form-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin: 24px 0; }
button { min-height: 36px; padding: 8px 12px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-soft); color: var(--c-text); font: inherit; font-weight: 500; cursor: pointer; }
button:hover:not(:disabled) { background: var(--c-bg-muted); }
button.primary { background: var(--c-primary-bg); color: var(--c-text-on-primary); }
button.primary:hover:not(:disabled) { background: var(--c-primary-bg-hover); }
button:disabled { opacity: .55; cursor: not-allowed; }
.text-button { padding: 0; min-height: 0; border: 0; background: transparent; color: var(--c-primary); text-decoration: underline; }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.saved-section, .preview-section, .publication-form { margin-top: 32px; }
.saved-row { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; border-top: 1px solid var(--c-border); padding: 14px 0; }
.saved-row > div { flex: 1 1 220px; min-width: 0; }
.saved-row p { margin: 4px 0 0; color: var(--c-text-secondary); font-size: 12px; }
details { margin: 16px 0; }
summary { cursor: pointer; padding: 6px 0; }
details label { margin-top: 12px; }
.code-input, pre { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; }
pre { padding: 14px; background: var(--c-bg-soft); border: 1px solid var(--c-border); overflow: auto; max-height: 440px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
.skill-editor { display: grid; gap: 12px; margin-bottom: 20px; }
.skill-editor button { justify-self: start; }
.review-row { border-top: 1px solid var(--c-border); padding: 18px 0; }
.review-row h5 { margin: 0; }
.review-row header p { margin: 4px 0 0; color: var(--c-text-secondary); }
.review-body { margin-top: 20px; }
.review-assignment { padding: 12px 0; }
.review-assignment p { margin: 4px 0; }
.audit-row { padding: 8px 0; overflow-wrap: anywhere; }
@media (max-width: 700px) {
  .form-grid { grid-template-columns: minmax(0, 1fr); }
  .access-heading { flex-direction: column; }
  button, .check-label { min-height: 44px; }
  input:not([type="checkbox"]), select, textarea { font-size: 16px; }
  .picker-row { gap: 8px; }
  .row-status { max-width: 30%; }
}
</style>
