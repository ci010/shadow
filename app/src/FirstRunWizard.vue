<template>
	<main class="setup-shell">
		<section class="setup-panel" aria-labelledby="setup-title">
			<header class="setup-header">
				<img class="brand-mark" :src="shadowLogo" alt="" aria-hidden="true" draggable="false">
				<div>
					<h1 id="setup-title">{{ heading }}</h1>
				</div>
				<span v-if="state?.mode === 'main'" class="step-count">{{ progressLabel }}</span>
			</header>

			<div v-if="state?.mode === 'main'" class="progress-track" aria-hidden="true">
				<span :style="{ width: `${progressPercent}%` }" />
			</div>

			<div v-if="loadError" class="notice error-notice" role="alert">
				<strong>Setup could not be loaded.</strong>
				<span>Check the desktop connection, then try again.</span>
				<button class="secondary-button" :disabled="busy" @click="emit('retry-load')">Retry</button>
			</div>

			<template v-else-if="state">
				<div v-if="showRoleChoice" class="setup-content">
					<p class="lead">Choose how this computer will participate.</p>
					<div class="role-list" role="radiogroup" aria-label="Computer role">
						<button
							class="role-option"
							:class="{ selected: selectedRole === 'main' }"
							role="radio"
							:aria-checked="selectedRole === 'main'"
							:disabled="busy"
							@click="selectedRole = 'main'"
						>
							<span class="role-icon" aria-hidden="true">
								<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="7" rx="1"/><rect x="4" y="14" width="16" height="7" rx="1"/><path d="M8 6.5h.01M8 17.5h.01"/></svg>
							</span>
							<span><strong>Main</strong><small>Runs the workspace and coordinates connected computers.</small></span>
						</button>
						<button
							class="role-option"
							:class="{ selected: selectedRole === 'child' }"
							role="radio"
							:aria-checked="selectedRole === 'child'"
							:disabled="busy"
							@click="selectedRole = 'child'"
						>
							<span class="role-icon" aria-hidden="true">
								<svg viewBox="0 0 24 24"><rect x="5" y="2.5" width="14" height="19" rx="2"/><path d="M9 18h6"/></svg>
							</span>
							<span><strong>Child</strong><small>Runs remote tasks for an existing Main. You review execution access before pairing.</small></span>
						</button>
					</div>
					<div class="actions">
						<button class="primary-button" :disabled="busy || !selectedRole" @click="chooseRole">
							{{ busy ? 'Saving…' : selectedRole === 'child' ? 'Continue as Child' : 'Continue as Main' }}
						</button>
					</div>
				</div>

				<div v-else-if="state.mode === 'child'" class="setup-content">
					<p class="lead">On Main, open Nodes and copy a pairing invitation. Paste it here, then approve this device on Main.</p>
					<div v-if="childFingerprint" class="notice" role="status">
						<strong>This device's fingerprint</strong><code class="pairing-fingerprint">{{ childFingerprint }}</code>
						<span>If Main already shows this pending device, compare this fingerprint, approve it there, then retry here. Retrying keeps the same identity even if the first response was lost.</span>
					</div>
					<form class="child-form" @submit.prevent="pairChild">
						<template v-if="!manualPairing">
							<label class="field-label" for="child-invitation">Pairing invitation</label>
							<textarea id="child-invitation" v-model="invitationText" class="directory-input invitation-input" rows="3" placeholder="Paste the invitation copied from Main" required :disabled="busy" autocomplete="off" spellcheck="false" aria-describedby="child-invitation-help" :aria-invalid="!!invitationPreview.error"></textarea>
							<p id="child-invitation-help" class="field-help" :role="invitationPreview.error ? 'alert' : undefined">{{ invitationPreview.error || (invitationPreview.endpoint ? `Main: ${invitationPreview.endpoint}` : 'One paste includes Main’s address and pairing details. Keep the invitation private.') }}</p>
						</template>
						<template v-else>
							<label class="field-label" for="child-endpoint">Main device endpoint</label>
							<input id="child-endpoint" v-model="child.endpoint" class="directory-input" type="url" placeholder="http://192.168.1.10:3124" required :disabled="busy" autocomplete="off">
							<div class="child-fields">
								<div><label class="field-label" for="child-offer">Offer ID</label><input id="child-offer" v-model="child.offerId" class="directory-input" required :disabled="busy" autocomplete="off"></div>
								<div><label class="field-label" for="child-pin">Six-digit PIN</label><input id="child-pin" v-model="child.pin" class="directory-input" type="password" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required :disabled="busy" autocomplete="off"></div>
							</div>
						</template>
						<button type="button" class="secondary-button" :disabled="busy" @click="togglePairingMode">{{ manualPairing ? 'Paste invitation instead' : 'Enter details manually' }}</button>
						<label class="consent-row"><input v-model="child.allowInsecureLocalTransport" type="checkbox" :disabled="busy"><span>Use HTTP on a trusted LAN/VPN for testing only. Traffic and the PIN are not encrypted. Never use this on the public internet; device authentication remains required.</span></label>
						<label class="field-label" for="child-name">Device name</label>
						<input id="child-name" v-model="child.displayName" class="directory-input" required maxlength="128" :disabled="busy">
						<label class="field-label" for="child-home">Child home — protected identity and managed session data</label>
						<div class="directory-field"><input id="child-home" v-model="child.dataDir" class="directory-input" required :disabled="busy || childSaved"><button type="button" class="secondary-button" :disabled="busy || childSaved" @click="pickChildFolder('dataDir')">Browse…</button></div>
						<label class="field-label" for="child-workdir">Shared work folder — files, Git and commands</label>
						<div class="directory-field"><input id="child-workdir" v-model="child.workdir" class="directory-input" required :disabled="busy"><button type="button" class="secondary-button" :disabled="busy" @click="pickChildFolder('workdir')">Browse…</button></div>
						<p class="field-help">Use separate folders, not a drive root. Child home stays fixed after the first attempt so retries retain this device's identity. You can correct the endpoint and work folder until pairing succeeds. No existing data is moved or deleted.</p>
						<label class="consent-row"><input v-model="executionConsent" type="checkbox" :disabled="busy" required><span>I allow the approved Main to read/write the work folder, create managed workdirs under Child home, and execute commands as my OS account. <strong>Shell access is not a sandbox and can access other host files.</strong> Pair only with a Main you trust with this access.</span></label>
						<div class="actions"><button class="primary-button" type="submit" :disabled="busy || !executionConsent">{{ busy ? 'Submitting pairing request…' : 'Pair and open local status' }}</button></div>
					</form>
				</div>

				<div v-else-if="state.step === 'choose-data-directory'" class="setup-content">
					<p class="lead">Choose where Main should keep its configuration and workspace data.</p>
					<label class="field-label" for="main-directory">Main directory</label>
					<div class="directory-field">
						<input
							id="main-directory"
							v-model="directoryPath"
							class="directory-input"
							type="text"
							:disabled="busy"
							:readonly="!api.selectMainDirectoryPath"
							placeholder="Enter a full directory path"
							aria-describedby="main-directory-help"
							autocomplete="off"
							spellcheck="false"
							@keydown.enter="commitDirectory"
						>
						<button class="secondary-button" :disabled="busy" @click="pickDirectory">Browse…</button>
					</div>
					<p id="main-directory-help" class="field-help">Accept this location, edit the full path, or browse for another folder. Shadow creates the folder when you save. Existing data is not moved or deleted.</p>
					<div class="actions">
						<button class="primary-button" :disabled="busy || (!directoryPath.trim() && !directorySelection)" @click="commitDirectory">
							{{ busy ? 'Saving…' : 'Use this directory' }}
						</button>
					</div>
				</div>

				<div v-else-if="state.step === 'initialize-main'" class="setup-content">
					<p class="lead">Create the initial Main configuration in the selected directory.</p>
					<div class="summary-row"><span>Configuration</span><strong>Ready to initialize</strong></div>
					<div class="actions">
						<button class="primary-button" :disabled="busy" @click="initializeMain">
							{{ busy ? 'Initializing…' : 'Initialize Main' }}
						</button>
					</div>
				</div>

				<div v-else-if="state.step === 'configure-provider'" class="setup-content">
					<p class="lead">After Main launches, choose and connect a model provider in the app before your first chat.</p>
					<ul class="provider-options">
						<li><strong>GitHub Copilot</strong> — sign in with your GitHub account using a device code.</li>
						<li><strong>API key or local provider</strong> — use another supported provider or your own local endpoint.</li>
					</ul>
					<div class="actions">
						<button class="primary-button" :disabled="busy" @click="configureProvider">
							{{ busy ? 'Saving…' : 'Continue' }}
						</button>
					</div>
				</div>

				<div v-else-if="state.step === 'choose-local-capabilities'" class="setup-content">
					<p class="lead">Choose whether this computer may execute approved local tools.</p>
					<label class="toggle-row">
						<span><strong>Local executor</strong><small>Run approved commands and tools on this computer.</small></span>
						<input v-model="localExecutor" type="checkbox" role="switch" :disabled="busy">
					</label>
					<div class="actions">
						<button class="primary-button" :disabled="busy" @click="saveCapabilities">
							{{ busy ? 'Saving…' : 'Continue' }}
						</button>
					</div>
				</div>

				<div v-else-if="state.step === 'launch-main'" class="setup-content">
					<p class="lead">Launch Main, then connect your model provider in the app.</p>
					<div class="launch-summary">
						<div><span>Role</span><strong>Main</strong></div>
						<div><span>Provider setup</span><strong>After launch</strong></div>
						<div><span>Local executor</span><strong>{{ localExecutor ? 'Enabled' : 'Disabled' }}</strong></div>
					</div>
					<div class="actions">
						<button class="primary-button" :disabled="busy" @click="launchMain">
							{{ busy ? 'Launching…' : 'Launch Main' }}
						</button>
					</div>
				</div>

				<div v-if="actionError" class="notice error-notice action-error" role="alert">
					<strong>{{ actionError }}</strong>
					<span>Your setup progress is saved. Retry this step when ready.</span>
				</div>
			</template>
		</section>
	</main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import shadowLogo from './assets/shadow-logo.png'
