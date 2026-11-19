export function byteRange(value: string | null, size: number):
  { start: number; end: number } | 'unsatisfiable' | undefined {
  if (!value) return undefined
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim())
  // Unsupported units, malformed ranges and multi-range requests receive the full representation.
  if (!match || (!match[1] && !match[2])) return undefined
  const start = match[1] ? BigInt(match[1]) : undefined
  const end = match[2] ? BigInt(match[2]) : undefined
  if (start !== undefined && end !== undefined && end < start) return undefined
  if (size === 0 || (start !== undefined && start >= size) ||
    (start === undefined && end === 0n)) return 'unsatisfiable'
  return start === undefined
    ? { start: end! >= size ? 0 : size - Number(end), end: size - 1 }
    : { start: Number(start), end: end === undefined || end >= size ? size - 1 : Number(end) }
}
