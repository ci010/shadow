import type { ExecutionContext } from '../tools/context.ts'

/** A single entry in a virtual directory. */
export interface VirtualEntry {
  /** Entry name (e.g. "discord:123"). */
  name: string
  /** Full content returned when reading this entry. */
  content: string
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
) => Promise<VirtualEntry[]> | VirtualEntry[]

/** A registered virtual mount with its handlers. */
interface VirtualMount {
  description: string
  read: VirtualFsHandler
  list?: VirtualFsListHandler
}

/**
 * Virtual filesystem overlay for tools (read, glob, grep).
 *
 * Maps dot-prefixed path prefixes to programmatic handlers so that reading,
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
  ): void {
    this.mounts.set(prefix, { description, read, list })
  }

  /** All registered mount prefixes with descriptions. */
  prefixes(): Array<{ prefix: string; description: string }> {
    return [...this.mounts.entries()].map(([prefix, m]) => ({ prefix, description: m.description }))
  }

  /**
   * Try to resolve a workspace-relative path against registered mounts.
   * Returns the handler result if matched, or `null` to fall through to the
   * real filesystem.
   */
  resolve(
    relativePath: string,
    context: ExecutionContext,
  ): Promise<string> | null {
    const { prefix, subpath } = this.parse(relativePath)
    const mount = prefix ? this.mounts.get(prefix) : undefined
    if (!mount) return null

    const result = mount.read(subpath, context)
    return result instanceof Promise ? result : Promise.resolve(result)
  }

  /**
   * List entries for a mount. Returns null if the path doesn't match a mount
   * or the mount has no list handler.
   */
  list(
    relativePath: string,
    context: ExecutionContext,
  ): Promise<VirtualEntry[]> | null {
    const { prefix } = this.parse(relativePath)
    const mount = prefix ? this.mounts.get(prefix) : undefined
    if (!mount?.list) return null

    const result = mount.list(context)
    return result instanceof Promise ? result : Promise.resolve(result)
  }

  private parse(relativePath: string): { prefix: string; subpath: string } {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
    const slashIdx = normalized.indexOf('/')
    const prefix = slashIdx >= 0 ? normalized.slice(0, slashIdx) : normalized
    const subpath = slashIdx >= 0 ? normalized.slice(slashIdx + 1) : ''
    return { prefix, subpath }
  }
}
