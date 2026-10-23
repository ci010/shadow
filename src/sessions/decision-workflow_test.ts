import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { decisionBrief } from '../testing/decision.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionState, SessionStore } from './session-store.ts'
import { physicalSessionId } from './session-identity.ts'
import { parseDecisionBrief, type DecisionEvidence } from './decision-brief.ts'
import { YieldRecords } from './yield-records.ts'
import { YieldManager } from './yield.ts'
import type { YieldOutcome, YieldReference, YieldRequest } from './yield-contract.ts'

const question = { question: 'Expand the grader integration scope?', options: ['Expand', 'Keep scope'] as [string, string],
  defaultOption: 'Keep scope', brief: decisionBrief }
const reference = (request: YieldRequest): YieldReference => ({
  sessionId: request.sessionId, physicalId: request.origin!.physicalId, requestId: request.id,
})
const userGoal = "Run fresh Off/On evaluation using the grader on Herman's branch, at most four runs."

test('grader replay: an agent recommendation cannot be relabeled as a user constraint', () => {
  const evidence: DecisionEvidence = { sessionId: 'web:coord', physicalId: 'segment', kind: 'user', id: 'user-goal', quote: userGoal }
  assert.throws(() => parseDecisionBrief({ ...decisionBrief,
    claims: [{ kind: 'user_constraint', text: 'The user required v6 exclusively.', evidence }] }), /quote.*exactly/)
  assert.throws(() => parseDecisionBrief({ ...decisionBrief,
    claims: [{ kind: 'user_constraint', text: 'Use v6', evidence: { ...evidence, kind: 'tool', quote: 'Use v6' } }] }), /user constraint/)
  assert.throws(() => parseDecisionBrief({ ...decisionBrief, claims: [{ kind: 'observation', text: 'No fresh pipeline exists.' }] }), /require source evidence/)
  const brief = parseDecisionBrief({ ...decisionBrief, goal: 'Fresh Off/On evaluation, not reproduction of a historical score.',
    claims: [{ kind: 'user_constraint', text: userGoal, evidence }, { kind: 'proposal', text: 'Use v6 policy.' },
      { kind: 'assumption', text: 'The historical v6 adapter may not be the only evaluation entry point.' }] })
  assert.equal(brief.claims[1]?.kind, 'proposal')
  assert.equal(brief.claims[0]?.text, userGoal)
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: grader investigation, deferral and invalidation preserve independent work and real provenance`, async () => {
    await withTempWorkspace(async workspace => {
      const path = join(workspace, 'sessions')
      let store: SessionStore = new Store(path)
      await store.init()
      const states: Record<string, SessionState> = Object.fromEntries(['coord', 'grader', 'consumer', 'independent'].map(name =>
        [`web:${name}`, { sessionId: `web:${name}`, segmentIndex: 0, physicalIdVersion: 2 as const }]))
      for (const state of Object.values(states)) await store.saveState(state.sessionId, state)
      const records = new YieldRecords(store, id => states[id])
      const manager = new YieldManager({ journal: records, getState: id => states[id], getPolicy: () => ({ timeoutMs: null }),
        notifyUser: async () => {}, notifyParent: async () => {} })
      const waiting: Promise<YieldOutcome>[] = []
      const ask = async (id: string, input = question) => {
        const result = manager.ask(id, input, new AbortController().signal)
        waiting.push(result)
        await manager.settled()
        return { result, request: manager.get(id)! }
      }
      try {
        const physicalId = physicalSessionId(states['web:coord']!)
        await store.appendRawEvents(physicalId, [{ decision_input: { id: 'user-goal', text: userGoal } },
          { role: 'user', content: '<sender source="session" />The user required v6 exclusively.', timestamp: new Date().toISOString() }])
        const evidence: DecisionEvidence = { sessionId: 'web:coord', physicalId, kind: 'user', id: 'user-goal', quote: userGoal }
        await records.evidence(evidence)
        await assert.rejects(records.evidence({ ...evidence, quote: 'The user required v6 exclusively.' }), /does not match/)
        await assert.rejects(records.evidence({ ...evidence, sessionId: 'outside-project' }), /not found/)
        assert.equal((await records.context('web:coord')).userInputs[0]?.quote, userGoal)
        states['web:coord']!.segmentIndex = 1
        await store.saveState('web:coord', states['web:coord']!)
        assert.equal((await records.context('web:coord')).userInputs[0]?.physicalId, physicalId, 'Handoff retains genuine original-goal references')

        const original = await ask('web:grader', { ...question, brief: { ...decisionBrief,
          claims: [{ kind: 'user_constraint', text: userGoal, evidence }, { kind: 'proposal', text: 'Adopt historical v6 policy.' }] } })
        const independent = await ask('web:independent')
        const returned = await manager.continueUser('web:grader', original.request.id, 'investigation', "Check the existing pipeline on Herman's branch before proposing an adapter.")
        assert.deepEqual(await original.result, returned)
        assert.equal(returned.approved, false)
        assert.equal(returned.option, undefined)
        assert.equal(manager.get('web:independent')?.id, independent.request.id)
        assert.throws(() => manager.answerUser('web:grader', original.request.id, 'Expand'), /not found/)

        const renewedInput = { ...question, reconsiders: reference(original.request) }
        const renewedResult = manager.ask('web:grader', renewedInput, new AbortController().signal)
        waiting.push(renewedResult)
        await manager.settled()
        const renewed = manager.get('web:grader')!
        await manager.answerUser('web:grader', renewed.id, 'Keep scope')
        assert.equal((await renewedResult).option, 'Keep scope')
        const dependentResult = manager.ask('web:consumer', { ...question, sources: [reference(renewed)] }, new AbortController().signal)
        waiting.push(dependentResult)
        await manager.settled()
        const dependent = manager.get('web:consumer')!
        const { affected, scanErrors } = await records.invalidate(reference(renewed), 'A fresh pipeline exists; the historical-only premise was wrong.')
        assert.deepEqual(scanErrors, [])
        assert.equal(affected.length, 2)
        await manager.invalidatePending(reference(dependent), 'The cited premise was disproven.')
        assert.equal((await dependentResult).approved, false)
        assert.equal((await records.read('web:grader')).find(item => item.request.id === renewed.id)?.answer?.option, 'Keep scope', 'Invalidation never rewrites an actual human answer')
        assert.ok((await records.read('web:consumer'))[0]?.invalidated)
        assert.equal((await records.read('web:independent'))[0]?.invalidated, undefined)
        const obsolete = records.open({ ...renewed, id: 'obsolete', sources: [reference(renewed)] })
        await assert.rejects(obsolete, /needs revalidation/)
        const reconsidered = await records.open({ ...renewed, id: 'corrected', sources: undefined, reconsiders: reference(renewed) })
        assert.equal((await records.read('web:grader')).find(item => item.request.id === reconsidered.id)?.invalidated, undefined)
        await manager.continueUser('web:independent', independent.request.id, 'deferred', 'Keep this scope blocked; read the existing documentation instead.')
        assert.equal((await independent.result).approved, false)
        await manager.settled()
        store.close?.()
        store = new Store(path)
        await store.init()
        const restored = new YieldRecords(store, id => states[id])
        assert.ok((await restored.read('web:consumer'))[0]?.invalidated)
        assert.equal((await restored.read('web:independent'))[0]?.closed?.reason, 'deferred')
        assert.equal((await restored.read('web:grader'))[0]?.request.brief?.claims[0]?.evidence?.quote, userGoal)
        const broken: SessionState = { sessionId: 'web:broken', segmentIndex: 0, physicalIdVersion: 2 }
        states[broken.sessionId] = broken
        await store.saveState(broken.sessionId, broken)
        await store.appendRawEvents(physicalSessionId(broken), [{ yield_decision: { version: 99 } }])
        const partial = await restored.invalidate(reference(renewed), 'Retry propagation')
        assert.equal(partial.affected.length, 2, 'A broken unrelated segment cannot prevent available dependents from being notified')
        assert.equal(partial.scanErrors[0]?.sessionId, broken.sessionId)
        assert.match(partial.scanErrors[0]!.message, /Unsupported decision record version/)
      } finally {
        manager.stop()
        await manager.settled()
        await Promise.allSettled(waiting)
        store.close?.()
      }
    })
  })
}
