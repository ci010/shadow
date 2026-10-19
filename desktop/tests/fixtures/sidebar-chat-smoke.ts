import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'
app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})
async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  window.webContents.on('console-message', details => console.log(details.level, details.message))
  const run = (source: string) => window.webContents.executeJavaScript(source)
  const wait = async (source: string) => {
    for (let i = 0; i < 400; i++) { if (await run(source)) return; await delay(50) }
    throw Error(`Timeout: ${source} ${await run('document.body.innerText')}`)
  }
  try {
    await window.loadURL(new URL('__activity', process.env.ACTIVITY_SMOKE_URL).href)
    await wait(`document.querySelector('.session-folder-chip')?.textContent === 'shadow'`)
    assert.equal(await run(`!!document.querySelector('.chats-heading')`), false)
    assert.equal(await run(`document.querySelector('.chat-new .tree-primary').textContent.trim()`), 'New')
    assert.equal(await run(`document.querySelector('.session-folder-chip.is-scratch').textContent`), 'from scratch')
    assert.equal(await run(`document.querySelector('time').textContent`), '2 minutes ago')
    const sizes = await run(`({button:document.querySelector('.chat-new').getBoundingClientRect().height,row:document.querySelector('.session-select').getBoundingClientRect().height,buttonWidth:document.querySelector('.chat-new-row').getBoundingClientRect().width,listWidth:document.querySelector('.legacy-chats').getBoundingClientRect().width})`)
    assert.equal(sizes.button, sizes.row)
    assert.equal(sizes.buttonWidth, sizes.listWidth)
    const aligned = await run(`(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const icon = rect('.chat-new .tree-icon'), chatIcon = rect('.session-select .tree-icon');
      const label = rect('.chat-new .tree-primary'), chatLabel = rect('.session-select .tree-primary');
      const kbd = rect('.chat-new kbd'), button = rect('.chat-new');
      return {icon: icon.x, chatIcon: chatIcon.x, label: label.x, chatLabel: chatLabel.x, kbd: kbd.right, right: button.right, kbdAfterLabel: kbd.left > label.left};
    })()`)
    assert.equal(aligned.icon, aligned.chatIcon)
    assert.equal(aligned.label, aligned.chatLabel)
    assert.ok(Math.abs(aligned.kbd - aligned.right) < 0.01)
    assert.equal(aligned.kbdAfterLabel, true)
    for (const dark of [false, true]) {
      for (const selected of [false, true]) {
        const treatment = await run(`(() => {
          document.documentElement.classList.toggle('dark', ${dark});
          const chip = document.querySelector('.session-folder-chip:not(.is-scratch)');
          const row = chip.closest('.tree-item'); row.classList.toggle('selected', ${selected});
          const css = getComputedStyle(chip), kbd = getComputedStyle(document.querySelector('.chat-new kbd'));
          return {height: chip.getBoundingClientRect().height, rowHeight: row.getBoundingClientRect().height, shadow:css.boxShadow, weight:css.fontWeight, color:css.color, secondary:css.getPropertyValue('--c-text-secondary').trim(), kbdBorder:kbd.borderTopWidth, kbdHeight:document.querySelector('.chat-new kbd').getBoundingClientRect().height};
        })()`)
        assert.equal(treatment.height, 16)
        assert.equal(treatment.rowHeight, sizes.row)
        assert.notEqual(treatment.shadow, 'none')
        assert.equal(treatment.weight, '500')
        assert.ok(parseFloat(treatment.kbdBorder) > 0 && parseFloat(treatment.kbdBorder) <= 1)
        assert.ok(treatment.kbdHeight < sizes.row)
      }
    }
    await run(`document.documentElement.classList.remove('dark'); document.querySelectorAll('.tree-item.selected').forEach(row => row.classList.remove('selected'))`)
    await run(`document.querySelector('.chat-new').click()`)
    assert.equal(await run(`window.__activity.scratch`), 1)
    await run(`document.querySelector('[aria-label="Group chats by folder"]').click()`)
    await wait(`!!document.querySelector('.chats-heading')`)
    assert.equal(await run(`!!document.querySelector('.chat-new')`), false)
    await run(`document.querySelector('.chat-add').click()`)
    assert.equal(await run(`window.__activity.scratch`), 2)
    await run(`document.querySelector('[aria-label="Show unified chats"]').click()`)
    await wait(`!!document.querySelector('.chat-new')`)
    await run(`document.querySelector('[aria-label="Collapse folders"]').click()`)
    await wait(`!!document.querySelector('.folders-sidebar.is-rail')`)
    assert.equal(await run(`!!document.querySelector('.chat-new kbd')`), false)
    const rail = await run(`({newX:document.querySelector('.chat-new .tree-icon').getBoundingClientRect().x, chatX:document.querySelector('.session-select .tree-icon').getBoundingClientRect().x})`)
    assert.equal(rail.newX, rail.chatX)
    console.log('SIDEBAR_CHAT_OK')
  } finally { window.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
