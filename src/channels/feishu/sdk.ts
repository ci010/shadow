/**
 * feishu_sdk.ts
 *
 * Minimal Feishu / Lark SDK reimplemented with browser-native APIs
 * (fetch + WebSocket) available natively in Node.js.
 *
 * Covers only the features used by FeishuChannel:
 *  - Tenant-access-token management (auto-refresh)
 *  - im.message.create
 *  - im.message.list / get (native chat/topic history and message reads)
 *  - im.chat.get / im.chatMembers.get (chat metadata and membership)
 *  - im.message.resource.get  (file / image download)
 *  - im.messageReaction.create
 *  - EventDispatcher (decrypt + dispatch)
 *  - WSClient  (long-connection WebSocket with protobuf framing + auto-reconnect)
 *
 * References:
 *  https://open.feishu.cn/document/server-docs/api-call-guide/calling-process/overview
 *  https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case
 *  https://open.feishu.cn/document/server-docs/event-subscription-guide/long-connection
 */

// ---------------------------------------------------------------------------
// Re-exported types (so feishu.ts imports don't need to change much)
// ---------------------------------------------------------------------------
/** Interactive card element: markdown */
export interface InteractiveCardMarkdownElement {
  tag: 'markdown'
  content: string
}
/** Interactive card element: div (lark_md title) */
export interface InteractiveCardDivElement {
  tag: 'div'
  text: { tag: string; content: string }
}
/** Interactive card top-level type */
export interface InteractiveCard {
  config?: { wide_screen_mode?: boolean }
  elements: Array<
    | InteractiveCardMarkdownElement
    | InteractiveCardDivElement
    | Record<string, unknown>
  >
  header?: Record<string, unknown>
}

/** Log levels mirroring the original sdk enum */
export const LoggerLevel = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
} as const
export type LoggerLevel = (typeof LoggerLevel)[keyof typeof LoggerLevel]

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FEISHU_BASE = 'https://open.feishu.cn'
const WS_CONFIG_URL = `${FEISHU_BASE}/callback/ws/endpoint`
const TOKEN_URL =
  `${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`

// Token refreshed 5 minutes before expiry
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// AES decrypt (challenge / event payload)
// ---------------------------------------------------------------------------
// Feishu encrypts with AES-256-CBC, key = SHA-256(encryptKey), IV = first 16 bytes
// of the base64-decoded ciphertext.

async function aesDecrypt(
  encryptKey: string,
  encryptedBase64: string,
): Promise<string> {
  // SHA-256 the raw key string bytes
  const enc = new TextEncoder()
  const keyBytes = await crypto.subtle.digest('SHA-256', enc.encode(encryptKey))

  const cipher = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-CBC', length: 256 },
    false,
    ['decrypt'],
  )

  const raw = Uint8Array.from(atob(encryptedBase64), (c) => c.charCodeAt(0))
  const iv = raw.slice(0, 16)
  const ciphertext = raw.slice(16)

  const plain = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv },
    cipher,
    ciphertext,
  )
  return new TextDecoder().decode(plain)
}

// ---------------------------------------------------------------------------
// Token manager
// ---------------------------------------------------------------------------

interface TokenInfo {
  token: string
  expiresAt: number // ms since epoch
}

/**
 * TokenManager keeps a valid tenant-access-token.
 * It fetches a new one when the current one is absent or close to expiry.
 */
class TokenManager {
  private appId: string
  private appSecret: string
  private _cache: TokenInfo | null = null
  private _inflight: Promise<string> | null = null

  constructor(appId: string, appSecret: string, private readonly signal?: AbortSignal) {
    this.appId = appId
    this.appSecret = appSecret
  }

  async getTenantAccessToken(): Promise<string> {
    this.signal?.throwIfAborted()
    if (
      this._cache &&
      Date.now() < this._cache.expiresAt - TOKEN_REFRESH_BUFFER_MS
    ) {
      return this._cache.token
    }
    // Coalesce concurrent callers
    if (this._inflight) return this._inflight
    this._inflight = this._fetch()
    try {
      const token = await this._inflight
      return token
    } finally {
      this._inflight = null
    }
  }

  private async _fetch(): Promise<string> {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      signal: this.signal,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    })
    if (!resp.ok) {
      throw new Error(`[feishu_sdk] token fetch HTTP ${resp.status}`)
    }
    const json = (await resp.json()) as {
      code: number
      msg: string
      tenant_access_token: string
      expire: number
    }
    if (json.code !== 0) {
      throw new Error(
        `[feishu_sdk] token error code=${json.code} msg=${json.msg}`,
      )
    }
    this.signal?.throwIfAborted()
    this._cache = {
      token: json.tenant_access_token,
      expiresAt: Date.now() + json.expire * 1000,
    }
    return this._cache.token
  }
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

