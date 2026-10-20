/** Type-only SDK. Import with `import type` — no runtime imports or capabilities. */
export type ProcessorEvent = { type: string; data: Record<string, unknown> }
/** Host clock and partition-local JSON state. Return state to replace it; omission retains it. */
/** Available only on the second run of an independently reviewed observation classifier. Unknown is host-dropped. */
export type Classification = {label:'ignore'|'buffer'|'semanticwake'|'unknown';confidence:number}
export type ProcessorInput = { classification?: Classification; event: ProcessorEvent; state: Record<string, unknown> | null; now: number }
export type ProcessorDecision = { action: 'ignore' | 'buffer' | 'emit'; classify?: boolean; state?: Record<string, unknown> | null; semantic?: {type:string;data:Record<string,unknown>} }
export type Processor = (input: ProcessorInput) => ProcessorDecision | Promise<ProcessorDecision>
