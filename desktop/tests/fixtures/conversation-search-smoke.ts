import { withComposerTestAdapter } from './composer-test-adapter.ts'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, frame: false, width: 1100, height: 800,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const errors: string[] = []
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 2) errors.push(message) })
  const execute = (code: string) => window.webContents.executeJavaScript(withComposerTestAdapter(code))
  const wait = async (code: string, timeout = 12_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(50) }
    throw new Error(`Timed out: ${code}\n${await execute('JSON.stringify({width:innerWidth,height:innerHeight,scrollTop:document.querySelector(".chat-messages")?.scrollTop,scrollHeight:document.querySelector(".chat-messages")?.scrollHeight,rows:document.querySelectorAll("[data-history-row-key]").length})')}\n${await execute('document.body.innerText.slice(0,2000)')}\n${errors.slice(-10).join('\n')}`)
  }
  const key = (key: string, modifiers = '') => execute(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:${JSON.stringify(key)},bubbles:true,cancelable:true,${modifiers}}))`)
  const query = (value: string) => execute(`{const input=document.querySelector('.conversation-search input'); input.value=${JSON.stringify(value)}; input.dispatchEvent(new Event('input',{bubbles:true}));}`)
  const count = (value: string) => wait(`document.querySelector('.search-count')?.textContent === ${JSON.stringify(value)} && !document.querySelector('.search-error') && document.querySelector('.conversation-search')?.getAttribute('aria-busy') === 'false'${value === '0 / 0' ? '' : " && CSS.highlights.get('shadow-conversation-active')?.size > 0"}`)
  const highlighted = () => execute(`Array.from(CSS.highlights.get('shadow-conversation-active') || [],range=>range.toString())`)
  try {
    await window.loadURL(new URL('__search', process.env.CONVERSATION_SEARCH_URL).href)
    await wait(`document.querySelector('.chat-content')?.textContent.includes('当前消息')`)
    await execute(`{const input=document.querySelector('.reference-composer'); input.value='Unsent draft'; input.dispatchEvent(new Event('input',{bubbles:true})); input.focus();}`)
    await execute(`{const dialog=document.createElement('div'); dialog.id='fixture-dialog'; dialog.setAttribute('role','dialog'); dialog.textContent='Synthetic active dialog'; document.body.append(dialog);}`)
    assert.equal(await key('f', 'ctrlKey:true'), true, 'Search does not steal shortcuts from a dialog')
    assert.equal(await execute(`!!document.querySelector('.conversation-search')`), false)
    await execute(`document.getElementById('fixture-dialog').remove()`)
    assert.equal(await key('f', 'ctrlKey:true'), false, 'Ctrl+F is handled, not passed to browser find')
    await wait(`document.activeElement === document.querySelector('.conversation-search input')`)
    await execute(`document.activeElement.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))`)
    await query('historical')
    await delay(200)
    assert.equal(await execute(`CSS.highlights.has('shadow-conversation-active')`), false, 'IME composition does not navigate provisional text')
    await key('Enter', 'isComposing:true,keyCode:229')
    await execute(`document.activeElement.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))`)
    await count('1 / 4')
    assert.deepEqual(await highlighted(), ['historical'], 'Match crosses Markdown inline elements')
    assert.equal(await execute(`document.querySelector('.chat-messages').scrollTop < 80`), true, 'Older match is visible near the start of its segment')
    await key('Enter')
    await count('2 / 4')
    assert.deepEqual(await highlighted(), ['HISTORICAL'])
    await key('Enter')
    await count('3 / 4')
    assert.equal(await execute(`document.querySelector('.compaction-summary').open`), true, 'Search reveals lazy folded historical summaries')
    await key('Enter')
    await count('4 / 4')
    assert.deepEqual(await highlighted(), ['historical'])
    assert.equal(await execute(`document.querySelector('.reference-composer').value`), 'Unsent draft')
    assert.equal(await execute(`!!document.querySelector('.prose a[href="note.md"]')`), true, 'Search preserves markup and links')
    await key('Enter')
    await count('1 / 4')
    await key('Enter', 'shiftKey:true')
    await count('4 / 4')
    await key('f', 'ctrlKey:true')
    assert.equal(await execute(`document.querySelector('.conversation-search input').selectionEnd`), 10)
    await query('.*[b]')
    await count('1 / 1')
    assert.deepEqual(await highlighted(), ['.*[b]'])
    await query('中文搜索')
    await count('1 / 1')
    assert.deepEqual(await highlighted(), ['中文搜索'])
    for (const width of [1100, 390]) {
      window.setContentSize(width, 800)
      await wait(`Math.abs(innerWidth-${width})<=2`)
      if (width === 390) await wait(`document.querySelector('.conversation-search').getBoundingClientRect().width >= innerWidth - 32`)
      for (const dark of [false, true]) {
        await execute(`document.documentElement.classList.toggle('dark',${dark})`)
        await delay(50)
        const layout = await execute(`(() => {const bar=document.querySelector('.conversation-search'); const controls=bar.querySelector('.search-controls'); return {
          overflow:controls.scrollWidth>controls.clientWidth, inputWidth:bar.querySelector('input').getBoundingClientRect().width,
          count:getComputedStyle(bar.querySelector('.search-count')).color, buttons:[...bar.querySelectorAll('.search-controls button')].map(button=>button.getBoundingClientRect().width)
        };})()`)
        assert.equal(layout.overflow, false, JSON.stringify(layout))
        assert(layout.inputWidth > 40, JSON.stringify(layout))
        assert(layout.buttons.every((size: number) => size >= (width === 390 ? 44 : 32)))
        if (process.env.CONVERSATION_SEARCH_SCREENSHOT_DIR) await writeFile(join(process.env.CONVERSATION_SEARCH_SCREENSHOT_DIR, `search-${width}-${dark ? 'dark' : 'light'}.png`), (await window.webContents.capturePage()).toPNG())
      }
    }
    await query('not-found-anywhere')
    await count('0 / 0')
    assert.equal(await execute(`document.querySelector('[aria-label="Next match"]').disabled`), true)
    assert.equal(await execute(`CSS.highlights.has('shadow-conversation-active')`), false)
    await key('Escape')
    await wait(`!document.querySelector('.conversation-search')`)
    assert.equal(await execute(`document.activeElement === document.querySelector('.reference-composer')`), true, 'Escape restores the composer even after historical navigation remounts it')
    await execute(`document.querySelector('.diagnosis-tab [role="tab"]').click()`)
    await wait(`document.querySelector('.diagnosis-tab [role="tab"]').getAttribute('aria-selected') === 'true'`)
    assert.equal(await key('f', 'ctrlKey:true'), true, 'Diagnosis does not open conversation search')
    assert.equal(await execute(`!!document.querySelector('.conversation-search')`), false)
    await execute(`document.querySelector('.conversation-tab [role="tab"]').click()`)
    window.setContentSize(1100, 800)
    await execute(`window.__searchFixture.state.childSessionId='web:child'`)
    await wait(`document.querySelector('.child-conversation .chat-content')?.textContent.includes('Child-only')`)
    await execute(`document.querySelector('.child-conversation .chat-messages').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`)
    await key('f', 'metaKey:true')
    await wait(`!!document.querySelector('.child-conversation .conversation-search')`)
    assert.equal(await execute(`!!document.querySelector('.primary-conversation .conversation-search')`), false)
    await query('Child-only')
    await count('1 / 1')
    await key('Escape')
    await execute(`window.__searchFixture.state.childSessionId=''`)
    await wait(`!document.querySelector('.child-conversation')`)
    await execute(`document.querySelector('.reference-composer').focus()`)
    await execute(`fetch('/__fail?value=true')`)
    await key('f', 'ctrlKey:true')
    await query('historical')
    await wait(`document.querySelector('.search-error')?.textContent.includes('503')`)
    assert.equal(await execute(`document.querySelector('.search-count').textContent`), '0 / 0', 'A failed history segment cannot produce a complete-looking result count')
    await execute(`fetch('/__fail?value=false'); document.querySelector('.search-error button').click()`)
    await count('1 / 4')
    await execute(`window.__searchFixture.state.visible=false`)
    await wait(`!document.querySelector('.conversation-search')`)
    assert.equal(await execute(`CSS.highlights.has('shadow-conversation-active')`), false)
    await execute(`window.__searchFixture.state.visible=true`)
    await wait(`!!document.querySelector('.conversation-find')`)
    await execute(`document.querySelector('.conversation-find').click()`)
    await wait(`!!document.querySelector('.conversation-search')`)
    await execute(`window.__searchFixture.select('web:chat-two')`)
    await wait(`!document.querySelector('.conversation-search') && document.querySelector('.chat-content')?.textContent.includes('Second conversation')`)
    assert.equal(await execute(`CSS.highlights.has('shadow-conversation-active')`), false)
    // A cached, fully mounted math/table history must not lay out every subtree
    // when returning from settings. This uses real ChatWorkspace/ChatTab rows.
    await execute(`window.__searchFixture.select('web:chat-heavy')`)
    await wait(`document.querySelectorAll('[data-history-row-key]').length === 48`, 45_000)
    await wait(`(() => {const e=document.querySelector('.chat-messages');return e.scrollHeight-e.scrollTop-e.clientHeight<32})()`)
    const skipped = await execute(`Array.from(document.querySelectorAll('.chat-message-entry .chat-content')).filter(e => !e.checkVisibility({contentVisibilityAuto:true})).length`)
    assert(skipped > 32, `Offscreen history should skip rendering, skipped only ${skipped}/48 rows`)
    const forcedReads = await execute(`(async () => {
      const original=Element.prototype.getBoundingClientRect; let reads=0;
      Element.prototype.getBoundingClientRect=function() {
        if(this.matches('[data-msg-idx]') && this.closest('[data-history-row-key]') && !this.checkVisibility({contentVisibilityAuto:true})) reads++;
        return original.call(this);
      };
      try {
        const container=document.querySelector('.chat-messages');container.scrollTop-=400;
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        container.scrollTop=container.scrollHeight;
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        return reads;
      } finally {Element.prototype.getBoundingClientRect=original}
    })()`)
    assert.equal(forcedReads, 0, 'Passive rail tracking must not force layout of skipped message descendants')
    await wait(`(() => {const e=document.querySelector('.chat-messages');return e.scrollHeight-e.scrollTop-e.clientHeight<32})()`)
    await execute(`window.__retainedHistoryRow=document.querySelector('[data-history-row-key]'); const input=document.querySelector('.reference-composer'); input.value='Retained heavy-history draft'; input.dispatchEvent(new Event('input',{bubbles:true}));`)
    await execute(`window.__searchFixture.settings(true)`)
    await wait(`!!document.getElementById('fixture-settings') && !document.querySelector('.chat-messages')`)
    const restoredAt = Date.now()
    await execute(`window.__searchFixture.settings(false)`)
    await wait(`document.querySelectorAll('[data-history-row-key]').length === 48`)
    await wait(`(() => {const e=document.querySelector('.chat-messages');return e.scrollHeight-e.scrollTop-e.clientHeight<32})()`)
    assert.equal(await execute(`window.__retainedHistoryRow===document.querySelector('[data-history-row-key]')`), true, 'KeepAlive retains row/component state, rather than remounting all messages')
    assert.equal(await execute(`document.querySelector('.reference-composer').value`), 'Retained heavy-history draft')
    console.log('HISTORY_RESTORE_MS', Date.now() - restoredAt, 'SKIPPED_ROWS', skipped)
    // Search must unlock an old skipped row and still highlight its real text.
    await execute(`document.querySelector('.reference-composer').focus()`)
    await key('f', 'ctrlKey:true')
    await query('UniqueOldHistoryTarget')
    await count('1 / 1')
    assert.deepEqual(await highlighted(), ['UniqueOldHistoryTarget'])
    assert.equal(await execute(`document.querySelector('.chat-messages').scrollTop < 80`), true)
    await key('Escape')
    await execute(`window.__searchFixture.settings(true)`)
    await wait(`!!document.getElementById('fixture-settings')`)
    await execute(`window.__searchFixture.settings(false)`)
    await wait(`!!document.querySelector('.chat-messages')`)
    assert.equal(await execute(`document.querySelector('.chat-messages').scrollTop < 80`), true, 'Reactivation preserves intentional historical browsing')
    // Jump to a middle row that was skipped, not only the first/last rows.
    await execute(`document.querySelectorAll('.history-marker')[3].click()`)
    await wait(`(() => {const e=document.querySelector('[data-msg-idx="24"]');const c=document.querySelector('.chat-messages');const top=e.getBoundingClientRect().top-c.getBoundingClientRect().top;return top>=-2 && top<80})()`)
    const browsingTop = await execute(`document.querySelector('.chat-messages').scrollTop`)
    await execute(`window.__searchFixture.settings(true)`)
    await wait(`!!document.getElementById('fixture-settings')`)
    await execute(`window.__searchFixture.settings(false)`)
    await wait(`!!document.querySelector('.chat-messages') && Math.abs(document.querySelector('.chat-messages').scrollTop-${browsingTop})<2`)
    // Rail navigation reads the target only, and passive tracking must not
    // defeat containment by measuring every offscreen descendant.
    await execute(`document.querySelector('.history-marker').click()`)
    await wait(`document.querySelector('.chat-messages').scrollTop < 80`)
    for (const width of [1100, 390]) {
      window.setContentSize(width, 800)
      await wait(`Math.abs(innerWidth-${width})<=2`)
      const geometry = await execute(`(() => {const row=document.querySelector('.chat-message-entry');const bubble=row.querySelector('.chat-user');const a=row.getBoundingClientRect(),b=bubble.getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth,rightGap:a.right-b.right,width:b.width,rowWidth:a.width}})()`)
      assert.equal(geometry.overflow, false, JSON.stringify(geometry))
      assert(Math.abs(geometry.rightGap) < 2 && geometry.width <= geometry.rowWidth, JSON.stringify(geometry))
    }
    console.log('CONVERSATION_SEARCH_OK')
  } finally {
    window.destroy()
  }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
