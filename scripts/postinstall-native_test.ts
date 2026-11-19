import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { prepareNativeAfterInstall } from './postinstall-native.ts'

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`installation on ${platform} never builds addons or changes the host`, async () => {
    const messages: string[] = []
    await prepareNativeAfterInstall('/inert-fixture', {}, platform, 'arm64', { info: message => { messages.push(message) } })
    assert.equal(messages.length, 1)
    assert.match(messages[0], /No desktop native build or automatic download/)
    assert.match(messages[0], new RegExp(`download-agent-desktop.ts ${platform} arm64`))
  })
}
test('postinstall has no child-process, network, addon repair or system installer dependency', async () => {
  const source = await readFile(new URL('./postinstall-native.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /child_process|fetch\(|repair-agent-desktop|cargo|powershell/i)
})
