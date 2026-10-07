import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1200, height: 850,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  const errors: string[] = []
  const external: string[] = []
  const base = new URL(process.env.I18N_SMOKE_URL!)
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  window.webContents.on('render-process-gone', (_event, details) => errors.push(details.reason))
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = !/^https?:/.test(details.url) || new URL(details.url).origin === base.origin
    if (!allowed) external.push(details.url)
    callback({ cancel: !allowed })
  })
  const execute = (source: string) => window.webContents.executeJavaScript(source)
  const frame = () => execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const wait = async (source: string) => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) { if (await execute(source)) return; await delay(40) }
    throw new Error(`Timed out: ${source}\n${await execute('document.body.innerText')}\n${errors.join('\n')}`)
  }
  const locale = async (value: 'en' | 'zh-CN') => {
    await execute(`(() => {
      const select = [...document.querySelectorAll('.language-selector select')].find(el => el.getClientRects().length);
      if (!select) throw new Error('Missing visible language selector');
      select.focus(); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    await frame()
    assert.equal(await execute('document.documentElement.lang'), value)
    assert.equal(await execute("localStorage.getItem('shadow.locale')"), value)
  }
  const show = async (view: string) => {
    await execute(`window.__localization.show(${JSON.stringify(view)})`)
    await frame()
  }
  const capture = async (name: string) => {
    await execute(`Promise.all(document.getAnimations().filter(animation =>
      Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})))`)
    await frame()
    const bounds = await execute(`({
      width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      selectors: [...document.querySelectorAll('.language-selector select')].filter(el => el.getClientRects().length)
        .map(el => ({ ...el.getBoundingClientRect().toJSON(), label: el.getAttribute('aria-label') }))
    })`)
    assert.ok(bounds.scrollWidth <= bounds.width + 1, `${name}: ${JSON.stringify(bounds)}`)
    assert.ok(bounds.selectors.length > 0, name)
    for (const select of bounds.selectors) {
      assert.ok(select.x >= 0 && select.right <= bounds.width + 1 && select.width > 0, name)
      assert.ok(select.height >= (bounds.width <= 700 ? 44 : 32), name)
      assert.ok(select.label, name)
    }
    if (process.env.I18N_SCREENSHOTS) {
      await mkdir(process.env.I18N_SCREENSHOTS, { recursive: true })
      await writeFile(join(process.env.I18N_SCREENSHOTS, `${name}.png`), (await window.webContents.capturePage()).toPNG())
    }
  }
  const resize = async (width: number) => {
    window.setContentSize(width, 850)
    window.webContents.enableDeviceEmulation({
      screenPosition: 'desktop', screenSize: { width, height: 850 }, deviceScaleFactor: 1,
      viewPosition: { x: 0, y: 0 }, viewSize: { width, height: 850 }, scale: 1,
    })
    await frame()
  }
  try {
    await window.loadURL(new URL('__localization', base).href)
    await wait('!!window.__localization')
    await locale('en')
    assert.equal(await execute("document.querySelector('h1').textContent"), 'Connect this browser')
    await execute(`(() => {
      const input = document.querySelector('#pairing-code');
      input.value = 'synthetic-unsent-code'; input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await locale('zh-CN')
    assert.equal(await execute("document.querySelector('h1').textContent"), '连接此浏览器')
    assert.equal(await execute("document.querySelector('#pairing-code').value"), 'synthetic-unsent-code')
    await capture('browser-zh-desktop')
    const reloaded = once(window.webContents, 'did-finish-load')
    window.webContents.reload()
    await reloaded
    await wait("!!window.__localization && document.querySelector('h1')?.textContent === '连接此浏览器'")
    assert.equal(await execute("document.querySelector('.language-selector select').value"), 'zh-CN')
    for (const width of [1200, 390]) {
      await resize(width)
      for (const language of ['en', 'zh-CN'] as const) {
        await locale(language)
        await show('settings')
        assert.equal(await execute("document.querySelector('.settings-heading h1').textContent"), language === 'en' ? 'App settings' : '应用设置')
        assert.equal(await execute("document.querySelectorAll('.language-selector select').length"), 2)
        await capture(`settings-${language}-${width}`)
        await show('cards')
        assert.equal(await execute("document.querySelector('pre').textContent"), '# Original English prompt\nRetry stays user-authored.')
        assert.ok((await execute('document.body.textContent')).includes(language === 'en' ? 'System Prompt' : '系统提示词'))
        assert.ok((await execute('document.body.textContent')).includes(language === 'en' ? 'No tools available.' : '没有可用工具。'))
        await locale(language === 'en' ? 'zh-CN' : 'en')
        assert.ok((await execute('document.body.textContent')).includes(language === 'en' ? '系统提示词' : 'System Prompt'))
        await locale(language)
        await show('setup')
        assert.ok(await execute("document.querySelector('[role=radiogroup]')?.getAttribute('aria-label') === window.__localization.t('Computer role')"))
        await capture(`setup-${language}-${width}`)
        await show('mobile')
        assert.equal(await execute("document.querySelector('h1').textContent"), language === 'en' ? 'Connect to Main' : '连接主节点')
        await capture(`mobile-${language}-${width}`)
      }
    }
    assert.deepEqual(await execute('window.__localization.errors'), [])
    assert.deepEqual(errors, [])
    assert.deepEqual(external, [])
    console.log('I18N_RENDERED_OK')
  } finally { window.destroy() }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
