import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import test from 'node:test'
import { withTempWorkspace } from '../testing/workspace.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { AgentResourceStore } from './store.ts'
import { AgentAuthoringService } from './service.ts'
import { CapabilityBroker } from './capabilities.ts'
import { AgentCredentialStore } from './credentials.ts'
import { CredentialRequests } from './credential-requests.ts'
import { authoringManagementTool } from './management.ts'
import { PublicationRequests } from './publication-requests.ts'

test('project_config tests latest draft/candidate code with approved GET access without staging or publishing it', async () => {
  await withTempWorkspace(async workspace => {
    const directory = join(workspace, 'resources')
    const store = new AgentResourceStore({ projectId: 'a', directory })
    const credentials = new AgentCredentialStore(directory)
    const credentialRequests = new CredentialRequests({ projectId: 'a', credentials })
    const requests: Array<{ url: string; method?: string }> = []
    let status = 200
    let onRequest: (() => Promise<void>) | undefined
    const broker = new CapabilityBroker({
      projectId: 'a', directory: join(workspace, 'receipts'),
      resolveSecret: async () => undefined,
      deliver: async () => { throw new Error('Probe must never deliver a session or QQ message.') },
      canDeliver: () => false,
      request: async (url, init) => {
        requests.push({ url: String(url), method: init?.method })
        assert.equal(new Headers(init?.headers).get('user-agent'), 'Shadow')
        await onRequest?.()
        return Response.json(status === 200 ? [{ number: 42 }] : {
          message: 'API rate limit exceeded', privateField: 'PRIVATE-RESPONSE-FIELD',
        }, { status, headers: { 'x-github-request-id': 'request-123', 'x-ratelimit-remaining': '0', 'set-cookie': 'PRIVATE-COOKIE' } })
      },
    })
    const service = new AgentAuthoringService({
      projectId: 'a', workspace, store, broker,
      folders: { get: () => undefined, acquireAccess: () => () => {}, requireAvailable: async () => { throw new Error('No folder access in probe') } },
    })
    const publication = { service, retire: async () => {}, validateLive: async () => {} }
    const publicationRequests = new PublicationRequests(publication)
    const management = authoringManagementTool({
      credentials, credentialRequests, inventory: () => ({}),
      ...publication, publicationRequests,
    })
    const owner: ExecutionContext = {
      projectId: 'a', sessionId: 'web:orchestrator', physicalSessionId: 'test-owner',
      channel: 'web', chatId: 'orchestrator', senderId: 'owner', inputSource: 'user', admin: true,
      messageId: randomUUID(), signal: new AbortController().signal, tools: new SessionTools(new Tools(workspace), workspace),
    }
    const identity = { botInstanceId: 'bot', platform: 'qq' as const, conversationId: 'group:room' }
    const draft = await store.stage({
      expectedRevision: store.draft().revision,
      bundle: {
        version: 1,
        files: {
          'agents/support/AGENT.md': '---\ndescription: Support\nallowedTools: [issue_list]\nallowedModules: ["@shadow/issues"]\n---\nCollect issues.',
          'skills/issues/SKILL.md': '---\nname: issues\ndescription: Issues\ntools:\n  issue_list:\n    source: issues.js\n    description: List issues\n    parameters:\n      type: object\n      properties:\n        method:\n          type: string\n      required: [method]\n      additionalProperties: false\n    imports: ["@shadow/issues"]\n---\nRead issues.',
          'skills/issues/issues.js': 'import request from "@shadow/issues"; export async function run(args) { const response = await request({method:args.method,path:"/issues"}); return {version:"published",count:response.body.length}; }',
        },
        bindings: [{
          ...identity, enabled: true, agent: 'support', skills: ['issues'], readFolders: [], parameters: {},
          grants: [{ id: 'issues', kind: 'http', origin: 'https://api.example.com', routes: [{ method: 'GET', path: '/issues' }, { method: 'POST', path: '/issues' }] }],
        }],
      },
    })
    const args = { action: 'probe', ...identity, expectedRevision: draft.revision, toolName: 'issue_list', testArguments: { method: 'GET' } }
    try {
      await assert.rejects(management.execute(args, owner), /No approved service binding/)
      assert.equal(requests.length, 0)
      const published = await store.publish(draft.revision)
      args.expectedRevision = published.revision
      const result = JSON.parse(await management.execute(args, owner))
      assert.equal(result.synthetic, false)
      assert.equal(result.target, 'draft')
      assert.equal(result.httpVerified, true)
      assert.deepEqual(result.result, { version: 'published', count: 1 })
      assert.deepEqual(requests, [{ url: 'https://api.example.com/issues', method: 'GET' }])

      const next = structuredClone(draft.bundle)
      next.files['skills/issues/issues.js'] = next.files['skills/issues/issues.js'].replace('version:"published"', 'version:"draft"')
      const staged = await store.stage({ bundle: next, expectedRevision: draft.revision })
      await assert.rejects(management.execute(args, owner), /Stale draft revision/)
      await assert.rejects(management.execute({ ...args, action: 'test' }, owner), /Stale draft revision/)
      args.expectedRevision = staged.revision
      const latest = JSON.parse(await management.execute(args, owner))
      assert.deepEqual(latest.result, { version: 'draft', count: 1 })
      assert.equal(latest.revision, staged.revision)
      assert.equal(latest.authorizationRevision, published.revision)
      assert.equal(store.snapshot().revision, published.revision)
      const deployed = JSON.parse(await management.execute({ ...args, target: 'published', expectedRevision: published.revision }, owner))
      assert.deepEqual(deployed.result, { version: 'published', count: 1 })
      assert.notEqual(deployed.sourceHash, latest.sourceHash)

      const candidate = structuredClone(next)
      candidate.files['skills/issues/issues.js'] = next.files['skills/issues/issues.js'].replace('version:"draft"', 'version:"candidate"')
      const candidateArgs = { ...args, expectedRevision: undefined, bundle: candidate }
      const tested = JSON.parse(await management.execute(candidateArgs, owner))
      assert.equal(tested.target, 'candidate')
      assert.deepEqual(tested.result, { version: 'candidate', count: 1 })
      assert.equal(tested.sourceHash, `sha256:${createHash('sha256').update(candidate.files['skills/issues/issues.js']).digest('hex')}`)
      assert.equal(tested.authorizationRevision, published.revision)
      assert.equal(store.draft().revision, staged.revision)
      assert.equal(store.snapshot().revision, published.revision)
      assert.equal(publicationRequests.pending(), null)
      for (const inputSource of ['session', 'event'] as const) {
        const peer = { ...owner, inputSource, admin: false }
        const synthetic = JSON.parse(await management.execute({
          ...candidateArgs, action: 'test', assertion: { expected: { version: 'candidate', count: 1 } },
          capabilityResults: { issues: { status: 200, body: [{}] } },
        }, peer))
        assert.equal(synthetic.evaluation.passed, true)
        assert.equal(synthetic.sourceHash, tested.sourceHash)
        assert.equal(JSON.parse(await management.execute({ ...candidateArgs, action: 'preview' }, peer)).revision, tested.revision)
      }
      const sequenceCandidate = structuredClone(candidate)
      sequenceCandidate.files['skills/issues/issues.js'] = `
        import request from "@shadow/issues";
        export async function run() {
          const results = [];
          for (let i = 0; i < 3; i++) {
            try { results.push({status:(await request({method:"GET",path:"/issues"})).status}); }
            catch (error) { results.push({code:error.code,...(error.status === undefined ? {} : {status:error.status})}); }
          }
          return results;
        }
      `
      const beforeMock = requests.length
      const sequenced = JSON.parse(await management.execute({
        ...candidateArgs, bundle: sequenceCandidate, action: 'test',
        assertion: { expected: [{ status: 200 }, { code: 'http_status', status: 401 }, { code: 'network_error' }] },
        capabilityResults: { issues: { sequence: [{ status: 200, body: [] }, { status: 401, body: {} }, { throws: { code: 'network_error' } }] } },
      }, { ...owner, inputSource: 'session', admin: false }))
      assert.equal(sequenced.evaluation.passed, true)
      assert.equal(requests.length, beforeMock)
      assert.equal(store.draft().revision, staged.revision)
      assert.equal(store.snapshot().revision, published.revision)
      assert.equal(publicationRequests.pending(), null)
      const beforeDenied = requests.length
      const post = JSON.parse(await management.execute({ ...args, testArguments: { method: 'POST' } }, owner))
      assert.equal(post.error.code, 'route_denied')
      assert.equal(post.calls[0].requestAttempted, false)
      await assert.rejects(management.execute(args, { ...owner, inputSource: 'session' }), /direct owner/)
      const altered = structuredClone(candidate)
      const grant = altered.bindings[0].grants[0]
      assert.equal(grant.kind, 'http')
      if (grant.kind === 'http') grant.origin = 'https://unapproved.example.com'
      const blocked = JSON.parse(await management.execute({ ...candidateArgs, bundle: altered }, owner))
      assert.equal(blocked.error.code, 'grant_not_approved')
      assert.equal(requests.length, beforeDenied)
      await assert.rejects(management.execute({ ...candidateArgs, target: 'published' }, owner), /Do not mix bundle/)
      status = 403
      const rejected = JSON.parse(await management.execute(args, owner))
      assert.equal(rejected.execution, 'failed')
      assert.deepEqual(rejected.error, { code: 'http_status', httpStatus: 403 })
      assert.equal(rejected.calls[0].responseReceived, true)
      assert.equal(rejected.calls[0].phase, 'response')
      assert.equal(rejected.httpVerified, false)
      assert.deepEqual(rejected.calls[0].diagnostics, {
        source: 'untrusted-http-response', message: 'API rate limit exceeded',
        headers: { 'x-github-request-id': 'request-123', 'x-ratelimit-remaining': '0' }, truncated: false,
      })
      assert.doesNotMatch(JSON.stringify(rejected), /PRIVATE-/)
      status = 200
      onRequest = async () => {
        const changed = structuredClone(next)
        changed.files['agents/support/AGENT.md'] += '\nChanged during test.'
        await store.stage({ expectedRevision: store.draft().revision, bundle: changed })
      }
      await assert.rejects(management.execute(args, owner), /Draft changed during probe/)
      assert.equal(store.snapshot().revision, published.revision)
    } finally { credentialRequests.stop(); publicationRequests.stop() }
  })
})
