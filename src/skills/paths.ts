export function isSkillRootPath(path: unknown): boolean {
  if (typeof path !== 'string') return false
  const normalized = path.replaceAll('\\', '/').replace(/\/$/, '')
  return /^v:skills\/folder\/[^/]+$/.test(normalized)
    || normalized !== 'v:skills/folder' && /^v:skills\/[^/]+$/.test(normalized)
}