import { decodeChildInvitation } from './device-pairing-invitation.ts'
import {
	commitMainDirectoryChoice,
	loadMainDirectorySelection,
	MAIN_LAUNCH_PORT,
	type NativeDirectorySelection,
	type ShadowDesktopApi,
	type WizardState,
} from './desktop-bootstrap.ts'

const LOCAL_EXECUTOR_KEY = 'shadow.bootstrap.local-executor'

function loadLocalExecutorChoice(): boolean {
	try {
		return window.localStorage.getItem(LOCAL_EXECUTOR_KEY) !== 'false'
	} catch {
		return true
	}
}

const props = defineProps<{
	api: ShadowDesktopApi
	initialState: WizardState | null
	loadError?: boolean
}>()

const emit = defineEmits<{
	complete: []
	'retry-load': []
}>()

const state = ref(props.initialState)
const selectedRole = ref<'main' | 'child' | null>(null)
const directorySelection = ref<NativeDirectorySelection | null>(null)
const directoryPath = ref('')
const localExecutor = ref(loadLocalExecutorChoice())
const busy = ref(false)
const actionError = ref('')
const executionConsent = ref(false)
const childSaved = ref(false)
const childFingerprint = ref('')
const manualPairing = ref(false)
const invitationText = ref('')
const invitationPreview = computed(() => {
	if (!invitationText.value.trim()) return { endpoint: '', error: '' }
	try { return { endpoint: decodeChildInvitation(invitationText.value).endpoint, error: '' } }
	catch (error) { return { endpoint: '', error: error instanceof Error ? error.message : 'Invalid Child invitation.' } }
})
const child = ref({ endpoint: '', offerId: '', pin: '', displayName: '', dataDir: '', workdir: '', allowInsecureLocalTransport: false })

