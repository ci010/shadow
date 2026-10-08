import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'
import { verifyConversationEvents } from './conversation-events-smoke.ts'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1100, height: 844,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const errors: string[] = []
  window.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
  const execute = async (code: string) => {
    try {
      return await window.webContents.executeJavaScript(code)
    } catch (cause) {
      throw new Error(`Renderer script failed:\n${code}\n${errors.join('\n')}`, { cause })
    }
  }
  const frame = () => execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const wait = async (code: string) => {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(50) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}\n${errors.join('\n')}`)
  }
  const setCardOpen = async (selector: string, open: boolean) => {
    await execute(`(() => {
      const card = document.querySelector('${selector}');
      if (card.dataset.expanded !== '${open}') card.querySelector('.message-preview-toggle').click();
    })()`)
    await wait(`document.querySelector('${selector}').dataset.expanded === '${open}'
      && document.querySelector('${selector}').getAnimations({subtree:true}).length === 0`)
  }
  const setCardsOpen = async (expanded: boolean) => {
    await execute(`document.querySelectorAll('.message-preview-card').forEach(card => {
      if (card.dataset.expanded !== '${expanded}') card.querySelector('.message-preview-toggle').click();
    })`)
    await wait(`[...document.querySelectorAll('.message-preview-card')].every(card =>
      card.dataset.expanded === '${expanded}' && card.getAnimations({subtree:true}).length === 0)`)
  }
  const screenshot = async (name: string) => {
    if (process.env.CONVERSATION_SCREENSHOTS) {
      await writeFile(join(process.env.CONVERSATION_SCREENSHOTS, `${name}.png`), (await window.webContents.capturePage()).toPNG())
    }
  }
  try {
    await window.loadURL(new URL('__conversation', process.env.CONVERSATION_SMOKE_URL).href)
    await wait(`!!document.querySelector('.conversation-skeleton')`)
    if (process.env.CONVERSATION_READING_LAYOUT_ONLY) {
      await execute(`window.__showReadingLayout()`)
      await wait(`document.querySelectorAll('.message-preview-card').length === 4`)
      for (const width of [1800, 1100, 760, 390]) {
        window.setContentSize(width, 844)
        await execute(`window.__conversationFixture.mobileLayout = ${width === 390}`)
        await frame()
        const before = await execute(`JSON.stringify([...document.querySelectorAll('.message-preview-card .prose')].map(el => el.getBoundingClientRect().width))`)
        await setCardsOpen(true)
        assert.equal(await execute(`JSON.stringify([...document.querySelectorAll('.message-preview-card .prose')].map(el => el.getBoundingClientRect().width))`),
          before, 'Expansion changes height without reflowing the body width')
        await execute(`document.querySelector('.compaction-summary').open = true`)
        await wait(`!!document.querySelector('.compaction-summary-body')`)
        const layout = await execute(`(() => {
          const list = document.querySelector('.chat-message-list').getBoundingClientRect();
          const pane = document.querySelector('.chat-history').getBoundingClientRect();
          const scroll = document.querySelector('.chat-messages');
          const scrollBounds = scroll.getBoundingClientRect();
          const composer = document.querySelector('.chat-composer').getBoundingClientRect();
          const user = document.querySelector('.chat-user').getBoundingClientRect();
          const prose = document.querySelector('.chat-assistant > .prose');
          const code = prose.querySelector('pre');
          const mobile = window.__conversationFixture.mobileLayout;
          return {list:list.width,expected:Math.min(860, mobile ? scroll.clientWidth - 16 : pane.width - 112),
            center:mobile ? (list.left + list.right - 2 * scrollBounds.left - scroll.clientWidth) / 2
              : (list.left + list.right - pane.left - pane.right) / 2,
            composer:composer.width,user:user.width,userRight:user.right,listRight:list.right,
            widths:[...document.querySelectorAll('.message-preview-card,.chat-assistant,.tool-activity,.compaction-summary')].map(el => el.getBoundingClientRect().width),
            markdown:[...document.querySelectorAll('.chat-message-list .prose')].map(el => ({
              cap:getComputedStyle(el).maxWidth,width:el.getBoundingClientRect().width,
              parent:el.parentElement.clientWidth,padding:parseFloat(getComputedStyle(el.parentElement).paddingLeft) + parseFloat(getComputedStyle(el.parentElement).paddingRight),
            })),
            sourceBreak:!!prose.querySelector('br'),codeScroll:code.scrollWidth > code.clientWidth,
            codeOverflow:getComputedStyle(code).overflowX,pageOverflow:document.documentElement.scrollWidth > innerWidth,
            scrollOverflow:document.querySelector('.chat-messages').scrollWidth > document.querySelector('.chat-messages').clientWidth};
        })()`)
        assert.ok(Math.abs(layout.list - layout.expected) < 1, `The centered rail owns the desktop cap and mobile gutters: ${JSON.stringify(layout)}`)
        assert.ok(Math.abs(layout.center) < 1)
        assert.ok(layout.widths.every((value: number) => Math.abs(value - layout.list) < 1), 'All assistant, tool and response surfaces fill the rail')
        assert.ok(layout.markdown.every((value: {cap: string}) => value.cap === 'none'), 'Chat Markdown has no independent character-width cap')
        assert.ok(layout.markdown.slice(0, -1).every((value: {width: number; parent: number; padding: number}) => Math.abs(value.width - value.parent + value.padding) < 1),
          'Ordinary message and response bodies fill their containers')
        assert.ok(layout.user < layout.list * .8)
        assert.ok(Math.abs(layout.userRight - layout.listRight) < 1, 'Short human messages remain right-aligned')
        if (width >= 1100) assert.ok(Math.abs(layout.composer - layout.list) < 1, 'The wide reading rail matches the composer maximum')
        assert.equal(layout.sourceBreak, true, 'Source newlines keep their existing rendering')
        assert.equal(layout.codeScroll, true)
        assert.equal(layout.codeOverflow, 'auto')
        assert.equal(layout.pageOverflow || layout.scrollOverflow, false, 'Long code scrolls locally without widening the conversation')
        await setCardsOpen(false)
        for (const dark of [false, true]) {
          await execute(`document.documentElement.classList.toggle('dark', ${dark});
            document.querySelector('.chat-messages').scrollTop = 0`)
          await frame()
          await wait(`[...document.querySelectorAll('.message-preview-card')].every(card =>
            card.getAnimations({subtree:true}).every(animation => !(animation instanceof CSSTransition)))`)
          await screenshot(`reading-layout-${width}-${dark ? 'dark' : 'light'}`)
        }
      }
      assert.deepEqual(errors, [])
      console.log('CONVERSATION_SMOKE_OK')
      return
    }
    if (process.env.CONVERSATION_RESPONSE_CARDS_ONLY) {
      await execute(`window.__showResponses()`)
      await wait(`document.querySelectorAll('.message-preview-card').length === 4`)
      const selectors = ['[data-execution-mode="call"]', '[data-execution-mode="task"]',
        '[data-event-id="task-result"]', '[data-event-id="legacy-result"]']
      for (const width of [1100, 390]) {
        window.setContentSize(width, 844)
        for (const dark of [false, true]) {
          await execute(`document.documentElement.classList.toggle('dark', ${dark})`)
          await frame()
          const railWidth = await execute(`document.querySelector('.tool-activity').getBoundingClientRect().width`)
          assert.ok(await execute(`Math.abs(document.querySelector('.chat-assistant').getBoundingClientRect().width - ${railWidth}) < 1`), 'Normal assistant replies fill the same rail as tools')
          for (const selector of selectors) {
            const state = await execute(`(() => {
              const card = document.querySelector('${selector}');
              const body = card.querySelector('.message-preview-body');
              const fade = getComputedStyle(body, '::after');
              const normal = document.querySelector('.chat-assistant > .chat-content');
              const markdown = card.querySelector('.chat-content');
              const typography = root => ['', 'h2', 'p', 'strong', 'code', 'pre', 'pre code', 'ul', 'li'].map(selector => {
                const style = getComputedStyle(selector ? root.querySelector(selector) : root);
                return ['fontSize','lineHeight','marginTop','marginBottom','paddingLeft','backgroundColor'].map(key => style[key]);
              });
              return {expanded:card.dataset.expanded,width:card.getBoundingClientRect().width,
                bodyHeight:body.getBoundingClientRect().height,lineHeight:parseFloat(getComputedStyle(body).lineHeight),
                copies:card.querySelectorAll('.prose').length,fade:fade.backgroundImage,opacity:fade.opacity,
                pointer:fade.pointerEvents,cardType:typography(markdown),normalType:typography(normal),
                headingWidth:card.querySelector('.event-copy')?.getBoundingClientRect().width,
                overflow:card.scrollWidth > card.clientWidth};
            })()`)
            assert.equal(state.expanded, 'false', 'Call and task results start as preview cards')
            assert.ok(Math.abs(state.width - railWidth) < 1)
            assert.ok(Math.abs(state.bodyHeight - state.lineHeight * 5) < 1, 'Responses show five lines by default')
            assert.equal(state.copies, 1)
            assert.match(state.fade, /linear-gradient/)
            assert.equal(state.opacity, '1')
            assert.equal(state.pointer, 'none')
            assert.deepEqual(state.cardType, state.normalType, 'Response Markdown keeps ordinary message typography')
            if (state.headingWidth !== undefined) assert.ok(state.headingWidth >= 80, 'Narrow event headings remain readable instead of wrapping character by character')
            assert.equal(state.overflow, false)
          }
          await execute(`document.querySelector('${selectors[0]}').scrollIntoView({block:'start'})`)
          await screenshot(`response-cards-${width}-${dark ? 'dark' : 'light'}-collapsed`)
          await execute(`window.__responseBodies = [...document.querySelectorAll('.message-preview-card .prose')]`)
          await setCardsOpen(true)
          const expandedCards = await execute(`[...document.querySelectorAll('.message-preview-card')].map((card, index) => {
            const body = card.querySelector('.message-preview-body');
            return {sameBody:card.querySelector('.prose') === window.__responseBodies[index],
              revealsMore:body.getBoundingClientRect().height > 5 * parseFloat(getComputedStyle(body).lineHeight),
              fade:getComputedStyle(body, '::after').opacity};
          })`)
          for (const card of expandedCards) {
            assert.equal(card.sameBody, true, 'Response expansion never duplicates the body')
            assert.equal(card.revealsMore, true)
            assert.equal(card.fade, '0')
          }
          await screenshot(`response-cards-${width}-${dark ? 'dark' : 'light'}-expanded`)
          await setCardsOpen(false)
          assert.equal(await execute(`document.documentElement.scrollWidth > innerWidth`), false)
        }
      }
      await execute(`document.querySelector('[data-event-id="legacy-result"] .event-header').click()`)
      await wait(`document.querySelector('[data-event-id="legacy-result"]').dataset.expanded === 'true'`)
      assert.equal(await execute(`window.__conversationFixture.navigation.length`), 0, 'A heading without a source expands the card rather than navigating')
      await setCardOpen(selectors[3], false)
      await execute(`document.querySelector('${selectors[0]} .execution-inspect').click();
        document.querySelector('[data-event-id="task-result"] .event-inspect-header').click()`)
      assert.equal(await execute(`window.__conversationFixture.navigation.length`), 2, 'Response source links still navigate')
      assert.equal(await execute(`document.querySelector('${selectors[0]}').dataset.expanded`), 'false', 'Inspection does not expand a result')
      assert.equal(await execute(`!!document.querySelector('[data-event-id="legacy-result"] .event-inspect-header')`), false, 'Legacy responses do not invent source links')
      await setCardOpen(selectors[0], true)
      await execute(`document.querySelector('${selectors[0]} .execution-details > summary').click()`)
      await wait(`document.querySelector('${selectors[0]} .execution-details').open`)
      assert.match(await execute(`document.querySelector('${selectors[0]} .execution-details').textContent`), /mode.*call/)
      await execute(`window.__conversationFixture.executionFixtures[0].output = '';
        window.__conversationFixture.executionFixtures[0].stage = 'running'`)
      await frame()
      assert.equal(await execute(`document.querySelector('${selectors[0]}').dataset.collapsible`), 'false', 'Executions without a response do not show an empty preview')
      assert.equal(await execute(`!!document.querySelector('${selectors[0]} .message-preview-toggle')`), false)
      assert.deepEqual(errors, [])
      console.log('CONVERSATION_SMOKE_OK')
      return
    }
    if (process.env.CONVERSATION_EVENTS_ONLY) {
      await verifyConversationEvents(window, wait, frame, screenshot)
      assert.deepEqual(errors, [])
      console.log('CONVERSATION_SMOKE_OK')
      return
    }
    if (process.env.CONVERSATION_NAVIGATION_ONLY) {
      await execute(`window.__showConversation(); window.__conversationFixture.embedded = true;
        window.__conversationFixture.enableChildPane = true;
        window.__conversationFixture.messages[1].sessionSource.intent = 'progress'`)
      await wait(`!!document.querySelector('.message-action .session-message-link') && document.querySelector('.chat-session strong').textContent === 'Session progress'`)
      for (const width of [1100, 390]) {
        window.setContentSize(width, 844)
        await frame()
        await execute(`window.__conversationFixture.navigation = []`)
        await setCardOpen('.message-action', true)
        await wait(`!!document.querySelector('.message-action-details summary')`)
        await execute(`document.querySelector('.message-action-details summary').click()`)
        await wait(`document.querySelector('.message-action-details').open`)
        assert.equal(await execute(`window.__conversationFixture.navigation.length`), 0, 'Expanding tool details does not navigate')
        await execute(`document.querySelector('.message-action-details summary').click(); document.querySelector('.message-action .session-message-link').click()`)
        await execute(`document.querySelector('.chat-session .session-message-link').focus()`)
        window.webContents.debugger.attach('1.3')
        await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r',
        })
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
        })
        await wait(`window.__conversationFixture.navigation.length === 2`)
        window.webContents.debugger.detach()
        assert.deepEqual(await execute(`JSON.parse(JSON.stringify(window.__conversationFixture.navigation))`), [
          { event: 'navigate', id: 'web:peer' }, { event: 'navigate', id: 'web:peer' },
        ], 'Coordinator recipient and progress source links reach workspace navigation')
        assert.equal(await execute(`window.__conversationFixture.activeSessionId`), 'web:owner', 'Navigation does not reset the cached coordinator')
      }
      await execute(`window.__conversationFixture.enableChildPane = false; document.querySelector('.chat-session .session-message-link').click()`)
      assert.deepEqual(await execute(`JSON.parse(JSON.stringify(window.__conversationFixture.navigation.at(-1)))`),
        { event: 'child-navigation', id: 'web:peer' }, 'An actual child pane still forwards inspection to its workspace')
      assert.deepEqual(errors, [])
      console.log('CONVERSATION_SMOKE_OK')
      return
    }
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
    const previewHeight = await execute(`5 * parseFloat(getComputedStyle(document.querySelector('.message-preview-body')).lineHeight)`)
    const collapsedHeight = await execute(`(() => {
      const card = document.querySelector('.session-message');
      const style = getComputedStyle(card);
      const body = getComputedStyle(card.querySelector('.message-preview-body'));
      return card.querySelector('.message-preview-header').getBoundingClientRect().height
        + parseFloat(body.marginTop) + 5 * parseFloat(body.lineHeight)
        + ['paddingTop','paddingBottom','borderTopWidth','borderBottomWidth'].reduce((total, key) => total + parseFloat(style[key]), 0);
    })()`)
    if (process.env.CONVERSATION_EXCHANGES_ONLY) {
      const selectors = ['.chat-session', '.message-action']
      for (const selector of selectors) {
        assert.equal(await execute(`document.querySelector('${selector}').dataset.expanded`), 'false')
        assert.equal(await execute(`document.querySelectorAll('${selector} .prose').length`), 1, 'There is one body, not separate preview and expanded copies')
        assert.ok(await execute(`Math.abs(document.querySelector('${selector}').getBoundingClientRect().height - ${collapsedHeight}) < 1`))
        await execute(`window.__cardBody = document.querySelector('${selector} .prose');
          document.querySelector('${selector} .message-preview-toggle').click()`)
        await wait(`document.querySelector('${selector}').getAnimations({subtree:true}).some(animation => animation.transitionProperty === 'grid-template-rows')`)
        await wait(`document.querySelector('${selector}').getAnimations({subtree:true}).length === 0`)
        assert.equal(await execute(`document.querySelector('${selector} .prose') === window.__cardBody`), true)
        assert.equal(await execute(`document.querySelector('${selector} .message-preview-body').inert`), false)
        await setCardOpen(selector, false)
      }
      assert.equal(await execute(`document.querySelector('.message-action-content strong').textContent`), 'the changes', 'The preview uses actual rendered Markdown')
      await execute(`(() => {
        const markdown = '## Matching heading\\n\\nBody with **strong** and \`inline code\`.\\n\\n- First item\\n- Second item\\n\\n\`\`\`ts\\nconst value = 1\\n\`\`\`\\n\\n' + 'Full collaboration body. '.repeat(30);
        window.__conversationFixture.messages[1].content = markdown;
        window.__conversationFixture.messages[2].toolCall.arguments.content = markdown;
        window.__conversationFixture.messages[6].content = markdown;
      })()`)
      await frame()
      for (const width of [1100, 390]) {
        window.setContentSize(width, 844)
        for (const dark of [false, true]) {
          await execute(`document.documentElement.classList.toggle('dark', ${dark});
            document.querySelector('.chat-session').scrollIntoView({block:'start'})`)
          await frame()
          for (const selector of selectors) {
            const layout = await execute(`(() => {
              const card = document.querySelector('${selector}');
              const body = card.querySelector('.message-preview-body');
              return {height:card.getBoundingClientRect().height,body:body.getBoundingClientRect().height,
                lineHeight:getComputedStyle(body).lineHeight,inert:body.inert,
                overflow:card.scrollWidth > card.clientWidth,
                copies:card.querySelectorAll('.prose').length};
            })()`)
            assert.ok(Math.abs(layout.height - collapsedHeight) < 1, 'All cards have the same collapsed height')
            assert.ok(Math.abs(layout.body - previewHeight) < 1, 'Five lines of the ordinary Markdown body remain visible')
            assert.equal(layout.inert, true, 'Clipped controls cannot receive focus')
            assert.equal(layout.overflow, false)
            assert.equal(layout.copies, 1)
            const fade = await execute(`(() => {
              const style = getComputedStyle(document.querySelector('${selector} .message-preview-body'), '::after');
              return {background:style.backgroundImage,opacity:style.opacity,pointer:style.pointerEvents};
            })()`)
            assert.match(fade.background, /linear-gradient/)
            assert.equal(fade.opacity, '1')
            assert.equal(fade.pointer, 'none')
            const typography = await execute(`(() => {
              const normal = document.querySelector('.chat-assistant > .chat-content');
              const card = document.querySelector('${selector} .chat-content');
              const read = root => ['', 'h2', 'p', 'strong', 'code', 'pre', 'pre code', 'ul', 'li'].map(selector => {
                const style = getComputedStyle(selector ? root.querySelector(selector) : root);
                return Object.fromEntries(['fontSize','fontFamily','lineHeight','marginTop','marginBottom',
                  'paddingTop','paddingLeft','color','backgroundColor'].map(key => [key, style[key]]));
              });
              return {normal:read(normal),card:read(card)};
            })()`)
            assert.deepEqual(typography.card, typography.normal, 'Preview and expanded Markdown match ordinary messages without style overrides')
          }
          assert.equal(await execute(`document.documentElement.scrollWidth > innerWidth`), false)
          const widths = await execute(`['.chat-assistant','.chat-session','.message-action','.tool-activity']
            .map(selector => document.querySelector(selector).getBoundingClientRect().width)`)
          assert.ok(widths.every((width: number) => Math.abs(width - widths[0]) < 1), 'Assistant messages, cards and tools share the same outer width')
          const gaps = await execute(`(() => {
            const incoming = document.querySelector('.chat-session').getBoundingClientRect();
            const outgoing = document.querySelector('.message-action').getBoundingClientRect();
            const tool = document.querySelector('.tool-activity').getBoundingClientRect();
            const gap = parseFloat(getComputedStyle(document.querySelector('.chat-message-list')).rowGap);
            return [outgoing.top - incoming.bottom - gap, tool.top - outgoing.bottom - gap];
          })()`)
          assert.ok(gaps.every((gap: number) => Math.abs(gap) < 1), 'Cards use the shared list spacing')
          await screenshot(`session-exchange-${width}-${dark ? 'dark' : 'light'}-collapsed`)
          for (const selector of selectors) await setCardOpen(selector, true)
          assert.ok(await execute(`document.querySelector('.message-action .message-preview-body').getBoundingClientRect().height > ${previewHeight}`), 'Expansion reveals more of the existing body')
          assert.equal(await execute(`getComputedStyle(document.querySelector('.message-action .message-preview-body'), '::after').opacity`), '0', 'Expanded content is not faded')
          assert.equal(await execute(`document.querySelectorAll('.message-action .prose').length`), 1)
          await screenshot(`session-exchange-${width}-${dark ? 'dark' : 'light'}-expanded`)
          for (const selector of selectors) await setCardOpen(selector, false)
        }
      }
      await execute(`window.__conversationFixture.navigation = [];
        document.querySelector('.message-action .session-message-link').click();
        document.querySelector('.chat-session .session-message-link').click()`)
      assert.equal(await execute(`window.__conversationFixture.navigation.length`), 2)
      for (const selector of selectors) assert.equal(await execute(`document.querySelector('${selector}').dataset.expanded`), 'false', 'Navigation does not expand the card')
      for (const intent of ['progress', 'handoff', 'request', 'question']) {
        await execute(`window.__conversationFixture.messages[1].sessionSource.intent = '${intent}';
          window.__conversationFixture.messages[1].content = 'Full collaboration body. '.repeat(60)`)
        await frame()
        assert.ok(await execute(`Math.abs(document.querySelector('.chat-session').getBoundingClientRect().height - ${collapsedHeight}) < 1`))
        assert.equal(await execute(`document.querySelectorAll('.chat-session .prose').length`), 1)
      }
      await execute(`document.querySelector('.chat-session').dispatchEvent(new Event('message-card-expand'))`)
      await wait(`document.querySelector('.chat-session').dataset.expanded === 'true'
        && document.querySelector('.chat-session').getAnimations({subtree:true}).length === 0`)
      assert.ok(await execute(`document.querySelector('.chat-session .message-preview-body').getBoundingClientRect().height > ${previewHeight}`), 'Search can reveal the complete body')
      await execute(`document.querySelector('.chat-session .message-preview-toggle').focus()`)
      window.webContents.debugger.attach('1.3')
      await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
      for (const type of ['keyDown', 'keyUp']) {
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
          type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}),
        })
      }
      await wait(`document.querySelector('.chat-session').dataset.expanded === 'false'
        && document.querySelector('.chat-session').getAnimations({subtree:true}).length === 0`)
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      await setCardOpen('.message-action', true)
      assert.equal(await execute(`document.querySelector('.message-action').getAnimations({subtree:true}).length`), 0)
      await setCardOpen('.message-action', false)
      window.webContents.debugger.detach()
      await execute(`window.__conversationFixture.messages[3].content = 'Error: peer is unavailable';
        window.__conversationFixture.messages[2].toolCall.arguments.content = ''`)
      await wait(`document.querySelector('.message-action-status').textContent === 'Failed'`)
      assert.ok(await execute(`Math.abs(document.querySelector('.message-action').getBoundingClientRect().height - ${collapsedHeight}) < 1`), 'Empty content still has a fixed-height card')
      assert.equal(await execute(`getComputedStyle(document.querySelector('.message-action .message-preview-details')).visibility`), 'hidden', 'Receipts are not part of the collapsed body preview')
      await setCardOpen('.message-action', true)
      assert.match(await execute(`document.querySelector('.message-action-note').textContent`), /peer is unavailable/)
      assert.deepEqual(errors, [])
      console.log('CONVERSATION_SMOKE_OK')
      return
    }
    assert.equal(await execute(`document.querySelectorAll('.message-action').length`), 1)
    assert.equal(await execute(`document.querySelectorAll('.tool-activity').length`), 1)
    assert.match(await execute(`document.querySelector('.tool-activity').textContent`), /View file.ts/)
    assert.equal(await execute(`document.querySelector('.message-action-status').textContent`), 'Queued')
    for (const selector of ['.message-action', '.chat-session']) {
      assert.equal(await execute(`document.querySelector('${selector}').dataset.expanded`), 'false', 'Session messages start collapsed regardless of direction or length')
      assert.equal(await execute(`document.querySelectorAll('${selector} .prose').length`), 1, 'Preview and expanded body use a single Markdown node')
      assert.ok(await execute(`Math.abs(document.querySelector('${selector}').getBoundingClientRect().height - ${collapsedHeight}) < 1`), 'Collapsed cards have a fixed heading and five-line preview including device-pixel-rounded borders')
      assert.ok(await execute(`Math.abs(document.querySelector('${selector} .message-preview-body').getBoundingClientRect().height - ${previewHeight}) < 1`), 'Preview shows a five-line body window')
      assert.equal(await execute(`document.querySelector('${selector} .message-preview-body').inert`), true, 'Clipped body links cannot receive focus')
      await execute(`window.__previewBody = document.querySelector('${selector} .prose'); document.querySelector('${selector} .message-preview-toggle').click()`)
      await wait(`document.querySelector('${selector}').getAnimations({subtree:true}).some(animation => animation.transitionProperty === 'grid-template-rows')`)
      await wait(`document.querySelector('${selector}').getAnimations({subtree:true}).length === 0`)
      assert.equal(await execute(`window.__previewBody === document.querySelector('${selector} .prose')`), true, 'Expansion reveals the same rendered body rather than duplicating it')
    }
    assert.equal(await execute(`document.querySelector('.message-action-content strong').textContent`), 'the changes')
    assert.match(await execute(`document.querySelector('.chat-session .prose').textContent`), /review the changes/)
    assert.equal(await execute(`window.__conversationFixture.navigation.length`), 0, 'Expanding messages does not navigate')
    assert.equal(await execute(`document.querySelectorAll('.yield-decision').length`), 1)
    assert.match(await execute(`document.querySelector('.yield-decision').textContent`), /Default selected by timeout/)
    assert.equal(await execute(`document.querySelector('.yield-decision').getAttribute('data-msg-idx')`), '7')
    assert.equal(await execute(`document.querySelectorAll('.yield-decision button, .yield-decision input').length`), 0, 'Historical decisions cannot submit answers')
    assert.equal(await execute(`document.querySelector('.response-disclosure').open`), false)
    assert.match(await execute(`document.querySelector('.response-disclosure > summary').textContent`), /Background response.*subagent-failed.*Reviewer.*Trigger failed/)
    assert.equal(await execute(`document.querySelector('.system-event .event-details').open`), false)
    assert.equal(await execute(`document.querySelector('.system-event .event-inspect-header').getAttribute('aria-pressed')`), 'false')
    assert.ok(await execute(`document.querySelector('.system-event .event-inspect-header .i-lucide-git-branch')`))
    await execute(`document.querySelector('.system-event .event-details summary').click()`)
    await wait(`document.querySelector('.system-event .event-details').open`)
    assert.equal(await execute(`window.__conversationFixture.navigation.length`), 0, 'Opening event details does not navigate')
    assert.match(await execute(`document.querySelector('.system-event').textContent`), /terminated[\s\S]*subagent-failed/)
    assert.match(await execute(`document.querySelector('.execution-card .execution-copy').textContent`), /Compile and finish native helper.*fresh context/)
    assert.ok(await execute(`document.querySelector('.execution-details summary .trace-chevron')`), 'Tool details use a chevron, not a permanently visible guide')
    assert.equal(await execute(`document.querySelector('.execution-details').open`), false)
    assert.equal(await execute(`getComputedStyle(document.querySelector('.execution-details')).borderLeftStyle`), 'none', 'Closed tool details have no always-visible guide')
    assert.ok(await execute(`{ const headers=['.tool-activity-summary','.response-disclosure > summary','.system-event .event-inspect-header','.execution-inspect']
      .map(selector => getComputedStyle(document.querySelector(selector)).minHeight);
      new Set(headers).size === 1 && headers[0] === '40px'; }`), 'Execution and event headers share the trace rhythm')
    assert.ok(await execute(`{ const response=document.querySelector('.response-disclosure').getBoundingClientRect();
      const event=document.querySelector('.system-event').getBoundingClientRect();
      const execution=document.querySelector('.execution-card').getBoundingClientRect();
      Math.abs(response.right - event.right) < 2 && Math.abs(event.right - execution.right) < 2; }`), 'All trace rows share the same edge')
    assert.equal(await execute(`getComputedStyle(document.querySelector('.system-event .prose')).fontSize`),
      await execute(`getComputedStyle(document.querySelector('.chat-assistant .prose')).fontSize`))
    const workEvent = '[data-event-id="work:fixture"]'
    assert.equal(await execute(`document.querySelector('${workEvent}').open`), false)
    assert.equal(await execute(`!!document.querySelector('${workEvent} .event-payload')`), false, 'Collapsed work events do not mount raw payloads')
    await execute(`document.querySelector('${workEvent} > summary').click()`)
    await wait(`!!document.querySelector('${workEvent} .event-payload')`)
    assert.equal(await execute(`document.querySelector('${workEvent} .payload-source').textContent`),
      await execute(`window.__conversationFixture.messages.at(-1).content`), 'Event instructions and JSON remain exact plain text')
    assert.equal(await execute(`!!document.querySelector('${workEvent} .prose')`), false, 'Agent-facing work events are not styled as chat prose')
    assert.equal(await execute(`document.querySelector('${workEvent} .event-metadata').open`), false)
    assert.ok(await execute(`document.querySelector('${workEvent} .event-metadata .trace-chevron')`), 'Metadata uses the shared disclosure affordance')
    await execute(`document.querySelector('${workEvent} .event-metadata > summary').click()`)
    await wait(`document.querySelector('${workEvent} .event-metadata').open`)
    assert.match(await execute(`document.querySelector('${workEvent} .event-metadata dl').textContent`), /work:fixture/)
    assert.equal(await execute(`window.__conversationFixture.navigation.length`), 0, 'Work event expansion never navigates or adopts work')
    await execute(`document.querySelector('${workEvent} .event-metadata > summary').click()`)
    assert.equal(await execute(`document.querySelector('.yield-decision').closest('.response-disclosure')`), null)
    assert.equal(await execute(`document.querySelector('.tool-activity').closest('.response-disclosure')`), null)
    await execute(`document.querySelector('.response-disclosure > summary').focus()`)
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    for (const type of ['keyDown', 'keyUp']) {
      await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}),
      })
    }
    await wait(`document.querySelector('.response-disclosure').open`)
    window.webContents.debugger.detach()
    assert.match(await execute(`document.querySelector('.response-disclosure .prose').textContent`), /original changes are untouched/)
    await execute(`void (window.__conversationFixture.messages = [...window.__conversationFixture.messages])`)
    await frame()
    assert.equal(await execute(`document.querySelector('.response-disclosure').open`), true, 'Message refresh preserves disclosure intent')
    await execute(`window.__conversationFixture.messages[1].content = 'Routine progress. '.repeat(60)`)
    await frame()
    assert.equal(await execute(`document.querySelector('.chat-session').dataset.expanded`), 'true', 'Content refresh preserves expansion')
    await setCardOpen('.chat-session', false)
    for (const intent of ['question', 'request', 'handoff', undefined]) {
      await execute(`window.__conversationFixture.messages[1].sessionSource.intent = ${JSON.stringify(intent)}`)
      await frame()
      assert.equal(await execute(`document.querySelector('.chat-session').dataset.expanded`), 'false', 'Requests and unclassified messages use the same preview card')
      assert.equal(await execute(`document.querySelectorAll('.chat-session .prose').length`), 1)
    }
    await execute(`document.querySelector('.chat-session .message-preview-toggle').focus()`)
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    for (const type of ['keyDown', 'keyUp']) {
      await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}),
      })
    }
    await wait(`document.querySelector('.chat-session').dataset.expanded === 'true'`)
    window.webContents.debugger.detach()
    assert.match(await execute(`document.querySelector('.chat-session .prose').textContent`), /Routine progress/)
    await execute(`window.__conversationFixture.messages[1].content = 'I will review the changes and send feedback shortly.'; window.__conversationFixture.messages[1].sessionSource.intent = 'acknowledgement'`)
    for (const width of [1800, 1100, 390]) {
      window.setContentSize(width, 844)
      for (const dark of [false, true]) {
        await execute(`document.documentElement.classList.toggle('dark', ${dark})`)
        await frame()
        await delay(160)
        const layout = await execute(`(() => {
          const list = document.querySelector('.chat-message-list').getBoundingClientRect();
          const user = document.querySelector('.chat-user:not(.chat-session)').getBoundingClientRect();
          const incoming = document.querySelector('.chat-session').getBoundingClientRect();
          const action = document.querySelector('.message-action').getBoundingClientRect();
          const content = document.querySelector('.message-action-content').getBoundingClientRect();
          const prose = document.querySelector('.message-action-content .prose').getBoundingClientRect();
          const incomingHeader = getComputedStyle(document.querySelector('.chat-session .message-preview-header'));
          const outgoingHeader = getComputedStyle(document.querySelector('.message-action .message-preview-header'));
          return { incomingLeft:incoming.left, listLeft:list.left,
            actionLeft:action.left, actionWidth:action.width, listWidth:list.width,
            incomingWidth:incoming.width, headersMatch:['fontSize','lineHeight','minHeight','padding','color'].every(key => incomingHeader[key] === outgoingHeader[key]),
            contentWidth:content.width, proseWidth:prose.width,
            proseMaxWidth:getComputedStyle(document.querySelector('.message-action-content .prose')).maxWidth,
            userProseMaxWidth:getComputedStyle(document.querySelector('.chat-user .prose')).maxWidth,
            overflow:document.documentElement.scrollWidth > innerWidth,
            actionOverflow:document.querySelector('.message-action').scrollWidth > document.querySelector('.message-action').clientWidth };
        })()`)
        assert(Math.abs(layout.incomingLeft - layout.listLeft) < 1, 'Incoming messages share the assistant trace rail')
        assert(Math.abs(layout.actionLeft - layout.listLeft) < 1, 'Outgoing actions stay in the assistant column')
        assert(Math.abs(layout.actionWidth - layout.incomingWidth) < 1, 'Both exchange directions share the same heading width')
        assert.equal(layout.headersMatch, true, 'Incoming and outgoing heading typography and spacing match')
        assert(layout.actionWidth <= layout.listWidth + 1)
        assert(layout.proseWidth <= layout.contentWidth + 1, 'Expanded Markdown stays within its rail')
        assert.equal(layout.proseMaxWidth, 'none', 'Outgoing message Markdown uses the shared conversation measure')
        assert.ok(await execute(`Math.abs(document.querySelector('.message-action').getBoundingClientRect().width
          - document.querySelector('.response-disclosure').getBoundingClientRect().width) < 1`), 'Session exchanges share the bounded trace width on wide panes')
        assert.equal(layout.userProseMaxWidth, 'none', 'Human message Markdown fills its content-sized bubble')
        assert.equal(layout.overflow, false)
        assert.equal(layout.actionOverflow, false)
        assert.equal(await execute(`document.querySelector('.response-disclosure').scrollWidth > document.querySelector('.response-disclosure').clientWidth`), false)
        if (width === 390) assert.ok(await execute(`{ const body=document.querySelector('.response-body').getBoundingClientRect();
          const message=document.querySelector('.response-body .chat-assistant').getBoundingClientRect();
          message.width >= body.width * .8 && message.right <= body.right + 1; }`), 'Expanded background text uses the available mobile rail')
        assert.equal(await execute(`document.querySelector('.execution-card').scrollWidth > document.querySelector('.execution-card').clientWidth`), false)
        assert.equal(await execute(`document.querySelector('.system-event').scrollWidth > document.querySelector('.system-event').clientWidth`), false)
        const work = await execute(`(() => {
          const event = document.querySelector('${workEvent}');
          const payload = event.querySelector('.event-payload');
          const style = getComputedStyle(payload);
          const source = getComputedStyle(payload.querySelector('.payload-source'));
          const theme = getComputedStyle(document.documentElement);
          return {font:source.fontSize,weight:source.fontWeight,family:source.fontFamily,
            background:style.backgroundColor,color:style.color,radius:style.borderRadius,
            muted:theme.getPropertyValue('--c-bg-muted').trim(),secondary:theme.getPropertyValue('--c-text-secondary').trim(),
            overflow:event.scrollWidth > event.clientWidth || payload.scrollWidth > payload.clientWidth,
            nestedHeader:getComputedStyle(event.querySelector('.event-metadata > summary')).minHeight};
        })()`)
        assert.equal(work.font, '12px')
        assert.equal(work.weight, '400')
        assert.match(work.family, /monospace/)
        assert.equal(work.radius, '0px')
        assert.equal(work.overflow, false, 'Long work/session IDs wrap within the event rail')
        const rgb = (hex: string) => `rgb(${hex.slice(1).match(/../g)!.map(part => parseInt(part, 16)).join(', ')})`
        assert.equal(work.background, rgb(work.muted))
        assert.equal(work.color, rgb(work.secondary))
        assert.equal(work.nestedHeader, width === 390 ? '44px' : '40px')
        const colors = await execute(`(() => {
          const root = getComputedStyle(document.documentElement);
          const token = name => { const el = document.createElement('span'); el.style.color = root.getPropertyValue(name); document.body.append(el); const value = getComputedStyle(el).color; el.remove(); return value };
          const style = selector => getComputedStyle(document.querySelector(selector));
          return {
            foreground:style('.chat-assistant').color, expectedForeground:token('--c-text'),
            assistant:style('.chat-assistant').backgroundColor, expectedAssistant:token('--c-bg-card'),
            user:style('.chat-user').backgroundColor, expectedUser:token('--c-info-bg'),
            peer:style('.chat-session').backgroundColor, expectedPeer:token('--c-chat-action-bg'),
            decision:style('.yield-decision').borderLeftColor, expectedDecision:token('--c-purple'),
            action:style('.message-action').backgroundColor, expectedAction:token('--c-chat-action-bg'),
            source:style('.chat-session strong').color, secondary:token('--c-text-secondary'),
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
        await execute(`document.querySelector('.chat-session').scrollIntoView({block:'start'})`)
        await frame()
        await screenshot(`session-exchange-${width}-${dark ? 'dark' : 'light'}-expanded`)
        await setCardOpen('.chat-session', false)
        await setCardOpen('.message-action', false)
        for (const selector of ['.message-action', '.chat-session']) {
          assert.ok(await execute(`Math.abs(document.querySelector('${selector}').getBoundingClientRect().height - ${collapsedHeight}) < 1`), 'Short and long previews share the same fixed card height even on mobile')
        }
        const spacing = await execute(`(() => {
          const incoming = document.querySelector('.chat-session').getBoundingClientRect();
          const outgoing = document.querySelector('.message-action').getBoundingClientRect();
          const tool = document.querySelector('.tool-activity').getBoundingClientRect();
          return { expected:parseFloat(getComputedStyle(document.querySelector('.chat-message-list')).rowGap),
            exchange:outgoing.top - incoming.bottom, tool:tool.top - outgoing.bottom };
        })()`)
        assert.ok(Math.abs(spacing.exchange - spacing.expected) < 1, 'Session exchanges use the list gap without added margins')
        assert.ok(Math.abs(spacing.tool - spacing.expected) < 1, 'Session messages and ordinary tools share the same spacing')
        if (process.env.CONVERSATION_SCREENSHOTS) await delay(200)
        await screenshot(`session-exchange-${width}-${dark ? 'dark' : 'light'}-collapsed`)
        await setCardOpen('.chat-session', true)
        await setCardOpen('.message-action', true)
        await screenshot(`conversation-${width}-${dark ? 'dark' : 'light'}`)
        if (process.env.CONVERSATION_SCREENSHOTS) {
          await execute(`document.querySelector('${workEvent}').scrollIntoView({block:'center'})`)
          await frame()
          await screenshot(`work-event-${width}-${dark ? 'dark' : 'light'}`)
        }
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
    const target = '.message-action .session-message-link'
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
    await execute(`document.querySelector('.chat-session .session-message-link').click()`)
    assert.equal(await execute(`document.querySelector('.chat-session').dataset.expanded`), 'true', 'Session navigation does not toggle expansion')
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
    await execute(`document.querySelector('.message-action .message-preview-toggle').click()`)
    await wait(`document.querySelector('.message-action').getAnimations({subtree:true}).some(animation => animation.transitionProperty === 'grid-template-rows' && animation.effect.getComputedTiming().duration === 160)`)
    await wait(`document.querySelector('.message-action').getAnimations({subtree:true}).length === 0`)
    assert.ok(await execute(`Math.abs(document.querySelector('.message-action').getBoundingClientRect().height - ${collapsedHeight}) < 1`), 'Closing animation includes the border without a final height jump')
    assert.equal(await execute(`document.querySelector('.message-action-status').textContent`), 'Failed', 'Failure remains visible while collapsed')
    await execute(`window.__conversationFixture.messages[1].sessionSource.id = 'web:' + 'long-session-id'.repeat(30);
      window.__conversationFixture.messages[2].toolCall.arguments.sessionId = 'web:' + 'long-session-id'.repeat(30)`)
    await frame()
    for (const selector of ['.message-action', '.chat-session']) {
      assert.equal(await execute(`document.querySelector('${selector}').scrollWidth > document.querySelector('${selector}').clientWidth`), false, 'Long session IDs do not overflow narrow headers')
    }
    await setCardOpen('.message-action', true)
    await wait(`!!document.querySelector('.message-action-details')`)
    await execute(`document.querySelector('.message-action-details').open = true`)
    await wait(`document.querySelector('.message-action-details').textContent.includes('Error: peer is unavailable')`)
    await execute(`void window.__conversationFixture.messages.splice(3, 1)`)
    await wait(`document.querySelector('.message-action-status').textContent === 'No result recorded'`)
    await execute(`window.__conversationFixture.streaming = true`)
    await wait(`document.querySelector('.message-action-status').textContent === 'Sending...'`)
    await execute(`window.__conversationFixture.messages[2].toolCall.arguments.sessionId = ''`)
    await wait(`!document.querySelector('.message-action .session-message-link')`)
    assert.match(await execute(`document.querySelector('.message-action').textContent`), /Unknown recipient/)
    await wait(`document.querySelector('.message-action').getAnimations({subtree:true}).length === 0`)
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await execute(`document.querySelector('.message-action .message-preview-toggle').click()`)
    await wait(`document.querySelector('.message-action').dataset.expanded === 'false'`)
    assert.equal(await execute(`document.querySelector('.message-action').getAnimations({subtree:true}).length`), 0, 'Reduced motion disables height and chevron transitions')
    await execute(`document.querySelector('.message-action .message-preview-toggle').click()`)
    await wait(`document.querySelector('.message-action').dataset.expanded === 'true'`)
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    window.webContents.debugger.detach()
    if (process.env.CONVERSATION_EXCHANGES_ONLY) {
      assert.deepEqual(errors, [])
      console.log('CONVERSATION_SMOKE_OK')
      return
    }
    await execute(`(() => {
      const state = window.__conversationFixture;
      const request = {
        id:'proposal-new', sessionId:'web:owner', question:'Apply the proposed change to work:fixture (revision 2)?',
        options:['Apply this work proposal','Keep current work'], defaultOption:'Keep current work',
        recipient:{kind:'user',sessionId:'web:owner'}, createdAt:'2026-09-28T06:00:00Z', deadline:null,
        origin:{physicalId:'owner-0',toolCallId:'proposal-call'},
      };
      const answer = {requestId:request.id,option:request.options[0],answeredBy:'user',answeredAt:'2026-09-28T06:01:00Z'};
      state.streaming = false;
      state.messages = [
        {role:'user',content:'Before the original ask'},
        {role:'assistant',event:'tool_call',content:'',toolCallId:'proposal-call',
          toolCall:{name:'ask',arguments:{kind:'decision',proposal:{key:'work:fixture',id:'proposal'},brief:{}}}},
        {role:'tool',event:'tool_result',toolCallId:'proposal-call',content:JSON.stringify(answer)},
        {role:'user',content:'After the original ask'},
      ];
      state.decisionRecords = [
        {request:{...request,id:'proposal-old',question:'Earlier version of the proposal'},
          invalidated:{reference:{sessionId:'web:owner',physicalId:'owner-0',requestId:'proposal-old'},
            at:'2026-09-28T06:02:00Z',reason:'The task agreement changed.'}},
        {request,answer},
        {request:{...request,id:'outside',question:'Decision from unloaded history',
          origin:{physicalId:'owner-0',toolCallId:'missing-call'}}},
      ];
    })()`)
    await wait(`document.querySelectorAll('.yield-decision').length === 3`)
    for (const width of [1100, 390]) {
      window.setContentSize(width, 844)
      for (const dark of [false, true]) {
        await execute(`document.documentElement.classList.toggle('dark', ${dark})`)
        await frame()
        assert.deepEqual(await execute(`[...document.querySelectorAll('.yield-decision')].map(el => el.getAttribute('data-msg-idx'))`),
          ['5', '1', '4'], 'Unloaded history is separate; revised decisions stay at the original ask')
        assert.match(await execute(`document.querySelector('.unlinked-decisions').textContent`), /Unlinked decision history.*original ask/s)
        const positions = await execute(`(() => {
          const top = index => document.querySelector('[data-msg-idx="' + index + '"]').getBoundingClientRect().top;
          return [top(5),top(0),top(1),top(4),top(3)];
        })()`)
        assert.ok(positions.every((position: number, index: number) => index === 0 || position > positions[index - 1]),
          'Both current and invalidated cards must precede later conversation')
        assert.match(await execute(`document.querySelector('[data-msg-idx="4"]').textContent`), /revalidation required/)
        assert.equal(await execute(`document.querySelectorAll('.tool-activity').length`), 0, 'A bound ask is not duplicated in generic tool activity')
        assert.equal(await execute(`document.documentElement.scrollWidth > innerWidth`), false)
        await screenshot(`decision-placement-${width}-${dark ? 'dark' : 'light'}`)
      }
    }
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
            widths:[traces, summary].map(el => el.getBoundingClientRect().width),
            lefts:[traces, summary].map(el => el.getBoundingClientRect().left),
            headingNavigation:nav.closest('.conversation-heading-row') !== null && !nav.closest('.chat-history'),
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
        assert.equal(continuity.headingNavigation, true)
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
    await execute(`document.querySelector('[aria-label="View previous session"]').click()`)
    await wait(`document.querySelector('.segment-position')?.textContent === 'Viewing previous session'`)
    await execute(`document.querySelector('[aria-label="Back to current session"]').click()`)
    await wait(`document.querySelector('.segment-position')?.textContent === 'Current session'`)
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
    await execute(`document.querySelector('.composer-popover').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))`)
    await verifyConversationEvents(window, wait, frame, screenshot)
    assert.deepEqual(errors, [])
    console.log('CONVERSATION_SMOKE_OK')
  } finally { window.destroy() }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
