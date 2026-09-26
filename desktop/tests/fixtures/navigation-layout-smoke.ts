import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 2000, height: 844,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (code: string) => {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(50) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}\nActive: ${await execute('document.activeElement.outerHTML')}\nRail: ${await execute(`JSON.stringify((() => { const rail = document.querySelector('.message-history-rail'); return rail && {top:rail.scrollTop,height:rail.clientHeight,content:rail.scrollHeight,classes:rail.className}; })())`)}`)
  }
  try {
    await window.loadURL(new URL('__navigation', process.env.NAVIGATION_SMOKE_URL).href)
    await wait(`!!document.querySelector('.knowledge')`)
    await execute(`document.querySelector('.knowledge').append(Object.assign(document.createElement('div'), { style:'height:1800px', textContent:'Long knowledge content' }))`)
    for (const width of [2000, 1100, 390]) {
      window.setContentSize(width, 844)
      await execute(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      const layout = await execute(`(() => {
        const scroll = document.querySelector('.knowledge-scroll');
        const content = document.querySelector('.knowledge');
        return { right:scroll.getBoundingClientRect().right, viewport:innerWidth,
          width:content.getBoundingClientRect().width, scrollable:scroll.scrollHeight > scroll.clientHeight,
          outerOverflow:document.documentElement.scrollWidth > innerWidth,
          left:content.offsetLeft, expectedLeft:(scroll.clientWidth - content.offsetWidth) / 2 };
      })()`)
      assert.equal(layout.right, layout.viewport, 'Scrollbar container must reach the pane edge')
      assert(layout.width <= 1600, 'Content keeps its readable maximum width')
      assert(layout.scrollable)
      assert.equal(layout.outerOverflow, false)
      assert(Math.abs(layout.left - layout.expectedLeft) <= 1, 'Content stays centered inside the scrollport')
      await execute(`document.querySelector('.knowledge-scroll').scrollTop = 500`)
      assert.equal(await execute(`document.querySelector('.knowledge-scroll').scrollTop`), 500)
    }
    await execute(`document.querySelector('#switch').click()`)
    await wait(`document.querySelectorAll('.history-marker').length === 3`)
    const frame = () => execute(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    const atBottom = `(() => { const el = document.querySelector('.fixture-messages'); return el.scrollHeight - el.scrollTop - el.clientHeight < 2 })()`
    await execute(`window.__followConversation()`)
    await frame()
    assert.equal(await execute(atBottom), true, 'Opening a conversation follows the latest message')
    await execute(`document.querySelector('.fixture-messages').scrollTop -= 120`)
    await frame()
    const readingTop = await execute(`document.querySelector('.fixture-messages').scrollTop`)
    await execute(`window.__appendLiveMessage()`)
    await frame()
    assert.equal(await execute(`document.querySelector('.fixture-messages').scrollTop`), readingTop, 'New messages must not pull a reader away from older messages')
    await execute(`window.__streamLiveMessage(); window.__followConversation()`)
    await frame()
    assert.equal(await execute(`document.querySelector('.fixture-messages').scrollTop`), readingTop, 'Streaming chunks and completion must preserve the reading position')
    await execute(`{ const el = document.querySelector('.fixture-messages'); el.scrollTop = el.scrollHeight; }`)
    await frame()
    await execute(`window.__appendLiveMessage()`)
    await frame()
    assert.equal(await execute(atBottom), true, 'Returning to the bottom resumes following new messages')
    await execute(`window.__streamLiveMessage()`)
    await frame()
    assert.equal(await execute(atBottom), true, 'Streaming growth keeps following while the reader stays at the bottom')
    await execute(`window.__browseConversation(); window.__followConversation()`)
    await frame()
    assert.equal(await execute(`window.__conversationScrollState().historyBrowsing`), true, 'A rail jump starting at the bottom must remain paused until it leaves the bottom')
    await execute(`window.__navigationMessages.splice(4); document.querySelector('.fixture-messages').scrollTop = 0`)
    await frame()
    for (const width of [1100, 390]) {
      window.setContentSize(width, 844)
      await execute(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      const labels = await execute(`Array.from(document.querySelectorAll('.history-marker'), el => el.getAttribute('aria-label'))`)
      assert.match(labels[0], /User message from Alice/)
      assert.match(labels[1], /Session progress from Reviewer \(web:reviewer\)/)
      assert.match(labels[2], /Agent completed from Worker \(task:worker\)/)
      // Hidden Chromium windows update activeElement without delivering native focus events.
      await execute(`{ const marker = document.querySelectorAll('.history-marker')[1]; marker.focus(); marker.dispatchEvent(new FocusEvent('focus')); }`)
      await wait(`document.querySelector('[role="tooltip"]')?.textContent.includes('web:reviewer')`)
      await execute(`document.querySelectorAll('.history-marker')[1].dispatchEvent(new KeyboardEvent('keydown', { key:'ArrowDown', bubbles:true }))`)
      assert.equal(await execute(`document.activeElement === document.querySelectorAll('.history-marker')[2]`), true)
      await execute(`document.activeElement.dispatchEvent(new FocusEvent('focus'))`)
      await wait(`document.querySelector('[role="tooltip"]')?.textContent.includes('task:worker')`)
      assert.equal(await execute(`(() => { const r = document.querySelector('[role="tooltip"]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight })()`), true)
      await execute(`document.querySelectorAll('.history-marker')[2].click()`)
      await wait(`Math.abs(document.querySelector('[data-msg-idx="3"]').getBoundingClientRect().top - document.querySelector('.fixture-messages').getBoundingClientRect().top) < 2`)
      await execute(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }))`)
      await wait(`!document.querySelector('[role="tooltip"]')`)
      await execute(`document.querySelectorAll('.history-marker')[0].click()`)
      await wait(`document.querySelector('.fixture-messages').scrollTop < 2`)
    }
    await execute(`window.__navigationMessages.push(
      {role:'user',content:'First investigation',sessionSource:{id:'web:reviewer',intent:'progress'}},
      {role:'assistant',content:'Checking the evidence'},
      {role:'user',content:'Second investigation',sessionSource:{id:'web:other',intent:'progress'}},
      {role:'assistant',event:'tool_call',toolCallId:'budget',content:'',toolCall:{name:'ask',arguments:{question:'Allow six runs?',options:['Yes','No'],default_option:'No'}}},
      {role:'tool',event:'tool_result',toolCallId:'budget',content:JSON.stringify({requestId:'budget',option:'No',answeredBy:'timeout',answeredAt:'2026-09-21T10:00:00Z'})},
      {role:'assistant',event:'tool_call',toolCallId:'next',content:'',toolCall:{name:'ask',arguments:{question:'Continue local investigation?',options:['Yes','No'],default_option:'No'}}}
    ); window.__setPending({id:'next',sessionId:'web:owner',question:'Continue local investigation?',options:['Yes','No'],defaultOption:'No',recipient:{kind:'user',sessionId:'web:owner'},createdAt:'2026-09-21T10:01:00Z',deadline:null})`)
    await wait(`document.querySelectorAll('.history-marker').length === 6`)
    assert.equal(await execute(`document.querySelectorAll('.history-marker.collaboration').length`), 1)
    assert.equal(await execute(`document.querySelectorAll('.history-marker.decision').length`), 2)
    assert.equal(await execute(`Array.from(document.querySelectorAll('.history-marker.decision > span')).every(el => { const box = el.getBoundingClientRect(); const matrix = new DOMMatrix(getComputedStyle(el).transform); return box.width >= box.height * 3 && matrix.b === 0 && matrix.c === 0 })`), true, 'Decisions use horizontal rectangles, never rotated squares')
    assert.match(await execute(`document.querySelector('.history-marker.waiting-user').getAttribute('aria-label')`), /Needs your reply/)
    window.setContentSize(1100, 844)
    await execute(`document.querySelector('.history-marker.collaboration').click()`)
    await wait(`document.querySelectorAll('.history-preview .history-members button').length === 2`)
    assert.match(await execute(`document.querySelector('.history-preview-source').textContent`), /2 messages/)
    await execute(`document.querySelectorAll('.history-preview .history-members button')[1].click()`)
    await wait(`Math.abs(document.querySelector('[data-msg-idx="6"]').getBoundingClientRect().top - document.querySelector('.fixture-messages').getBoundingClientRect().top) < 2`)
    await execute(`document.querySelector('.history-marker.timeout').dispatchEvent(new MouseEvent('mouseenter'))`)
    await wait(`document.querySelector('.history-preview.decision')?.textContent.includes('Default selected by timeout')`)
    await execute(`document.querySelector('.history-marker.waiting-user').click()`)
    await wait(`Math.abs(document.querySelector('[data-msg-idx="9"]').getBoundingClientRect().top - document.querySelector('.fixture-messages').getBoundingClientRect().top) < 2`)
    await execute(`window.__setHistoryList(true)`)
    window.setContentSize(390, 844)
    await wait(`!!document.querySelector('.history-list')`)
    await execute(`document.querySelector('.history-list .collaboration').click()`)
    await wait(`document.querySelectorAll('.history-list .history-members button').length === 2`)
    await execute(`document.querySelectorAll('.history-list .history-members button')[0].click()`)
    await wait(`Math.abs(document.querySelector('[data-msg-idx="4"]').getBoundingClientRect().top - document.querySelector('.fixture-messages').getBoundingClientRect().top) < 2`)
    assert.equal(await execute(`getComputedStyle(document.querySelector('.message-history-rail')).maskImage`), 'none', 'Mobile history lists remain unmasked')
    await execute(`window.__setHistoryList(false); window.__navigationMessages.push(...Array.from({length:50}, (_,index) => ({role:'user',content:'Older message '+index})))`)
    await wait(`document.querySelectorAll('.history-marker').length > 50`)
    const rail = `document.querySelector('.message-history-rail')`
    await frame()
    await execute(`${rail}.scrollTop = 0`)
    await wait(`${rail}.classList.contains('can-scroll-down') && !${rail}.classList.contains('can-scroll-up')`)
    assert.match(await execute(`getComputedStyle(${rail}).maskImage`), /linear-gradient/)
    assert.equal(await execute(`getComputedStyle(${rail}).getPropertyValue('--history-fade-top').trim()`), '0px')
    assert.notEqual(await execute(`getComputedStyle(${rail}).getPropertyValue('--history-fade-bottom').trim()`), '0px')
    await execute(`${rail}.scrollTop = 150`)
    await wait(`${rail}.classList.contains('can-scroll-up') && ${rail}.classList.contains('can-scroll-down')`)
    await execute(`${rail}.scrollTop = ${rail}.scrollHeight`)
    await wait(`${rail}.classList.contains('can-scroll-up') && !${rail}.classList.contains('can-scroll-down')`)
    await execute(`${rail}.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))`)
    await wait(`!${rail}.classList.contains('can-scroll-up') && ${rail}.classList.contains('can-scroll-down')`)
    await execute(`document.activeElement.dispatchEvent(new FocusEvent('focus'))`)
    await wait(`!!document.querySelector('.history-preview')`)
    assert.equal(await execute(`getComputedStyle(document.querySelector('.history-preview')).maskImage`), 'none', 'Teleported previews are not faded')
    await execute(`${rail}.style.maxHeight = '2000px'`)
    await wait(`!${rail}.classList.contains('can-scroll-up') && !${rail}.classList.contains('can-scroll-down')`)
    await execute(`${rail}.style.maxHeight = '100px'`)
    await wait(`${rail}.classList.contains('can-scroll-down')`)
    await execute(`window.__navigationMessages.splice(4); window.__setPending(null); void 0`)
    await wait(`document.querySelectorAll('.history-marker').length === 3 && !${rail}.classList.contains('can-scroll-up') && !${rail}.classList.contains('can-scroll-down')`)
    await execute(`window.__navigationMessages.splice(0); void 0`)
    await wait(`!${rail}`)
    await execute(`window.__navigationMessages.push(...Array.from({length:50}, (_,index) => ({role:'user',content:'Restored message '+index})))`)
    await wait(`!!${rail}`)
    await frame()
    await execute(`${rail}.scrollTop = 0`)
    await wait(`${rail}.classList.contains('can-scroll-down') && !${rail}.classList.contains('can-scroll-up')`)
    await execute(`document.querySelector('#switch').click()`)
    await wait(`document.querySelectorAll('.node rect').length === 3 && !!document.querySelector('.composer-send')`)
    for (const width of [1100, 390]) {
      window.setContentSize(width, 844)
      await execute(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
      for (const radius of [0, 10]) {
        await execute(`document.documentElement.style.setProperty('--radius-surface', '${radius}px'); document.documentElement.style.setProperty('--radius-control', '${radius}px')`)
        const radii = await execute(`[
          ...Array.from(document.querySelectorAll('.node rect'), el => getComputedStyle(el).rx),
          ...Array.from(document.querySelectorAll('.resume-bar, .resume-button, .composer-send'), el => getComputedStyle(el).borderTopLeftRadius),
        ]`)
        assert.equal(radii.length, 6)
        assert(radii.every((value: string) => value === `${radius}px`), 'Graph, recovery and actions must follow live global token changes')
      }
      assert.equal(await execute(`document.querySelectorAll('.composer-submit button').length`), 1)
      const sendRect = await execute(`(() => { const r = document.querySelector('.composer-send').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height} })()`)
      await execute(`window.__composerFixture.canSend = false`)
      await wait(`document.querySelector('[aria-label="Send message"]')?.disabled`)
      await execute(`window.__composerFixture.canSend = true`)
      await wait(`!document.querySelector('[aria-label="Send message"]').disabled`)
      const sent = await execute(`window.__composerFixture.sent`)
      await execute(`document.querySelector('[aria-label="Send message"]').click()`)
      assert.equal(await execute(`window.__composerFixture.sent`), sent + 1)
      await execute(`window.__composerFixture.requestBusy = true; window.__composerFixture.canSend = false`)
      await wait(`!!document.querySelector('[aria-label="Stop current request"]')`)
      assert.equal(await execute(`document.querySelectorAll('.composer-submit button').length`), 1)
      assert.equal(await execute(`document.querySelector('[aria-label="Stop current request"]').disabled`), false, 'Empty draft must not disable Stop')
      const stopRect = await execute(`(() => { const r = document.querySelector('.composer-stop').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height} })()`)
      assert.deepEqual(stopRect, sendRect, 'Stop replaces Send without moving or resizing')
      const stopped = await execute(`window.__composerFixture.stopped`)
      await execute(`document.querySelector('.composer-stop').click()`)
      assert.equal(await execute(`window.__composerFixture.stopped`), stopped + 1)
      await execute(`window.__composerFixture.currentRequest.state.stopping = true`)
      await wait(`document.querySelector('.composer-stop')?.disabled`)
      assert.equal(await execute(`document.querySelector('.composer-stop').getAttribute('aria-busy')`), 'true')
      await execute(`document.querySelector('.composer-stop').click()`)
      assert.equal(await execute(`window.__composerFixture.stopped`), stopped + 1)
      await execute(`window.__composerFixture.currentRequest.state.stopping = false; window.__composerFixture.installation.uiScopes = []`)
      await wait(`document.querySelector('.composer-stop')?.disabled && !document.querySelector('.composer-stop').hasAttribute('aria-busy')`)
      await execute(`window.__composerFixture.requestBusy = false; window.__composerFixture.canSend = true; window.__composerFixture.installation.uiScopes = ['chat:write']`)
      await wait(`!!document.querySelector('[aria-label="Send message"]')`)
    }
    console.log('NAVIGATION_SMOKE_OK')
  } finally { window.destroy() }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