export class FeishuApiError extends Error {
  readonly status: number
  readonly method: string
  readonly path: string
  readonly apiCode?: number
  readonly apiMsg?: string
  readonly requestId?: string

  constructor(opts: {
    status: number
    method: string
    path: string
    apiCode?: number
    apiMsg?: string
    requestId?: string
  }) {
    const detail = [
      opts.apiCode !== undefined ? `code=${opts.apiCode}` : null,
      opts.apiMsg ? `msg=${opts.apiMsg}` : null,
      opts.requestId ? `request_id=${opts.requestId}` : null,
    ].filter(Boolean).join(' ')
    super(
      detail
        ? `[feishu_sdk] HTTP ${opts.status} ${opts.method} ${opts.path} ${detail}`
        : `[feishu_sdk] HTTP ${opts.status} ${opts.method} ${opts.path}`,
    )
    this.name = 'FeishuApiError'
    this.status = opts.status
    this.method = opts.method
    this.path = opts.path
    this.apiCode = opts.apiCode
    this.apiMsg = opts.apiMsg
    this.requestId = opts.requestId
  }
}

async function parseApiError(resp: Response): Promise<{
  bodyText: string
  apiCode?: number
  apiMsg?: string
  requestId?: string
}> {
  let bodyText = ''
  let apiCode: number | undefined
  let apiMsg: string | undefined
  let requestId: string | undefined
  try {
    bodyText = await resp.text()
    if (bodyText) {
      const parsed = JSON.parse(bodyText) as {
        code?: number
        msg?: string
        RequestId?: string
        request_id?: string
      }
      apiCode = parsed.code
      apiMsg = parsed.msg
      requestId = parsed.RequestId ?? parsed.request_id
    }
  } catch {
    // keep generic HTTP error when body is non-JSON
  }
  return { bodyText, apiCode, apiMsg, requestId }
}

async function apiRequest<T = unknown>(
  tokenManager: TokenManager,
  method: string,
  path: string,
  opts: {
    params?: Record<string, string>
    body?: unknown
    binary?: boolean
    signal?: AbortSignal
  } = {},
): Promise<T> {
  opts.signal?.throwIfAborted()
  const token = await awaitApiToken(tokenManager.getTenantAccessToken(), opts.signal)
  opts.signal?.throwIfAborted()

  let url = `${FEISHU_BASE}${path}`
  if (opts.params && Object.keys(opts.params).length > 0) {
    const qs = new URLSearchParams(opts.params)
    url = `${url}?${qs}`
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  }
  let reqBody: BodyInit | undefined
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8'
    reqBody = JSON.stringify(opts.body)
  }

  const resp = await fetch(url, { method, headers, body: reqBody, signal: opts.signal })
  if (!resp.ok) {
    const { bodyText, apiCode, apiMsg, requestId } = await parseApiError(resp)
    throw new FeishuApiError({
      status: resp.status,
      method,
      path,
      apiCode,
      apiMsg: apiMsg ?? (bodyText ? bodyText.slice(0, 500) : undefined),
      requestId,
    })
  }

  if (opts.binary) {
    const buf = await resp.arrayBuffer()
    return new Uint8Array(buf) as unknown as T
  }
  const result = (await resp.json()) as T
  opts.signal?.throwIfAborted()
  return result
}

function awaitApiToken(token: Promise<string>, signal?: AbortSignal): Promise<string> {
  if (!signal) return token
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    token.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

// ---------------------------------------------------------------------------
// Multipart HTTP helper (for file / image upload)
// ---------------------------------------------------------------------------

async function apiRequestMultipart<T = unknown>(
  tokenManager: TokenManager,
  method: string,
  path: string,
  formData: FormData,
): Promise<T> {
  const token = await tokenManager.getTenantAccessToken()
  const url = `${FEISHU_BASE}${path}`
  // Do NOT set Content-Type manually — fetch sets it with the correct boundary for FormData
  const resp = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  })
  if (!resp.ok) {
    const { bodyText, apiCode, apiMsg, requestId } = await parseApiError(resp)
    throw new FeishuApiError({
      status: resp.status,
      method,
      path,
      apiCode,
      apiMsg: apiMsg ?? (bodyText ? bodyText.slice(0, 500) : undefined),
      requestId,
    })
  }
  return (await resp.json()) as T
}

