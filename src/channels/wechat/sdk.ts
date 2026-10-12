import { projectStoragePath } from '../../utils/data-paths.ts'
/**
 * weixin_sdk.ts
 *
 * WeChat iLink Bot SDK — protocol-level primitives for the WeChat iLink Bot API.
 *
 * Covers:
 *  - Domain types  (login, message, CDN media)
 *  - Configuration constants + env resolution
 *  - HTTP API client  (QR login, getupdates, sendmessage)
 *  - JSON file repository  (accounts, sessions, context tokens, sync state, dedup)
 *  - CDN media download + AES-128-ECB decryption
 *
 * The channel implementation (wechat.ts) imports from this module.
 */

import { createDecipheriv } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { env } from 'node:process'
import { join } from 'node:path'

// ===========================================================================
// Types
// ===========================================================================

// ── Login types ─────────────────────────────────────────────────────────────

export type WeixinLoginStatus =
  | 'pending'
  | 'scanned'
  | 'confirmed'
  | 'expired'
  | 'failed'

export interface WeixinAccountRecord {
  readonly accountId: string
  readonly baseUrl: string
  readonly botToken: string
  readonly linkedUserId?: string
  readonly savedAt: string
}

export interface WeixinLoginSessionRecord {
  readonly sessionKey: string
  readonly qrcode: string
  readonly qrcodeUrl: string
  readonly baseUrl: string
  readonly botType: string
  readonly status: WeixinLoginStatus
  readonly accountId?: string
  readonly linkedUserId?: string
  readonly startedAt: string
  readonly updatedAt: string
}

export interface WeixinQrCodeResponse {
  readonly qrcode: string
  readonly qrcode_img_content: string
}

export interface WeixinQrStatusResponse {
  readonly status: 'wait' | 'scaned' | 'confirmed' | 'expired'
  readonly bot_token?: string
  readonly ilink_bot_id?: string
  readonly baseurl?: string
  readonly ilink_user_id?: string
}

export interface WeixinLoginStartResult {
  readonly sessionKey: string
  readonly qrcodeUrl: string
  readonly baseUrl: string
  readonly botType: string
}

export interface WeixinLoginWaitResult {
  readonly connected: boolean
  readonly message: string
  readonly accountId?: string
  readonly linkedUserId?: string
}

// ── Message types ───────────────────────────────────────────────────────────

export const WeixinMessageType = { USER: 1, BOT: 2 } as const
export const WeixinMessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const
export const WeixinMessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const

export interface WeixinCDNMedia {
  readonly encrypt_query_param?: string
  readonly aes_key?: string
  readonly encrypt_type?: number
}

export interface WeixinTextItem {
  readonly text?: string
}
export interface WeixinVoiceItem {
  readonly media?: WeixinCDNMedia
  readonly encode_type?: number
  readonly sample_rate?: number
  readonly playtime?: number
  readonly text?: string
}
export interface WeixinImageItem {
  readonly media?: WeixinCDNMedia
  readonly thumb_media?: WeixinCDNMedia
  readonly aeskey?: string
  readonly mid_size?: number
  readonly thumb_size?: number
  readonly thumb_height?: number
  readonly thumb_width?: number
  readonly hd_size?: number
  readonly data?: string
  readonly format?: string
}
export interface WeixinFileItem {
  readonly media?: WeixinCDNMedia
  readonly file_name?: string
  readonly md5?: string
  readonly len?: string
}
export interface WeixinVideoItem {
  readonly media?: WeixinCDNMedia
  readonly thumb_media?: WeixinCDNMedia
  readonly video_size?: number
  readonly play_length?: number
  readonly video_md5?: string
  readonly thumb_size?: number
  readonly thumb_height?: number
  readonly thumb_width?: number
}
export interface WeixinRefMessage {
  readonly title?: string
  readonly message_item?: WeixinMessageItem
}

export interface WeixinMessageItem {
  readonly type?: number
  readonly text_item?: WeixinTextItem
  readonly voice_item?: WeixinVoiceItem
  readonly image_item?: WeixinImageItem
  readonly file_item?: WeixinFileItem
  readonly video_item?: WeixinVideoItem
  readonly ref_msg?: WeixinRefMessage
}

export interface WeixinMessage {
  readonly message_id?: number
  readonly from_user_id?: string
  readonly to_user_id?: string
  readonly client_id?: string
  readonly session_id?: string
  readonly message_type?: number
  readonly message_state?: number
  readonly item_list?: readonly WeixinMessageItem[]
  readonly context_token?: string
}

