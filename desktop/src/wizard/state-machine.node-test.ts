import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createWizardState,
  InvalidWizardTransitionError,
  parseWizardState,
  parseWizardEvent,
  transitionWizard,
  type WizardEvent,
  type WizardState,
} from './state-machine.js'

function apply(state: WizardState, events: readonly WizardEvent[]): WizardState {
  return events.reduce(transitionWizard, state)
}

test('Main wizard follows the frozen sequence and resumes from serialized state', () => {
  const interrupted = apply(createWizardState(), [
    { type: 'select-role', mode: 'main' },
    { type: 'data-directory-selected' },
    { type: 'main-initialized' },
  ])
  const resumed = parseWizardState(JSON.parse(JSON.stringify(interrupted)))

  assert.deepEqual(resumed, {
    version: 1,
    revision: 3,
    mode: 'main',
    step: 'configure-provider',
  })
  assert.equal(apply(resumed, [
    { type: 'provider-configured' },
    { type: 'sidecar-ready' },
  ]).step, 'complete')
})

test('Child wizard follows the frozen sequence and resumes from serialized state', () => {
  const interrupted = apply(createWizardState(), [
    { type: 'select-role', mode: 'child' },
    { type: 'pairing-offer-entered' },
    { type: 'fingerprint-verified' },
  ])
  const resumed = parseWizardState(JSON.parse(JSON.stringify(interrupted)))

  assert.equal(resumed.step, 'name-device')
  assert.equal(apply(resumed, [
    { type: 'device-named' },
    { type: 'child-capabilities-selected' },
    { type: 'sidecar-ready' },
  ]).step, 'complete')
})

test('wizard rejects skipped, cross-role, and incompatible restored states', () => {
  const main = transitionWizard(createWizardState(), { type: 'select-role', mode: 'main' })
  assert.throws(
    () => transitionWizard(main, { type: 'pairing-offer-entered' }),
    InvalidWizardTransitionError,
  )
  assert.throws(
    () => parseWizardState({ version: 1, revision: 2, mode: 'child', step: 'configure-provider' }),
    /incompatible/,
  )
  assert.throws(
    () => parseWizardState({ version: 1, revision: 0, mode: null, step: 'choose-role', token: 'nope' }),
    /unknown fields/,
  )
})
test('Main role choice persists execution preference and no longer has a separate capability step', () => {
  for (const localExecutor of [true, false]) {
    const state = transitionWizard(createWizardState(), parseWizardEvent({ type: 'select-role', mode: 'main', localExecutor }))
    assert.equal(state.mode === 'main' && state.localExecutor, localExecutor)
    const ready = apply(parseWizardState(JSON.parse(JSON.stringify(state))), [
      { type: 'data-directory-selected' }, { type: 'main-initialized' }, { type: 'provider-configured' },
    ])
    assert.equal(ready.step, 'launch-main')
    assert.equal(ready.mode === 'main' && ready.localExecutor, localExecutor)
  }
})

test('legacy Main capability step resumes at launch without losing saved execution preference', () => {
  for (const preference of [{}, { localExecutor: false }, { localExecutor: true }]) {
    assert.deepEqual(parseWizardState({ version: 1, revision: 4, mode: 'main', step: 'choose-local-capabilities', ...preference }),
      { version: 1, revision: 4, mode: 'main', step: 'launch-main', ...preference })
  }
})

test('execution preference is a validated Main-only field at the IPC and persisted-state boundaries', () => {
  assert.deepEqual(parseWizardEvent({ type: 'select-role', mode: 'child' }), { type: 'select-role', mode: 'child' })
  for (const event of [
    { type: 'select-role', mode: 'child', localExecutor: false },
    { type: 'select-role', mode: 'main', localExecutor: 'false' },
    { type: 'provider-configured', localExecutor: false },
    { type: 'local-capabilities-selected' },
  ]) assert.throws(() => parseWizardEvent(event), TypeError)
  for (const state of [
    { version: 1, revision: 1, mode: 'child', step: 'enter-pairing-offer', localExecutor: false },
    { version: 1, revision: 1, mode: 'main', step: 'launch-main', localExecutor: 'false' },
  ]) assert.throws(() => parseWizardState(state), /localExecutor/)
})
