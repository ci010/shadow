<template>
	<main class="setup-shell">
		<section class="setup-panel" aria-labelledby="setup-title">
			<header class="setup-header">
				<img class="brand-mark" :src="shadowLogo" alt="" aria-hidden="true" draggable="false">
				<div>
					<h1 id="setup-title">{{ heading }}</h1>
				</div>
				<span v-if="state && state.mode !== 'child'" class="step-count">{{ progressLabel }}</span>
			</header>

			<div v-if="state && state.mode !== 'child'" class="progress-track" aria-hidden="true">
				<span :style="{ width: `${progressPercent}%` }" />
			</div>

			<div v-if="loadError" class="notice error-notice" role="alert">
				<strong>{{ t('Setup could not be loaded.') }}</strong>
				<span>{{ t('Check the desktop connection, then try again.') }}</span>
				<button class="secondary-button" :disabled="busy" @click="emit('retry-load')">{{ t('Retry') }}</button>
			</div>

			<template v-else-if="state">
				<div v-if="showRoleChoice" class="setup-content">
					<p class="lead">{{ t('Connect a model service and start chatting. Recommended settings are already selected.') }}</p>
					<p class="field-help">{{ t('Your data folder is set up automatically. You can choose a different location in advanced settings.') }}</p>
					<details class="advanced-setup">
						<summary>{{ t('Advanced settings (optional)') }}</summary>
						<div class="role-list" role="radiogroup" :aria-label="t('Computer role')">
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
								<span><strong>{{ t('Use this computer (recommended)') }}</strong><small>{{ t('Create your workspace here. No other computer is needed.') }}</small></span>
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
								<span><strong>{{ t('Connect to an existing workspace') }}</strong><small>{{ t('For an additional device: pair with a Main you have already set up.') }}</small></span>
							</button>
						</div>
						<label v-if="selectedRole === 'main'" class="toggle-row role-capability">
							<span><strong>{{ t('Also run tasks on this computer') }}</strong><small id="local-executor-help">{{ t('When off, execution tasks require a connected Child device. Main still manages your sessions and data.') }}</small></span>
							<input v-model="localExecutor" type="checkbox" role="switch" :disabled="busy" :aria-label="t('Also run tasks on this computer')" aria-describedby="local-executor-help">
						</label>
						<label v-if="selectedRole === 'main'" class="toggle-row">
							<span><strong>{{ t('Choose a different data folder') }}</strong><small>{{ t('Optional. Otherwise, Shadow uses the saved or default location.') }}</small></span>
							<input v-model="customDirectory" type="checkbox" :disabled="busy" :aria-label="t('Choose a different data folder')">
						</label>
					</details>
					<div class="actions">
						<button class="primary-button" :disabled="busy || !selectedRole" @click="chooseRole">
							{{ busy ? t('Preparing your workspace…') : selectedRole === 'child' ? t('Connect this device') : t('Get started') }}
						</button>
					</div>
				</div>

				<div v-else-if="state.mode === 'child'" class="setup-content">
					<p class="lead">{{ t('On Main, open Nodes and copy a pairing invitation. Paste it here, then approve this device on Main.') }}</p>
					<div v-if="childFingerprint" class="notice" role="status">
						<strong>{{ t('This device\'s fingerprint') }}</strong><code class="pairing-fingerprint">{{ childFingerprint }}</code>
						<span>{{ t('If Main already shows this pending device, compare this fingerprint, approve it there, then retry here. Retrying keeps the same identity even if the first response was lost.') }}</span>
					</div>
					<form class="child-form" @submit.prevent="pairChild">
						<template v-if="!manualPairing">
							<label class="field-label" for="child-invitation">{{ t('Pairing invitation') }}</label>
							<textarea id="child-invitation" v-model="invitationText" class="directory-input invitation-input" rows="3" :placeholder="t('Paste the invitation copied from Main')" required :disabled="busy" autocomplete="off" spellcheck="false" aria-describedby="child-invitation-help" :aria-invalid="!!invitationPreview.error"></textarea>
							<p id="child-invitation-help" class="field-help" :role="invitationPreview.error ? 'alert' : undefined">{{ invitationPreview.error || (invitationPreview.endpoint ? t('Main: {endpoint}', { endpoint: invitationPreview.endpoint }) : t('One paste includes Main’s address and pairing details. Keep the invitation private.')) }}</p>
						</template>
						<template v-else>
							<label class="field-label" for="child-endpoint">{{ t('Main device endpoint') }}</label>
							<input id="child-endpoint" v-model="child.endpoint" class="directory-input" type="url" placeholder="http://192.168.1.10:3124" required :disabled="busy" autocomplete="off">
							<div class="child-fields">
								<div><label class="field-label" for="child-offer">{{ t('Offer ID') }}</label><input id="child-offer" v-model="child.offerId" class="directory-input" required :disabled="busy" autocomplete="off"></div>
								<div><label class="field-label" for="child-pin">{{ t('Six-digit PIN') }}</label><input id="child-pin" v-model="child.pin" class="directory-input" type="password" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required :disabled="busy" autocomplete="off"></div>
							</div>
						</template>
						<button type="button" class="secondary-button" :disabled="busy" @click="togglePairingMode">{{ manualPairing ? t('Paste invitation instead') : t('Enter details manually') }}</button>
						<label class="consent-row"><input v-model="child.allowInsecureLocalTransport" type="checkbox" :disabled="busy"><span>{{ t('Use HTTP on a trusted LAN/VPN for testing only. Traffic and the PIN are not encrypted. Never use this on the public internet; device authentication remains required.') }}</span></label>
						<label class="field-label" for="child-name">{{ t('Device name') }}</label>
						<input id="child-name" v-model="child.displayName" class="directory-input" required maxlength="128" :disabled="busy">
						<label class="field-label" for="child-home">{{ t('Child home — protected identity and managed session data') }}</label>
						<div class="directory-field"><input id="child-home" v-model="child.dataDir" class="directory-input" required :disabled="busy || childSaved"><button type="button" class="secondary-button" :disabled="busy || childSaved" @click="pickChildFolder('dataDir')">{{ t('Browse…') }}</button></div>
						<label class="field-label" for="child-workdir">{{ t('Shared work folder — files, Git and commands') }}</label>
						<div class="directory-field"><input id="child-workdir" v-model="child.workdir" class="directory-input" required :disabled="busy"><button type="button" class="secondary-button" :disabled="busy" @click="pickChildFolder('workdir')">{{ t('Browse…') }}</button></div>
						<p class="field-help">{{ t('Use separate folders, not a drive root. Child home stays fixed after the first attempt so retries retain this device\'s identity. You can correct the endpoint and work folder until pairing succeeds. No existing data is moved or deleted.') }}</p>
						<label class="consent-row"><input v-model="executionConsent" type="checkbox" :disabled="busy" required><span>{{ t('I allow the approved Main to read/write the work folder, create managed workdirs under Child home, and execute commands as my OS account.') }} <strong>{{ t('Shell access is not a sandbox and can access other host files.') }}</strong> {{ t('Pair only with a Main you trust with this access.') }}</span></label>
						<div class="actions"><button class="primary-button" type="submit" :disabled="busy || !executionConsent">{{ busy ? t('Submitting pairing request…') : t('Pair and open local status') }}</button></div>
					</form>
				</div>

				<div v-else-if="state.step === 'choose-data-directory' && !automaticDirectory" class="setup-content">
					<p class="lead">{{ t('Choose where Shadow stores its settings and workspace data, or keep the recommended location.') }}</p>
					<label class="field-label" for="main-directory">{{ t('Data folder') }}</label>
					<div class="directory-field">
						<input
							id="main-directory"
							v-model="directoryPath"
							class="directory-input"
							type="text"
							:disabled="busy"
							:readonly="!api.selectMainDirectoryPath"
							:placeholder="t('Enter a full directory path')"
							aria-describedby="main-directory-help"
							autocomplete="off"
							spellcheck="false"
							@keydown.enter="commitDirectory"
						>
						<button class="secondary-button" :disabled="busy" @click="pickDirectory">{{ t('Browse…') }}</button>
					</div>
					<p id="main-directory-help" class="field-help">{{ t('Accept this location, edit the full path, or browse for another folder. Shadow creates the folder when you save. Existing data is not moved or deleted.') }}</p>
					<div class="actions">
						<button class="primary-button" :disabled="busy || (!directoryPath.trim() && !directorySelection)" @click="commitDirectory">
							{{ busy ? t('Saving…') : t('Use this directory') }}
						</button>
					</div>
				</div>

				<div v-else-if="state.mode === 'main'" class="setup-content">
					<template v-if="providerContext && providerStatus && !providerStatus.ready">
						<ProviderSetup :api-base="providerContext.apiBase" :status="providerFormStatus" mode="setup"
							@configured="providerConfigured" @retry="prepareProvider" @saving="providerSaving = $event" />
					</template>
					<template v-else-if="providerStatus?.ready && state.step === 'launch-main'">
						<p class="lead">{{ t('Your model service is connected. You are ready to start.') }}</p>
						<div class="launch-summary">
							<div><span>{{ t('Model service') }}</span><strong>{{ providerDisplayName(providerStatus.provider) }}</strong></div>
							<div v-if="providerStatus.host"><span>{{ t('GitHub account host') }}</span><strong>{{ providerStatus.host }}</strong></div>
						</div>
						<div class="actions"><button class="primary-button" :disabled="busy || providerSaving" @click="launchMain">{{ busy ? t('Opening your workspace…') : t('Start chatting') }}</button></div>
					</template>
					<template v-else>
						<p class="lead" role="status">{{ busy ? t('Preparing your workspace…') : t('Continue setting up your workspace.') }}</p>
						<div v-if="!busy" class="actions"><button class="primary-button" @click="continueMain()">{{ t('Retry setup') }}</button></div>
					</template>
				</div>

				<div v-if="actionError" class="notice error-notice action-error" role="alert">
					<strong>{{ actionError }}</strong>
					<span>{{ t('Your setup progress is saved. Retry this step when ready.') }}</span>
				</div>
			</template>
		</section>
	</main>
