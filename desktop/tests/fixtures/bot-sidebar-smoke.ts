import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { Hono } from 'hono'
import { uiPlugin } from '../../../src/gateway/ui.ts'
import { channelSessionId } from '../../../src/bus/events.ts'
import { LiveFixture } from './live-fixture.ts'

function argument(name: string): string {
  const value = process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  assert.ok(value)
  return resolve(value)
}
const directory = argument('layout-root')
const selectionOnly = process.argv.includes('--selection-only')
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps'] as const) {
  mkdirSync(join(directory, name), { recursive: true })
  app.setPath(name, join(directory, name))
}
app.setPath('home', directory)
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.on('window-all-closed', () => {})
const ui = new Hono()
uiPlugin(argument('layout-assets'))(ui)
const live = new LiveFixture()
const publisher = live.hub.registerProject('a')
live.hub.registerProject('b')
let supportStage = 'tool'
const id = (projectId: string, botInstanceId: string, conversationId: string) =>
  channelSessionId({ projectId, botInstanceId, platform: 'qq', conversationId })
const supportDm = id('a', 'qq-one', 'dm:person')
const previousSegments = new Map([[supportDm, 'support-previous'], ['support-previous', 'support-oldest']])
let rejectSegmentRead = false
const supportGroup = id('a', 'qq-one', 'group:room')
const personalDm = id('a', 'qq-two', 'dm:person')
const personalGroup = id('a', 'qq-two', `group:${'shared-room-'.repeat(24)}`)
const folderChat = id('a', 'qq-one', 'group:folder')
const foreignDm = id('b', 'qq-one', 'dm:person')
const sessions = [
  { projectId: 'a', sessionId: supportDm, title: 'Support DM' },
  { projectId: 'a', sessionId: personalGroup, title: 'Personal room' },
  { projectId: 'a', sessionId: supportGroup, title: 'Support room' },
  { projectId: 'a', sessionId: personalDm, title: 'Personal DM' },
  { projectId: 'a', sessionId: folderChat, title: 'Folder room', folderId: 'code' },
  { projectId: 'a', sessionId: 'web:chat-plain', title: 'Ordinary chat' },
  { projectId: 'a', sessionId: 'qq:legacy', title: 'Unassociated legacy chat' },
  { projectId: 'b', sessionId: foreignDm, title: 'Other Project DM' },
]
const bots = [
  { id: 'qq-one', projectId: 'a', displayName: 'Support bot' },
  { id: 'qq-two', projectId: 'a', displayName: 'Personal bot' },
  { id: 'qq-one', projectId: 'b', displayName: 'Other Project bot' },
].map(bot => ({ ...bot, platform: 'qq', label: 'QQ', enabled: true, configured: true, state: 'connected', config: { enabled: true }, secrets: {} }))
const deletions: Array<{ projectId: string; sessionId: string }> = []
let rejectDeletion = false
let unavailableBotStatus = false
const deletionFailure = 'Synthetic backend detail: a concurrent operation prevented deletion. The shared legacy transcript was retained for another conversation. Retry only after the other operation finishes.'
const errors: string[] = []
let window: BrowserWindow | undefined
const server = createServer(async (request, response) => {
  try {
    if (live.handle(request, response)) return
    const url = new URL(request.url!, 'http://127.0.0.1')
    const scope = url.pathname.match(/^\/projects\/([^/]+)(\/.*)$/)
    const projectId = scope?.[1] ?? 'a'
    const path = scope?.[2] ?? url.pathname
    const json = (body: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)) }
    if (path === '/api/projects') return json({ projects: [{ id: 'a', name: 'Project A', createdAt: '' }, { id: 'b', name: 'Project B', createdAt: '' }] })
    if (path === '/api/channels') return unavailableBotStatus && projectId === 'a'
      ? json({ error: 'unavailable' }, 503) : json({ channels: bots.filter(bot => bot.projectId === projectId) })
    if (path === '/api/folders') return json({ folders: projectId === 'a' ? [{ id: 'code', projectId, name: 'Code', path: 'C:\\fixture\\code', createdAt: '' }] : [] })
    if (path === '/api/automations') return json({ automations: [] })
    if (path === '/api/agent-resources/publication-requests') return json({ request: null })
    if (path === '/api/agent-resources/probe-requests') return json({ requests: [] })
    if (path === '/api/sessions/graph') return json({ sessions: sessions.filter(row => row.projectId === projectId).map(row => ({ ...row, current: `physical-${row.sessionId}` })), nodes: [] })
    if (path === '/api/sessions/stages') return json({ stages: projectId === 'a' ? { [supportGroup]: supportStage, [supportDm]: 'inactive' } : {} })
    if (path === '/api/provider/setup') return json({ ready: true, provider: 'custom', model: 'synthetic', authMode: 'none', hasApiKey: false })
    if (path === '/api/provider/configured') return json({ providers: [] })
    if (path === '/debug/models') return json({ models: ['synthetic'] })
    if (path === '/api/config') return json({ agent: { model: 'synthetic', temperature: .7, workspace: directory } })
    if (path === '/nodes/v1') return json({ version: 1, nodes: [] })
    if (path === '/api/chat/session') return json({ history: [], systemPrompt: 'Synthetic fixture.', tools: [] })
    if (/^\/api\/(?:folders|sessions)\/[^/]+\/files$/.test(path)) return json({ path: '', entries: [], workdir: { kind: 'local', displayPath: 'C:\\fixture' } })
    if (/\/git\/status$/.test(path)) return json({ available: false, reason: 'not_repository', entries: [] })
    const route = path.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/)
    if (route) {
      const sessionId = decodeURIComponent(route[1])
      const record = sessions.find(row => row.projectId === projectId && row.sessionId === sessionId)
      if (!route[2] && request.method === 'DELETE') {
        assert.ok(record)
        deletions.push({ projectId, sessionId })
        if (rejectDeletion) {
          rejectDeletion = false
          return json({ error: 'session_delete_failed', message: deletionFailure }, 503)
        }
        sessions.splice(sessions.indexOf(record), 1)
        return json({ deleted: [sessionId] })
      }
      if (route[2] === 'background-tasks') return json({ sessionId, total: 0, tasks: [] })
      if (route[2] === 'context') return json({ systemPrompt: 'Synthetic bot context.', tools: [] })
      if (route[2] === 'details') return json({
        sessionId, name: record?.title, workdir: { kind: 'local', displayPath: 'C:\\fixture' },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, usageScope: 'session', context: { usedTokens: null, windowTokens: null },
      })
      if (!route[2]) {
        if (sessionId === 'support-oldest' && rejectSegmentRead) { rejectSegmentRead = false; return json({ error: 'synthetic_history_failure' }, 503) }
        return json({ messages: [{ role: 'user', content: record?.title ?? sessionId }], currentPhysicalId: `physical-${sessionId}`, previousPhysicalId: previousSegments.get(sessionId) ?? null })
      }
    }
    if (/^\/(?:api|nodes|debug|local)\//.test(path)) {
      errors.push(`Unexpected ${request.method} ${projectId} ${path}`)
      return json({ error: 'Unstubbed endpoint' }, 404)
    }
    const resource = await ui.request(url.toString())
    const type = resource.headers.get('Content-Type') || 'application/octet-stream'
    response.writeHead(resource.status, { 'Content-Type': type })
    const bytes = Buffer.from(await resource.arrayBuffer())
    response.end(type.includes('text/html') ? bytes.toString().replace(/<link\b[^>]*href=["']https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '') : bytes)
  } catch (error) {
    errors.push(String(error))
    response.writeHead(500).end()
  }
})
const evaluate = <T = unknown>(source: string): Promise<T> => window!.webContents.executeJavaScript(source)
async function waitFor(source: string): Promise<void> {
  const end = Date.now() + 8000
  while (Date.now() < end) {
    if (await evaluate(source)) return
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error(`Timed out ${source}; ${JSON.stringify(errors)}`)
}
async function click(selector: string): Promise<void> {
  await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`)
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
}
async function key(selector: string, space = false): Promise<void> {
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  await new Promise(resolve => setTimeout(resolve, 100))
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)
  assert.equal(await evaluate(`document.activeElement === document.querySelector(${JSON.stringify(selector)})`), true, 'Disclosure receives keyboard focus')
  const event = { key: space ? ' ' : 'Enter', code: space ? 'Space' : 'Enter', windowsVirtualKeyCode: space ? 32 : 13 }
  await window!.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...event, text: space ? ' ' : '\r' })
  await window!.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
}
async function assertDeleteDialog(width: number, failed: boolean): Promise<void> {
  const geometry = await evaluate<{
    bounded: boolean; overflow: number; warning: string; identity: string; identityLines: number
    error: string; errorLines: number; copyVisible: boolean
  }>(`(() => {
    const dialog = document.querySelector('dialog.session-delete-dialog');
    const r = dialog.getBoundingClientRect();
    const identity = dialog.querySelector('.delete-target span');
    const warning = document.getElementById(dialog.getAttribute('aria-describedby'));
    const error = dialog.querySelector('[role="alert"]');
    const lines = node => node ? node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight) : 0;
    return {
      bounded: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
      overflow: dialog.scrollWidth - dialog.clientWidth,
      warning: warning.textContent, identity: identity.textContent, identityLines: lines(identity),
      error: error?.textContent ?? '', errorLines: lines(error),
      copyVisible: [identity, warning, error].filter(Boolean).every(node => {
        const b = node.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && b.left >= r.left && b.right <= r.right && b.top >= r.top && b.bottom <= r.bottom;
      }),
    };
  })()`)
  assert.ok(geometry.bounded && geometry.overflow <= 1 && geometry.copyVisible, `Deletion copy fits ${width}px: ${JSON.stringify(geometry)}`)
  assert.equal(geometry.identity, personalGroup)
  assert.ok(geometry.identityLines >= 2, `${width}px: long bot identity wraps rather than clipping`)
  assert.ok(geometry.warning.includes('Shared history may be kept to protect other conversations.'))
  if (failed) {
    assert.ok(geometry.error.includes(deletionFailure), 'The server explanation, not just its HTTP status, reaches the dialog')
    assert.ok(geometry.errorLines >= 2, `${width}px: backend error wraps and remains visible`)
  } else assert.equal(geometry.error, '')
  const { bounded, overflow, identityLines, errorLines, copyVisible } = geometry
  console.log(`LAYOUT_DELETE ${JSON.stringify({ viewportWidth: width, failed, bounded, overflow, identityLines, errorLines, copyVisible })}`)
}
async function main(): Promise<void> {
  await app.whenReady()
  console.log('LAYOUT_PHASE ready')
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({
    cancel: !details.url.startsWith(origin + '/') && !/^(data:|blob:|devtools:)/.test(details.url),
  }))
  window = new BrowserWindow({ width: 1440, height: 1000, show: false, webPreferences: {
    offscreen: true, backgroundThrottling: false, preload: join(directory, 'layout-preload.cjs'), additionalArguments: [`--layout-api-base=${origin}`],
  } })
  const projectA = '[data-project-id="a"]'
  const support = `${projectA} [data-bot-id="qq-one"]`
  const personal = `${projectA} [data-bot-id="qq-two"]`
  const other = '[data-project-id="b"] [data-bot-id="qq-one"]'
  const assertChatSelection = async (label: string) => {
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.projects-sidebar .tree-item.selected')).map(row => ({
      chat: row.classList.contains('folder-session-row'),
      current: row.querySelector('.session-select')?.getAttribute('aria-current'),
      label: row.querySelector('.tree-label')?.textContent.trim(),
    }))`), [{ chat: true, current: 'page', label }], 'Only the current chat, not its bot or folder, is highlighted')
  }
  for (const [width, height] of [[1440, 1000], [390, 844]]) {
    supportStage = 'tool'
    window.setContentSize(width, height)
    console.log(`LAYOUT_PHASE load-${width}`)
    await window.loadURL(`${origin}/projects/a/chat/${encodeURIComponent(supportDm)}`)
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor(`document.querySelector(${JSON.stringify(support)})?.textContent.includes('Support bot') && document.querySelector(${JSON.stringify(other)})?.textContent.includes('Other Project bot')`)
    if (width < 700) await click('.projects-toggle')
    await assertChatSelection('Support DM')
    const connection = `${support} .bot-connection`
    const segment = (label: string) => `.conversation-heading-row [aria-label="${label}"]`
    await waitFor(`document.querySelector(${JSON.stringify(segment('View previous session'))})?.disabled === false`)
    const headingHeight = await evaluate(`document.querySelector('.conversation-heading-row').getBoundingClientRect().height`)
    assert.equal(await evaluate(`document.querySelectorAll('.chat-messages .segment-nav').length`), 0)
    await click(segment('View previous session'))
    await waitFor(`document.querySelector('.chat-message-list')?.textContent.includes('support-previous')`)
    rejectSegmentRead = true
    await click(segment('View previous session'))
    await waitFor(`document.querySelector('.composer-error')?.textContent.includes('Could not load this historical segment')`)
    assert.equal(await evaluate(`document.querySelector('.chat-message-list').textContent.includes('support-previous')`), true)
    await click(segment('View previous session'))
    await waitFor(`document.querySelector('.chat-message-list')?.textContent.includes('support-oldest')`)
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(segment('View previous session'))}).disabled`), true)
    await click(segment('View next session'))
    await waitFor(`document.querySelector('.chat-message-list')?.textContent.includes('support-previous')`)
    await click(segment('View next session'))
    await waitFor(`document.querySelector('.segment-position')?.textContent === 'Current session'`)
    await click(segment('View previous session'))
    await waitFor(`document.querySelector('.chat-message-list')?.textContent.includes('support-previous')`)
    await click(segment('Back to current session'))
    await waitFor(`document.querySelector('.segment-position')?.textContent === 'Current session'`)
    assert.equal(await evaluate(`document.querySelector('.conversation-heading-row').getBoundingClientRect().height`), headingHeight)
    await waitFor(`document.querySelector(${JSON.stringify(connection)})?.dataset.state === 'connected'`)
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(connection)}).textContent.trim()`), '', 'Connection is icon-only')
    assert.match(await evaluate<string>(`document.querySelector(${JSON.stringify(`${support} .bot-toggle`)}).getAttribute('aria-label')`), /Connected/)
    const connectionGeometry = await evaluate<{ rightAligned: boolean; visibleIcon: boolean }>(`(() => {
      const button = document.querySelector(${JSON.stringify(`${support} .bot-toggle`)}).getBoundingClientRect();
      const icon = document.querySelector(${JSON.stringify(connection)}), bounds = icon.getBoundingClientRect();
      const style = getComputedStyle(icon.firstElementChild);
      return { rightAligned: button.right - bounds.right <= 2 && bounds.left > button.left,
        visibleIcon: bounds.width > 0 && (style.maskImage !== 'none' || style.backgroundImage !== 'none') };
    })()`)
    assert.deepEqual(connectionGeometry, { rightAligned: true, visibleIcon: true })
    for (const state of ['connecting', 'disconnected', 'error', 'running', 'connected']) {
      bots[0]!.state = state
      publisher.invalidateSessions(supportGroup)
      await waitFor(`document.querySelector(${JSON.stringify(connection)})?.dataset.state === ${JSON.stringify(state)}`)
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${other} .bot-connection`)}).dataset.state`), 'connected')
      if (state === 'connecting') {
        const bars = `${connection} .working-wave i`
        await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
        assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(bars)})).map(bar => {
          const style = getComputedStyle(bar);
          return { width: style.width, radius: style.borderRadius, duration: style.animationDuration, delay: style.animationDelay };
        })`), [
          { width: '3px', radius: '0px', duration: '1.2s', delay: '0s' },
          { width: '3px', radius: '0px', duration: '1.2s', delay: '0.15s' },
          { width: '3px', radius: '0px', duration: '1.2s', delay: '0.3s' },
        ])
        const transform = () => evaluate<string>(`getComputedStyle(document.querySelector(${JSON.stringify(bars)})).transform`)
        const before = await transform()
        await new Promise(resolve => setTimeout(resolve, 200))
        assert.notEqual(await transform(), before, 'Connecting bars must visibly animate, not just carry an animation class')
        await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
        assert.equal(await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(bars)})).animationName`), 'none')
        await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
      } else {
        assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(`${connection} .working-wave`)}).length`), 0)
      }
    }
    unavailableBotStatus = true
    publisher.invalidateSessions(supportGroup)
    await waitFor(`document.querySelector(${JSON.stringify(connection)})?.dataset.state === 'unknown'`)
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(support)}).textContent.includes('Support bot')`), true, 'Names and chats remain available after status failure')
    unavailableBotStatus = false
    publisher.invalidateSessions(supportGroup)
    await waitFor(`document.querySelector(${JSON.stringify(connection)})?.dataset.state === 'connected'`)
    await evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{ writeText:async value => {
      if (window.rejectCopy) throw new Error('Clipboard denied');
      window.copiedValue = value;
    } } })`)
    const openInfo = async (selector: string) => {
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight',bubbles:true,cancelable:true}))`)
      await waitFor(`document.querySelector('.hover-info-popup[role="dialog"]')?.contains(document.activeElement)`)
    }
    const closeInfo = async () => {
      await window!.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await window!.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await waitFor(`!document.querySelector('.hover-info-popup')`)
    }
    const captureInfo = async (name: string) => {
      for (const dark of [false, true]) {
        await evaluate(`document.documentElement.classList.toggle('dark', ${dark})`)
        await new Promise(resolve => setTimeout(resolve, 60))
        assert.equal(await evaluate(`(() => {
          const popup = document.querySelector('.hover-info-popup'); const r = popup.getBoundingClientRect();
          return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && popup.scrollWidth <= popup.clientWidth;
        })()`), true)
        await writeFile(join(directory, `${name}-${width}-${dark ? 'dark' : 'light'}.png`), (await window.webContents.capturePage()).toPNG())
      }
    }
    await openInfo(`${support} .bot-toggle`)
    assert.equal(await evaluate(`document.querySelector('.bot-info-title').textContent`), 'Support bot')
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.bot-info-details dt')).map(node => node.textContent)`), ['Platform', 'Bot ID'])
    assert.equal(await evaluate(`document.querySelector('.bot-info-details dd').textContent`), 'QQ')
    await captureInfo('bot-info')
    await click('.bot-info button[aria-label="Copy Bot ID"]')
    await waitFor(`document.querySelector('.bot-info [role="status"]')?.textContent === 'Copied'`)
    assert.equal(await evaluate('window.copiedValue'), 'qq-one')
    await closeInfo()
    await openInfo(`${support} .session-select`)
    await waitFor(`document.querySelector('.session-info .status-icon')`)
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.session-info .status-icon')).maskImage !== 'none'`), true)
    assert.equal(await evaluate(`document.querySelector('.session-info .activity-label').textContent`), 'Inactive')
    await captureInfo('chat-info')
    await click('.session-info button[aria-label="Copy Session ID"]')
    await waitFor(`document.querySelector('.session-info [role="status"]')?.textContent === 'Copied'`)
    assert.equal(await evaluate('window.copiedValue'), supportDm)
    await evaluate('window.rejectCopy = true')
    await click('.session-info .copyable-id button')
    await waitFor(`document.querySelector('.session-info [role="alert"]')?.textContent.includes('Could not copy')`)
    assert.equal(await evaluate(`document.querySelector('.session-info-id .copy-value').textContent`), supportDm)
    await evaluate('window.rejectCopy = false')
    await closeInfo()
    assert.equal(await evaluate(`document.activeElement.matches(${JSON.stringify(`${support} .session-select`)})`), true)
    assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(`${projectA} .bot-conversations`)}).length`), 2)
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(support)}).textContent.includes('Personal room')`), false)
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(projectA)}).textContent.includes('Other Project DM')`), false)
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(support)}).textContent.includes('Folder room')`), false)
    await click(`${projectA} [aria-label="Expand folder Code"]`)
    await waitFor(`document.querySelector(${JSON.stringify(`${projectA} .folder-group`)})?.textContent.includes('Folder room')`)
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${projectA} .legacy-chats`)}).textContent.includes('Ordinary chat')`), true)
    const alignment = await evaluate<Array<{ icon: number; label: number; left: number; right: number }>>(`(() => {
      const project = document.querySelector(${JSON.stringify(projectA)});
      return ['.folder-conversations', '.legacy-chats', '.bot-conversations'].map(selector => {
        const row = project.querySelector(selector + ' .folder-session-row');
        const bounds = row.getBoundingClientRect();
        return { icon: row.querySelector('.tree-icon').getBoundingClientRect().left,
          label: row.querySelector('.tree-label').getBoundingClientRect().left,
          left: bounds.left, right: bounds.right };
      });
    })()`)
    for (const row of alignment.slice(1)) {
      for (const column of ['icon', 'label', 'left', 'right'] as const) {
        assert.ok(Math.abs(row[column] - alignment[0][column]) <= 1,
          `Folder, Chats and bot conversation ${column} align at ${width}px: ${JSON.stringify(alignment)}`)
      }
    }
    await click(`${projectA} [aria-label="Folder room (read-only)"]`)
    await waitFor(`decodeURIComponent(location.pathname).endsWith(${JSON.stringify(folderChat)})`)
    if (width < 700) await click('.projects-toggle')
    await assertChatSelection('Folder room')
    await click(`${projectA} .folder-folder`)
    await assertChatSelection('Folder room')
    await click(`${projectA} [aria-label="New conversation in Code"]`)
    await waitFor(`!!document.querySelector('.draft-heading')`)
    if (width < 700) await click('.projects-toggle')
    assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(`${projectA} .folder-folder-row.selected`)}) && !document.querySelector('.folder-session-row.selected')`), true, 'A folder draft still highlights its own folder when no chat is selected')
    await click(`${support} [aria-label="Support room (read-only)"]`)
    await waitFor(`decodeURIComponent(location.pathname).endsWith(${JSON.stringify(supportGroup)})`)
    if (width < 700) await click('.projects-toggle')
    await assertChatSelection('Support room')
    await click(`${support} [aria-label="Support DM (read-only)"]`)
    await waitFor(`decodeURIComponent(location.pathname).endsWith(${JSON.stringify(supportDm)})`)
    if (width < 700) await click('.projects-toggle')
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${support} .session-select[aria-current="page"]`)})?.textContent.includes('Support DM')`), true)
    await assertChatSelection('Support DM')
    const location = await evaluate('location.href')
    await key(`${support} .bot-toggle`)
    await waitFor(`document.querySelector(${JSON.stringify(`${support} .bot-toggle`)}).getAttribute('aria-expanded') === 'false'`)
    assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(`${support} .session-select`)})`), false)
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${support} .bot-toggle`)}).closest('.tree-item').classList.contains('selected')`), false, 'Collapsed bot headers do not inherit chat selection')
    assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(`${support} .tree-meta .session-activity`)}) || !!document.querySelector(${JSON.stringify(`${support} .tree-meta .activity-symbol`)})`), true)
    supportStage = 'llm'
    publisher.invalidateSessions(supportGroup)
    await waitFor(`!!document.querySelector(${JSON.stringify(`${support} .tree-meta .session-activity.llm`)})`)
    assert.equal(await evaluate('location.href'), location, 'Collapsing a bot does not change the selected conversation')
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${other} .bot-toggle`)}).getAttribute('aria-expanded')`), 'true')
    await window.loadURL(`${origin}/projects/a/chat/${encodeURIComponent(supportDm)}`)
    window.webContents.debugger.detach()
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor(`document.querySelector(${JSON.stringify(`${support} .bot-toggle`)})?.getAttribute('aria-expanded') === 'false'`)
    if (width < 700) await click('.projects-toggle')
    await key(`${support} .bot-toggle`, true)
    await waitFor(`document.querySelector(${JSON.stringify(`${support} .bot-toggle`)}).getAttribute('aria-expanded') === 'true'`)
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${support} .session-select[aria-current="page"]`)})?.textContent.includes('Support DM')`), true)
    const geometry = await evaluate<{ width: number; overflow: number; buttons: number }>(`(() => {
      const section = document.querySelector(${JSON.stringify(projectA)});
      return { width: section.getBoundingClientRect().width, overflow: section.scrollWidth - section.clientWidth,
        buttons: Array.from(section.querySelectorAll('.bot-toggle')).filter(button => {
          const r = button.getBoundingClientRect(); return r.width > 32 && r.height >= 32 && r.left >= 0 && r.right <= innerWidth;
        }).length };
    })()`)
    assert.ok(geometry.overflow <= 1 && geometry.buttons === 2, `Bot controls fit ${width}px: ${JSON.stringify(geometry)}`)
    await writeFile(join(directory, `bot-sidebar-${width}.png`), (await window.webContents.capturePage()).toPNG())
    console.log(`LAYOUT_BOTS ${JSON.stringify({ viewportWidth: width, ...geometry, selectionRetained: true, keyboard: true, persisted: true })}`)
    if (selectionOnly) continue
    const before = deletions.length
    await click(`${personal} [aria-label="Delete conversation Personal room"]`)
    await waitFor(`document.querySelector('dialog.session-delete-dialog')?.matches(':modal')`)
    await assertDeleteDialog(width, false)
    assert.equal(deletions.length, before, 'Opening confirmation never submits deletion')
    await writeFile(join(directory, `bot-delete-${width}.png`), (await window.webContents.capturePage()).toPNG())
    rejectDeletion = true
    await click('dialog.session-delete-dialog button[type="submit"]')
    await waitFor(`document.querySelector('dialog.session-delete-dialog [role="alert"]')?.textContent.includes(${JSON.stringify(deletionFailure)})`)
    await assertDeleteDialog(width, true)
    assert.equal(deletions.length, before + 1)
    assert.ok(sessions.some(row => row.sessionId === personalGroup), 'Failed synthetic deletion retains the conversation')
    await writeFile(join(directory, `bot-delete-error-${width}.png`), (await window.webContents.capturePage()).toPNG())
    await click('dialog.session-delete-dialog button[type="button"]')
    await waitFor(`!document.querySelector('dialog.session-delete-dialog')`)
  }
  if (selectionOnly) {
    assert.deepEqual([...errors, ...live.errors], [])
    console.log('LAYOUT_RESULT ' + JSON.stringify({ ok: true, fixture: 'sidebar-selection', desktop: true, mobile: true }))
    return
  }
  await click(`${personal} [aria-label="Delete conversation Personal room"]`)
  await waitFor(`document.querySelector('dialog.session-delete-dialog')?.matches(':modal')`)
  await click('dialog.session-delete-dialog button[type="submit"]')
  await waitFor(`!document.querySelector('dialog.session-delete-dialog') && !document.querySelector(${JSON.stringify(`${personal} [aria-label="Delete conversation Personal room"]`)})`)
  assert.deepEqual(deletions, Array.from({ length: 3 }, () => ({ projectId: 'a', sessionId: personalGroup })))
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(other)}).textContent.includes('Other Project DM')`), true)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`${support} .session-select[aria-current="page"]`)})?.textContent.includes('Support DM')`), true)
  assert.deepEqual([...errors, ...live.errors], [])
  console.log('LAYOUT_RESULT ' + JSON.stringify({ ok: true, fixture: 'bot-sidebar', desktop: true, mobile: true, projectIsolation: true, deletion: true, sharedHistoryDisclosure: true, longIdentity: true, backendError: true }))
}
void (async () => {
  let code = 0
  try { await main() } catch (error) { console.error(error); code = 1 }
  if (window && !window.isDestroyed()) window.destroy()
  live.close()
  server.closeAllConnections()
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  app.exit(code)
})()
