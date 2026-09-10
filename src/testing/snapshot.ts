import { basename, dirname, join } from 'node:path'
import { snapshot } from 'node:test'

snapshot.setResolveSnapshotPath((testPath) => {
  if (!testPath) throw new Error('Snapshot test must have a file path')
  return join(dirname(testPath), '__snapshots__', `${basename(testPath)}.snap`)
})
// Keep prompts and wire payloads readable rather than JSON-escaped.
snapshot.setDefaultSnapshotSerializers([(value) => String(value).replace(/\r\n/g, '\n')])
