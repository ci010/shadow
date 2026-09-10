import { deepEqual as assertEquals, throws as assertThrows } from 'node:assert/strict'
import { test } from 'node:test'
import { parseBootstrapConfigV1 } from './bootstrap-config.ts'
import { planRuntimeComposition } from './composition.ts'

const mainConfig = parseBootstrapConfigV1({
  version: 1,
  mode: 'main',
  dataDir: './main-data',
  localNodeId: 'main-node',
})

const childConfig = parseBootstrapConfigV1({
  version: 1,
  mode: 'child',
  dataDir: './child-data',
  localNodeId: 'child-node',
  mainEndpoint: 'https://main.example.test',
})

test('brain-only Main plans all authority services without a local executor', () => {
  const plan = planRuntimeComposition(mainConfig)

  assertEquals(plan.phase, 'composition-planned')
  assertEquals(plan.mode, 'main')
  assertEquals(Object.keys(plan.services), [
    'providers',
    'sessions',
    'memory',
    'wiki',
    'skills',
    'agentDefinitions',
    'channels',
    'cron',
    'events',
    'vfs',
    'durableStores',
    'clusterListener',
    'nodeRegistry',
  ])
  assertEquals('localExecutor' in plan.services, false)
})

test('Main local executor is an explicit opt-in using the shared executor contract', () => {
  const plan = planRuntimeComposition(mainConfig, { localExecutor: true })
  if (plan.mode !== 'main') throw new Error('expected Main plan')

  assertEquals(Object.keys(plan.services.localExecutor ?? {}), [
    'nodeIdentity',
    'capabilityRegistry',
    'executors',
    'approvalService',
    'artifactStaging',
  ])
})

test('Child plans node services and excludes every brain-only service', () => {
  const plan = planRuntimeComposition(childConfig)

  assertEquals(plan.phase, 'composition-planned')
  assertEquals(plan.mode, 'child')
  assertEquals(Object.keys(plan.services), [
    'mainConnector',
    'remoteApiProxy',
    'nodeIdentity',
    'capabilityRegistry',
    'executors',
    'approvalService',
    'artifactStaging',
  ])

  for (
    const forbidden of [
      'providers',
      'sessions',
      'memory',
      'wiki',
      'channels',
      'cron',
    ]
  ) {
    assertEquals(forbidden in plan.services, false)
  }
})

test('Child rejects Main-only composition options', () => {
  assertThrows(
    () => planRuntimeComposition(childConfig, { localExecutor: false }),
    (error) => error instanceof Error &&
      error.message.includes('localExecutor is a Main-only composition option'),
  )
})
