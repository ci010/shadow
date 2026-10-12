import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../../testing/workspace.ts'

test('persisted disabled policy starts and fetches directly despite invalid inherited proxy credentials', async () => {
  const server = createServer((_request, response) => response.end('direct startup'))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    await withTempWorkspace(async root => {
      const path = join(root, 'config.json')
      await writeFile(path, JSON.stringify({ network: { proxyEnabled: false } }))
      const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
        import { readFileSync } from 'node:fs';
        import { ConfigSchema } from ${JSON.stringify(new URL('../../config/schema.ts', import.meta.url).href)};
        import { initializeBackendNetwork } from ${JSON.stringify(new URL('./backend.ts', import.meta.url).href)};
        import { getGlobalDispatcher } from 'undici';
        const config = ConfigSchema.parse(JSON.parse(readFileSync(${JSON.stringify(path)}, 'utf8')));
        await initializeBackendNetwork(config.network?.proxyEnabled ?? true);
        console.log(await (await fetch('http://127.0.0.1:${address.port}/')).text());
        await getGlobalDispatcher().close();
      `], { env: { ...process.env, http_proxy: 'http://user:private-password@proxy.invalid', https_proxy: 'not a URL', HTTP_PROXY: 'invalid', HTTPS_PROXY: 'invalid' }, timeout: 15_000, windowsHide: true })
      assert.match(result.stdout, /direct startup/)
      assert.doesNotMatch(result.stdout + result.stderr, /private-password/)
    })
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
