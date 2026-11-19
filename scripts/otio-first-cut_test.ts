import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseOtio, otioPictureAt, otioSourceTime } from '../app/src/otio-model.ts'
import { resolveOtioMedia } from '../app/src/otio-review.ts'
import { discoverFolderSkills } from '../src/skills/folder.ts'
import { withTempWorkspace } from '../src/testing/workspace.ts'

const sample = fileURLToPath(new URL('../examples/otio-first-cut/', import.meta.url))
const scaffold = join(sample, '.agents', 'skills', 'video-editor', 'scaffold.mjs')

test('Moonrise links only shipped media and matches the review exercise at the cut, trim and overlay', async () => {
  const model = parseOtio(await readFile(join(sample, 'cut.otio'), 'utf8'))
  assert.deepEqual([model.rate, model.duration], [24, 8])
  assert.deepEqual(new Set(model.nodes.map(node => node.kind)), new Set(['Timeline', 'Stack', 'Track', 'Clip', 'Gap', 'Transition']))
  const scenes = ['media/dusk.png', 'media/moonrise.mp4', 'media/field-note.png']
  for (const clip of model.nodes.filter(node => node.kind === 'Clip')) {
    const media = resolveOtioMedia('cut.otio', clip.targetUrl!)
    assert.ok(media && scenes.includes(media.path))
    assert.ok((await stat(join(sample, media.path))).isFile())
  }
  for (const [frame, scene] of [[0, 0], [47, 0], [48, 1], [96, 1], [167, 1], [168, 2], [191, 2]] as const) {
    assert.equal(otioPictureAt(model, frame / model.rate)?.targetUrl, scenes[scene])
  }
  const selected = otioPictureAt(model, 4)!
  assert.deepEqual(otioSourceTime(selected, 4), { value: 60, rate: 24 })
  assert.notEqual(otioPictureAt(model, 7)?.id, selected.id)
  assert.equal(otioPictureAt(model, 8), null)
  const transition = model.nodes.find(node => node.kind === 'Transition')!
  assert.deepEqual([transition.start * model.rate, transition.end * model.rate], [42, 54])
})

test('folder skill scaffolds a real new rough cut without assets, overwrites, or path escapes', async () => {
  const skills = await discoverFolderSkills({ folderId: 'sample', path: sample })
  assert.deepEqual(skills.map(skill => skill.meta.name), ['video-editor'])
  assert.deepEqual(Object.keys(skills[0]!.meta.tools ?? {}), [])
  await withTempWorkspace(async cwd => {
    const run = (...args: string[]) => spawnSync(process.execPath, [scaffold, ...args], { cwd, encoding: 'utf8' })
    assert.equal(run('--help').status, 0)
    for (const args of [[], ['../outside'], ['D:\\outside'], ['CON'], ['bad/name'], ['name', 'extra']]) assert.equal(run(...args).status, 1)
    assert.deepEqual(await readdir(cwd), [])
    const title = '夜航 01', root = join(cwd, title)
    const result = run(title)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual((await readdir(root)).sort(), ['cut-v001.otio', 'media', 'shots.md'])
    assert.deepEqual(await readdir(join(root, 'media')), [])
    const project = parseOtio(await readFile(join(root, 'cut-v001.otio'), 'utf8'))
    assert.deepEqual([project.root.name, project.rate, project.duration], [title, 24, 8])
    assert.deepEqual(project.nodes.filter(n => n.kind === 'Gap').map(n => [n.start, n.end]), [[0, 2], [2, 6], [6, 8]])
    assert.equal(otioPictureAt(project, 4), null)
    await writeFile(join(root, 'shots.md'), 'user notes')
    assert.equal(run(title).status, 1)
    assert.equal(await readFile(join(root, 'shots.md'), 'utf8'), 'user notes')
  })
})
