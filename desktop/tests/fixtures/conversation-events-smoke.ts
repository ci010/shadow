import assert from 'node:assert/strict'
import type { BrowserWindow } from 'electron'

export async function verifyConversationEvents(
  window: BrowserWindow,
  wait: (code: string) => Promise<void>,
  frame: () => Promise<void>,
  screenshot: (name: string) => Promise<void>,
) {
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  await execute(`window.__showEvents()`)
  await wait(`document.querySelectorAll('.system-event').length === 9`)
  const startEvent = '[data-event-id="start:fixture"]'
  const completeEvent = '[data-event-id="complete:fixture"]'
  const failedEvent = '[data-event-id="failed:fixture"]'
  const externalEvent = '[data-event-id="external:fixture"]'
  assert.equal(await execute(`document.querySelector('${startEvent}').open`), false)
  assert.equal(await execute(`document.querySelector('${completeEvent} .event-details').open`), false)
  assert.equal(await execute(`document.querySelector('[data-event-id="cancelled:fixture"]').dataset.expanded`), 'false')
  assert.equal(await execute(`document.querySelector('[data-event-id="legacy:fixture"]').dataset.expanded`), 'false')
  assert.equal(await execute(`document.querySelector('[data-event-id="legacy:fixture"] .event-inspect')`), null,
    'Old completion records without a source remain readable without a fake execution link')
  const ownBackground = '[data-event-id="own-background:fixture"]'
  const ownCompletion = '[data-event-id="own-completion:fixture"]'
  const peerBackground = '[data-event-id="peer-background:fixture"]'
  for (const selector of [ownBackground, ownCompletion]) {
    assert.equal(await execute(`document.querySelector('${selector} .event-inspect, ${selector} .event-inspect-header')`), null,
      'Events from the displayed session must not offer navigation back to themselves')
    await execute(`(() => {
      const event = document.querySelector('${selector}');
      if (event.matches('.message-preview-card')) event.dispatchEvent(new Event('message-card-expand'));
      else event.open = true;
    })()`)
  }
  assert.match(await execute(`document.querySelector('${ownBackground} .event-body').textContent`), /no output, exit code 0/)
  assert.match(await execute(`document.querySelector('${ownCompletion} .event-content').textContent`), /Own completion remains readable/)
  await execute(`document.querySelector('${ownBackground} .event-metadata').open = true`)
  assert.match(await execute(`document.querySelector('${ownBackground} .event-fields').textContent`), /source-session-id.*web:owner/)
  assert.equal(await execute(`window.__conversationFixture.navigation.length`), 0)
  await execute(`document.querySelector('${peerBackground}').open = true`)
  assert.match(await execute(`document.querySelector('${peerBackground} .event-inspect').textContent`), /View conversation/)
  await execute(`document.querySelector('${peerBackground} .event-inspect').click()`)
  await wait(`window.__conversationFixture.navigation.length === 1`)
  assert.deepEqual(await execute(`JSON.parse(JSON.stringify(window.__conversationFixture.navigation[0]))`), { event:'navigate', id:'web:peer' })
  await execute(`window.__conversationFixture.navigation = []`)
  await execute(`document.querySelector('${startEvent} > summary').focus()`)
  window.webContents.debugger.attach('1.3')
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  for (const type of ['keyDown', 'keyUp']) {
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}),
    })
  }
  await wait(`document.querySelector('${startEvent}').open`)
  assert.equal(await execute(`getComputedStyle(document.activeElement).outlineStyle`), 'solid')
  window.webContents.debugger.detach()
  assert.match(await execute(`document.querySelector('${startEvent} .event-body').textContent`), /read the event log/)
  assert.equal(await execute(`window.__conversationFixture.navigation.length`), 0, 'Expanding a start event never inspects its execution')
  await execute(`document.querySelector('${startEvent} .event-inspect').click()`)
  await wait(`window.__conversationFixture.navigation.length === 1`)
  assert.deepEqual(await execute(`JSON.parse(JSON.stringify(window.__conversationFixture.navigation[0]))`), { event:'navigate', id:'web:peer' })
  await execute(`window.__conversationFixture.navigation = [];
    document.querySelector('${completeEvent}').dispatchEvent(new Event('message-card-expand'))`)
  await wait(`document.querySelector('${completeEvent}').dataset.expanded === 'true'
    && document.querySelector('${completeEvent}').getAnimations({subtree:true}).length === 0`)
  await execute(`document.querySelector('${completeEvent} .event-details > summary').click()`)
  await wait(`document.querySelector('${completeEvent} .event-details').open`)
  assert.match(await execute(`document.querySelector('${completeEvent} .event-content').textContent`), /still requires a verified receipt/)
  assert.equal(await execute(`window.__conversationFixture.navigation.length`), 0)
  await execute(`document.querySelector('${completeEvent} .event-inspect-header').click()`)
  await wait(`window.__conversationFixture.navigation.length === 1`)
  assert.deepEqual(await execute(`JSON.parse(JSON.stringify(window.__conversationFixture.navigation[0]))`), { event:'navigate', id:'web:peer' })
  await execute(`window.__conversationFixture.childSessionId = 'web:peer'`)
  await frame()
  assert.equal(await execute(`document.querySelector('${completeEvent} .event-inspect-header').getAttribute('aria-pressed')`), 'true')
  await execute(`window.__conversationFixture.childSessionId = null`)
  for (const selector of [startEvent, externalEvent]) {
    await execute(`document.querySelector('${selector}').open = true; document.querySelector('${selector} .event-metadata').open = true`)
  }
  for (const width of [1100, 390]) {
    window.setContentSize(width, 844)
    for (const dark of [false, true]) {
      await execute(`document.documentElement.classList.toggle('dark', ${dark})`)
      await frame()
      await wait(`[...document.querySelectorAll('.system-event')].every(event =>
        event.getAnimations({subtree:true}).every(animation => !(animation instanceof CSSTransition)))`)
      const eventLayout = await execute(`(() => {
        const root = getComputedStyle(document.documentElement);
        const token = name => {
          const el = document.createElement('span'); el.style.color = root.getPropertyValue(name);
          document.body.append(el); const value = getComputedStyle(el).color; el.remove(); return value;
        };
        const events = [...document.querySelectorAll('.system-event')];
        const event = document.querySelector('${startEvent}');
        const header = event.querySelector('.event-header');
        const title = header.querySelector('strong').getBoundingClientRect();
        const source = header.querySelector('.event-source').getBoundingClientRect();
        const fields = getComputedStyle(event.querySelector('.event-fields'));
        return {
          overflow:document.documentElement.scrollWidth > innerWidth || events.some(el => el.scrollWidth > el.clientWidth + 1),
          sourceBelowTitle:source.top >= title.bottom,
          radii:events.map(el => getComputedStyle(el).borderRadius),
          background:getComputedStyle(event).backgroundColor, expectedBackground:token('--c-chat-action-bg'),
          guideCount:document.querySelectorAll('.system-event .trace-guide').length,
          timeSize:getComputedStyle(header.querySelector('time')).fontSize,
          fieldColumns:fields.gridTemplateColumns.split(' ').length,
          sourceOverflow:getComputedStyle(header.querySelector('.event-source')).textOverflow,
          failure:getComputedStyle(document.querySelector('${failedEvent} .event-symbol')).color, error:token('--c-error'),
          success:getComputedStyle(document.querySelector('${completeEvent} .event-symbol')).color, completed:token('--c-success'),
          cancelled:getComputedStyle(document.querySelector('[data-event-id="cancelled:fixture"] .event-symbol')).color,
          neutral:token('--c-text-secondary'),
          targets:[event.querySelector('.event-inspect'), event.querySelector('.event-disclosure')].map(el => el.getBoundingClientRect().height),
        };
      })()`)
      assert.equal(eventLayout.overflow, false, 'Titles, content and metadata wrap inside the existing conversation rail')
      assert.equal(eventLayout.sourceBelowTitle, true, 'Origin is a secondary line, not a competing title')
      assert(eventLayout.radii.every((value: string) => value === '0px'))
      assert.equal(eventLayout.background, eventLayout.expectedBackground)
      assert.equal(eventLayout.guideCount, 0, 'Events use quiet section dividers, not stacked trace rails')
      assert.equal(eventLayout.timeSize, '12px')
      assert.equal(eventLayout.fieldColumns, width === 390 ? 1 : 2)
      assert.equal(eventLayout.sourceOverflow, 'ellipsis')
      assert.equal(eventLayout.failure, eventLayout.error)
      assert.equal(eventLayout.success, eventLayout.completed)
      assert.equal(eventLayout.cancelled, eventLayout.neutral, 'Cancelled is not a successful execution')
      if (width === 390) assert(eventLayout.targets.every((height: number) => height >= 44))
      await execute(`document.querySelector('${startEvent}').scrollIntoView({block:'start'})`)
      await frame()
      await screenshot(`events-${width}-${dark ? 'dark' : 'light'}`)
    }
  }
}
