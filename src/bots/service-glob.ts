/** Small, bounded glob grammar for names only: *, ? and a whole ** segment.
 * No regular-expression construction, filesystem expansion or pattern evaluation. */
export function assertServiceGlob(pattern: string): void {
  if (pattern.length > 200 || /[\\%\x00-\x1f\x7f\[\]{}]/.test(pattern) ||
    pattern.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Use a relative glob of at most 200 characters (*, ? or **).')
}

function segmentMatches(name: string, pattern: string): boolean {
  let at = 0, token = 0, star = -1, rewind = 0
  while (at < name.length) {
    if (pattern[token] === '?' || pattern[token] === name[at] && pattern[token] !== '*') { at++; token++ }
    else if (pattern[token] === '*') { star = token++; rewind = at }
    else if (star >= 0) { token = star + 1; at = ++rewind }
    else return false
  }
  return /^\**$/.test(pattern.slice(token))
}

export function matchesServiceGlob(name: string, pattern: string): boolean {
  const names = name.split('/'), tokens = pattern.split('/')
  if (tokens.length === 1) return segmentMatches(names.at(-1)!, pattern)
  let at = 0, token = 0, star = -1, rewind = 0
  while (at < names.length) {
    if (tokens[token] === '**') { star = token++; rewind = at }
    else if (tokens[token] !== undefined && segmentMatches(names[at]!, tokens[token]!)) { at++; token++ }
    else if (star >= 0) { token = star + 1; at = ++rewind }
    else return false
  }
  return tokens.slice(token).every(value => value === '**')
}
