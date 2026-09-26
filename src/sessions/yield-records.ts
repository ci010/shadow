import { physicalSessionId } from './session-identity.ts'
import type { SessionState, SessionStore } from './session-store.ts'
import { parseYieldDecisionRecord, parseYieldReview, parseDecisionInvalidation, type DecisionInvalidation, type YieldDecisionRecord, type YieldRequest, type YieldReview, type YieldReference } from './yield-contract.ts'
import { DECISION_BRIEF_HELP, type DecisionEvidence } from './decision-brief.ts'
import { YieldError } from './yield.ts'
import type { ConventionAuthority, ConventionSource } from '../projects/conventions.ts'

/** Project-local append-only facts; not a queue and never a source of answer authority. */
export class YieldRecords {
  private writing: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly store: SessionStore,
    private readonly getState: (id: string) => SessionState | null | undefined,
    private readonly workValidity?: (request: YieldRequest) => string | undefined,
    private readonly customAnswer?: (record: YieldDecisionRecord) => void,
  ) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writing.catch(() => {}).then(operation)
    this.writing = result
    return result
  }

  private segment(sessionId: string, physicalId?: string): string {
    const state = this.getState(sessionId)
    if (!state) throw new YieldError('not_found', 'Decision session not found.')
    const selected = physicalId ?? physicalSessionId(state)
    if (!Array.from({ length: state.segmentIndex + 1 }, (_, index) => physicalSessionId(state, index)).includes(selected)) {
      throw new YieldError('not_found', 'Decision segment does not belong to this session.')
    }
    return selected
  }

  private async readSegment(sessionId: string, physicalId?: string): Promise<YieldDecisionRecord[]> {
    const selected = this.segment(sessionId, physicalId)
    const records = new Map<string, YieldDecisionRecord>()
    const invalidations = new Map<string, DecisionInvalidation>()
    for await (const event of this.store.readSessionLog(selected)) {
      if (event.yield_invalidation) {
        const invalidation = parseDecisionInvalidation(event.yield_invalidation)
        if (invalidation.reference.sessionId !== sessionId || invalidation.reference.physicalId !== selected) throw new TypeError('Invalidation does not belong to its segment.')
        invalidations.set(invalidation.reference.requestId, invalidation)
      }
      if (!Object.hasOwn(event, 'yield_decision')) continue
      const value = event.yield_decision
      if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) {
        throw new TypeError('Unsupported decision record version.')
      }
      const record = parseYieldDecisionRecord(value)
      if (record.request.sessionId !== sessionId || record.request.origin?.physicalId !== selected) {
        throw new TypeError('Decision record origin does not match its log.')
      }
      const prior = records.get(record.request.id)
      if (prior && (JSON.stringify(prior.request) !== JSON.stringify(record.request)
        || ((prior.answer || prior.closed) && JSON.stringify(prior) !== JSON.stringify(record)))) {
        throw new TypeError('Conflicting decision history.')
      }
      records.set(record.request.id, record)
    }
    return [...records.values()].map(record => {
      const reason = this.workValidity?.(record.request)
      const invalidated = invalidations.get(record.request.id) ?? (reason ? {
        reference: { sessionId, physicalId: selected, requestId: record.request.id },
        at: record.request.createdAt, reason,
      } : undefined)
      return { ...record, ...(invalidated ? { invalidated } : {}) }
    })
  }

  async read(sessionId: string, physicalId?: string): Promise<YieldDecisionRecord[]> {
    const cache = new Map<string, Promise<YieldDecisionRecord[]>>()
    const load = (id: string, segment: string) => {
      const key = JSON.stringify([id, segment])
      if (!cache.has(key)) cache.set(key, this.readSegment(id, segment))
      return cache.get(key)!
    }
    const records = await load(sessionId, this.segment(sessionId, physicalId))
    for (const record of records) {
      const queue = [...(record.request.sources ?? [])]
      const seen = new Set<string>()
      while (!record.invalidated && queue.length) {
        const source = queue.shift()!
        const key = JSON.stringify(source)
        if (seen.has(key)) continue
        seen.add(key)
        if (seen.size > 1000) throw new YieldError('unavailable', 'Decision dependency closure exceeds 1000 records; narrow the references.')
        let linked: YieldDecisionRecord | undefined
        try { linked = (await load(source.sessionId, source.physicalId)).find(item => item.request.id === source.requestId) }
        catch (error) { if (!(error instanceof YieldError) || error.code !== 'not_found') throw error }
        if (!linked) {
          record.invalidated = { reference: source, at: new Date().toISOString(), reason: 'Referenced record is unavailable on this read. Revalidate before using the saved answer.' }
          break
        }
        if (linked.invalidated) record.invalidated = linked.invalidated
        else queue.push(...(linked.request.sources ?? []))
      }
    }
    return records
  }

  async context(sessionId: string) {
    this.segment(sessionId)
    const inputs: { sessionId: string; physicalId: string; kind: 'user'; id: string; quote: string }[] = []
    const state = this.getState(sessionId)!
    for (let index = state.segmentIndex; index >= 0 && inputs.length < 6; index--) {
      const physicalId = physicalSessionId(state, index)
      const segmentInputs: typeof inputs = []
      for await (const event of this.store.readSessionLog(physicalId)) {
        const input = event.decision_input
        if (input && typeof input === 'object' && 'id' in input && typeof input.id === 'string' && 'text' in input && typeof input.text === 'string') {
          segmentInputs.push({ sessionId, physicalId, kind: 'user', id: input.id, quote: input.text.slice(0, 2000) })
          if (segmentInputs.length > 6) segmentInputs.shift()
        }
      }
      inputs.push(...segmentInputs.reverse().slice(0, 6 - inputs.length))
    }
    return { briefSchema: DECISION_BRIEF_HELP, userInputs: inputs,
      notice: 'Quotes identify authorship, not interpretation. Missing historical provenance is unknown, never permission to invent a user constraint.' }
  }

  async evidence(source: DecisionEvidence): Promise<void> {
    const segment = this.segment(source.sessionId, source.physicalId)
    for await (const event of this.store.readSessionLog(segment)) {
      if (source.kind === 'user') {
        const input = event.decision_input
        if (input && typeof input === 'object' && 'id' in input && input.id === source.id
          && 'text' in input && typeof input.text === 'string' && input.text.includes(source.quote)) return
      } else if (event.role === 'tool' && event.tool_call_id === source.id
        && typeof event.content === 'string' && event.content.includes(source.quote)) return
    }
    throw new YieldError('invalid_request', 'Evidence quote does not match a recorded input/receipt from that author. Mark unverified claims as assumptions.')
  }

  async conventionAuthority(source: ConventionSource, input: { sessionId: string; physicalId: string; id: string }): Promise<ConventionAuthority> {
    if (source.sessionId !== input.sessionId) throw new YieldError('forbidden', 'Convention authority must belong to the current human conversation.')
    if (source.kind === 'user') {
      if (source.id !== input.id) {
        throw new YieldError('forbidden', 'A direct convention instruction must be the current human input, not an old quote.')
      }
      await this.evidence(source)
      return { source, quote: source.quote }
    }
    if (source.kind !== 'decision') throw new YieldError('forbidden', 'Tool observations cannot authorize Project conventions.')
    const record = (await this.read(source.sessionId, source.physicalId)).find(item => item.request.id === source.requestId)
    if (!record || record.closed || record.invalidated || record.request.recipient.kind !== 'user'
      || record.answer?.answeredBy !== 'user' || record.answer.custom
      || record.answer.requestId !== record.request.id || !record.request.options.includes(record.answer.option)) {
      throw new YieldError('forbidden', 'A convention decision needs a current, explicit human-selected option; parent, timeout, custom and invalidated answers are not approval.')
    }
    return { source, quote: record.answer.option }
  }

  async invalidate(reference: YieldReference, reason: string) {
    return this.serialize(async () => {
      const source = (await this.readSegment(reference.sessionId, reference.physicalId)).find(item => item.request.id === reference.requestId)
      if (!source) throw new YieldError('not_found', 'Decision record not found.')
      const proposed = parseDecisionInvalidation({ reference, reason, at: new Date().toISOString() })
      const invalidated = source.invalidated ?? proposed
      // Persist the cause once. Dependent validity is derived on read, including after restart.
      if (!source.invalidated) await this.store.appendRawEvents(reference.physicalId, [{ yield_invalidation: invalidated }])
      const affected = new Map<string, YieldDecisionRecord>([[JSON.stringify(reference), { ...source, invalidated }]])
      const scanErrors: { sessionId: string; message: string }[] = []
      let states: Record<string, SessionState> = {}
      try { states = await this.store.listAllStates() }
      catch (error) { scanErrors.push({ sessionId: reference.sessionId, message: `Could not enumerate dependent sessions: ${String(error)}` }) }
      for (const state of Object.values(states)) {
        for (let index = 0; index <= state.segmentIndex; index++) {
          try {
            for (const record of await this.read(state.sessionId, physicalSessionId(state, index))) {
              if (record.invalidated && JSON.stringify(record.invalidated.reference) === JSON.stringify(reference)) {
                affected.set(JSON.stringify({ sessionId: record.request.sessionId, physicalId: record.request.origin!.physicalId, requestId: record.request.id }), record)
              }
            }
          } catch (error) {
            scanErrors.push({ sessionId: state.sessionId, message: `Could not check segment ${index}: ${String(error)}` })
          }
        }
      }
      return { affected: [...affected.values()], scanErrors }
    })
  }

  async open(request: YieldRequest, toolCallId?: string): Promise<YieldRequest> {
    const state = this.getState(request.sessionId)
    if (!state) throw new YieldError('not_found', 'Decision session not found.')
    // Pin the segment before any asynchronous work: handoff cannot move this fact.
    const origin = { physicalId: physicalSessionId(state), ...(toolCallId ? { toolCallId } : {}) }
    if (request.reconsiders && !(await this.readSegment(request.reconsiders.sessionId, request.reconsiders.physicalId))
      .some(record => record.request.id === request.reconsiders!.requestId)) throw new YieldError('not_found', 'The earlier decision does not exist.')
    for (const claim of request.brief?.claims ?? []) if (claim.evidence) await this.evidence(claim.evidence)
    for (const source of request.sources ?? []) {
      const records = await this.read(source.sessionId, source.physicalId)
      const cited = records.find(record => record.request.id === source.requestId)
      if (!cited) {
        throw new YieldError('not_found', 'The cited decision does not exist in that session segment.')
      }
      if (cited.invalidated) throw new YieldError('conflict', 'A cited premise needs revalidation. Investigate and cite a new decision version.')
    }
    const saved = { ...request, origin }
    await this.write({ request: saved })
    return saved
  }

  async write(record: YieldDecisionRecord): Promise<void> {
    const parsed = parseYieldDecisionRecord(record)
    await this.serialize(async () => {
      const workError = this.workValidity?.(parsed.request)
      if (workError && !parsed.closed) throw new YieldError('conflict', workError)
      if (!parsed.closed) {
        for (const source of parsed.request.sources ?? []) {
          const linked = (await this.read(source.sessionId, source.physicalId)).find(record => record.request.id === source.requestId)
          if (!linked || linked.invalidated) throw new YieldError('conflict', 'Decision basis changed before publication or settlement.')
        }
      }
      if (parsed.answer && (await this.read(parsed.request.sessionId, parsed.request.origin!.physicalId))
        .find(item => item.request.id === parsed.request.id)?.invalidated) throw new YieldError('conflict', 'Decision premises changed; this version cannot be answered.')
      await this.store.appendRawEvents(parsed.request.origin!.physicalId, [{ yield_decision: { version: 1, ...parsed } }])
      if (parsed.answer?.custom && parsed.answer.answeredBy === 'user') {
        await this.store.appendRawEvents(parsed.request.origin!.physicalId, [{
          decision_input: { id: `yield:${parsed.request.id}`, text: parsed.answer.option, at: parsed.answer.answeredAt },
        }])
        this.customAnswer?.(parsed)
      }
    })
  }

  async replace(previous: YieldRequest, next: YieldRequest): Promise<void> {
    if (previous.workProposal || next.workProposal) {
      throw new YieldError('conflict', 'A work proposal cannot be rewritten as a different question. Return for investigation and create a new work proposal instead.')
    }
    if (!previous.origin || next.origin?.physicalId !== previous.origin.physicalId
      || next.supersedes?.requestId !== previous.id || next.sessionId !== previous.sessionId) {
      throw new TypeError('A replacement must retain the original decision owner and segment.')
    }
    const replacement = { sessionId: next.sessionId, physicalId: next.origin.physicalId, requestId: next.id }
    const closed = parseYieldDecisionRecord({ request: previous, closed: {
      at: next.createdAt, reason: 'superseded', message: next.revisionReason, replacement,
    } })
    const opened = parseYieldDecisionRecord({ request: next })
    await this.serialize(async () => {
      for (const claim of next.brief?.claims ?? []) if (claim.evidence) await this.evidence(claim.evidence)
      if ((await this.read(previous.sessionId, previous.origin!.physicalId)).find(item => item.request.id === previous.id)?.invalidated) {
        throw new YieldError('conflict', 'Revalidate the changed premise before requesting a new decision.')
      }
      await this.store.appendRawEvents(previous.origin!.physicalId, [closed, opened].map(record => ({ yield_decision: { version: 1, ...record } })))
    })
  }

  async readReviews(reference: YieldReference): Promise<YieldReview[]> {
    if (!(await this.read(reference.sessionId, reference.physicalId)).some(record => record.request.id === reference.requestId)) {
      throw new YieldError('not_found', 'Decision record not found.')
    }
    const reviews = new Map<string, YieldReview>()
    for await (const event of this.store.readSessionLog(reference.physicalId)) {
      if (!Object.hasOwn(event, 'yield_review')) continue
      const value = event.yield_review
      if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) throw new TypeError('Unsupported decision discussion version.')
      const review = parseYieldReview(value)
      if (review.reference.sessionId !== reference.sessionId || review.reference.physicalId !== reference.physicalId) {
        throw new TypeError('Decision discussion origin does not match its log.')
      }
      if (review.reference.requestId === reference.requestId) {
        const prior = reviews.get(review.id)
        if (prior && (prior.kind !== review.kind || prior.question !== review.question
          || prior.sessionId !== review.sessionId || prior.createdAt !== review.createdAt
          || (prior.status !== 'running' && JSON.stringify(prior) !== JSON.stringify(review)))) {
          throw new TypeError('Conflicting decision discussion history.')
        }
        reviews.set(review.id, review)
      }
    }
    return [...reviews.values()]
  }

  async writeReview(review: YieldReview): Promise<void> {
    const parsed = parseYieldReview(review)
    await this.store.appendRawEvents(parsed.reference.physicalId, [{ yield_review: { version: 1, ...parsed } }])
  }
}
