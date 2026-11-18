import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Project-local aggregate; no session identifiers or Skill content are stored. */
export class SkillRecallStore {
  private readonly db: DatabaseSync

  constructor(path: string, legacyPath?: string, private readonly indexedRecord?: (path: string) => void) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    try {
      this.db.exec(`
        PRAGMA busy_timeout = 3000;
        CREATE TABLE IF NOT EXISTS skill_recall (
          skill_path TEXT PRIMARY KEY,
          reads INTEGER NOT NULL
        );
      `)
      if (legacyPath && existsSync(legacyPath)) {
        const legacy = new DatabaseSync(legacyPath, { readOnly: true })
        try {
          this.db.exec('CREATE TABLE IF NOT EXISTS recall_migration (name TEXT PRIMARY KEY); BEGIN IMMEDIATE')
          try {
            if (this.db.prepare('INSERT OR IGNORE INTO recall_migration VALUES (?)').run('legacy-skill-v1').changes) {
              const insert = this.db.prepare(`INSERT INTO skill_recall VALUES (?,?)
                ON CONFLICT(skill_path) DO UPDATE SET reads=reads+excluded.reads`)
              for (const row of legacy.prepare('SELECT skill_path, reads FROM skill_recall').iterate()) insert.run(row.skill_path!, row.reads!)
            }
            this.db.exec('COMMIT')
          } catch (error) { this.db.exec('ROLLBACK'); throw error }
        } finally { legacy.close() }
      }
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  record(path: string): void {
    if (this.indexedRecord) return this.indexedRecord(path)
    this.db.prepare(`INSERT INTO skill_recall VALUES (?, 1)
      ON CONFLICT(skill_path) DO UPDATE SET reads = reads + 1`).run(path)
  }

  render(): string {
    const rows = this.db.prepare('SELECT skill_path, reads FROM skill_recall ORDER BY reads DESC, skill_path').all()
    return ['Successful Skill body reads (since tracking began; excludes continuation pages):',
      ...rows.map(row => `${row.reads}\t${JSON.stringify(row.skill_path)}`),
      ...(rows.length ? [] : ['No Skill body reads recorded.']),
    ].join('\n')
  }

  close(): void { this.db.close() }
}
