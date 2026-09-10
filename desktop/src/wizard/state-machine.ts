export type InstallationMode = 'main' | 'child'

export type MainWizardStep =
  | 'choose-role'
  | 'choose-data-directory'
  | 'initialize-main'
  | 'configure-provider'
  | 'choose-local-capabilities'
  | 'launch-main'
  | 'complete'

export type ChildWizardStep =
  | 'choose-role'
  | 'enter-pairing-offer'
  | 'verify-fingerprint'
  | 'name-device'
  | 'choose-capabilities'
  | 'launch-child'
  | 'complete'

interface WizardStateBase {
  readonly version: 1
  readonly revision: number
}

export interface UnselectedWizardState extends WizardStateBase {
  readonly mode: null
  readonly step: 'choose-role'
}

export interface MainWizardState extends WizardStateBase {
  readonly mode: 'main'
  readonly step: MainWizardStep
}

export interface ChildWizardState extends WizardStateBase {
  readonly mode: 'child'
  readonly step: ChildWizardStep
}

export type WizardState =
  | UnselectedWizardState
  | MainWizardState
  | ChildWizardState

export type WizardEvent =
  | { readonly type: 'select-role'; readonly mode: InstallationMode }
  | { readonly type: 'data-directory-selected' }
  | { readonly type: 'main-initialized' }
  | { readonly type: 'provider-configured' }
  | { readonly type: 'local-capabilities-selected' }
  | { readonly type: 'pairing-offer-entered' }
  | { readonly type: 'fingerprint-verified' }
  | { readonly type: 'device-named' }
  | { readonly type: 'child-capabilities-selected' }
  | { readonly type: 'sidecar-ready' }

const MAIN_TRANSITIONS: Readonly<Partial<Record<MainWizardStep, WizardEvent['type']>>> = {
  'choose-data-directory': 'data-directory-selected',
  'initialize-main': 'main-initialized',
  'configure-provider': 'provider-configured',
  'choose-local-capabilities': 'local-capabilities-selected',
  'launch-main': 'sidecar-ready',
}

const MAIN_NEXT: Readonly<Partial<Record<MainWizardStep, MainWizardStep>>> = {
  'choose-data-directory': 'initialize-main',
  'initialize-main': 'configure-provider',
  'configure-provider': 'choose-local-capabilities',
  'choose-local-capabilities': 'launch-main',
  'launch-main': 'complete',
}

const CHILD_TRANSITIONS: Readonly<Partial<Record<ChildWizardStep, WizardEvent['type']>>> = {
  'enter-pairing-offer': 'pairing-offer-entered',
  'verify-fingerprint': 'fingerprint-verified',
  'name-device': 'device-named',
  'choose-capabilities': 'child-capabilities-selected',
  'launch-child': 'sidecar-ready',
}

const CHILD_NEXT: Readonly<Partial<Record<ChildWizardStep, ChildWizardStep>>> = {
  'enter-pairing-offer': 'verify-fingerprint',
  'verify-fingerprint': 'name-device',
  'name-device': 'choose-capabilities',
  'choose-capabilities': 'launch-child',
  'launch-child': 'complete',
}

const MAIN_STEPS = new Set<MainWizardStep>([
  'choose-data-directory',
  'initialize-main',
  'configure-provider',
  'choose-local-capabilities',
  'launch-main',
  'complete',
])

const CHILD_STEPS = new Set<ChildWizardStep>([
  'enter-pairing-offer',
  'verify-fingerprint',
  'name-device',
  'choose-capabilities',
  'launch-child',
  'complete',
])

export class InvalidWizardTransitionError extends Error {
  constructor(state: WizardState, event: WizardEvent) {
    super(`Cannot apply ${event.type} while wizard is at ${state.mode ?? 'unselected'}:${state.step}`)
    this.name = 'InvalidWizardTransitionError'
  }
}

export function createWizardState(): UnselectedWizardState {
  return { version: 1, revision: 0, mode: null, step: 'choose-role' }
}

export function transitionWizard(state: WizardState, event: WizardEvent): WizardState {
  if (state.mode === null) {
    if (event.type !== 'select-role') throw new InvalidWizardTransitionError(state, event)
    if (event.mode === 'main') return {
      version: 1,
      revision: state.revision + 1,
      mode: 'main',
      step: 'choose-data-directory',
    }
    return {
      version: 1,
      revision: state.revision + 1,
      mode: 'child',
      step: 'enter-pairing-offer',
    }
  }

  if (state.mode === 'main') {
    const next = MAIN_NEXT[state.step]
    if (MAIN_TRANSITIONS[state.step] !== event.type || next === undefined) {
      throw new InvalidWizardTransitionError(state, event)
    }
    return { ...state, revision: state.revision + 1, step: next }
  }

  const next = CHILD_NEXT[state.step]
  if (CHILD_TRANSITIONS[state.step] !== event.type || next === undefined) {
    throw new InvalidWizardTransitionError(state, event)
  }
  return { ...state, revision: state.revision + 1, step: next }
}

export function parseWizardState(value: unknown): WizardState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Wizard state must be an object')
  }

  const candidate = value as Record<string, unknown>
  const fields = Object.keys(candidate)
  if (fields.some((field) => !['version', 'revision', 'mode', 'step'].includes(field))) {
    throw new TypeError('Wizard state contains unknown fields')
  }
  if (candidate.version !== 1) throw new TypeError('Unsupported wizard state version')
  if (!Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 0) {
    throw new TypeError('Wizard state revision must be a non-negative integer')
  }

  const mode = candidate.mode
  const step = candidate.step
  if (mode === null && step === 'choose-role') return candidate as unknown as UnselectedWizardState
  if (mode === 'main' && typeof step === 'string' && MAIN_STEPS.has(step as MainWizardStep)) {
    return candidate as unknown as MainWizardState
  }
  if (mode === 'child' && typeof step === 'string' && CHILD_STEPS.has(step as ChildWizardStep)) {
    return candidate as unknown as ChildWizardState
  }
  throw new TypeError('Wizard state mode and step are incompatible')
}