import assert from 'node:assert/strict'
import test from 'node:test'
import { canRetainHomeTree, fileEntryKey, fileWorkspaceKey, reconcileFileEntries } from './file-tree-state.ts'
import type { FileEntry } from './composables/useSessionFiles.ts'

const entry = (name: string, fields: Partial<FileEntry> = {}): FileEntry => ({
  name, type: 'file', ext: '.txt', size: 10, mtime: '2026-09-13T00:00:00Z', ...fields,
})

test('only a verified local Home shares workspace identity across sessions', () => {
  const a = { apiBase: 'http://main', sessionId: 'heartbeat:reflector-one' }
  const b = { ...a, sessionId: 'heartbeat:soul-reflector-two' }
  const home = { kind: 'local', scope: 'home', displayPath: 'C:\\Home' } as const
  assert.equal(fileWorkspaceKey(a, home), fileWorkspaceKey(b, home))
  assert.equal(canRetainHomeTree(a, b, home), true)
  for (const workdir of [undefined, { kind: 'local', displayPath: 'C:\\Home' } as const, { kind: 'remote', displayPath: 'C:\\Home' } as const]) {
    assert.notEqual(fileWorkspaceKey(a, workdir), fileWorkspaceKey(b, workdir))
    assert.equal(canRetainHomeTree(a, b, workdir), false)
  }
  assert.notEqual(fileWorkspaceKey(a, home), fileWorkspaceKey(b, { ...home, displayPath: 'D:\\Home' }))
  for (const next of [{ ...b, apiBase: 'http://other-main' }, { ...b, projectId: 'project-a' }, { ...b, sessionId: 'web:chat-one' }]) {
    assert.equal(canRetainHomeTree(a, next, home), false)
  }
  assert.equal(canRetainHomeTree({ ...a, projectId: 'project-a' }, b, home), false)
  assert.equal(canRetainHomeTree(a, b, { ...home, displayPath: null }), false)
  assert.notEqual(fileWorkspaceKey(a, home), fileWorkspaceKey({ ...b, apiBase: 'http://other-main' }, home))
})

test('identical file data preserves the array and every existing entry reference', () => {
  const previous = [entry('folder', { type: 'dir', ext: '' }), entry('a.txt')]
  assert.equal(reconcileFileEntries(previous, structuredClone(previous)), previous)
  assert.equal(fileEntryKey(previous[0]!), 'dir:folder')
})

test('updates replace only changed entries while preserving incoming order and removals', () => {
  const previous = [entry('a.txt'), entry('b.txt'), entry('removed.txt')]
  const incoming = [entry('b.txt', { size: 20 }), entry('new.txt'), entry('a.txt')]
  const next = reconcileFileEntries(previous, incoming)
  assert.notEqual(next, previous)
  assert.equal(next[0], incoming[0])
  assert.equal(next[1], incoming[1])
  assert.equal(next[2], previous[0])
  assert.equal(previous.length, 3)
  assert.equal(previous[1]?.size, 10)
})

test('file type changes intentionally get a new identity and updated metadata is not ignored', () => {
  const previous = [entry('same')]
  for (const fields of [{ type: 'dir', ext: '' } as const, { ext: '.log' }, { mtime: null }, { size: 0 }]) {
    const incoming = [entry('same', fields)]
    assert.equal(reconcileFileEntries(previous, incoming)[0], incoming[0])
  }
  assert.notEqual(fileEntryKey(entry('same')), fileEntryKey(entry('same', { type: 'dir' })))
  assert.equal(reconcileFileEntries(previous, []).length, 0)
})
