import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { ReadTool } from './read.ts'
import { SearchTool } from './search.ts'
import { otioSubpath, projectOtio, otioPage, otioSearch, OTIO_PAGE_CHARS, OTIO_SEARCH_LINES, OTIO_SEARCH_VIEWS } from './otio-file-vfs.ts'
import { parseOtio } from '../shared/otio-model.ts'
import type { ExecutionContext } from './context.ts'

const time = (value: number, rate = 24000 / 1001) => ({ OTIO_SCHEMA: 'RationalTime.1', value, rate })
const range = { OTIO_SCHEMA: 'TimeRange.1', start_time: time(101), duration: time(48) }
const fixture = { OTIO_SCHEMA: 'Timeline.1', name: 'Film', tracks: { OTIO_SCHEMA: 'Stack.1', children: [
  { OTIO_SCHEMA: 'Track.1', kind: 'Video', children: [{ OTIO_SCHEMA: 'Clip.1', name: 'Shot', source_range: range,
    media_reference: { OTIO_SCHEMA: 'ExternalReference.1', target_url: 'https://invalid.example/never-fetch.mov' } }] },
] } }
const text = JSON.stringify(fixture)
const context = (cwd: string) => ({ cwd, sessionId: 'test', physicalSessionId: 'test', signal: new AbortController().signal }) as ExecutionContext

test('real read route preserves source bytes, follows stable pointers, pages and versions views', async () => {
  await withTempWorkspace(async root => {
    const cwd = join(root, 'repo')
    await mkdir(join(cwd, 'film'), { recursive: true })
    const source = join(cwd, 'film/edit.otio')
    await writeFile(source, text)
    const reader = new ReadTool(root)
    const ctx = context(cwd)
    assert.equal(await reader.execute({ path: './film/edit.otio' }, ctx), text)
    const overviewText = String(await reader.execute({ path: './film/edit.otio/overview' }, ctx))
    const overview = JSON.parse(overviewText)
    assert.equal(overview.rate, parseOtio(text).rate)
    assert.equal(overview.duration, parseOtio(text).duration)
    assert.match(overview.sourceVersion, /^sha256:[a-f0-9]{64}$/)
    for (const path of overview.follow) assert.match(String(await reader.execute({ path, limit: 5 }, ctx)), /sourceVersion/)
    assert.equal(overview.clips, undefined)
    const clipsPath = overview.follow.find((p: string) => p.endsWith('/clips'))
    const clips = JSON.parse(String(await reader.execute({ path: clipsPath }, ctx))).clips
    const clip = JSON.parse(String(await reader.execute({ path: clips[0].read, limit: 200 }, ctx)))
    assert.equal(clip.clip.sourcePointer, '/tracks/children/0/children/0')
    assert.deepEqual(clip.clip.authoredRange.duration, { value: 48, rate: 24000 / 1001 })
    const page = String(await reader.execute({ path: './film/edit.otio/overview', offset: 2, limit: 2, flag: 'n' }, ctx))
    assert.match(page, /2\s+"source"/)
    await writeFile(source, text.replace('Film', 'Changed'))
    const changed = JSON.parse(String(await reader.execute({ path: './film/edit.otio/overview' }, ctx)))
    assert.notEqual(changed.sourceVersion, overview.sourceVersion)
    assert.deepEqual(JSON.parse(String(await reader.execute({ path: clipsPath }, ctx))).clips.map((c: { read: string }) => c.read), clips.map((c: { read: string }) => c.read))
    await assert.rejects(reader.execute({ path: './film/edit.otio/unknown' }, ctx), /Unknown OTIO/)
    await assert.rejects(reader.execute({ path: './film/edit.otio/tracks/../overview' }, ctx), /Invalid OTIO/)
    await assert.rejects(reader.execute({ path: './film/edit.otio/overview', flag: 'l' }, ctx), /line paging/)
  })
})

