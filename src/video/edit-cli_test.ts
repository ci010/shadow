import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'
import { runVideoCli } from './cli.ts'

test('CLI edit produces a new revision without probing media or replacing the source', async () => {
  const dir = await mkdtemp(path.join(fileURLToPath(new URL('../../', import.meta.url)), '.tmp-video-edit-cli-'))
  try {
    const source = path.join(dir, 'edit.otio'), output = path.join(dir, 'edit-v2.otio'), patch = path.join(dir, 'changes.json')
    const initial = await runVideoCli(['init', source, '--duration', '2', '--rate', '24']) as { revision: string }
    const original = await readFile(source, 'utf8')
    await writeFile(patch, JSON.stringify([
      { op: 'test', path: '/name', value: 'Agent video' },
      { op: 'replace', path: '/name', value: 'Reviewed assembly' },
      { op: 'add', path: '/metadata', value: { author: 'Agent', preserved: true } },
    ]))
    const receipt = await runVideoCli(['edit', source, '--patch', patch, '--revision', initial.revision, '--output', output]) as { file: string; sourceRevision: string; revision: string; operations: number; duration: number; rate: number }
    assert.equal(receipt.file, output)
    assert.equal(receipt.sourceRevision, initial.revision)
    assert.notEqual(receipt.revision, initial.revision)
    assert.match(receipt.revision, /^[a-f0-9]{64}$/)
    assert.equal(receipt.operations, 3)
    assert.equal(receipt.duration, 2)
    assert.equal(receipt.rate, 24)
    assert.equal(await readFile(source, 'utf8'), original)
    const result = JSON.parse(await readFile(output, 'utf8'))
    assert.equal(result.name, 'Reviewed assembly')
    assert.deepEqual(result.metadata, { author: 'Agent', preserved: true })
    await assert.rejects(runVideoCli(['edit', source, '--patch', patch, '--revision', initial.revision, '--output', output]))
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), result)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('CLI edit rejects missing, duplicate and render-only options before producing output', async () => {
  const dir = await mkdtemp(path.join(fileURLToPath(new URL('../../', import.meta.url)), '.tmp-video-edit-cli-'))
  try {
    const source = path.join(dir, 'absent.otio'), patch = path.join(dir, 'changes.json'), output = path.join(dir, 'new.otio')
    await assert.rejects(runVideoCli(['edit', source]), /requires --patch/)
    await assert.rejects(runVideoCli(['edit', source, '--patch', patch, '--patch', patch]), /Invalid\/duplicate/)
    await assert.rejects(runVideoCli(['edit', source, '--ffmpeg', 'not-an-encoder']), /Invalid\/duplicate/)
    await assert.rejects(runVideoCli(['edit', source, '--patch', 'https://example.invalid/patch.json', '--revision', '0'.repeat(64), '--output', output]))
    assert.deepEqual(await readdir(dir), [])
  } finally { await rm(dir, { recursive: true, force: true }) }
})


test('CLI init accepts exact fractional-rate frame counts and rejects ambiguous duration', async () => {
  const dir = await mkdtemp(path.join(fileURLToPath(new URL('../../', import.meta.url)), '.tmp-video-edit-cli-'))
  try {
    const source = path.join(dir, 'ntsc.otio')
    await runVideoCli(['init', source, '--frames', '150', '--rate', String(30000 / 1001)])
    const timeline = JSON.parse(await readFile(source, 'utf8'))
    const duration = timeline.tracks.children[0].children[0].source_range.duration
    assert.equal(duration.value, 150)
    assert.equal(duration.rate, 30000 / 1001)
    await assert.rejects(runVideoCli(['init', path.join(dir, 'ambiguous.otio'), '--frames', '150', '--duration', '5']), /not both/)
    await assert.rejects(runVideoCli(['init', path.join(dir, 'fractional.otio'), '--frames', '1.5']), /frame/i)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('CLI rejects invalid preview publication options before rendering', async () => {
  const args = ['preview', 'absent.otio', '--revision', '0'.repeat(64), '--output', 'unused.mp4', '--start', '0', '--end', '1']
  await assert.rejects(runVideoCli([...args, '--manifest-revision', '0'.repeat(64)]), /requires --manifest/)
  await assert.rejects(runVideoCli([...args, '--manifest', 'absent.otio.preview.json', '--manifest-revision', 'not-a-hash']), /previous manifest SHA256/)
  await assert.rejects(runVideoCli([...args, '--manifest', 'unrelated.json', '--manifest-revision', '0'.repeat(64)]), /limited to the timeline/)
})
