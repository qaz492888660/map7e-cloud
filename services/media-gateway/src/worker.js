import { OFFICIAL_CLIENT_ID, OFFICIAL_SIGN_KEY } from '../../../lib/storage/providers/quark-client.js'
import { QUARK_FILE_SIZE_LIMIT, quarkDownloadLimit, quarkDownloadLimitBody } from '../../../lib/storage/quark-download-limit.js'
import { createMediaDiagnostics, diagnosticResponseHeaders } from './diagnostics.js'
import { createMediaProbeScope, MEDIA_PROBE_TIMEOUT_MS, MEDIA_PROBE_RESPONSE_MARGIN_MS, MEDIA_PROBE_DEADLINE_HEADER, MEDIA_PROBE_DEADLINE_ERROR } from '../../../lib/storage/media-probe.js'

export const MEDIA_GATEWAY_VERSION = '0.2.15'
export const MEDIA_SESSION_COOKIE = '__Secure-map7e-media-'
const LEGACY_MEDIA_SESSION_COOKIE = '__Host-map7e-media-'
const MEDIA_SESSION_COOKIE_HEADER_MAX_LENGTH = 65_536
const MEDIA_SESSION_COOKIE_MAX_EVICTIONS = 32
const MAX_RANGE_LENGTH = 128
const QUARK_REFRESH_LOCK_WAIT_ATTEMPTS = 120
const QUARK_API = 'https://open-api-drive.quark.cn'
const STORE_PREFIX = 'map7e-cloud:'
const STORAGE_TTL_MS = 10_000
const MEDIA_CDN_HEADER_TIMEOUT_MS = 15_000
const MEDIA_URL_TTL_MS = 30_000
const MEDIA_URL_MARGIN_MS = 5 * 60 * 1000
const MEDIA_PURPOSES = new Set(['preview', 'original', 'video'])
const PREVIEW_VARIANTS = new Set(['preview', 'thumbnail'])
const REDIS_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const QUARK_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const READ_PATHS = new Set([
  '/open/v1/file/info',
  '/open/v1/file/get_download_url',
])
const RASTER_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'heic', 'heif', 'jpe', 'jpeg', 'jpg', 'png', 'tif', 'tiff', 'webp'])
const IMAGE_TYPES = new Set([
  'image/avif', 'image/bmp', 'image/gif', 'image/heic', 'image/heif', 'image/x-icon',
  'image/jpeg', 'image/png', 'image/svg+xml', 'image/tiff', 'image/webp',
])
const MIME_BY_EXTENSION = new Map([
  ['avif', 'image/avif'], ['bmp', 'image/bmp'], ['gif', 'image/gif'], ['heic', 'image/heic'],
  ['heif', 'image/heif'], ['jpe', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['jpg', 'image/jpeg'],
  ['png', 'image/png'], ['tif', 'image/tiff'], ['tiff', 'image/tiff'], ['webp', 'image/webp'],
  ['mp4', 'video/mp4'], ['m4v', 'video/mp4'], ['mov', 'video/quicktime'], ['webm', 'video/webm'],
  ['mkv', 'video/x-matroska'], ['avi', 'video/x-msvideo'], ['mpeg', 'video/mpeg'], ['mpg', 'video/mpeg'],
  ['3gp', 'video/3gpp'], ['3g2', 'video/3gpp2'], ['m2ts', 'video/mp2t'], ['mts', 'video/mp2t'],
  ['ts', 'video/mp2t'], ['ogv', 'video/ogg'], ['wmv', 'video/x-ms-wmv'],
  ['mp3', 'audio/mpeg'], ['m4a', 'audio/mp4'], ['pdf', 'application/pdf'],
])
const PREVIEW_KEYS = ['image_preview_url', 'preview_url', 'preview_image_url', 'image_preview', 'preview_image', 'preview']
const THUMBNAIL_KEYS = ['thumbnail_url', 'thumbnail_link', 'thumbnail', 'thumb_url', 'thumb', 'image_thumbnail_url', 'image_thumbnail', 'icon_link']
const UNLOCK_LOCK_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0"
const downloadUrlCache = new Map()
const storageReadCaches = new WeakMap()
const encoder = new TextEncoder()

class GatewayError extends Error {
  constructor(code, status = 502, headers = {}) {
    super(code)
    this.code = code
    this.status = status
    this.headers = headers
  }
}

function bytesToBase64Url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

function base64UrlToBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 32768) throw new Error('invalid_base64url')
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

async function hmacKey(secret) {
  if (typeof secret !== 'string' || encoder.encode(secret).byteLength < 32) {
    throw new GatewayError('media_gateway_not_configured', 503)
  }
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

async function hmacBytes(secret, value) {
  const key = await hmacKey(secret)
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)))
}

function isSafeIdentity(value, required = false) {
  return typeof value === 'string'
    && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !(required && value.length === 0)
}

function validClaims(claims) {
  if (!claims || typeof claims !== 'object' || claims.version !== 1) return false
  if (claims.grantType !== 'ticket' && claims.grantType !== 'session') return false
  if (typeof claims.storageId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(claims.storageId)) return false
  if (!isSafeIdentity(claims.fileId, true) || !isSafeIdentity(claims.parentId)) return false
  if (!MEDIA_PURPOSES.has(claims.purpose)) return false
  if (claims.purpose === 'preview') {
    if (!PREVIEW_VARIANTS.has(claims.variant)) return false
  } else if (claims.variant !== undefined) return false
  if (claims.disposition !== undefined && !['inline', 'attachment'].includes(claims.disposition)) return false
  return Number.isSafeInteger(claims.issuedAt)
    && Number.isSafeInteger(claims.expiresAt)
    && claims.expiresAt > claims.issuedAt
}

function sameMediaIdentity(left, right) {
  if (!left || !right) return false
  const defaultDisposition = claims => claims.disposition
    ?? (claims.purpose === 'preview' ? 'inline' : 'attachment')
  return ['storageId', 'fileId', 'parentId', 'purpose', 'variant'].every(key => left[key] === right[key])
    && defaultDisposition(left) === defaultDisposition(right)
}

export async function verifyGrant(token, secret, { now = Date.now(), grantType, allowExpired = false } = {}) {
  if (typeof token !== 'string' || token.length > 4096) throw new GatewayError('media_ticket_invalid', 401)
  const parts = token.split('.')
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) {
    throw new GatewayError('media_ticket_invalid', 401)
  }
  let validSignature = false
  try {
    const key = await hmacKey(secret)
    validSignature = await crypto.subtle.verify('HMAC', key, base64UrlToBytes(parts[1]), encoder.encode(parts[0]))
  } catch (error) {
    if (error instanceof GatewayError) throw error
  }
  if (!validSignature) throw new GatewayError('media_ticket_invalid', 401)
  let claims
  try { claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[0]))) } catch {
    throw new GatewayError('media_ticket_invalid', 401)
  }
  if (!validClaims(claims) || claims.grantType !== grantType) throw new GatewayError('media_ticket_invalid', 401)
  const current = Math.floor(now / 1000)
  const maxLifetime = grantType === 'ticket' ? 5 * 60 : 6 * 60 * 60
  if (claims.issuedAt > current + 30 || claims.expiresAt - claims.issuedAt > maxLifetime) {
    throw new GatewayError('media_ticket_invalid', 401)
  }
  if (claims.expiresAt <= current && !(allowExpired && grantType === 'ticket')) {
    throw new GatewayError('media_ticket_expired', 401)
  }
  return claims
}

async function signClaims(claims, secret) {
  const encoded = bytesToBase64Url(encoder.encode(JSON.stringify(claims)))
  return encoded + '.' + bytesToBase64Url(await hmacBytes(secret, encoded))
}

async function makeSession(claims, secret) {
  const issuedAt = claims.issuedAt
  const session = {
    version: claims.version,
    grantType: 'session',
    storageId: claims.storageId,
    fileId: claims.fileId,
    parentId: claims.parentId,
    purpose: claims.purpose,
    ...(claims.variant === undefined ? {} : { variant: claims.variant }),
    ...(claims.disposition === undefined ? {} : { disposition: claims.disposition }),
    issuedAt,
    expiresAt: claims.grantType === 'session' ? Math.min(claims.expiresAt, issuedAt + 6 * 60 * 60) : issuedAt + 6 * 60 * 60,
  }
  if (!validClaims(session)) throw new GatewayError('media_ticket_invalid', 401)
  return signClaims(session, secret)
}

async function mediaSessionCookieName(claims, secret) {
  const disposition = claims.disposition ?? (claims.purpose === 'preview' ? 'inline' : 'attachment')
  const identity = JSON.stringify([
    claims.storageId, claims.fileId, claims.parentId, claims.purpose,
    claims.purpose === 'preview' ? claims.variant ?? null : null, disposition,
  ])
  return MEDIA_SESSION_COOKIE + bytesToBase64Url(await hmacBytes(secret, identity)).slice(0, 22)
}