export interface WeixinGetUpdatesResponse {
  readonly ret?: number
  readonly errcode?: number
  readonly errmsg?: string
  readonly msgs?: readonly WeixinMessage[]
  readonly get_updates_buf?: string
  readonly longpolling_timeout_ms?: number
}

// ── Media result ────────────────────────────────────────────────────────────

export interface InboundMediaResult {
  readonly filePath: string
  readonly mimeType: string
  readonly fileName?: string
}

// ===========================================================================
// Configuration
// ===========================================================================

export const DEFAULT_WEIXIN_API_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const DEFAULT_WEIXIN_BOT_TYPE = '3'
export const DEFAULT_WEIXIN_WAIT_TIMEOUT_MS = 180_000
export const WEIXIN_POLL_INTERVAL_MS = 1_000
export const WEIXIN_POLL_REQUEST_TIMEOUT_MS = 35_000
export const CHANNEL_VERSION = 'shadow-wechat-2.0'

export function resolveRouteTag(): string | undefined {
  const raw = env.WEIXIN_ROUTE_TAG?.trim()
  return raw || undefined
}

export function resolveWeixinBaseUrl(): string {
  const raw = env.WEIXIN_API_BASE_URL?.trim()
  return raw || DEFAULT_WEIXIN_API_BASE_URL
}

// ===========================================================================
// HTTP API Client
// ===========================================================================

function buildUrl(
  baseUrl: string,
  pathname: string,
  params: Record<string, string> = {},
): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const url = new URL(pathname, base)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.toString()
}

function buildHeaders(routeTag?: string): Record<string, string> {
  const h: Record<string, string> = {}
  if (routeTag) h['SKRouteTag'] = routeTag
  return h
}

function randomWechatUin(): string {
  const arr = new Uint8Array(4)
  crypto.getRandomValues(arr)
  const view = new DataView(arr.buffer)
  return btoa(String(view.getUint32(0)))
}

function buildAuthHeaders(
  token: string,
  body: string,
  routeTag?: string,
): Record<string, string> {
  const h = buildHeaders(routeTag)
  h['Content-Type'] = 'application/json'
  h['AuthorizationType'] = 'ilink_bot_token'
  h['Authorization'] = `Bearer ${token}`
  h['X-WECHAT-UIN'] = randomWechatUin()
  return h
}

function buildBaseInfo(): { channel_version: string } {
  return { channel_version: CHANNEL_VERSION }
}

async function readJson<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => '(unreadable)')
    throw new Error(
      `${label} failed: ${response.status} ${response.statusText} ${body}`,
    )
  }
  return response.json() as Promise<T>
}

function withTimeout(timeoutMs: number): AbortController {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  if (typeof (id as unknown as { unref?: () => void }).unref === 'function') {
    ;(id as unknown as { unref: () => void }).unref()
  }
  return controller
}

export class WeixinApiClient {
  constructor(private readonly routeTag?: string) {}

  async fetchQrCode(
    baseUrl: string,
    botType: string,
  ): Promise<WeixinQrCodeResponse> {
    const url = buildUrl(baseUrl, 'ilink/bot/get_bot_qrcode', {
      bot_type: botType,
    })
    const res = await fetch(url, { headers: buildHeaders(this.routeTag) })
    return readJson<WeixinQrCodeResponse>(res, 'fetchQrCode')
  }

