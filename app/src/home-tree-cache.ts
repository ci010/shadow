import { reactive, type InjectionKey } from 'vue'
import type { DirListing, FileEntry } from './composables/useSessionFiles.ts'
import { canRetainHomeTree, fileWorkspaceKey, reconcileFileEntries, type FileTreeSource } from './file-tree-state.ts'
import { automationSessionOwners, type SidebarSession } from './folders-sidebar.ts'
import { isLearningAutomationRef } from '../../src/cron/contracts.ts'

export interface HomeDirectoryState {
  expanded: boolean
  children: FileEntry[]
  loaded: boolean
  stale: boolean
}

export interface HomeTreeState {
  source: FileTreeSource
  workdir: NonNullable<DirListing['workdir']>
  entries: FileEntry[]
  revision: number
  directories: Map<string, HomeDirectoryState>
  scrollTop: number
  scrollLeft: number
}

export function createHomeTreeCache() {
  const homes = new Map<string, HomeTreeState>()
  const latest = new Map<string, HomeTreeState>()
  const learningSessions = reactive(new Map<string, Set<string>>())
  return {
    setSessions(apiBase: string, sessions: SidebarSession[]): void {
      const next = new Set([...automationSessionOwners(sessions)]
        .filter(([, automation]) => isLearningAutomationRef(automation)).map(([id]) => id))
      const previous = learningSessions.get(apiBase)
      if (!previous || previous.size !== next.size || [...next].some(id => !previous.has(id))) learningSessions.set(apiBase, next)
    },
    expectsHome(source: FileTreeSource): boolean {
      return !source.folderId && learningSessions.get(source.apiBase)?.has(source.sessionId) === true
    },
    candidate(source: FileTreeSource): HomeTreeState | undefined {
      const home = latest.get(source.apiBase)
      return home && canRetainHomeTree(home.source, source, home.workdir) ? home : undefined
    },
    confirm(source: FileTreeSource, listing: DirListing, refreshChildren: boolean): HomeTreeState | undefined {
      if (source.folderId || !source.sessionId || listing.workdir?.kind !== 'local'
        || listing.workdir.scope !== 'home' || !listing.workdir.displayPath) return undefined
      const key = fileWorkspaceKey(source, listing.workdir)
      let home = homes.get(key)
      if (!home) {
        home = reactive<HomeTreeState>({
          source, workdir: listing.workdir, entries: listing.entries, revision: 0,
          directories: new Map(), scrollTop: 0, scrollLeft: 0,
        })
        homes.set(key, home)
      } else {
        for (const entry of home.entries) {
          if (entry.type !== 'dir') continue
          const replacement = listing.entries.find(next => next.type === 'dir' && next.name === entry.name)
          for (const [path, directory] of home.directories) {
            if (path !== entry.name && !path.startsWith(`${entry.name}/`)) continue
            if (!replacement) home.directories.delete(path)
            else if (replacement.mtime !== entry.mtime) directory.stale = true
          }
        }
        home.entries = reconcileFileEntries(home.entries, listing.entries)
        home.source = source
        if (refreshChildren) {
          home.revision++
          for (const directory of home.directories.values()) directory.stale = true
        }
      }
      latest.set(source.apiBase, home)
      return home
    },
  }
}

export function homeDirectoryState(home: HomeTreeState | undefined, path: string, expanded = false): HomeDirectoryState {
  const existing = home?.directories.get(path)
  if (existing) return existing
  const state = reactive<HomeDirectoryState>({ expanded, children: [], loaded: false, stale: false })
  home?.directories.set(path, state)
  return state
}

export const HomeTreeCacheKey: InjectionKey<ReturnType<typeof createHomeTreeCache>> = Symbol('project-home-trees')
