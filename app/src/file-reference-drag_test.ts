import assert from 'node:assert/strict'
import test from 'node:test'
import { FILE_REFERENCE_MIME, hasFileReference, readFileReference, startFileReferenceDrag } from './file-reference-drag.ts'
import { addChatContext, composeChatMessage } from './chat-draft.ts'

function transfer() {
  const values = new Map<string, string>()
  return { get types() { return [...values.keys()] }, effectAllowed: 'none', setData(type: string, value: string) { values.set(type, value) }, getData(type: string) { return values.get(type) ?? '' } }
}
test('file tree drag produces an owned reference, never file bytes or external path payload', () => {
  const data = transfer()
  const release = startFileReferenceDrag(data, '/project', { kind: 'local', displayPath: 'C:\\repo' }, 'src/main.ts', 'file')!
  assert.equal(hasFileReference(data), true)
  assert.equal(data.effectAllowed, 'copy')
  const reference = readFileReference(data)!
  assert.deepEqual(reference, { apiBase: '/project', path: 'C:\\repo\\src\\main.ts', kind: 'file' })
  const context = addChatContext([], reference.kind, [reference.path])
  assert.equal(addChatContext(context, reference.kind, [reference.path]).length, 1)
  assert.match(composeChatMessage('Look at this', context), /File: "C:/)
  assert.deepEqual(data.types, [FILE_REFERENCE_MIME])
  release()
  assert.equal(readFileReference(data), undefined)
  data.setData(FILE_REFERENCE_MIME, 'C:\\external\\forged.txt')
  assert.equal(readFileReference(data), undefined)
})
test('local folder references work; remote, unavailable sources and traversal are not advertised', () => {
  const data = transfer()
  const release = startFileReferenceDrag(data, '/project', { kind: 'local', displayPath: '/repo' }, 'src', 'folder')!
  assert.equal(readFileReference(data)!.path, '/repo/src')
  release()
  for (const workdir of [undefined, { kind: 'remote' as const, displayPath: '/repo' }, { kind: 'local' as const, displayPath: null }]) {
    assert.equal(startFileReferenceDrag(transfer(), '/project', workdir, 'file', 'file'), undefined)
  }
  assert.equal(startFileReferenceDrag(transfer(), '/project', { kind: 'local', displayPath: '/repo' }, '../escape', 'file'), undefined)
})
