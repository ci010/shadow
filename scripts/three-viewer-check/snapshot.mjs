import { serveThreeSnapshot } from '../../src/gateway/three-snapshot.ts';
import { Hono } from 'hono';
import { sessionsApiPlugin } from '../../src/sessions/routes.ts';
import { apiBase, marker, sessionId } from './constants.mjs';
import { mountFixtureTools } from './capture-fixture.mjs';

export async function fixtureEndpoints(workspace, fixtureScene, withTools) {
  const requests = [];
  const app = new Hono();
  sessionsApiPlugin({
    workspace,
    readSessionState: async key => key === sessionId ? {
      sessionId: key, workdir: { version: 2, nodeId: 'local', workdirId: 'fixture' },
    } : null,
    assertHistoricalFolderAccess: async key => { if (key !== sessionId) throw new Error('Unexpected fixture session'); },
    workdirLookup: () => ({ node: 'offline' }), // Managed storage, not historical execution.
  })(app);
  const close = withTools ? await mountFixtureTools(app, workspace, fixtureScene) : async () => {};
  const handle = async (req, res, next) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!url.pathname.startsWith(apiBase + '/')) return next();
    res.setHeader('content-type', 'application/json');
    const path = url.pathname.slice(apiBase.length);
    const snapshot = req.method === 'GET' && path === `/api/sessions/${encodeURIComponent(sessionId)}/workspace/three-snapshot` && url.searchParams.get('path') === marker;
    const tool = withTools && req.method === 'POST' && (path.startsWith('/api/gltf-capture/') || path === '/api/chat/send' || path.startsWith('/test/tool/'));
    if (path === '/requests') return res.end(JSON.stringify(requests));
    if (!snapshot && !tool) { res.statusCode = 404; return res.end('{}'); }
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    try {
      const start = performance.now();
      const headers = new Headers({ 'x-three-check-owner': 'fixture' });
      for (const header of ['if-none-match', 'content-type', 'x-shadow-viewer-binding']) {
        if (typeof req.headers[header] === 'string') headers.set(header, req.headers[header]);
      }
      let body;
      if (tool) {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          if ((size += chunk.length) > 16 * 1024 * 1024) throw new Error('Fixture body exceeded size limit');
          chunks.push(chunk);
        }
        if (size) body = Buffer.concat(chunks);
      }
      const response = await app.request(path + url.search, { method: req.method, headers, body, signal: controller.signal });
      const text = await response.text();
      const elapsedMs = performance.now() - start;
      if (snapshot) requests.push({ time: Date.now(), etag: response.headers.get('etag'), version: response.status === 200 ? JSON.parse(text).version : undefined, status: response.status, unchanged: response.status === 304, elapsedMs });
      res.statusCode = response.status;
      for (const [key, value] of response.headers) res.setHeader(key, value);
      res.end(text);
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); }
  };
  return { handle, close };
}

// Only the selected marker can be read. Its directory is not a Vite static root.
export function markerEndpoint(path, markerName) {
  const app = new Hono();
  app.get('/__three-marker', c => c.req.query('path') === markerName
    ? serveThreeSnapshot(c, async () => ({ path })) : c.notFound());
  return { close: async () => {}, async handle(req, res, next) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/__three-marker') return next();
    const response = await app.request(url, { method: req.method, headers: req.headers });
    res.statusCode = response.status;
    for (const [key, value] of response.headers) res.setHeader(key, value);
    res.end(await response.text());
  } };
}