async function mediaSessionPath(claims, secret) {
  return '/v1/media/' + (await mediaSessionCookieName(claims, secret)).slice(MEDIA_SESSION_COOKIE.length)
}

function readCookies(header, cookieName) {
  if (typeof header !== 'string' || header.length > MEDIA_SESSION_COOKIE_HEADER_MAX_LENGTH) return []
  const values = []
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== cookieName) continue
    const value = part.slice(separator + 1).trim()
    if (/^[A-Za-z0-9_.-]{40,4096}$/.test(value)) values.push(value)
    if (values.length > 4) return []
  }
  return values
}

async function mediaSessionCookieUpdates(header, secret, now, currentCookieName) {
  if (typeof header !== 'string' || header.length > MEDIA_SESSION_COOKIE_HEADER_MAX_LENGTH) return []
  const updates = []
  const seen = new Set()
  let budget = 3000
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    const name = part.slice(0, separator).trim()
    if ((!/^__Host-map7e-media-[A-Za-z0-9_-]{22}$/.test(name) && name !== '__Host-map7e-media') || seen.has(name)) continue
    seen.add(name)
    if (seen.size > MEDIA_SESSION_COOKIE_MAX_EVICTIONS) break
    const lines = [name + '=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict']
    try {
      const claims = await verifyGrant(part.slice(separator + 1).trim(), secret, { now, grantType: 'session' })
      const scopedName = await mediaSessionCookieName(claims, secret)
      if (name !== '__Host-map7e-media' && name !== LEGACY_MEDIA_SESSION_COOKIE + scopedName.slice(MEDIA_SESSION_COOKIE.length)) throw new Error('media_session_cookie_mismatch')
      if (scopedName !== currentCookieName) continue // Other valid grants migrate on their own file requests.
    } catch {}
    const length = lines.reduce((sum, line) => sum + encoder.encode(line).length, 0)
    // Bound legacy cleanup separately from the new file-scoped session.
    if (length > budget) continue
    budget -= length
    updates.push(...lines)
  }
  return updates
}

async function sessionFromCookie(header, expectedClaims, secret, now) {
  const cookieName = await mediaSessionCookieName(expectedClaims, secret)
  const legacyName = LEGACY_MEDIA_SESSION_COOKIE + cookieName.slice(MEDIA_SESSION_COOKIE.length)
  for (const name of [cookieName, legacyName, '__Host-map7e-media']) {
    for (const token of readCookies(header, name)) {
      try {
        const claims = await verifyGrant(token, secret, { now, grantType: 'session' })
        if (sameMediaIdentity(expectedClaims, claims)) return { claims, legacyToken: name === cookieName ? null : token }
      } catch {}
    }
  }
  return null
}

async function setSessionCookie(claims, secret, now, cookieHeader, legacyToken) {
  if (claims.purpose !== 'video' || claims.disposition !== 'inline') return null
  const cookies = await mediaSessionCookieUpdates(cookieHeader, secret, now, await mediaSessionCookieName(claims, secret))
  if (claims.grantType === 'ticket' || legacyToken) {
    const token = await makeSession(claims, secret)
    const expiresAt = claims.grantType === 'session' ? claims.expiresAt : claims.issuedAt + 6 * 60 * 60
    const maxAge = Math.max(0, expiresAt - Math.floor(now / 1000))
    if (maxAge > 0) cookies.push(await mediaSessionCookieName(claims, secret) + '=' + token
      + '; Path=' + await mediaSessionPath(claims, secret) + '; Max-Age=' + maxAge + '; Secure; HttpOnly; SameSite=Strict')
  }
  return cookies.length ? cookies : null
}

function rangeError(size) {
  return new GatewayError('range_not_satisfiable', 416, {
    'Content-Range': 'bytes */' + (Number.isSafeInteger(size) ? size : '*'),
  })
}

export function parseSingleRange(value, fileSize = null) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || value.length > MAX_RANGE_LENGTH || value.includes(',')) throw rangeError(fileSize)
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim())
  if (!match || (!match[1] && !match[2])) throw rangeError(fileSize)
  const start = match[1] ? Number(match[1]) : null
  const end = match[2] ? Number(match[2]) : null
  if ((start !== null && !Number.isSafeInteger(start))
    || (end !== null && !Number.isSafeInteger(end))
    || (start !== null && end !== null && start > end)
    || (start === null && end === 0)
    || (start !== null && Number.isSafeInteger(fileSize) && start >= fileSize)) throw rangeError(fileSize)
  return { header: 'bytes=' + match[1] + '-' + match[2], start, end }
}

function safeRangeForLog(value) {
  if (typeof value !== 'string') return null
  return value.length <= MAX_RANGE_LENGTH && /^[A-Za-z0-9=,-]+$/.test(value) ? value : 'invalid'
}

function safeMime(value) {
  const type = String(value || '').split(';', 1)[0].trim().toLowerCase()
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : null
}

function itemExtension(item) {
  return String(item.extension || String(item.name || '').split('.').pop() || '').toLowerCase()
}

function contentTypeFor(response, item, purpose) {
  const upstream = safeMime(response.headers.get('content-type'))
  const fromItem = safeMime(item.mimeType)
  const inferred = MIME_BY_EXTENSION.get(itemExtension(item)) || null
  if (purpose === 'video') {
    if (upstream && upstream.startsWith('video/')) return upstream
    if (upstream && upstream !== 'application/octet-stream') return null
    if (fromItem && fromItem.startsWith('video/')) return fromItem
    if (inferred && inferred.startsWith('video/')) return inferred
    return null
  }
  const type = upstream && upstream !== 'application/octet-stream'
    ? upstream
    : fromItem || inferred || upstream || 'application/octet-stream'
  if (purpose === 'preview' && !IMAGE_TYPES.has(type)) return null
  return type
}

function safeHeader(value, pattern) {
  return typeof value === 'string'
    && value.length <= 512
    && !/[\r\n\u0000-\u001f\u007f]/.test(value)
    && pattern.test(value)
    ? value
    : null
}

function safeContentRange(response) {
  return safeHeader(response.headers.get('content-range'), /^bytes (?:\d+-\d+|\*)\/(?:\d+|\*)$/i)
}

function validatePartialResponse(response, range, fileSize = null) {
  if (!range || (range.start === null && range.end === null)) return
  if (response.status === 416) return
  if (response.status !== 206) throw new GatewayError('range_not_supported', 502)
  const raw = safeContentRange(response)
  const match = raw && /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(raw)
  if (!match) throw new GatewayError('range_response_invalid', 502)
  const start = Number(match[1])
  const end = Number(match[2])
  const total = match[3] === '*' ? null : Number(match[3])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) throw new GatewayError('range_response_invalid', 502)
  if (total !== null && (!Number.isSafeInteger(total) || total <= end)) throw new GatewayError('range_response_invalid', 502)
  if (Number.isSafeInteger(fileSize) && total !== null && fileSize !== total) throw new GatewayError('range_response_invalid', 502)
  let expectedStart = null
  let expectedEnd = null
  if (range.start !== null) {
    expectedStart = range.start
    if (range.end !== null) expectedEnd = total === null ? range.end : Math.min(range.end, total - 1)
    else if (total !== null) expectedEnd = total - 1
  } else if (range.end !== null && total !== null) {
    expectedStart = Math.max(0, total - range.end)
    expectedEnd = total - 1
  } else if (range.end !== null && end - start + 1 > range.end) {
    throw new GatewayError('range_response_invalid', 502)
  }
  if ((expectedStart !== null && start !== expectedStart) || (expectedEnd !== null && end !== expectedEnd)) {
    throw new GatewayError('range_response_invalid', 502)
  }
  const lengthHeader = response.headers.get('content-length')
  if (lengthHeader !== null) {
    const length = Number(lengthHeader)
    if (!/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(length) || length !== end - start + 1) {
      throw new GatewayError('range_response_invalid', 502)
    }
  }
}

function corsHeaders(request, env) {
  const configured = env.MEDIA_GATEWAY_ALLOWED_ORIGIN || 'https://cloud.map7e.com'
  let allowed
  try { allowed = new URL(configured) } catch { throw new GatewayError('media_gateway_not_configured', 503) }
  if (allowed.protocol !== 'https:' || allowed.origin !== configured || allowed.pathname !== '/' || allowed.search || allowed.hash) {
    throw new GatewayError('media_gateway_not_configured', 503)
  }
  const siteDomain = env.MEDIA_GATEWAY_SITE_DOMAIN
  if (siteDomain !== undefined && siteDomain !== '') {
    if (typeof siteDomain !== 'string' || siteDomain !== siteDomain.toLowerCase()
      || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(siteDomain)) {
      throw new GatewayError('media_gateway_not_configured', 503)
    }
    const requestHost = new URL(request.url).hostname.toLowerCase()
    const isWithinSite = hostname => hostname === siteDomain || hostname.endsWith('.' + siteDomain)
    if (!isWithinSite(allowed.hostname.toLowerCase()) || !isWithinSite(requestHost)) {
      throw new GatewayError('media_gateway_site_mismatch', 403)
    }
  }
  const headers = new Headers({ Vary: 'Origin' })
  const origin = request.headers.get('origin')
  if (origin && origin !== configured) throw new GatewayError('origin_forbidden', 403)
  if (origin) {
    headers.set('Access-Control-Allow-Origin', configured)
    headers.set('Access-Control-Allow-Credentials', 'true')
    headers.set('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Range, Content-Length, Content-Type, Content-Disposition, ETag, Last-Modified')
  }
  return headers
}

