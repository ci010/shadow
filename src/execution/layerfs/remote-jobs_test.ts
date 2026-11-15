import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { ProjectCatalog } from '../../projects/catalog.ts'
import { managedProjectScope } from '../managed-workdir.ts'
import { RemoteLayerFSJobReservations } from './remote-jobs.ts'
import { inspectRemoteBootstrapTerminal } from './remote-bootstrap-journal.ts'
import { projectDataPaths } from '../../utils/data-paths.ts'
import { ProjectFolderDiscovery } from '../../folders/discovery.ts'
import type { ExecutionContext } from '../../tools/context.ts'

test('durable target bootstrap guard blocks Project deletion across Main restart/disconnect and releases only exact verified terminal target evidence', async () => withTempWorkspace(async home => {
  const first = new ProjectCatalog(home); await first.init()
  const project = await first.create('Remote bootstrap')
  const target = { nodeId: 'windows', pairingId: 'paired-one', projectScope: managedProjectScope(project.id) }
  const requestId = randomUUID(), targetJobId = 'layerfs-target:' + randomUUID()
  const approval = { sessionId: 'web:owner', physicalId: 'physical', requestId: 'actual-main-decision' }
  new RemoteLayerFSJobReservations(project.id, first).reserve(target, requestId, approval)
  await assert.rejects(first.remove(project.id), /remote job/)
  // New Main catalog and proxy have no in-memory state from admission.
  const restarted = new ProjectCatalog(home); await restarted.init()
  const jobs = new RemoteLayerFSJobReservations(project.id, restarted, id => restarted.recordRemoteJob(project.id, id, false))
  restarted.recordRemoteJob(project.id, requestId, true) // lost typed dispatch receipt also retained
  assert.equal(jobs.list().length, 1)
  const discovery = new ProjectFolderDiscovery({ projectId: project.id, workspace: home, getProject: () => restarted.get(project.id), registry: { list: () => [] }, workdirLookup: () => ({ node: 'offline' }), remoteLayerFSJobs: () => jobs.list() })
  const offlineMetadata = String(await discovery.handlers().read('remote-layerfs-jobs', { projectId: project.id } as ExecutionContext))
  assert.match(offlineMetadata, /windows/); assert.match(offlineMetadata, new RegExp(requestId)); assert.match(offlineMetadata, /Cancellation\/disconnect\/unknown/)
  jobs.admitted(target, requestId, targetJobId)
  await assert.rejects(restarted.remove(project.id), /remote job/)
  const targetHome = join(home, 'target-fixture'), directory = join(projectDataPaths(targetHome).state, 'layerfs', 'bootstrap')
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'bootstrap.json')
  const journal = { version: 1, projectId: target.projectScope, sessionId: approval.sessionId, executionId: 'bg:' + targetJobId.slice('layerfs-target:'.length), approval, phase: 'uncertain', step: 'build', provisioningStarted: true, diagnostic: { launcherExited: false, reason: 'cancelled' } }
  await writeFile(path, JSON.stringify(journal))
  const unknown = await inspectRemoteBootstrapTerminal(targetHome, target, targetJobId, false)
  assert.equal(unknown.terminal, false)
  assert.equal(jobs.release(target, unknown).released, 0)
  assert.throws(() => jobs.release(target, { ...unknown, terminal: true }), /Inconsistent/)
  await assert.rejects(restarted.remove(project.id), /remote job/)
  await writeFile(path, JSON.stringify({ ...journal, phase: 'ready', step: 'complete' }))
  const active = await inspectRemoteBootstrapTerminal(targetHome, target, targetJobId, true)
  assert.equal(active.terminal, false)
  const terminal = await inspectRemoteBootstrapTerminal(targetHome, target, targetJobId, false)
  assert.equal(terminal.terminal, true)
  assert.throws(() => jobs.release({ ...target, pairingId: 'repaired' }, terminal), /pairing mismatch/)
  assert.throws(() => new RemoteLayerFSJobReservations('foreign', restarted).release(target, terminal), /Project\/pairing mismatch/)
  assert.equal(jobs.release(target, { ...terminal, approval: { ...approval, requestId: 'other-consent' } }).released, 0)
  assert.equal(jobs.release(target, { ...terminal, targetJobId: 'layerfs-target:' + randomUUID() }).released, 0)
  assert.equal(jobs.release(target, terminal).released, 1)
  assert.deepEqual(restarted.remoteJobIds(project.id), [])
  await restarted.remove(project.id)
  assert.equal(restarted.get(project.id), undefined)
}))

test('lost-admission proxy can reconcile canonical archived job evidence without replay; wrong Project or missing journal cannot release', async () => withTempWorkspace(async home => {
  const catalog = new ProjectCatalog(home); await catalog.init()
  const project = await catalog.create('Lost response')
  const target = { nodeId: 'windows', pairingId: 'pair', projectScope: managedProjectScope(project.id) }
  const approval = { sessionId: 'web:owner', physicalId: 'physical', requestId: 'human-decision' }, requestId = randomUUID(), targetJobId = 'layerfs-target:' + randomUUID()
  const jobs = new RemoteLayerFSJobReservations(project.id, catalog)
  jobs.reserve(target, requestId, approval) // crash before Main observes targetJobId
  const targetHome = join(home, 'target'), history = join(projectDataPaths(targetHome).state, 'layerfs', 'bootstrap', 'history')
  await mkdir(history, { recursive: true })
  const path = join(history, 'a'.repeat(32) + '-blocked.json')
  const journal = { version: 1, projectId: target.projectScope, sessionId: approval.sessionId, executionId: 'bg:' + targetJobId.slice('layerfs-target:'.length), approval, phase: 'blocked', step: 'build', provisioningStarted: true, diagnostic: { launcherExited: true, reason: 'exit' } }
  await writeFile(path, JSON.stringify({ ...journal, projectId: 'foreign' }))
  await assert.rejects(inspectRemoteBootstrapTerminal(targetHome, target, targetJobId, false), /Foreign/)
  assert.equal(jobs.list().length, 1)
  await writeFile(path, JSON.stringify(journal))
  await assert.rejects(inspectRemoteBootstrapTerminal(targetHome, target, 'layerfs-target:' + randomUUID(), false), /unavailable/)
  const proof = await inspectRemoteBootstrapTerminal(targetHome, target, targetJobId, false)
  assert.equal(jobs.release(target, proof).released, 1)
  assert.deepEqual(jobs.list(), [])
}))
