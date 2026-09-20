import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({
    show: false, width: 1200, height: 900,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (code: string) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (await execute(code)) return
      await delay(50)
    }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}`)
  }
  const input = async (selector: string, value: string) => execute(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', {bubbles:true}));
  })()`)
  try {
    await window.loadURL(new URL('__search', process.env.WEB_SEARCH_SMOKE_URL).href)
    await wait(`document.querySelector('.web-search-settings fieldset')?.disabled === false`)
    // Hidden Chromium windows do not acquire native keyboard focus.
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('DOM.enable')
    await window.webContents.debugger.sendCommand('CSS.enable')
    const { root } = await window.webContents.debugger.sendCommand('DOM.getDocument')
    const { nodeId } = await window.webContents.debugger.sendCommand('DOM.querySelector', {
      nodeId: root.nodeId, selector: '.key-row input[type="password"]',
    })
    await window.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] })
    for (const width of [1200, 390]) {
      window.setContentSize(width, 900)
      await execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      assert.equal(await execute(`document.documentElement.scrollWidth <= innerWidth`), true, 'No page overflow')
      assert.equal(await execute(`document.querySelector('.settings-navigation [aria-current="page"]').textContent.trim()`), 'Web search')
      assert.deepEqual(await execute(`Array.from(document.querySelectorAll('.key-heading label'), el => el.textContent)`),
        ['Firecrawl API key', 'Brave API key', 'Exa API key', 'Tavily API key'])
      assert.equal(await execute(`Array.from(document.querySelectorAll('.key-row input[type="password"]')).every(input =>
        input.labels.length === 1 && input.value === '' && input.autocomplete === 'new-password'
        && input.getBoundingClientRect().right <= innerWidth && input.getBoundingClientRect().height >= 44)`), true)
      assert.equal(await execute(`document.querySelector('.save-settings').disabled`), true)
      await execute(`document.querySelector('.key-row input[type="password"]').focus()`)
      assert.equal(await execute(`document.activeElement.type`), 'password')
      assert.equal(await execute(`getComputedStyle(document.activeElement).outlineStyle`), 'solid')
    }
    await execute(`{ const select = document.querySelector('.web-search-settings select'); select.value = 'exa'; select.dispatchEvent(new Event('change',{bubbles:true})); }`)
    await input('input[id$="-exa"]', 'synthetic-rendered-key')
    await execute(`document.querySelector('.remove-key input').click()`)
    await wait(`document.querySelector('input[id$="-firecrawl"]').disabled`)
    await execute(`window.fixture.fail = true; document.querySelector('.save-settings').click()`)
    await wait(`!!document.querySelector('.web-search-settings [role="alert"]')`)
    assert.equal(await execute(`document.querySelector('input[id$="-exa"]').value`), 'synthetic-rendered-key')
    assert.equal(await execute(`document.body.innerText.includes('synthetic-private-error')`), false)
    await execute(`window.fixture.fail = false; document.querySelector('.save-settings').click()`)
    await wait(`document.querySelector('.web-search-settings').textContent.includes('settings saved for all Projects')`)
    assert.deepEqual(await execute(`window.fixture.patches[1]`),
      { provider: 'exa', apiKeys: { firecrawl: null, exa: 'synthetic-rendered-key' } })
    assert.equal(await execute(`document.querySelector('input[id$="-exa"]').value`), '')
    assert.equal(await execute(`document.querySelector('.save-settings').disabled`), true)
    assert.equal(await execute(`document.querySelector('input[id$="-exa"]').parentElement.textContent.includes('Configured')`), true)
    assert.equal(await execute(`document.querySelector('.web-search-settings').textContent.includes('Saved service: Exa')`), true)
    console.log('WEB_SEARCH_SMOKE_OK')
  } finally { window.destroy() }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
