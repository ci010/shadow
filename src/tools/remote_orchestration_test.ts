import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BackgroundTaskManager } from '../agent/background-task.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { ExecutionContext } from './context.ts'
import { CancelTool } from './cancel.ts'
import { ContinuationTool } from './background.ts'
import { SessionTools, Tools } from './registry.ts'

function fixture(terminalReceipt = true) {
  const owner = 'web:owner'
  const worker = 'virtual:worker'
  const calls: string[] = []
  let actorProject = 'p'
  let delegationOwner = owner
  let executionStatus = 'running'
  const sessions = {
    getSessionState: (id: string) => id === owner
      ? { projectId: actorProject, mode: 'session' }
      : id === worker ? { projectId: 'p', mode: 'task', parentSessionId: delegationOwner, executionStatus } : undefined,
    getDelegationOwner: () => delegationOwner,
    assertFolderAccess: (id: string) => { calls.push(`access:${id}`) },
    getActiveSession: () => ({ cancel: () => { calls.push('cancel') }, completion: Promise.resolve().then(() => {
      calls.push('stopped')
      if (terminalReceipt) executionStatus = 'cancelled'
    }) }),
  } as unknown as SessionManager
  const tasks = {
    cancelTask: async (id: string) => { calls.push(`cancel-bg:${id}`); return 'cancelled' },
    assertOwner: (_context: ExecutionContext, id: string) => { calls.push(`owner:${id}`) },
    setContinuation: (id: string, text: string) => { calls.push(`continuation:${id}:${text}`); return 'updated' },
  } as unknown as BackgroundTaskManager
  const registry = new Tools(process.cwd())
  registry.register(new CancelTool(sessions, undefined, tasks))
  registry.register(new ContinuationTool(tasks, sessions))
  const tools = new SessionTools(registry, process.cwd())
  tools.setExecutionScope('session', ['task', 'call'])
  const context = {
    projectId: 'p', sessionId: owner, signal: new AbortController().signal, tools,
    cwd: 'DO-NOT-RESOLVE-ON-MAIN',
    remoteWorkdir: { nodeId: 'child', workdirId: 'opaque', executor: {
      execute: () => assert.fail('Control-plane tools must not execute a Child command'),
    } },
  } as unknown as ExecutionContext
  return { tools, context, calls, worker,
    denyProject: () => { actorProject = 'other' },
    denyOwnership: () => { delegationOwner = 'web:other' },
  }
}

test('remote session can cancel owned background work and update its continuation through registry', async () => {
  const f = fixture()
  assert.equal(await f.tools.execute('continuation', { executionId: 'bg:0123456789abcdef', continuation: 'report result' }, f.context), 'updated')
  assert.match(String(await f.tools.execute('cancel', { executionId: 'bg:0123456789abcdef' }, f.context)), /cancelled/)
  assert(f.calls.includes('owner:0123456789abcdef'))
  assert(f.calls.includes('continuation:0123456789abcdef:report result'))
  assert(f.calls.includes('cancel-bg:0123456789abcdef'))
})

test('remote cancellation reaches owned worker and awaits its cleanup, not Child filesystem', async () => {
  const f = fixture()
  const result = await f.tools.execute('cancel', { executionId: f.worker }, f.context)
  assert.equal(JSON.parse(String(result)).status, 'cancelled')
  assert(f.calls.indexOf('cancel') >= 0)
  assert(f.calls.indexOf('stopped') > f.calls.indexOf('cancel'))
})

test('remote cancellation does not fabricate success without a terminal receipt', async () => {
  const f = fixture(false)
  assert.match(String(await f.tools.execute('cancel', { executionId: f.worker }, f.context)), /without a terminal receipt/)
})

test('remote orchestration keeps Project and delegation ownership checks', async () => {
  const f = fixture()
  f.denyOwnership()
  assert.match(String(await f.tools.execute('cancel', { executionId: f.worker }, f.context)), /access denied/)
  assert(!f.calls.includes('cancel'))
  f.denyProject()
  for (const [name, args] of [
    ['cancel', { executionId: 'bg:0123456789abcdef' }],
    ['continuation', { executionId: 'bg:0123456789abcdef', continuation: 'no' }],
  ] as const) {
    assert.match(String(await f.tools.execute(name, args, f.context)), /owning session in this Project/)
  }
  assert(!f.calls.some(call => call.startsWith('cancel-bg:') || call.startsWith('continuation:')))
})