function jsonResponse(status, code, headers = new Headers(), limitBytes) {
  const output = new Headers(headers)
  output.set('Content-Type', 'application/json; charset=utf-8')
  output.set('Cache-Control', 'no-store')
  output.set('X-Content-Type-Options', 'nosniff')
  return new Response(JSON.stringify(code === QUARK_FILE_SIZE_LIMIT ? quarkDownloadLimitBody(limitBytes) : { ok: false, error: code }), { status, headers: output })
}

function storageError(code, status = 502) {
  return new GatewayError(code, status)
}

function redisRequestErrorCode(error) {
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : ''
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || /timed out|timeout/.test(message)) return 'persistent_storage_request_timeout'
  if (/redirect/.test(message)) return 'persistent_storage_redirect_rejected'
  if (/signal/.test(message)) return 'persistent_storage_signal_invalid'
  if (/cache/.test(message)) return 'persistent_storage_cache_mode_unsupported'
  if (/dns|resolve|hostname/.test(message)) return 'persistent_storage_dns_failed'
  if (/tls|certificate/.test(message)) return 'persistent_storage_tls_failed'
  if (/network|fetch failed/.test(message)) return 'persistent_storage_network_failed'
  return 'persistent_storage_request_failed'
}

function quarkRequestErrorCode(error) {
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : ''
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || /timed out|timeout/.test(message)) return 'quark_request_timeout'
  if (/redirect/.test(message)) return 'quark_redirect_rejected'
  if (/signal/.test(message)) return 'quark_signal_invalid'
  if (/dns|resolve|hostname/.test(message)) return 'quark_dns_failed'
  if (/tls|certificate/.test(message)) return 'quark_tls_failed'
  if (/network|fetch failed/.test(message)) return 'quark_network_failed'
  return 'quark_unreachable'
}

function quarkResponseErrorCode(response, payload) {
  if (!response) return 'quark_unreachable'
  const errno = Number.isSafeInteger(payload && payload.errno) && payload.errno !== 0 ? payload.errno : null
  const apiStatus = Number.isSafeInteger(payload && payload.status) && payload.status !== 0 ? payload.status : null
  const upstreamCode = errno ?? apiStatus
  const apiSuffix = upstreamCode === null ? '' : '_api_' + Math.abs(upstreamCode)
  if (!response.ok) return 'quark_http_' + response.status + apiSuffix
  if (upstreamCode !== null && upstreamCode !== 0) return 'quark_api_error_' + Math.abs(upstreamCode)
  return 'quark_request_failed'
}

function storageIdValid(id) {
  return typeof id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(id)
}

function redisCredentials(env) {
  let url = env.UPSTASH_REDIS_REST_URL
  let token = env.UPSTASH_REDIS_REST_TOKEN
  if (!(url && token)) {
    url = env.KV_REST_API_URL
    token = env.KV_REST_API_TOKEN
  }
  if (!url || !token) throw storageError('media_gateway_not_configured', 503)
  let parsed
  try { parsed = new URL(url) } catch { throw storageError('media_gateway_not_configured', 503) }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.port && parsed.port !== '443')) {
    throw storageError('media_gateway_not_configured', 503)
  }
  return { base: parsed.toString().replace(/\/$/, ''), token }
}

async function redisPipeline(commands, env, fetchImpl) {
  const credentials = redisCredentials(env)
  const configuredHost = new URL(credentials.base).hostname.toLowerCase()
  let url = new URL(credentials.base + '/pipeline')
  let response
  for (let redirects = 0; ; redirects += 1) {
    let signal
    try { signal = AbortSignal.timeout(10_000) } catch {
      throw storageError('persistent_storage_timeout_signal_unavailable', 503)
    }
    try {
      response = await fetchImpl(url.toString(), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + credentials.token,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(commands),
        cache: 'no-store',
        redirect: 'manual',
        signal,
      })
    } catch (error) {
      throw storageError(redisRequestErrorCode(error), 503)
    }
    if (!REDIS_REDIRECT_STATUSES.has(response.status)) break

    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => {})
    if (!location || redirects >= 2) throw storageError('persistent_storage_redirect_rejected', 503)
    if (![307, 308].includes(response.status)) throw storageError('persistent_storage_redirect_method_unsupported', 503)

    let next
    try { next = new URL(location, url) } catch { throw storageError('persistent_storage_redirect_rejected', 503) }
    const hostname = next.hostname.toLowerCase()
    const trustedUpstashHost = hostname === 'upstash.io' || hostname.endsWith('.upstash.io')
    if (next.protocol !== 'https:' || next.username || next.password || (next.port && next.port !== '443')
      || (hostname !== configuredHost && !trustedUpstashHost)) {
      throw storageError('persistent_storage_redirect_host_rejected', 503)
    }
    url = next
  }
  let payload
  try { payload = await response.json() } catch { throw storageError('persistent_storage_response_invalid', 503) }
  if (!response.ok) throw storageError('persistent_storage_http_' + response.status, 503)
  if (!Array.isArray(payload) || payload.length !== commands.length || payload.some(item => item && item.error)) throw storageError('persistent_storage_payload_invalid', 503)
  return payload.map(item => item ? item.result : null)
}

function storageKey(kind, id = '') {
  return STORE_PREFIX + 'storage:' + kind + ':v1:' + id
}

function parseStored(value, code) {
  try { return typeof value === 'string' ? JSON.parse(value) : value } catch {
    throw storageError(code, 503)
  }
}

function storageReadCache(env) {
  if (!env || typeof env !== 'object') return null
  let cache = storageReadCaches.get(env)
  if (!cache) {
    cache = { entries: new Map(), pending: new Map(), generations: new Map() }
    storageReadCaches.set(env, cache)
  }
  return cache
}

async function cachedStorageRead(env, key, now, load) {
  const cache = storageReadCache(env)
  if (!cache) return load()
  const current = now()
  const entry = cache.entries.get(key)
  if (entry && entry.expiresAt > current) return entry.value
  if (entry) cache.entries.delete(key)
  const generation = cache.generations.get(key) || 0
  const pending = cache.pending.get(key)
  if (pending && pending.generation === generation) return pending.promise
  const promise = Promise.resolve().then(load).then(value => {
    if ((cache.generations.get(key) || 0) === generation) {
      cache.entries.set(key, { value, expiresAt: now() + STORAGE_TTL_MS })
    }
    return value
  }).finally(() => {
    if (cache.pending.get(key)?.promise === promise) cache.pending.delete(key)
  })
  cache.pending.set(key, { generation, promise })
  return promise
}

function updateCachedStorageRead(env, key, value, now) {
  const cache = storageReadCache(env)
  if (!cache) return
  const generation = (cache.generations.get(key) || 0) + 1
  cache.generations.set(key, generation)
  cache.pending.delete(key)
  cache.entries.set(key, { value, expiresAt: now() + STORAGE_TTL_MS })
}

async function storageConfig(env, fetchImpl, now = Date.now) {
  return cachedStorageRead(env, 'config', now, async () => {
    const values = await redisPipeline([['GET', storageKey('config')]], env, fetchImpl)
    if (values[0] == null) {
      return { version: 1, defaultStorageId: 'pikpak-main', instances: [
        { storageId: 'pikpak-main', provider: 'pikpak', displayName: 'PikPak', enabled: true },
        { storageId: 'quark-main', provider: 'quark', displayName: '夸克网盘', enabled: true },
      ] }
    }
    const config = parseStored(values[0], 'storage_config_invalid')
    const validInstance = instance => instance
      && storageIdValid(instance.storageId)
      && ['pikpak', 'quark'].includes(instance.provider)
      && typeof instance.displayName === 'string'
      && instance.displayName.length <= 80
      && typeof instance.enabled === 'boolean'
      && (instance.rootFolderId === undefined || instance.rootFolderId === null
        || (typeof instance.rootFolderId === 'string' && instance.rootFolderId.length <= 512))
      && (instance.rootFolderName === undefined || instance.rootFolderName === null
        || (typeof instance.rootFolderName === 'string' && instance.rootFolderName.length <= 255))
    if (config?.version !== 1 || !Array.isArray(config.instances) || config.instances.length < 1
      || config.instances.length > 50 || !config.instances.every(validInstance)
      || new Set(config.instances.map(instance => instance.storageId)).size !== config.instances.length
      || !config.instances.some(instance => instance.storageId === config.defaultStorageId)) {
      throw storageError('storage_config_invalid', 503)
    }
    return config
  })
}

