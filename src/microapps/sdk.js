let access;
export class AppRequestError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'AppRequestError';
    this.status = status;
    this.code = code;
  }
}
async function checkResponse(response) {
  if (response.ok) return;
  const body = await response.text();
  let message = `App request failed (${response.status})`;
  let code = 'app_http_error';
  if (response.headers.get('content-type')?.includes('application/json')) {
    let value;
    try { value = JSON.parse(body); } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (value && typeof value === 'object') {
      if (typeof value.message === 'string') message = value.message;
      else if (typeof value.error === 'string') message = value.error;
      if (typeof value.error === 'string') code = value.error;
    }
  }
  throw new AppRequestError(message, response.status, code);
}
async function token() {
  if (!access) access = (async () => {
    const ticket = new URLSearchParams(location.hash.slice(1)).get('shadow_ticket');
    if (!ticket) {
      const saved = sessionStorage.getItem('shadow-app-access');
      if (saved) return saved;
      throw new Error('Open this app from Shadow Apps to establish an authorized connection.');
    }
    history.replaceState(null, '', location.pathname + location.search);
    const response = await fetch('/_shadow/connect', { method: 'POST', headers: { Authorization: `Bearer ${ticket}` } });
    await checkResponse(response);
    const body = await response.json();
    sessionStorage.setItem('shadow-app-access', body.token);
    return body.token;
  })();
  return access;
}
export async function request(path, options = {}) {
  if (typeof path !== 'string' || !/^\/(?:_shadow\/(?:generate|status|state)$|backend\/)/.test(path) || path.includes('\\')) {
    throw new Error('Use /_shadow/generate, /_shadow/status, /_shadow/state or /backend/ paths.');
  }
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${await token()}`);
  const response = await fetch(path, { ...options, headers, credentials: 'omit', redirect: 'error' });
  await checkResponse(response);
  return response;
}
export async function generate(input, signal) {
  return (await request('/_shadow/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal,
  })).json();
}
export async function status() { return (await request('/_shadow/status')).json(); }
export async function loadState(signal) {
  return (await request('/_shadow/state', { signal })).json();
}
export async function saveState(values, version, signal) {
  return (await request('/_shadow/state', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version, values }), signal,
  })).json();
}
