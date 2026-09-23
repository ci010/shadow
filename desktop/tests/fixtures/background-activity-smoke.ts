import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1280, height: 900,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const errors: string[] = []
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 2) errors.push(message) })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (code: string) => {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(50) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}\n${errors.join('\n')}`)
  }
  const chip = (panel: string) => `[data-session-work="${panel}"]`
  const click = (selector: string) => execute(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const ownerRow = `[...document.querySelectorAll('.folder-session-row')].find(row => row.querySelector('.session-select')?.getAttribute('aria-label')?.startsWith('Owner conversation'))`
  const change = async (query: string) => {
    await execute(`fetch('/fixture-state?${query}').then(() => window.__invalidate())`)
    await delay(200)
  }
  const close = async (panel: string) => {
    await execute(`document.querySelector('.session-work-panel').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
    await wait(`document.activeElement?.matches(${JSON.stringify(chip(panel))})`)
  }
  try {
    await window.loadURL(new URL('projects/a/chat/web%3Achat-owner', process.env.BACKGROUND_ACTIVITY_URL).href)
    await wait(`document.querySelector('${chip('background')}') && document.querySelector('${chip('subagents')}')`)
    assert.equal(await execute(`document.querySelector('.chat-composer .background-tasks')`), null, 'No separate full-width task row')
    assert.equal(await execute(`document.querySelectorAll('.session-work-triggers > button').length`), 4)
    await wait(`(${ownerRow})?.querySelectorAll('.subagent-running .activity-wave i').length === 3`)
    const bars = await execute(`[...(${ownerRow}).querySelectorAll('.activity-wave i')].map(bar => {
      const style = getComputedStyle(bar); return {name:style.animationName,delay:style.animationDelay,width:style.width,height:style.height};
    })`)
    assert.equal(new Set(bars.map((bar: { delay: string }) => bar.delay)).size, 3, 'Bars animate out of phase')
    assert.ok(bars.every((bar: { name: string; width: string; height: string }) => bar.name.includes('activity-wave') && bar.width === '3px' && bar.height === '13px'))
    assert.equal(await execute(`(${ownerRow}).querySelector('.session-activity').getAttribute('aria-label')`), 'Ready · 2 subagents working')
    assert.equal(await execute(`document.querySelector('[aria-label="Stop current request"]')`), null, 'Delegated work does not make the parent request busy')
    await click(chip('background'))
    await wait(`document.querySelector('.background-title')?.getClientRects().length && document.querySelector('.background-title').textContent === 'Build preview server'`)
    await close('background')
    await click(chip('subagents'))
    await wait(`document.querySelectorAll('.subagent-inspect').length === 2 && document.querySelector('.subagent-inspect').getClientRects().length`)
    assert.equal(await execute(`document.querySelectorAll('.subagent-inspect .activity-wave i').length`), 6)
    assert.equal(await execute(`document.querySelectorAll('.subagent-inspect .activity-spinner').length`), 0)
    await click('[data-subagent-id="worker"]')
    await wait(`new URL(location.href).searchParams.get('child') === 'worker'`)
    await execute(`window.__navigate('web:chat-other')`)
    await wait(`!document.querySelector('${chip('subagents')}') && document.querySelector('textarea')`)
    assert.ok(await execute(`(${ownerRow})?.querySelector('.subagent-wave')`), 'Hidden owner retains live delegated activity')
    await change('phase=completed')
    await wait(`!(${ownerRow})?.querySelector('.subagent-activity')`)
    await execute(`window.__navigate('web:chat-owner')`)
    await wait(`document.querySelector('${chip('background')}') && !document.querySelector('${chip('subagents')}')`)
    await change('phase=waiting')
    await wait(`(${ownerRow})?.querySelector('.subagent-waiting')`)
    assert.equal(await execute(`(${ownerRow}).querySelector('.subagent-wave')`), null)
    assert.match(await execute(`(${ownerRow}).querySelector('.session-activity').getAttribute('aria-label')`), /subagent waiting for a response/)
    await change('phase=pending')
    await wait(`(${ownerRow})?.querySelector('.subagent-pending')`)
    await change('phase=running&parent=waiting')
    await wait(`(${ownerRow})?.querySelector('.session-activity.waiting') && (${ownerRow})?.querySelector('.subagent-running')`)
    assert.match(await execute(`(${ownerRow}).textContent`), /Needs reply/)
    await change('parent=failed')
    await wait(`(${ownerRow})?.querySelector('.session-activity.failed') && (${ownerRow})?.querySelector('.subagent-running')`)
    await change('parent=idle&background=error')
    await click(chip('background'))
    await wait(`document.querySelector('.background-error')?.getClientRects().length`)
    await execute(`fetch('/fixture-state?background=running')`)
    await click('.background-retry')
    await wait(`!document.querySelector('.background-error') && document.querySelector('.background-title')`)
    await close('background')
    window.setSize(390, 844)
    await delay(250)
    assert.ok(await execute(`document.documentElement.scrollWidth <= innerWidth + 1`), 'Chips wrap without page overflow')
    await click(chip('subagents'))
    await wait(`document.querySelector('.subagent-inspect')?.getClientRects().length`)
    assert.ok(await execute(`{ const rect=document.querySelector('.session-work-panel').getBoundingClientRect(); rect.left>=0 && rect.right<=innerWidth && rect.top>=0; }`), 'Popup stays inside the narrow viewport')
    await change('phase=cancelled')
    await wait(`document.querySelector('.subagent-list').textContent.includes('No subagents active.')`)
    await close('work')
    await wait(`!document.querySelector('${chip('subagents')}')`)
    await click(chip('background'))
    await change('background=empty')
    await wait(`document.querySelector('.background-empty')?.textContent === 'No background tasks running.'`)
    await close('work')
    await wait(`!document.querySelector('${chip('background')}')`)
    assert.ok(!errors.some(error => error.includes('Unhandled error')), errors.join('\n'))
    console.log('BACKGROUND_ACTIVITY_SMOKE_OK')
  } finally { window.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