async function encryptionKey(env) {
  const secret = env.STORAGE_ENCRYPTION_KEY || env.PIKPAK_PAT
  if (!secret) throw storageError('storage_encryption_not_configured', 503)
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode('map7e-storage-v1\u0000' + secret))
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['decrypt', 'encrypt'])
}

async function decryptStoredAuth(storageId, raw, env) {
  const sealed = parseStored(raw, 'storage_credentials_unreadable')
  if (!sealed || sealed.version !== 1 || typeof sealed.iv !== 'string'
    || typeof sealed.tag !== 'string' || typeof sealed.data !== 'string') {
    throw storageError('storage_credentials_unreadable', 503)
  }
  try {
    const iv = base64UrlToBytes(sealed.iv)
    const tag = base64UrlToBytes(sealed.tag)
    const data = base64UrlToBytes(sealed.data)
    if (iv.byteLength !== 12 || tag.byteLength !== 16) throw new Error('sealed_auth_invalid')
    const combined = new Uint8Array(data.byteLength + tag.byteLength)
    combined.set(data)
    combined.set(tag, data.byteLength)
    const key = await encryptionKey(env)
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(storageId), tagLength: 128 }, key, combined)
    const auth = JSON.parse(new TextDecoder().decode(plaintext))
    if (!auth || typeof auth.accessToken !== 'string' || !auth.accessToken) throw new Error('auth_missing')
    return auth
  } catch {
    throw storageError('storage_credentials_unreadable', 503)
  }
}

async function sealStoredAuth(storageId, auth, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await encryptionKey(env)
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(storageId), tagLength: 128 },
    key,
    encoder.encode(JSON.stringify(auth)),
  ))
  const split = encrypted.byteLength - 16
  return JSON.stringify({
    version: 1,
    iv: bytesToBase64Url(iv),
    tag: bytesToBase64Url(encrypted.slice(split)),
    data: bytesToBase64Url(encrypted.slice(0, split)),
  })
}

async function getStoredAuth(storageId, env, fetchImpl, now = Date.now, { bypassCache = false } = {}) {
  const key = 'auth:' + storageId
  const load = async () => {
    const authKey = storageKey('auth', storageId)
    const values = await redisPipeline([['GET', authKey]], env, fetchImpl)
    if (values[0] == null) throw storageError('storage_authorization_required', 409)
    return decryptStoredAuth(storageId, values[0], env)
  }
  if (bypassCache) {
    const auth = await load()
    updateCachedStorageRead(env, key, auth, now)
    return auth
  }
  return cachedStorageRead(env, key, now, load)
}

async function writeStoredAuth(storageId, auth, env, fetchImpl, now = Date.now) {
  const authKey = storageKey('auth', storageId)
  await redisPipeline([['SET', authKey, await sealStoredAuth(storageId, auth, env)]], env, fetchImpl)
  updateCachedStorageRead(env, 'auth:' + storageId, auth, now)
}

function authChanged(before, after) {
  return Boolean(after && after.accessToken && (
    after.accessToken !== before.accessToken
    || after.refreshToken !== before.refreshToken
    || after.accessExpiresAt !== before.accessExpiresAt
  ))
}

function timeoutSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeout
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout])
  const controller = new AbortController()
  const abort = event => controller.abort(event && event.target ? event.target.reason : undefined)
  for (const source of [signal, timeout]) {
    if (source.aborted) abort({ target: source })
    else source.addEventListener('abort', abort, { once: true })
  }
  return controller.signal
}

async function quarkHeaders(method, path, env, now) {
  const timestamp = String(now)
  const clientId = env.QUARK_CLIENT_ID || OFFICIAL_CLIENT_ID
  const signKey = env.QUARK_SIGN_KEY || OFFICIAL_SIGN_KEY
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(method + '&' + path + '&' + timestamp + '&' + signKey))
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-pan-client-id': clientId,
    'x-pan-tm': timestamp,
    'x-pan-token': Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
  }
}

function isAllowedQuarkApiUrl(url) {
  const host = url.hostname.toLowerCase()
  return url.protocol === 'https:'
    && !url.username
    && !url.password
    && (!url.port || url.port === '443')
    && !url.hash
    && (host === 'quark.cn' || host.endsWith('.quark.cn'))
}

async function fetchQuarkApi(url, { method, body, env, fetchImpl, now, signal }) {
  let currentUrl = new URL(url)
  let currentMethod = method
  let currentBody = body
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetchImpl(currentUrl.toString(), {
      method: currentMethod,
      headers: await quarkHeaders(currentMethod, currentUrl.pathname, env, now()),
      ...(currentBody === undefined ? {} : { body: JSON.stringify(currentBody) }),
      cache: 'no-store',
      redirect: 'manual',
      signal: timeoutSignal(signal, 15_000),
    })
    if (!QUARK_REDIRECT_STATUSES.has(response.status)) return response

    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => {})
    if (!location || redirects >= 2) throw storageError('quark_redirect_rejected', 502)
    let next
    try { next = new URL(location, currentUrl) } catch { throw storageError('quark_redirect_rejected', 502) }
    if (!isAllowedQuarkApiUrl(next)) throw storageError('quark_redirect_host_rejected', 502)

    if (response.status === 303 || ([301, 302].includes(response.status) && currentMethod === 'POST')) {
      currentMethod = 'GET'
      currentBody = undefined
    }
    for (const [name, value] of currentUrl.searchParams) {
      if (!next.searchParams.has(name)) next.searchParams.set(name, value)
    }
    currentUrl = next
  }
}

async function quarkRequest(path, { method = 'GET', query = {}, body, auth, env, fetchImpl, now, signal } = {}) {
  const url = new URL(path, QUARK_API)
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(name, String(value))
  }
  if (auth && auth.accessToken) {
    url.searchParams.set('access_token', auth.accessToken)
    if (auth.deviceId) url.searchParams.set('device_id', auth.deviceId)
  }
  const retryable = READ_PATHS.has(path) && ['GET', 'POST'].includes(method)
  const maxAttempts = retryable ? 2 : 1
  let response
  let payload
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    url.searchParams.set('req_id', crypto.randomUUID())
    try {
      response = await fetchQuarkApi(url, {
        method,
        body,
        env,
        fetchImpl,
        now,
        signal,
      })
    } catch (error) {
      if (error instanceof GatewayError) throw error
      if (attempt + 1 >= maxAttempts) throw storageError(quarkRequestErrorCode(error), 502)
      await new Promise(resolve => setTimeout(resolve, 250))
      continue
    }
    try {
      payload = await response.json()
      break
    } catch {
      if (attempt + 1 >= maxAttempts) throw storageError('quark_response_invalid', 502)
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  if (!response || !payload || !response.ok || payload.status !== 0 || (payload.errno && payload.errno !== 0)) {
    const message = String(payload && (payload.error_info || payload.agent_msg) || '')
    const authFailure = Boolean(response && response.status === 401) || /token|授权|认证/i.test(message)
    const limitBytes = quarkDownloadLimit(path, response, payload)
    const error = storageError(limitBytes !== null ? QUARK_FILE_SIZE_LIMIT : authFailure ? 'storage_token_expired' : quarkResponseErrorCode(response, payload), limitBytes !== null ? 422 : authFailure ? 401 : 502)
    if (limitBytes !== null) {
      error.limitBytes = limitBytes
      error.headers = { 'X-Media-Error': QUARK_FILE_SIZE_LIMIT, 'X-Media-Limit-Bytes': String(limitBytes) }
    }
    // Log fixed identities, numeric codes and an exact, allowlisted policy reason.
    // Never log URLs, payloads, raw messages, or request/response headers.
    error.quarkFailure = {
      upstreamStage: path === '/open/v1/file/info' ? 'quark_file_info'
        : path === '/open/v1/file/get_download_url' ? 'quark_download_url'
          : 'quark_token_refresh',
      upstreamMethod: method,
      ...(response ? { upstreamStatus: response.status } : {}),
      ...(Number.isSafeInteger(payload && payload.errno) ? { upstreamErrno: payload.errno } : {}),
      ...(Number.isSafeInteger(payload && payload.status) ? { upstreamApiStatus: payload.status } : {}),
      upstreamRequestId: url.searchParams.get('req_id'),
      ...(Number.isSafeInteger(limitBytes) && limitBytes > 0 ? {
        upstreamReason: 'download_file_size_limit', upstreamLimitBytes: limitBytes,
      } : {}),
    }
    throw error
  }
  return payload
}

