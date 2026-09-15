import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { ProcessManager } from '../agent/process-manager.ts'
import type { MainCluster } from '../cluster/main-cluster.ts'
import type { CapabilityDescriptorV1 } from '../cluster/contracts.ts'
import { ConfigSchema } from '../config/schema.ts'
import { CapabilityFilesystem } from '../execution/capability-filesystem.ts'
import { CapabilityWorkdirIdentity } from '../execution/capability-workdir-identity.ts'
import { LocalExecutor } from '../execution/local-executor.ts'
import { WORKDIR_IDENTITY_OPERATION } from '../execution/workdir-identity.ts'
import { createOrganizationRuntime } from '../index.ts'
import { OrganizationCatalog } from '../organizations/catalog.ts'
import { OrganizationConfigStore } from '../organizations/config-store.ts'
import { createOrganizationScope } from '../otel/scope.ts'
import { projectFixture } from '../projects/test-fixtures.ts'
import { CopilotAuthenticator } from '../providers/copilot.ts'
import { ChromePortAllocator } from '../utils/chrome-manager.ts'

test('production organization composition creates remote folder projects and sessions with opaque refs', { timeout: 60000 }, async t => {
  const { root, workspace, folders } = await projectFixture(t)
  const home = join(workspace, 'org-home')
  await mkdir(home)
  await writeFile(join(folders, 'child.txt'), 'Child runtime fixture')
  const catalog = new OrganizationCatalog(join(root, 'catalog'))
  await catalog.init()
  const organization = catalog.get('default')!
  const bindings = [{ capabilityId: 'folder', rootPath: folders }]
  const child = new LocalExecutor(new ProcessManager(), 'child', [
    new CapabilityWorkdirIdentity(bindings), new CapabilityFilesystem(bindings),
  ])
  const descriptor: CapabilityDescriptorV1 = {
    version: 1, nodeId: 'child', capabilityId: 'folder', kind: 'workdir', displayName: 'Remote folder',
    displayPath: home, online: true, permissions: [WORKDIR_IDENTITY_OPERATION], approvalPolicy: 'none',
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
  const configStore = new OrganizationConfigStore({ configPath: join(root, 'config', 'organization.json'), home, getSharedConfig: () => config })
  const effective = await configStore.init(config)
  const scope = createOrganizationScope('default')
  const runtime = await scope.run(() => createOrganizationRuntime(effective, {
    organization, home, scope, catalog, configStore, mainCluster: cluster, copilotAuth: new CopilotAuthenticator(),
    chromePortAllocator: new ChromePortAllocator(), authorize: () => true, gatewayBaseUrl: 'http://127.0.0.1:1', selfCodeRoot: process.cwd(),
  }))
  try {
    await runtime.ready
    const request = (path: string, body?: unknown) => runtime.app.request(path, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.deepEqual(await (await request('/api/projects')).json(), { projects: [] })
    const body = { nodeId: 'child', capabilityId: 'folder', requestId: randomUUID() }
    const created = await request('/api/sessions/remote', body)
    assert.equal(created.status, 201, await created.clone().text())
    const session = await created.json()
    assert(session.projectId)
    const projects = await (await request('/api/projects')).json()
    assert.equal(projects.projects[0].kind, 'remote')
    assert.equal(projects.projects[0].id, session.projectId)
    assert.equal((await (await request(`/api/projects/${session.projectId}/files`)).json()).entries[0].name, 'child.txt')
    const graph = await (await request('/api/sessions/graph')).json()
    assert.equal(graph.sessions[0].projectId, session.projectId)
    assert.equal(graph.sessions[0].organizationId, 'default')
    const files = await request(`/api/sessions/${encodeURIComponent(session.sessionId)}/preview?path=child.txt`)
    assert.equal(files.status, 200)
    assert.equal((await files.json()).content, 'Child runtime fixture')
    const retry = await (await request('/api/sessions/remote', body)).json()
    assert.equal(retry.sessionId, session.sessionId)
    const second = await request(`/api/projects/${session.projectId}/sessions`, {})
    assert.equal(second.status, 200, await second.clone().text())
    const secondId = (await second.json()).sessionId
    assert.equal((await request(`/api/sessions/${encodeURIComponent(secondId)}/files`)).status, 200)
    const reopenedBody = { requestId: randomUUID() }
    const reopened = await Promise.all([request(`/api/projects/${session.projectId}/sessions`, reopenedBody),
      request(`/api/projects/${session.projectId}/sessions`, reopenedBody)])
    assert(reopened.every(result => result.status === 200), JSON.stringify(await Promise.all(reopened.map(result => result.clone().json()))))
    const reopenedIds = await Promise.all(reopened.map(result => result.json()))
    assert.equal(reopenedIds[0].sessionId, reopenedIds[1].sessionId)
    assert.equal((await (await request(`/api/projects/${session.projectId}/sessions`, reopenedBody)).json()).sessionId, reopenedIds[0].sessionId)
    assert.equal((await request(`/api/projects/${session.projectId}/sessions`, { requestId: 'bad' })).status, 400)
    const localFolder = join(root, 'local-project')
    await mkdir(localFolder)
    const local = await (await request('/api/projects/register', { path: localFolder })).json()
    assert.equal((await request(`/api/projects/${local.project.id}/sessions`, reopenedBody)).status, 409)
    assert.equal((await (await request('/api/sessions/graph')).json()).sessions.length, 3)
    const other = await catalog.create('Other')
    const moved = await request(`/api/projects/${session.projectId}/move`, { targetOrganizationId: other.id })
    assert.equal(moved.status, 200, await moved.clone().text())
    const transferred = (await moved.json()).project
    assert.notEqual(transferred.id, session.projectId)
    assert.equal((await request(`/api/sessions/${encodeURIComponent(session.sessionId)}/files`)).status, 409)
    assert.equal((await request('/api/sessions/remote', body)).status, 409)
    assert.equal((await request(`/api/sessions/${encodeURIComponent(session.sessionId)}`)).status, 200)
    const returned = await catalog.changeProjectOrganization(other.id, transferred.id, 'default')
    assert(returned)
    assert.equal((await request(`/api/sessions/${encodeURIComponent(session.sessionId)}/preview?path=child.txt`)).status, 409)
    const fresh = await (await request(`/api/projects/${returned.id}/sessions`, {})).json()
    const freshFiles = await request(`/api/sessions/${encodeURIComponent(fresh.sessionId)}/preview?path=child.txt`)
    assert.equal(freshFiles.status, 200, await freshFiles.clone().text())
    assert.equal((await freshFiles.json()).content, 'Child runtime fixture')
  } finally {
    await scope.run(() => runtime.shutdown())
    scope.close()
  }
})
