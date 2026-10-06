import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({
    show: false, width: 1000, height: 800,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  })
  const errors: string[] = []
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 2) errors.push(message) })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (code: string) => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (await execute(code)) return
      await delay(50)
    }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}\n${errors.join('\n')}`)
  }
  const selection = () => execute('window.getSelection().toString()')
  async function drag(selector: string): Promise<string> {
    const bounds = await execute(`(() => {
      document.activeElement?.blur(); window.getSelection().removeAllRanges();
      const element=document.querySelector(${JSON.stringify(selector)});
      element.scrollIntoView({block:'center'});
      const range=document.createRange(); range.selectNodeContents(element);
      const rect=range.getBoundingClientRect();
      return {x:Math.ceil(rect.left),y:Math.round(rect.top+rect.height/2),end:Math.floor(rect.right)};
    })()`)
    window.webContents.sendInputEvent({ type: 'mouseMove', x: bounds.x, y: bounds.y })
    window.webContents.sendInputEvent({ type: 'mouseDown', x: bounds.x, y: bounds.y, button: 'left', clickCount: 1 })
    for (let step = 1; step <= 8; step++) {
      window.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(bounds.x + (bounds.end - bounds.x) * step / 8), y: bounds.y, modifiers: ['leftButtonDown'] })
    }
    window.webContents.sendInputEvent({ type: 'mouseUp', x: bounds.end, y: bounds.y, button: 'left', clickCount: 1 })
    await delay(50)
    return selection()
  }
  try {
    await window.loadURL(process.env.USER_SELECT_URL!)
    await wait(`document.querySelector('.io-table td') && document.querySelector('.payload-source .file-syntax-token')`)
    await execute(`{
      const tool=document.querySelector('.tool-def');
      if(tool instanceof HTMLDetailsElement) tool.open=true;
      else tool.click();
    }`)
    const selectable = [
      '#response', '#response strong', '#response a', '#stream span', '#definition-value code',
      '.payload-source .file-syntax-token', '.tool-def-desc-full', '.tool-def-param-desc',
      '.system-prompt-content strong', '.system-prompt-raw', '#document p', '#document pre code',
      '#diff pre span', '.memory-record-what', '.io-text', '.io-table td', '.copy-value',
      '#input', '#textarea', '#editor span',
    ]
    const chrome = [
      '#navigation', '#navigation-button span', '#status', '#chrome-code', '#definition-label',
      '#content-button span', '#disclosure span', '.tool-def-name', '.copy-btn span',
      '#diff .select-none', '#thumbnail pre', '.io-text + .io-table + button', '#readonly',
    ]
    for (const width of [1000, 390]) {
      window.setContentSize(width, 800)
      await wait(`Math.abs(innerWidth-${width})<=2`)
      for (const [selectors, expected] of [[selectable, 'text'], [chrome, 'none']] as const) {
        const actual = await execute(`(${JSON.stringify(selectors)}).map(selector => {
          const element=document.querySelector(selector);
          if(!element) throw new Error('Missing '+selector);
          return {selector,selection:getComputedStyle(element).userSelect,webkit:getComputedStyle(element).webkitUserSelect};
        })`)
        for (const item of actual) {
          assert.equal(item.selection, expected, `${width}: ${item.selector}`)
          assert.equal(item.webkit, expected, `${width}: prefixed ${item.selector}`)
        }
      }
      assert.equal(await drag('#navigation'), '', 'Navigation cannot be selected by dragging')
      assert.match(await drag('#response'), /Response bold and a readable link/, 'Markdown selection crosses inline nodes')
      assert.match(await drag('#stream span'), /Streaming response/)
      assert.match(await drag('.io-text'), /Readable generated output/)
      assert.match(await drag('.copy-value'), /synthetic-session-id/)
    }
    window.setContentSize(1000, 800)
    await drag('#response')
    await wait(`!!document.querySelector('.selection-menu')`)
    await execute(`Array.from(document.querySelectorAll('.selection-menu button')).find(button=>button.textContent.includes('Copy')).click()`)
    await wait(`!document.querySelector('.selection-menu')`)
    assert.match(await execute(`window.__selectionFixture.copied`), /Response bold/, 'Copy selection uses the selected content')
    const quoted = await drag('#response')
    await wait(`!!document.querySelector('.selection-menu')`)
    await execute(`Array.from(document.querySelectorAll('.selection-menu button')).find(button=>button.textContent.includes('Quote')).click()`)
    assert.equal(await execute(`window.__selectionFixture.quoted`), quoted)
    for (const selector of ['#input', '#textarea']) {
      assert.equal(await execute(`(() => {
        const input=document.querySelector('${selector}');input.focus();input.select();
        return input.value.slice(input.selectionStart,input.selectionEnd);
      })()`), selector === '#input' ? 'Editable input' : 'Editable composer')
    }
    assert.equal(await drag('#editor span'), 'Editable rich text')
    await execute(`document.querySelector('#editor').focus()`)
    window.webContents.insertText('Replacement text')
    await wait(`document.querySelector('#editor').textContent === 'Replacement text'`)
    console.log('USER_SELECT_OK')
  } finally {
    window.destroy()
  }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
