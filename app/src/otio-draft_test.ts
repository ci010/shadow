import assert from 'node:assert/strict'
import { test } from 'node:test'
import { composeImageReferenceMessage, imageAttachmentReference, revokeChatAttachmentPreviews, uploadChatAttachments } from './chat-attachments.ts'
import { ref } from 'vue'
import { createEditorGroups } from './editor-groups.ts'
import { composeOtioReferenceMessage, createExplorerOtioDraftBridge, createOtioDraftBridge, registerOtioDraft, useOtioReferenceDraft, type OtioDraftReference } from './otio-draft.ts'

const apiBase = 'http://fixture/projects/review/'
function fixture() {
  const groups = createEditorGroups()
  let active = true
  const drafts = [1, 2].map(n => {
    const id = `chat-${n}`
    const draft = { key: `draft-${n}`, label: id, text: `Original ${n}`, canAttachFiles: true, references: [] as OtioDraftReference[] }
    let editable = true
    const bridge = createOtioDraftBridge(base => editable && base === apiBase ? draft : null, reference => {
      draft.references.push(reference)
      groups.activate(id)
    })
    const unregister = registerOtioDraft(groups, id, sessionId => sessionId === id ? bridge : undefined)
    groups.open({ id, owner: id, projectId: 'review', label: id, icon: '', closable: true, select() {}, close() {},
      conversation: { sessionId: id, editable: true } })
    return { draft, id, unregister, lock: () => { editable = false } }
  })
  groups.activate(drafts[0]!.id)
  const explorer = createExplorerOtioDraftBridge(groups, () => active ? { apiBase, projectId: 'review' } : null)
  return { groups, explorer, drafts, hide: () => { active = false } }
}
test('draft references follow their composer through switching and scratch migration', () => {
  const key = ref('scratch')
  const draft = useOtioReferenceDraft(key)
  const item: OtioDraftReference = { key: 'clip-1', label: 'Clip', text: 'Exact clip context' }
  draft.append(item)
  key.value = 'other-chat'
  assert.deepEqual(draft.items.value, [])
  key.value = 'scratch'
  assert.deepEqual(draft.items.value, [item])
  draft.migrate('prepared-chat')
  key.value = 'prepared-chat'
  assert.deepEqual(draft.items.value, [item])
  key.value = 'scratch'
  assert.deepEqual(draft.items.value, [])
  // Admission may arrive after navigation, but only clears the submitted chips.
  draft.remove('prepared-chat', new Set([item.key]))
  key.value = 'prepared-chat'
  assert.deepEqual(draft.items.value, [])
  draft.dispose()
})

function png(value: string) {
  return new File([value], 'marked.png', { type: 'image/png', lastModified: 1 })
}

test('explorer reviews stage distinct references and render exact anchors and PNGs only at send', async () => {
  const { groups, explorer, drafts: [first, second] } = fixture()
  const { draft } = first!
  const key = explorer.target(apiBase)!.key
  const frames = ['Review timeline.otio, frame 24', 'Review timeline.otio, frame 25']
  const files = [png('one'), png('two')]
  try {
    for (const [i, text] of frames.entries()) assert.equal(explorer.add(apiBase, key, { label: `Frame ${24 + i}`, text, file: files[i]! }), true)
    const pending = draft.references.map(item => item.attachment!)
    assert.equal(pending.length, 2)
    assert.deepEqual(pending.map(item => item.file), files)
    assert.notEqual(pending[0]!.key, pending[1]!.key)
    assert.ok(pending.every(item => item.kind === 'image' && item.previewUrl && !item.source))
    assert.equal(draft.text, 'Original 1')
    assert.deepEqual(draft.references.map(item => item.label), ['Frame 24', 'Frame 25'])
    const message = composeOtioReferenceMessage(draft.text, draft.references)
    assert.equal(message, `Original 1\n\n${frames[0]}\n${imageAttachmentReference(pending[0]!)}\n\n${frames[1]}\n${imageAttachmentReference(pending[1]!)}`)
    assert.equal(groups.active('review')?.id, first!.id)
    assert.equal(second!.draft.text, 'Original 2')
    assert.deepEqual(second!.draft.references, [])

    let uploads = 0
    const uploaded = await uploadChatAttachments(apiBase, first!.id, pending, new AbortController().signal, async (_url, init) => {
      assert.ok(init?.body instanceof FormData)
      assert.equal(init.body.get('chatId'), first!.id)
      return Response.json({ path: `/uploads/${++uploads}/marked.png` })
    })
    assert.equal(uploads, 2)
    assert.deepEqual(uploaded.map(item => item.reference), pending.map(item => item.reference))
    const content = composeImageReferenceMessage(message, uploaded)
    assert.ok(content.startsWith(message))
    assert.ok(content.includes('/uploads/1/marked.png') && content.includes('/uploads/2/marked.png'))
  } finally {
    revokeChatAttachmentPreviews(draft.references.flatMap(item => item.attachment ? [item.attachment] : []))
  }
})

test('explorer refuses drift, cross-project and invalid files without partial mutation', () => {
  const { groups, explorer, drafts: [first, second], hide } = fixture()
  const key = explorer.target(apiBase)!.key
  const review = { label: 'Frame 24', text: 'Review timeline.otio, frame 24', file: png('marked') }
  assert.equal(explorer.add('http://fixture/projects/other/', key, review), false)
  assert.equal(explorer.add(apiBase, key, { ...review, file: new File(['x'], 'marked.jpg', { type: 'image/jpeg' }) }), false)
  groups.activate(second!.id)
  assert.equal(explorer.add(apiBase, key, review), false)
  const next = explorer.target(apiBase)!.key
  assert.notEqual(next, key)
  second!.draft.key = 'new-draft-same-editor'
  assert.equal(explorer.add(apiBase, next, review), false)
  second!.lock()
  assert.equal(explorer.target(apiBase), null)
  groups.activate(first!.id)
  hide()
  assert.equal(explorer.add(apiBase, key, review), false)
  assert.deepEqual([first!, second!].map(({ draft }) => [draft.text, draft.references]), [['Original 1', []], ['Original 2', []]])
})
