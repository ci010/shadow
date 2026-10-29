import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import test from 'node:test'

test('opening ChatTab has no dedicated computer UI, polling or action container', () => {
  const source = readFileSync(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /ComputerControl|computerAccessActions|canUseComputer|computer-use|\/api\/computer/)
  for (const path of ['./computer-use.ts', './components/ComputerControl.vue']) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false)
  }
})
