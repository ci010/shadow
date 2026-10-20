import { mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises'
import { resolve } from 'node:path'

interface SlotState { identity: string; initialized?: boolean; profileDirectory?: string; pid?: number; ownerPid?: number }
export interface BrowserSlot {
  directory: string
  state: SlotState
  save(): Promise<void>
  release(): Promise<void>
}
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT'
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (e) { if (missing(e)) return false; throw e }
}
/** Atomic directory claims cover all managers/processes sharing the Project home.
 * Claims are deliberately NOT stolen by PID/TTL: browser descendants and PID reuse
 * make that unsafe. Crash remnants require operator verification, never auto-kill.
 */
export async function rentBrowserSlot(root: string, count: number, identity: string): Promise<BrowserSlot> {
  if (!Number.isInteger(count) || count < 1 || count > 16) throw new Error('tools.chrome.slotCount must be an integer from 1 to 16')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const guard = resolve(root, 'allocation.lock')
  let locked = false
  for (let i = 0; i < 100; i++) {
    try { await mkdir(guard); locked = true; break } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      await new Promise(r => setTimeout(r, 10))
    }
  }
  if (!locked) throw new Error('Browser slot allocation lock is occupied. If Shadow crashed, verify all managers are stopped before manually removing allocation.lock; profiles are retained.')
  try {
    const configPath = resolve(root, 'pool.json')
    let cursor = 0
    try {
      const config = JSON.parse(await readFile(configPath, 'utf8'))
      if (config.count !== count) throw new Error(`Browser pool has ${config.count} persistent slots; restore tools.chrome.slotCount=${config.count} or explicitly migrate the pool while all browsers are stopped. No data was deleted.`)
      cursor = config.cursor
      if (!Number.isInteger(cursor) || cursor < 0 || cursor >= count) throw new Error('Invalid browser pool cursor; manual inspection required')
    } catch (e) { if (!missing(e)) throw e }
    // Persist the cap even when initialization fails; never create one pool per browser.
    await writeFile(configPath, JSON.stringify({ count, cursor }))
    for (let offset = 0; offset < count; offset++) {
      const index = (cursor + offset) % count
      const slot = resolve(root, `slot-${index + 1}`)
      await mkdir(slot, { recursive: true, mode: 0o700 })
      if (await exists(resolve(slot, 'lease'))) continue
      const metadata = resolve(slot, 'slot.json')
      let state: SlotState
      try { state = JSON.parse(await readFile(metadata, 'utf8')) } catch (e) { if (!missing(e)) throw e; state = { identity } }
      if (state.identity !== identity) continue
      const directory = resolve(slot, 'profile')
      let browserLocked = false
      for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
        if (await exists(resolve(directory, name))) browserLocked = true
      }
      if (browserLocked) continue
      await mkdir(resolve(slot, 'lease'))
      state.ownerPid = process.pid
      const save = () => writeFile(metadata, JSON.stringify(state))
      await save()
      await writeFile(configPath, JSON.stringify({ count, cursor: (index + 1) % count }))
      return { directory, state, save, release: async () => {
        state.pid = undefined; state.ownerPid = undefined
        await save()
        await rm(resolve(slot, 'lease'), { recursive: true })
      } }
    }
    throw new Error(`Browser slot capacity exhausted (${count} total per Project): slots are busy, recovery-quarantined, browser-locked, or belong to another executable. Release an instance or select its browser. For crash recovery/migration, stop managers and verify no browser uses the slot before manually clearing its lease/locks; never delete profiles without approval. Existing UUID profiles are retained.`)
  } finally { await rm(guard, { recursive: true }) }
}
