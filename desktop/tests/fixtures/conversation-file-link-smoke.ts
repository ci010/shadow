import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1100, height: 700,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  window.webContents.session.webRequest.onBeforeSendHeaders({ urls: [new URL('*', process.env.FILE_LINK_URL).href] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders,
      ...(details.webContentsId === window.webContents.id && details.resourceType === 'xhr' ? { 'X-Fixture-Renderer': 'allowed' } : {}),
    } })
  })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (code: string) => {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(50) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}`)
  }
  try {
    await window.loadURL(new URL('__file-links', process.env.FILE_LINK_URL).href)
    await wait(`!!document.querySelector('.fixture-message a') && !!document.querySelector('[data-path="reports"]')`)
    const originalUrl = window.webContents.getURL()
    await execute(`document.querySelector('[aria-label="Toggle files"]').click()`)
    await execute(`document.querySelector('.fixture-message a').click()`)
    await wait(`document.querySelector('.file-markdown')?.textContent.includes('Preview reports/daily/REPORT.md')`)
    await wait(`document.querySelector('[data-path="reports/daily/REPORT.md"]')?.getAttribute('aria-current') === 'page'`)
    assert.equal(await execute(`document.querySelector('[aria-label="Toggle files"]').getAttribute('aria-expanded')`), 'true')
    assert.equal(await execute(`(() => {
      const row = document.querySelector('[data-path="reports/daily/REPORT.md"]').getBoundingClientRect();
      const body = document.querySelector('.file-tree-body').getBoundingClientRect();
      return row.top >= body.top && row.bottom <= body.bottom;
    })()`), true, 'The selected nested file is scrolled into the tree viewport')
    assert.equal(await execute(`document.querySelectorAll('.document-tabs [role="tab"]').length`), 1)
    const download = Promise.withResolvers<string>()
    window.webContents.session.once('will-download', (_event, item) => {
      assert.equal(item.getFilename(), 'REPORT.md')
      assert.ok(item.getURL().startsWith('blob:'), 'Raw files must be fetched with renderer authorization')
      item.setSavePath(join(process.cwd(), 'REPORT.md'))
      item.once('done', (_event, state) => download.resolve(state))
    })
    await execute(`document.querySelector('[aria-label="Download REPORT.md"]').click()`)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      assert.equal(await Promise.race([download.promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Preview download did not complete')), 10_000)
      })]), 'completed')
    } finally { clearTimeout(timer) }
    assert.equal(await readFile(join(process.cwd(), 'REPORT.md'), 'utf8'), '# Downloaded reports/daily/REPORT.md')
    assert.equal(await execute(`document.body.textContent.includes('Open raw')`), false)
    const conversation = `document.querySelector('.conversation-tab [role="tab"]').click()`
    await execute(conversation)
    await execute(`document.querySelector('.fixture-message a').click()`)
    assert.equal(await execute(`document.querySelectorAll('.document-tabs [role="tab"]').length`), 1, 'Repeated links reuse the preview tab')
    await execute(conversation)
    await execute(`document.querySelector('a[href="unlisted.md"]').click()`)
    await wait(`Array.from(document.querySelectorAll('.file-markdown')).some(el => el.textContent.includes('Preview unlisted.md'))`)
    assert.equal(await execute(`!!document.querySelector('[data-path="unlisted.md"]')`), false, 'A file absent from the tree still previews')
    await execute(conversation)
    await execute(`document.querySelector('a[href="missing.md"]').click()`)
    await wait(`!!document.querySelector('.file-modal-note[role="alert"]')`)
    await execute(`document.querySelector('[aria-label="Download missing.md"]').click()`)
    await wait(`document.querySelector('.file-download-error')?.textContent.includes('404')`)
    assert.equal(await execute(`document.querySelector('[aria-label="Download missing.md"]').getAttribute('aria-busy')`), 'false')
    assert.equal(window.webContents.getURL(), originalUrl)
    await execute(conversation)
    for (const [selector, modified] of [['a[href^="https:"]', false], ['a[href="unlisted.md"]', true]] as const) {
      assert.equal(await execute(`(() => {
        let intercepted;
        document.addEventListener('click', e => { intercepted = e.defaultPrevented; e.preventDefault() }, {once:true});
        document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true,ctrlKey:${modified}}));
        return intercepted;
      })()`), false)
    }
    window.setContentSize(390, 700)
    await delay(150)
    await execute(`document.querySelector('.fixture-message a').click()`)
    await wait(`document.querySelector('[aria-label="Toggle files"]').getAttribute('aria-expanded') === 'false'`)
    assert.equal(await execute(`!!document.querySelector('.explorer-backdrop')`), false)
    assert.equal(window.webContents.getURL(), originalUrl)
    console.log('FILE_LINK_SMOKE_OK')
  } finally { window.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
