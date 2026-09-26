import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})
async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1200, height: 844,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (code: string) => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) { if (await execute(`Boolean(${code})`)) return; await delay(30) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}`)
  }
  const click = (text: string) => execute(`(() => {
    const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)});
    if (!button || button.disabled) throw new Error('Button unavailable: ' + ${JSON.stringify(text)});
    button.click();
  })()`)
  const fill = (index: number, value: string) => execute(`(() => {
    const field = document.querySelectorAll('textarea')[${index}];
    field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('input', {bubbles:true}));
  })()`)
  const trigger = (panel: 'reporting' | 'work') => execute(`document.querySelector('[data-session-work="${panel}"]').click()`)
  const collapsedLayouts = new Map<number, unknown>()
  const screenshot = async (state: string) => {
    for (const width of [1200, 390]) {
      window.setContentSize(width, 844)
      for (const dark of [false, true]) {
        await execute(`document.documentElement.classList.toggle('dark', ${dark})`)
        await execute(`document.querySelectorAll('.session-work-panel').forEach(panel => { panel.scrollTop = 0 })`)
        await delay(60)
        assert.equal(await execute(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true)
        const metrics = await execute(`(() => {
          const buttons = [...document.querySelectorAll('[data-session-work]')];
          return buttons.map(button => ({radius: getComputedStyle(button).borderRadius,
            height: button.getBoundingClientRect().height, top: button.getBoundingClientRect().top}));
        })()`)
        assert.equal(metrics.length, 2)
        assert.ok(metrics.every((button: { radius: string; height: number }) => button.radius === '0px' && button.height >= (width <= 700 ? 44 : 32)))
        assert.equal(metrics[0].top, metrics[1].top, 'Session controls stay in one compact row')
        const layout = await execute(`(() => {
          const toolbar = document.querySelector('.session-work-controls').getBoundingClientRect();
          const composer = document.querySelector('#fixture-composer').getBoundingClientRect();
          return { top: toolbar.top, height: toolbar.height, composerTop: composer.top };
        })()`)
        if (state === 'collapsed') collapsedLayouts.set(width, layout)
        else {
          assert.deepEqual(layout, collapsedLayouts.get(width), 'Opening the popover must not move the toolbar or composer')
          assert.equal(await execute(`(() => {
            const popup = document.querySelector('.session-work-panel');
            const rect = popup.getBoundingClientRect();
            const trigger = document.querySelector('[data-session-work="work"]').getBoundingClientRect();
            return popup.parentElement === document.body && getComputedStyle(popup).position === 'fixed'
              && rect.bottom <= trigger.top - 7 && rect.top >= 12 && rect.left >= 12
              && rect.right <= innerWidth - 11 && rect.height <= 421;
          })()`), true, 'Popover is a bounded overlay above its trigger, not an inline panel')
        }
        if (process.env.WORK_SCREENSHOTS) await writeFile(
          join(process.env.WORK_SCREENSHOTS, `session-controls-${state}-${width}-${dark ? 'dark' : 'light'}.png`),
          (await window.webContents.capturePage()).toPNG(),
        )
      }
    }
  }
  try {
    await window.loadURL(new URL('__work', process.env.WORK_SMOKE_URL).href)
    await wait(`document.querySelector('[data-session-work="work"]')`)
    assert.equal(await execute(`[...document.querySelectorAll('[data-session-work]')].every(button => button.getAttribute('aria-expanded') === 'false')`), true)
    assert.equal(await execute(`document.querySelector('.work-alignment').getBoundingClientRect().height`), 0)
    await screenshot('collapsed')
    await trigger('work')
    await wait(`document.body.innerText.includes('Run both evaluations')`)
    assert.match(await execute('document.body.innerText'), /Agent interpretation.*not a quoted user requirement/)
    assert.match(await execute('document.body.innerText'), /Agent-chosen next phase/)
    assert.match(await execute('document.querySelector("[aria-label=\\"Pending work proposal\\"]").textContent'), /New execution: paused/)
    await click('Fresh context')
    await wait(`document.body.innerText.includes('next safe boundary')`)
    await click('Confirm fresh')
    await wait(`![...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Confirm fresh')`)
    await click('Revise work')
    await wait(`document.querySelectorAll('textarea').length === 4`)
    await fill(0, 'Corrected final outcome')
    await fill(3, 'Conflict')
    await execute('window.fixture.revision++')
    await wait(`!document.querySelector('.work-alignment button').disabled`)
    assert.equal(await execute(`document.querySelector('.work-alignment textarea').value`), 'Corrected final outcome', 'Live work refresh preserves the exact draft')
    assert.equal(await execute(`document.querySelector('input[type=checkbox]').getBoundingClientRect().width < 32`), true)
    await trigger('reporting')
    await wait(`document.querySelector('.decision-owner select')`)
    assert.equal(await execute(`document.querySelector('.work-alignment').getBoundingClientRect().height`), 0)
    await execute(`(() => { const select = document.querySelector('.decision-owner select'); select.value = 'web:reviewer'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`)
    await trigger('work')
    await wait(`!document.querySelector('.work-alignment button').disabled`)
    await trigger('reporting')
    await wait(`!document.querySelector('.decision-owner select').disabled`)
    assert.equal(await execute(`document.querySelector('.decision-owner select').value`), 'web:reviewer', 'Switching panels must retain an unsaved reporting selection')
    await click('Save responsibility')
    await wait(`document.querySelector('.decision-owner').textContent.includes('Assigned to: web:reviewer')`)
    await trigger('work')
    await wait(`document.querySelector('[data-session-work="work"]').getAttribute('aria-expanded') === 'true' && !document.querySelector('.work-alignment button').disabled`)
    assert.equal(await execute(`document.querySelector('.work-alignment textarea').value`), 'Corrected final outcome', 'Switching panels must retain unsaved work')
    await execute(`document.querySelector('.work-alignment textarea').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab',bubbles:true}))`)
    assert.equal(await execute(`document.querySelector('[data-session-work="work"]').getAttribute('aria-expanded')`), 'true', 'Tab within the form must not dismiss it')
    await execute(`document.querySelector('.work-alignment textarea').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))`)
    await wait(`document.querySelector('[data-session-work="work"]').getAttribute('aria-expanded') === 'false'`)
    assert.equal(await execute(`document.activeElement.matches('[data-session-work="work"]')`), true)
    await trigger('work')
    await wait(`!document.querySelector('.work-alignment button').disabled`)
    await execute(`document.querySelector('form').requestSubmit()`)
    await wait(`document.querySelector('[role="alert"]')?.textContent.includes('revision changed')`)
    assert.equal(await execute(`document.querySelector('textarea').value`), 'Corrected final outcome')
    await fill(3, 'Correct agent interpretation, not a changed user request')
    await execute(`document.querySelector('form').requestSubmit()`)
    await wait(`!document.querySelector('form') && document.body.innerText.includes('Human-confirmed agreement')`)
    assert.match(await execute('document.body.innerText'), /Awaiting executor adoption/)
    await screenshot('expanded')
    assert.equal(await execute(`(() => { const panel = document.querySelector('.session-work-panel'); return panel.clientHeight <= 420 && panel.scrollHeight > panel.clientHeight })()`), true, 'Long forms scroll within the floating panel')
    await execute(`document.querySelector('#fixture-composer').dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}))`)
    await wait(`document.querySelector('[data-session-work="work"]').getAttribute('aria-expanded') === 'false'`)
    await trigger('work')
    await wait(`document.querySelector('[data-session-work="work"]').getAttribute('aria-expanded') === 'true'`)
    // Hidden Electron windows update activeElement but do not emit native focusin.
    await execute(`document.querySelector('#fixture-composer').focus(); document.activeElement.dispatchEvent(new FocusEvent('focusin', {bubbles:true}))`)
    await wait(`document.querySelector('[data-session-work="work"]').getAttribute('aria-expanded') === 'false'`)
    assert.equal(await execute(`document.activeElement.id`), 'fixture-composer', 'Outside focus must not be stolen')
    await trigger('work')
    await execute(`window.fixture.active = false`)
    await wait(`document.querySelector('[data-session-work="work"]').getAttribute('aria-expanded') === 'false'`)
    assert.equal(await execute(`document.querySelector('.session-work-panel').getBoundingClientRect().height`), 0)
    await execute(`window.fixture.active = true`)
    await trigger('work')
    await execute(`window.fixture.canWrite = false`)
    await wait(`document.body.innerText.includes('Corrected final outcome') && ![...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Revise work')`)
    assert.match(await execute('document.body.innerText'), /Corrected final outcome/)
    assert.equal(await execute(`document.querySelector('[data-session-work="reporting"]')`), null)
    await execute(`window.fixture.sessionId = 'web:another'`)
    await wait(`document.querySelector('[data-session-work="work"]').getAttribute('aria-expanded') === 'false'`)
    assert.equal(await execute(`document.querySelector('.work-alignment').getBoundingClientRect().height`), 0)
    console.log('WORK_SMOKE_OK')
  } finally { window.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
