import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExecutionContext } from '../tools/context.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { mountCppInstallations } from './cpp-installations.ts'
import { VirtualFs } from './virtual-fs.ts'

const audio = 'v:cpp-installations/audio-cpp'
const diffusion = 'v:cpp-installations/diffusion-cpp'
const main = { projectId: 'fixture', tools: {}, signal: new AbortController().signal } as ExecutionContext
const child = { ...main, remoteWorkdir: { nodeId: '../../device', workdirId: 'opaque' } } as ExecutionContext
const sha = 'a'.repeat(64)

test('CPP inventory scopes records to Project, device and runtime without reading device paths', async () => {
  await withTempWorkspace(async workspace => {
    const vfs = new VirtualFs()
    mountCppInstallations(vfs, workspace, 'fixture', 'fixture-main')
    const read = async (path: string, context: ExecutionContext) => JSON.parse(await vfs.resolve(path, context) ?? '')
    const missing = await read(audio, main)
    assert.equal(missing.installed, false)
    assert.deepEqual(missing.node, { kind: 'local', id: 'fixture-main' })
    const { installed: _, ...scope } = missing
    const binary = { path: '/unmounted/audiocpp_cli', version: 'rev 1', source: null, expectedSha256: null, observedSha256: sha }
    const doc = { ...scope, binary, weights: [{ role: 'asr', path: '/unmounted/model.gguf', source: 'pinned release', expectedSha256: sha, observedSha256: sha }] }
    const put = async (path: string, content: unknown, context: ExecutionContext) => vfs.write(path, { content: JSON.stringify(content) }, context)
    await put(audio, doc, main)
    assert.deepEqual(await read(audio, main), doc)
    assert.equal((await read(diffusion, main)).installed, false)
    assert.equal((await read(audio, child)).installed, false)
    await assert.rejects(put(audio, doc, child), /does not match/)
    await assert.rejects(put(diffusion, doc, main), /does not match/)
    await assert.rejects(put(audio, doc, { ...main, projectId: 'other' }), /owning Project/)
    await assert.rejects(async () => read(audio, { ...main, projectId: 'other' }), /owning Project/)
    await assert.rejects(put(audio, doc, { ...main, layerfsWorkdir: { workspace: 'layerfs:test' } }), /device execution scope/)
    await assert.rejects(put(audio, { ...doc, binary: { ...binary, path: 'C:relative.exe' } }, main), /absolute device path/)
    await assert.rejects(put(audio, { ...doc, binary: { ...binary, observedSha256: 'bogus' } }, main), /observedSha256/)
    const childDoc = { ...doc, node: (await read(audio, child)).node, binary: { ...binary, path: 'D:\\tools\\audiocpp_cli.exe' } }
    await put(audio, childDoc, child)
    assert.deepEqual(await read(audio, child), childDoc)
    assert.deepEqual(await read(audio, main), doc)
    const reopened = new VirtualFs()
    mountCppInstallations(reopened, workspace, 'fixture', 'another-main')
    assert.equal(JSON.parse(await reopened.resolve(audio, main) ?? '').installed, false)
    assert.deepEqual(JSON.parse(await reopened.resolve(audio, child) ?? ''), childDoc)
  })
})