</template>

<script setup lang="ts">
import { t } from './i18n.ts'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import ProviderSetup from './ProviderSetup.vue'
import { createProviderSetupClient, providerDisplayName, type ProviderSetupStatus } from './provider-setup.ts'
import type { InstallationContextV1 } from './installation-context.ts'
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
const selectedRole = ref<'main' | 'child'>('main')
const customDirectory = ref(false)
const automaticDirectory = ref(false)
const providerContext = ref<InstallationContextV1 | null>(null)
const providerStatus = ref<ProviderSetupStatus | null>(null)
// Missing credentials are the normal first-run state, not an error the user caused.
const providerFormStatus = computed(() => {
	const status = providerStatus.value
	return status && ['missing_credentials', 'missing_base_url'].includes(status.reason ?? '')
		? { ...status, reason: undefined } : status
})
const providerSaving = ref(false)
const lifetime = new AbortController()
onBeforeUnmount(() => lifetime.abort())
const directorySelection = ref<NativeDirectorySelection | null>(null)
const directoryPath = ref('')
const localExecutor = ref(props.initialState?.mode === 'main'
	? props.initialState.localExecutor ?? loadLocalExecutorChoice()
	: true)
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
	catch (error) { return { endpoint: '', error: error instanceof Error ? error.message : t('Invalid Child invitation.') } }
})
const child = ref({ endpoint: '', offerId: '', pin: '', displayName: '', dataDir: '', workdir: '', allowInsecureLocalTransport: false })

