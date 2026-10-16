import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { SYSTEM_AUTOMATIONS, resolveAutomationSession } from '../cron/contracts.ts'
import { SessionTool } from '../tools/session.ts'

test('automatic metadata observer is retired while manual organization and historical receipts survive', async () => {
  assert.equal(Object.values(SYSTEM_AUTOMATIONS).some(job => String(job.id) === 'system:work-observer'), false)
  assert.equal(SYSTEM_AUTOMATIONS.organizer.id, 'system:work-organizer')
  assert.equal(resolveAutomationSession({ sessionId: 'work-observer:work-observer-1750000000001', agentType: 'work-observer' })?.jobId, 'system:work-observer')
  const runtime = await readFile(new URL('../runtime/main/project-runtime.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(runtime, /WorkObserver|workObserver|summarize:|updateTitle:/)
  assert.match(runtime, /new OrganizationController/)
  assert.match(runtime, /organize: runOrganization/)
  assert.match(runtime, /organizationController.update\(newConfig.organization.enabled\)/)

})

test('tool and inline guidance expose explicit self metadata, completion and reopening, not routing', async () => {
  const tool = new SessionTool({} as never)
  assert.ok((tool.parameters.properties?.action as { enum: string[] }).enum.includes('update_self'))
  const guidance = await readFile(new URL('../agent/context/tools-guideline.ts', import.meta.url), 'utf8')
  assert.match(guidance, /session action=update_self/)
  assert.match(guidance, /completed:true/)
  assert.match(guidance, /completed:false/)
  assert.match(guidance, /independent of inferred running\/waiting activity/)
  assert.match(guidance, /Title and description are parent-owned/)
  assert.match(guidance, /supply both explicitly/)
})

test('legacy config keeps only independent organizer preferences and ignores observer model/enable switches', async () => {
  const { normalizePersistedConfig } = await import('../config/loader.ts')
  const { ConfigSchema } = await import('../config/schema.ts')
  const raw = normalizePersistedConfig({ workObserver: { enabled: true, model: 'retired-model', organizerEnabled: false, organizerModel: 'organizer-model' } })
  assert.equal('workObserver' in raw, false)
  assert.deepEqual(ConfigSchema.parse(raw).organization, { enabled: false, model: 'organizer-model' })
  assert.deepEqual(ConfigSchema.parse(normalizePersistedConfig({ workObserver: { enabled: true, model: 'retired-model' } })).organization, { enabled: true })
  assert.deepEqual(ConfigSchema.parse(normalizePersistedConfig({ organization: { enabled: true }, workObserver: { organizerEnabled: false } })).organization, { enabled: true })
})