function togglePairingMode() {
	manualPairing.value = !manualPairing.value
	invitationText.value = ''
	child.value.offerId = ''
	child.value.pin = ''
	actionError.value = ''
}

const mainSteps = ['choose-data-directory', 'initialize-main', 'configure-provider', 'choose-local-capabilities', 'launch-main'] as const
const showRoleChoice = computed(() => state.value?.mode === null)
const currentStepIndex = computed(() => state.value?.mode === 'main' ? mainSteps.indexOf(state.value.step as typeof mainSteps[number]) : -1)
const progressLabel = computed(() => `Step ${Math.max(1, currentStepIndex.value + 1)} of ${mainSteps.length}`)
const progressPercent = computed(() => Math.max(0, ((currentStepIndex.value + 1) / mainSteps.length) * 100))
const heading = computed(() => {
	if (props.loadError) return 'Connect to desktop'
	if (state.value?.mode === null) return 'Set up this computer'
	if (state.value?.mode === 'child') return 'Child setup'
	const titles: Partial<Record<string, string>> = {
		'choose-data-directory': 'Choose Main directory',
		'initialize-main': 'Initialize Main',
		'configure-provider': 'Connect a provider after launch',
		'choose-local-capabilities': 'Local capabilities',
		'launch-main': 'Ready to launch',
	}
	return titles[state.value?.step ?? ''] ?? 'Set up Main'
})

