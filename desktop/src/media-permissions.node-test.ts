import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import test from 'node:test'
import type { BrowserWindow, IpcMainInvokeEvent, Session } from 'electron'
import { MEDIA_CAPTURE_CHANNELS, DISPLAY_PICKER_EVENT, MAX_MEDIA_CAPTURE_DURATION_MS, parseMediaCaptureGrant, parseDisplayPickerResponse, parseDisplayPickerState, type DisplayPickerState } from './media-capture-contract.js'
import { createMediaCaptureApi } from './media-capture-preload.js'
import { createDisplaySourcePicker } from './display-source-picker.js'
import { installMediaPermissions, isTrustedMediaUrl, MediaCaptureGrants } from './media-permissions.js'
import { resolveRendererTarget, type RendererTarget } from './renderer-target.js'

const target = resolveRendererTarget({ rendererDistPath: 'unused', developmentUrl: 'http://127.0.0.1:5173/' })
const fileTarget = resolveRendererTarget({ rendererDistPath: resolve('fixtures', 'Shadow Desktop', 'app-dist') })
const valid = { runId: 'io-run-1', capabilities: ['microphone', 'screen'], durationMs: 1000 }
type Check = NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>
type Request = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>
type Display = NonNullable<Parameters<Session['setDisplayMediaRequestHandler']>[0]>
type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function harness(rendererTarget: RendererTarget = target, getDisplaySources?: () => Promise<Electron.DesktopCapturerSource[]>) {
  let now = 100
  let check!: Check
  let request!: Request
  let display!: Display
  let displayOptions: unknown
  let selections = 0
  let pickerSignal: AbortSignal | undefined
  let selection: () => Promise<{ id: string; name: string } | undefined> = async () => ({ id: 'screen:2', name: 'Screen 2' })
  const url = rendererTarget.kind === 'url' ? rendererTarget.url : rendererTarget.entryUrl
  const messages: unknown[][] = []
  const frame = { url, send: (...args: unknown[]) => { messages.push(args) } }
  const session = {
    setPermissionCheckHandler: (handler: Check) => { check = handler },
    setPermissionRequestHandler: (handler: Request) => { request = handler },
    setDisplayMediaRequestHandler: (handler: Display, opts: unknown) => { display = handler; displayOptions = opts },
  }
  const contents = Object.assign(new EventEmitter(), {
    session, mainFrame: frame, isDestroyed: () => false,
  })
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false })
  const handlers = new Map<string, Handler>()
  const ipc = { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) }, removeHandler: (channel: string) => { handlers.delete(channel) } }
  const dispose = installMediaPermissions(ipc, window as unknown as BrowserWindow, rendererTarget, {
    now: () => now,
    ...(getDisplaySources ? { getDisplaySources } : { chooseDisplaySource: (signal: AbortSignal) => { selections++; pickerSignal = signal; return selection() } }),
  })
  const caller = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const origin = rendererTarget.kind === 'file' ? 'file:///' : rendererTarget.origin
  return {
    contents, window, handlers, caller, dispose, messages,
    setTime: (value: number) => { now = value },
    setSelection: (value: typeof selection) => { selection = value },
    get selections() { return selections },
    get pickerSignal() { return pickerSignal },
    get displayOptions() { return displayOptions },
    invoke: (channel: string, value: unknown, event = caller) => handlers.get(channel)!(event, value),
    check: (permission = 'media', overrides: Partial<Parameters<Check>[3]> = {}, sender: unknown = contents, requestingOrigin = origin) =>
      check(sender as Parameters<Check>[0], permission as Parameters<Check>[1], requestingOrigin, {
        isMainFrame: true, requestingUrl: frame.url, mediaType: 'audio', ...overrides,
      }),
    request: (permission = 'media', overrides: Partial<Electron.MediaAccessPermissionRequest> = {}) => {
      let result: boolean | undefined
      request(contents as unknown as Parameters<Request>[0], permission as Parameters<Request>[1], (allowed) => { result = allowed }, {
        isMainFrame: true, requestingUrl: frame.url, mediaTypes: ['audio'], securityOrigin: origin, ...overrides,
      })
      return result
    },
    display: (overrides: Partial<Parameters<Display>[0]> = {}) =>
      new Promise<Parameters<Parameters<Display>[1]>[0]>((resolve) => display({
        frame: frame as Parameters<Display>[0]['frame'], securityOrigin: origin, videoRequested: true,
        audioRequested: false, userGesture: true, ...overrides,
      }, resolve)),
  }
}

