import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOrganizationScope, getOrganizationScope } from './scope.ts'

test('organization scopes isolate concurrent async work without telemetry initialization', async () => {
  const first = createOrganizationScope('first')
  const second = createOrganizationScope('second')
  await Promise.all([first, second].map(scope => scope.run(async () => {
    await Promise.resolve()
    assert.equal(getOrganizationScope(), scope)
  })))
  assert.equal(getOrganizationScope(), undefined)
})

test('bound callbacks restore their owning scope and preserve this and arguments', () => {
  const owner = createOrganizationScope('owner')
  const caller = createOrganizationScope('caller')
  const receiver = { value: 7 }
  const callback = owner.run(() => owner.bind(function (this: typeof receiver, add: number) {
    assert.equal(getOrganizationScope(), owner)
    return this.value + add
  }))
  caller.run(() => {
    assert.equal(callback.call(receiver, 2), 9)
    assert.equal(getOrganizationScope(), caller)
  })
  assert.equal(getOrganizationScope(), undefined)
})

test('retiring a scope rejects its callbacks but not a replacement generation', () => {
  const retired = createOrganizationScope('organization')
  const callback = retired.bind(() => getOrganizationScope())
  const replacement = createOrganizationScope('organization')
  retired.close()
  assert.equal(retired.closed, true)
  assert.throws(callback, /Organization runtime is closed/)
  assert.throws(() => retired.run(() => undefined), /Organization runtime is closed/)
  assert.equal(replacement.run(() => getOrganizationScope()), replacement)
})
