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
            user:style('.chat-user').backgroundColor, expectedUser:token('--c-bg-muted'),
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
    console.log('CONVERSATION_SMOKE_OK')
  } finally { window.destroy() }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