async function run(
	operation: () => Promise<WizardState>,
	failureMessage = 'This step could not be completed.',
): Promise<void> {
	busy.value = true
	actionError.value = ''
	try {
		state.value = await operation()
	} catch {
		actionError.value = failureMessage
	} finally {
		busy.value = false
	}
}

async function chooseRole(): Promise<void> {
	if (!selectedRole.value) return
	await run(() => props.api.bootstrap.dispatch({ type: 'select-role', mode: selectedRole.value! }))
	await loadDirectory()
	await loadChild()
}

async function loadChild(): Promise<void> {
	if (state.value?.mode !== 'child') return
	try {
		if (!props.api.bootstrap.childSetup) throw new Error('unsupported')
		const info = await props.api.bootstrap.childSetup()
		child.value = { ...child.value, endpoint: info.endpoint, dataDir: info.dataDir,
			workdir: info.workdir, displayName: child.value.displayName || info.displayName, allowInsecureLocalTransport: info.allowInsecureLocalTransport }
		childSaved.value = info.saved
		childFingerprint.value = info.fingerprint ?? ''
	} catch { actionError.value = 'Child settings could not be loaded. Restart Shadow and retry; existing identity data is retained.' }
}

async function pickChildFolder(field: 'dataDir' | 'workdir'): Promise<void> {
	try {
		const path = await props.api.folders?.selectDirectory()
		if (path) child.value[field] = path
	} catch { actionError.value = 'The directory picker failed. Enter a full absolute path or retry Browse.' }
}

async function pairChild(): Promise<void> {
	if (busy.value || !executionConsent.value) return
	busy.value = true
	actionError.value = ''
	try {
		if (!props.api.bootstrap.pairChild) throw new Error('Child pairing requires a current desktop build.')
		const invitation = manualPairing.value ? child.value : decodeChildInvitation(invitationText.value)
		const result = await props.api.bootstrap.pairChild({ ...child.value,
			endpoint: invitation.endpoint, offerId: invitation.offerId, pin: invitation.pin, executionConsent: true })
		if (!result.ok) throw new Error('Child setup could not be saved. Retry this step.')
		state.value = result.state
		emit('complete')
	} catch (error) {
		actionError.value = error instanceof Error ? error.message : 'Pairing failed. Check Main and retry.'
		await loadChild()
	} finally {
		child.value.pin = ''
		invitationText.value = ''
		busy.value = false
	}
}
function useDirectorySelection(selection: NativeDirectorySelection): void {
	directorySelection.value = selection
	directoryPath.value = selection.displayPath ?? selection.displayName
}

async function loadDirectory(): Promise<void> {
	if (state.value?.mode !== 'main' || state.value.step !== 'choose-data-directory') return
	busy.value = true
	try {
		const selection = await loadMainDirectorySelection(props.api, directorySelection.value)
		if (selection) useDirectorySelection(selection)
	} catch {
		actionError.value = 'The saved or default directory could not be loaded. Enter a full path, or browse for a writable folder.'
	} finally {
		busy.value = false
	}
}

onMounted(async () => { await loadDirectory(); await loadChild() })

