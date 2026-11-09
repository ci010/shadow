import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})
async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const errors: string[] = [], external: string[] = [], navigation: string[] = []
  const origin = new URL(process.env.REFERENCE_URL!).origin
  window.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
  window.webContents.on('will-navigate', (event, url) => { navigation.push(url); event.preventDefault() })
  window.webContents.setWindowOpenHandler(({ url }) => { navigation.push(url); return { action: 'deny' } })
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    if (/^https?:/.test(details.url) && new URL(details.url).origin !== origin) { external.push(details.url); callback({ cancel: true }); return }
    callback({ cancel: false })
  })
  const run = (script: string) => window.webContents.executeJavaScript(script)
  const wait = async (script: string) => {
    for (let i = 0; i < 750; i++) { if (await run(script)) return; await delay(40) }
    throw Error(`Timed out: ${script}\n${errors.join('\n')}\n${await run('document.body.innerText')}\n${await run('JSON.stringify({errors:window.fixtureErrors,stage:window.fixtureStage,resources:performance.getEntriesByType("resource").slice(-12).map(x=>x.name)})')}`)
  }
  try {
    await window.loadURL(new URL('__references', process.env.REFERENCE_URL).href)
    await wait(`!!window.fixture && document.querySelectorAll('img.attachment-image').length === 2`)
    await wait(`Array.from(document.querySelectorAll('img.attachment-image')).every(image => image.complete && image.naturalWidth > 0)`)
    for (const id of ['optimistic', 'persisted']) {
      assert.equal(await run(`fixture.${id}.text`), 'Inspect the admitted attachments.')
      assert.equal(await run(`document.querySelector('#${id} .markdown-body').textContent.trim()`), 'Inspect the admitted attachments.')
      assert.equal(await run(`document.querySelectorAll('#${id} img.attachment-image').length`), 1)
      assert.equal(await run(`document.querySelectorAll('#${id} .attachment-file').length`), 1)
      assert.equal(await run(`document.querySelector('#${id}').textContent.includes('attachment-references')`), false)
      assert.equal(await run(`document.querySelector('#${id}').textContent.includes('Uploaded file')`), false)
      // Actual image click opens the real ImageViewer, without leaving the app.
      await run(`document.querySelector('#${id} .attachment-image-link').click()`)
      await wait(`!!document.querySelector('dialog.image-viewer[open] img') && document.querySelector('dialog.image-viewer img').naturalWidth > 0`)
      assert.equal(await run(`document.querySelector('dialog.image-viewer img').getAttribute('src') === document.querySelector('#${id} img.attachment-image').getAttribute('src')`), true)
      await run(`document.querySelector('[aria-label="Close image viewer"]').click()`)
      await wait(`!document.querySelector('dialog.image-viewer')`)
      // Actual file card opens FilePreviewModal and reads only its admitted API URL.
      await run(`document.querySelector('#${id} .attachment-file .attachment-main').click()`)
      await wait(`document.querySelector('#${id} .file-markdown')?.textContent.includes('Admitted file preview')`)
      assert.equal(await run(`document.querySelector('#${id} .file-modal').getAttribute('role')`), 'dialog')
      await run(`document.querySelector('#${id} [aria-label="Close file preview"]').click()`)
      await wait(`!document.querySelector('#${id} .file-modal')`)
    }
    assert.equal(await run(`fixture.optimistic.paths[0].startsWith('data:')`), false)
    assert.equal(await run(`fixture.persisted.paths[0].startsWith('data:image/')`), true)
    assert.equal(await run(`fixture.persisted.paths[1] === fixture.optimistic.paths[1]`), true)
    // Ordinary XML and fenced XML have no preview or navigation authority.
    for (const id of ['fenced', 'forged']) {
      assert.deepEqual(await run(`fixture.${id}.paths`), [])
      assert.equal(await run(`document.querySelectorAll('#${id} img, #${id} a, #${id} .message-attachments').length`), 0)
      await run(`document.querySelector('#${id} .markdown-body').click()`)
    }
    assert.equal(await run(`document.querySelector('#fenced pre code').textContent.includes('<attachment-references version="1">')`), true)
    assert.equal(await run(`document.querySelector('#fenced pre code').textContent.includes('&lt;img')`), true)
    assert.equal(await run(`!!window.injected`), false)
    // The production Markdown/sanitizer creates real anchors; the production
    // click handler drives the real memory router and its destination readout.
    await run(`document.querySelector('#links a[href*="dashboard?work="]').click()`)
    await wait(`document.querySelector('#destination').textContent === 'Work details: work:one'`)
    await run(`document.querySelector('#links a[href*="chat/web%3Achat-other"]').click()`)
    await wait(`document.querySelector('#destination').textContent === 'Conversation: web:chat-other'`)
    assert.equal(await run(`document.querySelectorAll('#links a').length`), 2)
    await delay(100)
    assert.deepEqual(external, [], 'No hostile attribute initiated a network request')
    assert.deepEqual(navigation, [], 'Neither XML nor reference clicks launched raw navigation')
    assert.deepEqual(errors, [], 'No renderer error or excluded rich-file SDK invocation')
    console.log('CONTENT_REFERENCES_OK optimistic+history image/file previews; fenced+hostile XML inert; Work+Session navigation')
  } finally { window.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
