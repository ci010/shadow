import { createHash } from 'node:crypto'
import { readFileSync, statSync, unlinkSync } from 'node:fs'
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

// Keep reservations' existing five-column layout: the operation ledger is an
// independent durable record, NOT a reinterpretation/deletion of old resources.
const ledgerSchema = `CREATE TABLE IF NOT EXISTS coordination_operations (
 owner TEXT PRIMARY KEY, project TEXT NOT NULL, action TEXT NOT NULL,
 resources TEXT NOT NULL, journals TEXT NOT NULL,
 phase TEXT NOT NULL CHECK (phase IN ('reserved','settled','released')),
 evidence TEXT, receipt TEXT, created_at TEXT NOT NULL, settled_at TEXT, released_at TEXT
)`
interface OperationRow {
  owner: string; project: string; action: string; resources: string; journals: string
  phase: 'reserved' | 'settled' | 'released'; evidence: string | null; receipt: string | null
  created_at: string; settled_at: string | null; released_at: string | null
}
export interface ReservationSnapshot {
  owner: string; project: string; action: string; resources: string[]; journals: string[]
  phase: OperationRow['phase']
  /** Null means absent, never proof of no SDK dispatch. */
  evidence: { journal: string; text: string | null }[]
  retainedEvidence: { journal: string; text: string | null }[] | null
  receipt: unknown
  fingerprint: string
}
function readJournal(journal: string): string | null {
  try {
    if (statSync(journal).size > 1024 * 1024) throw Error('Oversized coordination evidence; inspect without releasing')
    return readFileSync(journal, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
function operation(db: DatabaseSync, owner: string): OperationRow {
  const row = db.prepare('SELECT * FROM coordination_operations WHERE owner = ?').get(owner) as unknown as OperationRow | undefined
  if (!row) throw Error('Reservation has no durable operation evidence; legacy/unknown ownership requires separate investigation')
  return row
}
function pathsMatch(actual: string[], expected: string[]): boolean {
  return expected.length > 0 && new Set(expected).size === expected.length && actual.length === expected.length && actual.every(path => expected.includes(path))
}
function snapshot(db: DatabaseSync, owner: string): ReservationSnapshot {
  const row = operation(db, owner)
  const journals = JSON.parse(row.journals) as string[], resources = JSON.parse(row.resources) as string[]
  const rows = db.prepare('SELECT resource, journal, project, action FROM reservations WHERE owner = ? ORDER BY resource').all(owner) as { resource: string; journal: string; project: string; action: string }[]
  if (row.phase !== 'released' && (!pathsMatch(rows.map(r => r.journal), journals) || rows.some(r => r.project !== row.project || r.action !== row.action) || !pathsMatch(rows.map(r => r.resource), resources))) throw Error('Reservation owner/paths mismatch')
  if (row.phase === 'released' && rows.length) throw Error('Released operation still owns reservations; inspect database')
  const evidence = journals.map(journal => ({ journal, text: readJournal(journal) }))
  const state = { owner, project: row.project, action: row.action, resources, journals, phase: row.phase, evidence,
    retainedEvidence: row.evidence === null ? null : JSON.parse(row.evidence), receipt: row.receipt === null ? null : JSON.parse(row.receipt) }
  return { ...state, fingerprint: createHash('sha256').update(JSON.stringify([row, rows, evidence])).digest('hex') }
}

/** Observational only. Missing journals remain inspectable because reservation
 * identity and the pre-dispatch phase were committed in the SAME SQLite txn. */
export function inspectReservation(database: string, owner: string): ReservationSnapshot {
  const db = new DatabaseSync(database, { readOnly: true })
  try { db.exec('BEGIN'); return snapshot(db, owner) } finally { db.close() }
}

function receiptJSON(receipt: unknown): string {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw Error('A verified settlement receipt is required')
  const text = JSON.stringify(receipt)
  if (Buffer.byteLength(text) > 1024 * 1024) throw Error('Oversized settlement receipt')
  return text
}
function validateJournalOwners(state: ReservationSnapshot): void {
  for (const { text } of state.evidence) {
    if (text === null) continue
    for (const line of text.split('\n').filter(Boolean)) {
      const entry = JSON.parse(line)
      if (entry.owner !== state.owner || entry.project !== state.project || entry.action !== state.action || typeof entry.phase !== 'string') throw Error('Journal ownership/evidence mismatch; no release')
    }
  }
}
function markSettled(db: DatabaseSync, state: ReservationSnapshot, receipt: string): void {
  db.prepare("UPDATE coordination_operations SET phase = 'settled', evidence = ?, receipt = ?, settled_at = ? WHERE owner = ? AND phase = 'reserved'")
    .run(JSON.stringify(state.evidence), receipt, new Date().toISOString(), state.owner)
}

/** Called under an IMMEDIATE transaction only AFTER settled evidence is durable.
 * Crash before/during unlink: rows still exclude every resource and the ledger
 * retains every journal byte + receipt. Crash after COMMIT: released history
 * remains. A new owner cannot create a journal during cleanup. */
function retireSettled(db: DatabaseSync, state: ReservationSnapshot): void {
  if (state.phase !== 'settled' || state.receipt === null || !state.retainedEvidence) throw Error('No durable settlement; no release')
  if (!pathsMatch(state.retainedEvidence.map(e => e.journal), state.journals)) throw Error('Retained evidence paths mismatch')
  for (const current of state.evidence) {
    const retained = state.retainedEvidence.find(e => e.journal === current.journal)!
    if (current.text !== null && current.text !== retained.text) throw Error('Journal changed after settlement; no release')
  }
  for (const { journal, text } of state.evidence) if (text !== null) unlinkSync(journal)
  db.prepare('DELETE FROM reservations WHERE owner = ?').run(state.owner)
  db.prepare("UPDATE coordination_operations SET phase = 'released', released_at = ? WHERE owner = ?").run(new Date().toISOString(), state.owner)
}

/** Host-only boundary: caller MUST have validated the settled domain receipt
 * AND observed child exit. Optional fourth argument retains that exact receipt;
 * the three-argument bridge records its existing caller attestation instead.
 * This is not a reconcile/clear-lock API and refuses a previous settled attempt.
 * No SDK calls or resource deletion occur here (only owned coordination files). */
export function releaseReservation(database: string, owner: string, journals: string[], receipt: unknown = { kind: 'caller-confirmed-settled-process-receipt' }): void {
  const encodedReceipt = receiptJSON(receipt)
  const db = new DatabaseSync(database)
  try {
    db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE')
    // Preserve the previous mismatch diagnostic, even for a nonexistent owner.
    const rows = db.prepare('SELECT journal FROM reservations WHERE owner = ?').all(owner) as { journal: string }[]
    if (!pathsMatch(rows.map(row => row.journal), journals)) throw Error('Reservation owner/paths mismatch')
    const state = snapshot(db, owner)
    if (state.phase !== 'reserved') throw Error('Settlement already attempted; inspect and reconcile, never blindly retry')
    if (state.evidence.some(e => e.text === null)) throw Error('Missing admitted journal; inspect and reconcile')
    validateJournalOwners(state)
    markSettled(db, state, encodedReceipt)
    db.exec('COMMIT') // Evidence and receipt survive all subsequent file removal.
    db.exec('BEGIN IMMEDIATE')
    retireSettled(db, snapshot(db, owner))
    db.exec('COMMIT')
  } finally { db.close() }
}

export type ReconciliationDecision =
  | { ownerInactive: true; outcome: 'settled'; receipt: Record<string, unknown> }
  | { ownerInactive: true; outcome: 'not-dispatched'; receipt: Record<string, unknown> }
  | { ownerInactive: true; outcome: 'retire-settled' }

/** Internal host API, not tool arguments. verify must establish inactive process/
 * daemon ownership and a domain-specific outcome from authoritative evidence;
 * missing files, elapsed time, a PID alone, or operator flags are NOT sufficient.
 * The exact inspection fingerprint gates the decision and is rechecked after
 * asynchronous verification, under the same admission lock used by the runner.
 * Unknown/active outcomes have no decision variant and retain all reservations.
 * Old rows without a ledger are intentionally not auto-reconciled. */
export async function reconcileReservation(database: string, owner: string, expectedFingerprint: string,
  verify: (state: Readonly<ReservationSnapshot>) => Promise<ReconciliationDecision>): Promise<ReservationSnapshot> {
  const before = inspectReservation(database, owner)
  if (before.fingerprint !== expectedFingerprint || before.phase === 'released') throw Error('Reconciliation snapshot changed or is already released')
  const decision = await verify(structuredClone(before))
  if (!decision || decision.ownerInactive !== true || !['settled', 'not-dispatched', 'retire-settled'].includes(decision.outcome)) throw Error('Authoritative inactive-owner verification required; no release')
  const db = new DatabaseSync(database)
  try {
    db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE')
    const current = snapshot(db, owner)
    if (current.fingerprint !== expectedFingerprint) throw Error('Reconciliation evidence changed; inspect again')
    if (decision.outcome === 'retire-settled') {
      if (current.phase !== 'settled') throw Error('No settled receipt to reconcile')
    } else {
      if (current.phase !== 'reserved') throw Error('Settlement already recorded; cannot replace receipt')
      validateJournalOwners(current)
      if (decision.outcome === 'not-dispatched' && current.evidence.some(e => e.text?.split('\n').filter(Boolean).some(line => JSON.parse(line).phase !== 'admitted'))) throw Error('Dispatch evidence exists; cannot reconcile as not-dispatched')
      markSettled(db, current, receiptJSON({ outcome: decision.outcome, verification: JSON.parse(receiptJSON(decision.receipt)) }))
    }
    db.exec('COMMIT')
    db.exec('BEGIN IMMEDIATE')
    retireSettled(db, snapshot(db, owner))
    db.exec('COMMIT')
    return snapshot(db, owner)
  } finally { db.close() }
}

export const coordinationRunner = String.raw`
async function reserveResources() {
 if (!a.coordination || !a.owner || !Array.isArray(a.journals)) throw Error('Missing durable resource reservation');
 await mkdir(dirname(a.coordination), {recursive:true});
 const db = new DatabaseSync(a.coordination);
 try {
  db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS reservations (resource TEXT PRIMARY KEY, owner TEXT NOT NULL, journal TEXT NOT NULL, project TEXT NOT NULL, action TEXT NOT NULL);');
  db.exec(${JSON.stringify(ledgerSchema)});
  db.exec('BEGIN IMMEDIATE');
  const rows = db.prepare('SELECT resource, project FROM reservations').all();
  if(rows.some(row=>row.project!==project)) throw Object.assign(Error('Coordination namespace mismatch; no SDK dispatch'), {code:'Busy',shadowRefusal:true});
  const keys = a.resources === null ? ['*'] : a.resources.map(ref=>'branch:'+ref);
  if (!keys.length || new Set(keys).size !== keys.length || a.journals.length !== keys.length || new Set(a.journals).size !== keys.length || a.journals.some(path=>typeof path!=='string' || !path)) throw Error('Invalid reservation resource/journal set');
  if (rows.some(row => row.resource === '*' || keys.includes('*') || keys.includes(row.resource))) throw Object.assign(Error('LayerFS resource busy or unreconciled; inspect retained journals, never replay or discard'), {code:'Busy',shadowRefusal:true});
  // Old project/resource journals remain quarantine, even without SQLite rows.
  for (const path of new Set([a.projectJournal, ...a.journals])) {
   try { await stat(path); throw Object.assign(Error('Existing operation journal requires reconciliation'), {code:'Busy',shadowRefusal:true}); } catch(e) { if(e.code !== 'ENOENT') throw e; }
  }
  // Durable pre-dispatch evidence is atomic with ALL reservations. Journal
  // creation is later, but a crash there cannot leave an unexplained owner.
  db.prepare("INSERT INTO coordination_operations (owner,project,action,resources,journals,phase,created_at) VALUES (?,?,?,?,?,'reserved',?)")
    .run(a.owner, project, action, JSON.stringify(keys), JSON.stringify(a.journals), new Date().toISOString());
  for (let i=0;i<keys.length;i++) db.prepare('INSERT INTO reservations VALUES (?, ?, ?, ?, ?)').run(keys[i], a.owner, a.journals[i], project, action);
  db.exec('COMMIT');
 } catch(e) {
  if (String(e.code).includes('SQLITE') || /database is locked/.test(e.message)) throw Object.assign(Error('LayerFS admission busy; no SDK dispatch'), {code:'Busy',shadowRefusal:true});
  throw e;
 } finally { db.close(); }
}
`;
