import assert from 'node:assert/strict'
import { once } from 'node:events'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'
import { installRuntimeRequestAuthorization } from '../../src/runtime-authorization.ts'

app.setPath('userData', join(process.cwd(), 'profile'))
app.on('window-all-closed', () => {})
async function main() {
  await app.whenReady()
  const window = new BrowserWindow({ show: false, width: 1440, height: 900,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const update = installRuntimeRequestAuthorization(window.webContents.session, details => details.webContentsId === window.webContents.id)
  update({ apiBase: new URL(process.env.MICROAPPS_SMOKE_URL!).origin, launchToken: 'synthetic-host-token' })
  const wait = async (fn: () => Promise<unknown>, label: string) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) { if (await fn()) return; await delay(30) }
    throw new Error(`${label}\n${await execute('document.body.innerText')}`)
  }
  const button = (text: string) => `[...document.querySelectorAll('button')].find(b=>b.getClientRects().length&&b.textContent.trim()===${JSON.stringify(text)})`
  const click = async (text: string) => {
    await wait(() => execute(`!!${button(text)}&&!${button(text)}.disabled`), text)
    await execute(`${button(text)}.click()`)
  }
  const frame = () => {
    const result = window.webContents.mainFrame.frames.find(frame => frame.url.includes('127.0.0.1'))
    assert.ok(result, 'Isolated app frame exists')
    return result
  }
  const result = (text: string) => wait(() => frame().executeJavaScript(`document.querySelector('output')?.textContent===${JSON.stringify(text)}`), text)
  try {
    await window.loadURL(new URL('__microapps', process.env.MICROAPPS_SMOKE_URL).href)
    await wait(() => execute('!!document.querySelector("textarea")'), 'Coordinator draft')
    await wait(() => execute('document.querySelector(".project-dashboard-shell").classList.contains("has-coordinator") && document.body.innerText.includes("No work items yet")'), 'Dashboard ready')
    await click('Apps')
    await wait(() => execute('!!document.querySelector(".apps-list button")'), 'Saved app')
    await execute('document.querySelector(".apps-list button").click()')
    await wait(() => execute('!!document.querySelector(".app-confirm input") && !document.querySelector(".app-confirm input").disabled'), 'Review ready')
    await execute('document.querySelector("[aria-label=\\"Close coordinator panel\\"]").click()')
    await wait(() => execute('!!document.querySelector(".app-confirm input")'), 'Review details')
    assert.equal(await execute(`${button('Approve this version')}.disabled`), true)
    for (const width of [1440, 390]) {
      window.setContentSize(width, 900)
      for (const dark of [false, true]) {
        await execute(`document.documentElement.classList.toggle('dark',${dark})`)
        await delay(100)
        assert.equal(await execute('document.documentElement.scrollWidth<=document.documentElement.clientWidth'), true, 'Viewport does not overflow')
        assert.equal(await execute('document.querySelector(".micro-apps").scrollWidth<=document.querySelector(".micro-apps").clientWidth'), true, 'App review does not overflow')
        if (process.env.MICROAPPS_SCREENSHOTS) await writeFile(join(process.env.MICROAPPS_SCREENSHOTS,
          `apps-review-${width}-${dark ? 'dark' : 'light'}.png`), (await window.webContents.capturePage()).toPNG())
      }
    }
    window.setContentSize(1440, 900)
    await wait(() => execute('!document.querySelector(".app-confirm input").disabled'), 'Review ready after resize')
    await execute('document.querySelector(".app-confirm input").click()')
    await click('Approve this version')
    await wait(() => execute('!!document.querySelector(".app-acceptance .yield-question")'), 'Owner testing question')
    assert.equal(await execute('document.querySelector(".app-acceptance").textContent.includes("60 seconds")'), true)
    for (const width of [1440, 390]) {
      window.setContentSize(width, 900)
      await delay(100)
      assert.equal(await execute('document.querySelector(".micro-apps").scrollWidth<=document.querySelector(".micro-apps").clientWidth'), true, 'Acceptance question does not overflow')
      if (process.env.MICROAPPS_SCREENSHOTS) await writeFile(join(process.env.MICROAPPS_SCREENSHOTS,
        `apps-acceptance-${width}.png`), (await window.webContents.capturePage()).toPNG())
    }
    window.setContentSize(1440, 900)
    await execute(`[...document.querySelectorAll('.app-acceptance input[type="radio"]')].find(input=>input.value==='Not now; I will test it myself').click()`)
    await click('Continue')
    await wait(() => execute('document.querySelector(".app-acceptance h3").textContent.includes("paused")'), 'Testing paused by owner')
    assert.equal(await execute('!!document.querySelector(".app-acceptance .yield-question")'), false)
    for (const report of [false, true]) {
      assert.equal(await execute(`fetch('/__acceptance-fixture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({report:${report}})}).then(r=>r.ok)`), true)
      await click('Refresh')
      await wait(() => execute(`document.querySelector(".app-acceptance h3").textContent.includes(${JSON.stringify(report ? 'Report saved' : 'Author finished without a report')})`), 'Author outcome is visible')
      if (!report) {
        assert.equal(await execute(`!!${button('Ask to run tests again')}`), true)
        continue
      }
      assert.equal(await execute('document.querySelectorAll(".app-test-check").length'), 6)
      assert.equal(await execute('document.querySelector(".app-acceptance").textContent.includes("Saved preferences survive reopening")'), true)
      assert.equal(await execute('document.querySelectorAll(".app-test-check h4")[5].textContent.includes("not_tested")'), true)
      for (const width of [1440, 390]) {
        window.setContentSize(width, 900)
        await execute('document.querySelector(".app-acceptance").scrollIntoView({block:"start"})')
        await execute('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
        await delay(100)
        assert.equal(await execute('document.querySelector(".micro-apps").scrollWidth<=document.querySelector(".micro-apps").clientWidth'), true)
        if (process.env.MICROAPPS_SCREENSHOTS) await writeFile(join(process.env.MICROAPPS_SCREENSHOTS,
          `apps-coverage-${width}.png`), (await window.webContents.capturePage()).toPNG())
      }
    }
    window.setContentSize(1440, 900)
    await click('Open app')
    await wait(() => execute('!!document.querySelector("iframe")'), 'App iframe')
    await wait(async () => frame().executeJavaScript('typeof document.querySelector("#run")?.onclick === "function"'), 'App loaded')
    assert.equal(await frame().executeJavaScript('typeof require'), 'undefined')
    assert.equal(await frame().executeJavaScript(`(()=>{try{return !!parent.document.body}catch{return false}})()`), false)
    await frame().executeJavaScript('document.querySelector("#run").click()')
    await result('Result 1')
    assert.equal(new URL(frame().url).hash, '', 'Launch ticket consumed')
    const reloaded = once(window.webContents, 'did-frame-finish-load')
    await frame().executeJavaScript(`location.reload()`)
    await reloaded
    await wait(async () => frame().executeJavaScript('typeof document.querySelector("#run")?.onclick === "function"'), 'Reloaded SDK')
    await frame().executeJavaScript('document.querySelector("#run").click()')
    await result('Result 2')
    await frame().executeJavaScript('document.querySelector("#run").click()')
    await result('App call budget exhausted. The owner must review and renew its authorization.')
    await click('Close page')
    await click('Open app')
    await wait(() => execute('!!document.querySelector("iframe")'), 'Reopened page')
    await click('Stop')
    await wait(() => execute('!document.querySelector("iframe")'), 'Stopped frame')
    await wait(() => execute(`!!${button('Retry cleanup')}`), 'Retryable cleanup failure')
    assert.equal(await execute(`${button('Open app')}.disabled`), true)
    assert.equal(await execute('!!document.querySelector(".app-confirm")'), false)
    assert.equal(await execute('document.body.innerText.includes("temporary run removal")'), true)
    await click('Retry cleanup')
    await wait(() => execute('document.querySelector(".app-detail").textContent.includes("Stopped")'), 'Cleanup recovered')
    await click('Review details')
    await click('Revoke access and stop')
    await wait(() => execute('document.querySelector(".app-detail").textContent.includes("Needs review")'), 'Revoked grant')
    await execute('window.setAdmin(false)')
    await delay(50)
    assert.equal(await execute('!!document.querySelector(".app-confirm")'), false)
    await click('Back to work')
    assert.equal(await execute('document.querySelector("textarea").value'), 'Preserved draft')
    console.log('MICROAPPS_SMOKE_OK')
  } finally { window.destroy() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
