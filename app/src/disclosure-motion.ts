import { nextTick, type ObjectDirective } from 'vue'

const cleanup = new WeakMap<HTMLDetailsElement, () => void>()

/** Keep native disclosure semantics and lazy content until the closing motion ends. */
export const vDisclosureMotion: ObjectDirective<HTMLDetailsElement> = {
  mounted(element) {
    if (!(element instanceof HTMLDetailsElement)) return
    const summary = element.querySelector<HTMLElement>(':scope > summary')
    if (!summary) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    let animation: Animation | undefined
    let target = element.open
    let generation = 0
    let moving = false
    const overflow = element.style.overflow
    element.dataset.expanded = String(target)

    function cancel(): void {
      generation++
      animation?.cancel()
      animation = undefined
      moving = false
      element.style.overflow = overflow
    }

    async function move(open: boolean): Promise<void> {
      const from = element.getBoundingClientRect().height
      cancel()
      target = open
      element.dataset.expanded = String(open)
      if (reduced.matches || !element.animate) {
        element.open = open
        return
      }
      const current = generation
      moving = true
      if (open && !element.open) {
        element.open = true
        // Native toggle handlers mount the payload before its height is measured.
        await new Promise<void>(resolve => element.addEventListener('toggle', () => resolve(), { once: true }))
      }
      await nextTick()
      if (current !== generation || !element.isConnected) return
      const to = open ? element.getBoundingClientRect().height : summary!.getBoundingClientRect().height
      element.style.overflow = 'clip'
      animation = element.animate(
        [{ height: `${from}px` }, { height: `${to}px` }],
        { duration: open ? 220 : 160, easing: 'cubic-bezier(.22, 1, .36, 1)' },
      )
      animation.onfinish = () => {
        if (current !== generation) return
        animation = undefined
        moving = false
        element.style.overflow = overflow
        element.open = open
      }
    }

    function click(event: MouseEvent): void {
      if (event.defaultPrevented || event.button !== 0) return
      event.preventDefault()
      void move(!target)
    }
    function toggle(event: Event): void {
      if (event.target !== element || moving) return
      target = element.open
      element.dataset.expanded = String(target)
    }
    function preferenceChanged(): void {
      if (!reduced.matches) return
      cancel()
      element.open = target
    }
    summary.addEventListener('click', click)
    element.addEventListener('toggle', toggle)
    reduced.addEventListener('change', preferenceChanged)
    cleanup.set(element, () => {
      cancel()
      summary.removeEventListener('click', click)
      element.removeEventListener('toggle', toggle)
      reduced.removeEventListener('change', preferenceChanged)
    })
  },
  beforeUnmount(element) {
    cleanup.get(element)?.()
    cleanup.delete(element)
  },
}
