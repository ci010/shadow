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
    for (const dark of [false, true]) {
      for (const width of [1100, 390]) {
        window.setContentSize(width, 844)
        await execute(`document.documentElement.classList.toggle('dark', ${dark})`)
        await delay(100)
        assert.equal(await execute(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true)
        assert.equal(await execute(`Array.from(document.querySelectorAll('.message-attachment')).every(el => el.getBoundingClientRect().right <= innerWidth)`), true)
        if (process.env.MEDIA_SCREENSHOTS) {
          await mkdir(process.env.MEDIA_SCREENSHOTS, { recursive: true })
          await writeFile(join(process.env.MEDIA_SCREENSHOTS, `attachments-${dark ? 'dark' : 'light'}-${width}.png`), (await window.webContents.capturePage()).toPNG())
        }
      }
    }
    await execute(`document.querySelector('video').dispatchEvent(new Event('error'))`)
    await wait(`document.querySelector('[role="status"]')?.textContent.includes('Download')`)
    assert.equal(await execute(`!!document.querySelector('[aria-label="Download clip.webm"]')`), true)
    assert.equal(await execute(`document.body.innerText.includes('[file:')`), false)
    console.log('MEDIA_SMOKE_OK')
  } finally { window.destroy() }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
