import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { createRenderer, nextTick, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { parseRuntimeFailure, runtimeRecoveryDuration, runtimeRecoveryMessage } from './runtime-recovery.ts'

interface Element {
	tag: string
	text: string
	props: Record<string, unknown>
	children: Element[]
	parent?: Element
}
const element = (tag: string, text = ''): Element => ({ tag, text, props: {}, children: [] })
const text = (node: Element): string => node.tag === '#comment' ? '' : [node.text, ...node.children.map(text)].join(' ')

function mount(t: TestContext, props: Record<string, unknown>) {
	const url = new URL('./RuntimeRecovery.vue', import.meta.url)
	const { descriptor } = parse(readFileSync(url, 'utf8'))
	const source = compileScript(descriptor, { id: 'recovery', inlineTemplate: true }).content
	const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
	const module = { exports: {} as { default: Component } }
	const require = createRequire(url)
	new Function('require', 'module', 'exports', outputText)(
		(id: string) => id.endsWith('.png') ? { default: 'fixture-logo.png' } : require(id), module, module.exports,
	)
	const renderer = createRenderer<Element, Element>({
		createElement: element, createText: value => element('#text', value), createComment: value => element('#comment', value),
		insert(node, parent, anchor) {
			node.parent = parent
			const index = anchor ? parent.children.indexOf(anchor) : -1
			parent.children.splice(index < 0 ? parent.children.length : index, 0, node)
		},
		remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1) },
		setText: (node, value) => { node.text = value },
		setElementText: (node, value) => { node.text = value; node.children = [] },
		patchProp: (node, key, _previous, value) => { node.props[key] = value },
		parentNode: node => node.parent ?? null,
		nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
	})
	const root = element('root')
	const app = renderer.createApp(module.exports.default, props)
	app.mount(root)
	t.after(() => app.unmount())
	const nodes = (node: Element = root): Element[] => [node, ...node.children.flatMap(child => nodes(child))]
	const button = (label: string) => {
		const result = nodes().find(node => node.tag === 'button' && text(node).includes(label))
		assert.ok(result, `Missing button: ${label}`)
		return result
	}
	const click = async (label: string) => {
		const handler = button(label).props.onClick
		assert.ok(typeof handler === 'function')
		await handler()
		await nextTick()
	}
	return { button, click, nodes, text: () => text(root) }
}

test('failure copy only uses known categories and valid elapsed durations', () => {
	assert.equal(parseRuntimeFailure({ role: 'child', kind: 'private-key' }), undefined)
	assert.equal(runtimeRecoveryMessage({ role: 'main', kind: 'unknown', message: 'secret' }), 'The desktop runtime could not be started.')
	assert.equal(runtimeRecoveryDuration({ role: 'main', kind: 'early-exit', elapsedMs: -1 }), undefined)
	assert.match(runtimeRecoveryMessage({ role: 'main', kind: 'readiness-timeout' }), /deadline/)
	assert.match(runtimeRecoveryMessage({ role: 'main', kind: 'early-exit' }), /exited/)
})

test('rendered recovery shows safe role, reason, duration, log action and retry', async t => {
	let retries = 0
	let reveals = 0
	const view = mount(t, {
		canReset: true, role: 'main',
		failure: { role: 'child', kind: 'readiness-timeout', elapsedMs: 15000, message: 'secret-credential' },
		retry: async () => { retries++ },
		revealLog: async () => { reveals++ },
	})
	assert.match(view.text(), /Child is not ready/)
	assert.match(view.text(), /deadline/)
	assert.match(view.text(), /Startup attempt: 15 s/)
	assert.doesNotMatch(view.text(), /secret-credential/)
	await view.click('Show startup log')
	assert.equal(reveals, 1)
	assert.equal(view.button('Retry').props.disabled, false)
	await view.click('Retry')
	assert.equal(retries, 1)
	assert.equal(view.button('Retry').props.disabled, false)
})

test('recovery remains visible while retrying, blocks duplicate actions and announces safe errors', async t => {
	let finish!: () => void
	let retries = 0
	const view = mount(t, {
		canReset: false, role: 'main',
		retry: () => { retries++; return new Promise<void>(resolve => { finish = resolve }) },
		revealLog: async () => { throw new Error('secret-credential') },
	})
	const pending = view.click('Retry')
	await nextTick()
	assert.match(view.text(), /Starting the runtime again/)
	assert.equal(view.button('Trying again').props.disabled, true)
	await view.click('Trying again')
	assert.equal(retries, 1)
	assert.equal(view.nodes().some(node => node.props.role === 'status'), true)
	finish()
	await pending
	await view.click('Show startup log')
	assert.match(view.text(), /startup log could not be shown/)
	assert.doesNotMatch(view.text(), /secret-credential|Reset setup/)
	assert.equal(view.nodes().some(node => node.props.role === 'alert'), true)
	assert.equal(view.button('Retry').props.disabled, false)
})
