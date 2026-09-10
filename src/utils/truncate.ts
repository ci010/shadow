/** Extract a human-readable message from an unknown caught value. */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Extract message + stack from an unknown caught value. */
export function errDetail(err: unknown): { err: string; stack?: string } {
  if (err instanceof Error) return { err: err.message, stack: err.stack }
  return { err: String(err) }
}
