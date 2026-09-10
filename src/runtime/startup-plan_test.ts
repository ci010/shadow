import { deepEqual as assertEquals, throws as assertThrows } from 'node:assert/strict'
import { test } from 'node:test'
import {
  planRuntimeArguments,
  planRuntimeStartup,
  RuntimeArgumentError,
} from './startup-plan.ts'

test('headless server arguments plan startup without a display or UI', () => {
  const plan = planRuntimeArguments([
    'server',
    'start',
    '--config',
    'bootstrap.json',
    '--service',
    '--local-executor',
  ])

  assertEquals(plan, {
    command: 'start',
    expectedMode: 'main',
    configPath: 'bootstrap.json',
    serviceMode: true,
    localExecutor: true,
    requiresDisplay: false,
    launchUi: false,
  })
})

test('runtime startup combines validated config with a non-starting composition plan', () => {
  const argumentsPlan = planRuntimeArguments([
    'child',
    'start',
    '--config',
    'child-bootstrap.json',
  ])
  const plan = planRuntimeStartup(argumentsPlan, {
    version: 1,
    mode: 'child',
    dataDir: ' ./child-data ',
    localNodeId: ' child-node ',
    mainEndpoint: 'https://main.example.test/',
  })

  assertEquals(plan.requiresDisplay, false)
  assertEquals(plan.launchUi, false)
  assertEquals(plan.config.dataDir, './child-data')
  assertEquals(plan.composition.phase, 'composition-planned')
})

test('runtime arguments reject role-incompatible and secret-like flags', () => {
  assertThrows(
    () =>
      planRuntimeArguments([
        'child',
        'start',
        '--config',
        'bootstrap.json',
        '--local-executor',
      ]),
    (error) => error instanceof RuntimeArgumentError &&
      error.message.includes('--local-executor is only valid for server start'),
  )
  assertThrows(
    () =>
      planRuntimeArguments([
        'server',
        'start',
        '--config',
        'bootstrap.json',
        '--admin-secret',
        'plain-text',
      ]),
    (error) => error instanceof RuntimeArgumentError &&
      error.message.includes('unknown argument "--admin-secret"'),
  )
})

test('runtime startup rejects command and config role mismatch', () => {
  const argumentsPlan = planRuntimeArguments([
    'server',
    'validate',
    '--config',
    'bootstrap.json',
  ])

  assertThrows(
    () =>
      planRuntimeStartup(argumentsPlan, {
        version: 1,
        mode: 'child',
        dataDir: './child-data',
        localNodeId: 'child-node',
        mainEndpoint: 'https://main.example.test',
      }),
    (error) => error instanceof RuntimeArgumentError &&
      error.message.includes('command expects mode "main" but config has mode "child"'),
  )
})
