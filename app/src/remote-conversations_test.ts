import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { parse, compileScript, compileTemplate, compileStyle } from 'vue/compiler-sfc'
import { createFolderChatDraft, createRemoteChatDraft, remoteConversationTargets, remoteNodeTargets } from './remote-conversations.ts'
import { createFoldersClient, type FolderRecord } from './folders-client.ts'
import { type NodeInventoryEntry } from './node-inventory.ts'

const node: NodeInventoryEntry = {
  nodeId: 'wsl', displayName: 'WSL Ubuntu', role: 'child', connection: 'connected',
  executionProtocol: 'compatible',
  workdirs: [{ version: 2 as const, nodeId: 'wsl', workdirId: 'workspace', displayName: 'Folder', displayPath: '/home/test/folder', online: true, support: { operations: ['filesystem.read','filesystem.write','workdir.git.status','workdir.git.diff','workdir.identity','workdir.process.execute','workdir.process.execute-once','workdir.process.reconcile'] } }],
  support: { operations: ['workdir.session.allocate'] },
}
const target = remoteConversationTargets([node])[0]!
const requestId = '11111111-1111-4111-8111-111111111111'

test('resource discovery lists only Child directories, not capability descriptors or Project grants', () => {
  assert.deepEqual(remoteConversationTargets([{ ...node, role: 'main' }]), [])
  assert.equal(target.available, true)
  assert.equal(target.displayPath, '/home/test/folder')
  for (const connection of ['offline', 'revoked'] as const) {
    assert.equal(remoteConversationTargets([{ ...node, connection }])[0]?.available, false)
  }
  assert.equal(remoteConversationTargets([{ ...node, workdirs: [{ ...node.workdirs[0]!, online: false }] }])[0]?.available, false)
  assert.equal(remoteConversationTargets([{ ...node, executionProtocol: 'upgrade-required' }])[0]?.available, false)
  assert.deepEqual(remoteConversationTargets([{ ...node, workdirs: [] }]), [])
})

test('remote scratch choices are nodes, never advertised folders, and require explicit managed-session support', () => {
  const [target] = remoteNodeTargets([{ ...node, supportsManagedSessions: true }])
  assert.equal(target.available, true)
  assert.equal(target.workdirId, undefined)
  assert.equal(target.displayPath, undefined)
  assert.deepEqual(remoteNodeTargets([{ ...node, role: 'main' }]), [])
  assert.equal(remoteNodeTargets([node])[0].available, false)
  assert.match(remoteNodeTargets([node])[0].unavailableReason!, /Update/)
  for (const connection of ['offline', 'revoked'] as const) {
    assert.equal(remoteNodeTargets([{ ...node, supportsManagedSessions: true, connection }])[0].available, false)
  }
})

test('remote scratch first-send allocation sends only the node and reuses its request on retries', async () => {
  const target = remoteNodeTargets([{ ...node, supportsManagedSessions: true }])[0]!
  const requests: unknown[] = []
  const draft = createRemoteChatDraft('http://fixture/projects/a/', target, async (url, init) => {
    assert.equal(String(url), 'http://fixture/projects/a/api/sessions/remote')
    requests.push(JSON.parse(String(init?.body)))
    if (requests.length === 1) throw new Error('Synthetic lost reply')
    return Response.json({ sessionId: 'web:chat-managed', chatId: 'chat-managed',
      workdir: { version: 2, nodeId: 'wsl', workdirId: 'managed-fixture' } })
  }, () => requestId)
  assert.deepEqual(requests, [])
  assert.equal(draft.folder, undefined)
  await assert.rejects(draft.prepare(), /lost reply/)
  assert.deepEqual(await Promise.all([draft.prepare(), draft.prepare()]), ['web:chat-managed', 'web:chat-managed'])
  assert.equal(await draft.prepare(), 'web:chat-managed')
  assert.deepEqual(requests, [{ nodeId: 'wsl', requestId }, { nodeId: 'wsl', requestId }])
})

test('scratch rejects an ordinary registered folder response and explicitly reports unsupported devices', async () => {
  const target = remoteNodeTargets([{ ...node, supportsManagedSessions: true }])[0]!
  const invalid = createRemoteChatDraft('http://fixture/projects/a/', target, async () => Response.json({
    sessionId: 'web:chat-managed', chatId: 'chat-managed', folderId: 'unwanted-folder',
    workdir: { version: 2, nodeId: 'wsl', workdirId: 'workspace' },
  }))
  await assert.rejects(invalid.prepare(), /invalid remote conversation/)
  const unsupported = createRemoteChatDraft('http://fixture/projects/a/', target,
    async () => Response.json({ error: 'managed_sessions_unsupported' }, { status: 409 }))
  await assert.rejects(unsupported.prepare(), /Update the device.*No local folder was used/)
})

