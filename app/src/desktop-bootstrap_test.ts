import { strictEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import {
	browserBootstrap,
	loadDesktopBootstrap,
	resolveDesktopBootstrap,
	shouldShowFirstRun,
	type ShadowDesktopApi,
	type WizardState,
} from './desktop-bootstrap.ts'
import type { InstallationContextV1 } from './installation-context.ts'

function mainState(step: WizardState['step']): WizardState {
	return { version: 1, revision: 1, mode: 'main', step } as WizardState
}

const realContext: InstallationContextV1 = {
	version: 1,
	mode: 'main',
	localNodeId: 'runtime-main',
	mainConnection: 'connected',
	mainLatencyMs: null,
	uiScopes: ['chat:read'],
	apiBase: 'http://127.0.0.1:43123',
}

test('first-run remains visible at every resumable Main step', () => {
	for (const step of [
		'choose-data-directory',
		'initialize-main',
		'configure-provider',
		'choose-local-capabilities',
		'launch-main',
	] as const) {
		assertEquals(shouldShowFirstRun(mainState(step)), true)
	}
	assertEquals(shouldShowFirstRun(mainState('complete')), false)
})

test('desktop bootstrap state is loaded through the authenticated API', async () => {
	const expected = mainState('configure-provider')
	let loadCount = 0
	const api = {
		bootstrap: {
			load: () => {
				loadCount += 1
				return Promise.resolve(expected)
			},
		},
	} as unknown as ShadowDesktopApi

	assertEquals(await loadDesktopBootstrap(api), expected)
	assertEquals(loadCount, 1)
})

test('complete desktop setup ensures runtime and returns its real context', async () => {
	let ensureCount = 0
	const api = {
		bootstrap: {
			load: () => Promise.resolve(mainState('complete')),
			ensureRuntime: () => {
				ensureCount += 1
				return Promise.resolve({ ok: true, context: realContext } as const)
			},
		},
	} as unknown as ShadowDesktopApi

	const outcome = await resolveDesktopBootstrap(api)
	assertEquals(outcome.view, 'app')
	if (outcome.view !== 'app') throw new Error('Expected app outcome')
	assertEquals(outcome.context, realContext)
	assertEquals(ensureCount, 1)
})

test('incomplete desktop setup skips runtime ensure', async () => {
	let ensureCount = 0
	const api = {
		bootstrap: {
			load: () => Promise.resolve(mainState('configure-provider')),
			ensureRuntime: () => {
				ensureCount += 1
				return Promise.resolve({ ok: true, context: realContext } as const)
			},
		},
	} as unknown as ShadowDesktopApi

	const outcome = await resolveDesktopBootstrap(api)
	assertEquals(outcome.view, 'wizard')
	assertEquals(ensureCount, 0)
})

test('runtime ensure failure produces a recoverable state', async () => {
	const api = {
		bootstrap: {
			load: () => Promise.resolve(mainState('complete')),
			ensureRuntime: () => Promise.resolve({ ok: false, code: 'runtime-unavailable' } as const),
		},
	} as unknown as ShadowDesktopApi

	assertEquals((await resolveDesktopBootstrap(api)).view, 'runtime-recovery')
})

test('thrown runtime ensure produces the same recoverable state', async () => {
	const api = {
		bootstrap: {
			load: () => Promise.resolve(mainState('complete')),
			ensureRuntime: () => Promise.reject(new Error('private runtime failure')),
		},
	} as unknown as ShadowDesktopApi

	assertEquals((await resolveDesktopBootstrap(api)).view, 'runtime-recovery')
})

test('browser fallback preserves its synthetic installation context', () => {
	const outcome = browserBootstrap(realContext)
	assertEquals(outcome.view, 'app')
	if (outcome.view !== 'app') throw new Error('Expected app outcome')
	assertEquals(outcome.context, realContext)
})