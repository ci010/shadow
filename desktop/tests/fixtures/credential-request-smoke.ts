import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { Hono } from 'hono'
import { uiPlugin } from '../../../src/gateway/ui.ts'
import { LiveFixture } from './live-fixture.ts'
import type { PublicationRequest } from '../../../src/agent-authoring/publication-contract.ts'

function argument(name: string): string {
  const value = process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  assert.ok(value)
  return resolve(value)
}
const directory = argument('layout-root')
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
const sessionId = 'web:orchestrator'
const errors: string[] = []
const writes: Array<{ method: string; body: unknown }> = []
let reads = 0
let rejectNext = false
let pending: ReturnType<typeof createRequest> | null = null
let publication: PublicationRequest | null = null
let rejectPublication = false
const decisions: Array<{ method: string; revision: string; baseRevision: string }> = []
function createPublication(): PublicationRequest {
  return {
    id: randomUUID(), projectId: 'default', sessionId: 'web:orchestrator',
    revision: `sha256:${'a'.repeat(64)}`, baseRevision: `sha256:${'b'.repeat(64)}`, createdAt: new Date().toISOString(),
    files: [{ path: 'agents/support/AGENT.md', before: 'Read documentation.', after: 'Collect issues.\n<img src=x onerror="window.approvalHtmlExecuted=true">' }],
    previousBindings: [], bindings: [{
      botInstanceId: 'support-bot', platform: 'qq', conversationId: 'group:synthetic-room',
      enabled: true, agent: 'support', skills: [], readFolders: ['documentation'], parameters: {},
      grants: [{ id: 'issue-read', kind: 'http', origin: 'https://example.com', routes: [{ method: 'GET', path: '/issues' }] }],
    }],
  }
}
function createRequest() {
  return {
    id: randomUUID(), projectId: 'default', sessionId, secretRef: `github-${'issues-'.repeat(7)}token`,
    purpose: 'Collect feature requests and deduplicate bug reports in the reviewed repository. Use only the issue permissions approved for this Project.',
    createdAt: new Date().toISOString(), replacesExisting: true,
  }
}
const server = createServer(async (request, response) => {
  try {
    if (live.handle(request, response)) return
    const url = new URL(request.url!, 'http://127.0.0.1')
    const path = decodeURIComponent(url.pathname).replace(/^\/projects\/default(?=\/)/, '')
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(value))
    }
    if (path === '/api/projects') return json({ projects: [{ id: 'default', name: 'Credential fixture', createdAt: '2026-09-17' }] })
    if (path === '/api/automations') return json({ automations: [] })
    if (path === '/api/provider/setup') return json({ ready: true, provider: 'custom', model: 'synthetic', authMode: 'none', hasApiKey: false })
    if (path === '/api/provider/configured') return json({ providers: [] })
    if (path === '/debug/models') return json({ models: ['synthetic'] })
    if (path === '/api/config') return json({ agent: { model: 'synthetic', temperature: .7, workspace: directory } })
    if (path === '/api/folders') return json({ folders: [] })
    if (path === '/api/sessions/graph') return json({
      sessions: [{ sessionId, sessionKind: 'orchestrator', title: 'Project coordination', current: 'physical-coordinator' }],
      nodes: [{ logicalId: sessionId, physicalId: 'physical-coordinator', isCurrent: true }],
    })
    if (path === '/api/sessions/stages') return json({ stages: { [sessionId]: pending ? 'tool' : 'idle' } })
    if (path === '/api/chat/session') return json({ history: [{ role: 'user', content: 'Configure issue collection.' }, ...live.history(sessionId)], tools: [], systemPrompt: '' })
    if (path === '/api/agent-resources/credential-requests') { reads++; return json({ request: pending }) }
    if (path === '/api/agent-resources/publication-requests') return json({ request: publication })
    if (path.startsWith('/api/agent-resources/publication-requests/')) {
      assert.equal(path.split('/').at(-1), publication?.id)
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      assert.deepEqual(input, { revision: publication!.revision, baseRevision: publication!.baseRevision })
      decisions.push({ method: request.method!, ...input })
      if (rejectPublication) {
        rejectPublication = false
        return json({ error: 'stale_proposal' }, 409)
      }
      const result = { requestId: publication!.id, revision: publication!.revision, status: request.method === 'POST' ? 'published' : 'cancelled' }
      publication = null
      return json({ result })
    }
    if (path.startsWith('/api/agent-resources/credential-requests/')) {
      assert.equal(path.split('/').at(-1), pending?.id)
      let body = ''
      for await (const chunk of request) body += chunk
      writes.push({ method: request.method!, body: body ? JSON.parse(body) : undefined })
      if (rejectNext) {
        rejectNext = false
        return json({ error: 'Do not display SYNTHETIC-PRIVATE-VALUE' }, 500)
      }
      const result = { requestId: pending!.id, secretRef: pending!.secretRef, status: request.method === 'POST' ? 'saved' : 'cancelled' }
      pending = null
      publication = null
      return json({ result })
    }
    const route = path.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/)
    if (route) {
      if (route[2] === 'background-tasks') return json({ sessionId, total: 0, tasks: [] })
      if (route[2] === 'details') return json({
        sessionId, name: 'Project coordination', sessionKind: 'orchestrator',
        workdir: { kind: 'local', displayPath: directory }, usage: null, usageScope: 'session', context: { usedTokens: null, windowTokens: null },
      })
      if (route[2] === 'files') return json({ path: '', entries: [], workdir: { kind: 'local', displayPath: directory } })
      if (route[2] === 'git/status') return json({ available: false, entries: [], reason: 'not_repository' })
      if (!route[2]) return json({ messages: [{ role: 'user', content: 'Configure issue collection.' }], currentPhysicalId: 'physical-coordinator', previousPhysicalId: null })
    }
    if (/^\/(?:api|local|debug|nodes)\//.test(path)) {
      errors.push(`Unexpected ${request.method} ${path}`)
      return json({ error: 'Unstubbed endpoint' }, 404)
    }
    const resource = await ui.request(url.toString())
    const type = resource.headers.get('Content-Type') || 'application/octet-stream'
    response.writeHead(resource.status, { 'Content-Type': type })
    response.end(Buffer.from(await resource.arrayBuffer()))
  } catch (error) {
    errors.push(String(error))
    if (!response.headersSent) response.writeHead(500)
    response.end()
  }
})

