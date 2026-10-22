import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1200, height: 844,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (code: string) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(50) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}`)
  }
  const frame = () => execute(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  const openDetails = async () => {
    await wait(`!document.querySelector('.overlay-leave-active, .mobile-sheet-leave-active')`)
    if (!await execute(`!!document.querySelector('.session-details')?.getClientRects().length`)) {
      await execute(`document.querySelector('.session-heading .composer-control').click()`)
    }
    await wait(`!!document.querySelector('.session-details')?.getClientRects().length`)
    await wait(`!document.querySelector('.overlay-enter-active, .mobile-sheet-enter-active')`)
  }
  const click = async () => {
    await openDetails()
    await execute(`window.popupBeforeEdit = document.querySelector('[role="dialog"][aria-label="Session details"]');
      window.headingHeightBeforeEdit = document.querySelector('.session-heading').getBoundingClientRect().height;
      document.querySelector('.session-details [aria-label="Rename session"]').click()`)
  }
  const screenshot = async (name: string) => {
    if (process.env.RENAME_SCREENSHOTS) {
      await writeFile(join(process.env.RENAME_SCREENSHOTS, `${name}.png`), (await window.webContents.capturePage()).toPNG())
    }
  }
  const fill = (value: string) => execute(`(() => {
    const input = document.querySelector('input[aria-label="Session name"]');
    input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', {bubbles:true}));
  })()`)
  const key = async (keyCode: 'Enter' | 'Escape' | 'Tab') => {
    if (!window.webContents.debugger.isAttached()) {
      window.webContents.debugger.attach('1.3')
      await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    }
    const event = { key: keyCode, code: keyCode, windowsVirtualKeyCode: keyCode === 'Enter' ? 13 : keyCode === 'Escape' ? 27 : 9 }
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', ...event, ...(keyCode === 'Enter' ? { text: '\r' } : {}),
    })
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
  }
  try {
    await window.loadURL(new URL('__rename', process.env.RENAME_SMOKE_URL).href)
    await wait(`document.querySelector('.heading-folder')?.textContent === 'synthetic'`)
    assert.equal(await execute(`!!document.querySelector('.session-heading > .rename-button')`), false,
      'The session header has no separate rename action')
    await execute(`Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{writeText:async value => {
      if (window.rejectCopy) throw new Error('Synthetic clipboard denied');
      window.copiedValues.push(value);
    }} }); window.copiedValues = []`)
    await openDetails()
    assert.equal(await execute(`!!document.querySelector('.detail-name > [aria-label="Rename session"]')`), true)
    await execute(`document.querySelector('[aria-label="Copy Path"]').click()`)
    await wait(`!!document.querySelector('[aria-label="Path copied"]')`)
    assert.equal(await execute(`window.copiedValues.at(-1)`), 'C:\\synthetic')
    await execute(`document.querySelector('[aria-label="Copy Session ID"]').click()`)
    await wait(`!!document.querySelector('[aria-label="Session ID copied"]')`)
    assert.equal(await execute(`window.copiedValues.at(-1)`), 'web:fixture')
    await execute(`window.rejectCopy = true; document.querySelector('[aria-label="Path copied"]').click()`)
    await wait(`document.querySelector('.copy-error')?.textContent.includes('copy it manually')`)
    assert.equal(await execute(`!!document.querySelector('[aria-label="Path copied"]')`), false,
      'Clipboard denial cannot show a successful copy')
    assert.equal(await execute(`document.querySelector('.detail-copy .copy-value').textContent`), 'C:\\synthetic',
      'The path remains selectable for manual copying')
    await execute(`window.rejectCopy = false; document.querySelector('[aria-label="Copy Path"]').click()`)
    await wait(`!!document.querySelector('[aria-label="Path copied"]')`)
    assert.equal(await execute(`!!document.querySelector('.copy-error')`), false)
    for (const width of [1200, 390]) {
      window.setContentSize(width, 844)
      await wait(`Math.abs(innerWidth - ${width}) <= 2`)
      await frame()
      await click()
      await wait(`document.activeElement?.getAttribute('aria-label') === 'Session name'`)
      assert.equal(await execute(`document.querySelector('.session-rename').closest('.detail-name') !== null`), true,
        'The editor replaces the name inside the popup identity row')
      assert.equal(await execute(`document.querySelector('.session-heading .session-rename')`), null,
        'The header never contains the rename form')
      assert.equal(await execute(`document.querySelector('[role="dialog"][aria-label="Session details"]') === window.popupBeforeEdit`), true,
        'Editing never unmounts or replaces the details popup')
      assert.equal(await execute(`document.querySelector('.session-heading').getBoundingClientRect().height === window.headingHeightBeforeEdit`), true)
      assert.equal(await execute(`document.activeElement.selectionEnd - document.activeElement.selectionStart === document.activeElement.value.length`), true)
      await fill(`  Saved at ${width}  `)
      assert.equal(await execute(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true)
      await key('Tab')
      await wait(`document.activeElement?.matches('.rename-actions button[type="submit"]')`)
      assert.equal(await execute(`document.activeElement.closest('.session-rename') !== null`), true)
      await key('Tab')
      await wait(`document.activeElement?.textContent === 'Cancel'`)
      assert.equal(await execute(`!!document.querySelector('.session-details')`), true,
        'Native form tabbing does not trigger popover dismissal')
      await execute(`document.querySelector('.rename-input').focus()`)
      for (const dark of [false, true]) {
        await execute(`document.documentElement.classList.toggle('dark', ${dark})`)
        await frame()
        const editor = await execute(`(() => {
          const popup = document.querySelector('[role="dialog"][aria-label="Session details"]');
          const input = document.querySelector('.rename-input').getBoundingClientRect();
          const form = document.querySelector('.session-rename').getBoundingClientRect();
          const name = document.querySelector('.detail-name').getBoundingClientRect();
          const buttons = [...document.querySelectorAll('.rename-actions button')].map(button => button.getBoundingClientRect());
          return {
            withinName:input.left >= name.left && input.right <= name.right + 1,
            withinPopup:form.right <= popup.getBoundingClientRect().right,
            fullWidth:Math.abs(input.width - name.width) < 1,
            actionsBelow:buttons.every(button => button.top >= input.bottom),
            targets:buttons.map(button => button.height),
            font:getComputedStyle(document.querySelector('.rename-input')).fontSize,
            overflow:popup.scrollWidth > popup.clientWidth || document.documentElement.scrollWidth > innerWidth,
            sheet:popup.classList.contains('mobile-sheet'),
          };
        })()`)
        assert.equal(editor.withinName, true)
        assert.equal(editor.withinPopup, true)
        assert.equal(editor.fullWidth, true)
        assert.equal(editor.actionsBelow, true)
        assert.equal(editor.overflow, false)
        assert(editor.targets.every((height: number) => height >= (width === 390 ? 44 : 32)))
        assert.equal(editor.sheet, width === 390, 'Phones edit inside Session details, not a separate rename sheet')
        assert.equal(editor.font, width === 390 ? '16px' : '14px')
        await screenshot(`session-editor-${width}-${dark ? 'dark' : 'light'}`)
      }
      await key('Enter')
      await wait(`document.querySelector('#saved-name').textContent === 'Saved at ${width}'`)
      await wait(`document.querySelector('.heading-name').textContent === 'Synthetic project / Saved at ${width}'`)
      await wait(`document.activeElement?.getAttribute('aria-label') === 'Rename session'`)
      assert.equal(await execute(`document.activeElement.closest('.session-details') !== null`), true,
        'Saving returns to the popup action, not a removed header button')
      assert.equal(await execute(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true)
    }
    await click()
    await wait(`document.activeElement?.tagName === 'INPUT'`)
    await fill('Do not save')
    await key('Escape')
    await wait(`!document.querySelector('.session-rename')`)
    await wait(`document.activeElement?.getAttribute('aria-label') === 'Rename session'`)
    assert.equal(await execute(`!!document.querySelector('.session-details')`), true,
      'Escape cancels the edit without closing the popup')
    assert.equal(await execute(`document.querySelector('#saved-name').textContent`), 'Saved at 390')
    await click()
    await wait(`document.activeElement?.tagName === 'INPUT'`)
    await fill('Discard on dismissal')
    await execute(`document.querySelector('.composer-popover-backdrop, .mobile-sheet-backdrop').dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}))`)
    await wait(`!document.querySelector('.session-details')`)
    await click()
    await wait(`document.activeElement?.tagName === 'INPUT'`)
    assert.equal(await execute(`document.querySelector('.rename-input').value`), 'Saved at 390',
      'Closing the popup discards its unsaved draft')
    await key('Escape')
    await click()
    await wait(`document.activeElement?.tagName === 'INPUT'`)
    await fill('Fail this rename')
    await key('Enter')
    await wait(`document.querySelector('[role="alert"]')?.textContent.includes('Retry')`)
    assert.equal(await execute(`document.querySelector('input').value`), 'Fail this rename')
    assert.equal(await execute(`document.querySelector('#saved-name').textContent`), 'Saved at 390')
    await execute(`document.querySelector('.rename-actions button[type="button"]').click()`)
    await wait(`!!document.querySelector('.session-details')`)
    await execute(`window.__headingFixture.sessionId = 'web:missing'`)
    await wait(`document.querySelector('.heading-folder')?.textContent === 'Folder unavailable'`)
    assert.equal(await execute(`!!document.querySelector('[aria-label="Copy Path"]')`), false,
      'Unavailable path labels must not be copied as real paths')
    assert.equal(await execute(`document.querySelector('.details-identity').textContent.includes('Unavailable')`), true)
    await execute(`window.__headingFixture.sessionId = 'web:remote-missing'`)
    await wait(`document.querySelector('.heading-folder')?.textContent.includes('Synthetic device')`)
    assert.equal(await execute(`document.querySelector('.details-identity').textContent.includes('Not advertised by this device')`), true)
    assert.equal(await execute(`!!document.querySelector('[aria-label="Copy Path"]')`), false)
    await execute(`window.__headingFixture.sessionId = 'web:remote'`)
    await wait(`!!document.querySelector('[aria-label="Copy Path"]')`)
    await execute(`document.querySelector('[aria-label="Copy Path"]').click()`)
    await wait(`!!document.querySelector('[aria-label="Path copied"]')`)
    assert.equal(await execute(`window.copiedValues.at(-1)`), 'Z:\\remote\\review',
      'Remote display paths copy verbatim without being resolved on Main')
    await execute(`window.__headingFixture.canRename = false`)
    await frame()
    assert.equal(await execute(`!!document.querySelector('[aria-label="Rename session"]')`), false)
    assert.equal(await execute(`!!document.querySelector('[aria-label="Copy Session ID"]')`), true,
      'Read-only sessions still allow copying their identity')
    await execute(`window.__headingFixture.canRename = true; window.__headingFixture.sessionId = 'web:long'`)
    await wait(`document.querySelector('.heading-folder')?.textContent === 'review'`)
    for (const width of [1200, 390]) {
      window.setContentSize(width, 844)
      await wait(`Math.abs(innerWidth - ${width}) <= 2`)
      await frame()
      for (const dark of [false, true]) {
        await execute(`document.documentElement.classList.toggle('dark', ${dark})`)
        await frame()
        await openDetails()
        await frame()
        const layout = await execute(`(() => {
          const popup = document.querySelector('[role="dialog"][aria-label="Session details"]');
          const bounds = popup.getBoundingClientRect();
          const buttons = [...document.querySelectorAll('.details-identity button')];
          const values = [...document.querySelectorAll('.detail-copy .copy-value')];
          return {
            overflow:document.documentElement.scrollWidth > innerWidth || popup.scrollWidth > popup.clientWidth,
            inViewport:bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight,
            targets:buttons.map(button => button.getBoundingClientRect().height),
            wrap:values.map(value => getComputedStyle(value).whiteSpace),
            name:document.querySelector('.detail-name > span').textContent,
            path:values[0].textContent,
          };
        })()`)
        assert.equal(layout.overflow, false)
        assert.equal(layout.inViewport, true)
        assert(layout.targets.every((height: number) => height >= (width === 390 ? 44 : 32) - .01), JSON.stringify({ width, layout }))
        assert(layout.wrap.every((value: string) => value === 'pre-wrap'))
        assert.equal(layout.name, 'Synthetic project / Review / ' + 'LongSessionName'.repeat(25))
        assert.equal(layout.path, 'C:\\synthetic\\' + 'nested-folder\\'.repeat(15) + 'review')
        const usage = await execute(`(() => {
          const columns = [...document.querySelectorAll('.token-column')];
          const bounds = columns.map(column => column.getBoundingClientRect());
          return {
            labels:columns.map(column => column.querySelector('dt').textContent),
            counts:columns.map(column => [...column.querySelectorAll('dd > span')].map(span => span.title)),
            separate:bounds.length === 2 && bounds[0].right <= bounds[1].left && Math.abs(bounds[0].top - bounds[1].top) < 1,
            context:document.querySelector('progress')?.value,
            partial:document.querySelector('.details-usage').textContent.includes('Partial usage'),
            headerOverflow:document.querySelector('.session-heading').scrollWidth > document.querySelector('.session-heading').clientWidth,
          };
        })()`)
        assert.deepEqual(usage.labels, ['Total', 'Subagents'])
        assert.deepEqual(usage.counts, [['1,234,567 input tokens', '45,678 output tokens'], ['234,567 input tokens', '5,678 output tokens']])
        assert.equal(usage.separate, true)
        assert.equal(usage.context, 12)
        assert.equal(usage.partial, true)
        assert.equal(usage.headerOverflow, false)
        await screenshot(`session-popup-${width}-${dark ? 'dark' : 'light'}`)
      }
    }
    await execute(`document.querySelector('[aria-label="Copy Session ID"]').focus()`)
    await key('Enter')
    await wait(`!!document.querySelector('[aria-label="Session ID copied"]')`)
    assert.equal(await execute(`window.copiedValues.at(-1)`), 'web:long')
    await key('Escape')
    await wait(`!document.querySelector('.session-details')`)
    assert.equal(await execute(`document.activeElement?.getAttribute('aria-label')`), 'Session details')
    await execute(`window.__startHeadingRename()`)
    await wait(`document.activeElement?.getAttribute('aria-label') === 'Session name'`)
    assert.equal(await execute(`document.querySelector('.session-rename').closest('[aria-label="Session details"]') !== null`), true,
      'The contextual rename entry opens the same inline editor')
    assert.equal(await execute(`!!document.querySelector('[role="dialog"][aria-label="Rename session"]')`), false)
    await key('Escape')
    await wait(`!document.querySelector('.session-rename')`)
    assert.equal(await execute(`!!document.querySelector('.session-details')`), true)
    console.log('RENAME_SMOKE_OK')
  } finally { window.destroy() }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
