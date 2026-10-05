import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
    await execute(`document.querySelector('.file-modal [aria-label="Download REPORT.md"]').click()`)
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
    const tabsBeforeAttachments = await execute(`document.querySelectorAll('.document-tabs [role="tab"]').length`)
    const attachmentDownload = Promise.withResolvers<string>()
    window.webContents.session.once('will-download', (_event, item) => {
      assert.equal(item.getFilename(), 'REPORT.md')
      assert.ok(item.getURL().startsWith('blob:'))
      item.setSavePath(join(process.cwd(), 'attachment-REPORT.md'))
      item.once('done', (_event, state) => attachmentDownload.resolve(state))
    })
    const downloadPoint = await execute(`(() => {
      const rect = document.querySelector('.attachment-download').getBoundingClientRect();
      return {x:Math.round(rect.x + rect.width / 2),y:Math.round(rect.y + rect.height / 2)};
    })()`)
    window.webContents.sendInputEvent({type:'mouseDown', button:'left', clickCount:1, ...downloadPoint})
    window.webContents.sendInputEvent({type:'mouseUp', button:'left', clickCount:1, ...downloadPoint})
    let attachmentTimer: ReturnType<typeof setTimeout> | undefined
    try {
      assert.equal(await Promise.race([attachmentDownload.promise, new Promise<never>((_resolve, reject) => {
        attachmentTimer = setTimeout(() => reject(new Error('Attachment download did not complete')), 10_000)
      })]), 'completed')
    } finally { clearTimeout(attachmentTimer) }
    assert.equal(await readFile(join(process.cwd(), 'attachment-REPORT.md'), 'utf8'), 'Attachment download')
    assert.equal(await execute(`document.querySelector('.conversation-tab [role="tab"]').getAttribute('aria-selected')`), 'true',
      'Download must not switch to a file tab')
    assert.equal(await execute(`document.querySelectorAll('.document-tabs [role="tab"]').length`), tabsBeforeAttachments)
    await execute(`document.querySelector('.attachment-name').click()`)
    await wait(`document.querySelector('[data-path="reports/daily/REPORT.md"]')?.getAttribute('aria-current') === 'page'`)
    assert.equal(await execute(`document.querySelectorAll('.document-tabs [role="tab"]').length`), tabsBeforeAttachments,
      'A MEDIA card and a Markdown link to the same file reuse the same tab')
    await execute(conversation)
    const cardPoint = await execute(`(() => {
      const rect = document.querySelectorAll('.attachment-details')[1].getBoundingClientRect();
      return {x:Math.round(rect.x + 4),y:Math.round(rect.y + 4)};
    })()`)
    window.webContents.sendInputEvent({type:'mouseDown', button:'left', clickCount:1, ...cardPoint})
    window.webContents.sendInputEvent({type:'mouseUp', button:'left', clickCount:1, ...cardPoint})
    await wait(`Array.from(document.querySelectorAll('.file-markdown')).some(el => el.textContent.includes('Preview review notes/自我介绍.md'))`)
    assert.equal(await execute(`document.querySelectorAll('.document-tabs [role="tab"]').length`), tabsBeforeAttachments + 1)
    for (const keyCode of ['Enter', 'Space']) {
      await execute(conversation)
      await execute(`document.querySelectorAll('.attachment-open')[1].focus()`)
      assert.equal(await execute(`document.activeElement?.getAttribute('aria-label')`), 'Open 自我介绍.md in tab')
      window.webContents.sendInputEvent({type:'keyDown', keyCode})
      window.webContents.sendInputEvent({type:'char', keyCode:keyCode === 'Space' ? ' ' : '\r'})
      window.webContents.sendInputEvent({type:'keyUp', keyCode})
      await wait(`document.querySelector('.conversation-tab [role="tab"]').getAttribute('aria-selected') === 'false'`)
      assert.equal(await execute(`document.querySelectorAll('.document-tabs [role="tab"]').length`), tabsBeforeAttachments + 1,
        'Keyboard activation reuses the file tab')
    }
    await execute(conversation)
    window.setContentSize(390, 700)
    await delay(150)
    await execute(`document.querySelector('.fixture-message a').click()`)
    await wait(`document.querySelector('[aria-label="Toggle files"]').getAttribute('aria-expanded') === 'false'`)
    assert.equal(await execute(`!!document.querySelector('.explorer-backdrop')`), false)
    await execute(conversation)
    assert.equal(await execute(`document.documentElement.scrollWidth <= innerWidth`), true, 'Attachment cards do not overflow narrow panes')
    await execute(`document.querySelectorAll('.attachment-open')[1].click()`)
    await wait(`document.querySelector('.conversation-tab [role="tab"]').getAttribute('aria-selected') === 'false'`)
    assert.equal(window.webContents.getURL(), originalUrl)
    if (process.env.FILE_LINK_SCREENSHOTS) {
      await mkdir(process.env.FILE_LINK_SCREENSHOTS, { recursive: true })
      await execute(conversation)
      for (const width of [1100, 390]) {
        window.setContentSize(width, 700)
        for (const dark of [false, true]) {
          await execute(`document.documentElement.classList.toggle('dark', ${dark})`)
          await delay(100)
          assert.equal(await execute(`document.documentElement.scrollWidth <= innerWidth`), true)
          await writeFile(join(process.env.FILE_LINK_SCREENSHOTS, `file-cards-${width}-${dark ? 'dark' : 'light'}.png`),
            (await window.webContents.capturePage()).toPNG())
        }
      }
    }
    console.log('FILE_LINK_SMOKE_OK')
  } finally { window.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