test('media grants require known bounded schema and cannot extend an active run', () => {
  for (const value of [
    null, {}, { ...valid, extra: true }, { ...valid, runId: '../run' },
    { ...valid, capabilities: [] }, { ...valid, capabilities: ['microphone', 'microphone'] },
    { ...valid, capabilities: ['system-audio'] }, { ...valid, durationMs: 0 },
    { ...valid, durationMs: Infinity }, { ...valid, durationMs: 1.1 },
    { ...valid, durationMs: MAX_MEDIA_CAPTURE_DURATION_MS + 1 },
  ]) assert.throws(() => parseMediaCaptureGrant(value), TypeError)
  assert.equal(parseMediaCaptureGrant({ ...valid, durationMs: 86_400_000 }).durationMs, 86_400_000)
  let now = 10
  const grants = new MediaCaptureGrants(() => now)
  assert.equal(grants.allows('microphone'), false)
  assert.equal(grants.arm(valid).expiresAt, 1010)
  assert.throws(() => grants.arm(valid), /Stop the current/)
  assert.equal(grants.allows('camera'), false)
  now = 1010
  assert.equal(grants.allows('microphone'), false)
  grants.arm(valid)
  grants.revoke({ runId: 'other' })
  assert.equal(grants.allows('microphone'), true)
  grants.revoke({ runId: valid.runId })
  assert.equal(grants.allows('microphone'), false)
})

test('trusted media entry is exact, not merely loopback origin or file origin', () => {
  assert.equal(isTrustedMediaUrl('http://127.0.0.1:5173/#/chat/one', target), true)
  for (const url of [
    'http://127.0.0.1:5173/another', 'http://127.0.0.1:5173/?other=1',
    'http://localhost:5173/', 'http://127.0.0.1:5174/', 'https://127.0.0.1:5173/',
    'http://user:pass@127.0.0.1:5173/', 'data:text/html,hello', 'not-a-url',
  ]) assert.equal(isTrustedMediaUrl(url, target), false, url)
  assert.equal(isTrustedMediaUrl(`${fileTarget.kind === 'file' ? fileTarget.entryUrl : ''}#/chat`, fileTarget), true)
  assert.equal(isTrustedMediaUrl('file:///C:/other/index.html', fileTarget), false)
  assert.equal(isTrustedMediaUrl('file://evil/C:/shadow/app-dist/index.html', fileTarget), false)
})

test('preload only arms during a real trusted host user activation and exposes no generic IPC', async () => {
  let active = false
  const calls: unknown[] = []
  const api = createMediaCaptureApi({ invoke: async (...args) => { calls.push(args); return { expiresAt: 1100 } } }, () => active)
  assert.deepEqual(Object.keys(api).sort(), ['arm', 'displayPicker', 'revoke'])
  assert.equal(Object.isFrozen(api), true)
  await assert.rejects(api.arm(valid as Parameters<typeof api.arm>[0]), /Start button/)
  assert.equal(calls.length, 0)
  active = true
  await api.arm(valid as Parameters<typeof api.arm>[0])
  active = false
  await api.revoke({ runId: valid.runId })
  assert.deepEqual(calls, [[MEDIA_CAPTURE_CHANNELS.arm, valid], [MEDIA_CAPTURE_CHANNELS.revoke, { runId: valid.runId }]])
  await assert.rejects(api.displayPicker!.respond({ requestId: 'request', sourceId: 'offer' }), /Share button/)
  await api.displayPicker!.respond({ requestId: 'request', sourceId: null })
  assert.deepEqual(calls.at(-1), [MEDIA_CAPTURE_CHANNELS.pickerRespond, { requestId: 'request', sourceId: null }])
})

