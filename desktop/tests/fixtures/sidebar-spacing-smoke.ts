import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1100, height: 844,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (code: string) => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(50) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}`)
  }
  const frame = () => execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  try {
    await window.loadURL(new URL('__sidebar', process.env.SIDEBAR_SMOKE_URL).href)
    await wait(`document.querySelectorAll('.automation-entry').length === 3 && !!document.querySelector('.bot-toggle')`)
    assert.equal(await execute(`!!document.querySelector('.project-delete, [title="Delete project"]')`), false, 'Project deletion is not a sidebar action')
    await execute(`document.querySelector('.folder-toggle').click()`)
    await wait(`document.querySelectorAll('.folder-conversations .session-select').length === 2`)
    await wait(`!!document.querySelector('.session-select .tree-icon .i-lucide-brain')`)
    assert.equal(await execute(`!!document.querySelector('.folder-folder-row .session-activity')`), false,
      'Folder rows do not repeat conversation or subagent status')
    assert.equal(await execute(`!!document.querySelector('.folder-session-row .tree-meta')`), false,
      'Conversation status occupies its leading icon, not a trailing label')
    assert.equal(await execute(`document.querySelector('.session-select .session-activity').title.includes('1 subagent')`), true,
      'Delegated work stays discoverable without a folder badge or trailing count')
    for (const width of [1100, 390]) {
      window.setContentSize(width, 844)
      await wait(`Math.abs(innerWidth - ${width}) <= 2`)
      await wait(width === 390 ? `!!document.querySelector('.projects-toggle')` : `!document.querySelector('.projects-toggle')`)
      await frame()
      if (width === 390) await execute(`document.querySelector('.projects-toggle').click()`)
      await wait(`document.querySelector('.projects-sidebar').getClientRects().length > 0`)
      for (const theme of ['dark', 'light']) {
        await execute(`document.documentElement.classList.toggle('dark', ${theme === 'dark'})`)
        await frame()
        const selection = await execute(`(() => {
          const entry = document.querySelector('[data-project-id="work"] .coordinator-entry');
          const before = entry.getBoundingClientRect();
          entry.classList.add('selected');
          const style = getComputedStyle(entry);
          const label = getComputedStyle(entry.firstElementChild);
          return { background:style.backgroundColor, decoration:label.textDecorationLine,
            thickness:label.textDecorationThickness, offset:label.textUnderlineOffset,
            stable:entry.getBoundingClientRect().height === before.height };
        })()`)
        assert.equal(selection.background, 'rgba(0, 0, 0, 0)', 'Selected project heading has no filled block')
        assert.equal(selection.decoration, 'underline')
        assert.equal(selection.thickness, '1px')
        assert.equal(selection.offset, '4px')
        assert.equal(selection.stable, true)
        const layout = await execute(`(() => {
          const q = s => document.querySelector(s);
          const rect = s => {
            const el = q(s);
            if (!el) throw new Error('Missing layout target: ' + s);
            return el.getBoundingClientRect();
          };
          const work = '[data-project-id="work"]';
          const rows = [...document.querySelectorAll(work + ' .tree-item, ' + work + ' .automation-entry')]
            .filter(el => el.getClientRects().length);
          const lastTree = rows.filter(el => el.classList.contains('tree-item')).at(-1);
          return {
            heights:rows.map(el => el.getBoundingClientRect().height),
            projectHeight:rect(work + ' .folders-header').height,
            firstProjectGap:rect('.folders-header').top - rect('.projects-heading').bottom,
            emptyHeadingHeight:rect('[data-project-id="empty"] .chats-heading').height,
            chatActionSize:rect(work + ' .chat-add').width,
            chatActionRight:rect(work + ' .chat-add').right,
            folderActionRight:rect(work + ' .folder-actions').right,
            projectGap:rect(work).top - rect('[data-project-id="empty"]').bottom,
            headingGap:rect(work + ' .folder-folder-row').top - rect(work + ' .folders-header').bottom,
            folderGap:rect('.folder-group + .folder-group').top - rect('.folder-group').bottom,
            chatsGap:rect(work + ' .legacy-chats').top - rect('.folder-group + .folder-group').bottom,
            botGap:rect('.bot-conversations').top - rect(work + ' .legacy-chats').bottom,
            sectionGap:rect('.automations-sidebar').top - lastTree.getBoundingClientRect().bottom,
            sectionHeadingGap:rect('.automation-entry').top - rect('.automations-sidebar h3').bottom,
            iconXs:[rect('.folder-folder .tree-icon').x, rect('.bot-toggle .tree-icon').x, rect('.automation-icon').x],
            labelXs:[rect('.folder-folder .tree-label').x, rect('.bot-toggle .tree-label').x, rect('.automation-name').x],
            projectX:rect(work + ' .coordinator-entry').x,
            sectionX:rect('.automations-sidebar h3').x + parseFloat(getComputedStyle(q('.automations-sidebar h3')).paddingLeft),
            indent:rect('.session-select .tree-icon').x - rect('.folder-folder .tree-icon').x,
            titleTruncated:q('.coordinator-entry > span').scrollWidth > q('.coordinator-entry > span').clientWidth,
            borders:[...document.querySelectorAll('.project-settings')].map(el => getComputedStyle(el).borderTopWidth),
            overflow:q('.project-groups').scrollWidth > q('.project-groups').clientWidth,
          };
        })()`)
        assert(layout.heights.every((height: number) => height === (width === 390 ? 44 : 32)), JSON.stringify(layout))
        assert.equal(layout.projectHeight, width === 390 ? 44 : 36)
        assert.equal(layout.firstProjectGap, 0)
        assert.equal(layout.emptyHeadingHeight, width === 390 ? 44 : 32)
        assert.equal(layout.chatActionSize, width === 390 ? 44 : 28)
        assert.equal(layout.chatActionRight, layout.folderActionRight, 'Chat creation aligns with the trailing folder controls')
        assert.equal(layout.projectGap, 12)
        assert.equal(layout.headingGap, 4)
        assert.equal(layout.folderGap, 0)
        assert.equal(layout.chatsGap, 16)
        assert.equal(layout.botGap, 0)
        assert.equal(layout.sectionGap, 16)
        assert.equal(layout.sectionHeadingGap, 4)
        assert.equal(new Set(layout.iconXs).size, 1, 'Folder, bot and automation icons share one column')
        assert.equal(new Set(layout.labelXs).size, 1, 'Folder, bot and automation labels share one column')
        assert.equal(layout.projectX, layout.iconXs[0], 'Project names align with their content icon column')
        assert.equal(layout.sectionX, layout.iconXs[0], 'Section headings align with their content icon column')
        assert.equal(layout.indent, 16)
        assert.equal(layout.titleTruncated, true)
        assert(layout.borders.every((border: string) => border === '0px'))
        assert.equal(layout.overflow, false, JSON.stringify({ width, layout }))
        assert.equal(await execute(`[...document.querySelectorAll('.folder-conversations .session-activity')].every(icon =>
          icon.getBoundingClientRect().width <= 16.01 && !icon.querySelector('.activity-label'))`), true,
          'Thinking and needs-reply states stay inside the leading icon column')
        if (process.env.SIDEBAR_SCREENSHOT_DIR) {
          const image = await window.webContents.capturePage({ x: 0, y: 0, width: width === 390 ? 340 : 300, height: 680 })
          await writeFile(join(process.env.SIDEBAR_SCREENSHOT_DIR, `sidebar-${width}-${theme}.png`), image.toPNG())
        }
        await execute(`document.querySelector('[data-project-id="work"] .coordinator-entry').classList.remove('selected')`)
      }
      await execute(`document.querySelector('[data-project-id="work"] .project-toggle').click()`)
      await wait(`document.querySelector('[data-project-id="work"] .folders-scroll').getClientRects().length === 0`)
      await execute(`document.querySelector('[data-project-id="work"] .project-toggle').click()`)
      await wait(`document.querySelector('[data-project-id="work"] .folders-scroll').getClientRects().length > 0`)
      await wait(`document.querySelectorAll('.automation-entry').length === 3`)
      await execute(`document.querySelector('.folder-toggle').click()`)
      await wait(`!document.querySelector('.folder-conversations')`)
      await execute(`document.querySelector('.folder-toggle').click()`)
      await wait(`!!document.querySelector('.folder-conversations')`)
      await execute(`document.querySelector('[data-project-id="work"] .chat-add').click()`)
      await wait(`document.querySelector('.fixture-content:not([style*="display: none"]) .fixture-content-action')?.textContent === 'Draft'`)
      const draft = await execute(`(() => {
        const content = document.querySelector('.fixture-content:not([style*="display: none"])');
        const route = window.__sidebarFixture.router.currentRoute.value;
        return {project:content.dataset.fixtureProject, folder:content.dataset.fixtureFolder,
          remote:content.dataset.fixtureRemote, projectId:route.params.projectId, sessionId:route.params.sessionId,
          menu:!!document.querySelector('.folder-menu')};
      })()`)
      assert.equal(draft.project, 'work')
      assert.equal(draft.folder, undefined)
      assert.equal(draft.remote, 'false')
      assert.equal(draft.projectId, 'work')
      assert.equal(draft.sessionId || '', '')
      assert.equal(draft.menu, false, 'Chat creation opens the scratch draft directly, without a menu')
      if (width === 390) assert.equal(await execute(`document.querySelector('.projects-sidebar').getClientRects().length`), 0)
    }
    window.setContentSize(1100, 844)
    await frame()
    await execute(`document.querySelector('.projects-sidebar > .sidebar-resizer').dispatchEvent(new KeyboardEvent('keydown', {key:'Home', bubbles:true}))`)
    await frame()
    assert.equal(await execute(`document.querySelector('.projects-sidebar').getBoundingClientRect().width`), 200)
    assert.equal(await execute(`document.querySelector('.project-groups').scrollWidth > document.querySelector('.project-groups').clientWidth`), false)
    await execute(`document.querySelector('.projects-sidebar > .sidebar-resizer').dispatchEvent(new KeyboardEvent('keydown', {key:'End', bubbles:true}))`)
    await frame()
    const savedWidth = await execute(`document.querySelector('.projects-sidebar').getBoundingClientRect().width`)
    await execute(`document.querySelector('.project-groups').scrollTop = 180`)
    const scrollTop = await execute(`document.querySelector('.project-groups').scrollTop`)
    assert(scrollTop > 0)
    await execute(`document.querySelector('[aria-label="Hide projects"]').click()`)
    await wait(`document.querySelector('.projects-sidebar').getClientRects().length === 0`)
    assert.equal(await execute(`!!document.querySelector('.project-rail, .project-badge')`), false)
    assert.equal(await execute(`document.activeElement === document.querySelector('.projects-toggle')`), true)
    const contentRect = () => execute(`(() => { const r = document.querySelector('.project-conversations').getBoundingClientRect(); return {x:r.x, y:r.y, width:r.width, height:r.height} })()`)
    const hiddenRect = await contentRect()
    assert.equal(hiddenRect.x, 0)
    assert.equal(hiddenRect.width, await execute(`document.querySelector('.projects-workspace').getBoundingClientRect().width`), 'Hidden sidebar gives back its entire width')
    const open = async () => {
      await execute(`document.querySelector('.projects-toggle').click()`)
      await wait(`document.querySelector('.projects-sidebar').getClientRects().length > 0`)
    }
    await open()
    assert.deepEqual(await contentRect(), hiddenRect, 'Temporary navigation does not resize the workspace')
    assert.equal(await execute(`document.querySelector('.project-groups').scrollTop`), scrollTop)
    assert.equal(await execute(`document.querySelector('.projects-sidebar').contains(document.activeElement)`), true)
    await execute(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}))`)
    await wait(`document.querySelector('.projects-sidebar').getClientRects().length === 0`)
    assert.equal(await execute(`document.activeElement === document.querySelector('.projects-toggle')`), true)
    await open()
    await execute(`document.querySelector('[aria-label="New work in Workspace"]').click()`)
    await wait(`!!document.querySelector('.folder-menu')`)
    await execute(`document.querySelector('.folder-menu button').focus()`)
    await wait(`document.activeElement.closest('.folder-menu')`)
    await frame()
    await execute(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}))`)
    await wait(`!document.querySelector('.folder-menu')`)
    assert.equal(await execute(`document.querySelector('.projects-sidebar').getClientRects().length > 0`), true, 'Escape dismisses nested menus before navigation')
    await execute(`document.querySelector('.projects-backdrop').click()`)
    await wait(`document.querySelector('.projects-sidebar').getClientRects().length === 0`)
    await open()
    await execute(`document.querySelector('[aria-label="Pin projects"]').click()`)
    await wait(`!document.querySelector('.projects-sidebar').classList.contains('is-floating')`)
    assert.equal(await execute(`document.querySelector('.projects-sidebar').getBoundingClientRect().width`), savedWidth)
    assert.equal(await execute(`document.querySelector('.project-groups').scrollTop`), scrollTop)
    assert.equal(await execute(`document.activeElement === document.querySelector('[aria-label="Hide projects"]')`), true)
    await execute(`document.querySelector('[aria-label="Hide projects"]').click()`)
    await open()
    await execute(`document.querySelector('.session-select').click()`)
    await wait(`document.querySelector('.projects-sidebar').getClientRects().length === 0 && !!document.querySelector('.fixture-content')`)
    assert.equal(await execute(`document.querySelector('.projects-current-name').textContent`), 'Workspace')
    assert.equal(await execute(`JSON.parse(localStorage.getItem('shadow:projects-sidebar:' + location.origin)).collapsed`), true, 'Choosing a conversation does not repin navigation')
    await open()
    await execute(`document.querySelectorAll('.session-select')[1].click()`)
    await wait(`document.querySelector('.fixture-content:not([style*="display: none"]) .fixture-content-action').textContent === 'web:chat-two' && document.querySelector('.projects-sidebar').getClientRects().length === 0`)
    await open()
    await execute(`document.querySelector('.automation-entry').click()`)
    await wait(`document.querySelector('.fixture-automation-action')?.textContent === 'Encapsulation' && document.querySelector('.projects-sidebar').getClientRects().length === 0`)
    await open()
    await execute(`{ const control = document.querySelector('.fixture-automation-action'); control.focus(); control.dispatchEvent(new FocusEvent('focusin', {bubbles:true})); }`)
    await wait(`document.querySelector('.projects-sidebar').getClientRects().length === 0`)
    assert.equal(await execute(`document.activeElement === document.querySelector('.fixture-automation-action')`), true, 'Tabbing into content closes navigation without stealing focus')
    await open()
    await execute(`window.__sidebarFixture.setVisible(false)`)
    await wait(`document.querySelector('.projects-sidebar').getClientRects().length === 0`)
    await execute(`window.__sidebarFixture.setVisible(true)`)
    await frame()
    assert.equal(await execute(`document.querySelector('.projects-toggle').getAttribute('aria-expanded')`), 'false')
    await open()
    window.setContentSize(390, 844)
    await frame()
    await wait(`document.querySelector('.projects-sidebar').getClientRects().length === 0`)
    await open()
    assert.equal(await execute(`!!document.querySelector('[aria-label="Pin projects"]')`), false)
    assert.equal(await execute(`document.querySelector('.projects-sidebar').getBoundingClientRect().right <= innerWidth - 40`), true)
    await execute(`document.querySelector('.session-select').click()`)
    await wait(`document.querySelector('.projects-sidebar').getClientRects().length === 0`)
    window.setContentSize(1100, 844)
    await frame()
    assert.equal(await execute(`document.querySelector('.projects-sidebar').getClientRects().length`), 0, 'Mobile navigation preserves the desktop hidden preference')
    await window.loadURL(new URL('__sidebar', process.env.SIDEBAR_SMOKE_URL).href)
    await wait(`!!document.querySelector('.projects-toggle') && document.querySelectorAll('.automation-entry').length === 3`)
    assert.equal(await execute(`document.querySelector('.projects-sidebar').getClientRects().length`), 0, 'Legacy collapsed preference restores as hidden, not a rail')
    await open()
    await execute(`document.querySelector('[aria-label="Pin projects"]').click()`)
    await frame()
    assert.equal(await execute(`document.querySelector('.projects-sidebar').getBoundingClientRect().width`), savedWidth)
    await execute(`document.querySelector('[aria-label="Hide projects"]').click(); fetch('/__empty')`)
    await window.loadURL(new URL('__sidebar', process.env.SIDEBAR_SMOKE_URL).href)
    await wait(`document.querySelector('.project-empty .btn')?.textContent === 'Create a project'`)
    await execute(`document.querySelector('.project-empty .btn').click()`)
    await wait(`document.activeElement === document.querySelector('.project-create input')`)
    assert.equal(await execute(`document.querySelector('.projects-sidebar').getClientRects().length > 0`), true, 'Empty-state creation opens the hidden navigation form')
    await execute(`fetch('/__folders/hold')`)
    await window.loadURL(new URL('__folder-loading', process.env.SIDEBAR_SMOKE_URL).href)
    await wait(`!!document.querySelector('.project-toggle .folder-loading-icon')`)
    assert.equal(await execute(`document.querySelectorAll('.folders-scroll .sidebar-note').length`), 0, 'Initial folder loading never inserts a text row')
    assert.equal(await execute(`document.querySelector('[role="status"]').textContent`), 'Loading folders…')
    await execute(`fetch('/__folders/release')`)
    await wait(`document.querySelectorAll('.folder-folder').length === 2 && !document.querySelector('.folder-loading-icon')`)
    await execute(`document.querySelector('.folder-add').click()`)
    await wait(`!!document.querySelector('.folder-folder-row.selected')`)
    await execute(`document.querySelector('.chat-add').click()`)
    await wait(`!document.querySelector('.folder-folder-row.selected')`)
    const positions = () => execute(`JSON.stringify([...document.querySelectorAll('.folders-header, .folder-folder-row, .folder-folder .tree-icon, .folder-folder .tree-label')]
      .map(el => {const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}}))`)
    for (const width of [1100, 390]) {
      window.setContentSize(width, 844)
      for (const grouped of [true, false]) {
        await execute(`window.__folderFixture.group(${grouped})`)
        await frame()
        for (const dark of [true, false]) {
          await execute(`document.documentElement.classList.toggle('dark', ${dark}); document.querySelector('.folder-folder').focus()`)
          const before = await positions()
          await execute(`fetch('/__folders/hold')`)
          await execute(`window.__folderFixture.refresh()`)
          await wait(`document.querySelectorAll('.folder-folder .folder-loading-icon').length === 2`)
          assert.equal(await positions(), before, 'Loading keeps row positions, icon slots and label widths identical')
          assert.equal(await execute(`document.activeElement.classList.contains('folder-folder')`), true, 'Refreshing does not disturb folder focus')
          assert.equal(await execute(`document.querySelector('.folders-scroll').getAttribute('aria-busy')`), 'true')
          assert.equal(await execute(`document.querySelectorAll('.folders-scroll .sidebar-note').length`), 0)
          await execute(`fetch('/__folders/release')`)
          await wait(`!document.querySelector('.folder-loading-icon')`)
          assert.equal(await positions(), before, 'Loading completion does not shift the sidebar')
          assert.equal(await execute(`document.querySelector('.folders-scroll').getAttribute('aria-busy')`), 'false')
        }
      }
    }
    await execute(`fetch('/__folders/hold')`)
    await execute(`window.__folderFixture.refresh()`)
    await wait(`!!document.querySelector('.folder-loading-icon')`)
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    assert.equal(await execute(`getComputedStyle(document.querySelector('.folder-loading-icon')).animationName`), 'none')
    window.webContents.debugger.detach()
    await execute(`fetch('/__folders/fail')`)
    await wait(`!!document.querySelector('.sidebar-error') && !document.querySelector('.folder-loading-icon')`)
    assert.equal(await execute(`document.querySelectorAll('.folder-folder').length`), 2, 'Failed refresh retains existing folders')
    await execute(`fetch('/__folders/release')`)
    await execute(`document.querySelector('.sidebar-error button').click()`)
    await wait(`!document.querySelector('.sidebar-error') && !document.querySelector('.folder-loading-icon')`)
    window.setContentSize(1100, 844)
    await wait(`innerWidth > 700`)
    await execute(`window.__folderFixture.group(false)`)
    await wait(`!!document.querySelector('[aria-label="Collapse folders"]')`)
    await execute(`document.querySelector('[aria-label="Collapse folders"]').click()`)
    await wait(`!!document.querySelector('.folders-sidebar.is-rail')`)
    const railAction = await execute(`(() => {
      const button = document.querySelector('.chat-add');
      button.focus();
      const rect = button.getBoundingClientRect();
      return {width:rect.width, height:rect.height, focused:document.activeElement === button,
        label:button.getAttribute('aria-label')};
    })()`)
    assert.equal(railAction.width, 44)
    assert.equal(railAction.height, 44)
    assert.equal(railAction.focused, true, 'The scratch chat action remains keyboard reachable in the rail')
    assert.equal(railAction.label, 'New chat in Workspace')
    console.log('SIDEBAR_SPACING_OK')
  } finally {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
    window.destroy()
    app.quit()
  }
}

main().catch(error => { console.error(error); app.exit(1) })
