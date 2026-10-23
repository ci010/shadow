/* Network-only: never persist authenticated pages, conversations, or API responses. */
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

const offlinePage = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#141414"><title>Shadow is unavailable</title>
<style>
body{margin:0;padding:48px 24px;background:#141414;color:#e7e7e7;font:16px/1.6 system-ui,sans-serif}
main{max-width:36rem;margin:12vh auto}h1{font-size:24px;font-weight:600}
p{color:#b3b3b3}a{display:inline-block;padding:10px 16px;color:#8bb7ff;border:1px solid #353535;text-decoration:none}
a:focus-visible{outline:2px solid #8bb7ff;outline-offset:3px}
</style><main><h1>Shadow is unavailable</h1>
<p>Check your connection and make sure the Shadow backend is running. Conversations are not available offline.</p>
<a href="/">Try again</a></main></html>`

function isAppPage(path) {
  return path === '/' || path === '/index.html' || path === '/nodes' || path === '/nodes/'
    || /^\/(?:chat|knowledge|workspaces|providers|approvals|settings|agents|logs|spans)(?:\/|$)/.test(path)
    || /^\/projects\/?$/.test(path)
    || /^\/projects\/[^/]+\/(?:chat|knowledge|settings|agents|logs|spans)(?:\/|$)/.test(path)
}

self.addEventListener('fetch', event => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || request.mode !== 'navigate'
    || url.origin !== self.location.origin || !isAppPage(url.pathname)) return
  event.respondWith(fetch(request).catch(() => new Response(offlinePage, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    },
  })))
})
