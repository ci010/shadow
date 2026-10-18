import DOMPurify from 'dompurify'
import { Marked, type MarkedExtension } from 'marked'
import { createApp, type App, type Directive } from 'vue'
import AnswerFlowView from './components/AnswerFlow.vue'
import { parseAnswerFlow, ANSWER_FLOW_SOURCE_LIMIT } from './answer-flow'

export const ANSWER_CLASSES = ['answer-html', 'answer-grid', 'answer-card', 'answer-flow', 'answer-callout', 'answer-muted', 'answer-badge'] as const
const tags = ['div', 'section', 'article', 'header', 'footer', 'aside', 'p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 's', 'br', 'hr', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a', 'details', 'summary', 'table', 'thead', 'tbody', 'tr', 'th', 'td']
const markdown = new Marked({ breaks: true })
const themeVariables = new Set(('bg surface surface-soft surface-muted code-bg code-inline-bg border border-soft border-strong border-hover text text-body text-secondary text-muted text-faint text-on-dark text-on-accent accent accent-hover accent-bg accent-bg-hover info info-bg success success-bg warning warning-bg danger danger-bg selection-bg selection-border radius radius-sm radius-control radius-overlay shadow-color shadow-soft-color font font-mono').split(' ').map(name => `--answer-${name}`))
// Decode CSS escapes before inspecting parsed tokens (including escaped resource functions).
function decoded(value: string): string {
  return value.replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi, (_, hex, char) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : char).replace(/\/\*[\s\S]*?\*\//g, '').toLowerCase()
}
/** Browser CSSOM is the parser; no stylesheet is attached until validation completes. */
export function sanitizeAnswerCss(source: string): string {
  const sheet = new CSSStyleSheet()
  try { sheet.replaceSync(source) } catch { return '' }
  const rules = (list: CSSRuleList, depth = 0): string => {
    if (depth > 8) return ''
    return Array.from(list).map(rule => {
      if (rule instanceof CSSMediaRule) {
        const condition = decoded(rule.conditionText)
        if (/[{}@\\]|url\s*\(/.test(condition)) return ''
        return `@media ${rule.conditionText}{${rules(rule.cssRules, depth + 1)}}`
      }
      if (!(rule instanceof CSSStyleRule)) return '' // imports, fonts, keyframes, namespaces etc.
      const selector = decoded(rule.selectorText)
      if (selector.includes(':host') || selector.includes('::') || selector.includes(':root') || selector.includes('\\')) return ''
      const declarations: string[] = []
      // CSSOM expands shorthand names, but var()-containing longhands have empty
      // values until substitution. Preserve the browser-serialized shorthand too.
      const properties = new Set([...Array.from(rule.style), ...['border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-block', 'border-inline', 'border-color', 'border-width', 'border-style', 'border-radius', 'background', 'margin', 'padding', 'margin-block', 'margin-inline', 'padding-block', 'padding-inline', 'font', 'grid', 'grid-template', 'grid-area', 'grid-column', 'grid-row', 'flex', 'flex-flow', 'gap', 'outline', 'columns', 'column-rule', 'place-items', 'place-content', 'place-self', 'overflow', 'text-decoration']])
      for (const property of properties) {
        if (!rule.style.getPropertyValue(property)) continue
        const value = decoded(rule.style.getPropertyValue(property))
        if (property.startsWith('--') || /^(animation|transition|behavior|pointer-events|cursor|content|view-transition|scroll-timeline|anchor|position-anchor)/.test(property)) continue
        if (/(url|image-set|cross-fade|element|paint|expression|attr)\s*\(|@|javascript:|\\/.test(value)) continue
        // Only public theme tokens may be substituted; no inherited app-private resource values.
        if (Array.from(value.matchAll(/var\s*\(\s*([^,)\s]+)/g)).some(m => !themeVariables.has(m[1]!))) continue
        declarations.push(`${property}:${rule.style.getPropertyValue(property)}${rule.style.getPropertyPriority(property) ? ' !important' : ''}`)
      }
      return declarations.length ? `${rule.selectorText}{${declarations.join(';')}}` : ''
    }).join('\n')
  }
  return rules(sheet.cssRules)
}
function clean(source: string, allowMarkdownMarker = false): HTMLTemplateElement {
  const template = document.createElement('template')
  template.innerHTML = DOMPurify.sanitize(source, {
    ALLOWED_TAGS: tags,
    ALLOWED_ATTR: ['class', 'href', 'title', 'open', 'start', ...(allowMarkdownMarker ? ['data-md'] : [])],
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
    FORBID_CONTENTS: ['script', 'style', 'iframe', 'svg', 'math', 'form', 'object', 'template'],
  })
  for (const element of template.content.querySelectorAll('*')) {
    if (element.tagName === 'A') {
      const href = element.getAttribute('href')
      if (href && !/^(?:https?:\/\/|mailto:|#)/i.test(href)) element.removeAttribute('href')
      element.setAttribute('rel', 'noopener noreferrer')
      if (href && /^https?:/i.test(href)) element.setAttribute('target', '_blank')
    }
  }
  return template
}
function fragment(source: string): { html: string; css: string } {
  // Templates are inert: style text cannot load resources or transiently affect the app.
  const inert = document.createElement('template'); inert.innerHTML = source
  const css = Array.from(inert.content.querySelectorAll('style')).map(s => sanitizeAnswerCss(s.textContent || '')).join('\n')
  inert.content.querySelectorAll('style').forEach(s => s.remove())
  const template = clean(inert.innerHTML, true)
  for (const element of template.content.querySelectorAll('[data-md]')) {
    if (element.parentElement?.closest('[data-md]')) continue
    element.innerHTML = markdown.parse(element.textContent || '', { async: false }) as string
    element.removeAttribute('data-md')
  }
  return { html: clean(template.innerHTML).innerHTML, css }
}
/** Encoded inert payload survives the ordinary Markdown sanitizer; mounted by the directive. */
export function renderAnswerHtml(source: string): string {
  const payload = fragment(source)
  return `<div class="answer-html" data-answer-fragment="${encodeURIComponent(JSON.stringify(payload))}"></div>`
}
export function answerHtmlExtension(): MarkedExtension {
  return { renderer: { code(token) {
    if (token.lang?.trim() === 'answer-flow') return renderAnswerFlow(token.text)
    if (token.lang?.trim() !== 'answer-html') return false
    return renderAnswerHtml(token.text)
  } } }
}
// Answer payloads are already inert/encoded here. Unlike normal Markdown,
// their contents are re-sanitized at mounting, after all caller postprocessing.
export function sanitizeAnswerHtmlRoots(html: string): string { return html }
const base = `:host{user-select:text!important;display:block!important;position:relative!important;contain:layout paint style!important;isolation:isolate!important;overflow:clip!important;min-width:0!important;max-width:100%!important;margin:1em 0!important;color:var(--answer-text)!important;font-family:var(--answer-font)!important;overflow-wrap:anywhere}*{box-sizing:border-box;min-width:0} .answer-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:12px}.answer-card{padding:16px;border:1px solid var(--answer-border);border-radius:var(--answer-radius);background:var(--answer-surface)}.answer-flow{display:flex;flex-wrap:wrap;gap:12px}.answer-flow>*{flex:1 1 180px}.answer-callout{padding:12px;border-inline-start:3px solid var(--answer-accent);background:var(--answer-surface-soft)}.answer-muted{color:var(--answer-text-secondary)}.answer-badge{display:inline-block;padding:2px 8px;border:1px solid var(--answer-border)}details{padding:12px;border:1px solid var(--answer-border)}summary{cursor:pointer}pre{overflow:auto;max-width:100%}a{color:var(--answer-accent)}`
export function renderAnswerFlow(source: string): string {
  // Encode only bounded inert text; source is parsed at the native mounting boundary.
  const bytes = new TextEncoder().encode(source)
  const bounded = bytes.byteLength > ANSWER_FLOW_SOURCE_LIMIT ? new TextDecoder().decode(bytes.subarray(0, ANSWER_FLOW_SOURCE_LIMIT)) + '\n[Source truncated: exceeds 64 KiB]' : source
  return `<div class="answer-flow-host" data-answer-flow="${encodeURIComponent(JSON.stringify(bounded))}"></div>`
}
let flowInstance = 0
const flowApps = new WeakMap<HTMLElement, Map<HTMLElement, App>>()
export function disposeAnswerHtml(root: HTMLElement): void {
  const apps = flowApps.get(root)
  if (apps) for (const app of apps.values()) app.unmount()
  flowApps.delete(root)
}
function mountAnswerFlows(root: HTMLElement): void {
  const apps = flowApps.get(root) ?? new Map<HTMLElement, App>()
  flowApps.set(root, apps)
  for (const [host, app] of apps) if (!root.contains(host)) { app.unmount(); apps.delete(host) }
  for (const host of root.querySelectorAll<HTMLElement>('[data-answer-flow]')) {
    let source = ''
    try {
      const decoded: unknown = JSON.parse(decodeURIComponent(host.dataset.answerFlow!))
      if (typeof decoded !== 'string') throw Error('Invalid diagram payload')
      source = decoded.slice(0, ANSWER_FLOW_SOURCE_LIMIT + 100)
      const flow = parseAnswerFlow(source)
      host.replaceChildren()
      const instanceId = `answer-flow-${++flowInstance}`
      host.dataset.answerFlowInstance = instanceId
      const app = createApp(AnswerFlowView, { flow, instanceId })
      app.mount(host); apps.set(host, app)
    } catch (error) {
      host.replaceChildren()
      const message = document.createElement('p'); message.setAttribute('role', 'status')
      message.textContent = `Answer diagram unavailable: ${error instanceof Error ? error.message : 'Invalid diagram'}. Waiting for complete, valid JSON.`
      const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Diagram source'
      const pre = document.createElement('pre'); pre.textContent = source; pre.style.maxHeight = '240px'; pre.style.overflow = 'auto'; pre.style.whiteSpace = 'pre-wrap'
      details.append(summary, pre); host.append(message, details)
    }
    host.removeAttribute('data-answer-flow')
  }
}
export function mountAnswerHtml(root: HTMLElement): void {
  mountAnswerFlows(root)
  for (const host of root.querySelectorAll<HTMLElement>('[data-answer-fragment]')) {
    if (host.shadowRoot) continue
    try {
      const payload = JSON.parse(decodeURIComponent(host.dataset.answerFragment!))
      const html = clean(String(payload.html)).content
      const css = sanitizeAnswerCss(String(payload.css))
      host.replaceChildren()
      const shadow = host.attachShadow({ mode: 'open' })
      const style = document.createElement('style'); style.textContent = base + '\n' + css
      shadow.append(style, html)
    } catch { host.replaceChildren() }
    host.removeAttribute('data-answer-fragment')
  }
}
// Dispose native Vue stores/listeners before v-html replaces their DOM, and on teardown.
export const vAnswerHtml: Directive<HTMLElement> = { mounted: mountAnswerHtml, beforeUpdate: (root, _binding, vnode, previous) => { if (vnode.props?.innerHTML !== previous.props?.innerHTML) disposeAnswerHtml(root) }, updated: mountAnswerHtml, beforeUnmount: disposeAnswerHtml }
