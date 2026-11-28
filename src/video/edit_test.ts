import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { initialTimeline, revisionOf } from './index.ts'
import { editTimeline } from './edit.ts'

async function fixture(fn: (f: { dir: string; file: string; patch: string; output: string; revision: string }) => Promise<void>) {
  const dir = await mkdtemp(path.resolve('.video-edit-test-'))
  const file = path.join(dir, 'source.otio'), patch = path.join(dir, 'patch.json'), output = path.join(dir, 'result.otio')
  const raw = { ...initialTimeline(2), metadata: { vendor: { 'a/b': { '~key': 1 }, b: 2, a: 1 } } }
  const text = JSON.stringify(raw)
  try { await writeFile(file, text); await fn({ dir, file, patch, output, revision: revisionOf(text) }) }
  finally { await rm(dir, { recursive: true, force: true }) }
}
const children = '/tracks/children/0/children'
const rt = (value: number) => ({ OTIO_SCHEMA: 'RationalTime.1', value, rate: 24 })
const clip = { OTIO_SCHEMA: 'Clip.2', source_range: { OTIO_SCHEMA: 'TimeRange.1', start_time: rt(0), duration: rt(24) }, media_reference: { OTIO_SCHEMA: 'ExternalReference.1', target_url: 'missing-relative.mp4' }, effects: [{ OTIO_SCHEMA: 'Effect.1', effect_name: 'shadow.opacity', metadata: { shadow: { profile: 'opacity', value: 1 } } }] }
test('raw metadata retained; structural tests, pointer escaping, add/remove/trim/effect; no media IO', () => fixture(async f => {
  await writeFile(f.patch, JSON.stringify([
    { op: 'test', path: '/metadata/vendor', value: { a: 1, b: 2, 'a/b': { '~key': 1 } } },
    { op: 'replace', path: '/metadata/vendor/a~1b/~0key', value: 3 },
    { op: 'add', path: children + '/-', value: clip },
    { op: 'remove', path: children + '/0' },
    { op: 'replace', path: children + '/0/source_range/start_time/value', value: 12 },
    { op: 'replace', path: children + '/0/source_range/duration/value', value: 12 },
    { op: 'replace', path: children + '/0/effects/0/metadata/shadow/value', value: 0.5 },
  ]))
  const result = await editTimeline(f.file, f.patch, f.output, { revision: f.revision })
  assert.equal(result.file, f.output); assert.equal(result.operations, 7)
  assert.equal(result.duration, 0.5); assert.equal(result.rate, 24)
  const text = await readFile(f.output, 'utf8'), raw = JSON.parse(text)
  assert.equal(result.revision, revisionOf(text)); assert.equal(result.sourceRevision, f.revision)
  assert.deepEqual(raw.metadata.vendor, { 'a/b': { '~key': 3 }, b: 2, a: 1 })
  assert.equal(raw.tracks.children[0].children[0].media_reference.target_url, 'missing-relative.mp4')
}))
test('invalid patches fail atomically with source unchanged', () => fixture(async f => {
  const source = await readFile(f.file, 'utf8')
  const invalid = [
    [{ op: 'move', from: '/name', path: '/x' }], [{ op: 'copy', from: '/name', path: '/x' }],
    [{ op: 'replace', path: '', value: {} }], [{ op: 'remove', path: '/name', value: 1 }],
    [{ op: 'test', path: '/metadata/vendor/a', value: 99 }],
    ...['/01', '/2', '/-1', '/-', '/9007199254740992'].map(s => [{ op: 'remove', path: children + s }]),
    [{ op: 'add', path: '/bad~2key', value: 1 }],
    ...['__proto__', 'prototype', 'constructor', 'toString'].map(k => [{ op: 'replace', path: '/metadata/' + k, value: {} }]),
    [{ op: 'add', path: '/metadata/x', value: JSON.parse('{"__proto__":{"polluted":true}}') }],
    [{ op: 'replace', path: '/tracks', value: {} }],
    [{ op: 'add', path: children + '/0/effects', value: [{ OTIO_SCHEMA: 'LinearTimeWarp.1' }] }],
    Array.from({ length: 257 }, () => ({ op: 'add', path: '/name', value: 'x' })),
    {},
  ]
  for (const patch of invalid) {
    await writeFile(f.patch, JSON.stringify(patch))
    await assert.rejects(editTimeline(f.file, f.patch, f.output, { revision: f.revision }), { name: 'Error' }, JSON.stringify(patch).slice(0, 100))
    assert.equal(await readFile(f.file, 'utf8'), source)
    assert.deepEqual((await readdir(f.dir)).sort(), ['patch.json', 'source.otio'])
  }
  assert.equal(({} as any).polluted, undefined)
}))
test('hash, abort, no clobber, same-parent and network guards', () => fixture(async f => {
  await writeFile(f.patch, '[]')
  await assert.rejects(editTimeline(f.file, f.patch, f.output, { revision: 'stale' }), /Revision/)
  const c = new AbortController(); c.abort(new Error('cancelled'))
  await assert.rejects(editTimeline(f.file, f.patch, f.output, { revision: f.revision, signal: c.signal }), /cancelled/)
  assert.deepEqual((await readdir(f.dir)).sort(), ['patch.json', 'source.otio'])
  await mkdir(path.join(f.dir, 'other'))
  await assert.rejects(editTimeline(f.file, f.patch, path.join(f.dir, 'other', 'x.otio'), { revision: f.revision }), /parent/)
  for (const network of ['//host/share/x.otio', '\\\\host\\share\\x.otio', '\\\\?\\C:\\x.otio']) {
    await assert.rejects(editTimeline(network, f.patch, f.output, { revision: f.revision }), /network|device/)
    await assert.rejects(editTimeline(f.file, network, f.output, { revision: f.revision }), /network|device/)
    await assert.rejects(editTimeline(f.file, f.patch, network, { revision: f.revision }), /network|device/)
  }
  await assert.rejects(editTimeline(f.file, f.patch, f.file, { revision: f.revision }), /overwrite/)
  await writeFile(f.output, 'keep')
  await assert.rejects(editTimeline(f.file, f.patch, f.output, { revision: f.revision }), /EEXIST/)
  assert.equal(await readFile(f.output, 'utf8'), 'keep')
  await writeFile(f.patch, ' '.repeat(1024 * 1024 + 1))
  await assert.rejects(editTimeline(f.file, f.patch, f.output, { revision: f.revision }), /size limit/)
}))

test('concurrent same-output edits publish one complete JSON, never a partial target', () => fixture(async f => {
  const payload = 'atomic metadata '.repeat(50000)
  await writeFile(f.patch, JSON.stringify([{ op: 'add', path: '/metadata/payload', value: payload }]))
  let done = false, observed = 0
  const outcomes = Promise.allSettled([
    editTimeline(f.file, f.patch, f.output, { revision: f.revision }),
    editTimeline(f.file, f.patch, f.output, { revision: f.revision }),
  ]).then(results => { done = true; return results })
  async function observe() {
    try {
      const text = await readFile(f.output, 'utf8')
      assert.equal(JSON.parse(text).metadata.payload, payload)
      observed++
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  // Repeated asynchronous readers race both writers, including temp write/sync.
  while (!done) await observe()
  await observe()
  const results = await outcomes
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const loser = results.find(r => r.status === 'rejected') as PromiseRejectedResult
  assert.equal(loser.reason.code, 'EEXIST')
  assert.ok(observed > 0)
  assert.deepEqual((await readdir(f.dir)).sort(), ['patch.json', 'result.otio', 'source.otio'])
}))
