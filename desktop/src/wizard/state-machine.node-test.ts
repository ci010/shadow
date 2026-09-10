import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createWizardState,
  InvalidWizardTransitionError,
  parseWizardState,
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
    { type: 'local-capabilities-selected' },
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