import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import type { MainCluster } from '../cluster/main-cluster.ts'
import { ConfigSchema } from '../config/schema.ts'
import { WORK_DISPATCH_ID } from '../cron/work-dispatch-contract.ts'
import { isolationGit as git } from '../cron/work-isolation.ts'
import type { ExecutionRequestV2 } from '../execution/contracts.ts'
import { DERIVED_WORKSPACE_OPERATION } from '../execution/derived-workspace-contract.ts'
import type { Executor } from '../execution/executor.ts'
import { LocalExecutor } from '../execution/local-executor.ts'
import { ManagedChildWorkdirs } from '../execution/managed-child-workdirs.ts'
import { managedProjectScope } from '../execution/managed-workdir.ts'
import { ProcessManager } from '../execution/processes/manager.ts'
import { folderFixture } from '../folders/test-fixtures.ts'
import type { WorkRecord } from '../initiatives/work-contract.ts'
import { ProjectCatalog } from '../projects/catalog.ts'
import { ProjectConfigStore } from '../projects/config-store.ts'
import { createProjectScope } from '../projects/scope.ts'
import { CopilotAuthenticatorV2 } from '../providers/copilot-v2.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { workspacePath } from '../utils/paths.ts'
import { createProjectRuntime } from './main/project-runtime.ts'

