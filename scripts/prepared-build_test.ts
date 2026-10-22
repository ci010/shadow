import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { withTempWorkspace } from '../src/testing/workspace.ts'
import { parseBuildSelection, recordPreparedBuild, verifyPreparedBuild } from './prepared-build.ts'
import { sourceFingerprint } from './release-manifest.ts'

async function fixture(root: string) {
  for (const path of ['src', 'dist', 'desktop/dist', 'app/dist', 'app/dist-mobile']) {
    await mkdir(join(root, path), { recursive: true })
    await writeFile(join(root, path, 'entry.js'), `fixture for ${path}`)
  }
  return sourceFingerprint(root)
}

test('shared build selection is explicit and bounded', () => {
  for (const target of ['desktop', 'mobile', 'all']) assert.equal(parseBuildSelection(target), target)
  for (const target of [undefined, '', 'unknown']) assert.throws(() => parseBuildSelection(target), /Select desktop/)
})

test('one receipt shares independent desktop and mobile outputs without mixing bundles', async () => {
  await withTempWorkspace(async root => {
    const source = await fixture(root)
    await recordPreparedBuild(root, 'all', source)
    assert.equal(await verifyPreparedBuild(root, 'desktop'), source)
    assert.equal(await verifyPreparedBuild(root, 'mobile'), source)
    await writeFile(join(root, 'app/dist-mobile/entry.js'), 'stale mobile')
    assert.equal(await verifyPreparedBuild(root, 'desktop'), source)
    await assert.rejects(verifyPreparedBuild(root, 'mobile'), /Prepared output changed/)
  })
})

test('shared artifacts reject changed source before recording and before native packaging', async () => {
  await withTempWorkspace(async root => {
    const source = await fixture(root)
    await recordPreparedBuild(root, 'desktop', source)
    await assert.rejects(verifyPreparedBuild(root, 'mobile'), /incompatible/)
    await writeFile(join(root, 'src/entry.js'), 'changed')
    await assert.rejects(recordPreparedBuild(root, 'desktop', source), /Source changed/)
    await assert.rejects(verifyPreparedBuild(root, 'desktop'), /current source/)
  })
})

test('mobile-only preparation binds mobile build inputs without requiring desktop output', async () => {
  await withTempWorkspace(async root => {
    await fixture(root)
    await mkdir(join(root, 'mobile'))
    await writeFile(join(root, 'mobile/package.json'), '{"name":"mobile"}')
    await recordPreparedBuild(root, 'mobile', await sourceFingerprint(root))
    await rm(join(root, 'dist'), { recursive: true })
    await verifyPreparedBuild(root, 'mobile')
    await assert.rejects(verifyPreparedBuild(root, 'desktop'), /incompatible/)
    await writeFile(join(root, 'mobile/package.json'), '{"name":"changed-mobile"}')
    await assert.rejects(verifyPreparedBuild(root, 'mobile'), /current source/)
  })
})

test('modified, extra, missing outputs and receipts cannot silently trigger an unchecked package', async () => {
  for (const change of ['modified', 'extra', 'missing', 'receipt', 'version'] as const) {
    await withTempWorkspace(async root => {
      await recordPreparedBuild(root, 'desktop', await fixture(root))
      if (change === 'modified') await writeFile(join(root, 'dist/entry.js'), 'modified')
      if (change === 'extra') await writeFile(join(root, 'dist/unexpected.js'), 'extra')
      if (change === 'missing') await rm(join(root, 'desktop/dist/entry.js'))
      if (change === 'receipt') await rm(join(root, 'release-prepared.json'))
      if (change === 'version') {
        const receipt = JSON.parse(await readFile(join(root, 'release-prepared.json'), 'utf8'))
        await writeFile(join(root, 'release-prepared.json'), JSON.stringify({ ...receipt, version: 2 }))
      }
      await assert.rejects(verifyPreparedBuild(root, 'desktop'))
    })
  }
})
