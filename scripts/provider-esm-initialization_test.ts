import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

// Each entry needs a fresh ESM graph: importing V2 first in this test process can
// hide the base -> config store -> factory -> V2 -> base initialization cycle.
for (const entry of ['copilot.ts', 'copilot-v2.ts', 'factory.ts']) {
  test(`provider ESM initializes with ${entry} as the entry point`, () => {
    const url = new URL(`../src/providers/${entry}`, import.meta.url).href
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      await import(${JSON.stringify(url)});
      const base = await import(${JSON.stringify(new URL('../src/providers/copilot.ts', import.meta.url).href)});
      const v2 = await import(${JSON.stringify(new URL('../src/providers/copilot-v2.ts', import.meta.url).href)});
      assert.equal(Object.getPrototypeOf(v2.CopilotAuthenticatorV2), base.CopilotAuthenticator);
      assert.equal(Object.getPrototypeOf(v2.CopilotProviderV2), base.CopilotProvider);
    `], { encoding: 'utf8', timeout: 30_000 })
    assert.ifError(result.error)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  })
}
