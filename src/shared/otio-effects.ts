import { MAX_OTIO_BYTES, parseOtio, type OtioModel } from './otio-model.ts'

export type ProfileEffect =
  | { profile: 'opacity' | 'volume'; value: number }
  | { profile: 'transform'; x: number; y: number; scale: number }
  | { profile: 'crop'; left: number; top: number; right: number; bottom: number }
  | { profile: 'color'; brightness: number; contrast: number; saturation: number }
  | { profile: 'audioFade'; in: number; out: number }
export interface ProfileTransition { profile: 'dissolve' | 'wiperight'; inOffset: number; outOffset: number; from: string; to: string }
export interface OtioProfile {
  model: OtioModel
  effects: Record<string, ProfileEffect[]>
  transitions: Record<string, ProfileTransition>
  requiresCompositePreview: boolean
  diagnostics: string[]
}
type Obj = Record<string, any>
const obj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
function error(id: string, reason: string): never { throw new Error(`Unsupported OTIO profile at ${id || '/'}: ${reason}`) }
/** Strict, browser-safe compiler front end. Never mutates the authored document. */
export function prepareOtioProfile(text: string): OtioProfile {
  if (text.length > MAX_OTIO_BYTES || new TextEncoder().encode(text).length > MAX_OTIO_BYTES) error('', 'input exceeds size limit')
  const raw = JSON.parse(text), effects: OtioProfile['effects'] = {}, transitions: OtioProfile['transitions'] = {}
  const pending: { id: string; raw: Obj; siblings: Obj[]; index: number; parent: string }[] = []
  const authored = new Map<string, Obj>()
  let count = 0
  function walk(o: unknown, id: string, depth: number, siblings: Obj[] = [], index = 0, parent = '') {
    if (++count > 20000 || depth > 64) error(id, 'structure limit exceeded')
    if (!obj(o)) error(id, 'expected object')
    authored.set(id, o)
    if (o.effects !== undefined) {
      if (!Array.isArray(o.effects)) error(id, 'effects must be an array')
      if (o.effects.length && !/^Clip\.[12]$/.test(o.OTIO_SCHEMA)) error(id, 'Effects only supported on clips')
      effects[id] = o.effects.map((e: unknown): ProfileEffect => {
        if (!obj(e) || e.OTIO_SCHEMA !== 'Effect.1' || !obj(e.metadata) || !obj(e.metadata.shadow)) error(id, 'expected Effect.1 metadata.shadow profile')
        if (e.enabled !== undefined && e.enabled !== true) error(id, 'disabled effects are not supported')
        const p = e.metadata.shadow, name = p.profile
        const fields: Record<string, Record<string, [number, number, number]>> = {
          opacity: { value: [1, 0, 1] }, volume: { value: [1, 0, 16] },
          transform: { x: [0, -2, 2], y: [0, -2, 2], scale: [1, 0.01, 4] },
          crop: { left: [0, 0, 0.99], top: [0, 0, 0.99], right: [0, 0, 0.99], bottom: [0, 0, 0.99] },
          color: { brightness: [0, -1, 1], contrast: [1, 0, 2], saturation: [1, 0, 3] },
          audioFade: { in: [0, 0, 86400], out: [0, 0, 86400] },
        }
        if (typeof name !== 'string' || !Object.hasOwn(fields, name) || e.effect_name !== `shadow.${name}`) error(id, 'unknown effect profile/name')
        const spec = fields[name]!, result: Obj = { profile: name }
        for (const key of Object.keys(p)) if (key !== 'profile' && !Object.hasOwn(spec, key)) error(id, `unknown parameter ${key}`)
        for (const [key, [fallback, min, max]] of Object.entries(spec)) {
          const v = p[key] === undefined ? fallback : p[key]
          if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) error(id, `invalid ${name}.${key}`)
          result[key] = v
        }
        if (name === 'crop' && (result.left + result.right >= 1 || result.top + result.bottom >= 1)) error(id, 'empty crop')
        return result as ProfileEffect
      })
      if (new Set(effects[id]!.map(e => e.profile)).size !== effects[id]!.length) error(id, 'duplicate effect profiles are not supported')
      o.effects = []
    }
    if (o.OTIO_SCHEMA === 'Transition.1') pending.push({ id, raw: o, siblings, index, parent })
    if (o.tracks !== undefined) walk(o.tracks, '/tracks', depth + 1)
    if (Array.isArray(o.children)) o.children.forEach((v: unknown, i: number) => walk(v, `${id}/children/${i}`, depth + 1, o.children, i, id))
  }
  walk(raw, '', 0)
  const model = parseOtio(JSON.stringify(raw))
  const nodesById = new Map(model.nodes.map(n => [n.id, n]))
  for (const n of model.nodes.filter(n => n.kind === 'Track')) {
    let p = n.parentId === null ? undefined : nodesById.get(n.parentId)
    while (p) {
      if (p.kind === 'Track') error(n.id, 'nested Tracks are not supported; use clips in nested Stacks or top-level Tracks')
      p = p.parentId === null ? undefined : nodesById.get(p.parentId)
    }
  }
  const incoming = new Map<string, ProfileTransition>(), outgoing = new Map<string, ProfileTransition>()
  for (const t of pending) {
    const n = nodesById.get(t.id)!, p = t.raw.metadata?.shadow
    const kind = p?.profile ?? 'dissolve'
    if (!((kind === 'dissolve' && t.raw.transition_type === 'SMPTE_Dissolve') || (kind === 'wiperight' && t.raw.transition_type === 'Custom')) || (p !== undefined && (!obj(p) || Object.keys(p).some(k => k !== 'profile')))) error(t.id, 'only SMPTE_Dissolve/dissolve and Custom/wiperight supported; slide/fadeblack are not supported')
    if (!/^Clip\.[12]$/.test(t.siblings[t.index-1]?.OTIO_SCHEMA) || !/^Clip\.[12]$/.test(t.siblings[t.index+1]?.OTIO_SCHEMA)) error(t.id, 'transition requires two adjacent clips')
    if (n.trackKind !== 'Video') error(t.id, 'audio transitions are not supported')
    const a = n.transition!.inOffset, b = n.transition!.outOffset
    if (a.value / a.rate + b.value / b.rate <= 0) error(t.id, 'zero duration transition')
    const from = nodesById.get(`${t.parent}/children/${t.index-1}`)!, to = nodesById.get(`${t.parent}/children/${t.index+1}`)!
    const cut = from.end, inSeconds = a.value/a.rate, outSeconds = b.value/b.rate
    if (!from.enabled || !to.enabled || !n.enabled || Math.abs(cut-to.start) > 1e-8 || Math.abs(n.start-(cut-inSeconds)) > 1e-8 || Math.abs(n.end-(cut+outSeconds)) > 1e-8 || inSeconds > from.end-from.start || outSeconds > to.end-to.start) error(t.id, 'clipped/disabled/overlapping transitions are not supported')
    transitions[t.id] = { profile: kind, inOffset: a.value/a.rate, outOffset: b.value/b.rate, from: `${t.parent}/children/${t.index-1}`, to: `${t.parent}/children/${t.index+1}` }
    incoming.set(transitions[t.id]!.to, transitions[t.id]!)
    outgoing.set(transitions[t.id]!.from, transitions[t.id]!)
  }
  for (const n of model.nodes.filter(n => n.kind === 'Clip')) {
    const touching = [incoming.get(n.id), outgoing.get(n.id)].filter((t): t is ProfileTransition => !!t)
    if (touching.length > 1 && touching.reduce((sum,t) => sum + (t.from === n.id ? t.inOffset : t.outOffset),0) > n.end-n.start) error(n.id, 'overlapping transitions')
  }
  for (const n of model.nodes) for (const e of effects[n.id] ?? []) {
    if ((e.profile === 'audioFade' || e.profile === 'volume') !== (n.trackKind === 'Audio')) error(n.id, 'effect stream mismatch; audio effects require an Audio track')
    if (e.profile === 'audioFade' && e.in + e.out > n.end - n.start) error(n.id, 'audio fades exceed clip duration')
  }
  for (const t of Object.values(transitions)) for (const id of [t.from, t.to]) {
    if ((effects[id] ?? []).some(e => e.profile === 'transform' || e.profile === 'crop' || (e.profile === 'opacity' && e.value !== 1))) error(id, 'transitions require opaque untransformed endpoints; alpha/geometry transition combinations are not supported')
  }
  for (const n of model.nodes.filter(n => n.kind === 'Clip' && n.sourceStart)) {
    const o = authored.get(n.id)!, ref = o.media_references ? o.media_references[o.active_media_reference_key] : o.media_reference
    const r = ref?.available_range
    if (!r) continue
    const before = incoming.get(n.id)?.inOffset ?? 0
    const after = outgoing.get(n.id)?.outOffset ?? 0
    const source = n.sourceStart!.value/n.sourceStart!.rate, lo = r.start_time.value/r.start_time.rate, hi = lo + r.duration.value/r.duration.rate
    if (source-before < lo-1e-8 || source+n.end-n.start+after > hi+1e-8) error(n.id, 'source/transition handles outside media available_range')
  }
  const warnings = model.warnings.filter(w => w !== 'transition-cut')
  if (warnings.length) error('', warnings.join(', '))
  const videoClips = model.nodes.filter(n => n.kind === 'Clip' && n.trackKind === 'Video' && n.enabled && n.end > n.start).sort((a,b) => a.start-b.start)
  let overlap = false, finish = -Infinity
  for (const n of videoClips) { if (n.start < finish-1e-8) overlap = true; finish = Math.max(finish, n.end) }
  // Container extensions cannot prove opacity; conservatively request composition
  // for formats that commonly carry alpha. The decoder remains authoritative.
  const alphaPossible = videoClips.some(n => /\.(?:png|webp|mov|mkv|webm)(?:$|[?#])/i.test(n.targetUrl ?? ''))
  return { model, effects, transitions, requiresCompositePreview: pending.length > 0 || Object.values(effects).some(e => e.length > 0) || overlap || alphaPossible, diagnostics: [] }
}

export const OTIO_PROFILE_VERSION = 1 as const
export const OTIO_PROFILE_EXAMPLES = {
  opacity: { OTIO_SCHEMA: 'Effect.1', effect_name: 'shadow.opacity', metadata: { shadow: { profile: 'opacity', value: 0.5 } } },
  dissolve: { OTIO_SCHEMA: 'Transition.1', transition_type: 'SMPTE_Dissolve', in_offset: { OTIO_SCHEMA: 'RationalTime.1', value: 12, rate: 24 }, out_offset: { OTIO_SCHEMA: 'RationalTime.1', value: 12, rate: 24 } },
  wiperight: { OTIO_SCHEMA: 'Transition.1', transition_type: 'Custom', metadata: { shadow: { profile: 'wiperight' } }, in_offset: { OTIO_SCHEMA: 'RationalTime.1', value: 12, rate: 24 }, out_offset: { OTIO_SCHEMA: 'RationalTime.1', value: 12, rate: 24 } },
} as const
export interface OtioPreviewManifest {
  version: 1; profileVersion: 1; sourceSha256: string; media: string
  start: number; end: number; rate: number; frames: number
}
