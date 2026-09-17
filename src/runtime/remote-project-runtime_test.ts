import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { ProcessManager } from '../execution/processes/manager.ts'
import type { MainCluster } from '../cluster/main-cluster.ts'
import type { CapabilityDescriptorV1 } from '../cluster/contracts.ts'
import { ConfigSchema } from '../config/schema.ts'
import { CapabilityFilesystem } from '../execution/capability-filesystem.ts'
import { CapabilityWorkdirIdentity } from '../execution/capability-workdir-identity.ts'
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
  const child = new LocalExecutor(new ProcessManager(), 'child', [
    new CapabilityWorkdirIdentity(bindings), new CapabilityFilesystem(bindings),
  ])
  const descriptor: CapabilityDescriptorV1 = {
    version: 1, nodeId: 'child', capabilityId: 'folder', kind: 'workdir', displayName: 'Remote folder',
    displayPath: home, online: true, permissions: [WORKDIR_IDENTITY_OPERATION],
  }
  const cluster = {
    remoteExecutor: child,
    workdirCapabilityLookup: () => ({ node: 'online', capability: { kind: 'workdir', online: true } }),
    registry: { listCapabilities: () => [descriptor] },
    getNodeInventory: () => ({ version: 1, nodes: [{ nodeId: 'child', role: 'child', displayName: 'Child',
      connection: 'connected', capabilities: [descriptor] }] }),
  } as unknown as MainCluster
  const config = ConfigSchema.parse({ agent: { workspace: home, model: 'fixture@openai' },
    providers: { openai: { apiKey: 'fixture-not-used', baseUrl: 'http://127.0.0.1:1' } }, channels: {}, mcp: {} })
  const configStore = new ProjectConfigStore({ configPath: join(root, 'config', 'project.json'), home, getSharedConfig: () => config })
  const effective = await configStore.init(config)
  const scope = createProjectScope('default')
  const runtime = await scope.run(() => createProjectRuntime(effective, {
    project, home, scope, catalog, configStore, mainCluster: cluster, copilotAuth: new CopilotAuthenticator(),
    chromePortAllocator: new ChromePortAllocator(), authorize: () => true, gatewayBaseUrl: 'http://127.0.0.1:1', selfCodeRoot: process.cwd(),
  }))
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
    assert.equal((await (await request(`/api/folders/${session.folderId}/sessions`, reopenedBody)).json()).sessionId, reopenedIds[0].sessionId)
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
      requestId: randomUUID(), title: 'Remote topic', goal: 'Inspect child content', scope: 'Registered remote folder only',
      folderId: returned.id,
    }
    const topicResponse = await request('/api/topics', topicRequest)
    assert.equal(topicResponse.status, 200, await topicResponse.clone().text())
    const topic = await topicResponse.json()
    assert.equal(topic.folderId, returned.id)
    const topicFiles = await request(`/api/sessions/${encodeURIComponent(topic.sessionId)}/preview?path=child.txt`)
    assert.equal(topicFiles.status, 200, await topicFiles.clone().text())
    assert.equal((await topicFiles.json()).content, 'Child runtime fixture')
    assert.equal((await (await request('/api/topics', topicRequest)).json()).sessionId, topic.sessionId)
    const topics = await (await request('/api/topics?query=Remote%20topic')).json()
    assert.equal(topics.totalMatches, 1)
    assert.equal(topics.topics[0].sessionId, topic.sessionId)
    const topicGraph = await (await request('/api/sessions/graph')).json()
    const coordinatorState = topicGraph.sessions.find((state: { sessionId: string }) => state.sessionId === 'web:orchestrator')
    assert.equal(coordinatorState.sessionKind, 'orchestrator')
    assert.equal(coordinatorState.folderId, undefined)
    assert.equal(coordinatorState.parentSessionId, null)
    const topicState = topicGraph.sessions.find((state: { sessionId: string }) => state.sessionId === topic.sessionId)
    assert.equal(topicState.title, 'Remote topic')
    assert.equal(topicState.parentSessionId, null)
    assert.equal(topicState.topic.scope, topicRequest.scope)
    const localTopic = await request('/api/topics', {
      title: 'Local topic', goal: 'Separate work', scope: 'Local folder', folderId: local.folder.id,
    })
    assert.equal(localTopic.status, 200, await localTopic.clone().text())
    assert.equal((await localTopic.json()).folderId, local.folder.id)
    assert.equal((await request('/api/topics', { ...topicRequest, agentType: 'orchestrator' })).status, 400)
  } finally {
    await scope.run(() => runtime.shutdown())
    scope.close()
  }
})
