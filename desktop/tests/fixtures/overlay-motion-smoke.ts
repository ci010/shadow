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
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
  const errors: string[] = []
  window.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (code: string) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(10) }
    throw new Error(`Timed out: ${code}\n${errors.join('\n')}\n${await execute(`JSON.stringify({
      active:document.activeElement?.outerHTML,
      work:document.querySelector('.session-work-panel')?.outerHTML,
      trigger:document.querySelector('[data-session-work="subagents"]')?.outerHTML,
    })`)}`)
  }
  const settled = (selector: string) => wait(`(() => {
    const element = document.querySelector('${selector}');
    return element && ![...element.classList].some(name => /-(enter|leave)-active$/.test(name))
      && !element.getAnimations({subtree:true}).some(animation => animation instanceof CSSTransition);
  })()`)
  const escape = (selector: string) => execute(`document.querySelector('${selector}').dispatchEvent(
    new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`)
  const screenshot = async (name: string) => {
    if (process.env.OVERLAY_SCREENSHOTS) {
      await writeFile(join(process.env.OVERLAY_SCREENSHOTS, name + '.png'), (await window.webContents.capturePage()).toPNG())
    }
  }
  try {
    await window.loadURL(process.env.OVERLAY_URL!)
    await wait(`!!window.__overlay`)
    await execute(`document.querySelector('#tooltip-trigger').click()`)
    await wait(`document.querySelector('.hover-info-popup')?.classList.contains('overlay-enter-active')`)
    const entrance = await execute(`(() => {
      const element=document.querySelector('.hover-info-popup');
      const style=getComputedStyle(element), rect=element.getBoundingClientRect();
      return {duration:style.transitionDuration,property:style.transitionProperty,transform:style.transform,
        left:rect.left,top:rect.top,width:rect.width,height:rect.height};
    })()`)
    assert.equal(entrance.duration.split(', ')[0], '0.16s')
    assert.match(entrance.property, /opacity/)
    assert.match(entrance.property, /transform/, 'Position changes participate in the tooltip transition')
    await settled('.hover-info-popup')
    assert.equal(await execute(`getComputedStyle(document.querySelector('.hover-info-text')).whiteSpace`), 'pre-line')
    const stable = await execute(`(() => {const r=document.querySelector('.hover-info-popup').getBoundingClientRect();
      return {left:r.left,top:r.top,width:r.width,height:r.height}})()`)
    assert.equal(stable.width, entrance.width)
    assert.equal(stable.height, entrance.height)
    await execute(`window.__firstTooltip=document.querySelector('.shared-hover-info');
      document.querySelector('#tooltip-trigger').parentElement.dispatchEvent(new PointerEvent('pointerleave',{pointerType:'mouse'}));
      document.querySelector('#tooltip-second').parentElement.dispatchEvent(new PointerEvent('pointerenter',{pointerType:'mouse'}));`)
    await wait(`document.querySelector('.shared-hover-info')?.textContent.includes('Second tooltip content')`)
    assert.equal(await execute(`document.querySelector('.shared-hover-info') === window.__firstTooltip`), true,
      'Hovering a new source moves the same tooltip instead of mounting another')
    assert.equal(await execute(`document.querySelectorAll('[role="tooltip"]').length`), 1)
    assert.equal(await execute(`document.querySelector('.shared-hover-info').getAnimations().some(animation => animation.transitionProperty === 'transform')`), true,
      'Moving to another anchor animates translate')
    await settled('.shared-hover-info')
    assert.equal(await execute(`(() => {
      const source=document.querySelector('#tooltip-second'), card=document.querySelector('.shared-hover-info');
      const anchor=source.getBoundingClientRect(), popup=card.getBoundingClientRect();
      return Math.abs(popup.top-anchor.top)<1 && Math.abs(popup.left-anchor.right-8)<1
        && source.getAttribute('aria-describedby')===card.id
        && !document.querySelector('#tooltip-trigger').hasAttribute('aria-describedby');
    })()`), true, 'The shared tooltip reaches its new anchor and updates accessibility ownership')
    await escape('#tooltip-second')
    await wait(`document.querySelector('.hover-info-popup')?.classList.contains('overlay-leave-active')`)
    assert.deepEqual(await execute(`(() => {const el=document.querySelector('.hover-info-popup');
      return {inert:el.inert,hidden:el.getAttribute('aria-hidden'),duration:getComputedStyle(el).transitionDuration.split(', ')[0]}})()`),
    { inert: true, hidden: 'true', duration: '0.1s' })
    await wait(`!document.querySelector('.hover-info-popup')`)

    await execute(`document.querySelector('#info-trigger').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))`)
    await wait(`document.activeElement?.id === 'info-action'`)
    await settled('.hover-info-popup')
    await execute(`window.__conversationTooltip=document.querySelector('.hover-info-popup');
      document.querySelector('#info-second').parentElement.dispatchEvent(new PointerEvent('pointerenter',{pointerType:'mouse'}));`)
    await wait(`document.querySelector('.hover-info-popup')?.getAttribute('aria-label') === 'Second conversation'`)
    assert.equal(await execute(`document.querySelector('.hover-info-popup') === window.__conversationTooltip`), true,
      'Conversation information cards also reuse the same floating element')
    assert.equal(await execute(`document.querySelectorAll('.hover-info-popup').length`), 1)
    await settled('.hover-info-popup')
    await execute(`document.querySelector('#info-second').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))`)
    await wait(`document.activeElement?.id === 'info-second-action'`)
    await screenshot('shared-tooltip-desktop')
    await escape('#info-second-action')
    await wait(`document.activeElement?.id === 'info-second' && !document.querySelector('.hover-info-popup')`)

    await execute(`document.querySelectorAll('.history-marker')[0].dispatchEvent(new MouseEvent('mouseenter'))`)
    await settled('.history-preview')
    await execute(`window.__historyTooltip=document.querySelector('.history-preview');
      document.querySelectorAll('.history-marker')[1].dispatchEvent(new MouseEvent('mouseenter'))`)
    await wait(`document.querySelector('.history-preview')?.textContent.includes('Preview 1')`)
    assert.equal(await execute(`document.querySelector('.history-preview') === window.__historyTooltip`), true)
    assert.equal(await execute(`document.querySelector('.history-preview').getAnimations().some(animation => animation.transitionProperty === 'transform')`), true)
    await settled('.history-preview')
    await escape('.history-preview')
    await wait(`!document.querySelector('.history-preview')`)

    await execute(`document.querySelector('[aria-label="Desktop popup"]').click()`)
    await wait(`document.activeElement?.id === 'popup-action'`)
    await settled('.composer-popover-backdrop')
    await execute(`document.querySelector('#popup-action').click()`)
    await wait(`document.querySelector('.composer-popover-backdrop')?.inert`)
    assert.equal(await execute(`document.activeElement?.getAttribute('aria-label')`), 'Desktop popup')
    await wait(`!document.querySelector('.composer-popover-backdrop')`)

    await execute(`window.__overlay.shown=true`)
    await settled('#persistent-popup')
    await execute(`window.__overlay.shown=false`)
    await wait(`document.querySelector('#persistent-popup').inert`)
    await execute(`window.__overlay.shown=true`)
    await settled('#persistent-popup')
    assert.deepEqual(await execute(`(() => {const el=document.querySelector('#persistent-popup');
      return {inert:el.inert,hidden:el.getAttribute('aria-hidden'),opacity:getComputedStyle(el).opacity}})()`),
    { inert: false, hidden: null, opacity: '1' }, 'Reopening during exit restores the same popup')
    await execute(`window.__overlay.shown=false`)
    await wait(`getComputedStyle(document.querySelector('#persistent-popup')).display === 'none'`)

    await settled('.status-popover')
    await execute(`document.querySelector('.status-trigger').click()`)
    await wait(`document.querySelector('.status-popover').inert`)
    await wait(`getComputedStyle(document.querySelector('.status-popover')).display === 'none'`)
    await execute(`document.querySelector('.status-trigger').click()`)
    await settled('.status-popover')
    assert.equal(await execute(`document.querySelector('.status-popover').inert`), false)

    await execute(`document.querySelector('[data-session-work="subagents"]').click()`)
    await wait(`document.activeElement?.classList.contains('session-work-panel')`)
    await settled('.session-work-panel')
    await escape('.session-work-panel')
    await wait(`document.querySelector('.session-work-panel').inert`)
    assert.equal(await execute(`document.querySelector('.subagent-list').getClientRects().length > 0`), true,
      'Popup content remains visible throughout exit')
    await wait(`getComputedStyle(document.querySelector('.session-work-panel')).display === 'none'`)
    await execute(`document.querySelector('[data-session-work="subagents"]').click()`)
    await settled('.session-work-panel')
    assert.equal(await execute(`document.querySelector('.session-work-panel').inert`), false)
    await escape('.session-work-panel')

    window.setContentSize(390, 844)
    await execute(`document.querySelector('[aria-label="Sheet popup"]').click()`)
    await wait(`document.querySelector('.mobile-sheet-backdrop.mobile-sheet-enter-active') !== null`)
    await settled('.mobile-sheet-backdrop:not([aria-hidden])')
    await screenshot('overlay-sheet-mobile')
    await execute(`document.querySelector('#sheet-action').click()`)
    await wait(`!!document.querySelector('.mobile-sheet-backdrop.mobile-sheet-leave-active')`)
    assert.equal(await execute(`document.activeElement?.getAttribute('aria-label')`), 'Sheet popup')
    await wait(`document.querySelectorAll('.mobile-sheet-backdrop').length === 1`)
    assert.equal(await execute(`document.documentElement.scrollWidth > innerWidth`), false)

    await execute(`document.querySelector('[aria-label="Sheet popup"]').click()`)
    await settled('.mobile-sheet-backdrop:not([aria-hidden])')
    await execute(`document.querySelector('#sheet-action').click()`)
    await wait(`!!document.querySelector('.mobile-sheet-backdrop.mobile-sheet-leave-active')`)
    await execute(`document.querySelector('[aria-label="Sheet popup"]').click()`)
    await settled('.mobile-sheet-backdrop:not([aria-hidden])')
    assert.equal(await execute(`document.querySelectorAll('#sheet-action').length`), 1,
      'Reopening cancels sheet exit without unmounting its content')
    await execute(`document.querySelector('#sheet-action').click()`)
    await wait(`document.querySelectorAll('.mobile-sheet-backdrop').length === 1`)

    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })
    for (const side of [false, true]) {
      await execute(`window.__overlay.side=${side};window.__overlay.sheet=true`)
      await wait(`document.querySelector('.mobile-sheet-backdrop').getAttribute('aria-hidden') === null`)
      assert.equal(await execute(`getComputedStyle(document.querySelector('.mobile-sheet-backdrop')).transitionDuration`), '0s')
      assert.equal(await execute(`getComputedStyle(document.querySelector('.mobile-sheet')).transitionDuration`), '0s')
      await execute(`window.__overlay.sheet=false`)
      await wait(`getComputedStyle(document.querySelector('.mobile-sheet-backdrop')).display === 'none'`)
    }
    await execute(`document.querySelector('#tooltip-trigger').click()`)
    await wait(`!!document.querySelector('.hover-info-popup')`)
    assert.equal(await execute(`getComputedStyle(document.querySelector('.hover-info-popup')).transitionDuration`), '0s')
    await escape('#tooltip-trigger')
    await wait(`!document.querySelector('.hover-info-popup')`)
    await execute(`window.__overlay.first=false`)
    await execute(`document.querySelector('#tooltip-second').parentElement.dispatchEvent(new PointerEvent('pointerenter',{pointerType:'mouse'}))`)
    await wait(`document.querySelector('.hover-info-popup')?.textContent.includes('Second tooltip content')`)
    assert.equal(await execute(`document.querySelectorAll('.hover-info-popup').length`), 1,
      'Unmounting the previous rendering host transfers tooltip ownership')
    await escape('#tooltip-second')
    await wait(`!document.querySelector('.hover-info-popup')`)
    window.webContents.debugger.detach()
    assert.deepEqual(errors, [])
    console.log('OVERLAY_MOTION_OK')
  } finally {
    window.destroy()
    app.quit()
  }
}

void main().catch(error => { console.error(error); app.exit(1) })