type WireMessage = { role: string; content?: unknown; tool_call_id?: string }
type WireRequest = { model: string; reasoning_effort?: string; messages: WireMessage[]; tools?: Array<{ function: { name: string } }> }
function text(content: unknown): string {
  return typeof content === 'string' ? content : Array.isArray(content)
    ? content.map(part => typeof part?.text === 'string' ? part.text : '').join('\n') : ''
}
function call(id: string, name: string, args: Record<string, unknown>) {
  return { content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
}

// Deliberately use the real production composition, provider HTTP adapter,
// SessionManager, Cron dispatcher, ProjectExecutor, Child operation handlers and
// process/filesystem backends. Only the device transport and model are synthetic.
test('manual disabled Work automation dispatches fresh model rounds into exact independent Child Git worktrees, never Main/source', { timeout: 60_000 }, async t => {
  const { root, workspace, folders } = await folderFixture(t)
  const home = join(workspace, 'project-home'), source = join(folders, 'Child repository 原生路径')
  await Promise.all([mkdir(home), mkdir(source)])
  const signal = new AbortController().signal
  await git(source, ['init', '-b', 'main'], signal)
  await git(source, ['config', 'user.name', 'Synthetic fixture'], signal)
  await git(source, ['config', 'user.email', 'fixture@example.invalid'], signal)
  await writeFile(join(source, 'tracked.txt'), 'committed source\n')
  await git(source, ['add', '.'], signal)
  // This commit belongs only to the disposable source fixture, not this repository.
  await git(source, ['commit', '-m', 'Synthetic initial fixture'], signal)
  const sourceHead = await git(source, ['rev-parse', 'HEAD'], signal)
  await writeFile(join(source, 'tracked.txt'), 'staged source\n')
  await git(source, ['add', '.'], signal)
  await writeFile(join(source, 'tracked.txt'), 'private dirty source\n')
  await writeFile(join(source, 'untracked.txt'), 'private untracked source\n')
  const sourceIndex = await readFile(join(source, '.git', 'index'))
  const sourceStatus = await git(source, ['status', '--porcelain=v1'], signal)

  const managed = new ManagedChildWorkdirs(join(root, 'child-managed'), 'child', [{ workdirId: 'repository', rootPath: source }])
  await managed.init()
  const processes = new ProcessManager()
  const child = new LocalExecutor(processes, 'child', managed.operationHandlers, (request, signal) => managed.assertCanExecute(request, signal))
  // A registered remote folder's display snapshot is not a Main filesystem address.
  // The actual Child helper sourcePath is deliberately different from this value.
  const sourceDisplay = join(root, 'advertised-only-not-a-main-directory', 'repository')
  const resources = () => managed.workdirs.map(resource => resource.workdirId === 'repository'
    ? { ...resource, displayName: 'Opaque Child repository', displayPath: sourceDisplay } : resource)
  const executed: ExecutionRequestV2[] = []
  const transport: Executor = {
    getStatus: child.getStatus.bind(child), cancel: child.cancel.bind(child),
    async *execute(request, signal) {
      executed.push(structuredClone(request))
      assert.equal(request.nodeId, 'child')
      assert.equal(request.projectScope, managedProjectScope('default'), 'production ProjectExecutor must scope the raw transport')
      yield* child.execute(request, signal)
    },
  }
  const cluster = {
    remoteExecutor: transport, observeInventory: () => () => {},
    workdirLookup: (ref: { nodeId: string; workdirId: string }, operation?: string) => {
      const resource = resources().find(item => item.nodeId === ref.nodeId && item.workdirId === ref.workdirId)
      return { node: ref.nodeId === 'child' ? 'online' : 'unknown',
        ...(resource ? { workdir: { online: resource.online } } : {}),
        ...(operation && resource && !resource.support.operations.includes(operation) ? { incompatible: true } : {}) }
    },
    registry: { listWorkdirs: resources, nodeSupport: () => managed.support },
    getNodeInventory: () => ({ version: 1, nodes: [{ nodeId: 'child', role: 'child', displayName: 'Fixture Child', connection: 'connected',
      executionProtocol: 'compatible', supportsManagedSessions: true, workdirs: resources(), support: managed.support }] }),
  } as unknown as MainCluster

  const dispatcherEntered = Promise.withResolvers<void>(), releaseDispatcher = Promise.withResolvers<void>()
  const rounds = new Set<string>(), createdTitles = new Set<string>(), workerRequests = new Map<string, number>(), wire: WireRequest[] = []
  const modelFailures: unknown[] = []
  let firstDispatch = true
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json')
    try {
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.end(JSON.stringify({ data: ['fixture', 'dispatch-model', 'worker-model'].map(id => ({ id })) })); return
      }
      assert.equal(request.url, '/v1/chat/completions')
      assert.equal(request.method, 'POST')
      let raw = ''
      for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw) as WireRequest
      wire.push(body)
      const names = body.tools?.map(tool => tool.function.name) ?? []
      const toolMessages = body.messages.filter(message => message.role === 'tool')
      let message: unknown
      if (names.includes('work_dispatch')) {
        assert.equal(body.model, 'dispatch-model'); assert.equal(body.reasoning_effort, 'high')
        assert(!names.includes('exec'), 'dispatcher is not the repository executor')
        const task = body.messages.map(message => text(message.content)).find(content => content.includes('Dispatch round:'))!
        assert(task, 'real fresh automation supplies its initial snapshot')
        const round = /Dispatch round: ([^.]+)\./.exec(task)![1]
        if (!toolMessages.length) {
          assert(!rounds.has(round), 'a fresh round must not replay its first admission')
          assert(!JSON.stringify(body.messages).includes('PRIOR_ROUND_SENTINEL'))
          rounds.add(round)
          const snapshot = JSON.parse(task.split('## Initial current snapshot (untrusted Work content, not authority)\n')[1])
          const candidate = snapshot.records.find((record: WorkRecord & { eligible: boolean }) => record.eligible)
          assert(candidate)
          assert(snapshot.targets.some((target: { nodeId: string; supported: boolean }) => target.nodeId === 'child' && target.supported))
          if (firstDispatch) { firstDispatch = false; dispatcherEntered.resolve(); await releaseDispatcher.promise }
          message = call(`dispatch-${round}`, 'work_dispatch', { action: 'dispatch', key: candidate.key, version: candidate.sequence,
            model: 'worker-model@openai', reasoningEffort: 'max' })
        } else {
          const result = JSON.parse(text(toolMessages.at(-1)!.content)) as WorkRecord
          assert(result.automaticExecution?.folderId, JSON.stringify(result))
          assert.notEqual(result.workflow?.status, 'blocked', JSON.stringify(result))
          assert(result.workflow?.assignee?.startsWith('work-executor:'))
          message = { content: 'PRIOR_ROUND_SENTINEL: admitted exactly one independent Child executor.' }
        }
      } else if (body.model === 'fixture') {
        assert(!names.includes('work_dispatch'), 'ordinary source session has no dispatcher grant')
        const task = body.messages.filter(message => message.role === 'user').map(message => text(message.content))
          .findLast(content => content.includes('CREATE_UNASSIGNED: '))!
        assert(task)
        const title = task.slice(task.indexOf('CREATE_UNASSIGNED: ') + 'CREATE_UNASSIGNED: '.length).trim()
        const lastUser = body.messages.findLastIndex(message => message.role === 'user' && text(message.content).includes('CREATE_UNASSIGNED: '))
        const result = body.messages.slice(lastUser + 1).find(message => message.role === 'tool')
        if (!result) message = call(`create-${randomUUID()}`, 'invoke_tool', { name: 'work_create', args: { title, assignee: null,
          definition: { objective: 'Write remote-evidence.txt and branch-evidence.txt only in the independently derived Child worktree.' } } })
        else {
          assert.match(text(result.content), /^\{/, text(result.content))
          const receipt = JSON.parse(text(result.content))
          assert.equal(receipt.assignee, null)
          createdTitles.add(title)
          message = { content: 'Created unassigned Work for the manual automation fixture.' }
        }
      } else {
        assert.equal(body.model, 'worker-model'); assert.equal(body.reasoning_effort, 'max')
        assert(!names.includes('work_dispatch'), 'ordinary general worker must not inherit dispatcher grant')
        for (const name of ['read', 'write', 'exec', 'invoke_tool']) assert(names.includes(name), `remote general role exposes ${name}`)
        const assignment = body.messages.map(message => text(message.content)).find(content => content.includes('Assigned Work key:'))!
        const key = /Assigned Work key: (.+?)\. Read v:works\//.exec(assignment)![1]
        const step = workerRequests.get(key) ?? 0
        workerRequests.set(key, step + 1)
        const id = `worker-${workerRequests.size}-${step}`
        if (step === 0) message = call(id, 'read', { path: `v:works/keys/${encodeURIComponent(key)}` })
        else if (step === 1) {
          const view = JSON.parse(text(toolMessages.at(-1)!.content))
          assert.equal(view.records[0].key, key)
          message = call(id, 'write', { path: 'remote-evidence.txt', content: `Child write evidence for ${key}\n` })
        } else if (step === 2) {
          assert.match(text(toolMessages.at(-1)!.content), /^OK write/)
          message = call(id, 'exec', { shell: process.platform === 'win32' ? 'powershell' : 'sh', timeout_ms: 10_000,
            script: process.platform === 'win32'
              ? "git symbolic-ref --short HEAD | Set-Content branch-evidence.txt; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; Get-Location; Get-Content remote-evidence.txt"
              : 'git symbolic-ref --short HEAD > branch-evidence.txt && pwd && cat remote-evidence.txt' })
        } else if (step === 3) {
          assert.match(text(toolMessages.at(-1)!.content), /Child write evidence/)
          message = call(id, 'read', { path: `v:works/keys/${encodeURIComponent(key)}` })
        } else if (step === 4) {
          const current = JSON.parse(text(toolMessages.at(-1)!.content)).records[0]
          assert.equal(current.key, key)
          message = call(id, 'invoke_tool', { name: 'work_update', args: { key, version: current.version, status: 'done',
            notes: { summary: `Verified Child write and shell evidence for ${key}`, next: 'Result retained in isolated Child worktree; not publisher acceptance.' } } })
        } else {
          assert.equal(step, 5, 'no hidden retries or duplicate tool effects')
          const result = JSON.parse(text(toolMessages.at(-1)!.content))
          assert.equal(result.status, 'done')
          message = { content: 'Child evidence written and Work reports done; acceptance remains with the publisher.' }
        }
      }
      response.end(JSON.stringify({ id: randomUUID(), model: body.model, choices: [{ message, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }))
    } catch (error) {
      modelFailures.push(error)
      // A test assertion must not trigger the provider's network retry policy.
      response.end(JSON.stringify({ choices: [{ message: { content: 'Synthetic fixture assertion failed; inspect test diagnostics.' } }] }))
    }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert(address && typeof address !== 'string')
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const config = ConfigSchema.parse({ agent: { workspace: home, model: 'fixture@openai', autoHandoff: false },
    providers: { openai: { apiKey: 'synthetic-only-key', baseUrl: `http://127.0.0.1:${address.port}/v1` } },
    organization: { enabled: false }, channels: {}, mcp: {} })
  const catalog = new ProjectCatalog(join(root, 'catalog')); await catalog.init()
  const project = catalog.get('default')!
  const configStore = new ProjectConfigStore({ configPath: join(root, 'config', 'project.json'), home, getSharedConfig: () => config })
  await configStore.init(config)
  const effective = await configStore.update(raw => ({ ...raw, learning: { ...(raw.learning as object), enabled: false } }))
  const scope = createProjectScope('default')
  const runtime = await scope.run(() => createProjectRuntime(effective, { localExecutor: false, project, home, scope, catalog, configStore,
    mainCluster: cluster, copilotAuth: new CopilotAuthenticatorV2(join(root, 'empty-auth'), { isolated: true }), authorize: () => true }))
  const request = (path: string, method = 'GET', body?: unknown) => runtime.app.request(path, { method,
    headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const json = async (path: string, method = 'GET', body?: unknown, status = 200) => {
    const response = await request(path, method, body)
    assert.equal(response.status, status, await response.clone().text())
    return response.json()
  }
  const automationPath = `/api/automations/${WORK_DISPATCH_ID}`
  const summary = async () => (await json('/api/automations')).automations.find((job: { id: string }) => job.id === WORK_DISPATCH_ID)
  const wait = async (check: () => boolean | Promise<boolean>, description: string) => {
    const deadline = Date.now() + 20_000
    while (!await check()) {
      if (modelFailures.length) throw new AggregateError(modelFailures, 'Synthetic provider assertions failed')
      assert(Date.now() < deadline, description)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    if (modelFailures.length) throw new AggregateError(modelFailures, 'Synthetic provider assertions failed')
  }
  const records = async (): Promise<WorkRecord[]> => {
    const overview = await json('/api/work')
    return Promise.all(overview.items.map(async (item: { key: string }) => (await json(`/api/work/${encodeURIComponent(item.key)}`)).records[0]))
  }
  let reader: JsonlSessionStore | undefined
  try {
    await runtime.ready
    assert.equal((await summary()).enabled, false)
    const publisher = await json('/api/sessions/remote', 'POST', { nodeId: 'child', workdirId: 'repository', requestId: randomUUID() }, 201)
    const sourceFolder = runtime.folders.get(publisher.folderId)!
    assert.equal(sourceFolder.kind, 'remote'); assert.equal(sourceFolder.path, sourceDisplay)
    await assert.rejects(lstat(sourceDisplay), { code: 'ENOENT' })
    await json(automationPath, 'PATCH', { program: { kind: 'work-dispatch', folderId: publisher.folderId,
      model: 'dispatch-model@openai', reasoningEffort: 'high', maxConcurrent: 1, maxConcurrentPerDevice: 1, inferenceRequests: 12, toolCalls: 12 } })
    assert.equal((await summary()).enabled, false, 'configuration is not enablement')
    const createUnassigned = async (title: string) => {
      await json('/api/chat/send', 'POST', { chatId: publisher.chatId, content: `CREATE_UNASSIGNED: ${title}`, stream: false })
      await wait(async () => createdTitles.has(title) && (await records()).some(record => record.workflow?.title === title),
        'ordinary model session did not create Work through real dynamic work_create')
      const unassigned = (await records()).find(record => record.workflow?.title === title)!
      assert(unassigned)
      assert.equal(unassigned.workflow?.assignee, null)
      return unassigned
    }
    const first = await createUnassigned('First independent Child evidence')
    await json(`${automationPath}/run`, 'POST', undefined, 202)
    await Promise.race([dispatcherEntered.promise, wait(() => rounds.size === 1, 'dispatcher did not enter HTTP model')])
    const overlapping = await Promise.all([json(`${automationPath}/run`, 'POST', undefined, 202), json(`${automationPath}/run`, 'POST', undefined, 202)])
    assert(overlapping.every(result => result.accepted))
    assert.equal(rounds.size, 1, 'overlapping manual scans do not create another dispatcher')
    releaseDispatcher.resolve()
    await wait(async () => (await records()).find(record => record.key === first.key)?.workflow?.status === 'done' && !(await summary()).running,
      'first real remote executor did not finish')
    const second = await createUnassigned('Second fresh independent Child evidence')
    await json(`${automationPath}/run`, 'POST', undefined, 202)
    await wait(async () => (await records()).find(record => record.key === second.key)?.workflow?.status === 'done' && !(await summary()).running,
      'second fresh remote executor did not finish')
    assert.equal(rounds.size, 2, 'new eligible Work gets a genuinely fresh dispatcher transcript')
    assert.deepEqual([...workerRequests.values()], [6, 6])
    const settled = await records()
    const assignments = settled.map(record => record.workflow!.assignee!)
    assert.equal(new Set(assignments).size, 2)
    const executionInferences = () => wire.filter(request => request.model !== 'fixture').length
    const automationInferenceCount = executionInferences()
    await json(`${automationPath}/run`, 'POST', undefined, 202)
    await wait(async () => !(await summary()).running, 'idle scan did not end')
    assert.equal(executionInferences(), automationInferenceCount, 'already assigned/done Work cannot cause another inference or worker')
    assert.equal((await summary()).enabled, false, 'manual runs never enable the timer')
    assert.equal(managed.workdirs.length, 3, 'one source and exactly two derived resources')

    const history = await json(`${automationPath}/runs`)
    await scope.run(() => runtime.shutdown())
    const store = reader = new JsonlSessionStore(workspacePath(home, '.sessions')); await store.init()
    const branches = new Set<string>(), paths = new Set<string>()
    const retainedFiles = (await readdir(join(home, 'derived-workspaces'))).filter(name => name.endsWith('.json'))
    const retained = await Promise.all(retainedFiles.map(async name => JSON.parse(await readFile(join(home, 'derived-workspaces', name), 'utf8'))))
    assert.equal(retained.length, 2)
    for (const record of settled) {
      const execution = record.automaticExecution!
      const state = await store.getState(record.workflow!.assignee!)
      assert(state)
      assert.equal(state.agentType, 'general'); assert.equal(state.folderId, execution.folderId)
      const isolated = runtime.folders.get(execution.folderId!)!
      assert.equal(isolated.kind, 'remote')
      assert(isolated.kind === 'remote')
      assert.deepEqual(state.workdir, isolated.workdir, 'session binds the exact Child-derived workdir, not the source or a local-folder ref')
      assert.equal(state.workdir!.nodeId, 'child'); assert.notEqual(state.workdir!.workdirId, 'repository')
      const saved = retained.find(item => item.receipt.workspaceId === state.folderId)!
      assert(saved)
      assert.equal(saved.receipt.sourcePath, source)
      assert.notEqual(saved.receipt.sourcePath, sourceFolder.path, 'Child native source path is not the remote folder display snapshot')
      assert.equal(saved.receipt.path, saved.result.receipt.path, 'Main displays the exact path returned by Child')
      assert.equal(saved.receipt.remote.workdirId, state.workdir!.workdirId)
      assert.equal(state.config?.model, 'worker-model@openai'); assert.equal(state.config?.reasoningEffort, 'max')
      assert.equal(state.automaticWork?.limits.inferenceRequests, 12)
      const native = managed.workdirs.find(resource => resource.workdirId === state.workdir!.workdirId)!
      assert(native?.displayPath)
      assert.equal(native.displayPath, execution.path)
      paths.add(native.displayPath); branches.add(execution.branch!)
      assert.notEqual(native.displayPath, source)
      assert((await lstat(join(native.displayPath, '.git'))).isFile(), 'derived resource is a real linked Git worktree')
      assert.match(execution.branch!, /^shadow(?:\/|-)derived-[0-9a-f-]{36}$/)
      assert.equal(await realpath(await git(native.displayPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)), await realpath(join(source, '.git')))
      assert.equal(await git(native.displayPath, ['symbolic-ref', '--short', 'HEAD'], signal), execution.branch)
      assert.equal(await git(native.displayPath, ['rev-parse', 'HEAD'], signal), sourceHead)
      assert.equal(await readFile(join(native.displayPath, 'tracked.txt'), 'utf8'), 'committed source\n')
      assert.equal(await readFile(join(native.displayPath, 'remote-evidence.txt'), 'utf8'), `Child write evidence for ${record.key}\n`)
      assert.equal((await readFile(join(native.displayPath, 'branch-evidence.txt'), 'utf8')).trim(), execution.branch)
      await assert.rejects(lstat(join(native.displayPath, 'untracked.txt')), { code: 'ENOENT' })
      const operations = executed.filter(request => request.workdirId === state.workdir!.workdirId).map(request => request.operation)
      assert(operations.includes('filesystem.write'))
      assert(operations.includes('workdir.process.execute-once'), 'real remote shell must use the Child journaled backend')
    }
    assert.equal(paths.size, 2); assert.equal(branches.size, 2)
    const dispatchers = history.runs.filter((run: { sessionId: string }) => run.sessionId.startsWith('cron:'))
    assert.equal(dispatchers.length, 2)
    for (const run of dispatchers) {
      assert.equal(await store.getState(run.sessionId), null, 'fresh dispatcher is finalized, never reused')
      const archived = await store.readArchivedState!(run.sessionId)
      assert.equal(archived?.agentType, 'dispatcher'); assert.equal(archived?.folderId, undefined)
      assert.equal(archived?.config?.model, 'dispatch-model@openai'); assert.equal(archived?.config?.reasoningEffort, 'high')
    }
    assert.equal(executed.filter(request => request.operation === DERIVED_WORKSPACE_OPERATION && (request.args as { action?: string }).action === 'create').length, 2)
    assert.equal(await git(source, ['symbolic-ref', '--short', 'HEAD'], signal), 'main')
    assert.equal(await git(source, ['rev-parse', 'HEAD'], signal), sourceHead)
    assert.equal(await git(source, ['status', '--porcelain=v1'], signal), sourceStatus)
    assert.deepEqual(await readFile(join(source, '.git', 'index')), sourceIndex)
    assert.equal(await readFile(join(source, 'tracked.txt'), 'utf8'), 'private dirty source\n')
    assert.equal(await readFile(join(source, 'untracked.txt'), 'utf8'), 'private untracked source\n')
    for (const path of [source, home, workspace]) {
      await assert.rejects(lstat(join(path, 'remote-evidence.txt')), { code: 'ENOENT' })
      await assert.rejects(lstat(join(path, 'branch-evidence.txt')), { code: 'ENOENT' })
    }
    await assert.rejects(lstat(sourceDisplay), { code: 'ENOENT' })
    assert(!(await readdir(home)).some(name => name.includes('-worktree-')), 'no Main-local worktree fallback')
    assert.deepEqual(modelFailures, [])
  } finally {
    releaseDispatcher.resolve()
    reader?.close()
    await scope.run(() => runtime.shutdown())
    scope.close()
  }
})