test('remote drafts allocate nothing before first send and preserve one server identity on retries', async () => {
  let calls = 0
  const request: typeof fetch = async (_url, options) => {
    calls++
    assert.equal(options?.method, 'POST')
    assert.deepEqual(JSON.parse(options!.body as string), { nodeId: 'wsl', workdirId: 'workspace', requestId })
    return Response.json({ sessionId: 'web:chat-test', chatId: 'chat-test', workdir: { version: 2, nodeId: 'wsl', workdirId: 'workspace' } })
  }
  const draft = createRemoteChatDraft('http://localhost', target, request, () => requestId)
  assert.equal(calls, 0)
  assert.equal(draft.folder, undefined)
  assert.equal(draft.remote.nodeId, 'wsl')
  assert.deepEqual(await Promise.all([draft.prepare(), draft.prepare()]), ['web:chat-test', 'web:chat-test'])
  assert.equal(await draft.prepare(), 'web:chat-test')
  assert.equal(calls, 1)
})

test('lost remote creation replies retry with the same draft UUID while another draft keeps its own identity', async () => {
  const bodies: Array<{ requestId: string; nodeId: string; workdirId: string }> = []
  const request: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'http://fixture/projects/a/api/sessions/remote')
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    if (bodies.length === 1) throw new Error('Synthetic lost reply')
    return Response.json({ chatId: `chat-${body.requestId}`, sessionId: `web:chat-${body.requestId}`, folderId: 'remote-folder',
      workdir: { version: 2, nodeId: 'wsl', workdirId: 'workspace' } })
  }
  const draft = createRemoteChatDraft('http://fixture/projects/a/', target, request)
  const other = createRemoteChatDraft('http://fixture/projects/a/', target, request)
  assert.equal(bodies.length, 0)
  await assert.rejects(draft.prepare(), /lost reply/)
  const sessionId = await draft.prepare()
  assert.equal(await draft.prepare(), sessionId)
  await other.prepare()
  assert.equal(bodies.length, 3)
  assert.equal(bodies[0].requestId, bodies[1].requestId)
  assert.notEqual(bodies[0].requestId, bodies[2].requestId)
  assert.match(bodies[0].requestId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
  assert.deepEqual(Object.keys(bodies[0]).sort(), ['nodeId', 'requestId', 'workdirId'])
})

test('reopened remote folder drafts retain device metadata and retry with the same request and folder identity', async () => {
  const folder: FolderRecord = {
    id: 'remote-folder', name: 'Remote folder', kind: 'remote', path: 'C:\\display-only', createdAt: '2026-09-14',
    workdir: { version: 2, nodeId: 'wsl', workdirId: 'workspace' },
    identity: { version: 1, rootId: 'a'.repeat(64), ancestorIds: [] },
  }
  const calls: string[] = []
  const draft = createFolderChatDraft(createFoldersClient('http://fixture/projects/a/', async (input, init) => {
    assert.equal(String(input), 'http://fixture/projects/a/api/folders/remote-folder/sessions')
    const body = JSON.parse(String(init?.body))
    assert.deepEqual(body, { requestId: body.requestId })
    calls.push(body.requestId)
    if (calls.length === 1) throw new Error('Synthetic lost reply')
    return Response.json({ chatId: 'chat-remote', sessionId: 'web:chat-remote' })
  }), folder)
  assert.deepEqual(calls, [])
  assert.ok('remote' in draft)
  assert.equal(draft.remote.nodeId, 'wsl')
  assert.equal(draft.remote.displayPath, 'C:\\display-only')
  assert.equal(draft.folder, folder)
  await assert.rejects(draft.prepare(), /Cannot reach Main/)
  assert.equal(await draft.prepare(), 'web:chat-remote')
  assert.equal(await draft.prepare(), 'web:chat-remote')
  assert.equal(calls.length, 2)
  assert.equal(calls[0], calls[1])
})

test('unavailable and mismatched remote creation results fail without selecting a local fallback', async () => {
  let calls = 0
  const draft = createRemoteChatDraft('http://localhost', target, async () => {
    calls++
    return calls === 1 ? Response.json({ error: 'workdir_unavailable' }, { status: 409 })
      : Response.json({ sessionId: 'web:chat-test', chatId: 'chat-test', workdir: { version: 2, nodeId: 'other', workdirId: 'workspace' } })
  })
  await assert.rejects(draft.prepare(), /No local folder was used/)
  await assert.rejects(draft.prepare(), /invalid remote conversation/)
  assert.equal(draft.remote.nodeId, 'wsl')
})

