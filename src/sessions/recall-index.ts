import { randomUUID } from 'node:crypto'
import { appendFileSync, createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { DatabaseSync } from 'node:sqlite'
import { setImmediate } from 'node:timers/promises'

import type { RecallOrigin } from './recall-origin.ts'

type Kind = 'skill' | 'active' | 'automatic'
interface Event { id: string; day: string; entry: string; source: Kind; version?: 2; origin?: RecallOrigin }

/** A metadata-only rebuild source. The UI and virtual mounts never read it. */
export class RecallIndex {
  constructor(private db: DatabaseSync, private journal?: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS skill_recall (skill_path TEXT PRIMARY KEY, reads INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_recall (day TEXT NOT NULL, entry TEXT NOT NULL, source TEXT NOT NULL,
        reads INTEGER NOT NULL, PRIMARY KEY(day,entry,source));
      CREATE TABLE IF NOT EXISTS recall_event (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS skill_recall_v2 (skill_path TEXT PRIMARY KEY, reads INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_recall_v2 (day TEXT NOT NULL, entry TEXT NOT NULL, source TEXT NOT NULL,
        reads INTEGER NOT NULL, PRIMARY KEY(day,entry,source));
      CREATE TABLE IF NOT EXISTS recall_cursor (id INTEGER PRIMARY KEY CHECK(id=1), offset INTEGER NOT NULL);`)
  }
  record(entry: string, source: Kind, origin: RecallOrigin = 'unknown') {
    const event: Event = { id: randomUUID(), entry, source, version: 2, origin, day: new Date().toISOString().slice(0, 10) }
    // Leading separator isolates an interrupted previous append; no prompt or arguments enter this file.
    if (this.journal) appendFileSync(this.journal, `\n${JSON.stringify(event)}\n`, { mode: 0o600 })
    this.apply(event)
  }
  private apply(event: Event) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (this.db.prepare('INSERT OR IGNORE INTO recall_event VALUES (?)').run(event.id).changes) {
        const suffix = event.version === 2 && event.origin === 'conversation' ? '_v2' : ''
        // Legacy/unknown records remain available in the original tables, never in the corrected projection.
        if (event.version === 2 && event.origin === 'excluded') { this.db.exec('COMMIT'); return }
        if (event.source === 'skill') this.db.prepare(`INSERT INTO skill_recall${suffix} VALUES (?,1)
          ON CONFLICT(skill_path) DO UPDATE SET reads=reads+1`).run(event.entry)
        else this.db.prepare(`INSERT INTO memory_recall${suffix} VALUES (?,?,?,1)
          ON CONFLICT(day,entry,source) DO UPDATE SET reads=reads+1`).run(event.day, event.entry, event.source)
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  async replay(stopped: () => boolean) {
    if (!this.journal || !existsSync(this.journal) || stopped()) return
    let offset = Number(this.db.prepare('SELECT offset FROM recall_cursor WHERE id=1').get()?.offset ?? 0)
    const initialOffset = offset
    const stream = createReadStream(this.journal, { start: offset })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    const checkpoint = this.db.prepare('INSERT OR REPLACE INTO recall_cursor VALUES (1,?)')
    try {
      let count = 0
      for await (const line of lines) {
        if (stopped()) return
        offset += Buffer.byteLength(line) + 1
        if (!line) continue
        let event: Event
        try { event = JSON.parse(line) } catch { continue }
        if (!event || !['skill', 'active', 'automatic'].includes(event.source) || typeof event.entry !== 'string'
          || typeof event.id !== 'string' || typeof event.day !== 'string') continue
        this.apply(event)
        // Checkpoint only immediately before yielding; inserts are idempotent on crash.
        if (++count % 256 === 0) { checkpoint.run(offset); await setImmediate() }
      }
      if (!stopped()) checkpoint.run(Math.min(offset, stream.bytesRead + initialOffset))
    } finally { lines.close(); stream.destroy() }
  }
  usageSummary(complete: boolean) {
    return {
      skills: this.db.prepare('SELECT skill_path AS entry, reads FROM skill_recall_v2 ORDER BY reads DESC, entry LIMIT 100').all()
        .map(row => ({ entry: String(row.entry), reads: Number(row.reads) })),
      memory: this.memorySummary().flatMap(row => row.source === 'active' || row.source === 'automatic'
        ? [{ entry: String(row.entry), source: row.source as 'active' | 'automatic', reads: Number(row.reads) }] : []),
      coverage: complete ? 'complete' as const : 'partial' as const,
    }
  }
  memorySummary() {
    return this.db.prepare(`SELECT entry,source,sum(reads) AS reads FROM memory_recall_v2 GROUP BY entry,source
      ORDER BY reads DESC,entry,source LIMIT 100`).all()
  }
}
