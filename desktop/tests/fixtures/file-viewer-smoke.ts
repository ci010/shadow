import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, session } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const origin = new URL(process.env.VIEWER_FIXTURE_URL!).origin
  const external: string[] = []
  const gisRequests: string[] = []
  let gisEnabled = false
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    const url = new URL(details.url)
    if (gisEnabled && details.url === 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css') {
      gisRequests.push(details.url)
      done({ redirectURL: `${origin}/__viewer/leaflet.css` })
      return
    }
    if (gisEnabled && /^https:\/\/[abc]\.tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/.test(details.url)) {
      gisRequests.push(details.url)
      done({ redirectURL: `${origin}/__viewer/tile.png` })
      return
    }
    const developmentSocket = url.protocol === 'ws:' && url.hostname === new URL(origin).hostname
    const allowed = developmentSocket || details.url.startsWith(`${origin}/`) || /^(?:blob:|data:|devtools:)/.test(details.url)
    if (!allowed) external.push(details.url)
    done({ cancel: !allowed })
  })
  session.defaultSession.webRequest.onBeforeSendHeaders((details, done) => {
    done({ requestHeaders: {
      ...details.requestHeaders,
      ...(details.resourceType === 'xhr' ? { 'X-Viewer-Fixture': 'authorized' } : {}),
    } })
  })
  const window = new BrowserWindow({ show: false, width: 1100, height: 740,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (code: string) => {
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      if (await execute(code)) return
      await delay(50)
    }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}`)
  }
  try {
    await window.loadURL(process.env.VIEWER_FIXTURE_URL!)
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('DOM.enable')
    await window.webContents.debugger.sendCommand('CSS.enable')
    await wait('!!window.viewerFixture')
    await execute(`if (document.documentElement.classList.contains('dark')) window.viewerFixture.toggleTheme()`)
    for (const [width, dark] of [[1100, false], [1100, true], [390, false], [390, true]] as const) {
      window.setContentSize(width, 740)
      await execute(`if (document.documentElement.classList.contains('dark') !== ${dark}) window.viewerFixture.toggleTheme()`)
      for (const [name, expression] of [
        ['report.pdf', `document.querySelector('.ofv-pdf-text-layer')?.textContent.includes('Synthetic PDF report')`],
        ['report.docx', `document.querySelector('.viewer-container')?.textContent.includes('Synthetic Word report')`],
        ['report.xlsx', `document.querySelector('.viewer-container')?.textContent.includes('Synthetic sheet cell')`],
        ['bundle.zip', `document.querySelector('.shadow-archive-source')?.textContent.includes('Synthetic archive entry')`],
        ['message.eml', `document.querySelector('.viewer-container')?.textContent.includes('Synthetic mail body')`],
        ['drawing.dxf', `!!document.querySelector('.ofv-svg-stage line')`],
        ['shape.excalidraw', `!!document.querySelector('.ofv-svg-stage')`],
        ['module.wasm', `document.querySelector('.viewer-container')?.textContent.includes('WASM')`],
        ['area.geojson', `!!document.querySelector('.leaflet-control-attribution') && !!document.querySelector('.ofv-map-feature')`],
      ]) {
        if (name === 'area.geojson') gisEnabled = true
        await execute(`window.viewerFixture.open(${JSON.stringify(name)})`)
        await wait(expression!)
        await wait(`document.querySelector('.file-viewer-preview')?.getAttribute('aria-busy') === 'false'`)
        const measurements = await execute(`(() => {
          const body = document.querySelector('.file-modal-body').getBoundingClientRect();
          const host = document.querySelector('.ofv-host').getBoundingClientRect();
          return { viewport: innerWidth, width: host.width, height: host.height,
            bodyWidth: body.width, pageWidth: document.documentElement.scrollWidth,
            error: document.querySelector('.viewer-notice')?.textContent };
        })()`)
        assert.ok(measurements.width > 100 && measurements.height > 200, `${name} must occupy a usable preview area: ${JSON.stringify(measurements)}`)
        assert.ok(measurements.width <= measurements.bodyWidth + 1, `${name} must stay within the file tab`)
        assert.ok(measurements.pageWidth <= measurements.viewport, `${name} must not overflow a narrow viewport`)
        assert.equal(measurements.error, undefined)
        await wait(`!!document.querySelector('.ofv-theme-${dark ? 'dark' : 'light'}')`)
        assert.equal(await execute(`(() => {
          const root = document.querySelector('.ofv-root');
          const style = getComputedStyle(root);
          return style.getPropertyValue('--ofv-text').trim() === style.getPropertyValue('--c-text').trim();
        })()`), true, 'The viewer inherits Shadow theme tokens')
        const { root: documentNode } = await window.webContents.debugger.sendCommand('DOM.getDocument')
        const { nodeId } = await window.webContents.debugger.sendCommand('DOM.querySelector', {
          nodeId: documentNode.nodeId, selector: '.ofv-toolbar-search input',
        })
        await window.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] })
        const controls = await execute(`(() => {
          const root = document.querySelector('.ofv-root');
          const token = name => getComputedStyle(root).getPropertyValue(name).trim();
          const color = name => { const probe = document.createElement('span'); probe.style.color = token(name); root.append(probe); const result = getComputedStyle(probe).color; probe.remove(); return result; };
          const input = root.querySelector('.ofv-toolbar-search input');
          const button = root.querySelector('.ofv-toolbar button');
          if (!input || !button) throw new Error('Missing reader controls: ' + root.innerHTML.slice(0, 1000));
          const style = getComputedStyle(input);
          const surface = root.querySelector('.ofv-pdf');
          return { radius: style.borderRadius, shadow: style.boxShadow,
            border: style.borderTopColor, expectedBorder: color('--c-control-border'),
            background: style.backgroundColor, expectedBackground: color('--c-bg-input'),
            focus: style.outlineColor, expectedFocus: color('--c-blue'),
            buttonRadius: getComputedStyle(button).borderRadius, buttonHeight: button.getBoundingClientRect().height,
            paper: root.querySelector('.ofv-pdf-page') ? getComputedStyle(root.querySelector('.ofv-pdf-page')).backgroundColor : null,
            documentShadow: root.querySelector('section.ofv-docx') ? getComputedStyle(root.querySelector('section.ofv-docx')).boxShadow : null,
            mapGlow: root.querySelector('.ofv-map-feature') ? getComputedStyle(root.querySelector('.ofv-map-feature')).filter : null,
            mapShadow: root.querySelector('.leaflet-bar') ? getComputedStyle(root.querySelector('.leaflet-bar')).boxShadow : null,
            canvas: surface ? getComputedStyle(surface).backgroundColor : null, expectedCanvas: color('--c-bg'),
            notice: !!document.querySelector('.viewer-network-notice') };
        })()`)
        assert.equal(controls.radius, '0px', `${name}: square search input`)
        assert.equal(controls.shadow, 'none', `${name}: flat focus treatment`)
        assert.equal(controls.border, controls.expectedBorder)
        assert.equal(controls.background, controls.expectedBackground)
        assert.equal(controls.focus, controls.expectedFocus, `${name}: focus treatment ${JSON.stringify(controls)}`)
        assert.equal(controls.buttonRadius, '0px')
        assert.ok(controls.buttonHeight >= (width === 390 ? 44 : 32))
        if (controls.paper) assert.equal(controls.paper, 'rgb(255, 255, 255)', 'PDF pages retain their authored white background')
        if (controls.documentShadow) assert.equal(controls.documentShadow, 'none', 'Document frames use flat Shadow chrome')
        if (controls.mapGlow) assert.equal(controls.mapGlow, 'none', 'Map geometry has no decorative glow')
        if (controls.mapShadow) assert.equal(controls.mapShadow, 'none', 'Map controls use flat Shadow chrome')
        if (controls.canvas) assert.equal(controls.canvas, controls.expectedCanvas, 'PDF reader background follows the app theme')
        assert.equal(controls.notice, name === 'area.geojson')
        if (process.env.VIEWER_SCREENSHOTS) {
          await delay(150)
          await mkdir(process.env.VIEWER_SCREENSHOTS, { recursive: true })
          await writeFile(join(process.env.VIEWER_SCREENSHOTS, `viewer-${name}-${width}-${dark ? 'dark' : 'light'}.png`),
            (await window.webContents.capturePage()).toPNG())
      }
      if (name === 'bundle.zip') {
        await execute(`Array.from(document.querySelectorAll('.ofv-archive-item')).find(row => row.textContent.includes('icon.svg')).click()`)
        await wait(`document.querySelector('.shadow-archive-media')?.complete && document.querySelector('.shadow-archive-media')?.naturalWidth > 0`)
        await execute(`(() => {
          const imageUrl = document.querySelector('.shadow-archive-media').src;
          const revoke = URL.revokeObjectURL.bind(URL);
          window.archiveImageRevoked = false;
          URL.revokeObjectURL = url => { if (url === imageUrl) window.archiveImageRevoked = true; revoke(url); };
          Array.from(document.querySelectorAll('.ofv-archive-item')).find(row => row.textContent.includes('large.txt')).click();
        })()`)
        await wait(`document.querySelector('.shadow-archive-note')?.textContent.includes('truncated')`)
        assert.equal(await execute(`document.querySelector('.shadow-archive-source').textContent.length`), 65536)
        assert.equal(await execute(`!!window.unsafeArchiveEntry`), false, 'Archive HTML is displayed as inert source')
        assert.equal(await execute(`window.archiveImageRevoked`), true, 'Changing archive entries revokes the native preview URL')
      }
      }
    }
    await execute(`window.viewerFixture.open('offline.docx')`)
    await wait(`document.querySelector('.node-offline-state')?.textContent.includes('Node offline') || document.body.textContent.includes('Node offline')`)
    await execute(`window.viewerFixture.open('denied.docx')`)
    await wait(`document.querySelector('.viewer-notice')?.textContent.includes('denied')`)
    assert.equal(await execute(`!!document.querySelector('.viewer-retry')`), true)
    await execute(`window.viewerFixture.open('report.pdf')`)
    await wait(`document.querySelector('.ofv-pdf-text-layer')?.textContent.includes('Synthetic PDF report')`)
    await execute('window.viewerFixture.pause()')
    await wait(`!document.querySelector('.ofv-host')`)
    assert(gisRequests.some(url => url.includes('leaflet.css')), 'GIS uses the explicitly authorized stylesheet service')
    assert(gisRequests.some(url => url.includes('tile.openstreetmap.org')), 'GIS uses the explicitly authorized tile service')
    assert.deepEqual(external, [], 'No external service is used outside the explicitly authorized GIS resources')
    console.log('FILE_VIEWER_SMOKE_OK')
  } finally { window.destroy() }
}
void main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
