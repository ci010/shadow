import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { evaluateScriptCases } from './evaluate.ts'
import { executeScript, type ScriptOptions } from './runtime.ts'

test('evaluation and production execute the same source with different module bindings', async () => {
  const code = `import lookup from '@shadow/lookup'; export async function run(args) { return (await lookup(args)).value * 2 }`
  const options: Omit<ScriptOptions, 'args' | 'callModule'> = {
    code, entry: 'run', signal: new AbortController().signal,
    policy: { kind: 'restricted', imports: ['@shadow/lookup'], mode: 'test' },
  }
  const report = await evaluateScriptCases(options, [
    { name: 'match', args: { id: 1 }, expected: 6, callModule: async () => ({ value: 3 }) },
    { name: 'mismatch', args: { id: 2 }, expected: 10, callModule: async () => ({ value: 4 }) },
    { name: 'failure', args: { id: 3 }, expected: 0, callModule: async () => { throw new Error('private callback detail') } },
  ])
  assert.equal(report.sourceHash, createHash('sha256').update(code).digest('hex'))
  assert.deepEqual(report.policy, options.policy)
  assert.equal(report.passed, false)
  assert.deepEqual(report.cases.map(item => item.passed), [true, false, false])
  assert.equal(report.cases[1].actual, 8)
  assert.doesNotMatch(report.cases[2].error!, /private callback detail/)
  const live = await executeScript({
    ...options, args: { id: 1 }, policy: { kind: 'restricted', imports: ['@shadow/lookup'], mode: 'live' },
    callModule: async () => ({ value: 3 }),
  })
  assert.equal(report.cases[0].actual, live.value)
})

test('evaluation refuses ambiguous expected values and propagates cancellation', async () => {
  const controller = new AbortController()
  const options = {
    code: 'export function run(args) { return args }', entry: 'run' as const,
    policy: { kind: 'restricted' as const, imports: [] }, signal: controller.signal,
  }
  await assert.rejects(evaluateScriptCases(options, []), /At least one/)
  await assert.rejects(evaluateScriptCases(options, [{ name: 'invalid', args: {}, expected: undefined }]), /JSON/)
  controller.abort(new Error('Evaluation cancelled'))
  await assert.rejects(evaluateScriptCases(options, [{ name: 'cancelled', args: {}, expected: {} }]), /Evaluation cancelled/)
})
