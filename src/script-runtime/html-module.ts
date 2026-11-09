// Bundled as a self-contained guest module, never imported into the host realm.
import { load } from 'cheerio/slim'

const MAX_HTML_BYTES = 1024 * 1024
const MAX_SELECTOR = 1024
const MAX_NODES = 256
const MAX_FRAGMENT_BYTES = 64 * 1024
// Force CSS parsing even when the user's document has no element children.
const selectorValidationRoot = load('<shadow-html-selector-validation></shadow-html-selector-validation>').root()

function bytes(text: string): number {
  // UTF-8 length without relying on host TextEncoder/Buffer globals.
  let length = 0
  for (const char of text) {
    const code = char.codePointAt(0)!
    length += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4
  }
  return length
}

/** Static HTML only. No scripts, URLs, resources, browser DOM or host handles. */
export interface HtmlRoot {
  querySelector(selector: string): HtmlElement | null
  querySelectorAll(selector: string): readonly HtmlElement[]
}
export interface HtmlElement extends HtmlRoot {
  readonly textContent: string
  getAttribute(name: string): string | null
  getHtml(): string
}
export function parseHtml(html: string): HtmlRoot {
  if (typeof html !== 'string') throw new TypeError('HTML_INPUT: expected a string')
  if (html.length > MAX_HTML_BYTES || bytes(html) > MAX_HTML_BYTES) throw new RangeError('HTML_INPUT_LIMIT: maximum 1048576 UTF-8 bytes')
  const $ = load(html, { xmlMode: false })
  function select(selector: string, root?: ReturnType<typeof $>, first = false): readonly HtmlElement[] {
    if (typeof selector !== 'string' || !selector.trim()) throw new TypeError('HTML_SELECTOR: expected a nonempty string')
    if (selector.length > MAX_SELECTOR) throw new RangeError('HTML_SELECTOR_LIMIT: maximum 1024 code units')
    if (selector.trimStart().startsWith('<')) throw new Error('HTML_SELECTOR: expected CSS, not an HTML fragment')
    let matches: ReturnType<typeof $>
    try {
      selectorValidationRoot.find(selector)
      matches = (root ?? $.root()).find(selector)
    }
    catch { throw new Error('HTML_SELECTOR: invalid or unsupported CSS selector') }
    if (first) return matches.length ? [wrap(matches.eq(0))] : []
    if (matches.length > MAX_NODES) throw new RangeError('HTML_NODE_LIMIT: maximum 256 matching nodes')
    return Object.freeze(matches.toArray().map(node => wrap($(node))))
  }
  function wrap(node: ReturnType<typeof $>): HtmlElement {
    // Only detached, immutable string snapshots and guest-realm closures escape.
    return Object.freeze(Object.assign(Object.create(null), {
      textContent: node.text(),
      getAttribute(name: string) {
        if (typeof name !== 'string' || name.length > MAX_SELECTOR) throw new TypeError('HTML_ATTRIBUTE: expected a name of at most 1024 code units')
        return node.attr(name.toLowerCase()) ?? null
      },
      getHtml() {
        const fragment = $.html(node)
        if (bytes(fragment) > MAX_FRAGMENT_BYTES) throw new RangeError('HTML_FRAGMENT_LIMIT: maximum 65536 UTF-8 bytes')
        return fragment
      },
      querySelector: (selector: string) => select(selector, node, true)[0] ?? null,
      querySelectorAll: (selector: string) => select(selector, node),
    }))
  }
  return Object.freeze(Object.assign(Object.create(null), {
    querySelector: (selector: string) => select(selector, undefined, true)[0] ?? null,
    querySelectorAll: (selector: string) => select(selector),
  }))
}
