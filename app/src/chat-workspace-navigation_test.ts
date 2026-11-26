import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { compileScript, parse } from 'vue/compiler-sfc'
import { createRenderer, h } from 'vue'

test('channel workspaces forward session requests without a ChatTab; ordinary chats retain delegation', async t => {
  const directory = resolve('app/.test-artifacts', `workspace-navigation-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = await readFile(resolve('app/src/components/ChatWorkspace.vue'), 'utf8')
  const script = compileScript(parse(source).descriptor, { id: 'workspace-navigation' }).content
  await build({
    stdin: { contents: script, loader: 'ts', resolveDir: resolve('app/src/components') },
    outfile: resolve(directory, 'component.mjs'), bundle: true, format: 'esm', platform: 'node', external: ['vue'],
    plugins: [{ name: 'children', setup(builder) {
      builder.onResolve({ filter: /\.vue$|\/i18n\.ts$/ }, args => ({ path: args.path, namespace: 'stub' }))
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: args.path.endsWith('.vue')
        ? 'export default {}' : 'export const t = x => x', loader: 'ts' }))
    } }],
  })
  const definition = (await import(pathToFileURL(resolve(directory, 'component.mjs')).href)).default
  definition.render = () => null
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
    parentNode: () => null, nextSibling: () => null,
  })
  const navigated: string[] = []
  const app = renderer.createApp({ render: () => h(definition, {
    apiBase: '', managed: true, sessionId: 'channel-index', onNavigate: (id: string) => navigated.push(id),
  }) })
  const vm = app.mount({})
  t.after(() => app.unmount())
  const instance = vm.$.subTree.component!
  const exposed = instance.exposed as { requestSession(id: string): void }
  exposed.requestSession('web:ordinary')
  exposed.requestSession('web:another')
  assert.deepEqual(navigated, ['web:ordinary', 'web:another'])
  const delegated: string[] = []
  ;(instance as any).setupState.primary = { requestSession: (id: string) => delegated.push(id) }
  exposed.requestSession('child-inspection')
  assert.deepEqual(delegated, ['child-inspection'])
  assert.deepEqual(navigated, ['web:ordinary', 'web:another'], 'ChatTab owns child/primary routing when present')
})