async function rotateQuarkAuth(storageId, before, env, fetchImpl, now, sleep, diagnostics, probe) {
  if (!before.refreshToken || (before.refreshExpiresAt && before.refreshExpiresAt <= now())) {
    throw storageError('storage_authorization_required', 401)
  }
  const lockKey = storageKey('lock', 'refresh-' + storageId)
  for (let attempt = 0; attempt < QUARK_REFRESH_LOCK_WAIT_ATTEMPTS; attempt += 1) {
    probe?.check()
    const owner = crypto.randomUUID()
    const [acquired] = await redisPipeline([['SET', lockKey, owner, 'NX', 'EX', '90']], env, fetchImpl)
    if (acquired === 'OK') {
      try {
        const stored = await getStoredAuth(storageId, env, fetchImpl, now, { bypassCache: true })
        probe?.check()
        if (authChanged(before, stored)) {
          diagnostics?.emit('auth_refresh_result', { result: 'adopted', authChanged: true })
          return stored
        }
        if (!stored.refreshToken || (stored.refreshExpiresAt && stored.refreshExpiresAt <= now())) {
          throw storageError('storage_authorization_required', 401)
        }
        // Once rotation starts, finish persisting the new credentials even if
        // this caller times out. Cancelling a consumed refresh token loses auth.
        const payload = await quarkRequest('/agent/v1/oauth/access_token/rotate', {
          method: 'POST',
          body: { refresh_token: stored.refreshToken, device_id: stored.deviceId },
          env,
          fetchImpl,
          now,
        })
        if (!payload.data || !payload.data.access_token || !payload.data.refresh_token) {
          throw storageError('quark_refresh_invalid', 502)
        }
        const duration = Number(payload.data.expires_in)
        const refreshed = {
          ...stored,
          accessToken: payload.data.access_token,
          refreshToken: payload.data.refresh_token,
          accessExpiresAt: Number.isFinite(duration) && duration > 0 ? now() + duration * 1000 : null,
        }
        await writeStoredAuth(storageId, refreshed, env, fetchImpl, now)
        diagnostics?.emit('auth_refresh_result', { result: 'rotated', authChanged: authChanged(before, refreshed) })
        return refreshed
      } finally {
        await redisPipeline([['EVAL', UNLOCK_LOCK_SCRIPT, '1', lockKey, owner]], env, fetchImpl).catch(() => {})
      }
    }
    await sleep(250)
    probe?.check()
    const stored = await getStoredAuth(storageId, env, fetchImpl, now, { bypassCache: true })
    if (authChanged(before, stored)) {
      diagnostics?.emit('auth_refresh_result', { result: 'adopted', authChanged: true })
      return stored
    }
  }
  throw storageError('storage_operation_busy', 409)
}

function createQuarkClient(storageId, initialAuth, { env, fetchImpl, storageFetchImpl = fetchImpl, now, sleep, diagnostics, probe, waitUntil }) {
  let auth = initialAuth
  const refreshAuth = async reason => {
    diagnostics?.emit('auth_refresh_start', { reason })
    try {
      probe?.check()
      const rotation = rotateQuarkAuth(storageId, auth, env, storageFetchImpl, now, sleep, diagnostics, probe)
      if (probe) waitUntil?.(rotation.catch(() => {}))
      auth = await (probe ? probe.wait(rotation) : rotation)
    } catch (error) {
      diagnostics?.emit('auth_refresh_result', { result: probe?.signal.aborted ? 'caller_stopped' : 'failed' })
      throw error
    }
  }
  async function call(path, options = {}) {
    probe?.check()
    if (!auth || !auth.accessToken) throw storageError('storage_authorization_required', 409)
    if (auth.accessExpiresAt && auth.accessExpiresAt <= now() + 60_000) {
      await refreshAuth('proactive')
    }
    probe?.check()
    try {
      return await quarkRequest(path, { ...options, auth, env, fetchImpl, now })
    } catch (error) {
      if (error.code !== 'storage_token_expired' || !auth.refreshToken) throw error
      await refreshAuth('api_expired')
      probe?.check()
      return quarkRequest(path, { ...options, auth, env, fetchImpl, now })
    }
  }
  return {
    get auth() { return auth },
    call,
  }
}

function identity(value) {
  const id = typeof value === 'string' ? value : ''
  const separator = id.lastIndexOf('|')
  return separator >= 0 && separator < id.length - 1
    ? { kind: 'suffix', value: id.slice(separator + 1) }
    : { kind: 'full', value: id }
}

export function quarkFidsMatch(left, right) {
  const first = identity(left)
  const second = identity(right)
  return first.kind === second.kind && first.value === second.value
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null)
}

function byteCount(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !/^\d+$/.test(value)) return null
  const result = Number(value)
  return Number.isSafeInteger(result) && result >= 0 ? result : null
}

function fileInfoFrom(payload) {
  const data = payload && payload.data
  const candidates = [
    data && data.file, data && data.file_info, data && data.fileInfo, data && data.item,
    data && data.item_info, data && data.info, payload && payload.file, payload && payload.file_info, data,
  ]
  return candidates.find(value => value && typeof value === 'object' && !Array.isArray(value)
    && firstDefined(value.fid, value.id) !== undefined) || {}
}

function normalizeItem(file) {
  const fileType = firstDefined(file.file_type, file.type)
  const isFolder = file.isFolder === true || file.kind === 'drive#folder' || Number(fileType) === 0
    || ['folder', 'dir', 'directory'].includes(String(fileType || '').toLowerCase())
  const rawParent = firstDefined(file.pdir_fid, file.parent_fid, file.parent_id, file.parentId, '')
  const rawSize = firstDefined(file.size, file.file_size)
  return {
    id: String(firstDefined(file.fid, file.id, '')),
    parentId: String(rawParent) === '0' ? '' : String(rawParent),
    name: String(firstDefined(file.file_name, file.filename, file.name, '')),
    isFolder,
    size: byteCount(rawSize),
    mimeType: String(firstDefined(file.mime_type, file.mimeType, '')),
    extension: String(firstDefined(file.file_ext, file.extension, '')),
  }
}

async function getItemRecord(client, fileId) {
  const payload = await client.call('/open/v1/file/info', { query: { fid: fileId } })
  const record = fileInfoFrom(payload)
  const item = normalizeItem(record)
  if (!item.id || !quarkFidsMatch(item.id, fileId)) throw storageError('file_not_found', 404)
  return { item: { ...item, id: fileId }, record }
}

function valuesFrom(value, depth = 0) {
  if (depth > 4 || value == null) return []
  if (typeof value === 'string') return /^https:\/\//i.test(value) ? [value] : []
  if (Array.isArray(value)) return value.flatMap(child => valuesFrom(child, depth + 1))
  if (typeof value !== 'object') return []
  const preferred = ['url', 'link', 'src', 'href', 'image_url', 'thumbnail_url', 'preview_url']
  const rank = key => {
    const index = preferred.indexOf(String(key).toLowerCase().replaceAll('-', '_'))
    return index < 0 ? preferred.length : index
  }
  return Object.entries(value).sort(([a], [b]) => rank(a) - rank(b)).flatMap(([, child]) => valuesFrom(child, depth + 1))
}

function previewSourceUrl(record, variant) {
  const previewKeys = variant === 'thumbnail' ? [...THUMBNAIL_KEYS, ...PREVIEW_KEYS] : [...PREVIEW_KEYS, ...THUMBNAIL_KEYS]
  const entries = Object.entries(record || {})
  for (const key of previewKeys) {
    const value = entries.find(([candidate]) => String(candidate).toLowerCase().replaceAll('-', '_') === key)
    const url = value && valuesFrom(value[1])[0]
    if (url) return url
  }
  const fallback = entries.filter(([key]) => variant === 'thumbnail'
    ? /thumb|thumbnail|preview/i.test(key)
    : /preview|thumb|thumbnail/i.test(key)).flatMap(([, value]) => valuesFrom(value))
  return fallback[0] || null
}

export function isAllowedQuarkUrl(value) {
  if (typeof value !== 'string' || value.length > 16384) return false
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    const hostAllowed = host === 'quark.cn' || host.endsWith('.quark.cn')
      || host === 'quark.com' || host.endsWith('.quark.com')
    const localhost = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    const ipLiteral = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && (!url.port || url.port === '443')
      && !localhost
      && !ipLiteral
      && hostAllowed
  } catch {
    return false
  }
}

function combinedAbortSignal(signal, timeoutSignal) {
  if (!signal) return timeoutSignal
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeoutSignal])
  const controller = new AbortController()
  const forwardAbort = source => {
    if (source.aborted) controller.abort(source.reason)
    else source.addEventListener('abort', () => controller.abort(source.reason), { once: true })
  }
  forwardAbort(signal)
  forwardAbort(timeoutSignal)
  return controller.signal
}