test('search yields followable view paths and grep line numbers matching read', async () => {
  await withTempWorkspace(async root => {
    await writeFile(join(root, 'edit.otio'), text)
    const ctx = context(root), search = new SearchTool(root, undefined, undefined, false), reader = new ReadTool(root)
    const found = await search.execute({ handler: 'glob', query: '**', path: './edit.otio', limit: 2 }, ctx)
    assert.match(found, /\.\/edit.otio\/overview/)
    assert.match(found, /more: offset=2/)
    const grep = await search.execute({ handler: 'grep', query: 'Video', path: './edit.otio/tracks' }, ctx)
    const match = /(.+\/tracks):(\d+):/.exec(grep)!
    assert.ok(match)
    assert.match(String(await reader.execute({ path: match[1], offset: Number(match[2]), limit: 1 }, ctx)), /Video/)
  })
})

test('parser boundaries are shared; routes fail closed for remote and LayerFS without executor calls', async () => {
  assert.equal(otioSubpath('edit.otio'), undefined)
  assert.equal(otioSubpath('https://host/edit.otio/overview'), undefined)
  assert.deepEqual(otioSubpath('film\\edit.otio\\overview'), { source: 'film\\edit.otio', view: 'overview' })
  assert.throws(() => projectOtio('{}', 'x.otio'), /OTIO/)
  assert.throws(() => projectOtio(text.replace(/"rate":[^,}]+/, '"rate":0'), 'x.otio'), /JSON|OTIO/)
  for (const locality of [{ remoteWorkdir: { nodeId: 'child', workdirId: 'w', executor: { execute() { throw new Error('must not dispatch') } } } }, { layerfsWorkdir: { workspace: 'layerfs:not-real' } }]) {
    const ctx = { ...context('/not-a-main-path'), ...locality } as ExecutionContext
    await assert.rejects(new ReadTool('/not-home').execute({ path: 'edit.otio/overview' }, ctx), /No Main filesystem fallback/)
    await assert.rejects(new SearchTool('/not-home').execute({ handler: 'glob', query: '**', path: 'edit.otio' }, ctx), /No Main filesystem fallback/)
  }
})

test('explicit workspace authority is resolved before OTIO source access', async () => {
  await withTempWorkspace(async root => {
    const selected = join(root, 'selected')
    await mkdir(selected)
    await writeFile(join(selected, 'edit.otio'), text)
    const ctx = { ...context('/not-a-main-path'), resolveToolTarget: async (workspace: string, operation: string) => {
      assert.equal(operation, 'filesystem.read')
      if (workspace !== 'allowed') throw new Error('permission denied')
      return { cwd: selected, fileChangeTarget: { nodeId: 'local', workdirId: 'allowed' } }
    } } as ExecutionContext
    const reader = new ReadTool(root)
    assert.match(String(await reader.execute({ workspace: 'allowed', path: './edit.otio/overview' }, ctx)), /Film/)
    await assert.rejects(reader.execute({ workspace: 'denied', path: './edit.otio/overview' }, ctx), /permission denied/)
    await assert.rejects(new SearchTool(root).execute({ workspace: 'denied', handler: 'glob', query: '**', path: './edit.otio' }, ctx), /permission denied/)
    await writeFile(join(selected, 'broken.otio'), Buffer.from([0xff]))
    await assert.rejects(reader.execute({ workspace: 'allowed', path: 'broken.otio/overview' }, ctx), /encoded data/)
    await writeFile(join(selected, 'broken.otio'), '{')
    await assert.rejects(reader.execute({ workspace: 'allowed', path: 'broken.otio/overview' }, ctx), /JSON|property name/i)
  })
})

// 18k+ legal nodes under deep compositions exercises the old descendant-copy blowup.
function largeTimeline(): string {
  const clip = fixture.tracks.children[0]!.children[0]!
  let stack: unknown = { OTIO_SCHEMA: 'Stack.1', children: Array.from({ length: 9000 }, (_, i) => ({
    OTIO_SCHEMA: 'Track.1', kind: 'Video', name: `group-${i}`, children: [{ ...clip, name: `large-shot-${i}` }],
  })) }
  for (let i = 0; i < 20; i++) stack = { OTIO_SCHEMA: 'Stack.1', children: [{ OTIO_SCHEMA: 'Track.1', kind: 'Video', children: [stack] }] }
  return JSON.stringify({ OTIO_SCHEMA: 'Timeline.1', tracks: stack })
}

