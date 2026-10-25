import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { createRenderer, defineComponent, h, nextTick, reactive, type Component } from 'vue'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'

interface ElementNode {
  tag: string
  text: string
  props: Record<string, unknown>
  children: ElementNode[]
  style: Record<string, string>
  contains: (node: unknown) => boolean
  parent?: ElementNode
}
const element = (tag: string, text = ''): ElementNode => ({ tag, text, props: {}, children: [], style: {}, contains(node: unknown) { return node === this || this.children.some(child => child.contains(node)) } })
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick() }

function mount(t: TestContext, filename: string, props: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const popover = defineComponent({
    setup: (_, { slots, emit }) => () => h('div', [h('button', { onClick: () => emit('opened') }, 'Open audio'), slots.default?.({ close: () => emit('closed') })]),
  })
  function load(filename: string): Component {
    const url = new URL(`./components/${filename}`, import.meta.url)
    const { descriptor } = parse(readFileSync(url, 'utf8'))
    const source = compileScript(descriptor, { id: filename, inlineTemplate: true }).content
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
    const module = { exports: {} as { default: Component } }
    const require = createRequire(url)
    new Function('require', 'module', 'exports', outputText)(
      (id: string) => {
        if (id in overrides) return overrides[id]
        if (id === 'vue' && ['ProjectGroup.vue', 'FoldersSidebar.vue'].includes(filename)) {
          return { ...Vue, onMounted() {}, onActivated() {}, onUnmounted() {} }
        }
        if (id === './FoldersSidebar.vue') return { default: load(id.slice(2)) }
        return id.endsWith('.vue') ? { default: popover } : require(id)
      }, module, module.exports,
    )
    return module.exports.default
  }
  const component = load(filename)
  const renderer = createRenderer<ElementNode, ElementNode>({
    createElement: element, createText: text => element('#text', text), createComment: text => element('#comment', text),
    insert(node, parent, anchor) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index === -1) parent.children.push(node)
      else parent.children.splice(index, 0, node)
    },
    remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1) },
    setText: (node, text) => { node.text = text },
    setElementText: (node, text) => { node.text = text; node.children = [] },
    patchProp: (node, key, _previous, value) => { node.props[key] = value },
    parentNode: node => node.parent ?? null,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    querySelector: () => element('body'),
  })
  const root = element('root')
  const state = reactive(props)
  const app = renderer.createApp(defineComponent({ setup: () => () => h(component, state) }))
  app.component('RouterLink', defineComponent({ setup: (_, { slots }) => () => h('a', slots.default?.()) }))
  app.mount(root)
  t.after(() => app.unmount())
  const nodes = (): ElementNode[] => {
    const visit = (node: ElementNode): ElementNode[] => [node, ...node.children.flatMap(visit)]
    return visit(root)
  }
  return { state, nodes, unmount: () => app.unmount(),
    text: () => nodes().filter(node => node.tag !== '#comment').map(node => node.text).join(' '),
    button: () => {
      const button = nodes().find(node => node.tag === 'button')!
      return { props: button.props, click: () => (button.props.onClick as () => Promise<void>)() }
    },
  }
}