test('project remote ownership rejection explains the required upgrade and retains the selected draft', async () => {
  const urls: string[] = []
  const draft = createRemoteChatDraft('http://fixture/projects/a/', target, async input => {
    urls.push(String(input))
    return Response.json({ error: 'remote_folder_identity_required', action: 'upgrade_node' }, { status: 409 })
  })
  assert.equal(urls.length, 0)
  await assert.rejects(draft.prepare(), /Update Main and the device.*No local folder was used/)
  assert.equal(draft.remote.nodeId, 'wsl')
  assert.equal(draft.remote.workdirId, 'workspace')
  await assert.rejects(draft.prepare(), /ownership verification/)
  assert.deepEqual(urls, [
    'http://fixture/projects/a/api/sessions/remote',
    'http://fixture/projects/a/api/sessions/remote',
  ])
})

test('remote selector and chat surfaces compile with accessible device selection and deferred creation', async () => {
  for (const file of ['ExecutionLocationSelector.vue', 'ComposerPopover.vue', 'FoldersSidebar.vue', 'ChatTab.vue', 'SessionHeading.vue', 'files/FileTree.vue', 'files/FileWorkbench.vue']) {
    const filename = new URL(`./components/${file}`, import.meta.url)
    const source = await readFile(filename, 'utf8')
    const { descriptor } = parse(source)
    const script = compileScript(descriptor, { id: 'remote-test' })
    const compiled = compileTemplate({ source: descriptor.template!.content, filename: file, id: 'remote-test', compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(compiled.errors, [], file)
    for (const style of descriptor.styles) assert.deepEqual(compileStyle({ source: style.content, filename: file, id: 'remote-test', scoped: true }).errors, [])
    if (file === 'ChatTab.vue') {
      assert.match(source, /v-if="\(installation.mode === 'main' \|\| installation.mainWorkspace === true\)"/)
      assert.match(source, /await draft.value.prepare\(controller.signal\)/)
      assert.match(source, /Remove local attachments before selecting a remote workspace/)
    }
    if (file === 'ExecutionLocationSelector.vue') {
      assert.match(source, /:label="t\('Execution location'\)"/)
      assert.doesNotMatch(source, /remoteOnly|remoteConversationTargets/)
      assert.match(source, /v-for="target in folderTargets"/)
      assert.match(source, /!target.available \|\| loading \|\| !!error/)
      assert.match(source, /@opened="menuOpened"/)
    }
  }
})


test('draft request identity stays bound to the copied resource target after a lost response and caller mutation', async () => {
  const selected = { ...target }
  const requests: unknown[] = []
  const draft = createRemoteChatDraft('http://fixture/projects/a/', selected, async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)))
    if (requests.length === 1) throw new Error('Lost response')
    return Response.json({ sessionId: 'web:chat-target', chatId: 'chat-target', workdir: { version: 2, nodeId: 'wsl', workdirId: 'workspace' } })
  }, () => requestId)
  await assert.rejects(draft.prepare(), /Lost response/)
  selected.nodeId = 'other-device'
  selected.workdirId = 'other-directory'
  assert.equal(Object.isFrozen(draft.remote), true)
  assert.equal(await draft.prepare(), 'web:chat-target')
  assert.deepEqual(requests, [
    { nodeId: 'wsl', workdirId: 'workspace', requestId },
    { nodeId: 'wsl', workdirId: 'workspace', requestId },
  ])
})

test('invalid, mixed-version, wrong-resource and incompatible responses never reinterpret a remote target as local or scratch', async () => {
  assert.throws(() => createRemoteChatDraft('http://fixture', { ...target, workdirId: '' }), /invalid.*No local folder was used/)
  assert.throws(() => createRemoteChatDraft('http://fixture', { ...target, capabilityId: 'legacy' } as typeof target), /invalid.*No local folder was used/)
  for (const workdir of [
    { version: 1, nodeId: 'wsl', capabilityId: 'workspace' },
    { version: 2, nodeId: 'wsl', workdirId: 'other-directory' },
    { version: 2, nodeId: 'wsl', workdirId: 'workspace', capabilityId: 'workspace' },
    { version: 2, nodeId: 'wsl', workdirId: 'workspace', displayPathSnapshot: 12 },
  ]) {
    const draft = createRemoteChatDraft('http://fixture', target, async () => Response.json({ sessionId: 'web:chat-target', chatId: 'chat-target', workdir }))
    await assert.rejects(draft.prepare(), workdir.version === 1 ? /Update Main and the device.*No local folder was used/ : /invalid remote conversation/)
    assert.equal(draft.remote.nodeId, 'wsl')
    assert.equal(draft.remote.workdirId, 'workspace')
  }
  for (const status of [409, 503]) {
    const draft = createRemoteChatDraft('http://fixture', target,
      async () => Response.json({ error: 'execution-upgrade-required' }, { status }))
    await assert.rejects(draft.prepare(), /Update Main and the device.*No local folder was used/)
    assert.equal(draft.remote.workdirId, 'workspace')
  }
})
