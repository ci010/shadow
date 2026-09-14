import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { AgentTypesManager } from './agent-types/manager.ts'
import { sessionPlugin } from './routes.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { isExecutionMode } from '../sessions/execution-mode.ts'

test('agent role API exposes default execution mode rather than a lifetime flag', async () => {
  await withTempWorkspace(async workspace => {
    const roles = new AgentTypesManager(workspace)
    await roles.load()
    const app = new Hono()
    await sessionPlugin(undefined, undefined, roles)(app)
    const response = await app.request('/debug/agent-types')
    assert.equal(response.status, 200)
    const body: unknown = await response.json()
    assert(Array.isArray(body))
    const listed = body.map((role: unknown) => {
      assert(role && typeof role === 'object' && 'name' in role && 'defaultMode' in role)
      assert(isExecutionMode(role.defaultMode))
      assert.equal('ephemeral' in role, false)
      return role
    })
    const verify = listed.find(role => role.name === 'verify')
    assert(verify && 'allowedTools' in verify)
    assert.equal(verify.defaultMode, 'task')
    assert.equal(listed.find(role => role.name === 'general')?.defaultMode, 'session')
    assert.deepEqual(verify.allowedTools, ['read', 'search', 'exec', 'yield'])
  })
})
