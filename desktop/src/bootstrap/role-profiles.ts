import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AtomicFileBootstrapStateStorage, bootstrapStatePath } from './storage.js'

export type DesktopRole = 'main' | 'child'
interface RoleSelection { version: 1; activeRole: DesktopRole; legacyRole: DesktopRole }
const isRole = (value: unknown): value is DesktopRole => value === 'main' || value === 'child'

/** The legacy role keeps its original paths. The other role never overwrites them.
 * A single atomic pointer is the only switch commit; configs/identities are not copied.
 */
export class DesktopRoleProfiles {
  private constructor(readonly root: string, private selection: RoleSelection, private committed: boolean) {}

  static async load(root: string): Promise<DesktopRoleProfiles> {
    try {
      const value = JSON.parse(await readFile(join(root, 'bootstrap', 'role-selection.v1.json'), 'utf8'))
      if (!value || value.version !== 1 || !isRole(value.activeRole) || !isRole(value.legacyRole)
        || Object.keys(value).length !== 3) throw new Error('Saved desktop role selection is invalid; no runtime was started')
      return new DesktopRoleProfiles(root, value, true)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    const wizard = await new AtomicFileBootstrapStateStorage(bootstrapStatePath(root)).load()
    let configRole: DesktopRole | undefined
    try {
      const config = JSON.parse(await readFile(join(root, 'bootstrap', 'runtime-config.v1.json'), 'utf8'))
      if (!isRole(config.mode)) throw new Error('Legacy runtime role is invalid')
      configRole = config.mode
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    if (wizard?.mode && configRole && wizard.mode !== configRole) throw new Error('Legacy setup and runtime roles do not match; existing data was not changed')
    const role = wizard?.mode ?? configRole ?? 'main'
    return new DesktopRoleProfiles(root, { version: 1, activeRole: role, legacyRole: role }, false)
  }

  get explicit(): boolean { return this.committed }
  get role(): DesktopRole { return this.selection.activeRole }
  get userDataPath(): string { return this.pathFor(this.role) }
  pathFor(role: DesktopRole): string {
    return role === this.selection.legacyRole ? this.root : join(this.root, 'roles', role)
  }

  /** Call only after the old runtime and setup subprocesses have stopped. */
  async select(role: DesktopRole, currentRole: DesktopRole): Promise<void> {
    if (!isRole(role) || !isRole(currentRole)) throw new TypeError('Invalid desktop role')
    // On a fresh install, setup may have selected Child since load().
    const next: RoleSelection = { version: 1, legacyRole: this.explicit ? this.selection.legacyRole : currentRole, activeRole: role }
    const path = join(this.root, 'bootstrap', 'role-selection.v1.json')
    await mkdir(dirname(path), { recursive: true })
    const staging = `${path}.${randomUUID()}.tmp`
    try {
      const file = await open(staging, 'wx', 0o600)
      try { await file.writeFile(`${JSON.stringify(next)}\n`); await file.sync() } finally { await file.close() }
      await rename(staging, path)
      this.selection = next
      this.committed = true
    } finally { await rm(staging, { force: true }) }
  }
}

export function parseRoleSwitchArguments(args: readonly unknown[]): DesktopRole {
  if (args.length !== 2 || !isRole(args[0]) || typeof args[1] !== 'boolean' || args[0] === 'child' && args[1] !== true) {
    throw new TypeError('Choose Main or Child and explicitly consent to Child OS command execution')
  }
  return args[0]
}