// ---------------------------------------------------------------------------
// Typed API response shapes (only fields we use)
// ---------------------------------------------------------------------------

interface ApiResp {
  code: number
  msg: string
}

interface ImMessageCreateResp extends ApiResp {
  data?: { message_id?: string; thread_id?: string; root_id?: string }
}

interface ImImageCreateResp extends ApiResp {
  data?: { image_key?: string }
}

interface ImFileCreateResp extends ApiResp {
  data?: { file_key?: string }
}

interface ImMessageReactionCreateResp extends ApiResp {}

interface ContactUserGetResp extends ApiResp {
  data?: {
    user?: {
      name?: string
      en_name?: string
      open_id?: string
    }
  }
}

// ---------------------------------------------------------------------------
// Client — wraps named REST namespaces
// ---------------------------------------------------------------------------

class Client {
  private _tokens: TokenManager

  constructor(
    opts: { appId: string; appSecret: string; disableTokenCache?: boolean; signal?: AbortSignal },
  ) {
    this._tokens = new TokenManager(opts.appId, opts.appSecret, opts.signal)
  }

  /** `client.im.message.create(…)` */
  readonly im = {
    chat: {
      get: (req: { path: { chat_id: string }; signal?: AbortSignal }): Promise<ApiResp & {
        data?: { name?: string; chat_mode?: string; chat_status?: string; chat_post_permission?: string }
      }> => apiRequest(this._tokens, 'GET', `/open-apis/im/v1/chats/${encodeURIComponent(req.path.chat_id)}`, { signal: req.signal }),
    },
    chatMembers: {
      get: (req: { path: { chat_id: string }; params: { member_id_type: 'open_id'; page_size: string; page_token?: string }; signal?: AbortSignal }): Promise<unknown> =>
        apiRequest(this._tokens, 'GET', `/open-apis/im/v1/chats/${encodeURIComponent(req.path.chat_id)}/members`, { params: req.params, signal: req.signal }),
    },
    message: {
      list: (req: { params: { container_id_type: 'chat' | 'thread'; container_id: string; sort_type: 'ByCreateTimeDesc'; page_size: string; page_token?: string }; signal?: AbortSignal }): Promise<unknown> =>
        apiRequest(this._tokens, 'GET', '/open-apis/im/v1/messages', { params: req.params, signal: req.signal }),
      get: (req: { path: { message_id: string }; signal?: AbortSignal }): Promise<unknown> =>
        apiRequest(this._tokens, 'GET', `/open-apis/im/v1/messages/${encodeURIComponent(req.path.message_id)}`, { params: { user_id_type: 'open_id' }, signal: req.signal }),
      create: (req: {
        params: { receive_id_type: string }
        data: { receive_id: string; msg_type: string; content: string }
      }): Promise<ImMessageCreateResp> =>
        apiRequest<ImMessageCreateResp>(
          this._tokens,
          'POST',
          '/open-apis/im/v1/messages',
          {
            params: { receive_id_type: req.params.receive_id_type },
            body: req.data,
          },
        ),

      /** Reply to an existing message in thread. */
      reply: (req: {
        path: { message_id: string }
        data: { msg_type: string; content: string; reply_in_thread?: boolean }
      }): Promise<ImMessageCreateResp> =>
        apiRequest<ImMessageCreateResp>(
          this._tokens,
          'POST',
          `/open-apis/im/v1/messages/${
            encodeURIComponent(req.path.message_id)
          }/reply`,
          { body: req.data },
        ),

      /** Update (patch) the content of an existing message. */
      update: (req: {
        path: { message_id: string }
        data: { msg_type: string; content: string }
      }): Promise<ApiResp> =>
        apiRequest<ApiResp>(
          this._tokens,
          'PATCH',
          `/open-apis/im/v1/messages/${
            encodeURIComponent(req.path.message_id)
          }`,
          { body: req.data },
        ),
    },

    /**
     * Upload an image for use in messages.
     * `formData` must contain:
     *   - `image_type`: `"message"` | `"avatar"`
     *   - `image`: blob / file
     * Returns the `image_key` to use in an image message.
     */
    image: {
      create: (formData: FormData): Promise<ImImageCreateResp> =>
        apiRequestMultipart<ImImageCreateResp>(
          this._tokens,
          'POST',
          '/open-apis/im/v1/images',
          formData,
        ),
    },

    /**
     * Upload a file for use in messages.
     * `formData` must contain:
     *   - `file_type`: `"opus"` | `"mp4"` | `"pdf"` | `"doc"` | `"xls"` | `"ppt"` | `"stream"`
     *   - `file_name`: original filename
     *   - `file`: blob / file
     * Returns the `file_key` to use in a file message.
     */
    file: {
      create: (formData: FormData): Promise<ImFileCreateResp> =>
        apiRequestMultipart<ImFileCreateResp>(
          this._tokens,
          'POST',
          '/open-apis/im/v1/files',
          formData,
        ),
    },

    /** `client.im.messageResource.get(…)` mirroring SDK path */
    messageResource: {
      get: (req: {
        path: { message_id: string; file_key: string }
        params: { type: string }
      }): Promise<Uint8Array> =>
        apiRequest<Uint8Array>(
          this._tokens,
          'GET',
          `/open-apis/im/v1/messages/${
            encodeURIComponent(req.path.message_id)
          }/resources/${encodeURIComponent(req.path.file_key)}`,
          { params: { type: req.params.type }, binary: true },
        ),
    },

    messageReaction: {
      create: (req: {
        path: { message_id: string }
        data: { reaction_type: { emoji_type: string } }
      }): Promise<ImMessageReactionCreateResp> =>
        apiRequest<ImMessageReactionCreateResp>(
          this._tokens,
          'POST',
          `/open-apis/im/v1/messages/${
            encodeURIComponent(req.path.message_id)
          }/reactions`,
          { body: req.data },
        ),
    },
  }