test('large index stays lazy: overview, one clip and far-offset pages never materialize unrelated views', async () => {
  const input = largeTimeline()
  const index = projectOtio(input, './large.otio')
  assert.deepEqual(index.metrics, { viewsOpened: 0, recordsSerialized: 0 })
  const overviewText = otioPage(index, './large.otio/overview', 0, 200)
  const overview = JSON.parse(overviewText)
  assert.equal(overview.clipCount, 9000)
  assert.ok(overviewText.length < 2000)
  assert.equal(overview.clips, undefined)
  assert.deepEqual(index.metrics, { viewsOpened: 1, recordsSerialized: 1 })
  const clipPath = Array.from(index.paths).find(p => p.startsWith('./large.otio/clips/'))!
  assert.equal(JSON.parse(otioPage(index, clipPath, 0, 200)).clip.name, 'large-shot-0')
  assert.deepEqual(index.metrics, { viewsOpened: 2, recordsSerialized: 2 })
  const row = otioPage(index, './large.otio/clips', 5000, 1)
  assert.match(row, /large-shot-/)
  assert.match(row, /offset=5002/)
  assert.equal(index.metrics.recordsSerialized, 3) // No 5000 skipped records were serialized.
  const trackPath = Array.from(index.paths).find(p => p.startsWith('./large.otio/tracks/'))!
  const detail = JSON.parse(otioPage(index, trackPath, 0, 200))
  assert.equal(detail.children.length, 1) // Direct Stack, not all 9000 descendant clips.
  assert.equal(detail.children[0].kind, 'Stack')
  const beforePage = index.metrics.recordsSerialized
  const boundedPage = otioPage(index, './large.otio/clips', 0, Number.MAX_SAFE_INTEGER)
  assert.ok(boundedPage.length < OTIO_PAGE_CHARS + 200)
  assert.ok(boundedPage.split('\n').length <= 203)
  assert.match(boundedPage, /more: use offset=/)
  assert.ok(index.metrics.recordsSerialized - beforePage <= 201)
  const globIndex = projectOtio(input, './large.otio')
  assert.match(otioSearch(globIndex, 'glob', '**', './large.otio', 0, 1), /more: offset=1/)
  assert.deepEqual(globIndex.metrics, { viewsOpened: 0, recordsSerialized: 0 })
  const found = otioSearch(globIndex, 'grep', 'large-shot-0', clipPath, 0, 1)
  assert.match(found, /large-shot-0/)
  assert.equal(globIndex.metrics.viewsOpened, 1)
  const limited = otioSearch(globIndex, 'grep', 'not-in-this-source', './large.otio', 0, 100)
  assert.match(limited, /scan budget reached/)
  assert.ok(limited.length < OTIO_PAGE_CHARS)
  assert.ok(globIndex.metrics.viewsOpened <= OTIO_SEARCH_VIEWS + 1)
  assert.ok(globIndex.metrics.recordsSerialized <= OTIO_SEARCH_LINES + 3)
  await withTempWorkspace(async root => {
    await writeFile(join(root, 'large.otio'), input)
    const reader = new ReadTool(root), ctx = context(root)
    const routeOverview = JSON.parse(String(await reader.execute({ path: './large.otio/overview' }, ctx)))
    assert.equal(routeOverview.clipCount, 9000)
    const routePage = String(await reader.execute({ path: './large.otio/clips', offset: 5001, limit: 1 }, ctx))
    assert.equal(routePage, row)
    const search = await new SearchTool(root).execute({ path: './large.otio', handler: 'grep', query: 'not-in-this-source', limit: 1 }, ctx)
    assert.match(search, /scan budget reached/)
  })
})

test('oversize authored clip records produce explicit source-pointer omission and bounded output', () => {
  const huge = structuredClone(fixture)
  Object.assign(huge.tracks.children[0]!.children[0]!, { metadata: { comment: 'x'.repeat(100_000) } })
  const index = projectOtio(JSON.stringify(huge), 'huge.otio')
  const path = Array.from(index.paths).find(p => p.startsWith('huge.otio/clips/'))!
  const page = otioPage(index, path, 0, 200)
  assert.ok(page.length < OTIO_PAGE_CHARS)
  const body = JSON.parse(page)
  assert.match(body.omitted, /read the raw source/)
  assert.equal(body.sourcePointer, '/tracks/children/0/children/0')
  assert.match(body.sourceVersion, /^sha256:/)
})