function environment(t: TestContext) {
  const originalWindow = globalThis.window, originalDocument = globalThis.document, originalFetch = globalThis.fetch
  const win = new EventTarget(), doc = Object.assign(new EventTarget(), { hasFocus: () => true, hidden: false })
  Object.assign(globalThis, { window: win, document: doc })
  let reservations = 0, releasedReservations = 0, claimedReservations = 0
  let ready = true, starts = 0, stops = 0, cancels = 0, uploads = 0, transcripts = 0, requests = 0, text = 'recognized', draft = '', pending = false
  let resolveCapture: ((v: unknown) => void) | undefined
  let audio = new Blob(['fixture']), signalError = false
  const recording = () => ({ cancel: () => { cancels++ }, stop: async () => { stops++; if (signalError) throw new actual.NoAudioSignalError(); return audio } })
  globalThis.fetch = async url => {
    if (String(url).endsWith('/transcribe')) { uploads++; return Response.json({ text }) }
    return Response.json({ asr: { ready, route: 'local' }, tts: { ready: true, route: 'local' } })
  }

  const actual = createRequire(import.meta.url)('./audio-input.ts') as typeof import('./audio-input.ts')
  const view = mount(t, 'AudioSetupButton.vue', { disabled: false, setupDisabled: false, apiBase: 'http://localhost/a/', draftKey: 'a', onTranscript: (v: string) => { transcripts++; draft = v }, onRequest: () => { requests++ } }, {
    '../audio-input': { ...actual, prepareMicrophone: () => { reservations++; return { cancel() { releasedReservations++ } } }, recordMicrophone: (_signal: unknown, _options: unknown, prepared: unknown) => { if (prepared) claimedReservations++; starts++; return pending ? new Promise(resolve => { resolveCapture = resolve }) : Promise.resolve(recording()) } },
  })
  t.after(() => Object.assign(globalThis, { window: originalWindow, document: originalDocument, fetch: originalFetch }))
  function event(type: string, values: Record<string, unknown> = {}) { const e = new Event(type); Object.assign(e, values); win.dispatchEvent(e) }
  function key(type: string, key: string, values: Record<string, unknown> = {}) { event(type, { key, ctrlKey: true, shiftKey: true, ...values }) }
  const wait = async () => { await new Promise(resolve => setTimeout(resolve, 330)); await settle() }
  return { view, event, key, wait, doc, stats: () => ({ reservations, releasedReservations, claimedReservations, starts, stops, cancels, uploads, draft, transcripts, requests }), draft: (v: string) => { draft = v }, noSignal: () => { signalError = true }, zeroAudio: () => { audio = actual.pcmWav(new Float32Array(1600), 16000) }, ready: (v: boolean) => { ready = v }, text: (v: string) => { text = v }, pending: () => { pending = true }, resolve: () => resolveCapture?.(recording()) }
}
test('direct clicks, inline phases, empty text, setup and change configuration', async t => {
  const e = environment(t); await settle()
  assert.equal(e.stats().starts, 0)
  await e.view.button().click(); await settle(); assert.match(e.view.text(), /Recording/)
  await e.view.button().click(); await settle(); assert.equal(e.stats().draft, 'recognized'); assert.equal(e.stats().uploads, 1)
  e.text('  '); await e.view.button().click(); await settle(); await e.view.button().click(); await settle()
  assert.match(e.view.text(), /No speech recognized/)
  const change = e.view.nodes().find(n => n.props['aria-label'] === 'Change audio setup')!
  ;(change.props.onClick as () => void)(); await settle(); assert.match(e.view.text(), /Local · assess/)
  e.ready(false); e.view.state.draftKey = 'b'; await settle(); await e.view.button().click(); await settle()
  assert.match(e.view.text(), /transcription still needs setup/)
})
test('pointer hold releases outside, pending acquisition release transcribes, cancellation discards', async t => {
  const e = environment(t); await settle(); e.pending()
  const down = () => (e.view.button().props.onPointerdown as (e: unknown) => void)({ button: 0, pointerId: 1 })
  down(); await e.wait(); assert.match(e.view.text(), /Waiting for microphone/)
  e.event('pointerup', { pointerId: 1 }); await e.view.button().click(); e.resolve(); await settle(); assert.equal(e.stats().uploads, 1)
  assert.equal(e.stats().starts, 1, 'hold-generated click suppressed')
  down(); await e.wait(); e.event('pointercancel'); e.resolve(); await settle()
  assert.equal(e.stats().cancels, 1); assert.equal(e.stats().uploads, 1)
})
test('modifier delay, repeats, release either modifier and shortcut conflicts', async t => {
  const e = environment(t); await settle()
  e.key('keydown', 'Shift'); e.key('keyup', 'Shift'); await e.wait(); assert.equal(e.stats().starts, 0)
  e.key('keydown', 'Shift'); e.key('keydown', 'P'); await e.wait(); assert.equal(e.stats().starts, 0)
  e.key('keyup', 'Control'); e.key('keydown', 'Shift', { isComposing: true }); await e.wait(); assert.equal(e.stats().starts, 0)
  e.key('keyup', 'Shift'); e.key('keydown', 'Control'); e.key('keydown', 'Control', { repeat: true }); await e.wait()
  assert.equal(e.stats().starts, 1); e.key('keyup', 'Control'); await settle(); assert.equal(e.stats().uploads, 1)
  e.key('keydown', 'Shift'); await e.wait(); e.key('keyup', 'Shift'); await settle(); assert.equal(e.stats().uploads, 2)
})
test('Esc, blur, visibility, navigation, disabled and unmount clean up without uploading', async t => {
  const e = environment(t); await settle()
  for (const action of [() => e.key('keydown', 'Escape'), () => e.event('blur'), () => { e.doc.hidden = true; e.doc.dispatchEvent(new Event('visibilitychange')); e.doc.hidden = false }, () => { e.view.state.draftKey = 'b' }, () => { e.view.state.disabled = true }]) {
    await e.view.button().click(); await settle(); action(); await settle()
  }
  assert.equal(e.stats().uploads, 0); assert.equal(e.stats().cancels, 5)
  e.key('keydown', 'Shift'); await e.wait(); assert.equal(e.stats().starts, 5)
  e.view.state.disabled = false; await settle(); await e.view.button().click(); await settle(); e.view.unmount()
  assert.equal(e.stats().cancels, 6)
})
test('model busy blocks setup requests but permits capture and draft insertion', async t => {
  const e = environment(t); await settle(); e.view.state.setupDisabled = true
  await e.view.button().click(); await settle(); await e.view.button().click(); await settle()
  assert.equal(e.stats().draft, 'recognized'); assert.equal(e.stats().uploads, 1)
  const source = readFileSync(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
  const binding = source.split('\n').find(line => line.includes('<AudioSetupButton'))!
  assert.match(binding, /:setup-disabled="submissionBusy \|\| requestBusy/)
  assert.doesNotMatch(binding.match(/:disabled="[^"]+/)![0], /requestBusy|submissionBusy|inputText/)
})


test('short pointer click, keyboard ownership, processing exclusion and status failure', async t => {
  const e = environment(t); await settle()
  ;(e.view.button().props.onPointerdown as (v: unknown) => void)({ button: 0, pointerId: 7 })
  e.event('pointerup', { pointerId: 7 }); await e.view.button().click(); await settle()
  e.key('keyup', 'Shift'); await settle(); assert.equal(e.stats().stops, 0, 'modifier release must not stop click recording')
  let finish: ((r: Response) => void) | undefined
  globalThis.fetch = async () => new Promise<Response>(resolve => { finish = resolve })
  const stopping = e.view.button().click(); await settle()
  assert.match(e.view.text(), /Processing audio/); assert.equal(e.view.button().props.disabled, true)
  assert.match(String(e.view.nodes().find(n => n.props['data-audio-phase'] === 'processing')?.props.class), /audio-mic-processing/)
  e.key('keydown', 'Shift'); await e.wait(); assert.equal(e.stats().starts, 1)
  finish!(Response.json({ error: 'Fixture inference failure' }, { status: 500 })); await stopping; await settle()
  assert.match(e.view.text(), /Fixture inference failure/)
  globalThis.fetch = async () => new Response('{}', { status: 503 })
  e.view.state.draftKey = 'failed'; await settle(); await e.view.button().click(); await settle()
  assert.match(e.view.text(), /Unable to read Project audio status/); assert.doesNotMatch(e.view.text(), /Local · assess/)
})

test('inactive panes and unfocused window never arm; losing pane visibility cancels', async t => {
  const e = environment(t); await settle()
  e.view.state.keyboardActive = false; await settle(); e.key('keydown', 'Shift'); await e.wait(); assert.equal(e.stats().starts, 0)
  e.view.state.keyboardActive = true; e.doc.hasFocus = () => false; await settle(); e.key('keydown', 'Shift'); await e.wait(); assert.equal(e.stats().starts, 0)
  e.doc.hasFocus = () => true; e.key('keydown', 'Shift'); await e.wait(); assert.equal(e.stats().starts, 1)
  e.view.state.visible = false; await settle(); assert.equal(e.stats().cancels, 1); assert.equal(e.stats().uploads, 0)
})

test('no-speech ASR artifacts preserve the existing draft and never emit for click, hold or chord', async t => {
  const e = environment(t); await settle(); e.draft('existing unsent draft'); e.zeroAudio()
  const artifacts = ['', ' \t\n\u3000', '.', '。', '...!?', '，！？【】…']
  for (const [index, text] of artifacts.entries()) {
    e.text(text)
    if (index % 3 === 0) {
      await e.view.button().click(); await settle(); await e.view.button().click()
    } else if (index % 3 === 1) {
      ;(e.view.button().props.onPointerdown as (v: unknown) => void)({ button: 0, pointerId: 9 })
      await e.wait(); e.event('pointerup', { pointerId: 9 })
    } else {
      e.key('keydown', 'Shift'); await e.wait(); e.key('keyup', 'Shift')
    }
    await settle()
    assert.match(e.view.text(), /No speech recognized/)
    assert.equal(e.stats().draft, 'existing unsent draft')
    assert.equal(e.stats().transcripts, 0)
    assert.equal(e.stats().requests, 0)
  }
  for (const text of ['你好。', 'Hello!', '123', '+ 🎵']) {
    e.text(text); await e.view.button().click(); await settle(); await e.view.button().click(); await settle()
    assert.equal(e.stats().draft, text)
    assert.doesNotMatch(e.view.text(), /No speech recognized/)
  }
  assert.equal(e.stats().transcripts, 4)
  assert.equal(e.stats().requests, 0)
})

test('recording indicator stays at mic with screen-reader-only state and reduced-motion ring', async t => {
  const e = environment(t); await settle(); e.pending()
  const indicator = () => e.view.nodes().find(n => n.props['data-audio-phase'])!
  assert.equal(indicator().props['data-audio-phase'], 'idle')
  await e.view.button().click(); await settle()
  assert.match(String(indicator().props.class), /audio-mic-acquiring/)
  e.resolve(); await settle()
  assert.match(String(indicator().props.class), /audio-mic-recording/)
  const state = e.view.nodes().find(n => n.props.class === 'audio-state-sr')!
  assert.equal(state.props.role, 'status'); assert.equal(state.props['aria-live'], 'polite')
  assert.match(state.text, /Recording/)
  assert.equal(e.view.button().props['aria-label'], 'Stop and transcribe')
  assert.ok(e.view.nodes().some(n => n.tag === 'button' && n.text === 'Cancel'))
  const source = readFileSync(new URL('./components/AudioSetupButton.vue', import.meta.url), 'utf8')
  assert.match(source, /animation: input-breathe 9s ease-in-out infinite/)
  assert.doesNotMatch(source, /--c-red|#dc2626|audio-recording-pulse/)
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)[^\n]*animation: none/)
  assert.match(source, /\.audio-state-sr[^\n]*clip-path: inset\(50%\)/)
  await e.view.button().click(); await settle()
  assert.equal(indicator().props['data-audio-phase'], 'idle')
})


