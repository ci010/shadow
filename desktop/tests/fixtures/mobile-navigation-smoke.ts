import { withComposerTestAdapter } from './composer-test-adapter.ts'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 390, height: 844,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
  window.webContents.setAudioMuted(true)
  const errors: string[] = []
  const failures: string[] = []
  const external: string[] = []
  const origin = new URL(process.env.MOBILE_SMOKE_URL!).origin
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  window.webContents.on('render-process-gone', (_event, details) => errors.push(`Renderer exited: ${details.reason}`))
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = !/^https?:/.test(details.url) || new URL(details.url).origin === origin
    if (!allowed) external.push(details.url)
    callback({ cancel: !allowed })
  })
  const execute = (code: string) => window.webContents.executeJavaScript(withComposerTestAdapter(code))
  const frame = () => execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const resize = async (width: number, height = 844) => {
    window.setContentSize(width, height)
    // Chromium emulation avoids Windows fractional-DPI rounding of native client sizes.
    window.webContents.enableDeviceEmulation({
      screenPosition: 'desktop', screenSize: { width, height }, deviceScaleFactor: 1,
      viewPosition: { x: 0, y: 0 }, viewSize: { width, height }, scale: 1,
    })
    await frame()
  }
  const wait = async (code: string, diagnostics?: string) => {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(40) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}\nConsole: ${errors.join('\n')}${diagnostics ? `\nState: ${JSON.stringify(await execute(diagnostics))}` : ''}`)
  }
  const visible = (selector: string) => `window.__visible(${JSON.stringify(selector)})`
  const click = async (selector: string) => {
    await wait(`!!${visible(selector)}`)
    await execute(`(() => { const el = ${visible(selector)}; if (!el) throw new Error('Missing visible control: ' + ${JSON.stringify(selector)}); el.focus(); el.click(); })()`)
    await frame()
  }
  const text = async (label: string, scope = 'button') => {
    if (scope === '.mobile-global-navigation button' && !await execute(`!!${visible('.mobile-global-navigation .tab')}`)) {
      await click('.mobile-preferences-toggle')
    }
    await wait(`[...document.querySelectorAll(${JSON.stringify(scope)})].some(el => window.__isVisible(el) && (el.querySelector('.tree-primary')?.textContent ?? el.textContent).trim() === ${JSON.stringify(label)})`)
    await execute(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(scope)})].find(el => window.__isVisible(el) && (el.querySelector('.tree-primary')?.textContent ?? el.textContent).trim() === ${JSON.stringify(label)});
      if (!el) throw new Error('Missing visible button: ' + ${JSON.stringify(label)}); el.focus(); el.click(); })()`)
    await frame()
  }
  const escape = async () => {
    await execute(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}))`)
    await frame()
  }
  const drawerOpen = () => wait(`!!${visible('[role="dialog"][aria-label="Navigation"]')}`)
  const drawerClosed = () => wait(`!${visible('[role="dialog"][aria-label="Navigation"]')}`)
  const open = async () => { await click('.mobile-menu-trigger'); await drawerOpen() }
  const more = async (label: string) => { await click('[aria-label="Conversation and document actions"]'); await text(label, '.mobile-workbench-actions button') }
  const view = async (label: string) => { await click('[aria-label="Switch view"]'); await text(label, '.mobile-view-row button') }
  const key = async (key: string, ctrlKey = false, shiftKey = false) => {
    await execute(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:${JSON.stringify(key)}, ctrlKey:${ctrlKey}, shiftKey:${shiftKey}, bubbles:true, cancelable:true}))`)
    await frame()
  }
  const captureDiagnosis = async (layout: string) => {
    for (const theme of ['light', 'dark']) {
      await execute(`document.documentElement.classList.toggle('dark', ${theme === 'dark'})`)
      await frame()
      if (process.env.MOBILE_SCREENSHOT_DIR) {
        await mkdir(process.env.MOBILE_SCREENSHOT_DIR, { recursive: true })
        await writeFile(join(process.env.MOBILE_SCREENSHOT_DIR, `diagnosis-tabs-${layout}-${theme}.png`), (await window.webContents.capturePage()).toPNG())
      }
      const bounds = await execute(`({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, diagnosis: ${visible('.session-diagnosis')}.getBoundingClientRect().toJSON() })`)
      assert.ok(bounds.scrollWidth <= bounds.width && bounds.diagnosis.bottom <= bounds.height + 1, `${layout}/${theme}: ${JSON.stringify(bounds)}`)
    }
  }
  const swipe = async (selector: string, x: number, y: number, endX: number, endY: number, count = 1, cancel = false) => {
    await execute(`(() => {
      const target = ${visible(selector)}; if (!target) throw new Error('Missing touch target');
      const points = (x,y) => Array.from({length:${count}}, (_, identifier) => new Touch({identifier, target, clientX:x+identifier, clientY:y}));
      const send = (type,x,y,done=false) => target.dispatchEvent(new TouchEvent(type, {
        bubbles:true, cancelable:true, touches:done?[]:points(x,y), targetTouches:done?[]:points(x,y), changedTouches:points(x,y),
      }));
      send('touchstart',${x},${y}); send('touchmove',${endX},${endY}); send(${JSON.stringify(cancel ? 'touchcancel' : 'touchend')},${endX},${endY},true);
    })()`)
    await frame()
  }
  const touch = async (type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel', x: number, y = 220, selector = '.chat-history') => {
    await execute(`(() => {
      if (${type === 'touchstart'}) window.__dragTarget = ${visible(selector)};
      const target = window.__dragTarget;
      const point = new Touch({ identifier: 0, target, clientX: ${x}, clientY: ${y} });
      target.dispatchEvent(new TouchEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true,
        touches: ${type === 'touchend' || type === 'touchcancel'} ? [] : [point], changedTouches: [point] }));
    })()`)
    await frame()
  }
  const drawerRight = () => execute(`document.querySelector('.is-drawer .mobile-sheet').getBoundingClientRect().right`) as Promise<number>
  const installVisibilityHelpers = () => execute(`window.__isVisible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
      window.__visible = selector => [...document.querySelectorAll(selector)].find(window.__isVisible); void 0;`)
  try {
    await window.loadURL(new URL('__mobile', origin).href)
    await resize(390)
    await installVisibilityHelpers()
    if (process.env.MOBILE_SMOKE_SCENARIO === 'project-tabs') {
      await resize(1100)
      await wait(`!!window.__mobileFixture && !!${visible('.draft-heading')}`)
      const foreign = (project: string) => `.project-editor-tab-group[data-project-id="${project}"]`
      const tab = (label: string, selector = '.editor-workspace-header') => `[...document.querySelectorAll('${selector} button')].find(el => window.__isVisible(el) && el.textContent.trim() === ${JSON.stringify(label)})`
      const route = () => 'window.__mobileFixture.router.currentRoute.value'
      await execute(`window.__mobileFixture.router.push('/projects/work/chat/web%3Achat-one')`)
      await wait(`!!${tab('First investigation')} && !!${visible('.reference-composer')}`)
      await execute(`window.__retainedComposer = ${visible('.reference-composer')}; window.__retainedComposer.value = 'Unsent investigation draft'; window.__retainedComposer.dispatchEvent(new Event('input', { bubbles: true })); void 0;`)
      await execute(`window.__mobileFixture.router.push('/projects/other/workflows')`)
      await wait(`!!${tab('Workflows')}`)
      await execute(`window.__mobileFixture.router.push('/projects/other/chat/web%3Achat-two')`)
      await wait(`!!${tab('Second investigation')}`)
      assert.deepEqual(await execute(`(() => {
        const headers = [...document.querySelectorAll('.editor-workspace-header')].filter(window.__isVisible);
        const header = headers[0];
        const tabs = [...header.querySelectorAll('.editor-tab [role="tab"], .project-editor-label')];
        const markers = [...header.querySelectorAll('.editor-project-marker')];
        return {
          rows: headers.length,
          chromeTabs: document.querySelectorAll('.desktop-title-bar [role="tab"]').length,
          labels: tabs.map(el => el.textContent.trim()).sort(),
          markers: markers.map(el => el.textContent.trim()),
          aligned: tabs.every(el => el.getBoundingClientRect().top === tabs[0].getBoundingClientRect().top),
          belowChrome: header.getBoundingClientRect().top >= document.querySelector('.desktop-title-bar').getBoundingClientRect().bottom,
          fileToggle: !!header.querySelector('.project-explorer-toggle')
        };
      })()`), { rows: 1, chromeTabs: 0, labels: ['First investigation', 'New conversation', 'New conversation', 'Second investigation', 'Workflows'], markers: ['Other project', 'Workspace'], aligned: true, belowChrome: true, fileToggle: true })
      await execute(`${tab('First investigation', foreign('work'))}.click()`)
      await wait(`${route()}.params.projectId === 'work' && ${visible('.reference-composer')} === window.__retainedComposer`)
      assert.equal(await execute(`${visible('.reference-composer')}.value`), 'Unsent investigation draft')
      await execute(`${tab('Workflows', foreign('other'))}.click()`)
      await wait(`${route()}.name === 'project-workflows' && ${route()}.params.projectId === 'other' && ${tab('Workflows')}?.getAttribute('aria-selected') === 'true'`)
      await execute(`${tab('First investigation', foreign('work'))}.click()`)
      await wait(`${route()}.params.projectId === 'work'`)
      await execute(`${visible(foreign('other'))}.querySelector('[aria-label="Close Workflows"]').click()`)
      await wait(`!${tab('Workflows', foreign('other'))}`)
      assert.equal(await execute(`${route()}.params.projectId`), 'work', 'Closing a tab in another group does not navigate away')
      await execute(`window.__mobileFixture.router.push('/projects/other/settings/general')`)
      await wait(`!!${tab('Project settings')} && !!${visible('.project-settings-view')}`)
      await execute(`${tab('First investigation', foreign('work'))}.click()`)
      await wait(`${route()}.params.projectId === 'work'`)
      await execute(`${tab('Project settings', foreign('other'))}.click()`)
      await wait(`${route()}.name === 'project-settings' && ${route()}.params.projectId === 'other' && !!${visible('.project-settings-view')}`)
      const page = (label: string) => `Array.from(document.querySelectorAll('.desktop-title-bar .tab-nav button')).find(button => button.textContent.trim() === ${JSON.stringify(label)})`
      assert.equal(await execute(`${page('Chat')}.getAttribute('aria-current')`), 'page', 'Project routes keep the Chat tab selected')
      assert.deepEqual(await execute(`Array.from(document.querySelectorAll('.desktop-title-bar .tab-nav .tab'), button => button.textContent.trim())`), ['Chat', 'Usage', 'Settings'])
      const projectsToggle = `document.querySelector('.desktop-title-bar .tab-nav .projects-topbar-toggle')`
      await wait(`${projectsToggle}?.getAttribute('aria-label') === 'Hide projects' && !!${visible('#projects-sidebar')}`)
      await execute(`${projectsToggle}.click()`)
      await wait(`${projectsToggle}?.getAttribute('aria-label') === 'Show projects' && !${visible('#projects-sidebar')}`)
      assert.equal(await execute(`!!document.querySelector('.projects-toolbar')`), false)
      await execute(`${projectsToggle}.click()`)
      await wait(`${projectsToggle}?.getAttribute('aria-label') === 'Hide projects' && !!${visible('#projects-sidebar')}`)
      await execute(`${page('Usage')}.click()`)
      await wait(`${route()}.name === 'usage' && ${page('Usage')}.getAttribute('aria-current') === 'page' && !!${visible('.project-breakdown')}`)
      assert.equal(await execute(`document.querySelector('.project-filter [role=combobox]').textContent.trim()`), 'All projects')
      assert.equal(await execute(`document.querySelector('.metric-value').textContent.trim()`), '300')
      await execute(`Array.from(document.querySelectorAll('.project-breakdown button')).find(button => button.textContent.trim() === 'Workspace').click()`)
      await wait(`document.querySelector('.metric-value')?.textContent.trim() === '100'`)
      assert.equal(await execute(`${route()}.name`), 'usage')
      await execute(`${page('Settings')}.click()`)
      await wait(`${route()}.name === 'settings' && ${page('Settings')}.getAttribute('aria-current') === 'page' && !!${tab('Settings')} && !!${visible('.settings-view')}`)
      assert.equal(await execute(`!!${visible('.editor-group-content .settings-view')}`), true)
      await text('Language', '.settings-navigation a')
      await wait(`${route()}.params.section === 'language' && !!${visible('#language-settings-title')}`)
      await execute(`${tab('Usage')}.click()`)
      await wait(`${route()}.name === 'usage' && !!${visible('.editor-group-content .project-usage')} && ${visible('.metric-value')}?.textContent.trim() === '100'`)
      await execute(`window.__mobileFixture.router.back()`)
      await wait(`${route()}.name === 'settings' && ${route()}.params.section === 'language' && !!${visible('#language-settings-title')}`)
      await execute(`window.__mobileFixture.router.forward()`)
      await wait(`${route()}.name === 'usage' && !!${visible('.project-usage')}`)
      await execute(`${page('Settings')}.click()`)
      await wait(`${route()}.params.section === 'language' && !!${visible('#language-settings-title')}`)
      assert.deepEqual(await execute(`[...document.querySelectorAll('.editor-workspace-header [role="tab"]')].filter(window.__isVisible).map(el => el.textContent.trim()).sort()`), ['Settings', 'Usage'])
      await execute(`${page('Chat')}.click()`)
      await wait(`${route()}.name === 'chat' && ${page('Chat')}.getAttribute('aria-current') === 'page' && ${visible('.reference-composer')} === window.__retainedComposer`)
      await execute(`${tab('Settings', foreign('@app'))}.click()`)
      await wait(`${route()}.params.section === 'language' && !!${visible('#language-settings-title')}`)
      await click('.editor-workspace-header [aria-label="Close Settings"]')
      await wait(`${route()}.name === 'usage' && !${tab('Settings')}`)
      await click('.editor-workspace-header [aria-label="Close Usage"]')
      await wait(`${route()}.name === 'chat' && ${visible('.reference-composer')} === window.__retainedComposer`)
      assert.deepEqual(await execute('window.__mobileFixture.errors'), [])
      await window.loadURL(new URL('/__mobile?route=%2Fsettings%2Flanguage', origin).href)
      await installVisibilityHelpers()
      await wait(`!!window.__mobileFixture && ${route()}.params.section === 'language' && !!${visible('.editor-group-content #language-settings-title')}`)
      assert.equal(await execute(`${tab('Settings')}.getAttribute('aria-selected')`), 'true')
      assert.deepEqual(await execute('window.__mobileFixture.errors'), [])
      assert.deepEqual(errors, [])
      assert.deepEqual(external, [])
      console.log('PROJECT_TABS_OK')
      return
    }
    // Native pairing starts without a session: real client context, real App,
    // real project catalog and folder tree, rather than a preselected chat only.
    await wait(`!!${visible('.draft-heading')} && !!${visible('[aria-label="Switch view"]')}`)
    await execute(`document.documentElement.style.setProperty('--safe-area-inset-top', '28px')`)
    await frame()
    assert.ok(await execute(`${visible('.mobile-title-bar')}.getBoundingClientRect().bottom >= 85`), 'Capacitor injected safe area protects the native status bar')
    await open()
    await wait(`!!${visible('.mobile-project-navigation [data-project-id="work"]')}`)
    await click('.mobile-project-navigation [data-project-id="work"] [aria-label="Group chats by folder"]')
    await wait(`document.querySelector('.mobile-project-navigation').innerText.includes('Source workspace')`)
    if (process.env.MOBILE_SCREENSHOT_DIR) {
      await mkdir(process.env.MOBILE_SCREENSHOT_DIR, { recursive: true })
      await writeFile(join(process.env.MOBILE_SCREENSHOT_DIR, 'paired-project-navigation.png'), (await window.webContents.capturePage()).toPNG())
    }
    await click('.mobile-project-navigation [data-project-id="work"] [aria-label="New conversation in Source workspace"]')
    await drawerClosed()
    await wait(`!!${visible('.draft-heading')}`)
    await escape()
    await drawerClosed()
    assert.ok(await execute(`${visible('.draft-heading')}.getBoundingClientRect().width > innerWidth * .8`), 'Fresh paired draft has full width, not an empty 60% file column')
    await more('Browse files')
    await wait(`!!${visible('.project-file-explorer')} && ${visible('.project-file-explorer')}.innerText.includes('Source workspace')`)
    assert.ok(await execute(`${visible('.draft-heading')}.getBoundingClientRect().width > innerWidth * .8`), 'A workspace-bound draft also keeps full width while browsing files')
    await escape()
    await execute(`document.documentElement.style.removeProperty('--safe-area-inset-top'); window.__mobileFixture.router.push('/projects/work/chat/web%3Achat-one')`)
    await wait(`!!${visible('.reference-composer[aria-label="Message"]')} && document.body.innerText.includes('Synthetic reply: ready to continue.')`)
    for (const width of [320, 390]) {
      await resize(width)
      for (const theme of ['light', 'dark']) {
        await execute(`document.documentElement.classList.toggle('dark', ${theme === 'dark'})`)
        const layout = await execute(`(() => {
          const q = window.__visible;
          const rect = selector => q(selector).getBoundingClientRect();
          const header = rect('.mobile-title-bar'), history = rect('.chat-history'), input = rect('.reference-composer[aria-label="Message"]');
          const plus = rect('[aria-label="Message options"]'), send = rect('[aria-label="Send message"]');
          return { layers:['.mobile-title-bar','.desktop-title-bar','.projects-toolbar','.document-toolbar','.conversation-heading-row'].filter(q),
            headerBottom:header.bottom, contentTop:history.top, width:innerWidth,
            overflow:document.documentElement.scrollWidth > innerWidth,
            titleCount:[...document.querySelectorAll('.mobile-header-content [aria-label="Switch view"]')].filter(window.__isVisible).length,
            input:{height:input.height, font:getComputedStyle(q('.reference-composer')).fontSize, minHeight:getComputedStyle(q('.reference-composer')).minHeight},
            plus:{width:plus.width,height:plus.height,top:plus.top,bottom:plus.bottom},
            send:{width:send.width,height:send.height,top:send.top,bottom:send.bottom},
            composer:rect('.composer-box').height, inputTop:input.top,inputBottom:input.bottom };
        })()`)
        assert.deepEqual(layout.layers, ['.mobile-title-bar'], `${width}/${theme}: four chrome rows collapse to one`)
        assert.equal(layout.titleCount, 1)
        assert.equal(layout.width, width)
        assert.equal(layout.overflow, false)
        assert.ok(Math.abs(layout.headerBottom - 57) <= 1, JSON.stringify(layout))
        assert.ok(Math.abs(layout.contentTop - layout.headerBottom) <= 1, JSON.stringify(layout))
        assert.equal(layout.input.font, '16px')
        assert.equal(layout.input.minHeight, '44px')
        assert.ok(layout.plus.width >= 44 && layout.plus.height >= 44 && layout.send.width >= 44 && layout.send.height >= 44, JSON.stringify(layout))
        // The action toolbar intentionally occupies a separate row (ccbf101),
        // keeping a full-width input clear of stop/send/queue actions.
        assert.ok(layout.plus.top >= layout.inputBottom && layout.send.top >= layout.inputBottom, JSON.stringify(layout))
        assert.ok(Math.abs(layout.plus.top - layout.send.top) <= 1, 'Message options and send share the action row')
        assert.ok(layout.composer <= 112, JSON.stringify(layout))
        const chat = await execute(`(() => {
          const list = ${visible('.chat-message-list')}.getBoundingClientRect();
          const bubble = ${visible('.chat-assistant')}.getBoundingClientRect();
          const scroll = ${visible('.chat-messages')};
          return {left:list.left, right:innerWidth-list.right, width:list.width, bubbleWidth:bubble.width,
            scrollbar:scroll.getBoundingClientRect().width-scroll.clientWidth,
            rail:!!${visible('.chat-history .message-history-rail')}};
        })()`)
        assert.ok(Math.abs(chat.left - 8) <= 1 && Math.abs(chat.right - chat.scrollbar - 8) <= 1, JSON.stringify(chat))
        assert.ok(chat.bubbleWidth >= chat.width - 1, 'Long assistant replies use the full phone message column')
        assert.equal(chat.rail, false, 'Desktop history rail does not overlap phone messages')
        await open()
        assert.equal(await execute(`!!${visible('.mobile-project-navigation [data-project-id="work"]')}`), true)
        assert.equal(await execute(`!!${visible('.mobile-global-navigation .tab')}`), false, 'Global destinations do not occupy the top of the drawer')
        assert.equal(await execute(`!!${visible('.mobile-global-actions .theme-toggle')}`), false, 'Preferences start collapsed to leave room for conversations')
        await click('.mobile-preferences-toggle')
        assert.equal(await execute(`!!${visible('.mobile-global-navigation .tab')}`), true, 'Global destinations remain accessible in the footer')
        assert.equal(await execute(`!!${visible('.mobile-global-actions .theme-toggle')}`), true, 'Preferences remain accessible on demand')
        await click('.mobile-preferences-toggle')
        assert.equal(await execute(`document.querySelector('.app-shell').inert`), true)
        assert.equal(await execute(`${visible('[role="dialog"][aria-label="Navigation"]')}.contains(document.activeElement)`), true)
        await execute(`(() => { const panel = ${visible('[role="dialog"][aria-label="Navigation"]')};
          const buttons = [...panel.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(window.__isVisible);
          buttons.at(-1).focus(); buttons.at(-1).dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
          window.__focusWrapped = document.activeElement === buttons[0]; })()`)
        assert.equal(await execute('window.__focusWrapped'), true)
        await escape()
        await drawerClosed()
        if (!await execute(`document.activeElement === document.querySelector('.mobile-menu-trigger')`)) {
          failures.push(`${width}/${theme}: Escape did not restore hamburger focus: ${await execute('document.activeElement.outerHTML.slice(0,500)')}`)
        }
      }
    }
    await execute(`${visible('.reference-composer')}.focus(); document.querySelector('.mobile-menu-trigger').click()`)
    await drawerOpen()
    await escape()
    await drawerClosed()
    assert.equal(await execute(`document.activeElement === document.querySelector('.mobile-menu-trigger')`), true,
      'Navigation restores its explicit trigger even when opening did not focus it')
    await execute(`${visible('.reference-composer')}.focus()`)
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Input.insertText', { text: 'First line' })
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r',
    })
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
    })
    await window.webContents.debugger.sendCommand('Input.insertText', { text: 'Second line' })
    window.webContents.debugger.detach()
    await wait(`${visible('.reference-composer')}?.value === 'First line\\nSecond line'`)
    assert.equal(await execute(`${visible('.reference-composer')}.getAttribute('data-placeholder')`), 'Message...')
    assert.equal(await execute(`${visible('[aria-label="Send message"]')}.disabled`), false, 'Typing updates the real composer state without sending')
    await resize(390, 530)
    const typing = await execute(`(() => {
      const input = ${visible('.reference-composer')}, dock = ${visible('.conversation-dock')};
      const rect = input.getBoundingClientRect(), bottom = dock.getBoundingClientRect().bottom;
      return {value:input.value, height:rect.height, bottom, viewport:visualViewport.height,
        plus:${visible('[aria-label="Message options"]')}.getBoundingClientRect().height,
        send:${visible('[aria-label="Send message"]')}.getBoundingClientRect().height};
    })()`)
    assert.equal(typing.value, 'First line\nSecond line')
    assert.ok(typing.height > 44 && typing.height <= 160, JSON.stringify(typing))
    assert.ok(typing.bottom <= typing.viewport + 1, 'Composer stays within a reduced phone viewport')
    assert.equal(typing.plus, 44)
    assert.equal(typing.send, 44)
    await resize(390)
    await execute(`{ const input = ${visible('.reference-composer')}; input.value=''; input.dispatchEvent(new Event('input',{bubbles:true})); }`)
    await frame()
    assert.ok(await execute(`${visible('.composer-box')}.getBoundingClientRect().height <= 112`), 'Clearing multiline text returns to compact two-row geometry')
    for (const gesture of [
      { selector: '.chat-history', x: 220, y: 200, endX: 320, endY: 202 },
      { selector: '.chat-history', x: 12, y: 200, endX: 100, endY: 350 },
      { selector: '.reference-composer', x: 12, y: 750, endX: 120, endY: 752 },
      { selector: '.chat-history', x: 12, y: 200, endX: 120, endY: 202, count: 2 },
      { selector: '.chat-history', x: 12, y: 200, endX: 120, endY: 202, cancel: true },
    ]) {
      await swipe(gesture.selector, gesture.x, gesture.y, gesture.endX, gesture.endY, gesture.count, gesture.cancel)
      await drawerClosed()
    }
    await swipe('.chat-history', 24, 200, 104, 204)
    await drawerOpen()
    await swipe('.mobile-navigation-content', 180, 250, 90, 254)
    await drawerClosed()
    await touch('touchstart', 100)
    await touch('touchmove', 170)
    assert.ok(Math.abs(await drawerRight() - 70) <= 1, 'Drawer tracks a held finger before release, far from the screen edge')
    assert.equal(await execute('document.querySelector(".mobile-menu-trigger").getAttribute("aria-expanded")'), 'false')
    assert.equal(await execute('getComputedStyle(document.querySelector(".is-drawer .mobile-sheet")).transitionDuration'), '0s')
    await touch('touchmove', 260)
    assert.ok(Math.abs(await drawerRight() - 160) <= 1, 'Continued dragging advances the drawer one-to-one')
    await touch('touchend', 260)
    await wait(`Math.abs(document.querySelector('.is-drawer .mobile-sheet').getBoundingClientRect().left) < 1`)
    assert.equal(await execute('document.querySelector(".mobile-menu-trigger").getAttribute("aria-expanded")'), 'true')
    await touch('touchstart', 200, 220, '.mobile-navigation-content')
    await touch('touchmove', 120)
    assert.ok(Math.abs(await drawerRight() - 260) <= 1, 'Closing also follows the held finger')
    await touch('touchend', 120)
    await drawerClosed()
    await touch('touchstart', 100)
    await touch('touchmove', 140)
    assert.ok(Math.abs(await drawerRight() - 40) <= 1)
    await touch('touchend', 140)
    await drawerClosed()
    await touch('touchstart', 100)
    await touch('touchmove', 240)
    await touch('touchmove', 125)
    assert.ok(Math.abs(await drawerRight() - 25) <= 1, 'Reversing a held swipe pulls the drawer back')
    await touch('touchcancel', 125)
    await drawerClosed()
    await click('[aria-label="Conversation and document actions"]')
    await text('Message history', '.mobile-history summary')
    assert.ok(await execute(`${visible('.history-list .history-marker')}.getBoundingClientRect().height >= 44`))
    await click('.history-list .history-marker')
    await wait(`!${visible('.mobile-sheet[aria-label="Conversation and document actions"]')}`)
    await wait(`(() => {
      const container = ${visible('.chat-messages')}, message = ${visible('[data-msg-idx="0"]')};
      const bounds = container.getBoundingClientRect(), target = message.getBoundingClientRect();
      const aligned = container.scrollTop + target.top - bounds.top;
      const clamped = Math.max(0, Math.min(container.scrollHeight - container.clientHeight, aligned));
      return Math.abs(container.scrollTop - clamped) < 1 && target.top >= bounds.top - 1 && target.top < bounds.bottom;
    })()`)
    await execute(`{ const input = ${visible('.reference-composer')}; input.value='Unsent investigation draft'; input.dispatchEvent(new Event('input',{bubbles:true})); }`)
    await open()
    assert.deepEqual(await execute(`Array.from(document.querySelectorAll('.mobile-global-navigation .tab-nav button'), button => button.textContent.trim())`), ['Chat', 'Usage', 'Settings'])
    await text('Usage', '.mobile-global-navigation button')
    await drawerClosed()
    await wait(`window.__mobileFixture.router.currentRoute.value.name === 'usage' && !!${visible('.project-breakdown')}`)
    assert.equal(await execute(`document.querySelector('.project-filter [role=combobox]').textContent.trim()`), 'All projects')
    await open()
    await text('Settings', '.mobile-global-navigation button')
    await drawerClosed()
    await wait(`window.__mobileFixture.router.currentRoute.value.name === 'settings'`)
    await wait(`${visible('.mobile-document-title')}?.textContent.trim() === 'Settings'`)
    await text('Language', '.settings-navigation a')
    await wait(`!!${visible('#language-settings-title')}`)
    assert.equal(await execute(`(() => { const panel = ${visible('.app-settings-document')}; return panel.scrollWidth <= panel.clientWidth; })()`), true)
    await click('.mobile-document-title')
    await text('Usage', '[aria-label="Open views"] .mobile-view-row button')
    await wait(`${visible('.mobile-document-title')}?.textContent.trim() === 'Usage' && !!${visible('.project-breakdown')}`)
    await open()
    await text('Chat', '.mobile-global-navigation button')
    await drawerClosed()
    await wait(`${visible('.reference-composer')}?.value === 'Unsent investigation draft'`)
    await open()
    await text('Second investigation', '[data-project-id="work"] .session-select')
    await drawerClosed()
    await wait(`${visible('.mobile-document-title')}?.textContent.includes('Second investigation')`)
    await execute(`{ const input = ${visible('.reference-composer')}; input.value='Second cached draft'; input.dispatchEvent(new Event('input',{bubbles:true})); }`)
    await open()
    await text('First investigation', '[data-project-id="work"] .session-select')
    await drawerClosed()
    await wait(`${visible('.reference-composer')}?.value === 'Unsent investigation draft'`)
    await more('Session details')
    await wait(`!!${visible('[role="dialog"][aria-label="Session details"]')}`)
    assert.match(await execute(`${visible('.session-details')}.innerText`), /C:\\synthetic/)
    await wait(`${visible('[role="dialog"][aria-label="Session details"]')}.contains(document.activeElement)`)
    await escape()
    await wait(`!${visible('[role="dialog"][aria-label="Session details"]')}`)
    await more('Rename session')
    await wait(`!!${visible('input[aria-label="Session name"]')}`)
    assert.equal(await execute(`document.activeElement === ${visible('input[aria-label="Session name"]')}`), true,
      'Opening the rename sheet preserves input autofocus')
    await execute(`{ const input = ${visible('input[aria-label="Session name"]')}; input.value='Renamed on phone'; input.dispatchEvent(new Event('input',{bubbles:true})); }`)
    await text('Save', '.session-rename button')
    await wait(`${visible('.mobile-document-title')}?.textContent.includes('Renamed on phone')`)
    // Saving the inline rename form returns to Session details; dismiss that
    // dialog before exercising document shortcuts, which deliberately ignore overlays.
    await wait(`${visible('[role="dialog"][aria-label="Session details"]')}.contains(document.activeElement)`)
    await escape()
    await wait(`!${visible('[role="dialog"][aria-label="Session details"]')}`)
    // Exercise a reader away from the bottom. Within 32px ChatTab deliberately
    // follows the bottom when the composer dock is measured again after v-show.
    // Short platform-dependent text layout previously put scrollTop=60 only 7px
    // from the bottom on Linux, testing follow-bottom instead of scroll retention.
    await execute(`window.__retainedComposer = ${visible('.reference-composer')}; window.__retainedHistory = ${visible('.chat-messages')}; window.__retainedHistory.scrollTop = 60; window.__retainedScroll = window.__retainedHistory.scrollTop; void 0;`)
    assert.equal(await execute(`window.__retainedScroll === 60 && window.__retainedHistory.scrollHeight - window.__retainedScroll - window.__retainedHistory.clientHeight > 32`), true,
      'Scroll-retention fixture must be scrollable and outside the composer follow-bottom zone')
    await click('[aria-label="Switch view"]')
    assert.equal(await execute(`[...document.querySelectorAll('.mobile-view-row button')].filter(window.__isVisible).find(el => el.textContent.trim() === 'Diagnosis').getBoundingClientRect().height >= 44`), true)
    await text('Diagnosis', '.mobile-view-row button')
    await wait(`!!${visible('.session-diagnosis')}`)
    assert.equal(await execute(`!!${visible('.reference-composer')}`), false)
    assert.equal(await execute(`${visible('.mobile-document-title')}.textContent.trim()`), 'Diagnosis')
    await captureDiagnosis('mobile')
    await click('[id$="diagnosis-prompt-tab"]')
    await execute(`window.__retainedDiagnosis = ${visible('.session-diagnosis')}; void 0;`)
    await click('[aria-label="Conversation and document actions"]')
    assert.equal(await execute(`[...document.querySelectorAll('.mobile-workbench-actions button')].filter(window.__isVisible).filter(el => el.textContent.trim() === 'Diagnosis').length`), 1, 'The focused conversation exposes one Diagnosis action')
    await escape()
    await view('Renamed on phone')
    await wait(`!!${visible('.chat-history')}`)
    // Showing the retained v-show panel precedes completion of Chromium layout.
    // Require the same DOM nodes AND exact saved scroll position, not visibility alone.
    await wait(`${visible('.reference-composer')} === window.__retainedComposer && ${visible('.chat-messages')} === window.__retainedHistory && window.__retainedHistory.scrollTop === window.__retainedScroll`,
      `({ composerRetained: ${visible('.reference-composer')} === window.__retainedComposer, historyRetained: ${visible('.chat-messages')} === window.__retainedHistory,
        scrollTop: window.__retainedHistory.scrollTop, expectedScrollTop: window.__retainedScroll,
        scrollHeight: window.__retainedHistory.scrollHeight, clientHeight: window.__retainedHistory.clientHeight })`)
    await click('[aria-label="Message options"]')
    await wait(`!!${visible('[role="dialog"][aria-label="Message options"]')}`)
    assert.equal(await execute(`!!${visible('.mobile-message-settings')} && [...document.querySelectorAll('.context-action')].some(el => window.__isVisible(el) && el.textContent.includes('Add file') && !el.disabled)`), true)
    assert.match(await execute(`${visible('.mobile-message-settings')}.innerText`), /gpt-test/)
    await click('[aria-label="Choose model"]')
    await wait(`!!${visible('.mobile-sheet[aria-label="Choose model"]')}`)
    await resize(390, 530)
    assert.equal(await execute(`!!${visible('.mobile-sheet[aria-label="Choose model"]')}`), true,
      'Mobile model sheet survives keyboard-like viewport resize')
    await escape()
    assert.equal(await execute(`!!${visible('.mobile-sheet[aria-label="Message options"]')}`), true,
      'Dismissing a nested model sheet preserves Message options')
    await resize(390)
    await escape()
    assert.equal(await execute(`document.activeElement === ${visible('[aria-label="Message options"]')}`), true)
    await more('Browse files')
    await wait(`!!${visible('.project-file-explorer')}`)
    assert.ok(await execute(`${visible('.chat-history')}.getBoundingClientRect().width >= innerWidth - 1`), 'Opening files overlays rather than shrinking the phone conversation')
    await click('.project-file-explorer .root-toggle[aria-expanded="false"]')
    await text('notes.txt', '.project-file-explorer button')
    await wait(`${visible('.mobile-document-title')}?.textContent.includes('notes.txt')`)
    await wait(`${visible('.file-modal.inline')}?.innerText.includes('Synthetic document body')`)
    await view('Diagnosis')
    assert.equal(await execute(`${visible('.session-diagnosis')} === window.__retainedDiagnosis && ${visible('[id$="diagnosis-prompt-tab"]')}.getAttribute('aria-selected') === 'true'`), true, 'Opening Diagnosis directly from a file preserves its selected section')
    await view('notes.txt')
    await click('[aria-label="Switch view"]')
    await wait(`!!${visible('[role="dialog"][aria-label="Open views"]')}`)
    assert.equal(await execute(`!!${visible('[aria-label="Close notes.txt"]')}`), true)
    await text('Renamed on phone', '.mobile-view-row button')
    await wait(`${visible('.reference-composer')}?.value === 'Unsent investigation draft'`)
    await resize(1100)
    const editorTab = (name: string) => `[...document.querySelectorAll('.editor-tabs [role="tab"]')].find(el => window.__isVisible(el) && el.textContent.trim() === ${JSON.stringify(name)})`
    for (const theme of ['light', 'dark']) {
      await execute(`document.documentElement.classList.toggle('dark', ${theme === 'dark'})`)
      for (const label of ['Renamed on phone', 'Diagnosis', 'notes.txt']) assert.ok(await execute(`!!${editorTab(label)}`), `Shared desktop editor tabs retain ${label}`)
    }
    await execute(`${editorTab('Diagnosis')}.click()`)
    assert.equal(await execute(`${visible('.session-diagnosis')} === window.__retainedDiagnosis`), true)
    await click('[id$="diagnosis-trace-tab"]')
    await captureDiagnosis('desktop')
    await execute(`${editorTab('Renamed on phone')}.click()`)
    assert.equal(await execute(`${visible('.reference-composer')} === window.__retainedComposer && window.__retainedComposer.value === 'Unsent investigation draft'`), true)
    for (const width of [700, 701, 1100, 390]) {
      await resize(width)
      const mobile = width <= 700
      await wait(`!!${visible('.mobile-title-bar')} === ${mobile}`)
      assert.equal(await execute(`!!${visible('.desktop-title-bar')}`), !mobile)
      assert.equal(await execute(`!!${visible('.editor-workspace-header')}`), !mobile)
      assert.equal(await execute(`!!${visible('.conversation-heading-row')}`), !mobile)
      assert.equal(await execute(`${visible('.reference-composer')}?.value`), 'Unsent investigation draft')
      if (!mobile) {
        assert.equal(await execute(`!!${visible('.chat-history .message-history-rail')}`), true)
        assert.equal(await execute(`getComputedStyle(${visible('.chat-messages')}).scrollbarGutter`), 'stable both-edges')
      }
    }
    await execute(`window.__mobileFixture.router.push('/projects/work/chat')`)
    await wait(`!!${visible('.draft-heading')}`)
    await click('[aria-label="Switch view"]')
    assert.equal(await execute(`${visible('.mobile-document-title')}.textContent.includes('Diagnosis')`), false, 'A new draft never inherits the previous diagnosis selection; retained editors remain available in Open views')
    assert.equal(await execute(`!!${visible('.diagnosis-tab')}`), false)
    await escape()
    assert.deepEqual(await execute('window.__mobileFixture.errors'), [], 'No uncaught page errors')
    assert.deepEqual(errors, [], 'No renderer console errors')
    assert.deepEqual(external, [], 'No external network requests')
    assert.deepEqual(failures, [], 'Mobile focus regressions')
    console.log('MOBILE_NAVIGATION_OK')
  } finally {
    if (failures.length || errors.length) console.error(JSON.stringify({ failures, errors }))
    window.destroy(); app.quit()
  }
}

main().catch(error => { console.error(error); app.exit(1) })
