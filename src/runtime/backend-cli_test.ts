import { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import {
  attachBackendSignalHandlers,
  type BackendProcessHooks,
  type BackendSignal,
  parseBackendCliArguments,
} from './backend-cli.ts'

test('backend CLI uses the first positional process argument as config path', () => {
  assertEquals(
    parseBackendCliArguments([process.execPath, 'src/index.ts', 'custom.json']),
    { configPath: 'custom.json' },
  )
})

test('backend CLI ignores runtime-injected flags in the config position', () => {
  assertEquals(
    parseBackendCliArguments([
      'shadow',
      'src/index.ts',
      '--runtime',
      'ignored-runtime-value',
    ]),
    { configPath: undefined },
  )
})

test('backend CLI allows the default config lookup', () => {
  assertEquals(parseBackendCliArguments([process.execPath, 'src/index.ts']), {
    configPath: undefined,
  })
})

test('backend CLI signals shut down before exiting and can be detached', async () => {
  const listeners = new Map<BackendSignal, () => void>()
  const exits: number[] = []
  let shutdowns = 0
  const hooks: BackendProcessHooks = {
    argv: [],
    on: (signal, listener) => listeners.set(signal, listener),
    off: (signal, listener) => {
      if (listeners.get(signal) === listener) listeners.delete(signal)
    },
    exit: (code) => exits.push(code),
  }
  const detach = attachBackendSignalHandlers(
    {
      shutdown: () => {
        shutdowns++
        return Promise.resolve()
      },
    },
    hooks,
    { includeSigterm: true },
  )

  listeners.get('SIGTERM')?.()
  await Promise.resolve()
  assertEquals(shutdowns, 1)
  assertEquals(exits, [0])

  detach()
  assertEquals(listeners.size, 0)
})

test('backend CLI maps shutdown failure to exit one', async () => {
  let listener: (() => void) | undefined
  const exits: number[] = []
  attachBackendSignalHandlers(
    { shutdown: () => Promise.reject(new Error('shutdown failed')) },
    {
      argv: [],
      on: (_signal, nextListener) => listener = nextListener,
      off: () => {},
      exit: (code) => exits.push(code),
    },
    { includeSigterm: false },
  )

  listener?.()
  await Promise.resolve()
  await Promise.resolve()
  assertEquals(exits, [1])
})

test('backend CLI can register SIGINT without unsupported SIGTERM', () => {
  const signals: BackendSignal[] = []
  attachBackendSignalHandlers(
    { shutdown: () => Promise.resolve() },
    {
      argv: [],
      on: (signal) => signals.push(signal),
      off: () => {},
      exit: () => {},
    },
    { includeSigterm: false },
  )

  assertEquals(signals, ['SIGINT'])
})