test('hover popup waits 200ms, cancels on exit and stays across popup travel without capture', async t => {
  const e = environment(t); await settle()
  const root = () => e.view.nodes().find(n => n.props.class === 'audio-input')!
  const enter = () => (root().props.onPointerenter as (v: unknown) => void)({ pointerType: 'mouse' })
  const leave = () => (root().props.onPointerleave as () => void)()
  const popup = () => e.view.nodes().find(n => n.props.role === 'dialog')
  enter(); await settle(); assert.equal(popup(), undefined)
  await new Promise(r => setTimeout(r, 100)); leave(); await e.wait(); assert.equal(popup(), undefined)
  enter(); await e.wait(); assert.ok(popup()); assert.equal(e.stats().starts, 0); assert.equal(e.stats().requests, 0)
  leave(); enter(); await e.wait(); assert.ok(popup(), 'returning into popup cancels closing')
  const change = e.view.nodes().find(n => n.tag === 'button' && n.text === 'Change audio setup')!
  ;(change.props.onClick as () => void)(); await settle(); assert.match(e.view.text(), /Local · assess/)
  leave(); await e.wait(); assert.equal(popup(), undefined)
  enter(); e.view.state.draftKey = 'new'; await e.wait(); assert.equal(popup(), undefined)
})

test('focus, Escape, touch settings and arming/recording suppression preserve direct recording', async t => {
  const e = environment(t); await settle()
  const root = () => e.view.nodes().find(n => n.props.class === 'audio-input')!
  const popup = () => e.view.nodes().find(n => n.props.role === 'dialog')
  ;(root().props.onFocusin as () => void)(); await settle(); assert.ok(popup()); assert.equal(e.stats().starts, 0)
  ;(root().props.onKeydown as (v: unknown) => void)({ key: 'Escape', stopPropagation() {} }); await settle(); assert.equal(popup(), undefined)
  ;(root().props.onPointerenter as (v: unknown) => void)({ pointerType: 'touch' }); await e.wait(); assert.equal(popup(), undefined)
  const settings = e.view.nodes().find(n => n.props.class === 'audio-touch-settings')!
  ;(settings.props.onClick as () => void)(); await settle(); assert.match(e.view.text(), /Local · assess/)
  ;(root().props.onFocusout as (v: unknown) => void)({ relatedTarget: null }); await settle(); assert.equal(popup(), undefined)
  ;(root().props.onPointerenter as (v: unknown) => void)({ pointerType: 'mouse' })
  e.key('keydown', 'Shift'); await new Promise(r => setTimeout(r, 220)); await settle(); assert.equal(popup(), undefined)
  await e.wait(); assert.equal(e.stats().starts, 1)
  ;(root().props.onFocusin as () => void)(); await settle(); assert.equal(popup(), undefined)
  e.key('keyup', 'Shift'); await settle(); assert.equal(e.stats().uploads, 1)
})

