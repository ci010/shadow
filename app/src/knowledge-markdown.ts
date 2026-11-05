import { createMarkdown } from './markdown.ts'
import DOMPurify from 'dompurify'
import type { KnowledgeLink } from './knowledge.ts'

export function renderKnowledgeMarkdown(
  content: string,
  links: readonly KnowledgeLink[],
  entryHref: (id: string, fragment: string) => string,
): string {
  const markdown = createMarkdown({ math: false, breaks: false })
  markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    const token = tokens[index]!
    const href = token.attrGet('href') ?? ''
    const attrs = token.attrs ?? []
    token.attrs = attrs.filter(([name]) => name !== 'href')
    token.attrSet('data-knowledge-href', href)
    return renderer.renderToken(tokens, index, options)
  }
  const fragment = DOMPurify.sanitize(markdown.render(content), {
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'span', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a'],
    ALLOWED_ATTR: ['class', 'href', 'title', 'id', 'data-knowledge-href'],
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