for (const rendererTarget of [target, fileTarget]) {
  test(`${rendererTarget.kind} clipboard writes require the trusted Main document but no media grant`, (t) => {
    const h = harness(rendererTarget)
    t.after(h.dispose)
    assert.equal(h.check('clipboard-sanitized-write'), true)
    assert.equal(h.request('clipboard-sanitized-write'), true)
    assert.equal(h.check('clipboard-read'), false)
    assert.equal(h.request('clipboard-read'), false)
    assert.equal(h.check('media'), false)
    assert.equal(h.request('media'), false)
    assert.equal(h.check('clipboard-sanitized-write', {}, {}), false)
    assert.equal(h.check('clipboard-sanitized-write', { isMainFrame: false }), false)
    assert.equal(h.request('clipboard-sanitized-write', { isMainFrame: false }), false)
    assert.equal(h.check('clipboard-sanitized-write', {}, h.contents, 'https://other.example'), false)
    assert.equal(h.request('clipboard-sanitized-write', { securityOrigin: 'https://other.example' }), false)
    assert.equal(h.request('clipboard-sanitized-write', { requestingUrl: 'https://other.example' }), false)
    h.contents.mainFrame.url = 'https://other.example'
    assert.equal(h.check('clipboard-sanitized-write'), false)
    assert.equal(h.request('clipboard-sanitized-write'), false)
    h.dispose()
    assert.equal(h.check('clipboard-sanitized-write'), false)
    assert.equal(h.request('clipboard-sanitized-write'), false)
  })

  test(`${rendererTarget.kind} permission check/request require exact main frame and active capability`, (t) => {
    const h = harness(rendererTarget)
    t.after(h.dispose)
    assert.equal(h.check(), false)
    assert.equal(h.request(), false)
    h.invoke(MEDIA_CAPTURE_CHANNELS.arm, valid)
    assert.equal(h.check(), true)
    assert.equal(h.request(), true)
    assert.equal(h.check('media', { mediaType: 'video' }), false)
    assert.equal(h.request('media', { mediaTypes: ['audio', 'video'] }), false)
    assert.equal(h.request('media', { mediaTypes: [] }), true)
    assert.equal(h.check('media', { mediaType: 'unknown' }), false)
    for (const permission of ['notifications', 'geolocation', 'clipboard-read', 'unknown']) {
      assert.equal(h.check(permission), false)
      assert.equal(h.request(permission), false)
    }
    assert.equal(h.check('media', {}, null), false)
    assert.equal(h.check('media', {}, {}), false)
    assert.equal(h.check('media', { isMainFrame: false }), false)
    assert.equal(h.request('media', { isMainFrame: false }), false)
    assert.equal(h.check('media', { requestingUrl: 'file:///C:/other/index.html' }), false)
    assert.equal(h.request('media', { requestingUrl: 'http://127.0.0.1:5173/evil' }), false)
    assert.equal(h.check('media', {}, h.contents, 'https://evil.example'), false)
    assert.equal(h.request('media', { securityOrigin: 'https://evil.example' }), false)
    assert.equal(h.check('media', { securityOrigin: 'https://evil.example' }), false)
    h.setTime(1100)
    assert.equal(h.check(), false)
    assert.equal(h.request(), false)
  })
}

test('arm and revoke IPC reject invalid senders, frames, URL and extra arguments', (t) => {
  const h = harness()
  t.after(h.dispose)
  for (const channel of Object.values(MEDIA_CAPTURE_CHANNELS)) {
    for (const caller of [
      { sender: {}, senderFrame: h.contents.mainFrame },
      { sender: h.contents, senderFrame: {} },
      { sender: h.contents, senderFrame: null },
    ]) assert.throws(() => h.invoke(channel, valid, caller as unknown as IpcMainInvokeEvent), /trusted Main frame/)
    assert.throws(() => h.handlers.get(channel)!(h.caller, valid, 'extra'), /one request/)
    assert.throws(() => h.handlers.get(channel)!(h.caller), /one request/)
  }
  h.contents.mainFrame.url = 'http://127.0.0.1:5173/other'
  assert.throws(() => h.invoke(MEDIA_CAPTURE_CHANNELS.arm, valid), /trusted Main frame/)
})

test('history routes retain document trust and reload requires a fresh capture grant', async (t) => {
  const h = harness()
  t.after(h.dispose)
  const route = 'http://127.0.0.1:5173/projects/demo/conversations/one?view=chat'
  h.contents.mainFrame.url = route
  h.contents.emit('did-navigate-in-page', {}, route, true)
  h.invoke(MEDIA_CAPTURE_CHANNELS.arm, valid)
  assert.equal(h.check(), true)
  assert.equal(h.request(), true)
  assert.equal(h.request('media', { requestingUrl: 'http://127.0.0.1:5173/unrelated' }), false)
  assert.deepEqual(await h.display(), { video: { id: 'screen:2', name: 'Screen 2' } })

  h.contents.emit('did-navigate-in-page', {}, 'https://other.example/', false)
  assert.equal(h.check(), true, 'subframe navigation does not change the Main document')
  h.contents.emit('did-start-navigation', {}, route, false, true)
  assert.equal(h.check(), false)
  h.contents.emit('did-navigate', {}, route)
  assert.equal(h.check(), false, 'reload retains route trust, never the previous grant')
  h.invoke(MEDIA_CAPTURE_CHANNELS.arm, valid)
  assert.equal(h.check(), true)
})