  /** `client.contact.user.get(…)` — fetch a user's profile by open_id */
  readonly contact = {
    user: {
      get: (req: {
        path: { user_id: string }
        params?: { user_id_type?: string }
      }): Promise<ContactUserGetResp> =>
        apiRequest<ContactUserGetResp>(
          this._tokens,
          'GET',
          `/open-apis/contact/v3/users/${encodeURIComponent(req.path.user_id)}`,
          { params: { user_id_type: req.params?.user_id_type ?? 'open_id' } },
        ),
    },
  }

  /** Expose token manager for WSClient to reuse */
  _getTokenManager(): TokenManager {
    return this._tokens
  }
}

// ---------------------------------------------------------------------------
// EventDispatcher
// ---------------------------------------------------------------------------

type EventHandler = (
  data: Record<string, unknown>,
) => Promise<unknown> | unknown

/**
 * Minimal event dispatcher. Decrypts the payload if encryptKey is set,
 * then routes to the registered handler by event type.
 */
class EventDispatcher {
  private encryptKey: string
  private verificationToken: string
  private _handlers: Map<string, EventHandler> = new Map()

  constructor(opts: { encryptKey?: string; verificationToken?: string }) {
    this.encryptKey = opts.encryptKey ?? ''
    this.verificationToken = opts.verificationToken ?? ''
  }

  register(handlers: Record<string, EventHandler>): this {
    for (const [type, handler] of Object.entries(handlers)) {
      this._handlers.set(type, handler)
    }
    return this
  }

  /**
   * Decrypt (if needed) and dispatch an incoming event payload object.
   * Works with both HTTP webhook delivery and WS frame body.
   */
  async invoke(raw: Record<string, unknown>): Promise<unknown> {
    let data = raw

    // Encrypted payload: { encrypt: "<base64>" }
    if ('encrypt' in data && typeof data['encrypt'] === 'string') {
      if (!this.encryptKey) {
        throw new Error('[feishu_sdk] encryptKey required but not set')
      }
      const decrypted = await aesDecrypt(
        this.encryptKey,
        data['encrypt'] as string,
      )
      data = JSON.parse(decrypted)
    }

    // Challenge (URL verification)
    if (data['type'] === 'url_verification') {
      return { challenge: data['challenge'] }
    }

    // Schema v2: { schema: "2.0", header: { event_type: "..." }, event: {...} }
    const schema = data['schema'] as string | undefined
    let eventType: string | undefined
    let eventPayload: Record<string, unknown>

    if (schema === '2.0') {
      const header = data['header'] as Record<string, unknown> | undefined
      eventType = header?.['event_type'] as string | undefined
      eventPayload = data['event'] as Record<string, unknown> ?? data
    } else {
      // Schema v1 / websocket push structure
      eventType = (data['event_type'] as string | undefined) ??
        (data['header'] as Record<string, unknown> | undefined)
          ?.['event_type'] as string | undefined
      eventPayload = (data['event'] as Record<string, unknown> | undefined) ??
        data
    }

    if (!eventType) {
      console.debug(
        '[feishu_sdk] Unknown event structure',
        JSON.stringify(data).slice(0, 200),
      )
      return {}
    }

    const handler = this._handlers.get(eventType)
    if (!handler) {
      console.debug(`[feishu_sdk] No handler for event_type=${eventType}`)
      return {}
    }

    return handler(eventPayload)
  }
}

