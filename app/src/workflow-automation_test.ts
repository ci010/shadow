import assert from 'node:assert/strict'
import test from 'node:test'
import { workflowAutomation, automationWorkflowId } from './workflow-automation.ts'
import type { AutomationSummary } from './automations.ts'
const job = (id: string, workflow?: string): AutomationSummary => ({ id, name: 'Same name', source: 'cron', session: 'fresh', schedule: 'daily', enabled: true, editable: false, ...(workflow ? { workflow: { id: workflow, pending: 0, blocked: 0 } } : {}) })
test('workflow profiles use exact catalog associations, never names or guessed schedule IDs', () => {
  const a = job('a', 'schedule:one'), b = job('b', 'schedule:two')
  assert.equal(workflowAutomation([a, b], 'schedule:one'), a)
  assert.equal(workflowAutomation([a, b], 'schedule:two'), b)
  assert.equal(workflowAutomation([job('one')], 'schedule:one'), undefined)
  assert.equal(workflowAutomation([a, job('duplicate', 'schedule:one')], 'schedule:one'), undefined)
  assert.equal(workflowAutomation([a, b], ''), undefined)
  assert.equal(workflowAutomation([a, b], 'external:one'), undefined)
})
test('the host organizer uses its fixed controller identity and explicit metadata takes precedence', () => {
  assert.equal(automationWorkflowId(job('system:work-organizer')), 'internal:work-organizer')
  assert.equal(automationWorkflowId(job('system:other')), undefined)
  assert.equal(automationWorkflowId(job('system:work-organizer', 'explicit')), 'explicit')
})
