import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Project-local aggregate; no session identifiers or Skill content are stored. */
export class SkillRecallStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
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
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  record(path: string): void {
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