test('a different same-origin document cannot inherit trust or spoof it with history routing', (t) => {
  const h = harness()
  t.after(h.dispose)
  h.invoke(MEDIA_CAPTURE_CHANNELS.arm, valid)
  const other = 'http://127.0.0.1:5173/other'
  h.contents.emit('did-start-navigation', {}, other, false, true)
  h.contents.mainFrame.url = other
  h.contents.emit('did-navigate', {}, other)
  assert.equal(h.check(), false)
  assert.throws(() => h.invoke(MEDIA_CAPTURE_CHANNELS.arm, valid), /trusted Main frame/)
  h.contents.mainFrame.url = 'http://127.0.0.1:5173/'
  h.contents.emit('did-navigate-in-page', {}, h.contents.mainFrame.url, true)
  assert.throws(() => h.invoke(MEDIA_CAPTURE_CHANNELS.arm, valid), /trusted Main frame/)
  h.contents.emit('did-start-navigation', {}, h.contents.mainFrame.url, false, true)
  h.contents.emit('did-navigate', {}, h.contents.mainFrame.url)
  h.invoke(MEDIA_CAPTURE_CHANNELS.arm, valid)
  assert.equal(h.check(), true, 'loading the exact entry establishes a new trusted document')
})

test('in-page navigation cannot move trust to another origin or local file', (t) => {
  for (const [rendererTarget, url] of [
    [target, 'http://127.0.0.1:5174/projects/demo'],
    [fileTarget, 'file:///C:/other/index.html'],
  ] as const) {
    const h = harness(rendererTarget)
    t.after(h.dispose)
    h.invoke(MEDIA_CAPTURE_CHANNELS.arm, valid)
    h.contents.mainFrame.url = url
    h.contents.emit('did-navigate-in-page', {}, url, true)
    assert.equal(h.check(), false)
    assert.throws(() => h.invoke(MEDIA_CAPTURE_CHANNELS.arm, valid), /trusted Main frame/)
  }
})

test('screen bootstrap permission is not implied by a microphone or camera grant', async (t) => {
  const h = harness()
  t.after(h.dispose)
  h.invoke(MEDIA_CAPTURE_CHANNELS.arm, { ...valid, capabilities: ['microphone', 'camera'] })
  assert.equal(h.check('media', { mediaType: 'video' }), true)
  assert.equal(h.request('media', { mediaTypes: ['audio', 'video'] }), true)
  assert.equal(h.request('media', { mediaTypes: [] }), false)
  assert.equal(h.check('display-capture'), false)
  assert.equal(h.request('display-capture'), false)
  assert.deepEqual(await h.display(), {})
  assert.equal(h.selections, 0)
})

test('navigation, renderer crash, revocation and close clear grants; hash routing does not', (t) => {
  for (const event of ['reload', 'render-process-gone', 'destroyed', 'revoke', 'closed']) {
    const h = harness()
    t.after(h.dispose)
    h.invoke(MEDIA_CAPTURE_CHANNELS.arm, valid)
    h.contents.emit('did-start-navigation', {}, `${target.kind === 'url' ? target.url : ''}#other`, true, true)
    assert.equal(h.check(), true)
    if (event === 'reload') h.contents.emit('did-start-navigation', {}, h.contents.mainFrame.url, false, true)
    else if (event === 'revoke') h.invoke(MEDIA_CAPTURE_CHANNELS.revoke, { runId: valid.runId })
    else if (event === 'closed') h.window.emit('closed')
    else h.contents.emit(event)
    assert.equal(h.check(), false, event)
    assert.equal(h.request(), false, event)
    if (event === 'closed') assert.equal(h.handlers.size, 0)
  }
})

test('display capture is never automatic and rejects invalid frame, origin, gesture, audio, missing grant', async (t) => {
  const h = harness()
  t.after(h.dispose)
  assert.deepEqual(await h.display(), {})
  h.invoke(MEDIA_CAPTURE_CHANNELS.arm, valid)
  for (const request of [
    { frame: null }, { frame: {} as Electron.WebFrameMain }, { securityOrigin: 'https://evil.example' },
    { userGesture: false }, { videoRequested: false }, { audioRequested: true },
  ]) assert.deepEqual(await h.display(request), {})
  assert.equal(h.selections, 0)
  assert.deepEqual(h.displayOptions, { useSystemPicker: false })
  assert.deepEqual(await h.display(), { video: { id: 'screen:2', name: 'Screen 2' } })
  assert.equal(h.selections, 1)
})

