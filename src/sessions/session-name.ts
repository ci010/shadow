export const SESSION_NAME_MAX_LENGTH = 120

export class SessionNameError extends TypeError {}

export function parseSessionName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > SESSION_NAME_MAX_LENGTH
    || /[\x00-\x1f\x7f]/.test(value)) {
    throw new SessionNameError(`Use a non-empty session name of at most ${SESSION_NAME_MAX_LENGTH} characters, without line breaks or control characters.`)
  }
  return value.trim()
}
