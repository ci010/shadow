import assert from 'node:assert/strict'
import test from 'node:test'
import { OrganizationController } from './organization-controller.ts'
import { createProjectScope } from './scope.ts'

test('independent organizer has no automatic admission, and disable/stop abort explicit full or delta work', async () => {
  const scope = createProjectScope('fixture')
  let calls = 0
  const controller = new OrganizationController({ scope, changed() {}, organize: async (_mode, signal) => {
    calls++
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  } })
  try {
    assert.equal(calls, 0)
    controller.update(false)
    await assert.rejects(controller.organize(new AbortController().signal), /organization_disabled/)
    assert.equal(calls, 0)
    controller.update(true)
    const full = controller.organize(new AbortController().signal, 'full')
    assert.equal(calls, 1)
    assert.equal(controller.status().running, true)
    await assert.rejects(controller.organize(new AbortController().signal, 'delta'), /already running/)
    const disabled = assert.rejects(full, /organization_disabled/)
    controller.update(false)
    await disabled
    assert.equal(controller.status().running, false)
    controller.update(true)
    assert.equal(calls, 1, 're-enabling never replays observation or organization')
    const delta = controller.organize(new AbortController().signal, 'delta')
    const stopped = assert.rejects(delta, /organization_stopped/)
    await controller.stop()
    await stopped
    assert.equal(calls, 2)
    await assert.rejects(controller.organize(new AbortController().signal), /organization_stopped/)
    assert.equal(calls, 2)
  } finally { await controller.stop(); scope.close() }
})

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await sleep(2) }
  assert.fail('condition did not settle')
}

test('startup preflight skips unchanged candidates; debounce drains bounded delta and retries failure', async () => {
  const scope = createProjectScope('fixture')
  let candidates = 0, calls = 0, checks = 0, fail = true
  const controller = new OrganizationController({ scope, changed() {}, debounceMs: 5, maxWaitMs: 15, retryMs: 5,
    hasDelta: async () => { checks++; return candidates > 0 },
    organize: async mode => {
      assert.equal(mode, 'delta'); calls++
      if (fail) { fail = false; throw new Error('fixture failure') }
      candidates--
    },
  })
  try {
    controller.start()
    await until(() => checks > 0)
    assert.equal(calls, 0)
    candidates = 2
    controller.notify(); controller.notify(); controller.notify()
    await until(() => candidates === 0)
    assert.equal(calls, 3, 'failure retried, both persisted candidates drained')
    await sleep(15)
    assert.equal(calls, 3)
  } finally { await controller.stop(); scope.close() }
})

test('hints during execution survive, manual stays single-flight, disable and stop cancel timers', async () => {
  const scope = createProjectScope('fixture')
  let candidates = 1, calls = 0, release: (() => void) | undefined
  const controller = new OrganizationController({ scope, changed() {}, debounceMs: 3, retryMs: 3,
    hasDelta: async () => candidates > 0,
    organize: async () => { calls++; candidates--; if (calls === 1) await new Promise<void>(resolve => { release = resolve }) },
  })
  try {
    controller.start()
    await until(() => !!release)
    await assert.rejects(controller.organize(new AbortController().signal), /already running/)
    candidates++
    controller.notify()
    release!()
    await until(() => calls === 2)
    controller.notify(); controller.update(false)
    await sleep(10)
    assert.equal(calls, 2)
    candidates++
    controller.update(true)
    await until(() => calls === 3)
    controller.notify()
    await controller.stop()
    await sleep(10)
    assert.equal(calls, 3)
  } finally { await controller.stop(); scope.close() }
})

test('continuous hints have a maximum debounce delay', async () => {
  const scope = createProjectScope('fixture')
  let calls = 0, candidates = true
  const controller = new OrganizationController({ scope, changed() {}, debounceMs: 30, maxWaitMs: 15,
    hasDelta: async () => candidates, organize: async () => { calls++; candidates = false },
  })
  const ticker = setInterval(() => controller.notify(), 2)
  try {
    controller.start()
    await until(() => calls === 1)
    assert.equal(calls, 1)
  } finally { clearInterval(ticker); await controller.stop(); scope.close() }
})

