import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { compileBackend } from '../../../scripts/backend-bundle.ts'

test('compiled LayerFS helpers run as Node under Electron even when the backend flag is absent', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.layerfs-launch-test-'))
  try {
    await compileBackend(process.cwd(), join(directory, 'compiled'), ['execution/layerfs/managed', 'execution/layerfs/bridge'])
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }))
    // Synthetic SDK only: no WSL, Docker, real worker, source import or persisted approval.
    await writeFile(join(directory, 'sdk.mjs'), `
      if (process.env.ELECTRON_RUN_AS_NODE !== '1') throw Error('missing Node mode');
      export const LayerFSRuntime = { open: async () => ({
        worker: { start: async () => {} },
        status: async () => ({worker:{state:'running',answering:true},docker:{level:'ok'}}),
        close: async () => {}
      }) };
      export const LayerFS = { open: async () => ({
        project: { list_branches: async () => ({nodeMode:process.env.ELECTRON_RUN_AS_NODE,electron:process.versions.electron ?? null}) },
        close: async () => {}
      }) };
    `)
    await writeFile(join(directory, 'smoke.mjs'), `
      import assert from 'node:assert/strict';
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { join } from 'node:path';
      // Match the desktop utility backend, which deliberately removes this flag.
      delete process.env.ELECTRON_RUN_AS_NODE;
      const spawn = childProcess.spawn; let launches = 0;
      childProcess.spawn = (executable, args, options) => {
        // Fail before launching a GUI if either production path regresses.
        assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
        assert.equal(executable, process.execPath); launches++;
        return spawn(executable, args, options);
      };
      syncBuiltinESMExports();
      const {spawnManagedDriver} = await import('./compiled/src/execution/layerfs/managed.js');
      const {runBridge} = await import('./compiled/src/execution/layerfs/bridge.js');
      const sdkModule = join(process.cwd(), 'sdk.mjs');
      const driver = spawnManagedDriver({requestTimeoutMs:5000});
      try {
        const status = await driver.request('open', {runtimeModule:sdkModule,settings:{}}, AbortSignal.timeout(6000));
        assert.equal(status.ready, true);
        assert.equal((await driver.request('status', {}, AbortSignal.timeout(6000))).ready, true);
      } finally { await driver.close(); }
      const receipt = JSON.parse(await runBridge({sdkModule,env:{}}, 'fixture', 'branches', {}, AbortSignal.timeout(6000), 5000));
      assert.deepEqual(receipt, {ok:true,result:{nodeMode:'1',electron:process.versions.electron ?? null}});
      assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined, 'parent environment must stay unchanged');
      console.log(JSON.stringify({launches, electron:process.versions.electron ?? null}));
    `)
    const require = createRequire(new URL('../../../desktop/package.json', import.meta.url))
    const electron = require('electron') as string
    const electronVersion = (require('electron/package.json') as { version: string }).version
    for (const [executable, version] of [[process.execPath, process.versions.electron ?? null], [electron, electronVersion]] as const) {
      const { stdout } = await promisify(execFile)(executable, [join(directory, 'smoke.mjs')], {
        cwd: directory, env: { ...process.env, NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '1' },
        timeout: 20000, windowsHide: true,
      })
      assert.deepEqual(JSON.parse(stdout), { launches: 2, electron: version })
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
