import DOMPurify from 'dompurify'

export function workExhibitDocument(html: string): string {
  const content = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true },
    ADD_TAGS: ['style'],
    FORBID_TAGS: ['a', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'object',
      'embed', 'script', 'meta', 'link', 'base', 'audio', 'video', 'source', 'foreignObject'],
    FORBID_ATTR: ['href', 'xlink:href', 'srcdoc', 'action', 'formaction', 'target', 'contenteditable', 'autofocus'],
  })
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; object-src 'none'">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{color-scheme:light dark}body{margin:16px;font:14px/1.6 system-ui,sans-serif;color:CanvasText;background:Canvas;overflow-wrap:anywhere}img,svg{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%}td,th{padding:8px;border:1px solid GrayText}pre{white-space:pre-wrap}</style>
</head><body>${content}</body></html>`
}
