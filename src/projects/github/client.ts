import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { GitHubError, githubSnapshotSchema, parseGitHubUrl, repositoryName, type GitHubRepository, type GitHubSnapshot } from './contracts.ts'

export type GitHubTransport = (path: string, method: 'GET' | 'POST' | 'PATCH', body: unknown, signal: AbortSignal) => Promise<unknown>
export const ghTransport: GitHubTransport = (path, method, body, signal) => new Promise((resolve, reject) => {
  // Fixed host and executable; content goes through stdin, never a shell or argv.
  const args = ['api', '--hostname', 'github.com', '--method', method, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', path]
  if (body !== undefined) args.push('--input', '-')
  const child = execFile('gh', args, { signal, timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' } }, (error, stdout, stderr) => {
    if (error) {
      const status = /\(HTTP (\d{3})\)/.exec(stderr)?.[1]
      reject(signal.aborted ? signal.reason : new GitHubError(
        `GitHub request failed${status ? ` (HTTP ${status})` : ''}. Check gh installation, gh auth login, repository access and rate limits; refresh to retry.`, 502))
      return
    }
    try { resolve(stdout.trim() ? JSON.parse(stdout) : null) }
    catch { reject(new GitHubError('GitHub returned invalid JSON.', 502)) }
  })
  child.stdin?.on('error', error => { if (!signal.aborted) reject(new GitHubError(`GitHub request input failed (${error.name}).`, 502)) })
  child.stdin?.end(body === undefined ? undefined : JSON.stringify(body))
})
const user = z.object({ login: z.string() }).nullable()
const repository = z.object({ node_id: z.string().min(1), full_name: repositoryName })
const issue = z.object({
  node_id: z.string().min(1), number: z.number().int().positive(), html_url: z.string().url(),
  title: z.string(), body: z.string().nullable(), state: z.enum(['open', 'closed']), updated_at: z.string(),
  pull_request: z.unknown().optional(),
})
const pull = issue.extend({ head: z.object({ sha: z.string() }), base: z.object({ sha: z.string() }),
  merged: z.boolean(), draft: z.boolean() })
const comment = z.object({ id: z.number().int().positive(), user, body: z.string(), updated_at: z.string(), in_reply_to_id: z.number().int().positive().optional() })
const review = z.object({ id: z.number().int(), user, body: z.string().nullable().optional(), state: z.string(), commit_id: z.string().nullable(), submitted_at: z.string().nullable() })
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class GitHubClient {
  constructor(readonly transport: GitHubTransport = ghTransport) {}
  request(path: string, method: 'GET' | 'POST' | 'PATCH', body: unknown, signal: AbortSignal) {
    return this.transport(path, method, body, AbortSignal.any([signal, AbortSignal.timeout(30000)]))
  }
  async repository(name: string, signal: AbortSignal) {
    return repository.parse(await this.request(`repos/${repositoryName.parse(name)}`, 'GET', undefined, signal))
  }
  async verifyRepository(repo: GitHubRepository, signal: AbortSignal) {
    const current = await this.repository(repo.name, signal)
    if (current.node_id !== repo.id) throw new GitHubError('Repository identity changed. Rebind it before continuing.', 409)
    return current
  }
  async pages(path: string, signal: AbortSignal): Promise<unknown[]> {
    const values: unknown[] = []
    for (let page = 1; page <= 11; page++) {
      const result = z.array(z.unknown()).parse(await this.request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, 'GET', undefined, signal))
      if (page === 11 && result.length) break
      values.push(...result)
      if (result.length < 100) return values
    }
    throw new GitHubError('GitHub result exceeds 1,000 entries. Snapshot is incomplete; no follow-up was triggered.', 502)
  }
  async branch(repo: GitHubRepository, name: string, signal: AbortSignal) {
    const ref = z.object({ object: z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/) }) })
    return ref.parse(await this.request(`repos/${repo.name}/git/ref/heads/${encodeURIComponent(name)}`, 'GET', undefined, signal)).object.sha
  }
  async snapshot(repo: GitHubRepository, kind: 'issue' | 'pr', number: number, signal: AbortSignal): Promise<GitHubSnapshot> {
    await this.verifyRepository(repo, signal)
    const path = `repos/${repo.name}`
    const raw = await this.request(`${path}/${kind === 'pr' ? 'pulls' : 'issues'}/${number}`, 'GET', undefined, signal)
    const item = issue.parse(raw)
    const reference = parseGitHubUrl(item.html_url)
    if (item.number !== number || reference.number !== number || reference.kind !== kind
      || reference.repository.toLowerCase() !== repo.name.toLowerCase()) throw new GitHubError('Unexpected GitHub resource identity.', 502)
    if (kind === 'issue' && item.pull_request !== undefined) throw new GitHubError('This is a pull request. Use its /pull/ URL.')
    const comments: GitHubSnapshot['comments'] = z.array(comment).parse(await this.pages(`${path}/issues/${number}/comments`, signal))
      .map(value => ({ id: value.id, author: value.user?.login ?? 'deleted-user', body: value.body, updatedAt: value.updated_at, inline: false }))
    let pr: Partial<GitHubSnapshot> = {}
    let reviewFacts: unknown[] = []
    let checkFacts: unknown = null
    if (kind === 'pr') {
      const details = pull.parse(raw)
      const reviews = z.array(review).parse(await this.pages(`${path}/pulls/${number}/reviews`, signal))
        .filter(value => value.submitted_at && value.state !== 'PENDING')
      reviewFacts = reviews
      comments.push(...z.array(comment).parse(await this.pages(`${path}/pulls/${number}/comments`, signal))
        .map(value => ({ id: value.id, author: value.user?.login ?? 'deleted-user', body: value.body, updatedAt: value.updated_at,
          inline: true, inReplyTo: value.in_reply_to_id })))
      const checks: Array<{ id: number; name: string; status: string; conclusion: string | null }> = []
      for (let page = 1; ; page++) {
        const batch = z.object({ total_count: z.number().int().nonnegative().max(1000), check_runs: z.array(z.object({
          id: z.number().int(), name: z.string(), status: z.string(), conclusion: z.string().nullable(),
        })) }).parse(await this.request(`${path}/commits/${details.head.sha}/check-runs?per_page=100&page=${page}`, 'GET', undefined, signal))
        checks.push(...batch.check_runs)
        if (new Set(checks.map(check => check.id)).size !== checks.length) throw new GitHubError('Check pages changed while reading. Refresh before acting.', 409)
        if (checks.length >= batch.total_count) break
        if (!batch.check_runs.length || page === 10) throw new GitHubError('Check results are incomplete.', 502)
      }
      const statuses = z.array(z.object({ context: z.string(), state: z.enum(['error', 'failure', 'pending', 'success']) })).parse(
        await this.pages(`${path}/commits/${details.head.sha}/statuses`, signal))
      const latest = [...new Map(statuses.toReversed().map(value => [value.context, value])).values()]
      const failed = checks.some(value => value.status === 'completed' && !['success', 'neutral', 'skipped'].includes(value.conclusion ?? ''))
        || latest.some(value => ['failure', 'error'].includes(value.state))
      const pending = checks.some(value => value.status !== 'completed') || latest.some(value => value.state === 'pending')
      const currentReviews = [...new Map(reviews.filter(value => value.commit_id === details.head.sha && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(value.state))
        .sort((a, b) => a.submitted_at!.localeCompare(b.submitted_at!)).map(value => [value.user?.login ?? value.id, value])).values()]
      checkFacts = { checks, latest }
      pr = { head: details.head.sha, base: details.base.sha, draft: details.draft, state: details.merged ? 'merged' : details.state,
        checkFingerprint: digest(checkFacts),
        reviews: reviews.map(value => ({ id: value.id, author: value.user?.login ?? 'deleted-user', body: value.body ?? '',
          state: value.state, commit: value.commit_id, submittedAt: value.submitted_at! })),
        ci: !checks.length && !latest.length ? 'none' : failed ? 'failure' : pending ? 'pending' : 'success',
        review: currentReviews.some(value => value.state === 'CHANGES_REQUESTED') ? 'changes_requested'
          : currentReviews.some(value => value.state === 'APPROVED') ? 'approved'
          : reviews.some(value => value.commit_id === details.head.sha && value.state === 'COMMENTED') ? 'commented' : 'none' }
      const after = pull.parse(await this.request(`${path}/pulls/${number}`, 'GET', undefined, signal))
      if (digest(after) !== digest(details)) throw new GitHubError('PR changed while reading. Refresh before acting.', 409)
    } else {
      const after = issue.parse(await this.request(`${path}/issues/${number}`, 'GET', undefined, signal))
      if (digest(after) !== digest(item)) throw new GitHubError('Issue changed while reading. Refresh before acting.', 409)
    }
    const sourceHash = digest([item.title, item.body])
    return githubSnapshotSchema.parse({
      id: item.node_id, repositoryId: repo.id, repository: repo.name, number, kind, url: item.html_url,
      title: item.title, body: item.body ?? '', state: item.state, updatedAt: item.updated_at,
      fetchedAt: new Date().toISOString(), sourceHash, comments, ...pr,
      fingerprint: digest([sourceHash, item.state, pr, comments, reviewFacts, checkFacts]),
    })
  }
}
