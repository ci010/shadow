import type { SessionDetails } from './session-details.ts'

/** Visibility is only a hint; the backend proof and desktop bridge remain authoritative. */
export function canRevealAttachment(path: string, url: string | null | undefined, desktop: boolean, workdir?: SessionDetails['workdir']): boolean {
  return desktop && !!url && !!path && workdir?.kind !== 'remote' && workdir?.available !== false
    && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(path.replace(/^[a-z]:[\\/]/i, '/'))
    && !/[\u0000-\u001f\u007f]/.test(path)
}

export interface AttachmentRevealState { pending: Set<string>; error: boolean }

/** No work occurs until run(). Reset invalidates even transports that ignore abort. */
export function createAttachmentReveal(state: AttachmentRevealState, proofFor: (url: string, signal: AbortSignal) => Promise<unknown>, reveal: (proof: unknown) => Promise<boolean>) {
  let generation = 0
  const controllers = new Set<AbortController>()
  return {
    reset() {
      generation++
      for (const controller of controllers) controller.abort()
      controllers.clear()
      state.pending.clear()
      state.error = false
    },
    async run(path: string, url: string) {
      if (state.pending.has(path)) return
      const current = generation
      const controller = new AbortController()
      controllers.add(controller)
      state.pending.add(path)
      state.error = false
      try {
        const proof = await proofFor(url, controller.signal)
        if (generation !== current) return
        if (!proof || !await reveal(proof)) throw new Error('Not local')
      } catch {
        if (generation === current) state.error = true
      } finally {
        controllers.delete(controller)
        if (generation === current) state.pending.delete(path)
      }
    },
  }
}
