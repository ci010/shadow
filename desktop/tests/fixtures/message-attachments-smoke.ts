import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1100, height: 844,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (code: string) => {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(50) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}`)
  }
  try {
    await window.loadURL(new URL('__media', process.env.MEDIA_SMOKE_URL).href)
    await wait(`document.querySelector('video') && document.querySelector('img')?.naturalWidth > 0`)
    assert.equal(await execute(`document.querySelector('video').preload`), 'none')
    assert.equal(await execute(`fetch('/fixture-count').then(r => r.text())`), '0', 'Video bytes must not be fetched until playback')
    assert.equal(await execute(`document.querySelector('video').autoplay`), false)
    assert.equal(await execute(`document.querySelector('video').controls && document.querySelector('video').playsInline`), true)
    await execute(`(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const ctx = canvas.getContext('2d'); const stream = canvas.captureStream(12);
      const chunks = []; const recorder = new MediaRecorder(stream, {mimeType:'video/webm;codecs=vp8'});
      const done = new Promise(resolve => { recorder.onstop = resolve });
      recorder.ondataavailable = e => chunks.push(e.data); recorder.start();
      for (let i = 0; i < 12; i++) {
        ctx.fillStyle = i % 2 ? '#245a75' : '#214451'; ctx.fillRect(0, 0, 320, 180);
        ctx.fillStyle = '#fff'; ctx.font = '20px sans-serif'; ctx.fillText('Video attachment', 65, 95);
        await new Promise(resolve => setTimeout(resolve, 80));
      }
      recorder.stop(); await done; stream.getTracks().forEach(track => track.stop());
      const response = await fetch('/fixture-video', {method:'POST',body:new Blob(chunks,{type:'video/webm'})});
      if (!response.ok) throw new Error('Could not prepare synthetic video');
      await document.querySelector('video').play();
    })()`)
    await wait(`document.querySelector('video')?.currentTime > 0 && document.querySelector('video')?.videoWidth === 320`)
    await execute(`document.querySelector('video').pause()`)
    const download = Promise.withResolvers<string>()
    window.webContents.session.once('will-download', (_event, item) => {
      assert.equal(item.getFilename(), 'logs.zip')
      item.setSavePath(join(process.cwd(), 'download.zip'))
      item.once('done', (_event, state) => download.resolve(state))
    })
    await execute(`document.querySelector('[aria-label="Download logs.zip"]').click()`)
    assert.equal(await download.promise, 'completed')
    assert.equal(await readFile(join(process.cwd(), 'download.zip'), 'utf8'), 'synthetic archive bytes')
    const originalUrl = window.webContents.getURL()
    let popups = 0
    window.webContents.setWindowOpenHandler(() => { popups++; return { action: 'deny' } })
    const openPhoto = async () => {
      await execute(`document.querySelector('.attachment-image-link').click()`)
      await wait(`document.querySelector('.image-viewer')?.matches(':modal') && document.querySelector('.image-viewer img')?.naturalWidth > 0`)
    }
    for (const dark of [false, true]) {
      for (const width of [1100, 390]) {
        window.setContentSize(width, 844)
        await execute(`document.documentElement.classList.toggle('dark', ${dark})`)
        await delay(100)
        assert.equal(await execute(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true)
        assert.equal(await execute(`Array.from(document.querySelectorAll('.message-attachment')).every(el => el.getBoundingClientRect().right <= innerWidth)`), true)
        const scroll = await execute('scrollY')
        await openPhoto()
        assert.equal(await execute(`document.activeElement?.getAttribute('aria-label')`), 'Close image viewer')
        assert.equal(await execute(`(() => {
          const r = document.querySelector('.image-viewer').getBoundingClientRect();
          return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
        })()`), true)
        assert.equal(await execute(`new URL(document.querySelector('.image-viewer a').href).searchParams.get('download')`), '1')
        assert.equal(await execute(`document.querySelector('.image-viewer img').src`), await execute(`document.querySelector('img.attachment-image').src`))
        assert.equal(await execute(`document.querySelector('.attachment-image-link').focus(); document.activeElement?.getAttribute('aria-label')`), 'Close image viewer', 'Modal keeps background controls inert')
        if (process.env.MEDIA_SCREENSHOTS) {
          await mkdir(process.env.MEDIA_SCREENSHOTS, { recursive: true })
          await writeFile(join(process.env.MEDIA_SCREENSHOTS, `attachments-${dark ? 'dark' : 'light'}-${width}.png`), (await window.webContents.capturePage()).toPNG())
        }
        await execute(`document.querySelector('[aria-label="Close image viewer"]').click()`)
        await wait(`!document.querySelector('.image-viewer')`)
        assert.equal(await execute(`document.activeElement === document.querySelector('.attachment-image-link')`), true)
        assert.equal(await execute('scrollY'), scroll)
      }
    }
    await openPhoto()
    window.webContents.sendInputEvent({type:'keyDown', keyCode:'Escape'})
    window.webContents.sendInputEvent({type:'keyUp', keyCode:'Escape'})
    await wait(`!document.querySelector('.image-viewer')`)
    await openPhoto()
    await execute(`{
      const dialog = document.querySelector('.image-viewer');
      const r = dialog.getBoundingClientRect();
      dialog.querySelector('img').dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}));
      dialog.dispatchEvent(new MouseEvent('click', {bubbles:true, clientX:r.left - 2, clientY:r.top - 2}));
    }`)
    assert.equal(await execute(`document.querySelector('.image-viewer')?.matches(':modal')`), true, 'Dragging from the image to the backdrop does not dismiss the viewer')
    await execute(`{
      const dialog = document.querySelector('.image-viewer');
      const r = dialog.getBoundingClientRect();
      const init = {bubbles:true, clientX:r.left - 2, clientY:r.top - 2};
      dialog.dispatchEvent(new PointerEvent('pointerdown', init));
      dialog.dispatchEvent(new MouseEvent('click', init));
    }`)
    await wait(`!document.querySelector('.image-viewer')`)
    await execute(`{
      const canvas = document.createElement('canvas'); canvas.width = 2400; canvas.height = 1600;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#245bc1'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      window.__largeImage = canvas.toDataURL();
      window.__imageFixture.markdown('![Large screenshot](' + window.__largeImage + ')');
    }`)
    await wait(`document.querySelector('.fixture-markdown img')?.naturalWidth === 2400`)
    const openMarkdown = async (key: string) => {
      await execute(`{ const image = document.querySelector('.fixture-markdown [data-image-preview]'); image.focus(); image.dispatchEvent(new KeyboardEvent('keydown', {key:${JSON.stringify(key)}, bubbles:true, cancelable:true})); }`)
      await wait(`document.querySelector('.image-viewer')?.matches(':modal') && document.querySelector('.image-viewer img')?.naturalWidth === 2400`)
    }
    for (const key of ['Enter', ' ']) {
      window.setBounds({width:key === 'Enter' ? 1100 : 390, height:700})
      await delay(50)
      await openMarkdown(key)
      assert.equal(await execute(`(() => {
        const image = document.querySelector('.image-viewer img').getBoundingClientRect();
        const viewport = document.querySelector('.image-viewer-viewport').getBoundingClientRect();
        return image.width < 2400 && image.left >= viewport.left && image.right <= viewport.right && image.top >= viewport.top && image.bottom <= viewport.bottom;
      })()`), true, 'Large images fit completely inside the viewing area')
      await execute(`document.querySelector('[aria-label="View image at actual size"]').click()`)
      await wait(`document.querySelector('.image-viewer img').getBoundingClientRect().width === 2400`)
      assert.equal(await execute(`document.querySelector('.image-viewer-viewport').scrollWidth > document.querySelector('.image-viewer-viewport').clientWidth`), true)
      await execute(`document.querySelector('[aria-label="Fit image to window"]').click()`)
      await wait(`document.querySelector('.image-viewer img').getBoundingClientRect().width < 2400`)
      await execute(`document.querySelector('[aria-label="Close image viewer"]').click()`)
      await wait(`!document.querySelector('.image-viewer')`)
      assert.equal(await execute(`document.activeElement === document.querySelector('.fixture-markdown img')`), true)
    }
    await execute(`window.__imageFixture.markdown('[![Linked screenshot](' + window.__largeImage + ')](https://example.invalid/image)')`)
    await wait(`!!document.querySelector('.fixture-markdown a[data-image-preview]')`)
    assert.equal(await execute(`document.querySelector('.fixture-markdown img').hasAttribute('tabindex')`), false, 'Linked images have one keyboard stop')
    await execute(`document.querySelector('.fixture-markdown img').click()`)
    await wait(`document.querySelector('.image-viewer')?.matches(':modal')`)
    await execute(`window.__imageFixture.close()`)
    await wait(`!document.querySelector('.image-viewer')`)
    assert.equal(popups, 0)
    assert.equal(window.webContents.getURL(), originalUrl)
    await openMarkdown('Enter')
    await execute(`window.__imageFixture.close()`)
    await wait(`!document.querySelector('.image-viewer')`)
    assert.equal(await execute(`(() => {
      let intercepted;
      document.addEventListener('click', event => { intercepted = event.defaultPrevented; event.preventDefault(); }, {once:true});
      document.querySelector('.fixture-markdown img').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, ctrlKey:true}));
      return intercepted;
    })()`), false, 'Modified image clicks preserve normal link behavior')
    assert.equal(await execute(`!!document.querySelector('.image-viewer')`), false)
    await execute(`window.__imageFixture.markdown('[Text and ![image](' + window.__largeImage + ')](https://example.invalid/text)')`)
    await wait(`document.querySelector('.fixture-markdown a')?.textContent.includes('Text and')`)
    assert.equal(await execute(`!!document.querySelector('.fixture-markdown [data-image-preview]')`), false, 'Mixed text links retain their link semantics')
    await execute(`window.__imageFixture.openImage({src:location.origin + '/api/media?sessionId=qq:group-media-fixture&path=uploads/missing.png', name:'Missing image'})`)
    await wait(`document.querySelector('.image-viewer [role="alert"]')?.textContent.includes('Could not load')`)
    await execute(`document.querySelector('.image-viewer [role="alert"] button').click()`)
    await wait(`document.querySelector('.image-viewer [role="alert"]')?.textContent.includes('Could not load')`)
    await execute(`window.__imageFixture.openImage({src:window.__largeImage, name:'Recovered image'})`)
    await wait(`document.querySelector('.image-viewer img')?.naturalWidth === 2400 && !document.querySelector('.image-viewer [role="alert"]')`)
    await execute(`document.querySelector('[aria-label="Close image viewer"]').click()`)
    await wait(`!document.querySelector('.image-viewer')`)
    await execute(`document.querySelector('video').dispatchEvent(new Event('error'))`)
    await wait(`document.querySelector('[role="status"]')?.textContent.includes('Download')`)
    assert.equal(await execute(`!!document.querySelector('[aria-label="Download clip.webm"]')`), true)
    assert.equal(await execute(`document.body.innerText.includes('[file:')`), false)
    console.log('MEDIA_SMOKE_OK')
  } finally { window.destroy() }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
