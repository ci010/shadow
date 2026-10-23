import assert from 'node:assert/strict'
import { once } from 'node:events'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1100, height: 800,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const errors: string[] = []
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 2) errors.push(message) })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (code: string) => {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(50) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}\n${errors.join('\n')}`)
  }
  const ready = () => wait(`document.querySelector('textarea[aria-label="Message"]') && !document.body.textContent.includes('Loading conversation')`)
  const reload = async () => {
    const loaded = once(window.webContents, 'did-finish-load')
    window.webContents.reload()
    await loaded
    await ready()
    await delay(250)
  }
  const input = async (text: string) => {
    await execute(`{ const input = document.querySelector('textarea[aria-label="Message"]'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', {bubbles:true})); }`)
  }
  const conversation = () => execute(`document.querySelector('.conversation-tab [role="tab"]').click()`)
  const promptSelected = () => wait(`document.querySelector('.diagnosis-tab [role="tab"]')?.getAttribute('aria-selected') === 'true' && document.querySelector('[id$="diagnosis-prompt-tab"]')?.getAttribute('aria-selected') === 'true'`)
  try {
    await window.loadURL(new URL('projects/a/chat/web%3Achat-one', process.env.PERSISTENCE_URL).href)
    await ready()
    await wait(`!!document.querySelector('a[href="layout.html"]')`)
    await execute(`document.querySelector('a[href="layout.html"]').click()`)
    await wait(`!!document.querySelector('.file-modal-body.html-preview iframe')`)
    const checkPreviewEdges = async () => {
      await wait(`(() => {
        const frame = document.querySelector('.file-modal-frame')?.getBoundingClientRect();
        const modal = document.querySelector('.file-modal.inline')?.getBoundingClientRect();
        const header = document.querySelector('.file-modal-header')?.getBoundingClientRect();
        const composer = document.querySelector('.conversation-dock')?.getBoundingClientRect();
        return frame && modal && header && composer && frame.height > 0
          && Math.abs(frame.left - modal.left) < 1 && Math.abs(frame.right - modal.right) < 1
          && Math.abs(frame.top - header.bottom) < 1 && Math.abs(frame.bottom - composer.top) < 1;
      })()`)
      assert.equal(await execute(`document.querySelector('.file-modal-frame').getAttribute('sandbox')`), 'allow-scripts allow-forms allow-popups')
    }
    for (const [width, height] of [[1100, 800], [600, 650], [1100, 420]]) {
      window.setContentSize(width, height)
      await checkPreviewEdges()
    }
    await input('Multiline preview draft\nSecond line\nThird line\nFourth line')
    await checkPreviewEdges()
    await execute(`Array.from(document.querySelectorAll('.file-modal-btn')).find(button => button.textContent === 'Source').click()`)
    await wait(`!!document.querySelector('.file-modal-text')`)
    assert.equal(await execute(`getComputedStyle(document.querySelector('.file-modal-body')).paddingLeft`), '24px')
    await execute(`Array.from(document.querySelectorAll('.file-modal-btn')).find(button => button.textContent === 'Preview').click()`)
    await checkPreviewEdges()
    window.setContentSize(1100, 800)
    await conversation()
    await input('Unsent draft\nSecond line')
    await reload()
    assert.equal(await execute(`document.querySelector('textarea').value`), 'Unsent draft\nSecond line')
    await execute(`window.__composerBeforeSettings = document.querySelector('textarea[aria-label="Message"]')`)
    await execute(`window.__navigate('/projects/a/settings/general')`)
    await wait(`document.querySelector('.project-settings-view input')?.value === 'Project A'`)
    for (const [width, height] of [[1100, 800], [600, 650]]) {
      window.setContentSize(width, height)
      await wait(`(() => {
        const dock = document.querySelector('.conversation-dock');
        const workbench = document.querySelector('.file-workbench');
        const settings = document.querySelector('.project-settings-view');
        return dock && !dock.getClientRects().length && settings?.getClientRects().length
          && getComputedStyle(workbench).getPropertyValue('--composer-height').trim() === '0px';
      })()`)
      assert.equal(await execute(`document.querySelector('textarea[aria-label="Message"]') === window.__composerBeforeSettings`), true)
      assert.equal(await execute(`window.__composerBeforeSettings.value`), 'Unsent draft\nSecond line')
    }
    window.setContentSize(1100, 800)
    await execute(`window.__navigate('/projects/a/chat/web%3Achat-one')`)
    await wait(`document.querySelector('.conversation-dock')?.getClientRects().length > 0`)
    assert.equal(await execute(`document.querySelector('textarea[aria-label="Message"]') === window.__composerBeforeSettings`), true)
    assert.equal(await execute(`window.__composerBeforeSettings.value`), 'Unsent draft\nSecond line')
    await execute(`document.querySelector('.diagnosis-tab [role="tab"]').click()`)
    await wait(`!!document.querySelector('[id$="diagnosis-prompt-tab"]')`)
    await execute(`document.querySelector('[id$="diagnosis-prompt-tab"]').click()`)
    await wait(`new URL(location.href).searchParams.get('diagnosis') === 'prompt'`)
    await reload()
    await promptSelected()
    await wait(`document.querySelector('.context-view')?.textContent.includes('Synthetic persisted system prompt')`)
    await execute(`document.querySelector('[id$="diagnosis-tools-tab"]').click()`)
    await wait(`new URL(location.href).searchParams.get('diagnosis') === 'tools'`)
    await reload()
    await wait(`document.querySelector('[id$="diagnosis-tools-tab"]')?.getAttribute('aria-selected') === 'true'`)
    await execute(`window.__navigate('/projects/a/chat/web%3Achat-one?panel=knowledge')`)
    await wait(`document.querySelector('.document-tab [aria-controls*="knowledge"]')?.getAttribute('aria-selected') === 'true'`)
    await execute(`document.querySelector('.diagnosis-tab [role="tab"]').click()`)
    await wait(`new URL(location.href).searchParams.get('panel') === 'diagnosis'`)
    await conversation()
    await wait(`!new URL(location.href).searchParams.has('panel')`)
    assert.equal(await execute(`document.querySelector('textarea').value`), 'Unsent draft\nSecond line')
    await execute(`window.__navigate('/projects/a/chat/web%3Achat-two')`)
    await ready()
    assert.equal(await execute(`document.querySelector('textarea').value`), '')
    await input('Draft two')
    await execute(`window.__navigate('/projects/a/chat/web%3Achat-one?panel=diagnosis&diagnosis=prompt')`)
    await promptSelected()
    await conversation()
    assert.equal(await execute(`document.querySelector('textarea').value`), 'Unsent draft\nSecond line')
    await execute(`fetch('/fixture-reject?value=true')`)
    await execute(`document.querySelector('[aria-label="Send message"]').click()`)
    await wait(`document.querySelector('.composer-error')?.textContent.includes('503')`)
    await reload()
    assert.equal(await execute(`document.querySelector('textarea').value`), 'Unsent draft\nSecond line')
    await execute(`fetch('/fixture-reject?value=false')`)
    await execute(`document.querySelector('[aria-label="Send message"]').click()`)
    await wait(`document.querySelector('textarea').value === ''`)
    await reload()
    assert.equal(await execute(`document.querySelector('textarea').value`), '')
    await execute(`window.__navigate('/projects/a/chat/web%3Achat-two')`)
    await ready()
    assert.equal(await execute(`document.querySelector('textarea').value`), 'Draft two')
    await execute(`window.__navigate('/projects/a/chat')`)
    await ready()
    await input('New conversation draft')
    await reload()
    assert.equal(await execute(`document.querySelector('textarea').value`), 'New conversation draft')
    assert.ok(!errors.some(error => error.includes('Unhandled error')), errors.join('\n'))
    console.log('PERSISTENCE_SMOKE_OK')
  } finally { window.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
