import type { ExecutionContext } from '../tools/context.ts'

/** A single entry in a virtual directory. */
export interface VirtualEntry {
  /** Entry name (e.g. "discord:123"). */
  name: string
  /** Full content returned when reading this entry. */
  content: string
  /** Incomplete discovery must be reported even when no content matches. */
  warning?: string
}

export interface VirtualListOptions {
  subpath?: string
  content?: boolean
}

/**
 * Handler for a virtual filesystem mount point.
 * Receives the subpath (portion after the mount prefix) and the execution context.
 */
export type VirtualFsHandler = (
  subpath: string,
  context: ExecutionContext,
) => Promise<string> | string

/**
 * Lists all entries under a virtual mount.
 * Used by glob (match names) and grep (search content).
 */
export type VirtualFsListHandler = (
  context: ExecutionContext,
  options?: VirtualListOptions,
) => Promise<VirtualEntry[]> | VirtualEntry[]

export interface VirtualWriteRequest {
  content: string
  match?: string
  replaceAll?: boolean
}

export type VirtualFsWriteHandler = (
  subpath: string,
  request: VirtualWriteRequest,
  context: ExecutionContext,
) => Promise<string> | string

export function isVirtualPath(path: string): boolean {
  return /^v:/i.test(path.replace(/\\/g, '/').replace(/^\/+/, ''))
}

/** A registered virtual mount with its handlers. */
interface VirtualMount {
  description: string
  read: VirtualFsHandler
  list?: VirtualFsListHandler
  write?: VirtualFsWriteHandler
}

/**
 * Virtual filesystem overlay for tools (read, write, glob, grep).
 *
 * Maps virtual path prefixes to programmatic handlers so that reading,
 * globbing, or grepping certain paths (e.g. `v:sessions/`, `v:bg/`) returns
 * dynamically generated content instead of hitting the real filesystem.
 *
 * Mounts can be added at any time — handlers capture their dependencies via
 * closure, allowing late-binding.
 */
export class VirtualFs {
  private mounts = new Map<string, VirtualMount>()

  /** Register a handler for paths starting with `prefix`. */
  mount(
    prefix: string,
    description: string,
    read: VirtualFsHandler,
    list?: VirtualFsListHandler,
    write?: VirtualFsWriteHandler,
  ): void {
    this.mounts.set(prefix, { description, read, list, write })
  }

  /** All registered mount prefixes with descriptions. */
  prefixes(): Array<{ prefix: string; description: string }> {
    return [...this.mounts.entries()].map(([prefix, m]) => ({ prefix, description: m.description }))
  }

  /**
   * Try to resolve a workspace-relative path against registered mounts.
   * Returns the handler result if matched, or `null` to fall through to the
   * real filesystem. Unknown `v:` paths fail instead of falling through.
   */
  resolve(
    relativePath: string,
    context: ExecutionContext,
  ): Promise<string> | null {
    if (context.memoryAccess) throw new Error('Channel memory leases cannot access the Project virtual filesystem. Use the scoped conversation tools.')
    const { prefix, subpath } = this.parse(relativePath)
    const mount = prefix ? this.mounts.get(prefix) : undefined
    if (!mount) {
      if (isVirtualPath(relativePath)) throw new Error('Unknown virtual filesystem path.')
      return null
    }

    const result = mount.read(subpath, context)
    return result instanceof Promise ? result : Promise.resolve(result)
  }

  /** Virtual writes never fall through to the host filesystem. */
  write(
    relativePath: string,
    request: VirtualWriteRequest,
    context: ExecutionContext,
  ): Promise<string> | null {
    if (context.memoryAccess) throw new Error('Channel memory leases cannot write Project resources.')
    const { prefix, subpath } = this.parse(relativePath)
    const mount = this.mounts.get(prefix)
    if (!mount) {
      if (isVirtualPath(relativePath)) throw new Error('Unknown virtual filesystem path.')
      return null
    }
    if (!mount.write) throw new Error('Virtual filesystem path is read-only.')
    // Self metadata belongs to the session control plane, not its workdir.
    if (context.remoteWorkdir && prefix !== 'v:session') throw new Error('Virtual configuration writes require a local workdir.')
    if (context.tools.executionMode === 'call') throw new Error('Virtual configuration writes are unavailable in call mode.')
    context.signal.throwIfAborted()
    return Promise.resolve(mount.write(subpath, request, context))
  }

  /**
   * List a virtual subtree without falling through to the host filesystem.
   */
  list(
    relativePath: string,
    context: ExecutionContext,
    options: Pick<VirtualListOptions, 'content'> = {},
  ): Promise<Array<VirtualEntry & { path: string }>> | null {
    if (context.memoryAccess) throw new Error('Channel memory leases cannot discover Project resources.')
    const { prefix, subpath } = this.parse(relativePath)
    if (subpath.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid virtual search path.')
    const mount = prefix ? this.mounts.get(prefix) : undefined
    if (!mount?.list) {
      if (isVirtualPath(relativePath)) {
        throw new Error(mount ? `Virtual folder "${prefix}" does not support search.` : `Unknown virtual folder "${prefix}".`)
      }
      return null
    }
    context.signal.throwIfAborted()
    return Promise.resolve(mount.list(context, { ...options, subpath })).then(entries => {
      context.signal.throwIfAborted()
      return entries
        .filter(entry => !subpath || entry.name === subpath || entry.name.startsWith(`${subpath}/`) ||
          entry.warning && subpath.startsWith(`${entry.name}/`))
        .map(entry => ({
          ...entry,
          path: `${prefix}/${entry.name}`,
          name: subpath && entry.name.startsWith(`${subpath}/`) ? entry.name.slice(subpath.length + 1)
            : subpath ? entry.name.split('/').at(-1)! : entry.name,
        }))
        .sort((a, b) => a.path.localeCompare(b.path, 'en'))
    })
  }

  private parse(relativePath: string): { prefix: string; subpath: string } {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const slashIdx = normalized.indexOf('/')
    const prefix = slashIdx >= 0 ? normalized.slice(0, slashIdx) : normalized
    const subpath = slashIdx >= 0 ? normalized.slice(slashIdx + 1) : ''
    return { prefix, subpath }
  }
}
