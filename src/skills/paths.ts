export function isSkillRootPath(path: unknown): boolean {
  return typeof path === 'string' && /^v:skills[\\/][^\\/]+[\\/]?$/.test(path)
}
