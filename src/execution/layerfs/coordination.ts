import { createHash } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

/** null is project-wide; [] is observational. Ref strings are opaque SDK names,
 * never inferred from mount paths. Sources are conservatively reserved too. */
export function operationResources(action: string, a: Record<string, unknown>): string[] | null {
  if (['list', 'branches', 'history', 'status', 'diff'].includes(action)) return []
  let branch: unknown
  if (typeof a.workspace === 'string') {
    try { branch = JSON.parse(Buffer.from(a.workspace.replace(/^layerfs:/, ''), 'base64url').toString()).branch } catch { /* legacy management needs broad exclusion */ }
  }
  let refs: unknown[]
  switch (action) {
    case 'read': case 'write': case 'search': case 'exec': refs = [branch]; break
    case 'branch_workspace': case 'mount': refs = [a.branch]; break
    case 'fork': case 'load': refs = [a.branch, a.ref ?? 'main']; break
    case 'merge': refs = [a.ref, a.branch, a.name]; break
    case 'publish': refs = [a.branch, 'main']; break
    default: return null
  }
  if (refs.some(ref => typeof ref !== 'string' || !ref)) return null
  return [...new Set(refs as string[])].sort()
}
export function resourceJournal(base: string, resource: string): string {
  return base + '.resources/' + createHash('sha256').update(resource).digest('hex') + '.jsonl'
}

/** Release only after child exit and a validated settled receipt. SQLite's
 * process lock is crash-released; reservation rows are intentionally durable.
 * File removal occurs under the same transaction, before allowing a new owner. */
export function releaseReservation(database: string, owner: string, journals: string[]): void {
  const db = new DatabaseSync(database)
  try {
    db.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE')
    const rows = db.prepare('SELECT journal FROM reservations WHERE owner = ?').all(owner) as { journal: string }[]
    if (rows.length !== journals.length || rows.some(row => !journals.includes(row.journal))) throw Error('Reservation owner/paths mismatch')
    for (const journal of journals) unlinkSync(journal)
    db.prepare('DELETE FROM reservations WHERE owner = ?').run(owner)
    db.exec('COMMIT')
  } finally { db.close() }
}

export const coordinationRunner = String.raw`
async function reserveResources() {
 if (!a.coordination || !a.owner || !Array.isArray(a.journals)) throw Error('Missing durable resource reservation');
 await mkdir(dirname(a.coordination), {recursive:true});
 const db = new DatabaseSync(a.coordination);
 try {
  db.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS reservations (resource TEXT PRIMARY KEY, owner TEXT NOT NULL, journal TEXT NOT NULL, project TEXT NOT NULL, action TEXT NOT NULL); BEGIN IMMEDIATE');
  const rows = db.prepare('SELECT resource, project FROM reservations').all();
  if(rows.some(row=>row.project!==project)) throw Object.assign(Error('Coordination namespace mismatch; no SDK dispatch'), {code:'Busy',shadowRefusal:true});
  const keys = a.resources === null ? ['*'] : a.resources.map(ref=>'branch:'+ref);
  if (rows.some(row => row.resource === '*' || keys.includes('*') || keys.includes(row.resource))) throw Object.assign(Error('LayerFS resource busy or unreconciled; inspect retained journals, never replay or discard'), {code:'Busy',shadowRefusal:true});
  // Pre-migration project journals remain an explicit broad quarantine.
  try { await stat(a.projectJournal); throw Object.assign(Error('Legacy project journal requires reconciliation'), {code:'Busy',shadowRefusal:true}); } catch(e) { if(e.code !== 'ENOENT') throw e; }
  for (let i=0;i<keys.length;i++) db.prepare('INSERT INTO reservations VALUES (?, ?, ?, ?, ?)').run(keys[i], a.owner, a.journals[i], project, action);
  db.exec('COMMIT');
 } catch(e) {
  if (String(e.code).includes('SQLITE') || /database is locked/.test(e.message)) throw Object.assign(Error('LayerFS admission busy; no SDK dispatch'), {code:'Busy',shadowRefusal:true});
  throw e;
 } finally { db.close(); }
}
`;
