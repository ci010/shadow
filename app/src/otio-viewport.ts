export interface OtioWindow { start: number; span: number }

export function fitOtioWindow(duration: number): OtioWindow {
  return { start: 0, span: Math.max(0, duration) }
}

/** Wheel deltas are normalized to CSS pixels before entering this function. */
export function wheelOtioWindow(view: OtioWindow, duration: number, rate: number, delta: number, anchor: number | null): OtioWindow {
  if (!(duration > 0) || !Number.isFinite(delta)) return fitOtioWindow(duration)
  const minimum = Math.min(duration, rate > 0 ? 1 / rate : 0.001)
  const span = Math.max(minimum, Math.min(duration, view.span))
  if (anchor === null) return { span, start: Math.max(0, Math.min(duration - span, view.start + delta * span / 800)) }
  const ratio = Math.max(0, Math.min(1, anchor))
  const next = Math.max(minimum, Math.min(duration, span * Math.exp(Math.max(-1, Math.min(1, delta * 0.002)))))
  return { span: next, start: Math.max(0, Math.min(duration - next, view.start + ratio * (span - next))) }
}