test('pre-ready hints never run until start; failed preflight exposes safe diagnostics and recovers', async () => {
  const scope = createProjectScope('fixture')
  let checks = 0, calls = 0, fail = true, pending = true
  const controller = new OrganizationController({ scope, changed() {}, debounceMs: 3, maxWaitMs: 5, retryMs: 40,
    hasDelta: async () => { checks++; if (fail) throw new Error('private fixture evidence'); return pending },
    organize: async () => { calls++; pending = false },
  })
  try {
    controller.notify(); controller.notify()
    await sleep(15)
    assert.equal(checks, 0)
    assert.equal(controller.status().nextAutomaticAt, undefined)
    controller.start()
    await until(() => !!controller.status().lastAutomaticError)
    assert.equal(controller.status().lastAutomaticError, 'organization_delta_check_failed')
    assert(controller.status().lastCheckedAt)
    await until(() => !!controller.status().nextAutomaticAt)
    assert(!JSON.stringify(controller.status()).includes('private fixture evidence'))
    fail = false
    await until(() => calls === 1)
    assert.equal(controller.status().lastAutomaticError, undefined)
  } finally { await controller.stop(); scope.close() }
})


test('idle and cooldown reconciliation survives an unchanged preflight without a fresh hint',async()=>{
  const scope=createProjectScope('fixture')
  let eligible=false,checks=0,calls=0
  const controller=new OrganizationController({scope,changed(){},debounceMs:1,retryMs:5,
    hasDelta:async()=>{checks++;return eligible},organize:async()=>{calls++;eligible=false}})
  try{
    controller.start()
    await until(()=>checks>=2)
    assert.equal(calls,0,'cheap recovery checks never call an empty model')
    eligible=true // source became idle or cooldown expired, with no second hint
    await until(()=>calls===1)
    assert(controller.status().nextAutomaticAt || checks>2)
    controller.update(false)
    const stoppedAt=checks
    await sleep(20)
    assert.equal(checks,stoppedAt,'disable stops periodic admission checks')
  }finally{await controller.stop();scope.close()}
})

// Exercise the production publisher contract, including several empty retry cycles.
test('empty automatic checks publish organization status only, never sessions', async () => {
  const { RealtimeHub } = await import('../realtime/hub.ts')
  const hub = new RealtimeHub()
  const publisher = hub.registerProject('fixture')
  const scope = createProjectScope('fixture')
  const abort = new AbortController()
  const reader = hub.connect([{ kind: 'sessions', projectId: 'fixture' }, { kind: 'resources', projectId: 'fixture' }], abort.signal).body!.getReader()
  const events: { topic: { kind: string }; payload: unknown }[] = []
  const reading = (async () => {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      for (const match of new TextDecoder().decode(chunk.value).matchAll(/^data: (.+)$/gm)) {
        const envelope = JSON.parse(match[1])
        if (envelope.type === 'event') events.push(envelope)
      }
    }
  })()
  let checks = 0, executions = 0
  const controller = new OrganizationController({ scope, debounceMs: 1, retryMs: 5,
    hasDelta: async () => { checks++; return false },
    organize: async () => { executions++ },
    changed: () => publisher.invalidateResource?.('organization'),
  })
  try {
    controller.start()
    await until(() => checks >= 4 && events.length >= 4)
    assert.equal(executions, 0)
    assert(controller.status().lastCheckedAt)
    assert(controller.status().nextAutomaticAt)
    assert(events.length >= 4)
    for (const event of events) {
      assert.equal(event.topic.kind, 'resources')
      assert.deepEqual(event.payload, { event: 'invalidate', resource: 'organization' })
    }
  } finally {
    await controller.stop(); await reader.cancel(); await reading
    publisher.close(); hub.close(); scope.close()
  }
})