async function fetchQuarkCdnHeaders(value, init, fetchImpl, timeoutMs, diagnostics, fields) {
  const timeoutController = new AbortController()
  const signal = combinedAbortSignal(init.signal, timeoutController.signal)
  let timedOut = false
  const startedAt = diagnostics?.clock()
  if (diagnostics) {
    const headers = new Headers(init.headers)
    diagnostics.emit('cdn_headers_start', { ...fields, timeoutMs,
      accept: headers.get('accept') === '*/*' ? '*/*' : headers.get('accept')?.startsWith('image/') ? 'image' : undefined,
      acceptEncoding: headers.get('accept-encoding'),
      range: safeRangeForLog(headers.get('range')), ifRangePresent: headers.has('if-range') })
  }
  const timer = setTimeout(() => {
    timedOut = true
    timeoutController.abort()
  }, timeoutMs)
  try {
    const response = await fetchImpl(value, { ...init, signal })
    diagnostics?.emit('cdn_headers_result', { ...fields, result: 'headers', status: response.status,
      elapsedMs: diagnostics.clock() - startedAt, deadlineFired: timedOut, parentAborted: Boolean(init.signal?.aborted),
      ...diagnosticResponseHeaders(response.headers, true) })
    return response
  } catch (error) {
    diagnostics?.emit('cdn_headers_result', { ...fields,
      result: timedOut ? 'deadline' : init.signal?.reason?.code === MEDIA_PROBE_DEADLINE_ERROR ? 'probe_deadline'
        : init.signal?.aborted ? 'client_cancel' : 'fetch_error',
      elapsedMs: diagnostics.clock() - startedAt, deadlineFired: timedOut, parentAborted: Boolean(init.signal?.aborted),
      errorKind: error?.name === 'AbortError' ? 'abort' : error?.name === 'TypeError' ? 'type_error' : 'other' })
    if (timedOut) throw storageError('quark_media_headers_timeout', 504)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function fetchQuarkCdn(value, {
  headers,
  signal,
  fetchImpl,
  maxRedirects = 3,
  headerTimeoutMs = MEDIA_CDN_HEADER_TIMEOUT_MS,
  diagnostics,
  flow = 'download',
}) {
  let current = value
  const attempt = diagnostics?.nextAttempt()
  for (let redirects = 0; ; redirects += 1) {
    if (!isAllowedQuarkUrl(current)) throw storageError('quark_media_host_rejected', 502)
    let response
    try {
      response = await fetchQuarkCdnHeaders(current, {
        method: 'GET',
        headers,
        cache: 'no-store',
        redirect: 'manual',
        signal,
      }, fetchImpl, headerTimeoutMs, diagnostics, { attempt, hop: redirects, redirects, flow,
        host: diagnostics ? new URL(current).hostname.toLowerCase().replace(/\.$/, '') : undefined })
    } catch (error) {
      if (error instanceof GatewayError) throw error
      throw storageError('quark_media_unavailable', 502)
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => {})
    if (!location || redirects >= maxRedirects) throw storageError('quark_media_redirect_rejected', 502)
    let next
    try { next = new URL(location, current).toString() } catch {
      throw storageError('quark_media_redirect_rejected', 502)
    }
    if (!isAllowedQuarkUrl(next)) throw storageError('quark_media_redirect_rejected', 502)
    diagnostics?.emit('cdn_redirect', { attempt, hop: redirects, redirects: redirects + 1, status: response.status,
      nextHost: new URL(next).hostname.toLowerCase().replace(/\.$/, '') })
    current = next
  }
}

function mediaCookie(auth, env) {
  const clientId = env.QUARK_CLIENT_ID || OFFICIAL_CLIENT_ID
  const validValue = value => typeof value === 'string' && value.length > 0 && !/[\u0000-\u0020\u007f;,\\"]/.test(value)
  if (!validValue(clientId) || !validValue(auth.accessToken)) throw storageError('quark_media_auth_invalid', 502)
  let cookie = 'x_pan_client_id=' + clientId + ';x_pan_access_token=' + auth.accessToken
  if (auth.clientToken) {
    if (!validValue(auth.clientToken)) throw storageError('quark_media_auth_invalid', 502)
    cookie += ';x_pan_client_token=' + auth.clientToken
  }
  return cookie
}

function urlExpiryMs(value) {
  try {
    const url = new URL(value)
    const authKey = url.searchParams.get('auth_key')
    const authDeadline = authKey ? Number.parseInt(authKey.split('-', 1)[0], 10) : NaN
    const expires = Number.parseInt(url.searchParams.get('Expires') || url.searchParams.get('expires') || '', 10)
    const seconds = Number.isSafeInteger(authDeadline) && authDeadline > 0
      ? authDeadline
      : Number.isSafeInteger(expires) && expires > 0 ? expires : NaN
    return Number.isSafeInteger(seconds) ? seconds * 1000 : null
  } catch {
    return null
  }
}

async function getDownloadSource(client, storageId, fileId, env, now, refresh = false, diagnostics) {
  const auth = client.auth
  const fingerprint = bytesToBase64Url(new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(String(auth.userId || '') + '\u0000' + auth.accessToken + '\u0000' + String(auth.clientToken || '')),
  )))
  const cacheKey = storageId + '\u0000' + fileId + '\u0000' + fingerprint
  const cached = downloadUrlCache.get(cacheKey)
  if (!refresh && cached && cached.expiresAt > now()) {
    diagnostics?.emit('url_cache', { cacheHit: true, reason: 'cache' })
    return cached
  }
  diagnostics?.emit('url_cache', { cacheHit: false, reason: refresh ? 'forced' : 'new' })
  const readUrl = async () => {
    const payload = await client.call('/open/v1/file/get_download_url', { method: 'POST', body: { fid: fileId } })
    const value = payload.data && payload.data.download_url
    if (typeof value !== 'string' || (auth.accessToken && value.includes(auth.accessToken))
      || (auth.refreshToken && value.includes(auth.refreshToken)) || !isAllowedQuarkUrl(value)) {
      throw storageError('download_link_unavailable', 502)
    }
    return { payload, url: value, expiry: urlExpiryMs(value) }
  }
  let result = await readUrl()
  if (result.expiry !== null && result.expiry <= now() + MEDIA_URL_MARGIN_MS) {
    diagnostics?.emit('url_cache', { cacheHit: false, reason: 'near_expiry' })
    result = await readUrl()
  }
  diagnostics?.emit('url_ready', { urlChanged: Boolean(cached && cached.url !== result.url),
    authChanged: authChanged(auth, client.auth), expiry: result.expiry === null ? 'unknown'
      : result.expiry <= now() ? 'expired' : result.expiry <= now() + MEDIA_URL_MARGIN_MS ? 'within_margin' : 'fresh' })
  const current = now()
  const entry = {
    url: result.url,
    size: byteCount(result.payload.data && result.payload.data.size),
    fileName: String(result.payload.data && result.payload.data.file_name || ''),
    expiresAt: Math.min(current + MEDIA_URL_TTL_MS, result.expiry === null ? Infinity : result.expiry - MEDIA_URL_MARGIN_MS),
  }
  for (const [key, value] of downloadUrlCache) {
    if (value.expiresAt <= now() || downloadUrlCache.size >= 512) downloadUrlCache.delete(key)
  }
  downloadUrlCache.set(cacheKey, entry)
  return entry
}

async function requestDownload(client, storageId, fileId, {
  range,
  ifRange,
  signal,
  env,
  fetchImpl,
  now,
  refresh = false,
  cdnHeaderTimeoutMs = MEDIA_CDN_HEADER_TIMEOUT_MS,
  diagnostics,
} = {}) {
  const headers = new Headers({ Accept: '*/*', 'Accept-Encoding': 'identity' })
  if (range) headers.set('Range', range)
  if (ifRange) headers.set('If-Range', ifRange)
  let source = await getDownloadSource(client, storageId, fileId, env, now, refresh, diagnostics)
  headers.set('Cookie', mediaCookie(client.auth, env))
  let response = await fetchQuarkCdn(source.url, { headers, signal, fetchImpl, headerTimeoutMs: cdnHeaderTimeoutMs, diagnostics })
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => {})
    for (const [key, value] of downloadUrlCache) if (value.url === source.url) downloadUrlCache.delete(key)
    diagnostics?.emit('cdn_retry', { reason: 'cdn_unauthorized', status: response.status })
    const beforeUrl = source.url
    const beforeAuth = client.auth
    source = await getDownloadSource(client, storageId, fileId, env, now, true, diagnostics)
    diagnostics?.emit('cdn_retry', { reason: 'cdn_unauthorized', urlChanged: beforeUrl !== source.url,
      authChanged: authChanged(beforeAuth, client.auth) })
    const retryHeaders = new Headers(headers)
    retryHeaders.set('Cookie', mediaCookie(client.auth, env))
    response = await fetchQuarkCdn(source.url, {
      headers: retryHeaders,
      signal,
      fetchImpl,
      headerTimeoutMs: cdnHeaderTimeoutMs,
      diagnostics,
    })
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {})
      throw storageError('quark_media_upstream_forbidden', 502)
    }
  }
  return { response, source }
}

