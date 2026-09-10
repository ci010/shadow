import { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { readdir, rm, writeFile } from 'node:fs/promises'
import { createTempWorkspace } from '../testing/workspace.ts'
import type { RegistrySnapshotV1 } from './contracts.ts'
import {
  AtomicFileRegistrySnapshotAdapter,
  InMemoryRegistrySnapshotAdapter,
  RegistrySnapshotCoordinator,
  type RegistrySnapshotAdapter,
} from './persistence.ts'
import { InMemoryPairingNodeRegistry } from './registry.ts'

const snapshot: RegistrySnapshotV1 = {
  version: 1,
  createdAt: '2026-08-26T00:00:00.000Z',
  offers: [],
  consumedOfferIds: ['offer-1'],
  pending: [],
  nodes: [],
  capabilities: [],
}

function registrySnapshotAdapterConformance(
  name: string,
  createAdapter: () => RegistrySnapshotAdapter,
): void {
  test(`${name} registry snapshot adapter saves isolated snapshots`, async () => {
    const adapter = createAdapter()
    assertEquals(await adapter.load(), null)
    await adapter.save(snapshot)
    snapshot.consumedOfferIds.push('caller-mutation')

    const firstLoad = await adapter.load() as RegistrySnapshotV1
    assertEquals(firstLoad.consumedOfferIds, ['offer-1'])
    firstLoad.consumedOfferIds.push('loaded-mutation')
    assertEquals((await adapter.load() as RegistrySnapshotV1).consumedOfferIds, ['offer-1'])
  })
}

registrySnapshotAdapterConformance(
  'in-memory',
  () => new InMemoryRegistrySnapshotAdapter(),
)

test('file registry snapshot adapter round-trips and atomically overwrites', async () => {
  const directory = await createTempWorkspace()
  try {
    const adapter = new AtomicFileRegistrySnapshotAdapter(
      `${directory}/cluster/registry.v1.json`,
    )
    assertEquals(await adapter.load(), null)
    await adapter.save(snapshot)
    await adapter.save({
      ...snapshot,
      consumedOfferIds: ['offer-2'],
    })

    assertEquals(
      (await adapter.load() as RegistrySnapshotV1).consumedOfferIds,
      ['offer-2'],
    )
    assertEquals(
      await readdir(`${directory}/cluster`),
      ['registry.v1.json'],
    )
  } finally {
    await rm(directory, { recursive: true })
  }
})

test('file registry snapshot adapter rejects malformed JSON', async () => {
  const directory = await createTempWorkspace()
  try {
    const filePath = `${directory}/registry.v1.json`
    await writeFile(filePath, '{')
    const adapter = new AtomicFileRegistrySnapshotAdapter(filePath)

    let rejected = false
    try {
      await adapter.load()
    } catch (error) {
      rejected = error instanceof SyntaxError
    }
    assertEquals(rejected, true)
  } finally {
    await rm(directory, { recursive: true })
  }
})

test('registry snapshot coordinator restores and serializes current state', async () => {
  const adapter = new InMemoryRegistrySnapshotAdapter()
  await adapter.save(snapshot)
  const registry = new InMemoryPairingNodeRegistry()
  const coordinator = new RegistrySnapshotCoordinator(registry, adapter)

  assertEquals(await coordinator.restore(new Date(snapshot.createdAt)), true)
  registry.createOffer(
    'offer-2',
    new Date('2026-08-26T00:01:00.000Z'),
    new Date('2026-08-26T00:06:00.000Z'),
  )
  await coordinator.save(new Date('2026-08-26T00:01:00.000Z'))
  await coordinator.flush()

  assertEquals(
    (await adapter.load())?.offers.map((offer) => offer.offerId),
    ['offer-2'],
  )
})