test('pending source selections cannot survive revoke, expiry, reload or replacement grant', async (t) => {
  for (const action of ['revoke', 'expire', 'reload', 'replace', 'close']) {
    const h = harness()
    t.after(h.dispose)
    let select!: (source: { id: string; name: string }) => void
    h.setSelection(() => new Promise((resolve) => { select = resolve }))
    h.invoke(MEDIA_CAPTURE_CHANNELS.arm, valid)
    const result = h.display()
    await Promise.resolve()
    assert.deepEqual(await h.display(), {})
    if (action === 'revoke' || action === 'replace') h.invoke(MEDIA_CAPTURE_CHANNELS.revoke, { runId: valid.runId })
    if (action === 'replace') h.invoke(MEDIA_CAPTURE_CHANNELS.arm, valid)
    if (action === 'expire') h.setTime(1100)
    if (action === 'reload') h.contents.emit('did-start-navigation', {}, h.contents.mainFrame.url, false, true)
    if (action === 'close') h.window.emit('closed')
    if (action !== 'expire') assert.equal(h.pickerSignal?.aborted, true)
    select({ id: 'screen:2', name: 'Screen 2' })
    assert.deepEqual(await result, {}, action)
  }
})

test('display picker failure and user cancellation deny rather than selecting a default', async (t) => {
  for (const selection of [async () => undefined, async () => { throw new Error('OS denied') }]) {
    const h = harness()
    t.after(h.dispose)
    h.setSelection(selection)
    h.invoke(MEDIA_CAPTURE_CHANNELS.arm, valid)
    assert.deepEqual(await h.display(), {})
  }
})

const sources = Array.from({ length: 8 }, (_, index) => ({
  id: `${index ? 'window' : 'screen'}:${index}`, name: `Source ${index}`,
  thumbnail: { toDataURL: () => 'data:image/png;base64,YQ==' },
})) as Electron.DesktopCapturerSource[]
const settle = () => new Promise<void>(resolve => setImmediate(resolve))

test('DOM picker offers thumbnails, never defaults and resolves only a current opaque offer', async () => {
  const states: (DisplayPickerState | null)[] = []
  const picker = createDisplaySourcePicker(async () => sources, state => states.push(state))
  const result = picker.choose(new AbortController().signal)
  assert.equal(picker.state()?.status, 'loading')
  await settle()
  const state = picker.state()!
  assert.equal(state.sources.length, 8)
  assert.equal(state.sources[0]!.kind, 'screen')
  assert.equal(state.sources[1]!.thumbnailUrl, 'data:image/png;base64,YQ==')
  assert.notEqual(state.sources[7]!.id, sources[7]!.id)
  assert.throws(() => picker.respond({ requestId: state.requestId, sourceId: sources[7]!.id }), /offered/)
  assert.throws(() => picker.respond({ requestId: 'stale-request', sourceId: state.sources[7]!.id }), /no longer/)
  picker.respond({ requestId: state.requestId, sourceId: state.sources[7]!.id })
  assert.equal(await result, sources[7])
  assert.equal(states.at(-1), null)
  assert.throws(() => picker.respond({ requestId: state.requestId, sourceId: state.sources[7]!.id }), /no longer/)
})

test('DOM chooser cancellation and abort settle even while enumeration hangs; late results stay hidden', async () => {
  let enumerate!: (value: Electron.DesktopCapturerSource[]) => void
  const states: (DisplayPickerState | null)[] = []
  const picker = createDisplaySourcePicker(() => new Promise<Electron.DesktopCapturerSource[]>(resolve => { enumerate = resolve }), state => states.push(state))
  assert.equal(await picker.choose(AbortSignal.abort()), undefined)
  assert.equal(states.length, 0)
  for (const action of ['cancel', 'abort']) {
    const abort = new AbortController()
    const result = picker.choose(abort.signal)
    await settle()
    if (action === 'cancel') picker.respond({ requestId: picker.state()!.requestId, sourceId: null })
    else abort.abort()
    assert.equal(await result, undefined)
    enumerate(sources)
    await settle()
    assert.equal(picker.state(), null)
  }
})

