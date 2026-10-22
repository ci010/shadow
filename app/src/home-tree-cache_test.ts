import assert from 'node:assert/strict'
import test from 'node:test'
import { createHomeTreeCache, homeDirectoryState } from './home-tree-cache.ts'
import type { DirListing } from './composables/useSessionFiles.ts'
import { parseSessionGraph } from './folders-sidebar.ts'

const source = { apiBase: 'http://main/projects/a/', sessionId: 'cron:opaque-one', home: true }
const listing: DirListing = {
  path: '', workdir: { kind: 'local', scope: 'home', displayPath: 'C:\\synthetic\\Home' },
  entries: [{ name: 'memory', type: 'dir', size: 0, ext: '', mtime: '2026-09-15' }],
}

test('Home cache validates scope, shares unchanged directories and invalidates refreshes or replacements', () => {
  const cache = createHomeTreeCache()
  const home = cache.confirm(source, listing, false)!
  const folder = homeDirectoryState(home, 'memory', true)
  folder.loaded = true
  const second = { ...source, sessionId: 'heartbeat:soul-reflector-two' }
  assert.equal(cache.candidate(second), home)
  assert.equal(cache.confirm(second, structuredClone(listing), false), home)
  assert.equal(homeDirectoryState(home, 'memory'), folder)
  assert.equal(folder.expanded, true)
  assert.equal(folder.stale, false)
  assert.equal(home.revision, 0)
  cache.confirm(second, listing, true)
  assert.equal(folder.stale, true)
  assert.equal(home.revision, 1)
  folder.stale = false
  cache.confirm(second, { ...listing, entries: [{ ...listing.entries[0], mtime: '2026-09-16' }] }, false)
  assert.equal(folder.stale, true)
  homeDirectoryState(home, 'memory/nested').loaded = true
  cache.confirm(second, { ...listing, entries: [] }, false)
  assert.equal(home.directories.size, 0)
  cache.confirm(second, listing, false)
  const replacement = homeDirectoryState(home, 'memory')
  assert.notEqual(replacement, folder)
  assert.equal(replacement.loaded, false)
  assert.equal(replacement.expanded, false)
})

test('Home cache never shares folders, unverified or remote roots, different orgs, or another UI lifetime', () => {
  const cache = createHomeTreeCache()
  const home = cache.confirm(source, listing, false)!
  assert.equal(createHomeTreeCache().candidate(source), undefined)
  assert.equal(cache.candidate({ ...source, apiBase: 'http://main/projects/b/' }), undefined)
  assert.equal(cache.candidate({ ...source, folderId: 'folder' }), undefined)
  assert.equal(cache.candidate({ ...source, sessionId: 'web:chat-other', home: false }), undefined)
  for (const workdir of [undefined, { kind: 'remote' as const, displayPath: listing.workdir!.displayPath },
    { kind: 'local' as const, displayPath: listing.workdir!.displayPath }]) {
    assert.equal(cache.confirm(source, { ...listing, workdir }, false), undefined)
  }
  assert.notEqual(cache.confirm({ ...source, apiBase: 'http://main/projects/b/' }, listing, false), home)
  const changed = cache.confirm(source, { ...listing, workdir: { ...listing.workdir!, displayPath: 'C:\\synthetic\\Different' } }, false)!
  assert.notEqual(changed, home)
  assert.equal(cache.candidate(source), changed)
  assert.equal(changed.directories.size, 0)
})

test('Home hints follow explicit learning ownership and descendants, never a fresh job or address alone', () => {
  const cache = createHomeTreeCache()
  const automation = { jobId: 'learning:encapsulator', name: 'Encapsulation', runId: 'one',
    startedAt: '2026-09-16T00:00:00Z', contextMode: 'fresh', config: { source: 'learning', schedule: 'every 2h' } }
  cache.setSessions(source.apiBase, parseSessionGraph({ nodes: [], sessions: [
    { sessionId: source.sessionId, automation },
    { sessionId: 'opaque-child', parentSessionId: source.sessionId },
    { sessionId: 'heartbeat:reflector-fake' },
    { sessionId: 'cron:generic', automation: { ...automation, config: { ...automation.config, source: 'cron' } } },
  ] }))
  assert.equal(cache.expectsHome(source), true)
  assert.equal(cache.expectsHome({ ...source, sessionId: 'opaque-child' }), true)
  assert.equal(cache.expectsHome({ ...source, sessionId: 'heartbeat:reflector-fake' }), false)
  assert.equal(cache.expectsHome({ ...source, sessionId: 'cron:generic' }), false)
  assert.equal(cache.expectsHome({ ...source, folderId: 'folder' }), false)
  assert.equal(cache.expectsHome({ ...source, apiBase: 'http://main/projects/b/' }), false)
  cache.setSessions(source.apiBase, [])
  assert.equal(cache.expectsHome(source), false)
})
