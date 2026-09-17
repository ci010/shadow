import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { SkillsManager } from './loader.ts'

test('built-in capture guidance is visible in the default summary before tool discovery', async () => {
  const workspace = await mkdtemp(join(process.cwd(), '.io-discovery-test-'))
  const skills = new SkillsManager(workspace)
  try {
    await skills.load()
    for (const admin of [false, true]) {
      const summary = skills.getMetadataSummary(admin)
      const entry = summary.match(/<skill name="io">([^<]+)<\/skill>/)?.[1]
      assert.ok(entry, 'I/O must be inline, not only a name in a tools category')
      for (const trigger of ['audio recording', 'microphone', 'camera/video/screen capture', 'file input', 'interactive forms']) {
        assert.ok(entry.includes(trigger), `Default summary must expose ${trigger}`)
      }
      assert.match(entry, /missing task input/)
    }
    const io = skills.getSkillBody('io')
    assert.ok(io)
    assert.match(io, /io_surface/)
    assert.match(io, /Do not create a standalone HTML recorder merely to obtain missing task input/)
    assert.match(io, /explicit request to build a recording app or website is a development task/)
    assert.match(io, /ask before\s+switching to a separate browser implementation/)
    const browser = skills.getSkillBody('chrome-devtools')
    assert.ok(browser)
    assert.match(browser, /v:skills\/io/)
    assert.match(browser, /unless the user explicitly wants a separate web application/)
  } finally {
    await skills.stopWatching()
    await rm(workspace, { recursive: true, force: true })
  }
})
