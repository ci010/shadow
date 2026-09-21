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
  const errors: string[] = []
  window.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const frame = () => execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const wait = async (code: string) => {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(50) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}\n${errors.join('\n')}`)
  }
  const screenshot = async (name: string) => {
    if (process.env.CONVERSATION_SCREENSHOTS) {
      await writeFile(join(process.env.CONVERSATION_SCREENSHOTS, `${name}.png`), (await window.webContents.capturePage()).toPNG())
    }
  }
  try {
    await window.loadURL(new URL('__conversation', process.env.CONVERSATION_SMOKE_URL).href)
    await wait(`!!document.querySelector('.conversation-skeleton')`)
    assert.equal(await execute(`document.querySelector('.conversation-skeleton').getAttribute('role')`), 'status')
    assert.equal(await execute(`document.querySelector('.skeleton-thread').getAttribute('aria-hidden')`), 'true')
    // Simulate document visibility without focusing the hidden test window.
    await execute(`Object.defineProperty(document, 'hidden', { configurable:true, value:true }); document.dispatchEvent(new Event('visibilitychange'))`)
    await frame()
    assert.equal(await execute(`getComputedStyle(document.querySelector('.skeleton-message i')).animationPlayState`), 'paused')
    await execute(`Object.defineProperty(document, 'hidden', { configurable:true, value:false }); document.dispatchEvent(new Event('visibilitychange'))`)
    await frame()
    assert.equal(await execute(`getComputedStyle(document.querySelector('.skeleton-message i')).animationPlayState`), 'running')
    await screenshot('conversation-loading')
    await execute(`window.__conversationFixture.visible = false`)
    await frame()
    assert.equal(await execute(`getComputedStyle(document.querySelector('.skeleton-message i')).animationPlayState`), 'paused')
    await execute(`window.__conversationFixture.visible = true`)
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await frame()
    assert.equal(await execute(`getComputedStyle(document.querySelector('.skeleton-message i')).animationName`), 'none')
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    window.webContents.debugger.detach()
    await execute(`window.__showConversation()`)
    await wait(`!!document.querySelector('.message-action') && !document.querySelector('.conversation-skeleton')`)
    assert.equal(await execute(`document.querySelectorAll('.message-action').length`), 1)
    assert.equal(await execute(`document.querySelectorAll('.tool-activity').length`), 1)
    assert.match(await execute(`document.querySelector('.tool-activity').textContent`), /View file.ts/)
    assert.equal(await execute(`document.querySelector('.message-action-status').textContent`), 'Queued')
    assert.equal(await execute(`document.querySelector('.message-action strong').textContent`), 'the changes')
    assert.equal(await execute(`document.querySelectorAll('.yield-decision').length`), 1)
    assert.match(await execute(`document.querySelector('.yield-decision').textContent`), /Default selected by timeout/)
    assert.equal(await execute(`document.querySelector('.yield-decision').getAttribute('data-msg-idx')`), '7')
    assert.equal(await execute(`document.querySelectorAll('.yield-decision button, .yield-decision input').length`), 0, 'Historical decisions cannot submit answers')
    await execute(`window.__conversationFixture.messages[1].content = 'Routine progress. '.repeat(60)`)
    await wait(`!!document.querySelector('.collaboration-message')`)
    assert.equal(await execute(`!!document.querySelector('.collaboration-message .prose')`), false, 'Long routine progress does not mount hidden Markdown')
    await execute(`document.querySelector('.collaboration-message').open = true`)
    await wait(`!!document.querySelector('.collaboration-message .prose')`)
    await execute(`window.__conversationFixture.messages[1].sessionSource.intent = 'question'`)
    await wait(`!document.querySelector('.collaboration-message')`)
    assert.match(await execute(`document.querySelector('.chat-session').textContent`), /Routine progress/)
    await execute(`window.__conversationFixture.messages[1].content = 'I will review the changes and send feedback shortly.'; window.__conversationFixture.messages[1].sessionSource.intent = 'acknowledgement'`)
    for (const width of [1800, 1100, 390]) {
      window.setContentSize(width, 844)
      for (const dark of [false, true]) {
        await execute(`document.documentElement.classList.toggle('dark', ${dark})`)
        await frame()
        const layout = await execute(`(() => {
          const list = document.querySelector('.chat-message-list').getBoundingClientRect();
          const user = document.querySelector('.chat-user:not(.chat-session)').getBoundingClientRect();
          const incoming = document.querySelector('.chat-session').getBoundingClientRect();
          const action = document.querySelector('.message-action').getBoundingClientRect();
          const content = document.querySelector('.message-action-content').getBoundingClientRect();
          const prose = document.querySelector('.message-action-content .prose').getBoundingClientRect();
          return { userRight:user.right, incomingRight:incoming.right, listLeft:list.left,
            actionLeft:action.left, actionWidth:action.width, listWidth:list.width,
            contentWidth:content.width, proseWidth:prose.width,
            proseMaxWidth:getComputedStyle(document.querySelector('.message-action-content .prose')).maxWidth,
            userProseMaxWidth:getComputedStyle(document.querySelector('.chat-user .prose')).maxWidth,
            overflow:document.documentElement.scrollWidth > innerWidth,
            actionOverflow:document.querySelector('.message-action').scrollWidth > document.querySelector('.message-action').clientWidth };
        })()`)
        assert(Math.abs(layout.userRight - layout.incomingRight) < 1, 'Incoming peer messages align with human messages on the right')
        assert(Math.abs(layout.actionLeft - layout.listLeft) < 1, 'Outgoing actions stay in the assistant column')
        assert(layout.actionWidth <= layout.listWidth * .8 + 1)
        assert(Math.abs(layout.proseWidth - layout.contentWidth) < 1, 'The card fits its readable Markdown instead of leaving a wide empty right side')
        assert.notEqual(layout.proseMaxWidth, 'none', 'Outgoing message Markdown retains its reading measure')
        if (width === 1800) assert(layout.actionWidth < layout.listWidth * .6, 'Wide panes do not stretch message actions to panel width')
        assert.notEqual(layout.userProseMaxWidth, 'none', 'Other message prose retains its reading measure')
        assert.equal(layout.overflow, false)
        assert.equal(layout.actionOverflow, false)
        const colors = await execute(`(() => {
          const root = getComputedStyle(document.documentElement);
          const token = name => { const el = document.createElement('span'); el.style.color = root.getPropertyValue(name); document.body.append(el); const value = getComputedStyle(el).color; el.remove(); return value };
          const style = selector => getComputedStyle(document.querySelector(selector));
          return {
            foreground:style('.chat-assistant').color, expectedForeground:token('--c-text'),
            assistant:style('.chat-assistant').backgroundColor, expectedAssistant:token('--c-bg-card'),
            user:style('.chat-user').backgroundColor, expectedUser:token('--c-info-bg'),
            peer:style('.chat-session').backgroundColor, expectedPeer:token('--c-bg-soft'),
            decision:style('.yield-decision').borderLeftColor, expectedDecision:token('--c-purple'),
            action:style('.message-action').backgroundColor, expectedAction:token('--c-bg-soft'),
            source:style('.chat-session-source strong').color, secondary:token('--c-text-secondary'),
            thinking:style('.thinking-header').color,
            shadow:style('.chat-assistant').boxShadow,
            stages:Object.fromEntries(['idle','llm','tool','waiting','completed','failed'].map(stage => [stage, style('.fixture-stages .' + stage).color])),
            warning:token('--c-warn'), success:token('--c-success'), error:token('--c-error'),
          };
        })()`)
        assert.equal(colors.foreground, colors.expectedForeground)
        assert.equal(colors.assistant, colors.expectedAssistant)
        assert.equal(colors.user, colors.expectedUser)
        assert.equal(colors.peer, colors.expectedPeer)
        assert.notEqual(colors.user, colors.peer, 'Human input and peer coordination have distinct surfaces')
        assert.equal(colors.decision, colors.expectedDecision)
        assert.equal(colors.action, colors.expectedAction)
        assert.equal(colors.source, colors.secondary)
        assert.equal(colors.thinking, colors.secondary)
        assert.equal(colors.shadow, 'none')
        for (const stage of ['idle', 'llm', 'tool']) assert.equal(colors.stages[stage], colors.secondary)
        assert.equal(colors.stages.waiting, colors.warning)
        assert.equal(colors.stages.completed, colors.success)
        assert.equal(colors.stages.failed, colors.error)
        await screenshot(`conversation-${width}-${dark ? 'dark' : 'light'}`)
      }
    }
    await execute(`window.__conversationFixture.messages[8].content = JSON.stringify({requestId:'budget',option:'Only investigate for now',custom:true,answeredBy:'user',answeredAt:'2026-09-21T10:00:00Z'})`)
    await wait(`document.querySelector('.yield-decision').textContent.includes('Custom response')`)
    assert.match(await execute(`document.querySelector('.decision-status').textContent`), /Answered by user/)
    assert.match(await execute(`document.querySelector('.decision-answer').textContent`), /Only investigate for now/)
    await execute(`window.__conversationFixture.messages[8].content = 'Error: Yield cancelled by user.'`)
    await wait(`document.querySelector('.decision-status').textContent.includes('did not complete')`)
    await execute(`void window.__conversationFixture.messages.splice(8, 1)`)
    await wait(`document.querySelector('.decision-status').textContent.includes('No confirmed answer')`)
    const target = '.message-recipient'
    await execute(`document.querySelector('${target}').focus()`)
    assert.equal(await execute(`document.activeElement.matches('${target}')`), true)
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r',
    })
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
    })
    await wait(`window.__conversationFixture.navigation.length === 1`)
    window.webContents.debugger.detach()
    assert.deepEqual(await execute(`JSON.parse(JSON.stringify(window.__conversationFixture.navigation[0]))`), { event: 'navigate', id: 'web:peer' })
    await execute(`window.__conversationFixture.embedded = true; document.querySelector('${target}').click()`)
    assert.deepEqual(await execute(`JSON.parse(JSON.stringify(window.__conversationFixture.navigation[1]))`), { event: 'child-navigation', id: 'web:peer' })
    await execute(`document.querySelector('.chat-session-source').click()`)
    assert.deepEqual(await execute(`JSON.parse(JSON.stringify(window.__conversationFixture.navigation[2]))`), { event: 'child-navigation', id: 'web:peer' })
    await execute(`window.__conversationFixture.decisionRecords = [{
      request: { id:'budget', sessionId:'web:owner', question:'Increase the experiment budget?',
        options:['Six runs','Four runs'], defaultOption:'Four runs', recipient:{kind:'user',sessionId:'web:owner'},
        createdAt:'2026-09-21T10:00:00Z', deadline:null, origin:{physicalId:'owner-0',toolCallId:'decision'},
        sources:[{sessionId:'web:peer',physicalId:'worker-segment-0',requestId:'worker-budget'}] }
    }]`)
    await wait(`!!document.querySelector('.decision-source summary')`)
    await execute(`document.querySelector('.decision-source').open = true`)
    await wait(`document.querySelector('.source-question')?.textContent.includes('exceeding the four-run budget')`)
    assert.match(await execute(`document.querySelector('.decision-source').textContent`), /not proof of causation or permission/)
    assert.equal(await execute(`document.querySelectorAll('.decision-source input').length`), 0)
    assert.equal(await execute(`document.querySelector('.decision-source button').textContent`), 'Open source session')
    assert.match(await execute(`document.querySelector('.decision-source').textContent`), /does not indicate an active wait/)
    assert.equal(await execute(`document.documentElement.scrollWidth > innerWidth`), false)
    await execute(`document.querySelector('.decision-source button').click()`)
    assert.deepEqual(await execute(`JSON.parse(JSON.stringify(window.__conversationFixture.navigation[3]))`), { event: 'child-navigation', id: 'web:peer' })
    assert.equal(await execute(`document.querySelectorAll('.graph-node').length`), 0, 'Graphs stay lazy until opened')
    await execute(`document.querySelector('.decision-graph').open = true`)
    await wait(`document.querySelectorAll('.graph-node').length === 2`)
    assert.match(await execute(`document.querySelector('.decision-graph').textContent`), /not a verified cause/)
    await execute(`const node = document.querySelectorAll('.graph-node')[1]; node.focus(); node.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true}))`)
    await wait(`document.querySelector('.graph-inspector').textContent.includes('exceeding the four-run budget')`)
    assert.equal(await execute(`document.querySelectorAll('.decision-graph input, .decision-graph textarea').length`), 0)
    assert.equal(await execute(`document.documentElement.scrollWidth > innerWidth`), false, 'Expanded graph remains bounded on mobile')
    assert.equal(await execute(`document.querySelector('.decision-graph-scroll').scrollWidth > document.querySelector('.decision-graph-scroll').clientWidth`), true)
    await execute(`document.querySelector('.decision-discussion').open = true`)
    await wait(`document.querySelector('.decision-discussion').textContent.includes('No discussions have been recorded')`)
    assert.equal(await execute(`document.querySelectorAll('.decision-discussion textarea').length`), 0, 'Historical discussion is read-only')
    await execute(`window.__conversationFixture.decisionRecords[0].request.sources[0].requestId = 'missing-record'`)
    await frame()
    await execute(`document.querySelector('.decision-source').open = true`)
    await wait(`document.querySelector('.decision-source [role="alert"]')?.textContent.includes('does not match')`)
    assert.equal(await execute(`!!document.querySelector('.source-question')`), false, 'A failed source lookup must not display a stale question')
    await execute(`window.__conversationFixture.messages[3].content = 'Message sent to web:peer (silent). Recorded only.'`)
    await wait(`document.querySelector('.message-action-status').textContent === 'Recorded silently'`)
    assert.match(await execute(`document.querySelector('.message-action-note').textContent`), /will not be woken/)
    await execute(`window.__conversationFixture.messages[3].content = 'Error: peer is unavailable'`)
    await wait(`document.querySelector('.message-action-status').textContent === 'Failed'`)
    assert.match(await execute(`document.querySelector('.message-action-note').textContent`), /peer is unavailable/)
    await execute(`document.querySelector('.message-action-details').open = true`)
    await wait(`document.querySelector('.message-action-details').textContent.includes('Error: peer is unavailable')`)
    await execute(`void window.__conversationFixture.messages.splice(3, 1)`)
    await wait(`document.querySelector('.message-action-status').textContent === 'No result recorded'`)
    await execute(`window.__conversationFixture.streaming = true`)
    await wait(`document.querySelector('.message-action-status').textContent === 'Sending...'`)
    await execute(`window.__conversationFixture.messages[2].toolCall.arguments.sessionId = ''`)
    await wait(`!document.querySelector('.message-recipient')`)
    assert.match(await execute(`document.querySelector('.message-action').textContent`), /Unknown recipient/)
    await execute(`window.__showCompaction()`)
    await wait(`!!document.querySelector('.history-disclosure') && document.querySelector('.heading-folder')?.textContent === 'review'`)
    assert.equal(await execute(`!!document.querySelector('.compaction-summary-body')`), false, 'Summary Markdown stays lazy')
    assert.equal(await execute(`!!document.querySelector('.topic-metadata, .coordination-description')`), false)
    for (const width of [1100, 390]) {
      window.setContentSize(width, 844)
      for (const dark of [false, true]) {
        await execute(`document.documentElement.classList.toggle('dark', ${dark}); document.querySelector('.history-disclosure').open = false`)
        await frame()
        assert.equal(await execute(`document.querySelector('.session-heading').getBoundingClientRect().height <= 60`), true, 'Initiative context must not add a heading row')
        await screenshot(`compaction-${width}-${dark ? 'dark' : 'light'}-collapsed`)
        await execute(`document.querySelector('.history-disclosure').open = true; document.querySelector('.compaction-summary-header').click()`)
        await wait(`!!document.querySelector('.compaction-summary-body h3')`)
        const continuity = await execute(`(() => {
          const nav = document.querySelector('.segment-nav');
          const traces = document.querySelector('.history-disclosure');
          const summary = document.querySelector('.compaction-summary');
          const body = document.querySelector('.compaction-summary-body');
          return {
            widths:[nav, traces, summary].map(el => el.getBoundingClientRect().width),
            lefts:[nav, traces, summary].map(el => el.getBoundingClientRect().left),
            backgrounds:[nav, ...document.querySelectorAll('.segment-nav-btn, .history-execution')].map(el => getComputedStyle(el).backgroundColor),
            fontSizes:[traces.querySelector('summary'), summary.querySelector('summary')].map(el => getComputedStyle(el).fontSize),
            overflow:document.documentElement.scrollWidth > innerWidth,
            rowsOverflow:[...document.querySelectorAll('.history-execution')].some(el => el.scrollWidth > el.clientWidth + 1),
            summaryOverflow:body.scrollWidth > body.clientWidth + 1,
            summaryMaxHeight:getComputedStyle(body).maxHeight,
            icons:[...document.querySelectorAll('.history-chevron, .history-execution > .i-lucide-arrow-up-right')].every(el => getComputedStyle(el).maskImage !== 'none'),
          };
        })()`)
        assert(continuity.widths.every((value: number) => Math.abs(value - continuity.widths[0]) < 1), 'All history controls share the conversation rail')
        assert(continuity.lefts.every((value: number) => Math.abs(value - continuity.lefts[0]) < 1))
        assert(continuity.backgrounds.every((value: string) => value === 'rgba(0, 0, 0, 0)'), 'History navigation is not a primary blue action')
        assert.deepEqual(continuity.fontSizes, ['12px', '12px'])
        assert.equal(continuity.overflow, false)
        assert.equal(continuity.rowsOverflow, false)
        assert.equal(continuity.summaryOverflow, false)
        assert.equal(continuity.summaryMaxHeight, 'none')
        assert.equal(continuity.icons, true)
        await screenshot(`compaction-${width}-${dark ? 'dark' : 'light'}-expanded`)
        await execute(`document.querySelector('.compaction-summary-header').click(); document.querySelector('.session-heading .composer-control').click()`)
        await wait(`!!document.querySelector('.details-topic')`)
        assert.equal(await execute(`document.querySelector('.composer-popover').getBoundingClientRect().width === Math.min(520, innerWidth - 24)`), true, 'Session details use a wider reading measure without overflowing narrow viewports')
        assert.match(await execute(`document.querySelector('.details-topic').textContent`), /Initiative.*Goal.*Scope.*Out of scope/s)
        assert.match(await execute(`document.querySelector('.details-topic').textContent`), /Do not publish or change the source materials/)
        assert.equal(await execute(`(() => {
          const panel = document.querySelector('.composer-popover'); const rect = panel.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= innerWidth && panel.scrollWidth <= panel.clientWidth + 1;
        })()`), true)
        await screenshot(`compaction-${width}-${dark ? 'dark' : 'light'}-details`)
        await execute(`document.querySelector('.composer-popover').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))`)
        await wait(`!document.querySelector('.composer-popover')`)
        assert.equal(await execute(`document.activeElement.matches('.session-heading .composer-control')`), true)
      }
    }
    await execute(`document.querySelector('.history-execution').focus()`)
    assert.equal(await execute(`document.activeElement.matches('.history-execution')`), true)
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await wait(`window.__conversationFixture.navigation.length === 1`)
    window.webContents.debugger.detach()
    assert.deepEqual(await execute(`JSON.parse(JSON.stringify(window.__conversationFixture.navigation[0]))`), { event: 'navigate', id: 'web:peer' })
    await execute(`document.querySelector('.segment-nav-btn').click()`)
    await wait(`document.querySelector('.segment-nav-label')?.textContent === 'Viewing previous session'`)
    await execute(`document.querySelector('.segment-nav-btn').click()`)
    await wait(`document.querySelector('.segment-nav-btn')?.textContent.includes('View previous session')`)
    await execute(`window.__conversationFixture.activeSessionId = 'web:orchestrator'; window.__conversationFixture.headingTopic = undefined`)
    await frame()
    await execute(`document.querySelector('.session-heading .composer-control').click()`)
    await wait(`document.querySelector('.details-topic')?.textContent.includes('Coordinate this Project here')`)
    assert.equal(await execute(`document.querySelector('.session-heading').textContent.includes('Topics are independent')`), false)
    await execute(`document.querySelector('.composer-popover').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); window.__conversationFixture.activeSessionId = 'web:plain'`)
    await frame()
    await execute(`document.querySelector('.session-heading .composer-control').click()`)
    await wait(`!!document.querySelector('.session-details')`)
    assert.equal(await execute(`!!document.querySelector('.details-topic')`), false, 'Ordinary sessions have no empty Initiative section')
    assert.deepEqual(errors, [])
    console.log('CONVERSATION_SMOKE_OK')
  } finally { window.destroy() }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
