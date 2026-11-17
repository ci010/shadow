import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { Journal, JournalConflictError } from '../../watermarks/journal.ts'
import { projectStoragePath } from '../../utils/data-paths.ts'
import { safePath } from '../../knowledge/service.ts'
import { archivePathSchema, canonical, checksum, revisionSchema } from './maintenance-contracts.ts'

const directionSchema = z.enum(['prepare', 'commit', 'rollback', 'restore', 'internal'])
const operationSchema = z.object({ id: z.string().uuid(), revision: revisionSchema,
  phase: z.enum(['reserved', 'mutating', 'committed', 'blocked']), paths: z.array(archivePathSchema),
  terminalDirection: directionSchema.nullable(), settled: z.boolean(),
  publishedRetired: z.array(archivePathSchema).default([]),
  restores: z.object({ id: z.string().uuid(), revision: revisionSchema }).strict().optional(),
  retirementBaseline: z.array(archivePathSchema).optional(),
}).strict()
const runnerSchema = z.object({ id: z.string().uuid(), pid: z.number().int().positive(), hostname: z.string().min(1),
  direction: directionSchema, generation: z.number().int().nonnegative() }).strict()
const schema = z.object({ version: z.literal(1), generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  writers: z.array(z.string().uuid()), writerPaths: z.record(z.string().uuid(), z.array(z.string())),
  operation: operationSchema.nullable(), retired: z.array(archivePathSchema), runner: runnerSchema.nullable(),
  abandonedExecutions: z.array(runnerSchema), operationHistory: z.array(operationSchema).default([]),
}).strict()
type State = z.infer<typeof schema>
export type MaintenanceOperation = Pick<z.infer<typeof operationSchema>, 'id' | 'revision'>
const activeActions = new Set<string>()
const admissions = new AsyncLocalStorage<{ key: string; writer?: string; operation?: MaintenanceOperation; execution?: string }>()
const empty = (): State => ({ version: 1, generation: 0, writers: [], writerPaths: {}, operation: null, retired: [], runner: null, abandonedExecutions: [], operationHistory: [] })
const pathKey = (path: string) => path.replace(/\\/g, '/').normalize('NFC').toLowerCase()
const writerKey = (path: string) => {
  const key = pathKey(path), parts = key.split('/')
  return parts[0] === 'skills' && parts.length >= 2 ? `skills/${parts[1]}` : key
}
export class MaintenanceFenceError extends Error {}
/** The source callback is never replayed to repair a reservation cleanup. */
export class MaintenanceCleanupError extends AggregateError {
  constructor(readonly reservationId: string, readonly actionReturned: boolean,
    readonly actionResult: unknown, readonly actionError: unknown, readonly cleanupError: unknown,
    readonly evidencePath: string | undefined, evidenceError: unknown, readonly retryCleanup: () => void) {
    super([...(actionReturned ? [] : [actionError]), cleanupError, ...(evidenceError === undefined ? [] : [evidenceError])],
      `Source action ${actionReturned ? 'returned' : 'threw'}; admission cleanup failed; do not replay source action`)
  }
}


/** Durable writer/path reservations and exclusive operation execution. Crashed
 * writer reservations never expire; explicit execution recovery only abandons
 * a provably dead same-host PID, retaining its full runner evidence. */
