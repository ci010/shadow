import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, nativeImage, session } from 'electron'
import { Hono } from 'hono'
import { uiPlugin } from '../../../src/gateway/ui.ts'
import { serveLocalFiles } from '../../../src/gateway/local-files.ts'

function argument(name: string): string {
  const value = process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  assert.ok(value, `Missing ${name}`)
  return resolve(value)
}
const assets = argument('layout-assets')
const directory = argument('layout-root')
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps'] as const) {
  mkdirSync(join(directory, name), { recursive: true })
  app.setPath(name, join(directory, name))
}
app.setPath('home', directory)
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.on('window-all-closed', () => {})
const ui = new Hono()
uiPlugin(assets)(ui)
const sessionId = 'web:chat-image-annotation'
const chatId = sessionId.slice(4)
const fileName = 'original.png'
const jsonFileName = 'long.json'
const encodedTextName = '日本語 % #.txt'
const encodedTextBytes = Buffer.from('93fa967b8cea0a', 'hex')
const sourceDirectory = join(directory, 'image sources')
let sourcePath: string
const localFiles = new Hono()
for (const operation of ['files', 'raw', 'preview'] as const) {
  localFiles.get(`/${operation}`, c => serveLocalFiles(c, sourceDirectory, { key: sessionId }, operation, c.req.query('path') || ''))
}
const width = 400
const height = 200
let original: Buffer
const uploads: Array<{ name: string; chatId: string; bytes: Buffer; path: string }> = []
const sends: Array<{ chatId: string; content: string; media?: string[] }> = []
const requests: Array<{ method: string; path: string }> = []
const previewRequests: Array<{ path: string; encoding: string | null }> = []
const fileListRequests: string[] = []
let fileListGate: { path: string; wait: Promise<void> } | undefined
const errors: string[] = []
let rawRequests = 0
let sourceHeaderMode: 'valid' | 'missing' | 'malformed' = 'valid'
let window: BrowserWindow | undefined
let finishSend: (() => void) | undefined
let phase = 'initializing'
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url!, 'http://127.0.0.1')
    const path = url.pathname
    requests.push({ method: request.method!, path })
    const json = (data: unknown, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(data))
    }
    if (path === '/api/provider/setup') return json({ ready: true, provider: 'custom', model: 'synthetic-model', authMode: 'none', hasApiKey: false })
    if (path === '/api/provider/configured') return json({ providers: [{ provider: 'custom', model: 'synthetic-model', selected: true, authMode: 'none', hasApiKey: false }] })
    if (path === '/api/projects') return json({ projects: [] })
    if (path === '/api/config') return json({ agent: { model: 'synthetic-model' } })
    if (path === '/debug/models') return json({ models: ['synthetic-model'] })
    if (path === '/api/sessions/graph') return json({
      sessions: [{ sessionId, title: 'Image annotation regression', current: 'physical-image' }],
      nodes: [{ physicalId: 'physical-image', logicalId: sessionId }],
    })
    if (path === '/api/sessions/stages') return json({ stages: { [sessionId]: 'idle' } })
    if (path === '/api/chat/session') return json({ history: [{ role: 'assistant', content: 'Synthetic image context conversation.' }], systemPrompt: 'Synthetic fixture.', tools: [] })
    if (path === '/api/chat/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(': image fixture\n\n')
      return
    }
    const route = path.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/)
    if (route) {
      assert.equal(decodeURIComponent(route[1]), sessionId, 'The fixture must not create or switch conversations')
      const kind = route[2]
      if (kind === 'files' || kind === 'raw' || kind === 'preview') {
        assert.equal(request.method, 'GET', 'Image source is read-only')
        if (kind === 'raw') {
          assert.equal(url.searchParams.get('path'), fileName)
          rawRequests++
        }
        if (kind === 'preview') previewRequests.push({ path: url.searchParams.get('path') || '', encoding: url.searchParams.get('encoding') })
        if (kind === 'files') {
          const listingPath = url.searchParams.get('path') || ''
          fileListRequests.push(listingPath)
          if (fileListGate?.path === listingPath) {
            const waiting = fileListGate.wait
            fileListGate = undefined
            await waiting
          }
        }
        const resource = await localFiles.request(`http://fixture/${kind}${url.search}`)
        assert.equal(resource.status, 200)
        if (kind === 'raw') {
          assert.equal(resource.headers.get('X-Shadow-Source-Path'), encodeURIComponent(sourcePath), 'The real file-serving route provides canonical source provenance')
          assert.equal(resource.headers.get('Access-Control-Expose-Headers'), 'X-Shadow-Source-Path')
        }
        const headers = new Headers(resource.headers)
        if (kind === 'raw' && sourceHeaderMode === 'missing') headers.delete('X-Shadow-Source-Path')
        if (kind === 'raw' && sourceHeaderMode === 'malformed') headers.set('X-Shadow-Source-Path', '%E0%A4%A')
        response.writeHead(resource.status, Object.fromEntries(headers))
        response.end(Buffer.from(await resource.arrayBuffer()))
        return
      }
      if (kind === 'git/status') return json({ available: false, reason: 'not_repository', entries: [] })
      if (kind === 'details') return json({ sessionId, name: 'Image annotation regression', workdir: { kind: 'local', displayPath: sourceDirectory }, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, usageScope: 'session' })
      if (!kind) return json({ messages: [], currentPhysicalId: 'physical-image', previousPhysicalId: null })
    }
    if (path === '/api/chat/upload') {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const form = await new Response(new Uint8Array(Buffer.concat(chunks)), { headers: { 'Content-Type': String(request.headers['content-type']) } }).formData()
      const file = form.get('file')
      assert.ok(file instanceof File)
      const path = `C:\\synthetic\\uploads\\marked-${uploads.length + 1}.png`
      uploads.push({ name: file.name, chatId: String(form.get('chatId')), bytes: Buffer.from(await file.arrayBuffer()), path })
      return json({ path })
    }
    if (path === '/api/chat/send') {
      let body = ''
      for await (const chunk of request) body += chunk
      sends.push(JSON.parse(body))
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ event: 'response', content: 'Synthetic image received.', done: false })}\n\n`)
      finishSend = () => {
        response.end(`data: ${JSON.stringify({ event: 'response', content: 'Synthetic image received.', done: true })}\n\n`)
      }
      return
    }
    if (path === '/api/media') {
      const upload = uploads.find(item => item.path === url.searchParams.get('path'))
      assert.ok(upload)
      response.writeHead(200, { 'Content-Type': 'image/png' })
      response.end(upload.bytes)
      return
    }
    if (/^\/(?:api|nodes|debug|v1|local)\//.test(path)) {
      errors.push(`Unstubbed ${request.method} ${path}`)
      return json({ error: 'Unstubbed fixture endpoint' }, 404)
    }
    const resource = await ui.request(url.toString())
    const contentType = resource.headers.get('Content-Type') || 'application/octet-stream'
    response.writeHead(resource.status, {
      'Content-Type': contentType,
      'Content-Security-Policy': "default-src 'self' data:; img-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' blob:; font-src 'self' data:",
    })
    const body = Buffer.from(await resource.arrayBuffer())
    // Keep production assets and handlers, without contacting the optional font CDN.
    response.end(contentType.includes('text/html')
      ? body.toString('utf8').replace(/<link\b[^>]*href=["']https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '')
      : body)
  } catch (error) {
    errors.push(`Server: ${error instanceof Error ? error.stack : error}`)
    response.writeHead(500).end()
  }
})
const evaluate = <T = unknown>(source: string): Promise<T> => window!.webContents.executeJavaScript(source)
async function waitFor(source: string): Promise<void> {
  const end = Date.now() + 8000
  while (Date.now() < end) {
    if (await evaluate(source)) return
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`${phase}: timed out waiting for ${source}; errors=${JSON.stringify(errors)}`)
}
async function waitRequest(predicate: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 8000
  while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 40))
  assert.ok(predicate(), `${phase}: ${label}; errors=${JSON.stringify(errors)}`)
}
async function click(selector: string): Promise<void> {
  await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`)
  await waitFor(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    return !target.matches('.tree-row') || (!target.closest('[aria-disabled="true"]')
      && !target.querySelector('[aria-disabled="true"]'));
  })()`)
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
}
const canvasSelector = '.image-annotation-canvas'
async function attachedBytes(): Promise<Buffer> {
  const bytes = await evaluate<number[]>(`(async () => Array.from(new Uint8Array(await (await fetch(document.querySelector('.attachment-thumb').src)).arrayBuffer())))()`)
  return Buffer.from(bytes)
}
async function canvasBytes(): Promise<Buffer> {
  const value = await evaluate<string>(`document.querySelector('${canvasSelector}').toDataURL('image/png')`)
  return Buffer.from(value.split(',')[1], 'base64')
}
function assertPixels(bytes: Buffer, marked: boolean | 'red'): void {
  const image = nativeImage.createFromBuffer(bytes)
  assert.deepEqual(image.getSize(), { width, height }, 'Export retains the natural image resolution')
  const pixels = image.toBitmap()
  let red = 0
  let blue = 0
  let changed = 0
  for (let index = 0; index < pixels.length; index += 4) {
    const [b, g, r, a] = pixels.subarray(index, index + 4)
    if (r !== 255 || g !== 255 || b !== 255 || a !== 255) changed++
    if (a === 255 && r > 170 && r > g * 1.4 && r > b * 1.4) red++
    if (a === 255 && b > 170 && b > r * 1.4 && b > g * 1.2) blue++
  }
  if (marked === 'red') {
    assert.ok(red > 30, 'Undo retains the opaque red first stroke')
    assert.equal(blue, 0, 'Undo removes every blue last-stroke pixel')
  } else if (marked) {
    assert.ok(red > 30 && blue > 30, `Export must contain opaque red and blue marker pixels (red=${red}, blue=${blue})`)
    assert.ok(changed < width * height / 3, 'Marking preserves the rest of the original image')
  } else assert.equal(changed, 0, 'Clear/original reference preserves every source pixel')
}
async function stroke(y: number, gate: boolean | 'clear' | 'undo' = false): Promise<void> {
  if (gate) await evaluate(`(() => {
    const native = HTMLCanvasElement.prototype.toBlob;
    window.imageExports = [];
    window.imageExportsCompleted = 0;
    HTMLCanvasElement.prototype.toBlob = function(callback, ...args) {
      window.imageExports.push(() => native.call(this, blob => { callback(blob); window.imageExportsCompleted++; }, ...args));
    };
    window.restoreImageExport = () => { HTMLCanvasElement.prototype.toBlob = native; };
  })()`)
  const box = await evaluate<{ x: number; y: number; width: number; height: number }>(`(() => {
    const canvas = document.querySelector('${canvasSelector}');
    canvas.scrollIntoView({ block: 'center' }); const r = canvas.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`)
  const at = (x: number) => ({ x: Math.round(box.x + box.width * x), y: Math.round(box.y + box.height * y) })
  window!.webContents.sendInputEvent({ type: 'mouseMove', ...at(0.2) })
  window!.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...at(0.2) })
  await waitFor(`document.querySelector('.composer-send').disabled && document.querySelector('.composer-hint').textContent.includes('Preparing marked image')`)
  for (const x of [0.3, 0.4, 0.5, 0.6, 0.7]) window!.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'], ...at(x) })
  window!.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...at(0.7) })
  if (gate) {
    await waitFor(`window.imageExports.length === 1`)
    await click('.composer-send')
    assert.equal(uploads.length, 0, 'Send remains blocked while PNG export is outstanding')
    assert.equal(sends.length, 0)
    assert.equal(await evaluate(`document.querySelector('.composer-send').disabled`), true)
    if (gate === 'clear') await click('.image-annotation-clear')
    if (gate === 'undo') {
      assert.equal(await evaluate(`document.querySelector('.image-annotation-undo').disabled`), false, 'Undo remains available during PNG export')
      await click('.image-annotation-undo')
    }
    await evaluate(`window.restoreImageExport(); window.imageExports.shift()()`)
    await waitFor(`window.imageExportsCompleted === 1`)
  }
  if (gate === 'clear' || gate === 'undo') {
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    await waitFor(`document.querySelectorAll('.attachment-chip').length === 0 && document.querySelector('.composer-send').disabled`)
    return
  }
  await waitFor(`document.querySelectorAll('.attachment-chip').length === 1 && !document.querySelector('.composer-send').disabled`)
}
async function undoShortcut(selector: string, handled: boolean): Promise<void> {
  const count = await evaluate<number>(`window.undoShortcutEvents.length`)
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)
  assert.equal(await evaluate(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`), true, 'Native shortcut is sent to the requested focused element')
  window!.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] })
  window!.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] })
  window!.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Control' })
  await waitFor(`window.undoShortcutEvents.length === ${count + 1}`)
  const event = await evaluate<{ prevented: boolean; trusted: boolean }>(`window.undoShortcutEvents[${count}]`)
  assert.equal(event.trusted, true, 'Undo is driven by native key input, not a synthetic handler call')
  assert.equal(event.prevented, handled, 'Only image-focused Ctrl+Z is consumed by image undo')
}
async function assertReferencePresentation(): Promise<void> {
  await assertSourcePath()
  await waitFor(`document.querySelector('.attachment-reference .attachment-thumb')?.naturalWidth === ${width}`)
  assert.equal(await evaluate(`(() => {
    const reference = document.querySelector('.attachment-reference');
    const label = reference.querySelector('.attachment-reference-label');
    const thumb = reference.querySelector('.attachment-thumb');
    const image = thumb.getBoundingClientRect(), chip = reference.getBoundingClientRect();
    const composer = document.querySelector('.composer-box').getBoundingClientRect();
    return label?.textContent.trim() === 'Image reference' && label.getClientRects().length > 0
      && getComputedStyle(thumb).objectFit === 'contain'
      && Math.abs(image.width - 72) <= 1 && Math.abs(image.height - 48) <= 1
      && image.left >= chip.left && image.right <= chip.right && image.top >= chip.top && image.bottom <= chip.bottom
      && chip.left >= composer.left && chip.right <= composer.right
      && !!reference.querySelector('button[aria-label^="Remove "]');
  })()`), true, 'Pending image reference has a visible label, contained 72×48 thumbnail, and remove button')
}
async function assertSourcePath(): Promise<void> {
  await waitFor(`document.querySelector('.attachment-source-path')?.textContent.trim() === ${JSON.stringify(sourcePath)}`)
  await waitFor(`(() => {
    const path = document.querySelector('.attachment-source-path');
    if (!path) return false;
    const chip = path.closest('.attachment-reference').getBoundingClientRect();
    const rect = path.getBoundingClientRect();
    return path.getClientRects().length > 0 && rect.width > 0
      && rect.left >= chip.left - 1 && rect.right <= chip.right + 1;
  })()`)
}
async function captureScreenshot(name: string, mobile = false): Promise<void> {
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  await new Promise<void>((resolve, reject) => {
    const contents = window!.webContents
    const painted = () => { clearTimeout(timeout); resolve() }
    const timeout = setTimeout(() => {
      contents.removeListener('paint', painted)
      reject(new Error(`${phase}: screenshot did not repaint`))
    }, 5000)
    contents.once('paint', painted)
    contents.invalidate()
  })
  await writeFile(join(directory, name), (await window!.webContents.capturePage(mobile ? { x: 0, y: 0, width: 390, height: 844 } : undefined)).toPNG())
}
const clearanceProbe = `(() => {
  const body = Array.from(document.querySelectorAll('.file-modal-body')).find(node => node.getClientRects().length);
  const pre = body?.querySelector('.file-modal-text');
  const note = Array.from(body?.querySelectorAll('.file-modal-note') || []).find(node => node.textContent.includes('Preview truncated'));
  if (!pre || !note) return null;
  const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT); let last;
  while (walker.nextNode()) if (walker.currentNode.textContent.trimEnd()) last = walker.currentNode;
  if (!last) return null;
  const end = last.textContent.trimEnd().length, range = document.createRange();
  range.setStart(last, end - 1); range.setEnd(last, end);
  const dock = document.querySelector('.conversation-dock').getBoundingClientRect();
  return { lastBottom: range.getBoundingClientRect().bottom, noteBottom: note.getBoundingClientRect().bottom,
    dockTop: dock.top, dockHeight: dock.height, scrollTop: body.scrollTop, maxScroll: body.scrollHeight - body.clientHeight,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth };
})()`
type Clearance = { lastBottom: number; noteBottom: number; dockTop: number; dockHeight: number; scrollTop: number; maxScroll: number; horizontalOverflow: boolean }
async function scrollJsonToEnd(): Promise<Clearance> {
  await evaluate(`(() => {
    const body = Array.from(document.querySelectorAll('.file-modal-body')).find(node => node.getClientRects().length);
    body.scrollTop = body.scrollHeight;
  })()`)
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  const result = await evaluate<Clearance | null>(clearanceProbe)
  assert.ok(result, `${phase}: real source text and truncation note are present`)
  assert.ok(result.maxScroll > 0 && Math.abs(result.scrollTop - result.maxScroll) <= 2, `${phase}: preview is at its maximum scroll position: ${JSON.stringify(result)}`)
  return result
}
function hasJsonClearance(result: Clearance): boolean {
  return result.lastBottom <= result.dockTop - 40 && result.noteBottom <= result.dockTop - 40 && !result.horizontalOverflow
}
async function assertJsonClearance(): Promise<Clearance> {
  const result = await scrollJsonToEnd()
  assert.ok(hasJsonClearance(result), `${phase}: last source line and truncation note need 40px clearance above the composer: ${JSON.stringify(result)}`)
  return result
}
async function setComposerText(text: string): Promise<void> {
  await evaluate(`(() => {
    const input = document.querySelector('.composer-input textarea');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
}
async function assertScrollbar(dark: boolean): Promise<void> {
  const result = await evaluate<{ token: string; thumb: string; native: string; background: string }>(`(() => {
    const body = Array.from(document.querySelectorAll('.file-modal-body')).find(node => node.getClientRects().length);
    let background = '', current = body;
    while (current) {
      const value = getComputedStyle(current).backgroundColor;
      if (value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)') { background = value; break; }
      current = current.parentElement;
    }
    return { token: getComputedStyle(body).getPropertyValue('--c-scrollbar-thumb').trim(),
      thumb: getComputedStyle(body, '::-webkit-scrollbar-thumb').backgroundColor,
      native: getComputedStyle(body).scrollbarColor, background };
  })()`)
  const expected = dark ? 'rgb(119, 119, 130)' : 'rgb(124, 135, 151)'
  assert.equal(result.token.toLowerCase(), dark ? '#777782' : '#7c8797')
  assert.equal(result.thumb, expected, 'The actual file scroller uses the dedicated visible thumb token')
  assert.ok(result.native.startsWith(expected), 'Native scrollbar-color also uses the visible thumb token')
  const luminance = (value: string) => {
    const channels = value.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(channel => {
      const normalized = channel / 255
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
    })
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  }
  assert.ok(result.background, 'File scroller has a resolvable opaque background')
  const thumb = luminance(result.thumb), background = luminance(result.background)
  const contrast = (Math.max(thumb, background) + 0.05) / (Math.min(thumb, background) + 0.05)
  assert.ok(contrast >= 3, `${phase}: scrollbar contrast ${contrast.toFixed(2)} must be at least 3:1 against ${result.background}`)
}
async function jsonScrollRegression(): Promise<void> {
  const desktopWidth = await evaluate<number>('innerWidth')
  phase = 'opening oversized JSON'
  await waitFor(`!!document.querySelector('.tree-row[data-path="${jsonFileName}"]')`)
  await click(`.tree-row[data-path="${jsonFileName}"]`)
  await waitFor(`!!Array.from(document.querySelectorAll('.file-modal-note')).find(node => node.textContent.includes('Preview truncated')) && !!document.querySelector('.file-modal-text')`)
  const cases: Array<{ mobile: boolean; dark: boolean }> = [
    { mobile: false, dark: true }, { mobile: false, dark: false },
    { mobile: true, dark: false }, { mobile: true, dark: true },
  ]
  for (const [index, entry] of cases.entries()) {
    if (entry.mobile && index === 2) {
      window!.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
      await waitFor(`innerWidth === 390`)
    }
    const nextTheme = entry.dark ? 'dark' : 'light'
    if (await evaluate(`!!document.querySelector('[aria-label="Switch to ${nextTheme} theme"]')`)) await click(`[aria-label="Switch to ${nextTheme} theme"]`)
    await waitFor(`!!document.querySelector('[aria-label="Switch to ${entry.dark ? 'light' : 'dark'} theme"]')`)
    phase = `JSON ${entry.mobile ? 'mobile' : 'desktop'} ${nextTheme}`
    await setComposerText('')
    const short = await assertJsonClearance()
    await assertScrollbar(entry.dark)
    if (index === 0) {
      await evaluate(`document.querySelector('.file-modal-text-wrap').style.alignSelf = 'stretch'`)
      const broken = await scrollJsonToEnd()
      assert.equal(hasJsonClearance(broken), false, 'Reintroducing the old stretch layout reproduces hidden JSON footer clearance')
      await evaluate(`document.querySelector('.file-modal-text-wrap').style.removeProperty('align-self')`)
      await assertJsonClearance()
    }
    await setComposerText(Array.from({ length: 9 }, (_, line) => `Synthetic multiline composer row ${line + 1}`).join('\n'))
    await waitFor(`document.querySelector('.conversation-dock').getBoundingClientRect().height > ${short.dockHeight + 20}`)
    await assertJsonClearance()
    if (!entry.mobile && !entry.dark) await captureScreenshot('file-scroll-desktop.png')
    if (entry.mobile && entry.dark) await captureScreenshot('file-scroll-mobile.png', true)
  }
  phase = 'restoring after JSON regression'
  await setComposerText('')
  await click(`[aria-label="Close ${jsonFileName}"]`)
  window!.webContents.disableDeviceEmulation()
  await waitFor(`innerWidth === ${desktopWidth} && !document.querySelector('.file-modal-text-wrap')`)
  console.log('LAYOUT_JSON_RESULT ' + JSON.stringify({ ok: true, viewports: 2, themes: 2, composerSizes: 2, oldLayoutReproduced: true }))
}
const treeRow = (path: string) => `.workbench-explorer .tree-row[data-path="${path}"]`
const listingCount = (path: string) => fileListRequests.filter(item => item === path).length
async function assertTreeIdentity(nestedVisible = true): Promise<void> {
  assert.deepEqual(await evaluate(`(() => {
    const refs = window.treeRefs;
    const failures = [];
    for (const [name, path] of [['root', '${fileName}'], ['folder', 'branch'], ['nested', 'branch/nested'], ['leaf', 'branch/nested/keep.txt']]) {
      if (!refs[name].isConnected || refs[name] !== document.querySelector('.workbench-explorer .tree-row[data-path="' + path + '"]')) failures.push(name);
    }
    if (!refs.label.isConnected || refs.label.textContent.trim() !== 'image sources') failures.push('root label');
    if (!refs.preview.isConnected || refs.preview !== document.querySelector('.file-modal-text')) failures.push('selected preview');
    if (!!refs.leaf.getClientRects().length !== ${nestedVisible}) failures.push('expanded descendants visibility');
    return failures;
  })()`), [], `${phase}: tree rows, root label and selected preview retain actual DOM identity`)
}
async function refreshTree(): Promise<void> {
  const paths = ['', 'branch', 'branch/nested', 'overflow']
  const before = paths.map(listingCount)
  await click('.workbench-explorer [aria-label="Refresh files"]')
  await waitRequest(() => paths.every((path, index) => listingCount(path) === before[index] + 1), 'root and each already-expanded folder refresh once in place')
  await waitFor(`!document.querySelector('.workbench-explorer [aria-label="Refresh files"]').disabled`)
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
}
async function treeIdentityRegression(): Promise<void> {
  phase = 'initial nested folder expansion'
  await waitFor(`!!document.querySelector(${JSON.stringify(treeRow('branch'))})`)
  let before = fileListRequests.length
  await click(treeRow('branch'))
  await waitFor(`!!document.querySelector(${JSON.stringify(treeRow('branch/nested'))})`)
  assert.deepEqual(fileListRequests.slice(before), ['branch'], 'Initial folder expansion loads only that folder, never root or siblings')
  before = fileListRequests.length
  await click(treeRow('branch/nested'))
  await waitFor(`!!document.querySelector(${JSON.stringify(treeRow('branch/nested/keep.txt'))})`)
  assert.deepEqual(fileListRequests.slice(before), ['branch/nested'])
  await click(treeRow('branch/nested/keep.txt'))
  await waitFor(`document.querySelector('.file-modal-text')?.textContent.includes('Stable nested preview')`)
  await evaluate(`(() => {
    const explorer = document.querySelector('.workbench-explorer');
    window.treeRefs = {
      root: document.querySelector(${JSON.stringify(treeRow(fileName))}),
      folder: document.querySelector(${JSON.stringify(treeRow('branch'))}),
      nested: document.querySelector(${JSON.stringify(treeRow('branch/nested'))}),
      leaf: document.querySelector(${JSON.stringify(treeRow('branch/nested/keep.txt'))}),
      label: Array.from(explorer.querySelectorAll('*')).find(node => !node.children.length && node.textContent.trim() === 'image sources'),
      preview: document.querySelector('.file-modal-text')
    };
  })()`)
  await assertTreeIdentity()
  phase = 'collapse and reopen preserve nested DOM and cache'
  before = fileListRequests.length
  await click(treeRow('branch'))
  await assertTreeIdentity(false)
  await click(treeRow('branch'))
  await assertTreeIdentity()
  assert.equal(fileListRequests.length, before, 'Collapse/reopen reuses the loaded subtree without new reads')
  phase = 'folder scrollbar does not move sibling column'
  const bounds = () => evaluate<{ left: number; width: number; labelLeft: number }>(`(() => {
    const row = window.treeRefs.root.getBoundingClientRect();
    return { left: row.left, width: row.width, labelLeft: window.treeRefs.label.getBoundingClientRect().left };
  })()`)
  const beforeScrollbar = await bounds()
  await click(treeRow('overflow'))
  await waitFor(`(() => { const body = document.querySelector('.workbench-explorer .file-tree-body'); return body.scrollHeight > body.clientHeight && !!document.querySelector(${JSON.stringify(treeRow('overflow/item-69.txt'))}); })()`)
  assert.deepEqual(await bounds(), beforeScrollbar, 'Stable gutter prevents root/sibling horizontal movement when a folder creates scrolling')
  await evaluate(`document.querySelector('.workbench-explorer .file-tree-body').scrollTop = 48`)
  const scrollTop = await evaluate<number>(`document.querySelector('.workbench-explorer .file-tree-body').scrollTop`)
  phase = 'delayed unchanged root refresh keeps rows mounted'
  let release!: () => void
  fileListGate = { path: '', wait: new Promise(resolve => { release = resolve }) }
  const rootReads = listingCount('')
  const nestedReads = listingCount('branch/nested')
  await click('.workbench-explorer [aria-label="Refresh files"]')
  await waitRequest(() => listingCount('') === rootReads + 1, 'delayed root refresh is in flight')
  await assertTreeIdentity()
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.workbench-explorer .file-tree-note')).some(node => node.getClientRects().length && /Loading files/i.test(node.textContent))`), false, 'Refresh does not replace loaded rows with a loading placeholder')
  release()
  await waitRequest(() => listingCount('branch/nested') === nestedReads + 1, 'expanded descendants refresh after root response')
  await waitFor(`!document.querySelector('.workbench-explorer [aria-label="Refresh files"]').disabled`)
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  await assertTreeIdentity()
  assert.equal(await evaluate(`document.querySelector('.workbench-explorer .file-tree-body').scrollTop`), scrollTop, 'Unchanged refresh preserves tree scroll position')
  phase = 'nested addition and removal reconcile in place'
  await writeFile(join(sourceDirectory, 'branch', 'nested', 'added.txt'), 'New synthetic entry\n')
  await unlink(join(sourceDirectory, 'branch', 'nested', 'remove.txt'))
  await refreshTree()
  await waitFor(`!!document.querySelector(${JSON.stringify(treeRow('branch/nested/added.txt'))}) && !document.querySelector(${JSON.stringify(treeRow('branch/nested/remove.txt'))})`)
  await assertTreeIdentity()
  phase = 'collapsed subtree refresh is deferred until reopen'
  await click(treeRow('branch'))
  const collapsedBranchReads = listingCount('branch'), collapsedNestedReads = listingCount('branch/nested')
  const beforeCollapsedRefresh = listingCount('')
  await click('.workbench-explorer [aria-label="Refresh files"]')
  await waitRequest(() => listingCount('') === beforeCollapsedRefresh + 1, 'refresh while branch is collapsed')
  await waitFor(`!document.querySelector('.workbench-explorer [aria-label="Refresh files"]').disabled`)
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  assert.equal(listingCount('branch'), collapsedBranchReads)
  assert.equal(listingCount('branch/nested'), collapsedNestedReads)
  await assertTreeIdentity(false)
  await click(treeRow('branch'))
  await waitRequest(() => listingCount('branch') === collapsedBranchReads + 1 && listingCount('branch/nested') === collapsedNestedReads + 1, 'reopening refreshes stale cached expanded descendants')
  await assertTreeIdentity()
  await click(treeRow('branch'))
  await click(treeRow('overflow'))
  await click('[aria-label="Close branch/nested/keep.txt"]')
  await waitFor(`!document.querySelector('.file-modal-text')`)
  console.log('LAYOUT_TREE_RESULT ' + JSON.stringify({ ok: true, preservedRows: 4, unchangedRefresh: true, changedRefresh: true, deferredRefresh: true }))
}
async function dragReference(): Promise<void> {
  const reads = rawRequests
  const previousUploads = uploads.length
  const result = await evaluate<{ types: string[]; over: boolean; drop: boolean; selected: boolean; focused: boolean }>(`(() => {
    const canvas = document.querySelector('${canvasSelector}');
    const data = new DataTransfer();
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, ctrlKey: true }));
    canvas.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, ctrlKey: true, dataTransfer: data }));
    const target = document.querySelector('.composer-box');
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data });
    target.dispatchEvent(over);
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data });
    target.dispatchEvent(drop);
    canvas.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, ctrlKey: true }));
    return { types: [...data.types], over: over.defaultPrevented, drop: drop.defaultPrevented,
      selected: document.querySelector('[role="tab"][aria-label="${fileName}"]').getAttribute('aria-selected') === 'true',
      focused: document.activeElement === document.querySelector('.composer-input textarea') };
  })()`)
  assert.ok(result.types.includes('application/x-shadow-image-reference'), 'Production dragstart registers the owned image reference')
  assert.equal(result.over, true)
  assert.equal(result.drop, true)
  assert.equal(result.selected, true, 'Dropping keeps the source document selected')
  assert.equal(result.focused, false, 'Dropping does not steal focus into the composer')
  await waitFor(`document.querySelectorAll('.attachment-chip').length === 1`)
  await assertSourcePath()
  assert.equal(rawRequests, reads, 'Owned-reference drop does not fetch the image URL')
  assert.equal(uploads.length, previousUploads, 'Dropping only updates local pending state')
}
async function imageSourceRecoveryRegression(): Promise<void> {
  const initialReads = rawRequests
  for (const mode of ['missing', 'malformed'] as const) {
    phase = `image with ${mode} source header`
    await click(`[aria-label="Close ${fileName}"]`)
    await waitFor(`!document.querySelector('${canvasSelector}')`)
    sourceHeaderMode = mode
    const beforeOpen = rawRequests
    await click(`.tree-row[data-path="${fileName}"]`)
    await waitRequest(() => rawRequests === beforeOpen + 1, `${mode} source image request`)
    await waitFor(`document.querySelector('${canvasSelector}')?.width === ${width} && !!document.querySelector('.image-annotation-source-error') && document.querySelector('.image-annotation-preview').getAttribute('aria-busy') !== 'true'`)
    assert.equal(await evaluate(`(() => {
      const canvas = document.querySelector('${canvasSelector}');
      const rect = canvas.getBoundingClientRect();
      return canvas.getClientRects().length > 0 && rect.width > 0 && rect.height > 0;
    })()`), true, 'Missing source metadata must not prevent displaying the decoded image')
    assertPixels(await canvasBytes(), false)
    const notice = await evaluate<string>(`document.querySelector('.image-annotation-source-error').textContent`)
    assert.match(notice, mode === 'missing' ? /restart.*main/i : /invalid.*reopen.*retry/i)
    assert.match(notice, /still view.*marking and references are disabled/i)
    assert.equal(await evaluate(`document.querySelector('[aria-label="Red marker"]').disabled && document.querySelector('[aria-label="Blue marker"]').disabled && document.querySelector('[aria-label="Custom marker color"]').disabled`), true, 'Source-less previews cannot start marks')
    const point = await evaluate<{ x: number; y: number }>(`(() => {
      const r = document.querySelector('${canvasSelector}').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`)
    window!.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    window!.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'], x: point.x + 20, y: point.y })
    window!.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x + 20, y: point.y })
    const blockedDrag = await evaluate<{ prevented: boolean; types: string[] }>(`(() => {
      const canvas = document.querySelector('${canvasSelector}'), data = new DataTransfer();
      canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, ctrlKey: true }));
      const event = new DragEvent('dragstart', { bubbles: true, cancelable: true, ctrlKey: true, dataTransfer: data });
      canvas.dispatchEvent(event);
      document.querySelector('.composer-box').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
      canvas.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }));
      return { prevented: event.defaultPrevented, types: [...data.types] };
    })()`)
    assert.equal(blockedDrag.prevented, true, 'A source-less native dragstart is rejected')
    assert.equal(blockedDrag.types.includes('application/x-shadow-image-reference'), false)
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    assertPixels(await canvasBytes(), false)
    assert.equal(await evaluate(`document.querySelectorAll('.attachment-chip').length`), 0, 'Source-less viewing cannot create anonymous attachments')
    phase = `retrying ${mode} source header`
    sourceHeaderMode = 'valid'
    const beforeRetry = rawRequests
    await click('.image-annotation-source-retry')
    await waitRequest(() => rawRequests === beforeRetry + 1, 'source retry rereads this image')
    await waitFor(`!document.querySelector('.image-annotation-source-error') && !document.querySelector('[aria-label="Red marker"]').disabled`)
    assertPixels(await canvasBytes(), false)
    await dragReference()
    assert.deepEqual(await attachedBytes(), original, 'Retry restores a provenance-bearing reference to the unchanged original')
    await click('.attachment-reference button')
    await waitFor(`document.querySelectorAll('.attachment-chip').length === 0`)
  }
  assert.equal(rawRequests - initialReads, 4, 'Each missing/malformed-header case performs exactly an open and an explicit retry')
  console.log('LAYOUT_SOURCE_RECOVERY_RESULT ' + JSON.stringify({ ok: true, headerCases: 2, rawReads: rawRequests - initialReads }))
}
async function textEncodingRegression(): Promise<void> {
  phase = 'Japanese text automatic decoding warning'
  await click(`[aria-label="Close ${fileName}"]`)
  const beforeOpen = previewRequests.length
  await click(`.tree-row[data-path="${encodedTextName}"]`)
  await waitRequest(() => previewRequests.length === beforeOpen + 1 && previewRequests.at(-1)?.path === encodedTextName, 'encoded Japanese, percent, space and hash filename resolves unchanged')
  await waitFor(`!!document.querySelector('.file-encoding-warning') && document.querySelector('.file-modal-text')?.textContent.includes('\\uFFFD')`)
  assert.equal(await evaluate(`document.querySelector('[aria-label="Text encoding"]').value`), 'auto')
  assert.deepEqual(await evaluate<string[]>(`Array.from(document.querySelector('[aria-label="Text encoding"]').options, option => option.value).sort()`),
    ['auto', 'utf-8', 'shift_jis', 'gb18030', 'utf-16le', 'utf-16be', 'windows-1252'].sort())
  phase = 'Japanese text explicit Shift-JIS decoding'
  const beforeChange = previewRequests.length
  await evaluate(`(() => {
    const select = document.querySelector('[aria-label="Text encoding"]');
    select.value = 'shift_jis';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  await waitRequest(() => previewRequests.length === beforeChange + 1 && previewRequests.at(-1)?.path === encodedTextName && previewRequests.at(-1)?.encoding === 'shift_jis', 'the selected encoding reaches the real scoped preview route')
  await waitFor(`!document.querySelector('.file-encoding-warning') && document.querySelector('.file-modal-text')?.textContent === '日本語\\n'`)
  assert.deepEqual(await readFile(join(sourceDirectory, encodedTextName)), encodedTextBytes, 'Changing text decoding never rewrites or renames source bytes')
  await click(`[aria-label="Close ${encodedTextName}"]`)
  console.log('LAYOUT_ENCODING_RESULT ' + JSON.stringify({ ok: true, encoding: 'shift_jis', preservedFilename: encodedTextName, previewReads: previewRequests.length - beforeOpen }))
}
async function main(): Promise<void> {
  await app.whenReady()
  original = nativeImage.createFromBitmap(Buffer.alloc(width * height * 4, 255), { width, height }).toPNG()
  const originalSnapshot = Buffer.from(original)
  mkdirSync(sourceDirectory, { recursive: true })
  await writeFile(join(sourceDirectory, fileName), original)
  const jsonContent = JSON.stringify({ records: Array.from({ length: 1800 }, (_, index) => ({
    index, description: 'Synthetic long JSON preview content; no user filesystem data. '.repeat(3),
  })) }, null, 2)
  assert.ok(Buffer.byteLength(jsonContent) > 65536)
  await writeFile(join(sourceDirectory, jsonFileName), jsonContent)
  await writeFile(join(sourceDirectory, encodedTextName), encodedTextBytes)
  mkdirSync(join(sourceDirectory, 'branch', 'nested'), { recursive: true })
  mkdirSync(join(sourceDirectory, 'overflow'), { recursive: true })
  await Promise.all([
    writeFile(join(sourceDirectory, 'branch', 'nested', 'keep.txt'), 'Stable nested preview\n'),
    writeFile(join(sourceDirectory, 'branch', 'nested', 'remove.txt'), 'Removable synthetic entry\n'),
    ...Array.from({ length: 70 }, (_, index) => writeFile(join(sourceDirectory, 'overflow', `item-${String(index).padStart(2, '0')}.txt`), `Synthetic entry ${index}\n`)),
  ])
  sourcePath = await realpath(join(sourceDirectory, fileName))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(origin + '/') || details.url.startsWith(`blob:${origin}/`) || details.url.startsWith('data:') || details.url.startsWith('devtools:')
    if (!allowed) errors.push(`External request blocked: ${details.url}`)
    callback({ cancel: !allowed })
  })
  window = new BrowserWindow({ width: 1400, height: 1000, show: false, webPreferences: { offscreen: true, backgroundThrottling: false, preload: join(directory, 'layout-preload.cjs'), additionalArguments: [`--layout-api-base=${origin}`] } })
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(`Renderer: ${details.message} (${details.sourceId}:${details.lineNumber})`)
  })
  window.webContents.on('render-process-gone', (_event, details) => errors.push(`Renderer exited: ${details.reason}`))
  await window.loadURL(`${origin}/chat/${encodeURIComponent(sessionId)}`)
  window.webContents.debugger.attach('1.3')
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await treeIdentityRegression()
  await jsonScrollRegression()
  phase = 'opening image'
  await waitFor(`!!document.querySelector('.tree-row[data-path="${fileName}"]')`)
  await click(`.tree-row[data-path="${fileName}"]`)
  await waitFor(`document.querySelector('${canvasSelector}')?.width === ${width}`)
  await evaluate(`(() => {
    window.revokedImageUrls = [];
    window.undoShortcutEvents = [];
    window.addEventListener('keydown', event => {
      if (event.ctrlKey && event.key.toLowerCase() === 'z') setTimeout(() => {
        window.undoShortcutEvents.push({ prevented: event.defaultPrevented, trusted: event.isTrusted });
      }, 0);
    }, true);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = value => { window.revokedImageUrls.push(value); revoke(value); };
  })()`)
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea').value`), '')
  phase = 'original Ctrl-drag'
  await dragReference()
  assert.deepEqual(await attachedBytes(), original, 'Original Ctrl-drag references the exact original file bytes')
  const originalUrl = await evaluate<string>(`document.querySelector('.attachment-thumb').src`)
  await click('.attachment-chip button')
  await waitFor(`document.querySelectorAll('.attachment-chip').length === 0`)
  assert.equal(await evaluate(`document.querySelectorAll('.attachment-source-path').length`), 0, 'Removing the original reference also removes its source caption')
  assert.equal(await evaluate(`window.revokedImageUrls.includes(${JSON.stringify(originalUrl)})`), true, 'Removing an attachment revokes its preview URL')
  phase = 'red and blue strokes'
  await stroke(0.3, true)
  const redUrl = await evaluate<string>(`document.querySelector('.attachment-thumb').src`)
  await click('[aria-label="Blue marker"]')
  await stroke(0.7)
  assert.equal(await evaluate(`window.revokedImageUrls.includes(${JSON.stringify(redUrl)})`), true, 'A later stroke replaces and revokes the previous pending preview')
  assertPixels(await attachedBytes(), true)
  assert.equal(await evaluate(`document.querySelector('[role="tab"][aria-label="${fileName}"]').getAttribute('aria-selected')`), 'true')
  await assertReferencePresentation()
  phase = 'textarea Ctrl+Z leaves image untouched'
  const beforeTextUndo = await canvasBytes()
  const beforeTextReference = await attachedBytes()
  await undoShortcut('.composer-input textarea', false)
  assert.deepEqual(await canvasBytes(), beforeTextUndo)
  assert.deepEqual(await attachedBytes(), beforeTextReference)
  phase = 'native image Ctrl+Z removes last stroke'
  const beforeUndoUrl = await evaluate<string>(`document.querySelector('.attachment-thumb').src`)
  await undoShortcut(canvasSelector, true)
  await waitFor(`document.querySelectorAll('.attachment-chip').length === 1 && !document.querySelector('.composer-send').disabled && document.querySelector('.attachment-thumb').src !== ${JSON.stringify(beforeUndoUrl)}`)
  assertPixels(await canvasBytes(), 'red')
  assertPixels(await attachedBytes(), 'red')
  await assertSourcePath()
  assert.equal(await evaluate(`window.revokedImageUrls.includes(${JSON.stringify(beforeUndoUrl)})`), true, 'Undo replaces and revokes the old pending reference')
  phase = 'undo button restores original'
  await click('.image-annotation-undo')
  await waitFor(`document.querySelectorAll('.attachment-chip').length === 0 && document.querySelector('.composer-send').disabled`)
  assertPixels(await canvasBytes(), false)
  assert.equal(await evaluate(`document.querySelector('.image-annotation-undo').disabled`), true, 'Undoing every stroke empties undo history')
  await click('[aria-label="Red marker"]')
  await stroke(0.3)
  await click('[aria-label="Blue marker"]')
  await stroke(0.7)
  phase = 'remove reference keeps image marks'
  const beforeRemove = await canvasBytes()
  const removedUrl = await evaluate<string>(`document.querySelector('.attachment-thumb').src`)
  await click('.attachment-reference button')
  await waitFor(`document.querySelectorAll('.attachment-chip').length === 0`)
  assert.equal(await evaluate(`document.querySelectorAll('.attachment-source-path').length`), 0, 'Removing the marked reference removes its source caption')
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  assert.equal(await evaluate(`document.querySelectorAll('.attachment-chip').length`), 0, 'Removing a reference does not immediately recreate it')
  assert.deepEqual(await canvasBytes(), beforeRemove, 'The reference X does not erase preview marks')
  assert.equal(await evaluate(`window.revokedImageUrls.includes(${JSON.stringify(removedUrl)})`), true)
  await dragReference()
  assertPixels(await attachedBytes(), true)
  phase = 'clear'
  const markedUrl = await evaluate<string>(`document.querySelector('.attachment-thumb').src`)
  await click('.image-annotation-clear')
  await waitFor(`document.querySelectorAll('.attachment-chip').length === 0`)
  assert.equal(await evaluate(`window.revokedImageUrls.includes(${JSON.stringify(markedUrl)})`), true)
  const cleared = await evaluate<string>(`document.querySelector('${canvasSelector}').toDataURL('image/png')`)
  assertPixels(Buffer.from(cleared.split(',')[1], 'base64'), false)
  assert.equal(await evaluate(`document.querySelector('.composer-send').disabled`), true, 'Cleared image-only draft cannot send')
  assert.equal(await evaluate(`document.querySelector('.image-annotation-undo').disabled`), true, 'Clear resets stroke history')
  phase = 'clear cancels late export'
  await stroke(0.5, 'clear')
  assertPixels(Buffer.from((await evaluate<string>(`document.querySelector('${canvasSelector}').toDataURL('image/png')`)).split(',')[1], 'base64'), false)
  phase = 'undo cancels late export'
  await stroke(0.5, 'undo')
  assertPixels(await canvasBytes(), false)
  assert.equal(await evaluate(`document.querySelector('.image-annotation-undo').disabled`), true)
  phase = 'marked Ctrl-drag and geometry'
  await click('[aria-label="Red marker"]')
  await stroke(0.3)
  await click('[aria-label="Blue marker"]')
  await stroke(0.7)
  await dragReference()
  assertPixels(await attachedBytes(), true)
  await assertReferencePresentation()
  await captureScreenshot('image-markup-desktop.png')
  phase = 'mobile reference geometry'
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await waitFor(`innerWidth === 390 && document.querySelector('.composer-box').getBoundingClientRect().right <= innerWidth + 1`)
  assert.equal(await evaluate(`(() => {
    const c = document.querySelector('${canvasSelector}').getBoundingClientRect();
    const composer = document.querySelector('.composer-box').getBoundingClientRect();
    return document.documentElement.scrollWidth <= innerWidth && c.width > 0 && c.left >= 0 && c.right <= innerWidth + 1
      && composer.left >= 0 && composer.bottom <= innerHeight + 1;
  })()`), true, 'Mobile canvas and persistent composer remain within the viewport')
  await assertReferencePresentation()
  await captureScreenshot('image-markup-mobile.png', true)
  window.webContents.disableDeviceEmulation()
  phase = 'external drop'
  await evaluate(`(async () => {
    const blob = await (await fetch(document.querySelector('.attachment-thumb').src)).blob();
    const data = new DataTransfer(); data.items.add(new File([blob], 'external.png', { type: 'image/png', lastModified: 42 }));
    document.querySelector('.composer-box').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  })()`)
  await waitFor(`document.querySelectorAll('.attachment-chip').length === 2`)
  await click('[aria-label="Remove external.png"]')
  phase = 'closing source and sending image only'
  const pending = await attachedBytes()
  const pendingUrl = await evaluate<string>(`document.querySelector('.attachment-thumb').src`)
  await click(`[aria-label="Close ${fileName}"]`)
  await waitFor(`!document.querySelector('${canvasSelector}') && document.querySelectorAll('.attachment-chip').length === 1`)
  assert.deepEqual(await attachedBytes(), pending, 'A completed pending annotation outlives the source tab')
  await assertSourcePath()
  assert.equal(await evaluate(`window.revokedImageUrls.includes(${JSON.stringify(pendingUrl)})`), false)
  assert.equal(uploads.length, 0)
  assert.equal(sends.length, 0)
  await click('.composer-send')
  await waitRequest(() => sends.length === 1, 'one image-only send')
  assert.equal(uploads.length, 1)
  assert.equal(uploads[0].chatId, chatId)
  assert.deepEqual(uploads[0].bytes, pending, 'Send uploads the marked File, not a URL or original placeholder')
  assertPixels(uploads[0].bytes, true)
  assert.equal(sends[0].chatId, chatId)
  assert.deepEqual(sends[0].media, [uploads[0].path])
  assert.equal(sends[0].content, [
    'Image references (source metadata):',
    `- Attached image: ${JSON.stringify(sends[0].media![0])}`,
    `  Original file: ${JSON.stringify(sourcePath)}`,
    '  Version: marked copy; original file unchanged.',
    '  Media item: 1 of 1 (message attachment order).',
  ].join('\n'), 'The delivered user message maps the actual uploaded media to its canonical original file')
  assert.doesNotMatch(sends[0].content, /blob:|sourceKey|application\/x-shadow-image-reference/, 'Provider-visible provenance contains no renderer-only references')
  phase = 'streaming disables drawing'
  await click(`.tree-row[data-path="${fileName}"]`)
  await waitFor(`document.querySelector('${canvasSelector}')?.width === ${width} && document.querySelector('[aria-label="Red marker"]').disabled`)
  const readonly = await evaluate<string>(`document.querySelector('${canvasSelector}').toDataURL('image/png')`)
  const point = await evaluate<{ x: number; y: number }>(`(() => {
    const r = document.querySelector('${canvasSelector}').getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`)
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  window.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftButtonDown'], x: point.x + 20, y: point.y })
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x + 20, y: point.y })
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  assert.equal(await evaluate(`document.querySelector('${canvasSelector}').toDataURL('image/png')`), readonly, 'Streaming disables actual canvas drawing')
  finishSend!()
  await waitFor(`document.querySelectorAll('.attachment-chip').length === 0`)
  await waitFor(`!document.querySelector('[aria-label="Red marker"]').disabled`)
  assert.equal(await evaluate(`window.revokedImageUrls.includes(${JSON.stringify(pendingUrl)})`), true)
  assert.equal(rawRequests, 2, 'Existing annotation and provenance flow keeps its two image reads')
  await imageSourceRecoveryRegression()
  await textEncodingRegression()
  assert.equal(rawRequests, 6, 'Additional image reads are only the two old-backend opens and retries')
  assert.deepEqual(original, originalSnapshot, 'Source bytes remain unchanged')
  assert.deepEqual(await readFile(sourcePath), originalSnapshot, 'The real original image on disk is never modified')
  assert.deepEqual(requests.filter(item => item.method !== 'GET').map(item => `${item.method} ${item.path}`), ['POST /api/chat/upload', 'POST /api/chat/send'], 'No source mutations, eager uploads, or extra session creation')
  assert.deepEqual(errors, [], 'Native client and server must have no fixture or production errors')
  console.log('LAYOUT_RESULT ' + JSON.stringify({ ok: true, fixture: 'image-annotation', rawRequests, uploads: uploads.length, sends: sends.length }))
}
main().catch(error => {
  console.error(error)
  console.log('LAYOUT_FAILURE ' + JSON.stringify({ phase, message: String(error), errors, requests: requests.slice(-15) }))
  process.exitCode = 1
}).finally(async () => {
  if (window && !window.isDestroyed()) {
    if (window.webContents.debugger.isAttached()) {
      await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {})
      window.webContents.debugger.detach()
    }
    window.webContents.disableDeviceEmulation()
    window.destroy()
  }
  server.closeAllConnections()
  server.close()
  app.exit(process.exitCode || 0)
})
