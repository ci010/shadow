import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRenderer, defineComponent, h, nextTick, reactive } from 'vue'
import { compileScript, compileStyle, compileTemplate, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { fileLanguage, highlightFile, preserveHighlightSource, type FileHighlightToken } from './file-highlighting.ts'

test('file languages cover code and hidden configuration without guessing unknown extensions', () => {
  for (const [path, language] of [
    ['src/main.TS', 'typescript'], ['src/App.vue', 'vue'], ['.gitmodules', 'ini'], ['folder/.npmrc', 'ini'],
    ['.env.local', 'ini'], ['Dockerfile', 'dockerfile'], ['.bashrc', 'shellscript'],
    ['README.md', 'markdown'], ['index.html', 'html'], ['settings.custom', 'text'], ['.node-version', 'text'], ['LICENSE', 'text'], ['json', 'text'],
  ]) assert.equal(fileLanguage(path!), language)
})

test('Shiki produces real dual-theme tokens for common file languages and hidden config', async () => {
  for (const [path, source] of [
    ['main.ts', 'const value: number = 42;\r\n'],
    ['main.js', 'const value = "hello";\n'],
    ['data.json', '{ "value": true }\n'],
    ['main.py', 'def hello():\n\treturn "hello"\n'],
    ['run.sh', '#!/bin/sh\necho "$HOME"\n'],
    ['main.css', '.app { color: red; }\n'],
    ['App.vue', '<template><span>{{ message }}</span></template>\n<script setup>const message = "hello"</script>\n'],
    ['.gitmodules', '[submodule "example"]\r\n\tpath = example\r\n\turl = https://example.invalid/repo.git\r\n'],
    ['.npmrc', 'registry=https://example.invalid/\nalways-auth=true\n'],
    ['README.md', '# Hello\n\n**source**\n'],
    ['index.html', '<h1 class="title">Hello</h1>\n'],
  ]) {
    // Assert grammar/color correctness independently of concurrent-suite CPU contention.
    const tokens = await highlightFile(source!, path!, { tokenizeTimeLimit: 0 })
    assert.equal(tokens.map(token => token.text).join(''), source, path)
    assert(tokens.some(token => /^#[0-9a-f]{6}$/i.test(token.light ?? '') && /^#[0-9a-f]{6}$/i.test(token.dark ?? '')), path)
    assert(new Set(tokens.map(token => token.light).filter(Boolean)).size > 1, path)
  }
})

test('token spans preserve CRLF, CR, tabs, duplicate text, empty lines, long lines and trailing newlines', async () => {
  for (const source of ['', '\n', '\r\n', '\r', 'const same = 1;\r\n\r\n\t// same\r\n', 'let same = 1;\rlet next = 2;\r', 'x'.repeat(20_000), 'const unicode = "😀";\n\n']) {
    const tokens = await highlightFile(source, 'source.ts')
    assert.equal(tokens.map(token => token.text).join(''), source)
  }
  assert.deepEqual(await highlightFile('unknown\r\n\ttext\n', 'file.unknown'), [{ text: 'unknown\r\n\ttext\n' }])
  assert.deepEqual(preserveHighlightSource('one\r\ntwo\n', [
    { content: 'one', offset: 0, htmlStyle: { color: '#123456', '--shiki-dark': '#abcdef' } },
    { content: 'two', offset: 5 },
  ]), [{ text: 'one', light: '#123456', dark: '#abcdef' }, { text: '\r\n' }, { text: 'two', light: undefined, dark: undefined }, { text: '\n' }])
  assert.throws(() => preserveHighlightSource('text', [{ content: 'changed', offset: 0 }]), /do not match/)
})

test('numbered reads highlight code without feeding line-number prefixes into its grammar', async () => {
  const source = '157  /* comment\r\n158    still a comment */\r\n159  const value = "<script>";\r\n160  \r\n\n[truncated: read more]'
  const tokens = await highlightFile(source, 'main.ts', { lineNumbers: true, tokenizeTimeLimit: 0 })
  assert.equal(tokens.map(token => token.text).join(''), source)
  for (const prefix of ['157  ', '158  ', '159  ', '160  ']) {
    assert.deepEqual(tokens.find(token => token.text === prefix), { text: prefix })
  }
  assert.ok(tokens.some(token => token.text.includes('const') && token.light && token.dark))
  for (const plain of ['', '\n', ' 9  \r\n10  \treturn True\n', '42  123  literal number']) {
    assert.equal((await highlightFile(plain, 'file.py', { lineNumbers: true })).map(token => token.text).join(''), plain)
  }
})

function mountHighlighter(t: TestContext) {
  const pending: { source: string; finish: (tokens: FileHighlightToken[]) => void; fail: () => void }[] = []
  const url = new URL('./components/files/FileHighlightText.vue', import.meta.url)
  const filename = fileURLToPath(url)
  const { descriptor } = parse(readFileSync(url, 'utf8'), { filename })
  assert.deepEqual(compileTemplate({ source: descriptor.template!.content, filename, id: 'highlight' }).errors, [])
  const css = compileStyle({ source: descriptor.styles[0]!.content, filename, id: 'data-v-highlight', scoped: true })
  assert.deepEqual(css.errors, [])
  assert.match(css.code, /\.dark \.file-syntax-token\[data-v-highlight\]/)
  const source = compileScript(descriptor, { id: 'highlight' }).content
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const module = { exports: {} as { default: any } }
  const require = createRequire(url)
  new Function('require', 'module', 'exports', outputText)((id: string) => id.endsWith('/file-highlighting.ts') ? {
    highlightFile: (source: string) => new Promise<FileHighlightToken[]>((finish, reject) =>
      pending.push({ source, finish, fail: () => reject(new Error('synthetic failure')) })),
  } : require(id), module, module.exports)
  module.exports.default.render = () => null
  const props = reactive({ source: 'old\r\n', path: 'old.ts', active: true })
  const errors: string[] = []
  let instance: any
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null,
  })
  const app = renderer.createApp(defineComponent({
    setup: () => () => h(module.exports.default, { ...props, ref: (value: unknown) => { instance = value }, onError: (value: string) => errors.push(value) }),
  }))
  app.mount({})
  t.after(() => app.unmount())
  return { props, pending, errors, state: () => instance.$.setupState }
}
async function settle() { await new Promise(resolve => setImmediate(resolve)); await nextTick() }

test('highlighting ignores stale and hidden requests and exposes failures for explicit retry', async t => {
  const { props, pending, errors, state } = mountHighlighter(t)
  assert.deepEqual(state().tokens, [{ text: 'old\r\n' }])
  props.source = 'new\n'
  props.path = 'new.ts'
  await nextTick()
  pending[1]!.finish([{ text: 'new\n', light: '#123456' }])
  await settle()
  pending[0]!.finish([{ text: 'old\r\n', light: '#abcdef' }])
  await settle()
  assert.equal(state().tokens[0].text, 'new\n')
  void state().retry()
  pending[2]!.fail()
  await settle()
  assert.match(errors.at(-1)!, /highlighting is unavailable/)
  void state().retry()
  assert.equal(errors.at(-1), '')
  props.active = false
  await nextTick()
  pending[3]!.finish([{ text: 'hidden', light: '#123456' }])
  await settle()
  assert.equal(state().tokens[0].text, 'new\n')
})

test('late syntax colors wait until an active native selection is cleared', async t => {
  const { pending, state } = mountHighlighter(t)
  let selected = true
  state().root = { ownerDocument: { getSelection: () => selected
    ? { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ intersectsNode: () => true }) } : null } }
  pending[0]!.finish([{ text: 'old\r\n', light: '#123456' }])
  await settle()
  assert.deepEqual(state().tokens, [{ text: 'old\r\n' }])
  selected = false
  state().applyPending()
  assert.equal(state().tokens[0].light, '#123456')
})