// ---------------------------------------------------------------------------
// Protobuf-lite decoder for WSClient frames
// ---------------------------------------------------------------------------
// Feishu long-connection uses a simple binary framing:
//   4-byte big-endian header-length  |  header bytes (pbbp2.Header)  |  payload bytes
//
// Rather than pulling in protobufjs, we hand-decode the varint/length-delimited
// fields we actually need from pbbp2.Header and pbbp2.Frame:
//
// Frame fields (wire types inferred from the SDK source):
//   field 1 (type)   : varint
//   field 2 (headers): repeated bytes (each is a serialised pbbp2.Header)
//   field 3 (payload): bytes
//
// Header fields:
//   field 1 (key)    : string (length-delimited)
//   field 2 (value)  : string (length-delimited)

interface WsHeader {
  key: string
  value: string
}
interface WsFrame {
  seqId: number // field 1: SeqID (required for ACK correlation)
  logId: number // field 2: LogID (required)
  service: number // field 3: service (required for ACK routing)
  type: number // field 4: method (0=control, 1=data)
  headers: WsHeader[]
  payload: Uint8Array<any>
}

/** Read a protobuf varint from `buf` starting at `offset`. Returns [value, newOffset]. */
function readVarint(buf: Uint8Array, offset: number): [number, number] {
  let result = 0
  let shift = 0
  while (offset < buf.length) {
    const byte = buf[offset++]
    result |= (byte & 0x7f) << shift
    shift += 7
    if ((byte & 0x80) === 0) break
  }
  return [result, offset]
}

/** Read a length-delimited bytes field. Returns [bytes, newOffset]. */
function readBytes(buf: Uint8Array, offset: number): [Uint8Array, number] {
  const [len, o] = readVarint(buf, offset)
  return [buf.slice(o, o + len), o + len]
}

/** Read a length-delimited string. */
function readString(buf: Uint8Array, offset: number): [string, number] {
  const [bytes, o] = readBytes(buf, offset)
  return [new TextDecoder().decode(bytes), o]
}

function decodeHeader(buf: Uint8Array): WsHeader {
  let offset = 0
  let key = ''
  let value = ''
  while (offset < buf.length) {
    const [tag, o] = readVarint(buf, offset)
    offset = o
    const fieldNum = tag >> 3
    const wireType = tag & 0x7
    if (wireType === 2) {
      const [s, nx] = readString(buf, offset)
      offset = nx
      if (fieldNum === 1) key = s
      else if (fieldNum === 2) value = s
    } else {
      // skip unknown
      break
    }
  }
  return { key, value }
}

function decodeFrame(buf: Uint8Array): WsFrame {
  let offset = 0
  let seqId = 0
  let logId = 0
  let service = 0
  let type = 0
  const headers: WsHeader[] = []
  let payload: Uint8Array<any> = new Uint8Array(0)

  while (offset < buf.length) {
    const [tag, o] = readVarint(buf, offset)
    offset = o
    const fieldNum = tag >> 3
    const wireType = tag & 0x7

    if (wireType === 0) {
      // varint fields: 1=SeqID, 2=LogID, 3=service, 4=method/type
      const [v, nx] = readVarint(buf, offset)
      offset = nx
      if (fieldNum === 1) seqId = v
      else if (fieldNum === 2) logId = v
      else if (fieldNum === 3) service = v
      else if (fieldNum === 4) type = v
    } else if (wireType === 2) {
      // length-delimited: 5=headers, 6=payloadEncoding, 7=payloadType, 8=payload, 9=LogIDNew
      const [bytes, nx] = readBytes(buf, offset)
      offset = nx
      if (fieldNum === 5) headers.push(decodeHeader(bytes))
      else if (fieldNum === 8) payload = bytes as Uint8Array<any>
      // fields 6, 7, 9 are read and discarded
    } else {
      // skip unknown fixed-width wire types (groups etc.) — shouldn't appear
      break
    }
  }

  return { seqId, logId, service, type, headers, payload }
}