async function runViewport(origin: string, width: number, height: number) {
  pending = null
  const isolated = session.fromPartition(`private-entry-${width}`, { cache: false })
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${origin}/`) }))
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const window = new BrowserWindow({
    show: false, frame: false, width, height, useContentSize: true,
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const evaluate = <T = unknown>(source: string): Promise<T> => {
    assert.equal(window.isVisible(), false)
    return window.webContents.executeJavaScript(source)
  }
  async function waitFor(expression: string) {
    const deadline = Date.now() + 10000
    while (!await evaluate(expression)) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${expression}; ${JSON.stringify(errors)}`)
      await new Promise(resolve => setTimeout(resolve, 30))
    }
  }
  const type = () => evaluate(`(() => {
    const input = document.querySelector('.credential-request input');
    input.focus(); input.value = 'SYNTHETIC-PRIVATE-VALUE'; input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  try {
    await window.loadURL(`${origin}/chat/${encodeURIComponent(sessionId)}`)
    await waitFor(`!!document.querySelector('.composer-input textarea')`)
    const idleReads = reads
    await new Promise(resolve => setTimeout(resolve, 1600))
    assert.equal(reads, idleReads)
    await evaluate(`(() => { const input = document.querySelector('.composer-input textarea'); input.value = 'Preserve my draft'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    pending = createRequest()
    live.publisher.invalidateSessions(sessionId)
    await waitFor(`!!document.querySelector('.credential-request input')`)
    assert.equal(await evaluate(`document.querySelector('.credential-save').disabled`), true)
    await type()
    assert.equal(await evaluate(`document.querySelector('.credential-request input').type`), 'password')
    assert.equal(await evaluate(`document.querySelector('.credential-request input').labels.length`), 1)
    assert.equal(await evaluate(`document.activeElement === document.querySelector('.credential-request input')`), true)
    await evaluate(`document.querySelector('.credential-save').scrollIntoView({ block: 'nearest' })`)
    const geometry = await evaluate<{ bounded: boolean; overflow: boolean; reachable: boolean }>(`(() => {
      const card = document.querySelector('.credential-request'), rect = card.getBoundingClientRect();
      const button = card.querySelector('.credential-save'), bounds = button.getBoundingClientRect();
      return { bounded: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
        overflow: document.documentElement.scrollWidth > innerWidth || card.scrollWidth > card.clientWidth,
        reachable: document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) === button };
    })()`)
    assert.deepEqual(geometry, { bounded: true, overflow: false, reachable: true })
    await writeFile(join(directory, `credential-request-${width}.png`), (await window.webContents.capturePage()).toPNG())
    const beforeWrites = writes.length
    rejectNext = true
    await evaluate(`document.querySelector('.credential-save').click()`)
    await waitFor(`document.querySelector('.credential-error')?.textContent.includes('Could not confirm')`)
    assert.equal(await evaluate(`document.querySelector('.credential-request input').value`), '')
    assert.equal(await evaluate(`document.body.innerText.includes('SYNTHETIC-PRIVATE-VALUE')`), false)
    await type()
    await evaluate(`document.querySelector('.credential-save').click()`)
    await waitFor(`!document.querySelector('.credential-request')`)
    assert.equal(writes.length, beforeWrites + 2)
    assert.deepEqual(writes.at(-1), { method: 'POST', body: { value: 'SYNTHETIC-PRIVATE-VALUE' } })
    assert.equal(await evaluate(`document.querySelector('.composer-input textarea').value`), 'Preserve my draft')
    pending = createRequest()
    live.publisher.invalidateSessions(sessionId)
    await waitFor(`!!document.querySelector('.credential-request input')`)
    await type()
    await evaluate(`document.querySelector('.credential-actions button[type="button"]').click()`)
    await waitFor(`!document.querySelector('.credential-request')`)
    assert.deepEqual(writes.at(-1), { method: 'DELETE', body: undefined })
    assert.equal(await evaluate(`Object.values(localStorage).some(value => value.includes('SYNTHETIC-PRIVATE-VALUE'))`), false)
    assert.doesNotMatch(JSON.stringify([...live.histories.values()]), /SYNTHETIC-PRIVATE-VALUE/)
    publication = createPublication()
    live.publisher.invalidateSessions(sessionId)
    await waitFor(`!!document.querySelector('.publication-confirm')`)
    const beforeDecisions = decisions.length
    assert.equal(await evaluate(`document.querySelector('.publication-request').textContent.includes('/agent-publish')`), false)
    await evaluate(`document.querySelector('.publication-review details').open = true; document.querySelectorAll('.publication-review details')[1].open = true`)
    assert.equal(await evaluate(`document.querySelector('.publication-review').textContent.includes('https://example.com')`), true)
    assert.equal(await evaluate(`!!document.querySelector('.publication-review img') || window.approvalHtmlExecuted === true`), false, 'Sources render as text, never executable HTML')
    await evaluate(`document.querySelector('.publication-confirm').scrollIntoView({ block: 'nearest' })`)
    const approvalGeometry = await evaluate<{ bounded: boolean; overflow: boolean; reachable: boolean }>(`(() => {
      const card = document.querySelector('.publication-request'), r = card.getBoundingClientRect();
      const button = card.querySelector('.publication-confirm'), b = button.getBoundingClientRect();
      const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return { bounded: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        overflow: card.scrollWidth > card.clientWidth || document.documentElement.scrollWidth > innerWidth,
        reachable: hit === button || button.contains(hit) };
    })()`)
    assert.deepEqual(approvalGeometry, { bounded: true, overflow: false, reachable: true })
    await writeFile(join(directory, `publication-review-${width}.png`), (await window.webContents.capturePage()).toPNG())
    assert.equal(decisions.length, beforeDecisions, 'Review, focus and polling never approve automatically')
    rejectPublication = true
    await evaluate(`document.querySelector('.publication-confirm').click()`)
    await waitFor(`document.querySelector('.publication-error')?.textContent.includes('changed or was already resolved')`)
    assert.equal(await evaluate(`document.querySelector('.publication-confirm').disabled`), true)
    await evaluate(`Array.from(document.querySelectorAll('.publication-request button')).find(button => button.textContent.includes('Reload review')).click()`)
    await waitFor(`document.querySelector('.publication-confirm')?.disabled === false`)
    await evaluate(`document.querySelector('.publication-actions button').click()`)
    await waitFor(`document.querySelector('.publication-notice')?.textContent.includes('cancelled')`)
    assert.equal(decisions.at(-1)?.method, 'DELETE')
    publication = createPublication()
    await waitFor(`!!document.querySelector('.publication-confirm')`)
    await evaluate(`document.querySelector('.publication-confirm').click()`)
    await waitFor(`document.querySelector('.publication-notice')?.textContent.includes('published')`)
    assert.equal(decisions.at(-1)?.method, 'POST')
    assert.equal(await evaluate(`document.querySelector('.composer-input textarea').value`), 'Preserve my draft')
    console.log(`LAYOUT_PUBLICATION ${JSON.stringify({ width, ...approvalGeometry, explicitDecision: true, revisionBound: true, cancellation: true })}`)
    console.log(`LAYOUT_CREDENTIAL ${JSON.stringify({ width, ...geometry, privateSubmission: true, cancellation: true, draftPreserved: true })}`)
  } finally { window.destroy() }
}
async function main() {
  let exitCode = 0
  try {
    await app.whenReady()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    await runViewport(origin, 1440, 1000)
    await runViewport(origin, 390, 844)
    assert.deepEqual(errors, [])
    console.log('LAYOUT_RESULT {"ok":true,"fixture":"credential-request"}')
  } catch (error) { console.error(error); exitCode = 1 }
  finally { live.close(); server.closeAllConnections(); server.close(); app.exit(exitCode) }
}
void main()
