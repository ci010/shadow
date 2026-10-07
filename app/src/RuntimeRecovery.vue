<template>
	<main class="recovery-shell">
		<section class="recovery-panel" aria-labelledby="recovery-title" :aria-busy="busy">
			<img class="brand-mark" :src="shadowLogo" alt="" aria-hidden="true" draggable="false">
			<div>
				<h1 id="recovery-title">{{ runtimeName }} {{ t('is not ready') }}</h1>
				<p class="message">{{ reason }} {{ t('Your setup is still saved.') }}</p>
				<p v-if="duration" class="message">{{ duration }}</p>
			</div>
			<p v-if="actionFailed" class="notice" role="alert">{{ actionFailed }}</p>
			<p v-if="busy" class="status" role="status">{{ activeAction === 'retry' ? t('Starting the runtime again…') : activeAction === 'log' ? t('Locating the startup log…') : t('Resetting setup…') }}</p>
			<div v-if="revealLog" class="diagnostics">
				<p class="message">{{ t('Startup logs contain timing and failure categories, not chat content or credentials.') }}</p>
				<button class="secondary-button" :disabled="busy" @click="invoke('log')">{{ t('Show startup log') }}</button>
			</div>
			<div class="actions">
				<button v-if="canReset" class="secondary-button" :disabled="busy" @click="resetSetup">
					{{ t('Reset setup') }}
				</button>
				<button class="primary-button" :disabled="busy" @click="retry">
					{{ busy && activeAction === 'retry' ? t('Trying again…') : t('Retry') }}
				</button>
			</div>
		</section>
	</main>
</template>

<script setup lang="ts">
import { t } from './i18n.ts'
import { computed, ref } from 'vue'
import shadowLogo from './assets/shadow-logo.png'
import { parseRuntimeFailure, runtimeRecoveryDuration, runtimeRecoveryMessage, type RuntimeFailure } from './runtime-recovery.ts'

const props = defineProps<{
	canReset: boolean
	retry: () => Promise<void>
	reset?: () => Promise<void>
	revealLog?: () => Promise<void>
	role?: 'main' | 'child'
	code?: string
	failure?: RuntimeFailure
}>()

const runtimeName = computed(() => {
	const role = parseRuntimeFailure(props.failure)?.role ?? props.role
	return role === 'child' ? t('Child') : role === 'main' ? t('Main') : t('Runtime')
})
const reason = computed(() => runtimeRecoveryMessage(props.failure, props.code))
const duration = computed(() => runtimeRecoveryDuration(props.failure))
const busy = ref(false)
const actionFailed = ref('')
const activeAction = ref<'retry' | 'reset' | 'log'>('retry')

async function invoke(action: 'retry' | 'reset' | 'log'): Promise<void> {
	if (busy.value) return
	busy.value = true
	activeAction.value = action
	actionFailed.value = ''
	try {
		if (action === 'retry') await props.retry()
		else if (action === 'log') await props.revealLog?.()
		else await props.reset?.()
	} catch {
		actionFailed.value = action === 'log'
			? t('The startup log could not be shown. It may not have been saved. You can still retry startup.')
			: action === 'reset' ? t('Setup could not be reset. Try again.') : t('Startup could not be retried. Try again.')
	} finally {
		busy.value = false
	}
}

async function retry(): Promise<void> {
	await invoke('retry')
}

async function resetSetup(): Promise<void> {
	await invoke('reset')
}
</script>

<style scoped>
.recovery-shell {
	--ink: #18211d;
	--muted: #66706b;
	--line: #d8ddd9;
	--accent: #147a57;
	min-height: 100%;
	display: grid;
	place-items: center;
	padding: 24px;
	color: var(--ink);
	background: linear-gradient(145deg, #f8faf8, #eef2ef);
	font-family: "Segoe UI Variable", "Segoe UI", sans-serif;
}
.recovery-panel {
	width: min(440px, 100%);
	display: grid;
	grid-template-columns: 44px 1fr;
	gap: 14px;
	padding: 28px;
	border: 1px solid #cdd5d0;
	border-radius: var(--radius-overlay);
	background: #fff;
	box-shadow: 0 18px 48px rgba(25, 49, 39, .1);
}
.recovery-panel > div { min-width: 0; overflow-wrap: anywhere; }
.brand-mark {
	width: 44px;
	height: 44px;
	display: block;
	object-fit: contain;
}
h1 { margin: 0; font: 600 24px/1.2 Georgia, "Times New Roman", serif; letter-spacing: 0; }
.message { margin: 12px 0 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
.notice { grid-column: 1 / -1; margin: 4px 0 0; padding: 11px 13px; color: #7b3027; border: 1px solid #e5bbb4; border-radius: var(--radius-surface); background: #fff5f3; font-size: 13px; }
.status { grid-column: 1 / -1; margin: 0; font-size: 14px; color: var(--muted); }
.diagnostics { grid-column: 1 / -1; border-top: 1px solid var(--line); padding-top: 4px; }
.diagnostics button { margin-top: 12px; }
.actions { grid-column: 1 / -1; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; margin-top: 8px; }
button { min-height: 38px; padding: 0 16px; border-radius: var(--radius-control); font: 650 13px/1 "Segoe UI Variable", "Segoe UI", sans-serif; cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .52; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
button:not(:disabled):hover { filter: brightness(.96); }
.primary-button { color: white; border: 1px solid var(--accent); background: var(--accent); }
.secondary-button { color: var(--ink); border: 1px solid #bac4be; background: white; }
@media (max-width: 480px) {
	.recovery-shell { place-items: start center; padding: 16px; }
	.recovery-panel { padding: 22px 20px; }
}
</style>