test('microphone is immediately before Send and shares the composer theme breathing', () => {
  const chat = readFileSync(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
  const submit = chat.slice(chat.indexOf('<div class="composer-submit">'), chat.indexOf('</div>', chat.indexOf('<div class="composer-submit">')))
  assert.match(submit, /<AudioSetupButton[\s\S]*@request="sendMessage\(\$event\)" \/>\s*<button\s+v-if="showComposerSend"/)
  assert.doesNotMatch(chat.slice(chat.indexOf('<div class="composer-controls">'), chat.indexOf('<div class="composer-submit">')), /AudioSetupButton/)
  assert.match(chat, /animation: input-breathe 9s/)
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  assert.match(css, /@keyframes input-breathe/); assert.match(css, /var\(--c-blue\)/); assert.match(css, /var\(--c-purple\)/)
})


test('stream preview stays distinct, final appends to current manually edited draft, cancellation never inserts', async t => {
  const originalWindow = globalThis.window, originalDocument = globalThis.document, originalFetch = globalThis.fetch
  const win = new EventTarget()
  Object.assign(globalThis, { window: win, document: Object.assign(new EventTarget(), { hidden: false, hasFocus: () => true }) })
  globalThis.fetch = async () => Response.json({ asr: { ready: true, route: 'local' }, tts: { ready: false, route: 'local' } })
  const actual = createRequire(import.meta.url)('./audio-input.ts') as typeof import('./audio-input.ts')
  let partial: ((text: string) => void) | undefined, final: ((text: string) => void) | undefined
  let draft = 'original draft', inserts = 0, cancelled = 0
  const view = mount(t, 'AudioSetupButton.vue', { disabled: false, apiBase: 'http://localhost/', draftKey: 'a', sessionId: 'web:fixture', onTranscript(text: string) { inserts++; draft = [draft, text].filter(Boolean).join('\n') } }, {
    '../audio-input': { ...actual, prepareMicrophone: () => ({ cancel() {} }), recordMicrophone: async (_signal: AbortSignal, options: any) => {
      options.onLevel(.65)
      options.onSamples(Float32Array.from({ length: 3200 }, (_, i) => .01 * Math.sin(i / 10)), 16000)
      return { cancel() {}, stop: async () => actual.pcmWav(new Float32Array(3200), 16000) }
    } },
    '../audio-stream.ts': { openAudioStream: async (_base: string, _id: string, _signal: AbortSignal, preview: (text: string) => void) => {
      partial = preview
      return { push() {}, cancel() { cancelled++ }, finish: () => new Promise<string>(resolve => { final = resolve }) }
    } },
  })
  t.after(() => Object.assign(globalThis, { window: originalWindow, document: originalDocument, fetch: originalFetch }))
  await settle(); await view.button().click(); await settle()
  partial!('first provisional snapshot'); await settle()
  assert.match(view.text(), /Provisional · buffered local transcription/)
  assert.match(view.text(), /first provisional snapshot/); assert.equal(draft, 'original draft'); assert.equal(inserts, 0)
  const indicator = view.nodes().find(n => n.props['data-audio-phase'] === 'recording')!
  assert.equal((indicator.props.style as Record<string, unknown>)['--audio-level'], .65)
  draft = 'manual edits while recording'
  await view.button().click(); await settle()
  partial!('second revised snapshot'); await settle(); assert.equal(draft, 'manual edits while recording')
  final!('corrected final'); await settle()
  assert.equal(draft, 'manual edits while recording\ncorrected final'); assert.equal(inserts, 1)
  assert.doesNotMatch(view.text(), /snapshot/)
  await view.button().click(); await settle(); partial!('discard me'); await settle()
  win.dispatchEvent(new Event('blur')); await settle(); partial!('late partial'); await settle()
  assert.equal(inserts, 1); assert.doesNotMatch(view.text(), /discard me|late partial/); assert.ok(cancelled >= 2)
})

test('audio-side rough silence gate suppresses uploads in click, pointer hold and shortcut modes', async t => {
  const e = environment(t); await settle(); e.noSignal(); e.draft('keep manual draft')
  await e.view.button().click(); await settle(); await e.view.button().click(); await settle()
  ;(e.view.button().props.onPointerdown as (v: unknown) => void)({ button: 0, pointerId: 10 })
  await e.wait(); e.event('pointerup', { pointerId: 10 }); await settle()
  e.key('keydown', 'Shift'); await e.wait(); e.key('keyup', 'Shift'); await settle()
  assert.equal(e.stats().uploads, 0); assert.equal(e.stats().transcripts, 0)
  assert.equal(e.stats().draft, 'keep manual draft'); assert.equal(e.stats().stops, 3); assert.match(e.view.text(), /No speech recognized/)
})


test('hold/chord reserve in the original gesture before threshold; short/conflicting gestures revoke without recording', async t => {
  const e = environment(t); await settle()
  const down = () => (e.view.button().props.onPointerdown as (e: unknown) => void)({ button: 0, pointerId: 9 })
  down()
  assert.equal(e.stats().reservations, 1); assert.equal(e.stats().starts, 0)
  e.event('pointerup', { pointerId: 9 }); await settle()
  assert.equal(e.stats().releasedReservations, 1); assert.equal(e.stats().starts, 0)
  e.key('keydown', 'Shift')
  assert.equal(e.stats().reservations, 2); assert.equal(e.stats().starts, 0)
  e.key('keydown', 'P'); await e.wait()
  assert.equal(e.stats().releasedReservations, 2); assert.equal(e.stats().starts, 0)
  e.key('keyup', 'Shift'); e.key('keydown', 'Control')
  assert.equal(e.stats().reservations, 3)
  await e.wait(); assert.equal(e.stats().claimedReservations, 1)
  e.key('keyup', 'Shift'); await settle()
  down(); await e.wait(); assert.equal(e.stats().claimedReservations, 2)
  e.event('pointerup', { pointerId: 9 }); await settle()
})