function encodeFrame(frame: WsFrame): Uint8Array {
  const parts: Uint8Array[] = []

  // field 1: SeqID (uint64 varint) — tag = (1 << 3) | 0 = 0x08
  parts.push(new Uint8Array([0x08]))
  parts.push(encodeVarint(frame.seqId))

  // field 2: LogID (uint64 varint) — tag = (2 << 3) | 0 = 0x10
  parts.push(new Uint8Array([0x10]))
  parts.push(encodeVarint(frame.logId))

  // field 3: service (int32 varint) — tag = (3 << 3) | 0 = 0x18
  parts.push(new Uint8Array([0x18]))
  parts.push(encodeVarint(frame.service))

  // field 4: method/type (varint) — tag = (4 << 3) | 0 = 0x20
  parts.push(new Uint8Array([0x20]))
  parts.push(encodeVarint(frame.type))

  // field 5: headers (repeated length-delimited Header sub-messages)
  // Header sub-message: field 1 = key (tag 0x0a), field 2 = value (tag 0x12)
  const enc = new TextEncoder()
  for (const h of frame.headers) {
    const kBytes = enc.encode(h.key)
    const vBytes = enc.encode(h.value)

    const hBuf: number[] = []
    hBuf.push(0x0a) // field 1, wire 2
    hBuf.push(...encodeVarint(kBytes.length))
    hBuf.push(...kBytes)
    hBuf.push(0x12) // field 2, wire 2
    hBuf.push(...encodeVarint(vBytes.length))
    hBuf.push(...vBytes)

    const hBytes = new Uint8Array(hBuf)
    parts.push(new Uint8Array([0x2a])) // tag = (5 << 3) | 2
    parts.push(encodeVarint(hBytes.length))
    parts.push(hBytes)
  }

  // field 8: payload (bytes) — tag = (8 << 3) | 2 = 0x42
  if (frame.payload.length > 0) {
    parts.push(new Uint8Array([0x42]))
    parts.push(encodeVarint(frame.payload.length))
    parts.push(frame.payload)
  }

  return concat(parts)
}

function encodeVarint(n: number): Uint8Array {
  const out: number[] = []
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  out.push(n & 0x7f)
  return new Uint8Array(out)
}

function concat(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const a of arrays) {
    out.set(a, offset)
    offset += a.length
  }
  return out
}

/** Parse an incoming WebSocket binary message into a WsFrame.
 * The raw WebSocket bytes ARE the protobuf — no length prefix. */
function parseWsMessage(data: ArrayBuffer): WsFrame {
  return decodeFrame(new Uint8Array(data))
}

// ---------------------------------------------------------------------------
// WSClient — long-connection to Feishu
// ---------------------------------------------------------------------------

const WS_FRAME_TYPE_CONTROL = 0
const WS_FRAME_TYPE_DATA = 1
const WS_MSG_TYPE_EVENT = 'event'
const WS_MSG_TYPE_PING = 'ping'
const WS_MSG_TYPE_PONG = 'pong'

/** Reconnect back-off: doubles each attempt, capped at 60 s. */
function nextDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 60_000)
}

interface WSClientOptions {
  appId: string
  appSecret: string
  loggerLevel?: LoggerLevel
}

interface WSStartOptions {
  eventDispatcher: EventDispatcher
}

type Logger = {
  info: (...a: unknown[]) => void
  warn: (...a: unknown[]) => void
  debug: (...a: unknown[]) => void
}

class WSClient {
  private appId: string
  private appSecret: string
  private loggerLevel: LoggerLevel
  private _tokens: TokenManager
  private _ws: WebSocket | null = null
  private _closed = false
  private _pingTimer: ReturnType<typeof setInterval> | null = null
  private _dispatcher: EventDispatcher | null = null
  private _logger: Logger
  /** Deduplication cache: message_id → expiry timestamp (ms) */
  private _seenMessages = new Map<string, { expiry: number; response: Promise<{ code: number; data?: unknown }> }>()
  private static readonly _SEEN_TTL_MS = 5 * 60 * 1000 // 5 minutes

  constructor(opts: WSClientOptions) {
    this.appId = opts.appId
    this.appSecret = opts.appSecret
    this.loggerLevel = opts.loggerLevel ?? LoggerLevel.info
    this._tokens = new TokenManager(opts.appId, opts.appSecret)
    this._logger = this._makeLogger()
  }