async function previewResponse(client, fileId, item, record, claims, {
  env,
  fetchImpl,
  signal,
  now,
  cdnHeaderTimeoutMs = MEDIA_CDN_HEADER_TIMEOUT_MS,
  diagnostics,
}) {
  const sourceFor = (value, auth) => fetchQuarkCdn(value, {
    headers: {
      Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.1',
      Cookie: mediaCookie(auth, env),
      Origin: 'https://pan.quark.cn',
      Referer: 'https://pan.quark.cn/',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal,
    fetchImpl,
    headerTimeoutMs: cdnHeaderTimeoutMs,
    diagnostics,
    flow: 'preview',
  })
  let source = previewSourceUrl(record, claims.variant)
  if (!source) throw storageError('preview_unavailable', 404)
  let response = await sourceFor(source, client.auth)
  let mime = safeMime(response.headers.get('content-type'))
  if ((response.status === 401 || response.status === 403)) {
    await response.body?.cancel().catch(() => {})
    const refreshed = await getItemRecord(client, fileId)
    source = previewSourceUrl(refreshed.record, claims.variant)
    if (!source) throw storageError('preview_unavailable', 404)
    response = await sourceFor(source, client.auth)
    mime = safeMime(response.headers.get('content-type'))
  }
  if (response.status === 200 && mime && IMAGE_TYPES.has(mime)) return { response, contentTypeOverride: mime }
  await response.body?.cancel().catch(() => {})
  const extension = itemExtension(item)
  if (claims.variant === 'preview' && RASTER_EXTENSIONS.has(extension)) {
    const downloaded = await requestDownload(client, claims.storageId, fileId, {
      range: claims.requestRange,
      ifRange: claims.requestIfRange,
      signal,
      env,
      fetchImpl,
      now,
      cdnHeaderTimeoutMs,
      diagnostics,
    })
    return { response: downloaded.response }
  }
  throw storageError('preview_unavailable', 404)
}

async function resolveStorageForTicket(claims, env, fetchImpl, now) {
  if (!storageIdValid(claims.storageId)) throw storageError('storage_not_found', 404)
  const config = await storageConfig(env, fetchImpl, now)
  const instance = config.instances.find(value => value.storageId === claims.storageId)
  if (!instance || !instance.enabled || instance.provider !== 'quark') throw storageError('storage_not_found', 404)
  return { instance, auth: await getStoredAuth(claims.storageId, env, fetchImpl, now) }
}

function truncateFilename(value, maxLength) {
  let result = ''
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    const width = codePoint > 0xffff ? 2 : 1
    if (result.length + width > maxLength) break
    result += codePoint >= 0xd800 && codePoint <= 0xdfff ? '\uFFFD' : character
  }
  return result
}

function fileNameDisposition(purpose, item, requestedDisposition) {
  const unsafeName = String(item.name || 'download').replace(/[\r\n\u0000-\u001f\u007f\\/]/g, '_')
  const name = truncateFilename(unsafeName, 240) || 'download'
  const encoded = encodeURIComponent(name).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())
  return (requestedDisposition || (purpose === 'preview' ? 'inline' : 'attachment')) + "; filename*=UTF-8''" + encoded
}

function mediaHeaders(response, item, claims, contentType) {
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Type': contentType,
    'Content-Disposition': fileNameDisposition(claims.purpose, item, claims.disposition),
  })
  if (claims.purpose === 'preview' || claims.disposition === 'inline') {
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox")
  }
  const length = safeHeader(response.headers.get('content-length'), /^\d+$/)
  if (length) headers.set('Content-Length', length)
  const contentRange = safeContentRange(response)
  if (contentRange) headers.set('Content-Range', contentRange)
  if (response.headers.get('accept-ranges') === 'bytes' || response.status === 206) headers.set('Accept-Ranges', 'bytes')
  const etag = safeHeader(response.headers.get('etag'), /^(?:W\/)?"[^"\r\n]*"$/)
  if (etag) headers.set('ETag', etag)
  const lastModified = response.headers.get('last-modified')
  if (lastModified && !/[\r\n]/.test(lastModified) && Number.isFinite(Date.parse(lastModified))) headers.set('Last-Modified', lastModified)
  return headers
}

function singleRangeFromRequest(request, size) {
  let range
  try { range = parseSingleRange(request.headers.get('range'), size) } catch (error) {
    if (error instanceof GatewayError) throw error
    throw rangeError(size)
  }
  const ifRange = request.headers.get('if-range')
  if (ifRange !== null && (ifRange.length > 512 || /[\r\n\u0000-\u001f\u007f]/.test(ifRange))) throw rangeError(size)
  return { range, ifRange: ifRange || undefined }
}

async function resolveMediaResponse(client, claims, item, record, range, ifRange, request, context) {
  if (claims.purpose === 'preview') {
    return previewResponse(client, claims.fileId, item, record, {
      ...claims,
      requestRange: range && range.header,
      requestIfRange: ifRange,
    }, { ...context, signal: request.signal })
  }
  if (request.method === 'HEAD' && !range && item.size === 0) {
    return { response: new Response(null, { status: 200, headers: { 'Content-Length': '0' } }) }
  }
  const headProbe = request.method === 'HEAD' && !range
  const actualRange = range ? range.header : headProbe ? 'bytes=0-0' : undefined
  const downloaded = await requestDownload(client, claims.storageId, claims.fileId, {
    range: actualRange,
    ifRange,
    signal: request.signal,
    ...context,
  })
  return { response: downloaded.response, headProbe }
}

function safeErrorCode(error) {
  return error && typeof error.code === 'string' && /^[a-z0-9_-]{1,64}$/i.test(error.code)
    ? error.code
    : 'media_gateway_unavailable'
}

function responseStatus(error) {
  return Number.isInteger(error && error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502
}

async function logFileHash(secret, storageId, fileId) {
  return bytesToBase64Url((await hmacBytes(secret, storageId + '\u0000' + fileId)).slice(0, 12))
}

function safeLog(logger, entry) {
  try { logger(entry) } catch {}
}

function countStream(body, addBytes, finalize) {
  const reader = body.getReader()
  let finished = false
  const finish = async errorCode => {
    if (finished) return
    finished = true
    await finalize(errorCode)
  }
  return new ReadableStream({
    async pull(controller) {
      try {
        const part = await reader.read()
        if (part.done) {
          await finish()
          controller.close()
        } else {
          addBytes(part.value && part.value.byteLength || 0)
          controller.enqueue(part.value)
        }
      } catch {
        await finish('upstream_stream_failed')
        controller.error(new Error('media_stream_failed'))
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason) } finally { await finish('stream_cancelled') }
    },
  }, { highWaterMark: 0 })
}