test('DOM chooser shows empty/error state until explicit cancel, with no acquisition', async () => {
  for (const failure of [false, true]) {
    const picker = createDisplaySourcePicker(async () => { if (failure) throw new Error('OS detail'); return [] }, () => {})
    const result = picker.choose(new AbortController().signal)
    await settle()
    const state = picker.state()!
    assert.equal(state.status, failure ? 'error' : 'ready')
    assert.deepEqual(state.sources, [])
    picker.respond({ requestId: state.requestId, sourceId: null })
    assert.equal(await result, undefined)
  }
})

test('picker IPC is frame-validated and active-grant-bound, including expiry, close and reload', async t => {
  for (const action of ['select', 'cancel', 'revoke', 'expire', 'reload', 'close']) {
    const h = harness(target, async () => sources)
    t.after(h.dispose)
    assert.equal(h.invoke(MEDIA_CAPTURE_CHANNELS.pickerState, {}), null)
    assert.equal(h.messages.length, 0)
    h.invoke(MEDIA_CAPTURE_CHANNELS.arm, valid)
    const result = h.display()
    await settle()
    const state = h.invoke(MEDIA_CAPTURE_CHANNELS.pickerState, {}) as DisplayPickerState
    const response = { requestId: state.requestId, sourceId: state.sources[1]!.id }
    assert.equal(h.messages[0]![0], DISPLAY_PICKER_EVENT)
    assert.throws(() => h.invoke(MEDIA_CAPTURE_CHANNELS.pickerRespond, response, { ...h.caller, senderFrame: {} } as IpcMainInvokeEvent), /trusted Main/)
    assert.throws(() => h.invoke(MEDIA_CAPTURE_CHANNELS.pickerRespond, { ...response, video: sources[1] }), /Invalid/)
    if (action === 'select') h.invoke(MEDIA_CAPTURE_CHANNELS.pickerRespond, response)
    if (action === 'cancel') h.invoke(MEDIA_CAPTURE_CHANNELS.pickerRespond, { ...response, sourceId: null })
    if (action === 'revoke') h.invoke(MEDIA_CAPTURE_CHANNELS.revoke, { runId: valid.runId })
    if (action === 'expire') {
      h.setTime(1100)
      assert.throws(() => h.invoke(MEDIA_CAPTURE_CHANNELS.pickerRespond, response), /no longer/)
    }
    if (action === 'reload') h.contents.emit('did-start-navigation', {}, h.contents.mainFrame.url, false, true)
    if (action === 'close') h.window.emit('closed')
    assert.deepEqual(await result, action === 'select' ? { video: sources[1] } : {})
  }
})

test('picker wire schema and preload sanitize events, unsubscribe and avoid stale initial snapshots', async () => {
  for (const value of [null, {}, { requestId: 'ok', sourceId: 'screen:1', extra: true }, { requestId: 'ok', sourceId: {} }]) {
    assert.throws(() => parseDisplayPickerResponse(value), TypeError)
  }
  assert.throws(() => parseDisplayPickerState({ requestId: 'ok', status: 'ready', sources: [{ id: 'offer', name: 'X', kind: 'screen', thumbnailUrl: 'https://example.com/private' }] }), TypeError)
  let listener!: (event: unknown, value: unknown) => void
  let snapshot!: (value: unknown) => void
  let removed = false
  const values: unknown[] = []
  const api = createMediaCaptureApi({
    invoke: () => new Promise(resolve => { snapshot = resolve }),
    on: (channel, callback) => { assert.equal(channel, DISPLAY_PICKER_EVENT); listener = callback },
    removeListener: (_channel, callback) => { assert.equal(callback, listener); removed = true },
  }, () => true)
  const unsubscribe = api.displayPicker!.subscribe(value => values.push(value))
  listener({ sender: 'must not leak' }, null)
  snapshot({ requestId: 'stale', status: 'loading', sources: [] })
  await settle()
  assert.deepEqual(values, [null])
  unsubscribe()
  listener({}, null)
  assert.equal(removed, true)
  assert.deepEqual(values, [null])
})

test('a detached renderer that cannot receive its picker is denied without enumeration', async t => {
  let enumerated = false
  const h = harness(target, async () => { enumerated = true; return sources })
  t.after(h.dispose)
  h.contents.mainFrame.send = () => { throw new Error('Frame detached') }
  h.invoke(MEDIA_CAPTURE_CHANNELS.arm, valid)
  assert.deepEqual(await h.display(), {})
  assert.equal(enumerated, false)
})
