import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ref } from 'vue'
import { createEditorGroups } from './editor-groups.ts'
import { composeGltfReferenceMessage, createExplorerGltfReferenceDraftBridge, createGltfReferenceDraftBridge, gltfReferenceChips, prepareGltfDraftCapture, registerGltfReferenceDraft, useGltfReferenceDraft, type GltfReferenceSource } from './gltf-reference.ts'

const scope = { apiBase: 'http://fixture/projects/review', projectId: 'review' }
const folder = { ...scope, kind: 'folder', folderId: 'assets' } as const
const model = { assetId: 'stage', path: 'sets/stage.glb', buildVersion: 'build-42', objectId: 'node/2', label: 'Chair' }

function fixture(sessionId: string | null = 'web:one') {
  const key = ref('draft')
  const draft = useGltfReferenceDraft(key)
  const target = { key: 'lease', label: 'Chat', sessionId }
  let reveals = 0
  const bridge = createGltfReferenceDraftBridge(
    source => source.apiBase === scope.apiBase && source.projectId === scope.projectId ? target : null,
    references => {
      if (!draft.append(references)) return false
      reveals++
      return true
    },
  )
  return { key, draft, bridge, target, reveals: () => reveals }
}

test('adds a batch once, preserves same-name IDs and the selected build, and composes only when sent', () => {
  const { bridge, draft, reveals } = fixture()
  const { key, sessionId } = bridge.target(folder)!
  assert.equal(sessionId, 'web:one')
  const first = { ...model }
  const second = { ...model, objectId: 'node/3' }
  assert.equal(bridge.add(folder, key, [first, { ...second, path: '../wrong.glb' }]), false)
  assert.deepEqual(draft.items.value, [])
  assert.equal(reveals(), 0)
  assert.equal(bridge.add(folder, key, [first, second]), true)
  assert.equal(reveals(), 1)
  assert.equal(bridge.add(folder, key, [first]), false)
  first.buildVersion = 'build-43'
  assert.equal(bridge.add(folder, key, [first]), true)
  assert.equal(draft.items.value.length, 3)
  assert.equal(new Set(draft.items.value.map(item => item.key)).size, 3)
  assert.notEqual(draft.items.value[0]!.label, draft.items.value[1]!.label)
  const text = composeGltfReferenceMessage('Compare these.', draft.items.value)
  assert.ok(text.startsWith('Compare these.\n\n'))
  assert.ok(!text.includes(scope.apiBase))
  assert.deepEqual(JSON.parse(text.split('```json\n')[1]!.split('\n```')[0]!),
    [model, second, first].map(object => ({ source: { projectId: 'review', kind: 'folder', folderId: 'assets' }, ...object })))
  assert.equal(composeGltfReferenceMessage('No extra context', []), 'No extra context')
})

test('owner-relative locations distinguish workdir, session files, attachments and archive members', () => {
  const { bridge, draft } = fixture()
  const owners: GltfReferenceSource[] = [
    { ...scope, kind: 'project-workdir' }, folder,
    { ...scope, kind: 'session-workdir', sessionId: 'web:one', execution: { nodeId: 'child', workdirId: 'work' } },
    { ...scope, kind: 'session-files', sessionId: 'web:one' },
    { ...scope, kind: 'attachment', sessionId: 'web:one' },
    { ...scope, kind: 'archive', owner: { kind: 'folder', folderId: 'assets' }, archivePath: 'pack.zip', members: ['nested/data.zip'] },
  ]
  for (const owner of owners) assert.equal(bridge.add(owner, bridge.target(owner)!.key, [model]), true)
  assert.equal(new Set(draft.items.value.map(item => item.key)).size, owners.length)
  const archive = owners.at(-1)!
  if (archive.kind === 'archive') (archive.members as string[]).push('later.zip')
  const text = composeGltfReferenceMessage('', draft.items.value)
  assert.ok(text.includes('archive members and attachments are not workdir files'))
  const locations = JSON.parse(text.split('```json\n')[1]!.split('\n```')[0]!).map((entry: { source: object }) => entry.source)
  assert.deepEqual(locations.at(-1), {
    projectId: 'review', kind: 'archive', owner: { kind: 'folder', folderId: 'assets' },
    archivePath: 'pack.zip', members: ['nested/data.zip'],
  })
  assert.equal(bridge.target({ ...scope, kind: 'session-files', sessionId: 'web:other' }), null)
  assert.equal(bridge.target({ ...scope, kind: 'archive', owner: { kind: 'folder', folderId: 'assets' }, archivePath: '/pack.zip' }), null)
  for (const path of ['/sets/stage.glb', 'C:\\sets\\stage.glb', 'file:///stage.glb', 'https://test/stage.glb', 'sets/./stage.glb']) {
    assert.equal(bridge.add(folder, bridge.target(folder)!.key, [{ ...model, path }]), false)
  }
})

