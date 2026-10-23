import DOMPurify from 'dompurify'
import { Marked } from 'marked'
import type { KnowledgeLink } from './knowledge.ts'

const escapeAttribute = (value: string) => value.replace(/&(?!(?:#\d+|#x[\da-f]+|[a-z][a-z\d]+);)/gi, '&amp;')
  .replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function renderKnowledgeMarkdown(
  content: string,
  links: readonly KnowledgeLink[],
  entryHref: (id: string, fragment: string) => string,
): string {
  const markdown = new Marked({
    renderer: {
      link({ href, title, tokens }) {
        // Keep virtual destinations as inert data until Main's canonical links resolve them.
        return `<a data-knowledge-href="${escapeAttribute(href)}"${title ? ` title="${escapeAttribute(title)}"` : ''}>${this.parser.parseInline(tokens)}</a>`
      },
    },
  })
  const fragment = DOMPurify.sanitize(markdown.parse(content, { async: false }), {
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a'],
    ALLOWED_ATTR: ['href', 'title', 'id', 'data-knowledge-href'],
    ALLOW_DATA_ATTR: false,
    ADD_URI_SAFE_ATTR: ['data-knowledge-href'],
    RETURN_DOM_FRAGMENT: true,
  })
  const targets = new Map(links.filter(link => link.href).map(link => [link.href, link.target]))
  for (const anchor of fragment.querySelectorAll<HTMLAnchorElement>('a')) {
    const href = anchor.getAttribute('data-knowledge-href') ?? anchor.getAttribute('href')
    anchor.removeAttribute('data-knowledge-href')
    anchor.removeAttribute('href')
    if (!href) continue
    const hash = href.includes('#') ? href.slice(href.indexOf('#') + 1) : ''
    const target = targets.get(href)
    if (target || href.startsWith('#')) {
      anchor.href = target ? entryHref(target, hash) : href
      if (target) anchor.dataset.knowledgeId = target
      anchor.dataset.knowledgeFragment = hash
    } else if (/^(?:https?:\/\/|mailto:|\/\/)/i.test(href) && !/[\0-\x20\\]/.test(href)) {
      anchor.href = href
      anchor.target = '_blank'
      anchor.rel = 'noopener noreferrer'
    } else if (!/^[a-z][a-z\d+.-]*:/i.test(href) || /^(?:v:(?:memory|skills)\/|builtin:skills\/)/.test(href)) {
      anchor.href = '#'
      anchor.dataset.knowledgeError = href
    }
  }
  const ids = new Set([...fragment.querySelectorAll('[id]')].map(node => node.id))
  for (const heading of fragment.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    if (heading.id) continue
    const slug = (heading.textContent ?? '').trim().toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '').replace(/\s/g, '-')
    let id = slug
    for (let suffix = 1; ids.has(id); suffix++) id = `${slug}-${suffix}`
    heading.id = id
    ids.add(id)
  }
  const container = document.createElement('div')
  container.append(fragment)
  return container.innerHTML
}