export class MaintenanceGate {
  private readonly file: string
  constructor(private readonly home: string) {
    this.file = projectStoragePath(home, 'state/learning/document-maintenance-v1/gate.json')
  }
  private journal() {
    let parent = dirname(this.file)
    while (!existsSync(parent)) parent = dirname(parent)
    safePath(parent)
    if (existsSync(this.file)) safePath(this.file)
    return new Journal(this.file, value => schema.parse(value))
  }
  status(): State { return structuredClone(this.journal().read(empty())) }
  private change(update: (state: State) => void) {
    const journal = this.journal(), state = journal.read(empty())
    update(state); state.generation++
    journal.save(state) // No automatic callback replay after CAS conflict.
    return structuredClone(state)
  }
  private same(actual: State['operation'], expected: MaintenanceOperation) {
    if (!actual || actual.id !== expected.id || actual.revision !== expected.revision) throw new Error('Maintenance operation identity/revision conflict')
  }
  visibilityRevision(): string {
    const state = this.status()
    return checksum(canonical({ retired: state.retired, operation: state.operation ? { id: state.operation.id,
      paths: state.operation.paths, active: state.operation.phase !== 'committed' } : null }))
  }
  assertView(revision: string) {
    if (revision !== this.visibilityRevision()) throw new MaintenanceFenceError('Document visibility changed during read; retry from current view')
  }
  /** Canonical selections are lowercase, but ordinary file APIs can receive
   * case aliases on macOS/Windows. Compare actual file identity for such aliases
   * rather than retiring a distinct uppercase file on a case-sensitive volume. */
  private matches(selected: string, requested: string): boolean {
    if (selected === requested) return true
    const selectedSkill = /^skills\/([^/]+)\/SKILL\.md$/.exec(selected)
    const requestedSkill = /^skills\/([^/]+)(?:\/|$)/i.exec(requested)
    if (selectedSkill && requestedSkill && pathKey(selectedSkill[1]!) === pathKey(requestedSkill[1]!)) {
      if (selectedSkill[1] === requestedSkill[1]) return true
      try {
        const a = safePath(projectStoragePath(this.home, 'skills', selectedSkill[1]!))
        const b = safePath(projectStoragePath(this.home, 'skills', requestedSkill[1]!))
        return a.dev === b.dev && a.ino === b.ino
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
    }
    if (pathKey(selected) !== pathKey(requested)) return false
    try {
      const a = safePath(projectStoragePath(this.home, selected)), b = safePath(projectStoragePath(this.home, requested))
      return a.dev === b.dev && a.ino === b.ino
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  isRetired(path: string): boolean { return this.status().retired.some(selected => this.matches(selected, path)) }
  isHidden(path: string): boolean {
    const state = this.status()
    return state.retired.some(selected => this.matches(selected, path)) || !!(state.operation && state.operation.phase !== 'committed' && state.operation.paths.some(selected => this.matches(selected, path)))
  }
  assertReadable(path: string) {
    if (this.isHidden(path)) throw new Error('Retired document: use explicit maintenance snapshot history')
  }
  assertIdle() {
    const state = this.status()
    if (state.operation && (state.operation.phase !== 'committed' || !state.operation.settled || state.runner)) throw new MaintenanceFenceError('Document maintenance fence active; learning admission blocked')
  }
  private check(state: State, paths: readonly string[], operation?: MaintenanceOperation, execution?: string) {
    if (paths.some(path => state.retired.some(selected => this.matches(selected, path)))) throw new Error('Retired document cannot be modified')
    if (operation) {
      this.same(state.operation, operation)
      if (paths.some(path => !state.operation!.paths.some(selected => this.matches(selected, path)))) throw new Error('Maintenance write outside reviewed document scope')
      if (!execution || !activeActions.has(execution) || state.runner?.id !== execution) throw new Error('Expired operation execution cannot be reused')
      if (!['reserved', 'mutating'].includes(state.operation!.phase)) throw new Error('Maintenance operation is not writable')
    } else if (state.operation && (state.operation.phase !== 'committed' || !state.operation.settled || state.runner)) throw new MaintenanceFenceError('Document maintenance fence active')
  }
  private claimPaths(state: State, writer: string, paths: readonly string[]) {
    const keys = paths.map(writerKey)
    for (const [other, held] of Object.entries(state.writerPaths)) {
      if (other !== writer && keys.some(key => held.includes(key))) throw new Error('Formal writer path is busy; reread before retrying')
    }
    state.writerPaths[writer] = [...new Set([...(state.writerPaths[writer] ?? []), ...keys])].sort()
  }
  private nested(paths: readonly string[]): boolean {
    const nested = admissions.getStore()
    if (nested?.key !== this.file) return false
    const state = this.status()
    if (nested.writer && (!activeActions.has(nested.writer) || !state.writers.includes(nested.writer))) throw new Error('Expired writer admission cannot be reused')
    this.check(state, paths, nested.operation, nested.execution)
    if (nested.writer && paths.some(path => !(state.writerPaths[nested.writer!] ?? []).includes(writerKey(path)))) {
      this.change(current => { this.check(current, paths); this.claimPaths(current, nested.writer!, paths) })
    }
    return true
  }
  async write<T>(paths: readonly string[], action: () => T | Promise<T>): Promise<T> {
    if (this.nested(paths)) return action()
    const writer = randomUUID()
    this.change(state => { this.check(state, paths); this.claimPaths(state, writer, paths); state.writers.push(writer) })
    return this.finishAsync(writer, () => admissions.run({ key: this.file, writer }, action), () => this.releaseWriter(writer))
  }
  writeSync<T>(paths: readonly string[], action: () => T, expectedRevision?: string): T {
    if (expectedRevision === undefined && this.nested(paths)) return action()
    const writer = randomUUID()
    this.change(state => {
      if (expectedRevision !== undefined && checksum(canonical(state)) !== expectedRevision) throw new Error('Current complete gate revision changed; new host content review required')
      this.check(state, paths); this.claimPaths(state, writer, paths); state.writers.push(writer)
    })
    return this.finishSync(writer, () => admissions.run({ key: this.file, writer }, action), () => this.releaseWriter(writer))
  }
  /** Only idempotent removal of OUR metadata is retried. Never replay actions,
   * claims, state transitions or arbitrary callbacks on a stale read. */
  private cleanupOwn(update: (state: State) => boolean) {
    for (let attempt = 0; attempt < 32; attempt++) {
      try {
        const journal = this.journal(), state = journal.read(empty())
        if (!update(state)) return structuredClone(state)
        state.generation++; journal.save(state); return structuredClone(state)
      } catch (error) {
        const lockBusy = (error as NodeJS.ErrnoException).code === 'EEXIST' &&
          (error as NodeJS.ErrnoException).path === `${this.file}.lock`
        if ((!(error instanceof JournalConflictError) && !lockBusy) || attempt === 31) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
      }
    }
  }
  private releaseWriter(writer: string) {
    this.cleanupOwn(state => {
      if (!state.writers.includes(writer)) {
        if (state.writerPaths[writer]) throw new Error('Writer path evidence without matching owner')
        return false // Previous cleanup publication already succeeded.
      }
      state.writers = state.writers.filter(value => value !== writer); delete state.writerPaths[writer]
      return true
    })
  }
  private cleanupFailure(id: string, returned: boolean, result: unknown, actionError: unknown, cleanupError: unknown, retry: () => void) {
    let evidencePath: string | undefined, evidenceError: unknown
    try {
      const directory = `${dirname(this.file)}/cleanup-failures`
      mkdirSync(directory, { recursive: true }); safePath(directory)
      const file = `${directory}/${id}.json`
      const errorText = (error: unknown) => error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 2000) : String(error).slice(0, 2000)
      const fd = openSync(file, 'wx', 0o600)
      try { writeFileSync(fd, JSON.stringify({ version: 1, reservationId: id, actionOutcome: returned ? 'returned' : 'threw',
        actionError: returned ? null : errorText(actionError), cleanupError: errorText(cleanupError) }) + '\n'); fsyncSync(fd) }
      finally { closeSync(fd) }
      evidencePath = file
    } catch (error) { evidenceError = error }
    return new MaintenanceCleanupError(id, returned, result, actionError, cleanupError, evidencePath, evidenceError, retry)
  }
  private finishSync<T>(id: string, action: () => T, cleanup: () => void): T {
    let result!: T, actionError: unknown, returned = false
    activeActions.add(id)
    try { result = action(); returned = true } catch (error) { actionError = error }
    finally { activeActions.delete(id) }
    try { cleanup() } catch (error) { throw this.cleanupFailure(id, returned, result, actionError, error, cleanup) }
    if (!returned) throw actionError
    return result
  }
  private async finishAsync<T>(id: string, action: () => T | Promise<T>, cleanup: () => void): Promise<T> {
    let result!: T, actionError: unknown, returned = false
    activeActions.add(id)
    try { result = await action(); returned = true } catch (error) { actionError = error }
    finally { activeActions.delete(id) }
    try { cleanup() } catch (error) { throw this.cleanupFailure(id, returned, result, actionError, error, cleanup) }
    if (!returned) throw actionError
    return result
  }
  reserve(operation: MaintenanceOperation, paths: readonly string[] = [], expectedRevision?: string) {
    const scope = [...new Set(paths)].sort()
    operationSchema.parse({ ...operation, phase: 'reserved', paths: scope, terminalDirection: null, settled: false, publishedRetired: [] })
    return this.change(state => {
      if (expectedRevision !== undefined && checksum(canonical(state)) !== expectedRevision) throw new Error('Current complete gate revision changed; new host plan/confirmation required')
      if (state.operation) {
        this.same(state.operation, operation)
        if (canonical(state.operation.paths) !== canonical(scope)) throw new Error('Maintenance path scope conflict')
        return
      }
      if (state.writers.length) throw new Error('In-flight formal writers/learning attempts block maintenance; explicit recovery required after crash')
      state.operation = { ...operation, phase: 'reserved', paths: scope, terminalDirection: null, settled: false, publishedRetired: [] }
    })
  }
  /** Persistent exclusive runner. recoverDead is only for an explicit host
   * recovery call, never status/construction. No lock/evidence deletion. */
  async operation<T>(operation: MaintenanceOperation, action: () => T | Promise<T>, direction: z.infer<typeof directionSchema> = 'internal', recoverDead = false, expectedRevision?: string, released?: (revision: string) => void): Promise<T> {
    const id = randomUUID()
    this.change(state => {
      if (expectedRevision !== undefined && checksum(canonical(state)) !== expectedRevision) throw new Error('Current complete gate revision changed; new host recovery plan/confirmation required')
      this.same(state.operation, operation)
      if (state.writers.length) throw new Error('In-flight formal writers block operation execution')
      if (state.runner) {
        let dead = false
        if (recoverDead && state.runner.hostname === hostname()) {
          try { process.kill(state.runner.pid, 0) } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH' }
        }
        if (!dead) throw new Error('Maintenance operation execution already owned; explicit dead-owner recovery required')
        state.abandonedExecutions.push(state.runner)
      }
      state.runner = { id, pid: process.pid, hostname: hostname(), direction, generation: state.generation + 1 }
    })
    return this.finishAsync(id, () => admissions.run({ key: this.file, operation, execution: id }, action), () => {
      const state = this.cleanupOwn(state => {
        if (!state.runner) return false
        if (state.runner.id !== id) throw new Error('Maintenance execution ownership lost; evidence retained')
        state.runner = null; return true
      })
      if (!state) throw new Error('Maintenance cleanup did not publish a state')
      // Exact state published by OUR cleanup CAS, not a later arbitrary read.
      released?.(checksum(canonical(state)))
    })
  }
  transition(operation: MaintenanceOperation, phase: 'mutating' | 'committed' | 'blocked', retired: readonly string[] = []) {
    const execution = admissions.getStore()?.execution
    this.change(state => {
      this.same(state.operation, operation)
      if (!execution || !activeActions.has(execution) || state.runner?.id !== execution) throw new Error('Exclusive maintenance execution required')
      if (state.operation!.restores && phase === 'committed') throw new Error('Use exact restoration publication protocol')
      if (state.operation!.phase === 'committed') throw new Error('Committed operation cannot be republished')
      if (state.operation!.phase === 'blocked' && phase !== 'blocked') throw new Error('Blocked operation requires explicit recovery protocol')
      if (state.writers.length) throw new Error('Unexpected in-flight writers')
      for (const path of retired) {
        archivePathSchema.parse(path)
        if (!state.operation!.paths.includes(path)) throw new Error('Retirement outside reserved scope')
      }
      if ((phase !== 'committed' || state.runner.direction === 'rollback') && retired.length) throw new Error('Retirement requires forward committed visibility')
      if (phase === 'committed') {
        state.retired = [...new Set(retired)].sort()
        state.operation!.publishedRetired = [...state.retired]
        state.operation!.terminalDirection = state.runner.direction
        state.operation!.settled = false
      }
      state.operation!.phase = phase
    })
  }
  /** A separate confirmed restore reserves a NEW operation without erasing
   * the archived operation or any retired-path evidence. Full gate CAS binds the
   * current revision observed by the host restoration plan. */
  reserveRestoration(original: MaintenanceOperation, gateRevision: string, restore: MaintenanceOperation, paths: readonly string[], archivePaths: readonly string[], expectedRevision?: string) {
    const scope = [...new Set(paths)].sort(), archives = [...new Set(archivePaths)].sort()
    return this.change(state => {
      if (expectedRevision !== undefined && checksum(canonical(state)) !== expectedRevision) throw new Error('Current complete gate revision changed; new restoration recovery confirmation required')
      if (state.operation?.id === restore.id && state.operation.revision === restore.revision &&
        state.operation.restores?.id === original.id && state.operation.restores.revision === original.revision) {
        if (canonical(scope) !== canonical(state.operation.paths)) throw new Error('Restoration scope changed')
        return
      }
      if (checksum(canonical(state)) !== gateRevision) throw new Error('Current complete gate revision changed; restoration needs a fresh plan/confirmation')
      this.same(state.operation, original)
      if (state.operation!.phase !== 'committed' || !state.operation!.settled || state.operation!.terminalDirection !== 'commit' ||
        state.runner || state.writers.length) throw new Error('Only a settled committed archive can be restored')
      if (canonical(scope) !== canonical(state.operation!.paths)) throw new Error('Restoration must bind the complete original document scope')
      if (canonical(state.retired) !== canonical(archives) ||
        state.operation!.publishedRetired.length && canonical(state.operation!.publishedRetired) !== canonical(archives)) throw new Error('Original archive retirement evidence conflicts with restoration scope')
      // Legacy v1 gates did not duplicate published paths on the descriptor.
      // The confirmed original receipt + exact current retired set supply that
      // binding; retain the old receipt bytes and record the bound descriptor.
      state.operationHistory.push({ ...structuredClone(state.operation!), publishedRetired: archives })
      state.operation = { ...restore, phase: 'reserved', paths: scope, settled: false, terminalDirection: null,
        publishedRetired: [], restores: { ...original }, retirementBaseline: [...state.retired] }
    })
  }
  publishRestoration(operation: MaintenanceOperation, restorePaths: readonly string[]) {
    const execution = admissions.getStore()?.execution
    this.change(state => {
      this.same(state.operation, operation)
      if (!execution || !activeActions.has(execution) || state.runner?.id !== execution || state.runner.direction !== 'restore' ||
        !['reserved', 'mutating'].includes(state.operation!.phase)) throw new Error('Exclusive restoration execution required')
      const parent = state.operation!.restores
      const original = state.operationHistory.find(item => item.id === parent?.id && item.revision === parent.revision)
      if (!original || canonical([...restorePaths].sort()) !== canonical(original.publishedRetired) ||
        canonical(state.retired) !== canonical(state.operation!.retirementBaseline)) throw new Error('Original retirement/current visibility revision conflict')
      state.retired = state.retired.filter(path => !restorePaths.includes(path))
      state.operation!.publishedRetired = [...state.retired]
      state.operation!.phase = 'committed'; state.operation!.terminalDirection = 'restore'; state.operation!.settled = false
    })
  }
  /** Release write/learning admission only after terminal receipt publication
   * and view refresh. A crash after visibility CAS must leave this false. */
  settle(operation: MaintenanceOperation) {
    const execution = admissions.getStore()?.execution
    this.change(state => {
      this.same(state.operation, operation)
      if (!execution || !activeActions.has(execution) || state.runner?.id !== execution || state.operation!.phase !== 'committed' ||
        state.operation!.terminalDirection !== state.runner.direction) throw new Error('Matching exclusive terminal execution required to release fence')
      state.operation!.settled = true
    })
  }
  path(file: string): string {
    const absolute = resolve(file)
    for (const root of ['memory', 'skills']) {
      const inside = relative(projectStoragePath(this.home, root), absolute).split(sep).join('/')
      if (inside && inside !== '..' && !inside.startsWith('../') && !isAbsolute(inside)) return `${root}/${inside}`
    }
    const value = relative(projectStoragePath(this.home), absolute).split(sep).join('/')
    if (value.startsWith('../') || value === '..') throw new Error('Foreign Project maintenance path')
    return value
  }
}
