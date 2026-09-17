import { parseArgs } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { JsonlSessionStore } from '../src/sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../src/sessions/session-store-sqlite.ts'
import { OtelStore } from '../src/otel/store.ts'
import { createSessionDiagnosis, parseDiagnosisQuery } from '../src/sessions/diagnosis.ts'

const { values } = parseArgs({
  options: {
    'sessions-dir': { type: 'string' },
    storage: { type: 'string', default: 'jsonl' },
    'otel-db': { type: 'string' },
    project: { type: 'string' },
    session: { type: 'string' },
    physical: { type: 'string' },
    view: { type: 'string', default: 'summary' },
    offset: { type: 'string', default: '0' },
    limit: { type: 'string', default: '200' },
    'span-before': { type: 'string' },
    'text-limit': { type: 'string' },
    out: { type: 'string' },
  },
})
if (!values['sessions-dir'] || !values.session) {
  throw new Error('Usage: node --import tsx scripts/diagnose-session.ts --sessions-dir <project .sessions> --session <logical ID> [--storage jsonl|sqlite] [--otel-db <path>] [--project <id>] [--view summary|full] [--out <new file>]')
}
if (values.storage !== 'jsonl' && values.storage !== 'sqlite') throw new Error('storage must be jsonl or sqlite')
const params = new URLSearchParams({ view: values.view, recordOffset: values.offset, recordLimit: values.limit })
if (values.physical) params.set('physicalId', values.physical)
if (values['span-before']) params.set('spanBeforeId', values['span-before'])
if (values['text-limit']) params.set('textLimit', values['text-limit'])
const query = parseDiagnosisQuery(params)
const store = values.storage === 'sqlite'
  ? new SqliteSessionStore(resolve(values['sessions-dir']), { readOnly: true })
  : new JsonlSessionStore(resolve(values['sessions-dir']))
let otel: OtelStore | undefined
try {
  if (values['otel-db']) otel = new OtelStore(resolve(values['otel-db']), { readOnly: true })
  const diagnosis = await createSessionDiagnosis({
    projectId: values.project,
    getState: id => store.getState(id),
    readRecords: id => store.readSessionLog(id),
    querySpans: otel ? query => otel!.querySessionSpans(query) : undefined,
  }, values.session, query)
  const json = JSON.stringify(diagnosis, null, 2) + '\n'
  if (values.out) {
    await writeFile(resolve(values.out), json, { flag: 'wx', mode: 0o600 })
    console.error(`Wrote ${Buffer.byteLength(json)} bytes. Review redaction and completeness before sharing.`)
  } else process.stdout.write(json)
} finally {
  otel?.close()
  if (store instanceof SqliteSessionStore) store.close()
}
