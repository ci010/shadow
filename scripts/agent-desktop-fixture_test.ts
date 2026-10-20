import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { buildComputerFixture } from './agent-desktop-fixture.ts'

test('synthetic interactive fixture builds and metadata probe does not launch its UI', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadow-fixture-metadata-'))
  try {
    const output = join(directory, 'fixture.exe')
    await buildComputerFixture(fileURLToPath(new URL('..', import.meta.url)), output)
    const { stdout } = await promisify(execFile)(output, ['--identity'], { windowsHide: true, timeout: 5000 })
    const identity = JSON.parse(stdout)
    assert.equal(identity.protocol, 1)
    assert.equal(identity.backend, 'shadow-computer-fixture')
    assert.match(identity.sourceSha256, /^[a-f0-9]{64}$/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