async function pickDirectory(): Promise<void> {
	actionError.value = ''
	busy.value = true
	try {
		const selection = await props.api.selectDirectory()
		if (selection) useDirectorySelection(selection)
	} catch {
		actionError.value = 'The directory picker could not be opened. Enter a full path above, or try Browse again.'
	} finally {
		busy.value = false
	}
}

async function commitDirectory(): Promise<void> {
	if (busy.value || (!directoryPath.value.trim() && !directorySelection.value)) return
	await run(async () => {
		const result = await commitMainDirectoryChoice(props.api, directoryPath.value, directorySelection.value)
		if (!result.ok) throw new Error('command failed')
		directorySelection.value = null
		return result.state
	}, 'Main directory could not be saved. Enter a full absolute path to a writable folder, check its permissions and available disk space, then retry.')
}

async function initializeMain(): Promise<void> {
	await run(async () => {
		const result = await props.api.bootstrap.initializeMain()
		if (!result.ok) throw new Error('command failed')
		return result.state
	}, 'Main could not be initialized. Check that the selected folder is writable and has free space. If it already contains a configuration, keep it intact and check its compatibility before retrying.')
}

async function configureProvider(): Promise<void> {
	await run(() => props.api.bootstrap.dispatch({ type: 'provider-configured' }))
}

async function saveCapabilities(): Promise<void> {
	await run(async () => {
		const next = await props.api.bootstrap.dispatch({ type: 'local-capabilities-selected' })
		try {
			window.localStorage.setItem(LOCAL_EXECUTOR_KEY, String(localExecutor.value))
		} catch {
			// The current launch can still use the in-memory choice.
		}
		return next
	})
}

async function launchMain(): Promise<void> {
	await run(async () => {
		const result = await props.api.bootstrap.launchMain({ localExecutor: localExecutor.value, port: MAIN_LAUNCH_PORT })
		if (!result.ok) throw new Error('command failed')
		return result.state
	}, 'Main could not launch. Check that port 43123 is available, then retry.')
	if (state.value?.step === 'complete') emit('complete')
}
</script>

