import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { parse, compileScript, compileTemplate, compileStyle } from 'vue/compiler-sfc'
import { createFolderChatDraft, createRemoteChatDraft, remoteConversationTargets } from './remote-conversations.ts'
import { createFoldersClient, type FolderRecord } from './folders-client.ts'
import { type NodeInventoryEntry } from './node-inventory.ts'

const node: NodeInventoryEntry = {
  nodeId: 'wsl', displayName: 'WSL Ubuntu', role: 'child', connection: 'connected',
  capabilities: [{ capabilityId: 'workspace', kind: 'workdir', displayName: 'Folder', displayPath: '/home/test/folder', online: true }],
}
const target = remoteConversationTargets([node])[0]!
const requestId = '11111111-1111-4111-8111-111111111111'

test('remote picker offers only Child workdir capabilities and never treats offline or revoked nodes as available', () => {
  assert.deepEqual(remoteConversationTargets([{ ...node, role: 'main' }]), [])
  assert.equal(target.available, true)
  assert.equal(target.displayPath, '/home/test/folder')
  for (const connection of ['offline', 'revoked'] as const) {
    assert.equal(remoteConversationTargets([{ ...node, connection }])[0]?.available, false)
  }
  assert.equal(remoteConversationTargets([{ ...node, capabilities: [{ ...node.capabilities[0]!, online: false }] }])[0]?.available, false)
  assert.deepEqual(remoteConversationTargets([{ ...node, capabilities: [{ ...node.capabilities[0]!, kind: 'shell' }] }]), [])
})

test('remote drafts allocate nothing before first send and preserve one server identity on retries', async () => {
  let calls = 0
  const request: typeof fetch = async (_url, options) => {
    calls++
    assert.equal(options?.method, 'POST')
    assert.deepEqual(JSON.parse(options!.body as string), { nodeId: 'wsl', capabilityId: 'workspace', requestId })
    return Response.json({ sessionId: 'web:chat-test', chatId: 'chat-test', workdir: { version: 1, nodeId: 'wsl', capabilityId: 'workspace' } })
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
  const bodies: Array<{ requestId: string; nodeId: string; capabilityId: string }> = []
  const request: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'http://fixture/projects/a/api/sessions/remote')
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    if (bodies.length === 1) throw new Error('Synthetic lost reply')
    return Response.json({ chatId: `chat-${body.requestId}`, sessionId: `web:chat-${body.requestId}`, folderId: 'remote-folder',
      workdir: { version: 1, nodeId: 'wsl', capabilityId: 'workspace' } })
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
  assert.deepEqual(Object.keys(bodies[0]).sort(), ['capabilityId', 'nodeId', 'requestId'])
})

test('reopened remote folder drafts retain device metadata and retry with the same request and folder identity', async () => {
  const folder: FolderRecord = {
    id: 'remote-folder', name: 'Remote folder', kind: 'remote', path: 'C:\\display-only', createdAt: '2026-09-14',
    workdir: { version: 1, nodeId: 'wsl', capabilityId: 'workspace' },
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
      : Response.json({ sessionId: 'web:chat-test', chatId: 'chat-test', workdir: { version: 1, nodeId: 'other', capabilityId: 'workspace' } })
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
  assert.equal(draft.remote.capabilityId, 'workspace')
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
      assert.match(source, /v-if="!activeSessionId && installation.mode === 'main'"/)
      assert.match(source, /await draft.value.prepare\(controller.signal\)/)
      assert.match(source, /Remove local attachments before selecting a remote workspace/)
    }
    if (file === 'ExecutionLocationSelector.vue') {
      assert.match(source, /:label="remoteOnly \? 'Open remote folder' : 'Execution location'"/)
      assert.match(source, /v-if="!remoteOnly"/)
      assert.match(source, /!target.available \|\| loading \|\| !!error/)
      assert.match(source, /@opened="refresh"/)
    }
  }
})
