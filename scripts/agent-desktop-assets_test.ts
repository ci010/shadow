import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readdir, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { copyAgentDesktopAssets } from './agent-desktop-assets.ts'
import { AGENT_DESKTOP_REPOSITORY, AGENT_DESKTOP_REVISION, AGENT_DESKTOP_VERSION, agentDesktopDirectory, agentDesktopHash, agentDesktopTarget, verifyAgentDesktopAssets } from './agent-desktop-integrity.ts'

for (const platform of ['darwin', 'linux', 'win32']) for (const arch of ['x64', 'arm64']) {
  test(`official CLI packaging ${platform}-${arch}: allowlist, integrity and required helpers`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'shadow-cli-assets-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const target = agentDesktopTarget(platform, arch)
    const directory = agentDesktopDirectory(root, platform, arch)
    await mkdir(directory, { recursive: true })
    const files: Record<string, string> = {}
    for (const file of target.files) {
      const bytes = Buffer.from(`inert fixture ${file}`)
      await writeFile(join(directory, file), bytes, { mode: 0o755 })
      files[file] = agentDesktopHash(bytes)
    }
    await writeFile(join(directory, 'manifest.integrity.json'), JSON.stringify({ schema: 1,
      repository: AGENT_DESKTOP_REPOSITORY, version: AGENT_DESKTOP_VERSION, revision: AGENT_DESKTOP_REVISION,
      platform, arch, archive: { name: target.name, sha256: target.sha256 }, files }))
    await writeFile(join(root, 'integrations/agent-desktop/LICENSE'), 'Apache-2.0 fixture')
    await writeFile(join(root, 'integrations/agent-desktop/NOTICE'), 'official CLI fixture')
    await writeFile(join(directory, 'shadow-agent-desktop.node'), 'must not copy')
    await writeFile(join(directory, 'session-private-state'), 'must not copy')
    const verify = (root: string, platform: string, arch: string) => verifyAgentDesktopAssets(root, platform, arch, files)
    // A forged receipt with internally consistent fake file hashes is not enough.
    await assert.rejects(verifyAgentDesktopAssets(root, platform, arch), /Unpinned/)
    const output = join(root, 'output')
    assert.equal(await copyAgentDesktopAssets(root, output, { platform, arch }, verify), true)
    assert.deepEqual((await readdir(agentDesktopDirectory(output, platform, arch))).sort(), [...target.files, 'manifest.integrity.json'].sort())
    await verify(output, platform, arch)
    await writeFile(join(agentDesktopDirectory(output, platform, arch), 'stale-addon.node'), 'do not package')
    await copyAgentDesktopAssets(root, output, { platform, arch }, verify)
    assert.deepEqual((await readdir(agentDesktopDirectory(output, platform, arch))).sort(), [...target.files, 'manifest.integrity.json'].sort())
    await assert.rejects(copyAgentDesktopAssets(root, root, { platform, arch }, verify), /separate from the source/)
    const required = join(directory, target.files.at(-1)!)
    await writeFile(required, 'tampered')
    await assert.rejects(copyAgentDesktopAssets(root, output, { platform, arch }, verify), /Missing or invalid/)
    await rm(required)
    await assert.rejects(copyAgentDesktopAssets(root, output, { platform, arch }, verify), /Missing or invalid/)
  })
}

test('unsupported targets fail, rather than silently omit desktop integration', () => {
  assert.throws(() => agentDesktopTarget('linux', 'ia32'), /Unsupported/)
  assert.throws(() => agentDesktopTarget('freebsd', 'x64'), /Unsupported/)
})
