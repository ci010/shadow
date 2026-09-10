export interface NavigationPolicy {
  isAllowed(url: string): boolean
}

export function createNavigationPolicy(target: {
  readonly origin: string
  readonly entryUrl?: string
}): NavigationPolicy {
  return {
    isAllowed(url: string): boolean {
      try {
        const candidate = new URL(url)
        if (target.origin === 'null') {
          if (target.entryUrl === undefined) return false
          const entry = new URL(target.entryUrl)
          return candidate.protocol === 'file:' && candidate.pathname === entry.pathname
        }
        return candidate.origin === target.origin && candidate.protocol === 'http:'
      } catch {
        return false
      }
    },
  }
}

export function isAllowedExternalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}