  private _makeLogger(): Logger {
    const level = this.loggerLevel
    const noop = () => {}
    return {
      info: level >= LoggerLevel.info
        ? (...a) => console.info('[feishu_sdk ws]', ...a)
        : noop,
      warn: level >= LoggerLevel.warn
        ? (...a) => console.warn('[feishu_sdk ws]', ...a)
        : noop,
      debug: level >= LoggerLevel.debug
        ? (...a) => console.debug('[feishu_sdk ws]', ...a)
        : noop,
    }
  }

  /**
   * Start the WebSocket connection. Resolves immediately;
   * connection and reconnection happen in the background.
   */
  async start(opts: WSStartOptions): Promise<void> {
    this._dispatcher = opts.eventDispatcher
    this._closed = false
    await this._connect(0)
  }

  /** Gracefully close the WebSocket. */
  close(): void {
    this._closed = true
    this._stopPing()
    if (this._ws) {
      try {
        this._ws.close()
      } catch { /* ignore */ }
      this._ws = null
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async _fetchWsEndpoint(): Promise<
    { url: string; pingInterval: number }
  > {
    // The WS config endpoint authenticates via AppID+AppSecret in the body,
    // NOT via a tenant-access-token. Field names are PascalCase.
    const resp = await fetch(WS_CONFIG_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'locale': 'zh',
      },
      body: JSON.stringify({ AppID: this.appId, AppSecret: this.appSecret }),
    })
    if (!resp.ok) throw new Error(`[feishu_sdk] ws config HTTP ${resp.status}`)
    const json = (await resp.json()) as {
      code: number
      msg: string
      data?: { URL: string; ClientConfig?: { PingInterval?: number } }
    }
    if (json.code !== 0) {
      throw new Error(
        `[feishu_sdk] ws config error code=${json.code} msg=${json.msg}`,
      )
    }
    const pingInterval = (json.data?.ClientConfig?.PingInterval ?? 120) * 1000
    return { url: json.data!.URL, pingInterval }
  }

  private async _connect(attempt: number): Promise<void> {
    if (this._closed) return
    try {
      const { url, pingInterval } = await this._fetchWsEndpoint()
      this._logger.info(`Connecting (attempt ${attempt}) → ${url}`)
      const ws = new WebSocket(url)
      this._ws = ws

      ws.addEventListener('open', () => {
        this._logger.info('Connected')
        this._startPing(pingInterval)
      })

      ws.addEventListener('message', (evt) => {
        // WebSocket binary messages may arrive as Blob or ArrayBuffer.
        const data = evt.data
        if (data instanceof ArrayBuffer) {
          this._handleBinary(data).catch((err) =>
            this._logger.warn('handleBinary error', err)
          )
        } else if (data instanceof Blob) {
          data.arrayBuffer().then((buf) => this._handleBinary(buf)).catch((
            err,
          ) => this._logger.warn('handleBinary error', err))
        } else if (typeof data === 'string') {
          // Shouldn't happen in normal operation but handle gracefully
          this._logger.debug('text frame (ignored)', data.slice(0, 100))
        }
      })

      ws.addEventListener('close', (evt) => {
        this._stopPing()
        this._ws = null
        if (!this._closed) {
          const delay = nextDelay(attempt)
          this._logger.warn(
            `Disconnected (code=${evt.code}), reconnecting in ${delay}ms`,
          )
          setTimeout(() => this._connect(attempt + 1), delay)
        }
      })

      ws.addEventListener('error', (evt) => {
        this._logger.warn('WebSocket error', evt)
      })
    } catch (err) {
      if (!this._closed) {
        const delay = nextDelay(attempt)
        this._logger.warn(`Connection failed: ${err}; retry in ${delay}ms`)
        setTimeout(() => this._connect(attempt + 1), delay)
      }
    }
  }

  private _startPing(intervalMs = 120_000): void {
    this._stopPing()
    this._pingTimer = setInterval(() => {
      this._sendPing()
    }, intervalMs)
  }

  private _stopPing(): void {
    if (this._pingTimer !== null) {
      clearInterval(this._pingTimer)
      this._pingTimer = null
    }
  }

