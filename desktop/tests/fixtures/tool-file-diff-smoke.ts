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
  window.webContents.on('console-message', details => { if (details.level === 'error' && !details.message.includes('503')) errors.push(details.message) })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const frame = () => execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const wait = async (code: string) => {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) { if (await execute(code)) return; await delay(40) }
    throw new Error(`Timed out: ${code}\n${await execute('document.body.innerText')}\n${errors.join('\n')}`)
  }
  try {
    await window.loadURL(new URL('__tool_diff', process.env.TOOL_DIFF_SMOKE_URL).href)
    await wait(`!!document.querySelector('.tool-activity')`)
    assert.equal(await execute(`document.querySelector('.tool-activity').open`), false)
    assert.equal(await execute(`document.querySelector('.tool-entry-content')`), null)
    assert.equal(await execute(`performance.getEntriesByType('resource').some(entry => entry.name.includes('/file-changes'))`), false)
    await execute(`document.querySelector('.tool-activity > summary').click()`)
    await wait(`document.querySelector('.tool-activity').open`)
    assert.equal(await execute(`document.querySelector('.tool-file-preview')`), null, 'Opening the batch alone does not fetch diffs')
    await execute(`document.querySelector('.tool-entry > summary').click()`)
    await wait(`document.querySelectorAll('.diff-row').length > 0 && [...document.querySelectorAll('.diff-token')].some(token => token.style.getPropertyValue('--file-token-light'))`)
    assert.equal(await execute(`document.querySelector('.diff-file-path').textContent`), 'src/release.ts')
    assert.equal(await execute(`document.querySelector('.tool-entry-details').open`), false)
    assert.equal(await execute(`document.querySelector('.tool-entry-details').getBoundingClientRect().height < 40`), true)
    assert.match(await execute(`document.querySelector('.diff-removed .diff-code').textContent`), /import \{ resolve \}/)
    assert.match(await execute(`document.querySelector('.diff-added .diff-code').textContent`), /import \{ relative, resolve \}/)
    assert.doesNotMatch(await execute(`document.querySelector('.diff-content').textContent`), /requested old|requested new|Result preview/)
    assert.equal(await execute(`document.querySelector('.diff-marker').getAttribute('aria-hidden')`), 'true')
    assert.equal(await execute(`document.querySelector('.diff-removed .diff-marker').getAttribute('data-marker')`), '-')
    assert.equal(await execute(`document.querySelector('.diff-added .diff-marker').getAttribute('data-marker')`), '+')
    assert.equal(await execute(`document.querySelector('.diff-removed .diff-line-number').getAttribute('data-line')`), '1')
    for (const width of [1100, 390]) {
      window.setContentSize(width, 844)
      for (const dark of [false, true]) {
        await execute(`document.documentElement.classList.toggle('dark', ${dark})`)
        await frame()
        assert.ok(await execute(`document.documentElement.scrollWidth <= innerWidth + 1`), 'Long source lines must not overflow the conversation')
        assert.ok(await execute(`{ const node=document.querySelector('.diff-scroll'); node.scrollWidth > node.clientWidth; }`), 'Long code scrolls inside its file preview')
        assert.equal(await execute(`getComputedStyle(document.querySelector('.diff-code')).whiteSpace`), 'pre')
        assert.equal(await execute(`getComputedStyle(document.querySelector('.diff-added')).backgroundColor === getComputedStyle(document.querySelector('.diff-removed')).backgroundColor`), false)
        assert.ok(await execute(`new Set([...document.querySelector('.diff-added .diff-code').children].map(token => getComputedStyle(token).color)).size > 1`), 'Source-language syntax colors are visible')
        if (process.env.TOOL_DIFF_SCREENSHOTS) await writeFile(join(process.env.TOOL_DIFF_SCREENSHOTS, `tool-diff-${width}-${dark ? 'dark' : 'light'}.png`), (await window.webContents.capturePage()).toPNG())
      }
    }
    await execute(`document.querySelector('.tool-details-header').click()`)
    await wait(`document.querySelector('.tool-entry-details').open`)
    assert.match(await execute(`document.querySelector('.tool-arguments').textContent`), /requested old/)
    assert.match(await execute(`document.querySelector('.tool-result').textContent`), /OK edit \+2 -2 edit=/)
    await execute(`document.querySelector('.tool-activity > summary').click()`)
    await wait(`!document.querySelector('.tool-file-preview')`)
    assert.equal(await execute(`window.__diffListenerCount()`), 0, 'Closing the preview removes all document selection listeners')
    await execute(`document.querySelector('.tool-activity > summary').click()`)
    await wait(`!!document.querySelector('.diff-content')`)
    for (const [id, text] of [
      ['unavailable', /Previous content was not readable/],
      ['noop', /No content changes/], ['missing', /No historical file diff was recorded/],
    ] as const) {
      await execute(`window.__diffFixture.id = '${id}'`)
      await wait(`!document.querySelector('.tool-file-preview').getAttribute('aria-busy').includes('true') && document.querySelector('.tool-file-preview').textContent.includes(${JSON.stringify(text.source.replaceAll('\\', ''))})`)
      assert.match(await execute(`document.querySelector('.tool-file-preview').textContent`), text)
      if (id === 'unavailable') {
        assert.match(await execute(`document.querySelector('.written-content').textContent`), /const value = 42/)
        assert.equal(await execute(`document.querySelector('.diff-content')`), null)
      }
    }
    await execute(`window.__diffFixture.id = 'retry'`)
    await wait(`!!document.querySelector('.preview-error')`)
    assert.match(await execute(`document.querySelector('.preview-error').textContent`), /503.*Retry/)
    await execute(`document.querySelector('.preview-error button').click()`)
    await wait(`!!document.querySelector('.diff-content')`)
    assert.equal(await execute(`document.querySelector('.preview-error')`), null)
    await execute(`window.__diffFixture.id = 'slow'`)
    await wait(`document.querySelector('.tool-file-preview').getAttribute('aria-busy') === 'true'`)
    await execute(`document.querySelector('.tool-entry > summary').click()`)
    await wait(`!document.querySelector('.tool-file-preview')`)
    await delay(500)
    assert.equal(await execute(`document.querySelector('.diff-content')`), null, 'A late response cannot reopen a closed preview')
    await execute(`window.__diffFixture.id = 'failed'; document.querySelector('.tool-entry > summary').click()`)
    await wait(`!!document.querySelector('.tool-result')`)
    assert.match(await execute(`document.querySelector('.tool-result').textContent`), /Error: write denied/)
    assert.equal(await execute(`document.querySelector('.tool-file-preview')`), null)
    assert.deepEqual(errors, [])
    console.log('TOOL_DIFF_SMOKE_OK')
  } finally { window.destroy() }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
