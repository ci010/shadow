import { ref, shallowRef, type VNode } from 'vue'

export interface TooltipOwner {
  token: symbol
  id: string
  interactive: boolean
  label: () => string
  content: () => VNode[]
  cancelClose: () => void
  scheduleClose: () => void
  focusOut: (event: FocusEvent) => void
  popupKey: (event: KeyboardEvent) => void
}

export const sharedTooltip = {
  host: shallowRef<symbol>(),
  current: shallowRef<TooltipOwner>(),
  visible: ref(false),
  element: shallowRef<HTMLElement>(),
  position: ref({ left: 0, top: 0, visibility: 'hidden' as 'hidden' | 'visible', moving: false }),
}

const hosts = new Set<symbol>()

export function registerTooltipHost(token: symbol) {
  hosts.add(token)
  sharedTooltip.host.value ??= token
}

export function unregisterTooltipHost(token: symbol) {
  hosts.delete(token)
  if (sharedTooltip.host.value === token) {
    sharedTooltip.host.value = hosts.values().next().value
  }
  if (!hosts.size) {
    sharedTooltip.visible.value = false
    sharedTooltip.current.value = undefined
    sharedTooltip.element.value = undefined
  }
}
