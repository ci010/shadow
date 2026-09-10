<template>
	<main class="recovery-shell">
		<section class="recovery-panel" aria-labelledby="recovery-title">
			<div class="brand-mark" aria-hidden="true">S</div>
			<div>
				<p class="eyebrow">Shadow desktop</p>
				<h1 id="recovery-title">Main is not ready</h1>
				<p class="message">The desktop runtime could not be started. Your setup is still saved.</p>
			</div>
			<p v-if="actionFailed" class="notice" role="alert">That action could not be completed. Try again.</p>
			<div class="actions">
				<button v-if="canReset" class="secondary-button" :disabled="busy" @click="resetSetup">
					Reset setup
				</button>
				<button class="primary-button" :disabled="busy" @click="retry">
					{{ busy ? 'Trying again…' : 'Retry' }}
				</button>
			</div>
		</section>
	</main>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
	canReset: boolean
	retry: () => Promise<void>
	reset?: () => Promise<void>
}>()

const busy = ref(false)
const actionFailed = ref(false)

async function invoke(action: 'retry' | 'reset'): Promise<void> {
	busy.value = true
	actionFailed.value = false
	try {
		if (action === 'retry') await props.retry()
		else await props.reset?.()
	} catch {
		actionFailed.value = true
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
	min-height: 100vh;
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
	border-radius: 8px;
	background: #fff;
	box-shadow: 0 18px 48px rgba(25, 49, 39, .1);
}
.brand-mark {
	width: 44px;
	height: 44px;
	display: grid;
	place-items: center;
	border-radius: 7px;
	color: white;
	background: var(--ink);
	font: 700 22px/1 Georgia, serif;
}
.eyebrow { margin: 0 0 3px; color: var(--accent); font-size: 12px; font-weight: 700; text-transform: uppercase; }
h1 { margin: 0; font: 600 24px/1.2 Georgia, "Times New Roman", serif; letter-spacing: 0; }
.message { margin: 12px 0 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
.notice { grid-column: 1 / -1; margin: 4px 0 0; padding: 11px 13px; color: #7b3027; border: 1px solid #e5bbb4; border-radius: 6px; background: #fff5f3; font-size: 13px; }
.actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }
button { min-height: 38px; padding: 0 16px; border-radius: 5px; font: 650 13px/1 "Segoe UI Variable", "Segoe UI", sans-serif; cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .52; }
.primary-button { color: white; border: 1px solid var(--accent); background: var(--accent); }
.secondary-button { color: var(--ink); border: 1px solid #bac4be; background: white; }
@media (max-width: 480px) {
	.recovery-shell { place-items: start center; padding: 16px; }
	.recovery-panel { padding: 22px 20px; }
}
</style>