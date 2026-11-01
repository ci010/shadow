import { h, render, type Directive } from 'vue'
import HoverInfo from './components/HoverInfo.vue'

const hosts = new WeakMap<HTMLElement, HTMLElement>()

/** Attach shared, non-native destination hints to sanitized Markdown anchors. */
export const vMarkdownLinkHints: Directive<HTMLElement> = {
  mounted(element, binding) {
    const host = document.createElement('div')
    hosts.set(element, host)
    document.body.append(host)
    update(element, binding.instance?.$?.appContext)
  },
  updated(element, binding) { update(element, binding.instance?.$?.appContext) },
  beforeUnmount(element) {
    const host = hosts.get(element)
    if (host) { render(null, host); host.remove() }
    hosts.delete(element)
  },
}

function update(element: HTMLElement, appContext: import('vue').AppContext | undefined) {
  const host = hosts.get(element)
  if (!host) return
  const links = Array.from(element.querySelectorAll<HTMLAnchorElement>('a[href]'))
  const vnode = h('div', links.map((target, index) => {
    // Markdown's optional title must never spawn a competing native tooltip.
    target.removeAttribute('title')
    return h(HoverInfo, { target, text: target.getAttribute('href') || '', key: index })
  }))
  vnode.appContext = appContext ?? null
  render(vnode, host)
}
