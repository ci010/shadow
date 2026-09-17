import type { SidebarSession } from './folders-sidebar.ts'

export function railInitial(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?'
}

export function rootSessionFamilies(sessions: SidebarSession[]): SidebarSession[][] {
  const families: SidebarSession[][] = []
  for (const session of sessions) {
    if (session.depth === 0 || !families.length) families.push([])
    families.at(-1)!.push(session)
  }
  return families
}