function togglePairingMode() {
	manualPairing.value = !manualPairing.value
	invitationText.value = ''
	child.value.offerId = ''
	child.value.pin = ''
	actionError.value = ''
}

const showRoleChoice = computed(() => state.value?.mode === null)
const currentStepIndex = computed(() => {
	if (state.value?.mode !== 'main' || ['choose-data-directory', 'initialize-main'].includes(state.value.step)) return 0
	return providerStatus.value?.ready && state.value.step === 'launch-main' ? 2 : 1
})
const progressLabel = computed(() => t('Step {value1} of {length}', { value1: currentStepIndex.value + 1, length: 3 }))
const progressPercent = computed(() => ((currentStepIndex.value + 1) / 3) * 100)
const heading = computed(() => {
	if (props.loadError) return t('Connect to desktop')
	if (state.value?.mode === null) return t('Welcome to Shadow')
	if (state.value?.mode === 'child') return t('Connect this device')
	if (state.value?.step === 'choose-data-directory' && !automaticDirectory.value) return t('Choose a data folder')
	if (state.value?.step === 'initialize-main' || state.value?.step === 'choose-data-directory') return t('Preparing your workspace…')
	return currentStepIndex.value === 2 ? t('You are ready') : t('Connect a model service')
})

async function reloadSavedProgress(): Promise<void> {
	try {
		const saved = await props.api.bootstrap.load()
		if (!lifetime.signal.aborted) state.value = saved
	} catch { /* Keep the last known step while Desktop is unreachable. */ }
}

