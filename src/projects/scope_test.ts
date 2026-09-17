import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProjectScope, getProjectScope } from './scope.ts'

test('project scopes isolate concurrent async work without telemetry initialization', async () => {
  const first = createProjectScope('first')
  const second = createProjectScope('second')
  await Promise.all([first, second].map(scope => scope.run(async () => {
    await Promise.resolve()
    assert.equal(getProjectScope(), scope)
  })))
  assert.equal(getProjectScope(), undefined)
})

test('bound callbacks restore their owning scope and preserve this and arguments', () => {
  const owner = createProjectScope('owner')
  const caller = createProjectScope('caller')
  const receiver = { value: 7 }
  const callback = owner.run(() => owner.bind(function (this: typeof receiver, add: number) {
    assert.equal(getProjectScope(), owner)
    return this.value + add
  }))
  caller.run(() => {
    assert.equal(callback.call(receiver, 2), 9)
    assert.equal(getProjectScope(), caller)
  })
  assert.equal(getProjectScope(), undefined)
})

test('retiring a scope rejects its callbacks but not a replacement generation', () => {
  const retired = createProjectScope('project')
  const callback = retired.bind(() => getProjectScope())
  const replacement = createProjectScope('project')
  retired.close()
  assert.equal(retired.closed, true)
  assert.throws(callback, /Project runtime is closed/)
  assert.throws(() => retired.run(() => undefined), /Project runtime is closed/)
  assert.equal(replacement.run(() => getProjectScope()), replacement)
})