  async fetchQrStatus(
    baseUrl: string,
    qrcode: string,
    timeoutMs = WEIXIN_POLL_REQUEST_TIMEOUT_MS,
  ): Promise<WeixinQrStatusResponse> {
    const url = buildUrl(baseUrl, 'ilink/bot/get_qrcode_status', { qrcode })
    const controller = withTimeout(timeoutMs)
    try {
      const res = await fetch(url, {
        headers: {
          ...buildHeaders(this.routeTag),
          'iLink-App-ClientVersion': '1',
        },
        signal: controller.signal,
      })
      return await readJson<WeixinQrStatusResponse>(res, 'fetchQrStatus')
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { status: 'wait' }
      }
      throw err
    }
  }

  async getUpdates(
    baseUrl: string,
    token: string,
    getUpdatesBuf: string,
  ): Promise<WeixinGetUpdatesResponse> {
    const body = JSON.stringify({
      get_updates_buf: getUpdatesBuf,
      base_info: buildBaseInfo(),
    })
    const res = await fetch(buildUrl(baseUrl, 'ilink/bot/getupdates'), {
      method: 'POST',
      headers: buildAuthHeaders(token, body, this.routeTag),
      body,
    })
    return readJson<WeixinGetUpdatesResponse>(res, 'getUpdates')
  }

  async sendMessage(
    baseUrl: string,
    token: string,
    payload: { msg: WeixinMessage },
  ): Promise<void> {
    const body = JSON.stringify({ ...payload, base_info: buildBaseInfo() })
    const res = await fetch(buildUrl(baseUrl, 'ilink/bot/sendmessage'), {
      method: 'POST',
      headers: buildAuthHeaders(token, body, this.routeTag),
      body,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '(unreadable)')
      throw new Error(
        `sendMessage failed: ${res.status} ${res.statusText} ${text}`,
      )
    }
    await res.text()
  }
}

// ===========================================================================
// JSON File Repository
// ===========================================================================

/** Maximum number of seen-message keys kept in memory / on disk. */
const SEEN_MAX = 5000

interface RepoData {
  account: WeixinAccountRecord | null
  loginSession: WeixinLoginSessionRecord | null
  contextTokens: Record<string, string>
  syncStates: Record<string, string>
  seenMessages: string[]
}

function emptyData(): RepoData {
  return {
    account: null,
    loginSession: null,
    contextTokens: {},
    syncStates: {},
    seenMessages: [],
  }
}

function readJsonFile<T>(path: string, fallback: T): T {
  try {
    const text = readFileSync(path, 'utf8')
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

function writeJsonFile(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2))
}

export class WeixinRepository {
  private dir: string
  private data: RepoData
  private seenSet: Set<string>

  constructor(workspace: string) {
    this.dir = projectStoragePath(workspace, 'wechat')
    mkdirSync(this.dir, { recursive: true })
    this.data = this._load()
    this.seenSet = new Set(this.data.seenMessages)
  }

  // ── Accounts ────────────────────────────────────────────────────────────

  saveAccount(account: WeixinAccountRecord): void {
    this.data.account = account
    this._save('account.json', this.data.account)
  }

  getLatestAccount(): WeixinAccountRecord | null {
    return this.data.account
  }

  // ── Login sessions ──────────────────────────────────────────────────────

  saveLoginSession(session: WeixinLoginSessionRecord): void {
    this.data.loginSession = session
    this._save('login-session.json', this.data.loginSession)
  }

  getLatestLoginSession(): WeixinLoginSessionRecord | null {
    return this.data.loginSession
  }

  updateLoginStatus(
    sessionKey: string,
    status: WeixinLoginStatus,
    accountId?: string,
    linkedUserId?: string,
  ): void {
    if (this.data.loginSession?.sessionKey === sessionKey) {
      this.data.loginSession = {
        ...this.data.loginSession,
        status,
        accountId,
        linkedUserId,
        updatedAt: new Date().toISOString(),
      }
      this._save('login-session.json', this.data.loginSession)
    }
  }

  // ── Context tokens ──────────────────────────────────────────────────────

  saveContextToken(chatId: string, contextToken: string): void {
    this.data.contextTokens[chatId] = contextToken
    this._save('context-tokens.json', this.data.contextTokens)
  }

  getContextToken(chatId: string): string | null {
    return this.data.contextTokens[chatId] ?? null
  }

  // ── Sync state ──────────────────────────────────────────────────────────

  saveSyncState(accountId: string, getUpdatesBuf: string): void {
    this.data.syncStates[accountId] = getUpdatesBuf
    this._save('sync-state.json', this.data.syncStates)
  }

  getSyncState(accountId: string): { getUpdatesBuf: string } | null {
    const buf = this.data.syncStates[accountId]
    return buf ? { getUpdatesBuf: buf } : null
  }

  // ── Message dedup ───────────────────────────────────────────────────────

