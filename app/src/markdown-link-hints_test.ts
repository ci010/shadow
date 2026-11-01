import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

test('Markdown destination hints reuse HoverInfo without replacing anchors and clean up on unmount', () => {
  const calls: any[] = []
  const component = {}
  const source = readFileSync(new URL('./markdown-link-hints.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const exports: any = {}
  const host = { remove() { calls.push('removed') } }
  const originalDocument = globalThis.document
  ;(globalThis as any).document = { createElement: () => host, body: { append: (node: unknown) => calls.push(node) } }
  try {
    new Function('require', 'exports', js)((name: string) => name === 'vue' ? {
      h: (type: unknown, props: unknown) => ({ type, props }),
      render: (vnode: unknown, target: unknown) => calls.push({ vnode, target }),
    } : { default: component }, exports)
    const link = (href: string) => {
      const attributes = new Map([['href', href], ['title', 'native hint']])
      return { attributes, getAttribute: (key: string) => attributes.get(key), removeAttribute: (key: string) => attributes.delete(key) }
    }
    const first = link('https://example.com/a?x=1&y=2')
    const second = link('#section')
    let links = [first, second]
    const element = { querySelectorAll: () => links }
    const directive = exports.vMarkdownLinkHints
    directive.mounted(element, {})
    const mounted = calls.at(-1).vnode.props
    assert.equal(mounted[0].type, component)
    assert.equal(mounted[0].props.target, first)
    assert.equal(mounted[0].props.text, 'https://example.com/a?x=1&y=2')
    assert.equal(mounted[1].props.text, '#section')
    assert.equal(first.attributes.has('title'), false)
    assert.equal(first.attributes.get('href'), 'https://example.com/a?x=1&y=2')
    links = [link('mailto:hello@example.com')]
    directive.updated(element, {})
    assert.equal(calls.at(-1).vnode.props.length, 1)
    assert.equal(calls.at(-1).vnode.props[0].props.target, links[0])
    directive.beforeUnmount(element)
    assert.equal(calls.at(-2).vnode, null)
    assert.equal(calls.at(-1), 'removed')
  } finally { (globalThis as any).document = originalDocument }
})