test('editor scope refuses stale targets, hidden explorers, and other workbenches', () => {
  const groups = createEditorGroups()
  const first = fixture()
  const second = fixture('web:two')
  for (const { target, bridge } of [first, second]) {
    const id = target.sessionId!
    registerGltfReferenceDraft(groups, id, sessionId => sessionId === id ? bridge : undefined)
    groups.open({ id, owner: id, projectId: scope.projectId, label: id, icon: '', closable: true, select() {}, close() {},
      conversation: { sessionId: id, editable: true } })
  }
  let visible = true
  const explorer = createExplorerGltfReferenceDraftBridge(groups, () => visible ? scope : null)
  groups.activate('web:one')
  const { key, sessionId } = explorer.target(folder)!
  assert.equal(sessionId, 'web:one')
  assert.equal(explorer.target({ ...folder, projectId: 'other' }), null)
  assert.equal(explorer.target({ ...folder, apiBase: 'http://other' }), null)
  assert.equal(explorer.add({ ...folder, folderId: 'other' }, key, [model]), false)
  assert.equal(createExplorerGltfReferenceDraftBridge(createEditorGroups()).target(folder), null)
  groups.activate('web:two')
  assert.equal(explorer.add(folder, key, [model]), false)
  groups.activate('web:one')
  visible = false
  assert.equal(explorer.add(folder, key, [model]), false)
  visible = true
  first.target.key = 'new-lease'
  assert.equal(explorer.add(folder, key, [model]), false)
  assert.equal(explorer.add(folder, explorer.target(folder)!.key, [model]), true)
  assert.deepEqual(second.draft.items.value, [])
})

test('scratch has no capture session, migration keeps chips, and removal targets only the admitted composer', () => {
  const { bridge, key, draft } = fixture(null)
  const target = bridge.target(folder)!
  assert.equal(target.sessionId, null)
  assert.equal(bridge.add(folder, target.key, [model, { ...model, objectId: 'node/3' }]), true)
  const [submitted, unsent] = draft.items.value
  draft.migrate('prepared')
  key.value = 'prepared'
  key.value = 'elsewhere'
  assert.deepEqual(draft.items.value, [])
  draft.remove('prepared', new Set([submitted!.key]))
  key.value = 'prepared'
  assert.deepEqual(draft.items.value, [unsent])
  key.value = 'draft'
  assert.deepEqual(draft.items.value, [])
})

test('scratch defers capture until prepare supplies the exact real session for the explicit batch', async () => {
  const { bridge, draft } = fixture(null)
  const calls: unknown[] = []
  const prepare = async (target: unknown, signal: AbortSignal) => {
    calls.push(target)
    assert.equal(signal.aborted, false)
    return true
  }
  assert.equal(bridge.add(folder, bridge.target(folder)!.key, [model, { ...model, objectId: 'other' }], prepare), true)
  const submitted = draft.items.value
  const signal = new AbortController().signal
  const bind = (sessionId: string) => prepareGltfDraftCapture(submitted, () => draft.items.value, { ...scope, sessionId }, signal)
  assert.equal(await bind(''), false)
  assert.deepEqual(calls, [])
  assert.equal(await bind('web:server-prepared'), true)
  assert.deepEqual(calls, [{ ...scope, sessionId: 'web:server-prepared', assetId: model.assetId, version: model.buildVersion }])
  assert.match(composeGltfReferenceMessage('', submitted), /capture_view.*afterVersion/)
})

