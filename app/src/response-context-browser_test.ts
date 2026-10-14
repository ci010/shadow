import assert from 'node:assert/strict'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'vite'

test('response context browser bundle never imports Node runtime services', async () => {
  const result = await build({
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    plugins: [{
      name: 'reject-node-runtime-imports',
      enforce: 'pre',
      resolveId(source) {
        if (source.startsWith('node:') || builtinModules.includes(source)) {
          throw new Error(`Browser response context imports Node module: ${source}`)
        }
      },
    }],
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL('../../src/sessions/response-context.ts', import.meta.url)),
        formats: ['es'],
      },
    },
  })
  const bundle = Array.isArray(result) ? result[0] : result
  assert(bundle && 'output' in bundle)
  const entry = bundle.output.find(output => output.type === 'chunk' && output.isEntry)
  assert(entry?.type === 'chunk')
  const browser = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString('base64')}`)
  const context = {
    version: 1, turnId: 'turn', responseId: 'turn:0', source: { kind: 'user' }, userInvolved: true,
  }
  assert.deepEqual(browser.parseResponseContext(context), context)
  assert.equal(browser.continuedUserInvolvement([{
    role: 'user', name: 'runtime-context',
    content: [{ type: 'text', text: '<event type="runtime-context-work" source="runtime-context" event-id="12345678-1234-4123-8123-123456789abc" />' }],
  }]), false)
})