async function run(
	operation: () => Promise<WizardState>,
	failureMessage = t('This step could not be completed.'),
): Promise<void> {
	busy.value = true
	actionError.value = ''
	try {
		state.value = await operation()
	} catch {
		await reloadSavedProgress()
		actionError.value = failureMessage
	} finally {
		busy.value = false
	}
}

async function chooseRole(): Promise<void> {
	if (busy.value) return
	automaticDirectory.value = selectedRole.value === 'main' && !customDirectory.value
	await run(() => props.api.bootstrap.dispatch(selectedRole.value === 'main'
		? { type: 'select-role', mode: 'main', localExecutor: localExecutor.value }
		: { type: 'select-role', mode: 'child' }))
	if (lifetime.signal.aborted) return
	if (state.value?.mode === 'main') {
		if (customDirectory.value) await loadDirectory()
		else await continueMain()
	} else await loadChild()
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
	} catch { actionError.value = t('Child settings could not be loaded. Restart Shadow and retry; existing identity data is retained.') }
}

async function pickChildFolder(field: 'dataDir' | 'workdir'): Promise<void> {
	try {
		const path = await props.api.folders?.selectDirectory()
		if (path) child.value[field] = path
	} catch { actionError.value = t('The directory picker failed. Enter a full absolute path or retry Browse.') }
}

async function pairChild(): Promise<void> {
	if (busy.value || !executionConsent.value) return
	busy.value = true
	actionError.value = ''
	try {
		if (!props.api.bootstrap.pairChild) throw new Error(t('Child pairing requires a current desktop build.'))
		const invitation = manualPairing.value ? child.value : decodeChildInvitation(invitationText.value)
		const result = await props.api.bootstrap.pairChild({ ...child.value,
			endpoint: invitation.endpoint, offerId: invitation.offerId, pin: invitation.pin, executionConsent: true })
		if (!result.ok) throw new Error(t('Child setup could not be saved. Retry this step.'))
		state.value = result.state
		emit('complete')
	} catch (error) {
		actionError.value = error instanceof Error ? error.message : t('Pairing failed. Check Main and retry.')
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
		actionError.value = t('The saved or default directory could not be loaded. Enter a full path, or browse for a writable folder.')
	} finally {
		busy.value = false
	}
}

onMounted(async () => {
	if (state.value?.mode === 'main' && state.value.step !== 'choose-data-directory') await continueMain()
	else { await loadDirectory(); await loadChild() }
})

async function pickDirectory(): Promise<void> {
	actionError.value = ''
	busy.value = true
	try {
		const selection = await props.api.selectDirectory()
		if (selection) useDirectorySelection(selection)
	} catch {
		actionError.value = t('The directory picker could not be opened. Enter a full path above, or try Browse again.')
	} finally {
		busy.value = false
	}
}

async function commitDirectory(): Promise<void> {
	if (busy.value || (!directoryPath.value.trim() && !directorySelection.value)) return
	await continueMain(true)
}

async function continueMain(useChosenDirectory = false): Promise<void> {
	if (busy.value || state.value?.mode !== 'main') return
	busy.value = true
	actionError.value = ''
	try {
		lifetime.signal.throwIfAborted()
		if (state.value.step === 'choose-data-directory') {
			if (!useChosenDirectory) {
				const selection = await loadMainDirectorySelection(props.api, directorySelection.value)
				lifetime.signal.throwIfAborted()
				if (!selection) throw new Error('Directory selection unavailable')
				useDirectorySelection(selection)
			}
			const result = await commitMainDirectoryChoice(props.api, directoryPath.value, directorySelection.value)
			lifetime.signal.throwIfAborted()
			if (!result.ok) throw new Error('Directory setup failed')
			state.value = result.state
			directorySelection.value = null
		}
		if (state.value.mode === 'main' && state.value.step === 'initialize-main') {
			const result = await props.api.bootstrap.initializeMain()
			lifetime.signal.throwIfAborted()
			if (!result.ok) throw new Error('Initialization failed')
			state.value = result.state
		}
		await connectProviderRuntime()
	} catch {
		await reloadSavedProgress()
		if (state.value?.step === 'choose-data-directory') automaticDirectory.value = false
		if (!lifetime.signal.aborted) actionError.value = t('Setup could not finish. Check the data folder permissions and desktop connection, then retry. Existing data is preserved.')
	} finally { busy.value = false }
}