test('scratch does not bind removed references, another draft, an unmounted callback, or mixed Viewers/sources', async () => {
  const { bridge, draft } = fixture(null)
  let attempts = 0
  const prepare = async () => { attempts++; return false }
  const otherViewer = async () => { attempts++; return true }
  assert.equal(bridge.add(folder, bridge.target(folder)!.key, [model], prepare), true)
  const first = draft.items.value
  const signal = new AbortController().signal
  const bind = (items = draft.items.value, current = () => draft.items.value as typeof items | null) =>
    prepareGltfDraftCapture(items, current, { ...scope, sessionId: 'web:prepared' }, signal)
  assert.equal(await bind(first, () => null), false)
  assert.equal(bridge.add(folder, bridge.target(folder)!.key, [{ ...model, objectId: 'other' }], otherViewer), true)
  assert.equal(await bind(), false)
  draft.remove('draft', new Set([draft.items.value[1]!.key]))
  const otherFolder = { ...folder, folderId: 'other-folder' }
  assert.equal(bridge.add(otherFolder, bridge.target(otherFolder)!.key, [model], prepare), true)
  assert.equal(await bind(), false)
  draft.remove('draft', new Set([first[0]!.key]))
  assert.equal(await bind(first), false)
  assert.equal(attempts, 0)
  assert.equal(await bind(), false)
  assert.equal(attempts, 1)
})

test('scratch capture registration is bounded and aborts the Viewer attempt when late', async () => {
  const { bridge, draft } = fixture(null)
  let attempt: AbortSignal | undefined
  assert.equal(bridge.add(folder, bridge.target(folder)!.key, [model], async (_target, signal) => {
    attempt = signal
    return new Promise(() => {})
  }), true)
  assert.equal(await prepareGltfDraftCapture(draft.items.value, () => draft.items.value,
    { ...scope, sessionId: 'web:prepared' }, new AbortController().signal, 10), false)
  assert.equal(attempt?.aborted, true)
})

test('visible chips shorten IDs and show versions only for otherwise identical labels', () => {
  const { bridge, draft } = fixture()
  const suffix = 'same-end-123'
  const buildVersion = `sha256:${'a'.repeat(108)}:${suffix}`
  const item = { ...model, buildVersion, assetId: JSON.stringify(folder), objectId: `gltf:["scope","${buildVersion}"]:9:2` }
  const newer = { ...item, buildVersion: `sha256:${'b'.repeat(108)}:${suffix}` }
  const key = bridge.target(folder)!.key
  assert.equal(bridge.add(folder, key, [item]), true)
  assert.equal(gltfReferenceChips(draft.items.value)[0]!.label, 'Chair · gltf:9:2')
  assert.equal(bridge.add(folder, key, [newer]), true)
  const chips = gltfReferenceChips(draft.items.value)
  assert.notEqual(chips[0]!.label, chips[1]!.label)
  assert.notEqual(chips[0]!.key, chips[1]!.key)
  const details = JSON.parse(chips[0]!.details)
  assert.deepEqual(details, { ...item, source: { projectId: 'review', kind: 'folder', folderId: 'assets' } })
  assert.ok(chips.every(chip => !chip.label.includes(item.path) && !chip.label.includes(item.assetId) && chip.label.length < 50))
})

test('large selections preserve every full object ID in chip keys and submitted text', () => {
  const { bridge, draft } = fixture()
  const objects = Array.from({ length: 2048 }, (_, node) => ({
    ...model, objectId: `gltf:["${'x'.repeat(200)}","build-42"]:${node}:0`,
  }))
  assert.equal(bridge.add(folder, bridge.target(folder)!.key, objects), true)
  const chips = gltfReferenceChips(draft.items.value)
  assert.equal(chips.length, objects.length)
  assert.equal(new Set(chips.map(chip => chip.key)).size, objects.length)
  assert.equal(chips.at(-1)!.label, 'Chair · gltf:2047:0')
  const message = composeGltfReferenceMessage('', draft.items.value)
  const submitted = JSON.parse(message.split('```json\n')[1]!.split('\n```')[0]!) as typeof objects
  assert.deepEqual(submitted.map(item => item.objectId), objects.map(item => item.objectId))
})
