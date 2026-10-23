import assert, { deepEqual as assertEquals, throws as assertThrows } from 'node:assert/strict'
import { test } from 'node:test'
import {
  BootstrapConfigError,
  parseBootstrapConfigV1,
} from './bootstrap-config.ts'

test('bootstrap config normalizes valid Main and Child values', () => {
  assertEquals(
    parseBootstrapConfigV1({
      version: 1,
      mode: 'main',
      dataDir: '  C:\\shadow-data  ',
      localNodeId: '  node-main  ',
    }),
    {
      version: 1,
      mode: 'main',
      dataDir: 'C:\\shadow-data',
      localNodeId: 'node-main',
    },
  )

  assertEquals(
    parseBootstrapConfigV1({
      version: 1,
      mode: 'child',
      dataDir: '/var/lib/shadow-node',
      localNodeId: ' node-child ',
      mainEndpoint: ' https://main.example.test/base/ ',
    }),
    {
      version: 1,
      mode: 'child',
      dataDir: '/var/lib/shadow-node',
      localNodeId: 'node-child',
      mainEndpoint: 'https://main.example.test/base',
    },
  )
})

test('insecure local transport is an explicit Child-only setting', () => {
  assertEquals(
    parseBootstrapConfigV1({
      version: 1,
      mode: 'child',
      dataDir: './state',
      localNodeId: 'child-node',
      mainEndpoint: 'http://main.local:3123',
      allowInsecureLocalTransport: true,
    }),
    {
      version: 1,
      mode: 'child',
      dataDir: './state',
      localNodeId: 'child-node',
      mainEndpoint: 'http://main.local:3123',
      allowInsecureLocalTransport: true,
    },
  )
  assertThrows(
    () =>
      parseBootstrapConfigV1({
        version: 1,
        mode: 'main',
        dataDir: './state',
        localNodeId: 'main-node',
        allowInsecureLocalTransport: true,
      }),
    (error) => error instanceof BootstrapConfigError &&
      error.message.includes('only valid when mode is "child"'),
  )
})

test('Child workdirs are strict, absolute, and Child-only', () => {
  const rootPath = process.platform === 'win32'
    ? 'C:\\Folders\\alpha'
    : '/folders/alpha'
  assertEquals(
    parseBootstrapConfigV1({
      version: 1,
      mode: 'child',
      dataDir: './state',
      localNodeId: 'child-node',
      mainEndpoint: 'https://main.example.test',
      workdirs: [{
        capabilityId: 'workdir-alpha',
        rootPath,
        displayName: 'Alpha folder',
      }],
    }),
    {
      version: 1,
      mode: 'child',
      dataDir: './state',
      localNodeId: 'child-node',
      mainEndpoint: 'https://main.example.test',
      workdirs: [{
        capabilityId: 'workdir-alpha',
        rootPath,
        displayName: 'Alpha folder',
      }],
    },
  )
  for (
    const workdirs of [
      [{
        capabilityId: 'workdir-alpha',
        rootPath: './relative',
        displayName: 'Alpha',
      }],
      [
        { capabilityId: 'duplicate', rootPath, displayName: 'First' },
        { capabilityId: 'duplicate', rootPath, displayName: 'Second' },
      ],
      [{
        capabilityId: 'workdir-alpha',
        rootPath,
        displayName: 'Alpha',
        extra: true,
      }],
      [{ capabilityId: 'process-execute', rootPath, displayName: 'Reserved' }],
    ]
  ) {
    assertThrows(
      () =>
        parseBootstrapConfigV1({
          version: 1,
          mode: 'child',
          dataDir: './state',
          localNodeId: 'child-node',
          mainEndpoint: 'https://main.example.test',
          workdirs,
        }),
      BootstrapConfigError,
    )
  }
  assertThrows(
    () =>
      parseBootstrapConfigV1({
        version: 1,
        mode: 'main',
        dataDir: './state',
        localNodeId: 'main-node',
        workdirs: [],
      }),
    (error) => error instanceof BootstrapConfigError &&
      error.message.includes('workdirs is only valid when mode is "child"'),
  )
})

test('bootstrap config rejects malformed and unsupported data', () => {
  assertThrows(
    () =>
      parseBootstrapConfigV1({
        version: 2,
        mode: 'other',
        dataDir: ' ',
        localNodeId: 42,
        extra: true,
      }),
    (error) => {
      assert(error instanceof BootstrapConfigError)
      assertEquals(error.issues, [
        'unknown field "extra"',
        'version must be 1',
        'mode must be "main" or "child"',
        'dataDir must be a non-empty string',
        'localNodeId must be a non-empty string',
      ])
      return true
    },
  )
})

test('bootstrap config rejects role-incompatible fields', () => {
  assertThrows(
    () =>
      parseBootstrapConfigV1({
        version: 1,
        mode: 'main',
        dataDir: './data',
        localNodeId: 'main-node',
        mainEndpoint: 'https://not-used.example.test',
      }),
    (error) => error instanceof BootstrapConfigError &&
      error.message.includes('mainEndpoint is only valid when mode is "child"'),
  )

  assertThrows(
    () =>
      parseBootstrapConfigV1({
        version: 1,
        mode: 'child',
        dataDir: './data',
        localNodeId: 'child-node',
      }),
    (error) => error instanceof BootstrapConfigError &&
      error.message.includes('mainEndpoint must be a non-empty string'),
  )
})

test('bootstrap config rejects unsafe or non-http Main endpoints', () => {
  for (
    const mainEndpoint of [
      'file:///tmp/main',
      'https://user:secret@main.example.test',
      'https://main.example.test?token=secret',
    ]
  ) {
    assertThrows(
      () =>
        parseBootstrapConfigV1({
          version: 1,
          mode: 'child',
          dataDir: './data',
          localNodeId: 'child-node',
          mainEndpoint,
        }),
      BootstrapConfigError,
    )
  }
})
