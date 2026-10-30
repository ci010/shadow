import assert from 'node:assert/strict'
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
  const opened: string[] = []
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 2) errors.push(message) })
  window.webContents.setWindowOpenHandler(({ url }) => { opened.push(url); return { action: 'deny' } })
  const execute = (code: string) => window.webContents.executeJavaScript(code, true)
  const wait = async (code: string) => {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(50) }
    throw new Error(`Timed out: ${code}\n${await execute('JSON.stringify({route:window.__knowledge.router.currentRoute.value.fullPath,links:[...document.querySelectorAll(".knowledge-preview a")].map(a=>({text:a.textContent,href:a.getAttribute("href"),data:a.dataset}))})')}\n${await execute('document.body.innerText')}\n${errors.join('\n')}`)
  }
  const anchor = (label: string) => `[...document.querySelectorAll('.knowledge-preview a')].find(a=>a.textContent===${JSON.stringify(label)})`
  const click = (label: string) => execute(`${anchor(label)}.click()`)
  const loaded = (title: string) => wait(`document.querySelector('.detail-heading h2')?.textContent===${JSON.stringify(title)} && document.querySelector('.knowledge-preview h1')`)
  const home = async () => {
    await execute(`window.__knowledge.select('memory/topics/index.md')`)
    await loaded('Operations wiki')
  }
  const button = (label: string) => `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)})`
  try {
    const initial = new URL('__knowledge?home=1', process.env.KNOWLEDGE_LINKS_URL)
    await window.loadURL(initial.href)
    // Browser layout/visibility, not just Vue renderer node existence: a native
    // <template> wrapper makes these controls and the catalog error invisible.
    await execute(`window.__visible = selector => {
      const node = document.querySelector(selector);
      if (!node || !node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }; void 0`)
    await wait(`window.__visible('.knowledge > [role="alert"]') && document.querySelector('.knowledge > [role="alert"]').textContent.includes('503')`)
    assert.equal(await execute(`window.__visible('input[aria-label="Search knowledge"]')`), true)
    assert.equal(await execute(`${button('Refresh')}.disabled`), false)
    await execute(`${button('Refresh')}.click()`)
    await wait(`!document.querySelector('.knowledge > [role="alert"]') && document.querySelectorAll('.entry').length===5 && window.__visible('.entry')`)
    assert.equal(await execute(`window.__visible('.content svg')`), true)
    await execute(`document.querySelector('.entry').click()`)
    await loaded('Operations wiki')
    assert.equal(await execute(`window.__visible('.knowledge-preview') && window.__visible('.detail-heading h2')`), true)
    assert.equal(await execute(`!!window.__unsafe || !!document.querySelector('.knowledge-preview script, .knowledge-preview img, .knowledge-preview [onclick]')`), false)
    for (const label of ['Unsafe', 'Data', 'File', 'Unsafe HTML']) {
      assert.equal(await execute(`${anchor(label)}.hasAttribute('href')`), false, label)
    }
    const href = await execute(`${anchor('Relative page')}.getAttribute('href')`)
    assert.equal(new URL(href, 'http://fixture').searchParams.get('entry'), 'memory/topics/guide.md')
    assert.equal(new URL(href, 'http://fixture').hash, '#install')
    assert.equal(await execute(`${anchor('Raw web')}.hasAttribute('data-knowledge-id')`), false, 'Authored data attributes cannot impersonate UI navigation')
    await click('Web')
    await wait(`document.querySelector('.detail-heading h2')?.textContent==='Operations wiki'`)
    assert.deepEqual(opened, ['https://example.com/docs?q=1&view=2'])
    for (const label of ['Web', 'Mail', 'Raw web']) {
      assert.equal(await execute(`${anchor(label)}.rel`), 'noopener noreferrer')
      assert.equal(await execute(`${anchor(label)}.target`), '_blank')
    }
    await execute(`${anchor('Relative page')}.querySelector('strong').click()`)
    await loaded('Linked guide')
    await wait(`document.activeElement?.id==='install' && document.querySelector('.knowledge-preview').scrollTop>0`)
    await execute(`${button('Back')}.click()`)
    await loaded('Operations wiki')
    await execute(`${button('Forward')}.click()`)
    await loaded('Linked guide')
    for (const [label, title] of [
      ['Alias page', 'Linked guide'], ['Reference page', 'Linked guide'], ['Encoded page', 'Encoded guide'],
      ['Entity page', 'Entity guide'], ['Skill', 'Fixture skill'], ['Built-in', 'Fixture skill'],
    ]) {
      await home()
      await click(label)
      await loaded(title)
    }
    await click('Return')
    await loaded('Operations wiki')
    await click('Missing page')
    await wait(`document.body.innerText.includes('Unresolved reference')`)
    await home()
    await click('Unsupported')
    await wait(`document.querySelector('.detail [role="alert"]')?.textContent.includes('Link health')`)
    await click('Missing section')
    await wait(`document.querySelector('.detail [role="alert"]')?.textContent.includes('was not found')`)
    await click('Invalid section')
    await wait(`document.querySelector('.detail [role="alert"]')?.textContent.includes('invalid section address')`)
    await click('Chinese section')
    await wait(`document.activeElement?.id==='中文章节'`)
    assert.equal(await execute(`!!document.querySelector('.detail [role="alert"]')`), false)
    assert.equal(await execute(`!!document.querySelector('.knowledge-preview #local-section-1')`), true)
    for (const width of [1100, 390]) {
      window.setContentSize(width, 800)
      for (const dark of [false, true]) {
        await execute(`document.documentElement.classList.toggle('dark',${dark}); ${anchor('Local section')}.focus()`)
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
        await wait(`document.activeElement?.id==='local-section' && document.querySelector('.knowledge-preview').scrollTop>0`)
        assert.equal(await execute(`document.querySelector('.detail-heading h2').textContent`), 'Operations wiki')
      }
    }
    const deepLink = new URL('__knowledge', process.env.KNOWLEDGE_LINKS_URL)
    deepLink.searchParams.set('entry', 'memory/topics/guide.md')
    deepLink.hash = '#install'
    await window.loadURL(deepLink.href)
    await loaded('Linked guide')
    await wait(`document.activeElement?.id==='install' && document.querySelector('.knowledge-preview').scrollTop>0`)
    assert.deepEqual(errors, [])
    console.log('KNOWLEDGE_LINKS_OK')
  } finally { window.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