export function createMediaGatewayWorker({
  fetchImpl = fetch,
  now = Date.now,
  logger = entry => console.log(JSON.stringify(entry)),
  cdnHeaderTimeoutMs = MEDIA_CDN_HEADER_TIMEOUT_MS,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  diagnosticClock = () => performance.now(),
  probeBudgetMs = MEDIA_PROBE_TIMEOUT_MS - MEDIA_PROBE_RESPONSE_MARGIN_MS,
} = {}) {
  return {
    async fetch(request, env = {}, executionContext) {
      const startedAt = now()
      const requestId = crypto.randomUUID()
      const requestRange = safeRangeForLog(request.headers.get('range'))
      let claims = null
      let status = 500
      let contentType = null
      let errorCode = null
      let quarkFailure = null
      let fileSize = null
      let bytesStreamed = 0
      let legacySessionToken = null
      let logged = false
      let diagnostics = null
      let probe = null
      const finishLog = async streamError => {
        if (logged) return
        logged = true
        const entry = {
          requestId,
          ...(claims ? { storageId: claims.storageId, purpose: claims.purpose } : {}),
          ...(claims && env.MEDIA_GATEWAY_SIGNING_SECRET
            ? { fileHash: await logFileHash(env.MEDIA_GATEWAY_SIGNING_SECRET, claims.storageId, claims.fileId).catch(() => undefined) }
            : {}),
          range: requestRange,
          status,
          contentType,
          durationMs: Math.max(0, now() - startedAt),
          bytesStreamed,
          ...(Number.isSafeInteger(fileSize) ? { fileSize } : {}),
          ...(quarkFailure || {}),
          ...((streamError || errorCode) ? { errorCode: streamError || errorCode } : {}),
        }
        safeLog(logger, entry)
      }
      const finalize = error => {
        if (error) errorCode = error
        return finishLog(error)
      }
      let cors = new Headers()
      try {
        const url = new URL(request.url)
        if (url.pathname === '/health') {
          if (request.method !== 'GET') throw new GatewayError('method_not_allowed', 405, { Allow: 'GET' })
          status = 200
          const response = new Response(JSON.stringify({ ok: true, version: MEDIA_GATEWAY_VERSION }), {
            status,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
          })
          await finishLog()
          return response
        }
        if (url.pathname !== '/v1/media' && !/^\/v1\/media\/[A-Za-z0-9_-]{22}$/.test(url.pathname)) throw new GatewayError('not_found', 404)
        cors = corsHeaders(request, env)
        if (request.method === 'OPTIONS') {
          cors.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
          cors.set('Access-Control-Allow-Headers', 'Range, If-Range')
          cors.set('Access-Control-Max-Age', '600')
          status = 204
          await finishLog()
          return new Response(null, { status, headers: cors })
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') throw new GatewayError('method_not_allowed', 405, { Allow: 'GET, HEAD' })
        if ([...url.searchParams.keys()].some(key => key !== 'ticket') || url.searchParams.getAll('ticket').length > 1) {
          throw new GatewayError('media_ticket_invalid', 400)
        }
        const secret = env.MEDIA_GATEWAY_SIGNING_SECRET
        if (!secret) throw storageError('media_gateway_not_configured', 503)
        const token = url.searchParams.get('ticket')
        if (token && token.length > 4096) throw new GatewayError('media_ticket_invalid', 401)
        if (request.headers.get('range')) parseSingleRange(request.headers.get('range'))
        let expiredTicketClaims = null
        if (token) {
          try { claims = await verifyGrant(token, secret, { now: now(), grantType: 'ticket' }) } catch (error) {
            if (error.code !== 'media_ticket_expired') throw error
            expiredTicketClaims = await verifyGrant(token, secret, { now: now(), grantType: 'ticket', allowExpired: true })
          }
        }
        const pathClaims = claims || expiredTicketClaims
        if (url.pathname === '/v1/media' && pathClaims && request.method !== 'HEAD') {
          status = 307
          const headers = new Headers(cors)
          headers.set('Location', await mediaSessionPath(pathClaims, secret) + '?ticket=' + encodeURIComponent(token))
          headers.set('Cache-Control', 'private, no-store')
          headers.set('Referrer-Policy', 'no-referrer')
          await finishLog()
          return new Response(null, { status, headers })
        }
        if (pathClaims && url.pathname !== '/v1/media' && url.pathname !== await mediaSessionPath(pathClaims, secret)) throw new GatewayError('media_ticket_invalid', 401)
        if (!claims) {
          if (!expiredTicketClaims) throw new GatewayError(token ? 'media_ticket_expired' : 'media_ticket_invalid', 401)
          const session = await sessionFromCookie(request.headers.get('cookie'), expiredTicketClaims, secret, now())
          if (!session) throw new GatewayError('media_ticket_expired', 401)
          claims = session.claims
          legacySessionToken = session.legacyToken
        }
        if (!MEDIA_PURPOSES.has(claims.purpose)) throw new GatewayError('media_ticket_invalid', 401)
        const deadline = request.headers.get(MEDIA_PROBE_DEADLINE_HEADER)
        if (request.method === 'HEAD' && request.headers.get('range') === 'bytes=0-0' && deadline !== null) {
          if (!/^\d{13}$/.test(deadline)) throw new GatewayError('media_probe_deadline_invalid', 400)
          // An authenticated caller can shorten, but never extend, this cap.
          probe = createMediaProbeScope({
            timeoutMs: Math.min(probeBudgetMs, Number(deadline) - now() - MEDIA_PROBE_RESPONSE_MARGIN_MS),
            signal: request.signal,
            errorFor: code => new GatewayError(code, code === MEDIA_PROBE_DEADLINE_ERROR ? 504 : 499, { 'X-Media-Error': code }),
          })
          probe.check()
        }
        const runMedia = async () => {
          // Storage reads are shared between callers. Stop this caller's wait,
          // without cancelling a read needed by another request.
          const storage = await resolveStorageForTicket(claims, env, fetchImpl, now)
          probe?.check()
          if (env.MEDIA_GATEWAY_DIAGNOSTIC_FILE_HASH) {
            const fileHash = await logFileHash(secret, claims.storageId, claims.fileId)
            diagnostics = createMediaDiagnostics({ env, requestId, fileHash, claims, method: request.method,
              version: MEDIA_GATEWAY_VERSION, logger, now, monotonicNow: diagnosticClock })
            diagnostics?.emit('request_start', { ...(requestRange ? { range: requestRange } : {}),
              ifRangePresent: request.headers.has('if-range') })
          }
          const mediaFetch = probe ? probe.fetch(fetchImpl) : fetchImpl
          const client = createQuarkClient(claims.storageId, storage.auth, { env, fetchImpl: mediaFetch,
            storageFetchImpl: fetchImpl, now, sleep, diagnostics, probe,
            waitUntil: executionContext?.waitUntil?.bind(executionContext) })
          const resolved = await getItemRecord(client, claims.fileId)
          const item = resolved.item
          fileSize = item.size
          const expectedParent = claims.parentId === '0' ? '' : claims.parentId
          if (item.isFolder || !quarkFidsMatch(item.id, claims.fileId) || !quarkFidsMatch(item.parentId, expectedParent)) {
            throw storageError('file_not_found', 404)
          }
          const parsedRange = singleRangeFromRequest(request, item.size)
          const result = await resolveMediaResponse(
            client,
            claims,
            item,
            resolved.record,
            parsedRange.range,
            parsedRange.ifRange,
            probe ? new Request(request, { signal: probe.signal }) : request,
            { env, fetchImpl: mediaFetch, now, cdnHeaderTimeoutMs, diagnostics },
          )
          let upstream = result.response
          if (upstream.status === 416) {
            await upstream.body?.cancel().catch(() => {})
            const headers = new Headers(cors)
            headers.set('Content-Range', safeContentRange(upstream) || 'bytes */' + (Number.isSafeInteger(item.size) ? item.size : '*'))
            headers.set('Cache-Control', 'private, no-store')
            status = 416
            if (!probe) await finishLog()
            return new Response(null, { status, headers })
          }
          contentType = result.contentTypeOverride || contentTypeFor(upstream, item, claims.purpose)
          if (!contentType) {
            await upstream.body?.cancel().catch(() => {})
            throw storageError('preview_content_type_unsupported', 415)
          }
          try {
            if (result.headProbe) {
              validatePartialResponse(upstream, { header: 'bytes=0-0', start: 0, end: 0 }, item.size)
            } else if (parsedRange.range && !(parsedRange.ifRange && upstream.status === 200)) {
              validatePartialResponse(upstream, parsedRange.range, item.size)
            }
          } catch (error) {
            await upstream.body?.cancel().catch(() => {})
            throw error
          }
          if (![200, 206].includes(upstream.status)) {
            await upstream.body?.cancel().catch(() => {})
            throw storageError('media_upstream_unavailable', 502)
          }
          if (result.headProbe) {
            await upstream.body?.cancel().catch(() => {})
            const headers = new Headers({ 'Content-Type': contentType, 'Accept-Ranges': 'bytes' })
            if (Number.isSafeInteger(item.size)) headers.set('Content-Length', String(item.size))
            for (const name of ['etag', 'last-modified']) {
              const value = upstream.headers.get(name)
              if (value) headers.set(name, value)
            }
            upstream = { status: 200, headers, body: null }
          }
          const headers = new Headers(cors)
          for (const [name, value] of mediaHeaders(upstream, item, claims, contentType)) headers.set(name, value)
          if (request.method === 'GET') {
            const sessionCookies = await setSessionCookie(claims, secret, now(), request.headers.get('cookie'), legacySessionToken)
            for (const sessionCookie of sessionCookies || []) headers.append('Set-Cookie', sessionCookie)
          }
          status = upstream.status
          diagnostics?.emit('media_response_ready', { status, ...diagnosticResponseHeaders(headers) })
          if (request.method === 'HEAD' || !upstream.body) {
            await upstream.body?.cancel().catch(() => {})
            if (!probe) await finishLog()
            return new Response(null, { status, headers })
          }
          const body = countStream(upstream.body, count => { bytesStreamed += count }, finalize)
          return new Response(body, { status, headers })
        }
        const response = await (probe ? probe.wait(runMedia()) : runMedia())
        if (probe) {
          probe.dispose()
          await finishLog()
        }
        return response
      } catch (error) {
        if (probe?.signal.aborted) error = probe.signal.reason
        if (error instanceof GatewayError) quarkFailure = error.quarkFailure || null
        errorCode = safeErrorCode(error)
        status = responseStatus(error)
        const headers = new Headers(cors)
        for (const [name, value] of Object.entries(error && error.headers || {})) headers.set(name, value)
        if (status === 405 && !headers.has('Allow')) headers.set('Allow', 'GET, HEAD')
        const response = jsonResponse(status, errorCode, headers, error?.limitBytes)
        diagnostics?.emit('media_response_ready', { status, ...diagnosticResponseHeaders(response.headers) })
        await finishLog()
        return response
      } finally {
        probe?.dispose()
      }
    },
  }
}

export default createMediaGatewayWorker()
