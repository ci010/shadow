import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { sdkLauncher } from './sdk-launcher.ts'

const require = createRequire(import.meta.url)
let electron: string | undefined
try { electron = require('../../../desktop/node_modules/electron') as string } catch { /* optional desktop dependency */ }

for (const [host, executable] of [['Node', process.execPath], ['Electron run-as-node', electron]] as const) {
  test(`SDK launcher preserves failures in a real ${host} subprocess`, { skip: !executable }, async () => {
    const dir = await mkdtemp(join(process.env.SHADOW_SESSION_DATA_DIR ?? process.cwd(), '.sdk-launcher-test-'))
    try {
      const launcher = join(dir, 'launcher.mjs')
      const script = join(dir, 'script.mjs')
      await writeFile(launcher, sdkLauncher({ port: 1, token: 'synthetic', sdkModule: 'unused' }))
      const run = (args: string[]) => spawnSync(executable!, [launcher, ...args], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 15_000,
      })
      for (const source of [
        "export default async () => { await Promise.resolve(); throw Error('fixture job failed'); }",
        "throw Error('fixture job failed'); export default () => {};",
        "export default () => { throw Error('fixture job failed'); }",
      ]) {
        await writeFile(script, source)
        const failed = run([script])
        assert.equal(failed.error, undefined)
        assert.equal(failed.signal, null)
        assert.equal(failed.status, 1, failed.stderr)
        assert.match(failed.stderr, /Error: fixture job failed/)
        assert.match(failed.stderr, /at /)
      }
      await writeFile(script, 'export default 123;')
      assert.equal(run([script]).status, 1)
      assert.equal(run([]).status, 1)
      assert.equal(run([join(dir, 'missing.mjs')]).status, 1)
      await writeFile(script, "export default ({args}) => { console.log(args.join('|')); };")
      const success = run([script, 'one', 'two'])
      assert.equal(success.error, undefined)
      assert.equal(success.status, 0, success.stderr)
      assert.equal(success.stdout.trim(), 'one|two')
      await writeFile(script, 'export default () => { process.exitCode = 7; };')
      assert.equal(run([script]).status, 7)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}
