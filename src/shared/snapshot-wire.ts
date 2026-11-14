/** Version 1 JSON transport. Instances belong to one authorized resource, never global. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Path = (string | number)[]
export type Change = [Path, Json?]
export type SnapshotWire = { protocol: 'snapshot-v1'; version: string; base?: string; dictionary: string[]; data: Json }

// Tagged nodes make dictionary references unambiguous, even for user-authored arrays/keys.
export function pack(value: Json): { dictionary: string[]; data: Json } {
  const dictionary: string[] = [], indexes = new Map<string, number>()
  function id(text: string) { let index = indexes.get(text); if (index === undefined) { index = dictionary.length; dictionary.push(text); indexes.set(text, index) } return index }
  function visit(node: Json): Json {
    if (typeof node === 'string') return [0, id(node)]
    if (Array.isArray(node)) return [1, ...node.map(visit)]
    if (node !== null && typeof node === 'object') return [2, ...Object.entries(node).map(([key, value]) => [id(key), visit(value)])]
    return node
  }
  return { data: visit(value), dictionary }
}
export function unpack(data: Json, dictionary: string[]): Json {
  function text(index: Json): string { if (typeof index !== 'number' || !Number.isInteger(index) || dictionary[index] === undefined) throw new Error('Invalid snapshot dictionary'); return dictionary[index]! }
  function visit(node: Json): Json {
    if (!Array.isArray(node)) { if (node !== null && typeof node === 'object') throw new Error('Invalid snapshot node'); return node }
    if (node[0] === 0 && node.length === 2) return text(node[1]!)
    if (node[0] === 1) return node.slice(1).map(visit)
    if (node[0] === 2) {
      const result: Record<string, Json> = {}
      for (const pair of node.slice(1)) {
        if (!Array.isArray(pair) || pair.length !== 2) throw new Error('Invalid snapshot field')
        const key = text(pair[0]!)
        if (Object.hasOwn(result, key)) throw new Error('Duplicate snapshot field')
        Object.defineProperty(result, key, { value: visit(pair[1]!), enumerable: true, writable: true, configurable: true })
      }
      return result
    }
    throw new Error('Invalid snapshot tag')
  }
  return visit(data)
}
export function diff(before: Json, after: Json, path: Path = [], changes: Change[] = []): Change[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return changes
  if (before && after && !Array.isArray(before) && !Array.isArray(after) && typeof before === 'object' && typeof after === 'object') {
    for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) changes.push([[...path, key]])
    for (const [key, value] of Object.entries(after)) {
      if (!Object.hasOwn(before, key)) changes.push([[...path, key], value])
      else diff(before[key]!, value, [...path, key], changes)
    }
  } else changes.push([path, after])
  return changes
}
export function applyChanges(before: Json, changes: Change[]): Json {
  let value = structuredClone(before)
  for (const change of changes) {
    const [path] = change
    if (!Array.isArray(path) || path.some(key => typeof key !== 'string' && typeof key !== 'number')) throw new Error('Invalid snapshot path')
    if (!path.length) { if (change.length !== 2) throw new Error('Cannot delete snapshot root'); value = change[1]!; continue }
    let target: any = value
    for (const key of path.slice(0, -1)) {
      if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) throw new Error('Invalid snapshot path')
      target = target[key]
    }
    const key = path.at(-1)!
    if (!target || typeof target !== 'object') throw new Error('Invalid snapshot target')
    if (change.length === 1) delete target[key]
    else Object.defineProperty(target, key, { value: change[1], enumerable: true, configurable: true, writable: true })
  }
  return value
}

/** Keyed collections avoid retransmitting every session on insertion, removal or activity. */
export function keyedWork(value: any): Json {
  return { ...value, sessions: { order: value.sessions.map((session: any) => session.sessionId), entries: Object.fromEntries(value.sessions.map((session: any) => [session.sessionId, session])) } }
}
export function unkeyedWork(value: any): unknown {
  return { ...value, sessions: value.sessions.order.map((id: string) => value.sessions.entries[id]) }
}

export function keyedMaintenance(value: any): Json {
  return { ...value, report: value.report === null ? null : { ...value.report, findings: {
    order: value.report.findings.map((finding: any) => finding.id),
    entries: Object.fromEntries(value.report.findings.map((finding: any) => [finding.id, finding])),
  } } }
}
export function unkeyedMaintenance(value: any): unknown {
  return { ...value, report: value.report === null ? null : { ...value.report, findings: value.report.findings.order.map((id: string) => value.report.findings.entries[id]) } }
}
