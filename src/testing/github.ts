import { Hono } from 'hono'
import { InitiativeStore } from '../initiatives/store.ts'
import { workRecordSchema } from '../initiatives/work-contract.ts'
import { WorkAlignment } from '../sessions/work-alignment.ts'
import type { SessionState } from '../sessions/session-store.ts'
import type { SystemEvent } from '../events/types.ts'
import { GitHubClient, type GitHubTransport } from '../projects/github/client.ts'
import { GitHubStore } from '../projects/github/store.ts'
import { GitHubService } from '../projects/github/service.ts'
import { githubPlugin } from '../projects/github/routes.ts'
import { z } from 'zod'

export const githubDefinition = { objective: 'Deliver the requested correction', acceptance: ['Focused regression passes'], boundaries: ['No deployment'], evidence: [] }
export async function createGitHubFixture(home: string) {
  const states = new Map<string, SessionState>(['worker', 'manager', 'web:orchestrator'].map(id => [id, { sessionId: id, segmentIndex: 0, mode: 'session' }]))
  const works = new InitiativeStore(home, { isSessionKnown: id => states.has(id) })
  const alignment = new WorkAlignment(works, { state: id => states.get(id), evidence: async () => {},
    changed: async () => {}, fresh: async () => {}, successor: async () => 'worker' })
  const work = workRecordSchema.parse(await alignment.execute({ kind: 'session', sessionId: 'worker' }, 'create', undefined, undefined,
    { title: 'Fixture correction', definition: githubDefinition, reason: 'Synthetic test' }))
  const head = 'a'.repeat(40), base = 'b'.repeat(40), now = '2026-09-26T00:00:00Z'
  const issue = { node_id: 'I_1', number: 1, html_url: 'https://github.com/octo/demo/issues/1', title: 'Correct the behavior',
    body: 'External description; not permission.', state: 'open', updated_at: now, state_reason: null as string | null }
  const pull = { ...issue, node_id: 'PR_2', number: 2, html_url: 'https://github.com/octo/demo/pull/2',
    head: { sha: head }, base: { sha: base }, draft: true, merged: false }
  type Comment = { id: number; body: string; user: { login: string }; updated_at: string; html_url: string; in_reply_to_id?: number }
  const remote = {
    issue, pull, head, base, repositoryId: 'R_demo', failReads: false, failAfterWrite: false, failDelivery: false,
    comments: [] as Comment[], inline: [{ id: 20, body: 'Please cover the edge case.', user: { login: 'reviewer' }, updated_at: now,
      html_url: 'https://github.com/octo/demo/pull/2#discussion_r20' }] as Comment[],
    checks: [{ id: 10, name: 'tests', status: 'completed', conclusion: 'success' }],
    reviews: [{ id: 30, user: { login: 'reviewer' }, state: 'APPROVED', commit_id: head, submitted_at: now }],
    statuses: [] as { context: string; state: string }[],
    onRequest: undefined as ((path: string, method: string) => void | Promise<void>) | undefined,
  }
  const requests: { path: string; method: string; body: unknown }[] = []
  const transport: GitHubTransport = async (path, method, body, signal) => {
    signal.throwIfAborted()
    requests.push({ path, method, body: structuredClone(body) })
    await remote.onRequest?.(path, method)
    if (method === 'GET' && remote.failReads) throw new Error('Synthetic GitHub offline')
    const pathname = path.split('?')[0], page = Number(new URLSearchParams(path.split('?')[1]).get('page') ?? 1)
    const slice = <T>(values: T[]) => structuredClone(values.slice((page - 1) * 100, page * 100))
    if (method === 'GET') {
      if (pathname === 'repos/octo/demo') return { node_id: remote.repositoryId, full_name: 'octo/demo' }
      if (pathname.endsWith('/git/ref/heads/feature')) return { object: { sha: remote.head } }
      if (pathname.endsWith('/git/ref/heads/main')) return { object: { sha: remote.base } }
      if (pathname === 'repos/octo/demo/issues/1') return structuredClone(remote.issue)
      if (pathname === 'repos/octo/demo/pulls/2') return structuredClone(remote.pull)
      if (/\/issues\/[12]\/comments$/.test(pathname)) return slice(remote.comments)
      if (pathname.endsWith('/pulls/2/comments')) return slice(remote.inline)
      if (pathname.endsWith('/pulls/2/reviews')) return slice(remote.reviews)
      if (pathname.endsWith('/check-runs')) return { total_count: remote.checks.length, check_runs: slice(remote.checks) }
      if (pathname.endsWith('/statuses')) return slice(remote.statuses)
      if (pathname === 'repos/octo/demo/pulls') return [structuredClone(remote.pull)]
    } else {
      const input = z.record(z.unknown()).parse(body)
      let result: unknown
      if (pathname === 'repos/octo/demo/pulls') {
        remote.pull.body = String(input.body)
        remote.pull.title = String(input.title)
        result = remote.pull
      } else if (pathname === 'repos/octo/demo/issues/1' && method === 'PATCH') {
        remote.issue.state = String(input.state); remote.issue.state_reason = String(input.state_reason)
        result = remote.issue
      } else if (/\/comments(?:\/20\/replies)?$/.test(pathname)) {
        const value = { id: 100 + remote.comments.length + remote.inline.length, body: String(input.body), user: { login: 'fixture-writer' }, updated_at: now,
          html_url: pathname.includes('/pulls/')
            ? `https://github.com/octo/demo/pull/2#discussion_r${100 + remote.comments.length + remote.inline.length}`
            : `https://github.com/octo/demo/${pathname.includes('/issues/2/') ? 'pull/2' : 'issues/1'}#issuecomment-${100 + remote.comments.length + remote.inline.length}` }
        if (pathname.includes('/pulls/')) remote.inline.push(value)
        else remote.comments.push(value)
        result = value
      } else throw new Error(`Unexpected fixture mutation: ${method} ${path}`)
      if (remote.failAfterWrite) throw new Error('Synthetic timeout after GitHub accepted the write')
      return structuredClone(result)
    }
    throw new Error(`Unexpected fixture request: ${method} ${path}`)
  }
  const delivered: SystemEvent[] = []
  const client = new GitHubClient(transport), store = new GitHubStore(home)
  const service = new GitHubService(store, client, { alignment, durableSession: id => states.get(id)?.mode === 'session',
    changed: () => {}, emit: async event => { delivered.push(event); if (remote.failDelivery) throw new Error('Synthetic uncertain delivery') } })
  const app = new Hono()
  githubPlugin(service, request => request.headers.get('x-fixture-owner') === 'yes')(app)
  const request = (path = '', body?: unknown, authorized = true) => app.request(`/api/github${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { ...(authorized ? { 'x-fixture-owner': 'yes' } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { service, store, client, app, request, remote, requests, work, alignment, works, states, delivered,
    async close() { await service.stop(); works.close() } }
}