async function connectProviderRuntime(): Promise<void> {
	if (!props.api.bootstrap.prepareProvider) {
		actionError.value = t('Update and restart Desktop to connect a model service during setup.')
		return
	}
	const result = await props.api.bootstrap.prepareProvider({ localExecutor: localExecutor.value, port: MAIN_LAUNCH_PORT })
	lifetime.signal.throwIfAborted()
	if (!result.ok || result.context.mode !== 'main') throw new Error('Runtime unavailable')
	providerContext.value = result.context
	await checkProvider()
}

async function checkProvider(): Promise<void> {
	if (!providerContext.value) throw new Error('Runtime unavailable')
	const status = await createProviderSetupClient(providerContext.value.apiBase).status(lifetime.signal, true)
	lifetime.signal.throwIfAborted()
	providerStatus.value = status
	if (status.ready && state.value?.step === 'configure-provider') {
		state.value = await props.api.bootstrap.dispatch({ type: 'provider-configured' })
	}
}

async function prepareProvider(): Promise<void> {
	if (busy.value) return
	busy.value = true
	actionError.value = ''
	try { await connectProviderRuntime() }
	catch { if (!lifetime.signal.aborted) actionError.value = t('The model setup service could not be reached. Check Desktop and retry.') }
	finally { busy.value = false }
}

async function providerConfigured(): Promise<void> {
	if (busy.value) return
	busy.value = true
	actionError.value = ''
	try {
		await checkProvider()
		if (!providerStatus.value?.ready) actionError.value = t('Connect a model service before continuing.')
	} catch { if (!lifetime.signal.aborted) actionError.value = t('The model setup service could not be reached. Check Desktop and retry.') }
	finally { busy.value = false }
}

async function launchMain(): Promise<void> {
	if (busy.value || !providerStatus.value?.ready) return
	await run(async () => {
		const result = await props.api.bootstrap.launchMain({ localExecutor: localExecutor.value, port: MAIN_LAUNCH_PORT })
		if (!result.ok) throw new Error('Launch failed')
		return result.state
	}, t('Your workspace could not open. Your settings are saved; retry when ready.'))
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
.advanced-setup { margin-top: 22px; }
.advanced-setup > summary { cursor: pointer; color: var(--muted); margin-bottom: 16px; }
.setup-content :deep(.provider-setup) { width: 100%; max-width: none; padding: 0; border: 0; box-shadow: none; }
.setup-content :deep(.provider-setup > .setup-title) { display: none; }
.setup-content :deep(.provider-setup .primary) { background: var(--accent); border-color: var(--accent); }
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
.role-capability { margin-top: 16px; padding-block: 12px; }
.toggle-row input[role="switch"] { width: 38px; height: 20px; }
.launch-summary { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid var(--line); border-radius: var(--radius-surface); overflow: hidden; }
.launch-summary div { display: grid; gap: 6px; padding: 14px 16px; border-right: 1px solid var(--line); font-size: 12px; }
.launch-summary div:last-child { border-right: 0; }
@keyframes enter { from { opacity: 0; transform: translateY(4px); } }
@media (max-width: 620px) {
	.setup-shell { place-items: start center; padding: 16px; }
	.advanced-setup { margin-top: 22px; }
.advanced-setup > summary { cursor: pointer; color: var(--muted); margin-bottom: 16px; }
.setup-content :deep(.provider-setup) { width: 100%; max-width: none; padding: 0; border: 0; box-shadow: none; }
.setup-content :deep(.provider-setup > .setup-title) { display: none; }
.setup-content :deep(.provider-setup .primary) { background: var(--accent); border-color: var(--accent); }
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
.pairing-fingerprint { overflow-wrap: anywhere; -webkit-user-select: all; user-select: all; }
.child-fields { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 12px; margin-top: 18px; }
.consent-row { display: flex; align-items: flex-start; gap: 10px; margin-top: 16px; font-size: 13px; line-height: 1.5; }
.consent-row input { flex-shrink: 0; margin-top: 4px; }
@media (max-width: 620px) { .child-fields { grid-template-columns: 1fr; } }
</style>