  tryMarkMessageSeen(messageKey: string): boolean {
    if (this.seenSet.has(messageKey)) return false
    this.seenSet.add(messageKey)
    this.data.seenMessages.push(messageKey)
    // Evict oldest entries when exceeding the cap
    if (this.data.seenMessages.length > SEEN_MAX) {
      const removed = this.data.seenMessages.splice(
        0,
        this.data.seenMessages.length - SEEN_MAX,
      )
      for (const key of removed) this.seenSet.delete(key)
    }
    this._save('seen-messages.json', this.data.seenMessages)
    return true
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  close(): void {
    // No resources to release for JSON storage.
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private _load(): RepoData {
    return {
      account: readJsonFile<WeixinAccountRecord | null>(
        join(this.dir, 'account.json'),
        null,
      ),
      loginSession: readJsonFile<WeixinLoginSessionRecord | null>(
        join(this.dir, 'login-session.json'),
        null,
      ),
      contextTokens: readJsonFile<Record<string, string>>(
        join(this.dir, 'context-tokens.json'),
        {},
      ),
      syncStates: readJsonFile<Record<string, string>>(
        join(this.dir, 'sync-state.json'),
        {},
      ),
      seenMessages: readJsonFile<string[]>(
        join(this.dir, 'seen-messages.json'),
        [],
      ),
    }
  }

  private _save(filename: string, data: unknown): void {
    writeJsonFile(join(this.dir, filename), data)
  }
}

// ===========================================================================
// CDN Media Download + AES-128-ECB Decryption
// ===========================================================================

const CDN_HOST = 'https://novac2c.cdn.weixin.qq.com'

function buildCdnUrl(encryptQueryParam: string): string {
  return `${CDN_HOST}/c2c?${encryptQueryParam}`
}

/**
 * Parse the AES key from WeChat – handles:
 *   1. Raw 16-byte key encoded as Base64 (16 bytes → 24 chars)
 *   2. Hex string encoded as Base64 (32 hex chars → 44 chars)
 */
function parseAesKey(raw: string): Buffer {
  const buf = Buffer.from(raw, 'base64')
  if (buf.length === 16) return buf

  const hex = buf.toString('utf-8')
  if (/^[0-9a-fA-F]{32}$/.test(hex)) return Buffer.from(hex, 'hex')

  if (buf.length > 16) return buf.subarray(0, 16)
  const padded = Buffer.alloc(16)
  buf.copy(padded)
  return padded
}

function decryptAes128Ecb(
  data: Uint8Array,
  keyBase64: string,
): Uint8Array<ArrayBuffer> {
  const key = parseAesKey(keyBase64)
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  decipher.setAutoPadding(true)
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()])
  return new Uint8Array(
    decrypted.buffer,
    decrypted.byteOffset,
    decrypted.byteLength,
  ) as Uint8Array<ArrayBuffer>
}

function guessMimeType(data: Uint8Array): string {
  if (data.length < 4) return 'application/octet-stream'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
  ) return 'image/png'
  if (
    data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38
  ) return 'image/gif'
  if (
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 &&
    data[3] === 0x46 && data.length >= 12 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 &&
    data[11] === 0x50
  ) return 'image/webp'
  if (
    data.length >= 8 && data[4] === 0x66 && data[5] === 0x74 &&
    data[6] === 0x79 && data[7] === 0x70
  ) return 'video/mp4'
  if (
    data.length >= 7 && data[0] === 0x02 && data[1] === 0x23 &&
    data[2] === 0x21 && data[3] === 0x53
  ) return 'audio/silk'
  return 'application/octet-stream'
}

function extensionForMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return '.jpg'
    case 'image/png':
      return '.png'
    case 'image/gif':
      return '.gif'
    case 'image/webp':
      return '.webp'
    case 'video/mp4':
      return '.mp4'
    case 'audio/silk':
      return '.silk'
    default:
      return '.bin'
  }
}

export async function downloadMedia(
  encryptQueryParam: string,
  aesKey: string | undefined,
  mediaDir: string,
  fileName?: string,
): Promise<InboundMediaResult> {
  mkdirSync(mediaDir, { recursive: true })

  const url = buildCdnUrl(encryptQueryParam)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(
      `CDN download failed: ${response.status} ${response.statusText}`,
    )
  }

  let data = new Uint8Array(await response.arrayBuffer())

  if (aesKey) {
    data = decryptAes128Ecb(data, aesKey)
  }

  const mimeType = guessMimeType(data)
  const ext = extensionForMime(mimeType)
  const baseName = fileName ?? `wx-${Date.now()}${ext}`
  const filePath = join(mediaDir, baseName)

  await writeFile(filePath, data)

  return { filePath, mimeType, fileName: baseName }
}
