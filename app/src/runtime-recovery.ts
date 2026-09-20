export const STARTUP_FAILURE_KINDS = [
	'spawn-error', 'configuration-error', 'port-conflict', 'readiness-timeout',
	'early-exit', 'migration-failure', 'main-unreachable', 'crash',
] as const

export interface RuntimeFailure {
	readonly role: 'main' | 'child'
	readonly kind: typeof STARTUP_FAILURE_KINDS[number]
	readonly elapsedMs?: number
}

export function parseRuntimeFailure(value: unknown): RuntimeFailure | undefined {
	if (typeof value !== 'object' || value === null) return undefined
	const record = value as Record<string, unknown>
	if (
		(record.role !== 'main' && record.role !== 'child')
		|| !STARTUP_FAILURE_KINDS.includes(record.kind as RuntimeFailure['kind'])
	) return undefined
	return {
		role: record.role,
		kind: record.kind as RuntimeFailure['kind'],
		...(typeof record.elapsedMs === 'number' && Number.isSafeInteger(record.elapsedMs) && record.elapsedMs >= 0
			? { elapsedMs: record.elapsedMs } : {}),
	}
}

const REASONS: Record<RuntimeFailure['kind'], string> = {
	'spawn-error': 'The runtime process could not be launched. Check that Shadow is installed correctly.',
	'configuration-error': 'The runtime configuration or local readiness check was rejected.',
	'port-conflict': 'The runtime port is already in use. Close any other Shadow instance before retrying.',
	'readiness-timeout': 'The runtime did not become ready before the startup deadline.',
	'early-exit': 'The runtime process exited before it was ready.',
	'migration-failure': 'The runtime could not finish updating its saved data.',
	'main-unreachable': 'This Child could not reach Main. Check that Main is running and reachable.',
	'crash': 'The runtime process stopped unexpectedly.',
}

export function runtimeRecoveryMessage(failure: unknown, code?: string): string {
	const parsed = parseRuntimeFailure(failure)
	if (parsed) return REASONS[parsed.kind]
	if (code === 'profile-missing') return 'The saved launch settings are missing. Reset setup to configure this desktop again.'
	if (code === 'invalid-state') return 'This desktop setup cannot launch a runtime in its current state.'
	return 'The desktop runtime could not be started.'
}

export function runtimeRecoveryDuration(failure: unknown): string | undefined {
	const elapsedMs = parseRuntimeFailure(failure)?.elapsedMs
	if (elapsedMs === undefined) return undefined
	return `Startup attempt: ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(elapsedMs / 1_000)} s`
}
