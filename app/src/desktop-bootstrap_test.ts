import { deepStrictEqual, rejects, strictEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import {
	browserBootstrap,
	commitMainDirectoryChoice,
	loadDesktopBootstrap,
	loadMainDirectorySelection,
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

test('recovery carries only safe failure details, distinguishes Child and allows retry', async () => {
	let attempts = 0
	const api = {
		bootstrap: {
			load: async () => ({ version: 1, revision: 1, mode: 'child', step: 'complete' }),
			ensureRuntime: async () => ++attempts === 1 ? {
				ok: false, code: 'runtime-unavailable',
				failure: { role: 'child', kind: 'early-exit', elapsedMs: 900, message: 'private-key' },
			} : { ok: true, context: realContext },
		},
	} as unknown as ShadowDesktopApi
	deepStrictEqual(await resolveDesktopBootstrap(api), {
		view: 'runtime-recovery', role: 'child', code: 'runtime-unavailable',
		failure: { role: 'child', kind: 'early-exit', elapsedMs: 900 },
	})
	assertEquals((await resolveDesktopBootstrap(api)).view, 'app')
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

test('Main default is supplied by desktop as an expanded path without opening the chooser', async () => {
	let defaults = 0
	let browse = 0
	const selection = { selectionId: 'default', displayName: '.shadow', displayPath: 'C:\\fake-home\\.shadow' }
	const api = {
		getMainDirectorySelection: async () => { defaults += 1; return selection },
		selectDirectory: async () => { browse += 1; return null },
	} as unknown as ShadowDesktopApi
	assertEquals(await loadMainDirectorySelection(api, null), selection)
	assertEquals(defaults, 1)
	assertEquals(browse, 0)

	const custom = { selectionId: 'custom', displayName: 'custom', displayPath: 'D:\\custom' }
	assertEquals(await loadMainDirectorySelection(api, custom), custom)
	assertEquals(defaults, 1)
})

test('default and edited Main paths use validated selections before committing', async () => {
	const commands: unknown[] = []
	const result = { ok: true, state: mainState('initialize-main') } as const
	const api = {
		selectMainDirectoryPath: async (path: string) => {
			commands.push(['select', path])
			return { selectionId: 'validated', displayName: 'main', displayPath: path }
		},
		bootstrap: {
			commitMainDirectory: async (selectionId: string) => { commands.push(['commit', selectionId]); return result },
		},
	} as unknown as ShadowDesktopApi
	const initial = { selectionId: 'default', displayName: '.shadow', displayPath: 'C:\\fake-home\\.shadow' }
	assertEquals(await commitMainDirectoryChoice(api, initial.displayPath, initial), result)
	assertEquals(await commitMainDirectoryChoice(api, 'D:\\custom', initial), result)
	deepStrictEqual(commands, [
		['select', 'C:\\fake-home\\.shadow'], ['commit', 'validated'],
		['select', 'D:\\custom'], ['commit', 'validated'],
	])
})

test('failed saves refresh the single-use directory selection on retry', async () => {
	let selections = 0
	const committed: string[] = []
	const api = {
		selectMainDirectoryPath: async () => ({ selectionId: `selection-${++selections}`, displayName: 'main' }),
		bootstrap: {
			commitMainDirectory: async (selectionId: string) => {
				committed.push(selectionId)
				return committed.length === 1
					? { ok: false, code: 'write-failed', state: mainState('choose-data-directory') }
					: { ok: true, state: mainState('initialize-main') }
			},
		},
	} as unknown as ShadowDesktopApi
	assertEquals((await commitMainDirectoryChoice(api, 'C:\\fake-home\\.shadow', null)).ok, false)
	assertEquals((await commitMainDirectoryChoice(api, 'C:\\fake-home\\.shadow', null)).ok, true)
	deepStrictEqual(committed, ['selection-1', 'selection-2'])
})

test('legacy desktop directory mocks remain compatible without manufacturing a path', async () => {
	let committed = ''
	const selection = { selectionId: 'native-id', displayName: 'main' }
	const api = {
		bootstrap: {
			commitMainDirectory: async (id: string) => {
				committed = id
				return { ok: true, state: mainState('initialize-main') }
			},
		},
	} as unknown as ShadowDesktopApi
	assertEquals(await loadMainDirectorySelection(api, null), null)
	assertEquals((await commitMainDirectoryChoice(api, 'main', selection)).ok, true)
	assertEquals(committed, 'native-id')
	await rejects(commitMainDirectoryChoice(api, '', null), /Choose a Main directory first/)
})

test('invalid edited paths do not fall back to the previously selected directory', async () => {
	let writes = 0
	const api = {
		selectMainDirectoryPath: async () => { throw new Error('Path must be absolute') },
		bootstrap: {
			commitMainDirectory: async () => { writes += 1 },
		},
	} as unknown as ShadowDesktopApi
	await rejects(commitMainDirectoryChoice(api, '~/.shadow', { selectionId: 'old', displayName: 'old' }), /absolute/)
	assertEquals(writes, 0)
})