  private _sendPing(): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return
    const frame = encodeFrame({
      seqId: 0,
      logId: 0,
      service: 0,
      type: WS_FRAME_TYPE_CONTROL,
      headers: [{ key: 'type', value: WS_MSG_TYPE_PING }],
      payload: new Uint8Array(0),
    })
    try {
      this._ws.send(frame)
    } catch { /* ignore */ }
  }

  private async _handleBinary(data: ArrayBuffer): Promise<void> {
    let frame: WsFrame
    try {
      frame = parseWsMessage(data)
    } catch (err) {
      this._logger.warn('Failed to decode frame', err)
      return
    }

    const getHeader = (k: string) =>
      frame.headers.find((h) => h.key === k)?.value

    if (frame.type === WS_FRAME_TYPE_CONTROL) {
      const msgType = getHeader('type')
      if (msgType === WS_MSG_TYPE_PING) {
        // Server sent a ping (unusual) — ignore, we don't reply
        this._logger.debug('Received ping from server (ignored)')
      } else if (msgType === WS_MSG_TYPE_PONG) {
        // Server replied to our ping — payload may carry updated ClientConfig
        this._logger.debug('Received pong')
        if (frame.payload.length > 0) {
          try {
            const cfg = JSON.parse(new TextDecoder().decode(frame.payload)) as {
              PingInterval?: number
            }
            if (cfg.PingInterval) {
              this._logger.debug(
                `Updating ping interval to ${cfg.PingInterval}s`,
              )
              this._startPing(cfg.PingInterval * 1000)
            }
          } catch { /* ignore malformed pong payload */ }
        }
      }
      return
    }

    if (frame.type === WS_FRAME_TYPE_DATA) {
      const msgType = getHeader('type')
      if (msgType !== WS_MSG_TYPE_EVENT && msgType !== 'card') return

      const messageId = getHeader('message_id') ?? ''
      const sumStr = getHeader('sum')
      const seqStr = getHeader('seq')

      const sum = sumStr ? parseInt(sumStr, 10) : 1
      const seq = seqStr ? parseInt(seqStr, 10) : 1

      if (sum > 1) {
        this._logger.warn(
          `Multi-frame message (sum=${sum}, seq=${seq}) not yet supported; dropping`,
        )
        this._sendAck(frame, 200)
        return
      }

      // Deduplicate: if we have already dispatched this message_id, ACK and skip
      if (messageId) {
        const now = Date.now()
        // Evict expired entries
        for (const [id, entry] of this._seenMessages) {
          if (now > entry.expiry) this._seenMessages.delete(id)
        }
        const existing = this._seenMessages.get(messageId)
        if (existing) {
          this._logger.debug(
            `Duplicate message_id=${messageId}, ACKing without dispatch`,
          )
          const result = await existing.response
          this._sendAck(frame, result.code, 0, result.data)
          return
        }
      }

      // Parse event payload
      let eventObj: Record<string, unknown>
      try {
        eventObj = JSON.parse(new TextDecoder().decode(frame.payload))
      } catch (err) {
        this._logger.warn('Failed to JSON-parse event payload', err)
        this._sendAck(frame, 500)
        return
      }

      // Dispatch, then ACK with result code
      const startTime = Date.now()
      const response = (async (): Promise<{ code: number; data?: unknown }> => {
        try {
          return { code: 200, data: await this._dispatcher?.invoke(eventObj) }
        } catch {
          this._logger.warn('Dispatcher error')
          return { code: 500 }
        }
      })()
      if (messageId) {
        this._seenMessages.set(messageId, { expiry: Date.now() + WSClient._SEEN_TTL_MS, response })
        if (this._seenMessages.size > 1_000) this._seenMessages.delete(this._seenMessages.keys().next().value!)
      }
      const result = await response
      this._sendAck(frame, result.code, Date.now() - startTime, result.data)
    }
  }

  /**
   * Send an ACK response for a DATA frame.
   * Echoes all original headers, appends biz_rt, and sets payload to {code}.
   */
  private _sendAck(frame: WsFrame, code: number, elapsedMs = 0, data?: unknown): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return
    const ackHeaders: WsHeader[] = [
      ...frame.headers,
      { key: 'biz_rt', value: String(elapsedMs) },
    ]
    const payload = new TextEncoder().encode(JSON.stringify({
      code,
      ...(data === undefined ? {} : { data: Buffer.from(JSON.stringify(data)).toString('base64') }),
    }))
    // Echo SeqID, LogID, service back so the server can correlate the ACK
    // to the delivered event and mark it as acknowledged.
    const ack = encodeFrame({
      seqId: frame.seqId,
      logId: frame.logId,
      service: frame.service,
      type: WS_FRAME_TYPE_DATA,
      headers: ackHeaders,
      payload,
    })
    try {
      this._ws.send(ack)
    } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Convenience re-export (matches original SDK for drop-in usage in feishu.ts)
// ---------------------------------------------------------------------------

export { Client, EventDispatcher, WSClient }
