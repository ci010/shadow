import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeAuthorization } from '../runtime-authorization.js'
import {
  CONNECTION_LEASE_MS, dpapi, requireLaunchToken, requireLoopbackOrigin, runPowerShell,
  type DesktopConnectionDescriptor,
} from './connection.js'

export interface PublishedConnection {
  path: string
  renew(): Promise<void>
  remove(): Promise<void>
}

export interface ConnectionStore {
  publish(authorization: RuntimeAuthorization): Promise<PublishedConnection>
}

export class DesktopConnectionStore implements ConnectionStore {
  constructor(private readonly userDataPath: string) {}

  async publish(authorization: RuntimeAuthorization): Promise<PublishedConnection> {
    const apiBase = requireLoopbackOrigin(authorization.apiBase)
    const token = requireLaunchToken(authorization.launchToken)
    const control = join(this.userDataPath, 'control')
    const directory = join(control, 'web-access')
    await mkdir(control, { recursive: true, mode: 0o700 })
    if (!(await lstat(control)).isDirectory() || (await lstat(control)).isSymbolicLink()) throw new Error('Invalid control directory')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid publication directory')
    if (process.platform === 'win32') {
      await runPowerShell([
        '$ErrorActionPreference="Stop"',
        '$path=[Console]::In.ReadToEnd()',
        '$user=[Security.Principal.WindowsIdentity]::GetCurrent().User',
        '$acl=New-Object Security.AccessControl.DirectorySecurity',
        '$acl.SetOwner($user)',
        '$acl.SetAccessRuleProtection($true,$false)',
        'foreach($sid in @($user.Value,"S-1-5-18","S-1-5-32-544")){$id=New-Object Security.Principal.SecurityIdentifier($sid);$rule=New-Object Security.AccessControl.FileSystemAccessRule($id,"FullControl","ContainerInherit,ObjectInherit","None","Allow");$acl.AddAccessRule($rule)}',
        '[IO.Directory]::SetAccessControl($path,$acl)',
      ].join(';'), directory)
    } else {
      if (stat.uid !== process.getuid?.()) throw new Error('Publication directory belongs to another user')
      await chmod(directory, 0o700)
    }
    const credentialPath = join(directory, `${randomUUID()}.credential`)
    const path = join(directory, 'connection.v1.json')
    const staging = join(directory, `${randomUUID()}.json`)
    const credentialProtection = process.platform === 'win32' ? 'windows-dpapi-current-user' : 'unix-owner-only'
    const credential = process.platform === 'win32'
      ? await dpapi('Protect', Buffer.from(token, 'utf8'))
      : Buffer.from(token, 'utf8')
    let ownsDescriptor = false
    const remove = async () => {
      await Promise.all([
        ...(ownsDescriptor ? [rm(path, { force: true })] : []),
        rm(credentialPath, { force: true }), rm(staging, { force: true }),
      ])
    }
    const renew = async () => {
      const descriptor: DesktopConnectionDescriptor = {
        version: 1, kind: 'desktop', apiBase, credentialPath, credentialProtection,
        expiresAt: new Date(Date.now() + CONNECTION_LEASE_MS).toISOString(),
      }
      await writeFile(staging, JSON.stringify(descriptor), { mode: 0o600, flag: 'wx' })
      await rename(staging, path)
      ownsDescriptor = true
    }
    try {
      await writeFile(credentialPath, credential, { mode: 0o600, flag: 'wx' })
      await renew()
      return { path, renew, remove }
    } catch {
      await remove()
      throw new Error('Desktop Web connection could not be published')
    }
  }
}

export interface PublicationOptions {
  store: ConnectionStore
  isReady(authorization: RuntimeAuthorization): boolean
  onPublished(path: string): void
  onError(): void
  onUnavailable(): void
  refreshMs?: number
}

/** Serializes protected writes; stale ready callbacks cannot republish after stop. */
export class RuntimeConnectionPublication {
  private generation = 0
  private pending = Promise.resolve()
  private published: PublishedConnection | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false

  constructor(private readonly options: PublicationOptions) {}

  setAuthorization(authorization: RuntimeAuthorization | null): Promise<void> {
    if (this.closed) return this.pending
    const generation = ++this.generation
    clearTimeout(this.timer)
    this.pending = this.pending.then(async () => {
      await this.remove()
      if (!authorization || generation !== this.generation || !this.options.isReady(authorization)) return
      const published = await this.options.store.publish(authorization)
      this.published = published
      if (generation !== this.generation || !this.options.isReady(authorization)) {
        await this.remove()
        return
      }
      this.options.onPublished(published.path)
      this.schedule(authorization, generation)
    }).catch(() => { this.options.onError() })
    return this.pending
  }

  async close(): Promise<void> {
    if (!this.closed) {
      const closing = this.setAuthorization(null)
      this.closed = true
      await closing
    } else await this.pending
  }

  private schedule(authorization: RuntimeAuthorization, generation: number): void {
    this.timer = setTimeout(() => {
      if (generation !== this.generation || this.closed) return
      if (!this.options.isReady(authorization)) {
        this.options.onUnavailable()
        void this.setAuthorization(null)
        return
      }
      this.pending = this.pending.then(async () => {
        if (generation !== this.generation) return
        await this.published?.renew()
        if (generation === this.generation) this.schedule(authorization, generation)
      }).catch(async () => {
        this.options.onError()
        try { await this.remove() } catch { this.options.onError() }
      })
    }, this.options.refreshMs ?? 60_000)
    this.timer.unref()
  }

  private async remove(): Promise<void> {
    if (!this.published) return
    const previous = this.published
    await previous.remove()
    this.published = undefined
  }
}