test('every page fragment and search receipt carries its actual snapshot without shifting body lines', async () => {
  await withTempWorkspace(async root => {
    const source = './edit.otio', path = `${source}/tracks`, ctx = context(root)
    const reader = new ReadTool(root), search = new SearchTool(root)
    const receipt = (output: string) => {
      const match = /^\[OTIO snapshot (.+)\]$/m.exec(output)
      assert.ok(match, 'fragment/search must expose snapshot metadata')
      return JSON.parse(match[1]!) as { source: string; sourceVersion: string }
    }
    let previousVersion = '', previousBody = ''
    for (const input of [text, text.replace('Film', 'Changed')]) {
      await writeFile(join(root, 'edit.otio'), input)
      const expected = { source, sourceVersion: `sha256:${createHash('sha256').update(input).digest('hex')}` }
      const full = String(await reader.execute({ path }, ctx))
      // A complete first page remains pure JSON, not prefixed by a receipt.
      assert.equal(JSON.parse(full).sourceVersion, expected.sourceVersion)
      const grep = await search.execute({ handler: 'grep', query: 'Video', path, limit: 1 }, ctx)
      assert.deepEqual(receipt(grep), expected)
      const match = /(?:^|\n)(\.\/edit\.otio\/tracks):(\d+):([^\n]+)/.exec(grep)!
      assert.ok(match)
      const line = Number(match[2])
      const page = String(await reader.execute({ path, offset: line, limit: 1, flag: 'n' }, ctx))
      assert.deepEqual(receipt(page), expected)
      const body = page.split('\n')[1]!
      assert.equal(body, `${line}  ${match[3]}`) // Receipt consumes no view line number.
      assert.equal(full.split('\n')[line - 1], match[3])
      assert.deepEqual(receipt(String(await reader.execute({ path, offset: 1, limit: 1 }, ctx))), expected)
      assert.deepEqual(receipt(String(await reader.execute({ path, offset: 1000, limit: 1 }, ctx))), expected)
      for (const handler of ['glob', 'grep']) {
        const result = await search.execute({ handler, query: handler === 'glob' ? '**' : 'Video', path: source, offset: 1, limit: 1 }, ctx)
        assert.deepEqual(receipt(result), expected)
      }
      assert.deepEqual(receipt(await search.execute({ handler: 'grep', query: 'absent', path }, ctx)), expected)
      if (previousVersion) {
        assert.notEqual(expected.sourceVersion, previousVersion)
        assert.equal(body, previousBody) // Source edit changed hash, not the selected list record.
      }
      previousVersion = expected.sourceVersion; previousBody = body
    }
  })
})


test('profile-aware views preserve source mapping and expose supported effects without probing media', () => {
  const raw = JSON.parse(text)
  const clip = raw.tracks.children[0].children[0]
  clip.effects = [{ OTIO_SCHEMA: 'Effect.1', effect_name: 'shadow.opacity', metadata: { shadow: { profile: 'opacity', value: 0.5 } } }]
  const index = projectOtio(JSON.stringify(raw), 'edit.otio')
  const overview = JSON.parse(otioPage(index, 'edit.otio/overview', 0, 200))
  assert.equal(overview.renderProfile.supported, true)
  assert.equal(overview.renderProfile.requiresCompositePreview, true)
  const effects = JSON.parse(otioPage(index, 'edit.otio/effects', 0, 200)).effects
  assert.equal(effects[0].parsed[0].value, 0.5)
  const clips = JSON.parse(otioPage(index, 'edit.otio/clips', 0, 200)).clips
  assert.deepEqual(clips[0].sourceStart, { value: 101, rate: 24000 / 1001 })
  assert.equal(clip.media_reference.target_url, 'https://invalid.example/never-fetch.mov')
  clip.effects[0].effect_name = 'unknown.plugin'
  const unsupported = projectOtio(JSON.stringify(raw), 'edit.otio')
  const diagnostics = JSON.parse(otioPage(unsupported, 'edit.otio/diagnostics', 0, 200))
  assert.equal(diagnostics.renderProfile.supported, false)
  assert.match(diagnostics.renderProfile.error, /effect/)
  assert.equal(JSON.parse(otioPage(unsupported, 'edit.otio/clips', 0, 200)).clips[0].sourceStart, null)
})
