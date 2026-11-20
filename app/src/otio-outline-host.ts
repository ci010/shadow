import type { InjectionKey } from 'vue'

export const OtioOutlineHostKey: InjectionKey<{
  target: () => HTMLElement | undefined
  background: () => boolean
}> = Symbol('OTIO file explorer outline host')
