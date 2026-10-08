import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { ProcessManager } from '../execution/processes/manager.ts'
import type { MainCluster } from '../cluster/main-cluster.ts'
import type { CapabilityDescriptorV1 } from '../cluster/contracts.ts'
import { ConfigSchema } from '../config/schema.ts'
import { ManagedChildWorkdirs } from '../execution/managed-child-workdirs.ts'
import { MANAGED_SESSION_CAPABILITY } from '../execution/managed-workdir.ts'
import { LocalExecutor } from '../execution/local-executor.ts'
import { WORKDIR_IDENTITY_OPERATION } from '../execution/workdir-identity.ts'
import { createProjectRuntime } from './main/project-runtime.ts'
import { ProjectCatalog } from '../projects/catalog.ts'
import { ProjectConfigStore } from '../projects/config-store.ts'
import { createProjectScope } from '../projects/scope.ts'
import { folderFixture } from '../folders/test-fixtures.ts'
import { CopilotAuthenticator } from '../providers/copilot.ts'
import { ChromePortAllocator } from '../browser/chrome-manager.ts'

test('production project composition creates remote folders and sessions with opaque refs', { timeout: 60000 }, async t => {
  const { root, workspace, folders } = await folderFixture(t)
  const home = join(workspace, 'org-home')
  await mkdir(home)
  await writeFile(join(folders, 'child.txt'), 'Child runtime fixture')
  const catalog = new ProjectCatalog(join(root, 'catalog'))
  await catalog.init()
  const project = catalog.get('default')!
  const bindings = [{ capabilityId: 'folder', rootPath: folders }]
  const workdirs = new ManagedChildWorkdirs(join(root, 'child-managed'), 'child', bindings)
  await workdirs.init()
  const child = new LocalExecutor(new ProcessManager(), 'child', workdirs.operationHandlers)
  const descriptor: CapabilityDescriptorV1 = {
    version: 1, nodeId: 'child', capabilityId: 'folder', kind: 'workdir', displayName: 'Remote folder',
    displayPath: home, online: true, permissions: [WORKDIR_IDENTITY_OPERATION],
  }
  const cluster = {
    remoteExecutor: child,
    workdirCapabilityLookup: () => ({ node: 'online', capability: { kind: 'workdir', online: true } }),
    registry: { listCapabilities: () => [descriptor, ...workdirs.capabilities.filter(capability => capability.capabilityId !== 'folder')] },
    getNodeInventory: () => ({ version: 1, nodes: [{ nodeId: 'child', role: 'child', displayName: 'Child',
      connection: 'connected', supportsManagedSessions: true, capabilities: [descriptor, ...workdirs.capabilities.filter(capability => capability.capabilityId !== 'folder')] }] }),
  } as unknown as MainCluster
  const config = ConfigSchema.parse({ agent: { workspace: home, model: 'fixture@openai' },
    providers: { openai: { apiKey: 'fixture-not-used', baseUrl: 'http://127.0.0.1:1' } }, channels: {}, mcp: {} })
  const configStore = new ProjectConfigStore({ configPath: join(root, 'config', 'project.json'), home, getSharedConfig: () => config })
  const effective = await configStore.init(config)
  let scope = createProjectScope('default')
  const startRuntime = () => scope.run(() => createProjectRuntime(effective, {
    project, home, scope, catalog, configStore, mainCluster: cluster, copilotAuth: new CopilotAuthenticator(),
    chromePortAllocator: new ChromePortAllocator(), authorize: () => true,
  }))
  let runtime = await startRuntime()
  try {
    await runtime.ready
    const request = (path: string, body?: unknown) => runtime.app.request(path, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.deepEqual(await (await request('/api/folders')).json(), { folders: [] })
    const body = { nodeId: 'child', capabilityId: 'folder', requestId: randomUUID() }
    const created = await request('/api/sessions/remote', body)
    assert.equal(created.status, 201, await created.clone().text())
    const session = await created.json()
    assert(session.folderId)
    const folders = await (await request('/api/folders')).json()
    assert.equal(folders.folders[0].kind, 'remote')
    assert.equal(folders.folders[0].id, session.folderId)
    assert.equal((await (await request(`/api/folders/${session.folderId}/files`)).json()).entries[0].name, 'child.txt')
    const graph = await (await request('/api/sessions/graph')).json()
    assert.equal(graph.sessions[0].folderId, session.folderId)
    assert.equal(graph.sessions[0].projectId, 'default')
    const files = await request(`/api/sessions/${encodeURIComponent(session.sessionId)}/preview?path=child.txt`)
    assert.equal(files.status, 200)
    assert.equal((await files.json()).content, 'Child runtime fixture')
    const retry = await (await request('/api/sessions/remote', body)).json()
    assert.equal(retry.sessionId, session.sessionId)
    const second = await request(`/api/folders/${session.folderId}/sessions`, {})
    assert.equal(second.status, 200, await second.clone().text())
    const secondId = (await second.json()).sessionId
    assert.equal((await request(`/api/sessions/${encodeURIComponent(secondId)}/files`)).status, 200)
    const reopenedBody = { requestId: randomUUID() }
    const reopened = await Promise.all([request(`/api/folders/${session.folderId}/sessions`, reopenedBody),
      request(`/api/folders/${session.folderId}/sessions`, reopenedBody)])
    assert(reopened.every(result => result.status === 200), JSON.stringify(await Promise.all(reopened.map(result => result.clone().json()))))
    const reopenedIds = await Promise.all(reopened.map(result => result.json()))
    assert.equal(reopenedIds[0].sessionId, reopenedIds[1].sessionId)
    const reopenedRetry = await request(`/api/folders/${session.folderId}/sessions`, reopenedBody)
    assert.equal(reopenedRetry.status, 200, await reopenedRetry.clone().text())
    assert.equal((await reopenedRetry.json()).sessionId, reopenedIds[0].sessionId)
    assert.equal((await request(`/api/folders/${session.folderId}/sessions`, { requestId: 'bad' })).status, 400)
    const localFolder = join(root, 'local-folder')
    await mkdir(localFolder)
    const local = await (await request('/api/folders/register', { path: localFolder })).json()
    assert.equal((await request(`/api/folders/${local.folder.id}/sessions`, reopenedBody)).status, 409)
    assert.equal((await (await request('/api/sessions/graph')).json()).sessions.length, 3)
    const other = await catalog.create('Other')
    const moved = await request(`/api/folders/${session.folderId}/move`, { targetProjectId: other.id })
    assert.equal(moved.status, 200, await moved.clone().text())
    const transferred = (await moved.json()).folder
    assert.notEqual(transferred.id, session.folderId)
    assert.equal((await request(`/api/sessions/${encodeURIComponent(session.sessionId)}/files`)).status, 409)
    assert.equal((await request('/api/sessions/remote', body)).status, 409)
    assert.equal((await request(`/api/sessions/${encodeURIComponent(session.sessionId)}`)).status, 200)
    const returned = await catalog.changeFolderProject(other.id, transferred.id, 'default')
    assert(returned)
    assert.equal((await request(`/api/sessions/${encodeURIComponent(session.sessionId)}/preview?path=child.txt`)).status, 409)
    const fresh = await (await request(`/api/folders/${returned.id}/sessions`, {})).json()
    const freshFiles = await request(`/api/sessions/${encodeURIComponent(fresh.sessionId)}/preview?path=child.txt`)
    assert.equal(freshFiles.status, 200, await freshFiles.clone().text())
    assert.equal((await freshFiles.json()).content, 'Child runtime fixture')
    const coordinators = await Promise.all(Array.from({ length: 4 }, () => request('/api/orchestrator', {})))
    assert(coordinators.every(response => response.status === 200))
    const coordinatorIds = await Promise.all(coordinators.map(response => response.json()))
    assert(coordinatorIds.every(value => value.sessionId === 'web:orchestrator'))
    const topicRequest = {
      requestId: randomUUID(), title: 'Remote session', description: 'Registered remote folder only',
      folderId: returned.id,
    }
    const topicResponse = await request('/api/sessions', topicRequest)
    assert.equal(topicResponse.status, 200, await topicResponse.clone().text())
    const topic = await topicResponse.json()
    assert.equal(topic.folderId, returned.id)
    const topicFiles = await request(`/api/sessions/${encodeURIComponent(topic.sessionId)}/preview?path=child.txt`)
    assert.equal(topicFiles.status, 200, await topicFiles.clone().text())
    assert.equal((await topicFiles.json()).content, 'Child runtime fixture')
    assert.equal((await (await request('/api/sessions', topicRequest)).json()).sessionId, topic.sessionId)
    const topics = await (await request('/api/sessions/discover?query=Remote%20session')).json()
    assert.equal(topics.totalMatches, 1)
    assert.equal(topics.sessions[0].sessionId, topic.sessionId)
    const topicGraph = await (await request('/api/sessions/graph')).json()
    const coordinatorState = topicGraph.sessions.find((state: { sessionId: string }) => state.sessionId === 'web:orchestrator')
    assert.equal(coordinatorState.sessionKind, 'orchestrator')
    assert.equal(coordinatorState.folderId, undefined)
    assert.equal(coordinatorState.parentSessionId, null)
    const topicState = topicGraph.sessions.find((state: { sessionId: string }) => state.sessionId === topic.sessionId)
    assert.equal(topicState.title, 'Remote session')
    assert.equal(topicState.parentSessionId, null)
    assert.equal(topicState.description, topicRequest.description)
    assert.equal(topicState.topic, undefined)
    const localTopic = await request('/api/sessions', {
      title: 'Local session', description: 'Local folder', folderId: local.folder.id,
    })
    assert.equal(localTopic.status, 200, await localTopic.clone().text())
    assert.equal((await localTopic.json()).folderId, local.folder.id)
    assert.equal((await request('/api/sessions', { ...topicRequest, agentType: 'orchestrator' })).status, 400)
    const folderCount = catalog.folders().length
    const scratchBody = { nodeId: 'child', requestId: randomUUID() }
    const scratchResponse = await request('/api/sessions/remote', scratchBody)
    assert.equal(scratchResponse.status, 201, await scratchResponse.clone().text())
    const scratch = await scratchResponse.json()
    assert.equal(scratch.folderId, undefined)
    assert.equal(catalog.folders().length, folderCount)
    const allocated = workdirs.capabilities.find(capability => capability.capabilityId === scratch.workdir.capabilityId)!
    assert(allocated)
    assert.notEqual(allocated.capabilityId, MANAGED_SESSION_CAPABILITY)
    await writeFile(join(allocated.displayPath!, 'scratch.txt'), 'Independent Child session')
    const scratchPreview = await request(`/api/sessions/${encodeURIComponent(scratch.sessionId)}/preview?path=scratch.txt`)
    assert.equal(scratchPreview.status, 200, await scratchPreview.clone().text())
    assert.equal((await scratchPreview.json()).content, 'Independent Child session')
    const scratchGraph = await (await request('/api/sessions/graph')).json()
    const state = scratchGraph.sessions.find((item: { sessionId: string }) => item.sessionId === scratch.sessionId)
    assert.equal(state.projectId, 'default')
    assert.equal(state.folderId, undefined)
    assert.deepEqual(await (await request('/api/sessions/remote', scratchBody)).json(), scratch)
    await scope.run(() => runtime.shutdown())
    scope.close()
    scope = createProjectScope('default')
    runtime = await startRuntime()
    await runtime.ready
    const resumed = await request(`/api/sessions/${encodeURIComponent(scratch.sessionId)}/preview?path=scratch.txt`)
    assert.equal(resumed.status, 200, await resumed.clone().text())
    assert.equal((await resumed.json()).content, 'Independent Child session')
    assert.deepEqual(await (await request('/api/sessions/remote', scratchBody)).json(), scratch)
    assert.equal(catalog.folders().length, folderCount)
    assert(!catalog.folders().some(folder => folder.kind === 'remote' &&
      folder.workdir.capabilityId === scratch.workdir.capabilityId))
    const deleted = await runtime.app.request(`/api/sessions/${encodeURIComponent(scratch.sessionId)}`, { method: 'DELETE' })
    assert.equal(deleted.status, 200, await deleted.clone().text())
    assert.equal(await readFile(join(allocated.displayPath!, 'scratch.txt'), 'utf8'), 'Independent Child session')
  } finally {
    await scope.run(() => runtime.shutdown())
    scope.close()
  }
})
