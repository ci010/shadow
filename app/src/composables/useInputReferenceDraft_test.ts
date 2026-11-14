import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, ref } from 'vue'
import { useInputReferenceDraft } from './useInputReferenceDraft.ts'
import type { LabeledInputReference } from '../workflow-input-references.ts'
const item = (workflowId: string): LabeledInputReference => ({ label: workflowId, reference: { kind: 'workflow', projectId: 'p', workflowId, revision: 1 } })
test('draft switching, captured sends, admission cleanup, failures and migration', () => {
  const scope = effectScope()
  scope.run(() => {
    const key = ref('draft'), draft = useInputReferenceDraft(key)
    draft.append(item('a'))
    const sent = draft.capture()
    draft.append(item('b'))
    key.value = 'other'
    assert.equal(draft.items.value.length, 0)
    draft.append(item('c'))
    // Admission on another composer clears only the captured payload there.
    draft.admitted('draft', sent)
    assert.deepEqual(draft.items.value.map(i => i.label), ['c'])
    key.value = 'draft'
    assert.deepEqual(draft.items.value.map(i => i.label), ['b'])
    // Failed sends never call admitted and leave references intact.
    assert.equal(draft.capture()[0]!.workflowId, 'b')
    draft.migrate('prepared-session')
    key.value = 'prepared-session'
    assert.deepEqual(draft.items.value.map(i => i.label), ['b'])
    draft.items.value.splice(0, 1)
    assert.deepEqual(draft.capture(), [])
  })
  scope.stop()
})