<style scoped>
.setup-shell {
	--ink: var(--c-text);
	--muted: var(--c-text-muted);
	--line: var(--c-border);
	--accent: var(--c-primary-bg);
	--accent-dark: var(--c-primary-bg-hover);
	min-height: 100%;
	display: grid;
	place-items: center;
	padding: 32px;
	color: var(--ink);
	background: var(--c-bg);
	font-family: inherit;
}
.setup-panel { width: min(700px, 100%); min-height: 470px; padding: 34px 38px; border: 1px solid var(--line); border-radius: var(--radius-overlay); background: var(--c-bg-card); }
.setup-header { display: grid; grid-template-columns: 44px 1fr auto; gap: 14px; align-items: center; }
.brand-mark { width: 44px; height: 44px; display: block; object-fit: contain; }
h1 { margin: 0; font-size: 24px; font-weight: 600; line-height: 1.2; }
.step-count { color: var(--muted); font-size: 12px; }
.progress-track { height: 3px; margin: 22px 0 30px; overflow: hidden; background: var(--c-bg-muted); }
.progress-track span { display: block; height: 100%; background: var(--accent); }
.setup-content { margin-top: 30px; animation: enter .22s ease-out; }
.invitation-input { box-sizing: border-box; width: 100%; resize: vertical; font: inherit; }
.progress-track + .setup-content { margin-top: 0; }
.lead { max-width: 65ch; margin: 0 0 24px; color: var(--c-text-secondary); font-size: 15px; line-height: 1.55; }
.role-list { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.role-option { display: grid; grid-template-columns: 38px 1fr; gap: 12px; min-height: 108px; padding: 16px; text-align: left; color: var(--ink); border: 1px solid var(--line); border-radius: var(--radius-surface); background: var(--c-bg-input); cursor: pointer; }
.role-option:hover { border-color: var(--c-border-hover); }
.role-option.selected { border-color: var(--accent); background: var(--c-bg-muted); }
.role-icon { width: 36px; height: 36px; display: grid; place-items: center; border-radius: var(--radius-control); background: var(--c-bg-muted); }
.role-icon svg { width: 20px; fill: none; stroke: currentColor; stroke-width: 1.7; }
.role-option strong, .role-option small { display: block; }
.role-option strong { margin: 2px 0 6px; font-size: 15px; }
.role-option small { color: var(--muted); font-size: 12px; line-height: 1.4; }
.actions { display: flex; justify-content: flex-end; margin-top: 26px; }
button { font: inherit; }
.primary-button, .secondary-button { min-height: 40px; padding: 0 18px; border-radius: var(--radius-control); font-size: 13px; font-weight: 650; cursor: pointer; }
.primary-button { color: var(--c-text-on-primary); border: 1px solid var(--accent); background: var(--accent); }
.primary-button:hover:not(:disabled) { background: var(--accent-dark); }
.primary-button:disabled, button:disabled { cursor: not-allowed; opacity: .52; }
.secondary-button { align-self: start; color: var(--ink); border: 1px solid var(--c-control-border); background: var(--c-bg-input); }
.notice { display: grid; gap: 5px; padding: 14px 16px; border-radius: var(--radius-surface); font-size: 13px; line-height: 1.45; }
.notice span { color: var(--c-text-secondary); }
.error-notice { margin-top: 30px; border: 1px solid var(--c-error); background: var(--c-error-bg); color: var(--c-error); }
.error-notice .secondary-button { margin-top: 8px; }
.action-error { margin-top: 20px; }
.field-label { display: block; margin-bottom: 8px; font-size: 12px; font-weight: 700; }
.directory-field { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: start; }
.directory-input { min-width: 0; width: 100%; min-height: 40px; padding: 8px 10px; color: var(--ink); border: 1px solid var(--c-control-border); border-radius: var(--radius-control); background: var(--c-bg-input); font: inherit; font-size: 13px; }
.directory-input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.directory-input:disabled { color: var(--muted); background: var(--c-bg-muted); }
.field-help { margin: 8px 0 0; color: var(--muted); font-size: 12px; line-height: 1.45; }
.summary-row, .toggle-row { display: flex; justify-content: space-between; gap: 20px; align-items: center; min-height: 62px; padding: 0 16px; border: 1px solid var(--line); border-radius: var(--radius-surface); background: var(--c-bg-soft); font-size: 13px; }
.summary-row span, .launch-summary span { color: var(--muted); }
.provider-options { margin: 0; padding-left: 20px; color: var(--c-text-secondary); font-size: 14px; line-height: 1.55; }
.provider-options li + li { margin-top: 12px; }
input[type="checkbox"] { accent-color: var(--accent); }
.toggle-row span strong, .toggle-row span small { display: block; }
.toggle-row span small { margin-top: 4px; color: var(--muted); font-size: 12px; }
.toggle-row input[role="switch"] { width: 38px; height: 20px; }
.launch-summary { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid var(--line); border-radius: var(--radius-surface); overflow: hidden; }
.launch-summary div { display: grid; gap: 6px; padding: 14px 16px; border-right: 1px solid var(--line); font-size: 12px; }
.launch-summary div:last-child { border-right: 0; }
@keyframes enter { from { opacity: 0; transform: translateY(4px); } }
@media (max-width: 620px) {
	.setup-shell { place-items: start center; padding: 16px; }
	.setup-panel { min-height: 0; padding: 24px 20px; }
	.setup-header { grid-template-columns: 40px 1fr; }
	.step-count { grid-column: 2; }
	.role-list, .launch-summary { grid-template-columns: 1fr; }
	.role-option { min-height: 88px; }
	.launch-summary div { border-right: 0; border-bottom: 1px solid var(--line); }
	.launch-summary div:last-child { border-bottom: 0; }
}
@media (prefers-reduced-motion: reduce) { .setup-content { animation: none; } }
.child-form > .field-label { margin-top: 18px; }
.pairing-fingerprint { overflow-wrap: anywhere; user-select: all; }
.child-fields { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 12px; margin-top: 18px; }
.consent-row { display: flex; align-items: flex-start; gap: 10px; margin-top: 16px; font-size: 13px; line-height: 1.5; }
.consent-row input { flex-shrink: 0; margin-top: 4px; }
@media (max-width: 620px) { .child-fields { grid-template-columns: 1fr; } }
</style>