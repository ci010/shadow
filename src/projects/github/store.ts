import { lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writePrivateFile } from '../../config/store.ts'
import { githubStateSchema, parseGitHubUrl, type GitHubState } from './contracts.ts'

function validate(state: GitHubState) {
  const unique = (values: string[]) => { if (new Set(values).size !== values.length) throw new Error('Duplicate GitHub integration identity.') }
  unique(state.repositories.map(value => value.id))
  unique(state.repositories.map(value => value.name.toLowerCase()))
  unique(state.resources.map(value => value.id))
  unique(state.resources.map(value => JSON.stringify([value.repositoryId, value.kind, value.number])))
  unique(state.links.map(value => JSON.stringify([value.resourceId, value.workKey])))
  unique(state.operations.map(value => value.id))
  unique(state.subscriptions.map(value => JSON.stringify([value.resourceId, value.workKey])))
  unique(state.notifications.map(value => value.id))
  unique(state.imports.map(value => value.resourceId))
  unique(state.imports.map(value => value.token))
  for (const resource of state.resources) {
    const url = parseGitHubUrl(resource.url)
    if (url.repository.toLowerCase() !== resource.repository.toLowerCase() || url.kind !== resource.kind || url.number !== resource.number) {
      throw new Error('Invalid GitHub resource destination.')
    }
  }
  if (state.resources.some(resource => !state.repositories.some(repo => repo.id === resource.repositoryId))
    || [...state.links, ...state.subscriptions, ...state.imports].some(value => !state.resources.some(resource => resource.id === value.resourceId))
    || state.subscriptions.some(subscription => !state.links.some(link => link.resourceId === subscription.resourceId && link.workKey === subscription.workKey))
    || state.operations.some(operation => {
      const input = operation.input
      return !state.repositories.some(repo => repo.id === operation.repositoryId)
        || (input.kind === 'create_pr' ? input.repositoryId !== operation.repositoryId
          : !state.resources.some(resource => resource.id === input.resourceId && resource.repositoryId === operation.repositoryId))
        || ['succeeded', 'reconciled'].includes(operation.status) && !operation.receipt
    })) {
    throw new Error('Invalid GitHub integration reference.')
  }
}
export class GitHubStore {
  private state: GitHubState
  private readonly path: string
  constructor(home: string, private persist: typeof writePrivateFile = writePrivateFile) {
    mkdirSync(home, { recursive: true })
    this.path = join(home, 'github-integration.json')
    let saved: unknown = { version: 1, repositories: [], resources: [], links: [], operations: [], subscriptions: [], notifications: [], imports: [], errors: {} }
    try {
      const stat = lstatSync(this.path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error('GitHub state must be a regular file under 64 MiB.')
      saved = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    this.state = githubStateSchema.parse(saved)
    validate(this.state)
    this.update(state => {
      for (const operation of state.operations) if (operation.status === 'sending') {
        operation.status = 'unknown'; operation.error = 'Process stopped during a GitHub write. Reconcile before any retry.'
      }
      for (const notification of state.notifications) if (notification.status === 'sending') {
        notification.status = 'unknown'; notification.error = 'Process stopped during delivery. It may already have reached the session.'
      }
    })
  }
  read(): GitHubState { return structuredClone(this.state) }
  update(mutate: (state: GitHubState) => void) {
    const next = this.read()
    mutate(next)
    const parsed = githubStateSchema.parse(next)
    validate(parsed)
    const content = JSON.stringify(parsed)
    if (Buffer.byteLength(content) > 64 * 1024 * 1024) throw new Error('GitHub integration storage limit reached.')
    for (let attempt = 0; ; attempt++) {
      try { this.persist(this.path, content); break }
      catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(String(code)) || attempt === 3) throw error
        if (attempt === 0) console.warn('[github] Project state replacement is temporarily locked; retrying the atomic write.')
        // Windows file scanners can briefly prevent replacement after the handle closes.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1))
      }
    }
    this.state = parsed
  }
}
