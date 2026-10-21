/** Preserve only loopback Vite optimizer module identities, never URL authority,
 * credentials, query, fragment, arbitrary filesystem paths or remote URLs. */
export function redactDiagnosticUrls(value: string): string {
  return value.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, raw => {
    try {
      const url = new URL(raw)
      if ((url.protocol === 'http:' || url.protocol === 'https:')
        && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        && !url.username && !url.password
        && /^\/node_modules\/\.vite\/deps\/(?:shiki_[A-Za-z0-9_-]+|chunk-[A-Za-z0-9_-]+)\.js$/.test(url.pathname)) {
        return `[local module ${url.pathname}]`
      }
    } catch { /* not a valid diagnostic module URL */ }
    return '[REDACTED URL]'
  })
}
