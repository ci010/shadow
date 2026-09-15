<template>
	<main class="setup-shell">
		<section class="setup-panel" aria-labelledby="setup-title">
			<header class="setup-header">
				<img class="brand-mark" :src="shadowLogo" alt="" aria-hidden="true" draggable="false">
				<div>
					<p class="eyebrow">Shadow setup</p>
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
							<span><strong>Child</strong><small>Connects to an existing Main with limited capabilities.</small></span>
						</button>
					</div>
					<div v-if="selectedRole === 'child'" class="notice pending-notice" role="status">
						<strong>Child setup is not available yet.</strong>
						<span>Pairing is still being implemented. This setup will not create or simulate a connection.</span>
					</div>
					<div class="actions">
						<button class="primary-button" :disabled="busy || selectedRole !== 'main'" @click="chooseMain">
							{{ busy ? 'Saving…' : 'Continue as Main' }}
						</button>
					</div>
				</div>

				<div v-else-if="state.mode === 'child'" class="setup-content">
					<div class="notice pending-notice" role="status">
						<strong>Child setup is pending implementation.</strong>
						<span>No pairing data has been sent. Install a future update to continue this setup.</span>
					</div>
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

async function chooseMain(): Promise<void> {
	await run(() => props.api.bootstrap.dispatch({ type: 'select-role', mode: 'main' }))
	await loadDirectory()
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

onMounted(loadDirectory)

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
	--ink: #18211d;
	--muted: #66706b;
	--line: #d8ddd9;
	--accent: #147a57;
	--accent-dark: #0f6246;
	min-height: 100%;
	display: grid;
	place-items: center;
	padding: 32px;
	color: var(--ink);
	background: radial-gradient(circle at 15% 15%, rgba(31, 132, 96, .11), transparent 30%), linear-gradient(145deg, #f8faf8, #eef2ef);
	font-family: "Segoe UI Variable", "Segoe UI", sans-serif;
}
.setup-panel { width: min(640px, 100%); min-height: 470px; padding: 34px 38px; border: 1px solid #cdd5d0; border-radius: var(--radius-overlay); background: rgba(255, 255, 255, .94); box-shadow: 0 20px 60px rgba(25, 49, 39, .12); }
.setup-header { display: grid; grid-template-columns: 44px 1fr auto; gap: 14px; align-items: center; }
.brand-mark { width: 44px; height: 44px; display: block; object-fit: contain; }
.eyebrow { margin: 0 0 2px; color: var(--accent); font-size: 12px; font-weight: 700; text-transform: uppercase; }
h1 { margin: 0; font: 600 25px/1.2 Georgia, "Times New Roman", serif; letter-spacing: 0; }
.step-count { color: var(--muted); font-size: 12px; }
.progress-track { height: 3px; margin: 22px 0 30px; overflow: hidden; background: #e8ece9; }
.progress-track span { display: block; height: 100%; background: var(--accent); transition: width .25s ease; }
.setup-content { margin-top: 30px; animation: enter .22s ease-out; }
.progress-track + .setup-content { margin-top: 0; }
.lead { max-width: 520px; margin: 0 0 24px; color: #4e5953; font-size: 15px; line-height: 1.55; }
.role-list { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.role-option { display: grid; grid-template-columns: 38px 1fr; gap: 12px; min-height: 108px; padding: 16px; text-align: left; color: var(--ink); border: 1px solid var(--line); border-radius: var(--radius-surface); background: #fff; cursor: pointer; }
.role-option:hover, .role-option:focus-visible { border-color: #8ba99b; outline: none; }
.role-option.selected { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); background: #f4faf7; }
.role-icon { width: 36px; height: 36px; display: grid; place-items: center; border-radius: var(--radius-control); background: #edf2ef; }
.role-icon svg { width: 20px; fill: none; stroke: currentColor; stroke-width: 1.7; }
.role-option strong, .role-option small { display: block; }
.role-option strong { margin: 2px 0 6px; font-size: 15px; }
.role-option small { color: var(--muted); font-size: 12px; line-height: 1.4; }
.actions { display: flex; justify-content: flex-end; margin-top: 26px; }
button { font: inherit; }
.primary-button, .secondary-button { min-height: 40px; padding: 0 18px; border-radius: var(--radius-control); font-size: 13px; font-weight: 650; cursor: pointer; }
.primary-button { color: white; border: 1px solid var(--accent); background: var(--accent); }
.primary-button:hover:not(:disabled) { background: var(--accent-dark); }
.primary-button:disabled, button:disabled { cursor: not-allowed; opacity: .52; }
.secondary-button { align-self: start; color: var(--ink); border: 1px solid #bac4be; background: white; }
.notice { display: grid; gap: 5px; padding: 14px 16px; border-radius: var(--radius-surface); font-size: 13px; line-height: 1.45; }
.notice span { color: #59645e; }
.pending-notice { margin-top: 18px; border: 1px solid #dfd3a8; background: #fffbec; }
.error-notice { margin-top: 30px; border: 1px solid #e5bbb4; background: #fff5f3; }
.error-notice .secondary-button { margin-top: 8px; }
.action-error { margin-top: 20px; }
.field-label { display: block; margin-bottom: 8px; font-size: 12px; font-weight: 700; }
.directory-field { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: start; }
.directory-input { min-width: 0; width: 100%; min-height: 40px; padding: 8px 10px; color: var(--ink); border: 1px solid var(--line); border-radius: var(--radius-control); background: white; font: inherit; font-size: 13px; }
.directory-input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.directory-input:disabled { color: var(--muted); background: #f4f6f4; }
.field-help { margin: 8px 0 0; color: var(--muted); font-size: 11px; line-height: 1.45; }
.summary-row, .toggle-row { display: flex; justify-content: space-between; gap: 20px; align-items: center; min-height: 62px; padding: 0 16px; border: 1px solid var(--line); border-radius: var(--radius-surface); background: #fafcfa; font-size: 13px; }
.summary-row span, .launch-summary span { color: var(--muted); }
.provider-options { margin: 0; padding-left: 20px; color: #48534d; font-size: 14px; line-height: 1.55; }
.provider-options li + li { margin-top: 12px; }
input[type="checkbox"] { accent-color: var(--accent); }
.toggle-row span strong, .toggle-row span small { display: block; }
.toggle-row span small { margin-top: 4px; color: var(--muted); font-size: 11px; }
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
</style>