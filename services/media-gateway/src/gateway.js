import crypto from 'node:crypto'
import http from 'node:http'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { resolveStorage } from '../../../lib/storage/registry.js'
import { StorageError } from '../../../lib/storage/errors.js'
import { isAllowedPreviewContentType } from '../../../lib/storage/previews.js'
import { quarkFidsMatch } from '../../../lib/storage/providers/quark.js'
import {
  createMediaSession,
  MEDIA_SESSION_TTL_SECONDS,
  sameMediaIdentity,
  verifyMediaSession,
  verifyMediaTicket,
} from '../../../lib/storage/media-ticket.js'

export const MEDIA_GATEWAY_VERSION = '0.1.0'
export const MEDIA_SESSION_COOKIE = '__Host-map7e-media'
const MEDIA_SESSION_COOKIE_MAX_VALUE_LENGTH = 3800
const MEDIA_SESSION_COOKIE_MAX_GRANTS = 8
const RANGE_HEADER_MAX_LENGTH = 128
const RASTER_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'heic', 'heif', 'jpe', 'jpeg', 'jpg', 'png', 'tif', 'tiff', 'webp'])
const MIME_BY_EXTENSION = new Map([
  ['avif', 'image/avif'], ['bmp', 'image/bmp'], ['gif', 'image/gif'], ['heic', 'image/heic'], ['heif', 'image/heif'],
  ['jpe', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['jpg', 'image/jpeg'], ['png', 'image/png'], ['tif', 'image/tiff'],
  ['tiff', 'image/tiff'], ['webp', 'image/webp'], ['3g2', 'video/3gpp2'], ['3gp', 'video/3gpp'], ['avi', 'video/x-msvideo'],
  ['m2ts', 'video/mp2t'], ['mp4', 'video/mp4'], ['m4v', 'video/mp4'], ['mov', 'video/quicktime'], ['mpeg', 'video/mpeg'], ['mpg', 'video/mpeg'],
  ['mts', 'video/mp2t'], ['ogv', 'video/ogg'], ['ts', 'video/mp2t'], ['webm', 'video/webm'], ['mkv', 'video/x-matroska'], ['wmv', 'video/x-ms-wmv'],
  ['mp3', 'audio/mpeg'], ['m4a', 'audio/mp4'], ['pdf', 'application/pdf'],
])

class MediaHttpError extends Error {
  constructor(code, status, headers = {}) { super(code); this.code = code; this.status = status; this.headers = headers }
}

function json(res, status, error) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify({ ok: false, error }))
}

function safeLog(logger, entry) {
  try { logger(entry) } catch {}
}

function fileHash(storageId, fileId, secret) {
  return crypto.createHmac('sha256', String(secret || 'unavailable')).update(`${storageId}\u0000${fileId}`).digest('hex').slice(0, 16)
}

function safeRangeForLog(value) {
  if (typeof value !== 'string') return null
  return value.length <= RANGE_HEADER_MAX_LENGTH && /^[A-Za-z0-9=,-]+$/.test(value) ? value : 'invalid'
}

export function parseSingleRange(value, fileSize = null) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || value.length > RANGE_HEADER_MAX_LENGTH || value.includes(',')) {
    throw new MediaHttpError('range_not_satisfiable', 416, { 'Content-Range': `bytes */${Number.isSafeInteger(fileSize) ? fileSize : '*'}` })
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim())
  if (!match || (!match[1] && !match[2])) {
    throw new MediaHttpError('range_not_satisfiable', 416, { 'Content-Range': `bytes */${Number.isSafeInteger(fileSize) ? fileSize : '*'}` })
  }
  const start = match[1] ? Number(match[1]) : null
  const end = match[2] ? Number(match[2]) : null
  if ((start !== null && !Number.isSafeInteger(start)) || (end !== null && !Number.isSafeInteger(end))
    || (start !== null && end !== null && start > end) || (start === null && end === 0)
    || (start !== null && Number.isSafeInteger(fileSize) && start >= fileSize)) {
    throw new MediaHttpError('range_not_satisfiable', 416, { 'Content-Range': `bytes */${Number.isSafeInteger(fileSize) ? fileSize : '*'}` })
  }
  return { header: `bytes=${match[1]}-${match[2]}`, start, end }
}

function safeMime(value) {
  const type = String(value || '').split(';', 1)[0].trim().toLowerCase()
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : null
}

function inferredMime(item) {
  const extension = String(item?.extension || item?.name?.split('.').pop() || '').toLowerCase()
  return MIME_BY_EXTENSION.get(extension) || null
}

function contentTypeFor(response, item, purpose) {
  const fromUpstream = safeMime(response.headers.get('content-type'))
  const fromItem = safeMime(item?.mimeType)
  const inferred = inferredMime(item)
  if (purpose === 'video') {
    if (fromUpstream?.startsWith('video/')) return fromUpstream
    if (fromUpstream && fromUpstream !== 'application/octet-stream') return null
    if (fromItem?.startsWith('video/')) return fromItem
    if (inferred?.startsWith('video/')) return inferred
    return null
  }
  const type = fromUpstream && fromUpstream !== 'application/octet-stream' ? fromUpstream : fromItem || inferred || fromUpstream || 'application/octet-stream'
  if (purpose === 'preview' && !isAllowedPreviewContentType(type)) return null
  return type
}

function safeHeader(value, pattern) {
  return typeof value === 'string' && value.length <= 512 && !/[\r\n\u0000-\u001f\u007f]/.test(value) && pattern.test(value) ? value : null
}

function disposition(purpose, item, requestedDisposition) {
  const name = String(item?.name || 'download').replace(/[\r\n\u0000-\u001f\u007f\\/]/g, '_').slice(0, 240) || 'download'
  const encoded = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  const type = requestedDisposition || (purpose === 'preview' || purpose === 'video' ? 'inline' : 'attachment')
  return `${type}; filename*=UTF-8''${encoded}`
}

function contentRangeHeader(response) {
  return safeHeader(response.headers.get('content-range'), /^bytes (?:\d+-\d+|\*)\/(?:\d+|\*)$/i)
}

function validatePartialResponse(response, range, fileSize = null) {
  if (!range) return
  if (response.status === 416) return
  if (response.status !== 206) throw new MediaHttpError('range_not_supported', 502)
  const raw = contentRangeHeader(response)
  const match = raw && /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(raw)
  if (!match) throw new MediaHttpError('range_response_invalid', 502)
  const start = Number(match[1]), end = Number(match[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) throw new MediaHttpError('range_response_invalid', 502)
  const total = match[3] === '*' ? null : Number(match[3])
  if (total !== null && (!Number.isSafeInteger(total) || total <= end)) throw new MediaHttpError('range_response_invalid', 502)
  if (Number.isSafeInteger(fileSize) && total !== null && fileSize !== total) throw new MediaHttpError('range_response_invalid', 502)
  let expectedStart = null
  let expectedEnd = null
  if (range.start !== null) {
    expectedStart = range.start
    if (range.end !== null) expectedEnd = total === null ? range.end : Math.min(range.end, total - 1)
    else if (total !== null) expectedEnd = total - 1
  } else if (range.end !== null) {
    if (Number.isSafeInteger(total)) {
      expectedStart = Math.max(0, total - range.end)
      expectedEnd = total - 1
    } else if (end - start + 1 > range.end) throw new MediaHttpError('range_response_invalid', 502)
  }
  if ((expectedStart !== null && start !== expectedStart) || (expectedEnd !== null && end !== expectedEnd)) {
    throw new MediaHttpError('range_response_invalid', 502)
  }
  const rawLength = response.headers.get('content-length')
  if (rawLength !== null) {
    const length = Number(rawLength)
    if (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(length) || length !== end - start + 1) {
      throw new MediaHttpError('range_response_invalid', 502)
    }
  }
}

function addCors(req, res, env) {
  const allowedOrigin = env.MEDIA_GATEWAY_ALLOWED_ORIGIN || 'https://cloud.map7e.com'
  let parsedAllowedOrigin
  try { parsedAllowedOrigin = new URL(allowedOrigin) } catch { throw new StorageError('media_gateway_not_configured', 503) }
  if (parsedAllowedOrigin.protocol !== 'https:' || parsedAllowedOrigin.origin !== allowedOrigin
    || parsedAllowedOrigin.username || parsedAllowedOrigin.password || parsedAllowedOrigin.pathname !== '/') {
    throw new StorageError('media_gateway_not_configured', 503)
  }
  const siteDomain = env.MEDIA_GATEWAY_SITE_DOMAIN
  if (siteDomain) {
    if (siteDomain !== siteDomain.toLowerCase()
      || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(siteDomain)) {
      throw new StorageError('media_gateway_not_configured', 503)
    }
    const requestHost = String(req.headers.host || '').split(':', 1)[0].toLowerCase()
    const isWithinSite = hostname => hostname === siteDomain || hostname.endsWith('.' + siteDomain)
    if (!isWithinSite(parsedAllowedOrigin.hostname.toLowerCase()) || !isWithinSite(requestHost)) {
      throw new StorageError('media_gateway_site_mismatch', 403)
    }
  }
  const origin = req.headers.origin
  res.setHeader('Vary', 'Origin')
  if (origin && origin !== allowedOrigin) throw new MediaHttpError('origin_forbidden', 403)
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Range, Content-Length, Content-Type, Content-Disposition, ETag, Last-Modified')
  }
}

function sessionTokensFromCookie(header) {
  if (typeof header !== 'string' || header.length > 8192) return []
  const part = header.split(';').find(value => value.slice(0, value.indexOf('=')).trim() === MEDIA_SESSION_COOKIE)
  if (!part) return []
  const value = part.slice(part.indexOf('=') + 1).trim()
  if (!value || value.length > MEDIA_SESSION_COOKIE_MAX_VALUE_LENGTH) return []
  return value.split('~').filter(token => /^[A-Za-z0-9_.-]{40,4096}$/.test(token)).slice(-MEDIA_SESSION_COOKIE_MAX_GRANTS)
}

function validSessionEntries(header, secret, now) {
  const entries = []
  for (const token of sessionTokensFromCookie(header)) {
    try { entries.push({ token, claims: verifyMediaSession(token, secret, { now }) }) } catch {}
  }
  return entries
}

function sessionFromCookie(header, expectedClaims, secret, now) {
  return validSessionEntries(header, secret, now).find(entry => sameMediaIdentity(expectedClaims, entry.claims))?.claims || null
}

function setSessionCookie(res, claims, secret, now, cookieHeader, method) {
  if (method !== 'GET' || claims.grantType !== 'ticket' || claims.purpose !== 'video') return
  const token = createMediaSession(claims, { secret, now: claims.issuedAt * 1000 })
  const sessionClaims = verifyMediaSession(token, secret, { now })
  const entries = validSessionEntries(cookieHeader, secret, now)
    .filter(entry => !sameMediaIdentity(entry.claims, sessionClaims))
  entries.push({ token, claims: sessionClaims })
  while (entries.length > MEDIA_SESSION_COOKIE_MAX_GRANTS
    || entries.map(entry => entry.token).join('~').length > MEDIA_SESSION_COOKIE_MAX_VALUE_LENGTH) entries.shift()
  const maxAge = Math.max(0, claims.issuedAt + MEDIA_SESSION_TTL_SECONDS - Math.floor(now / 1000))
  const value = entries.map(entry => entry.token).join('~')
  if (maxAge > 0 && value) res.setHeader('Set-Cookie', `${MEDIA_SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`)
}

function requestAbortSignal(req, res) {
  const controller = new AbortController()
  if (req.aborted) controller.abort()
  req.once('aborted', () => controller.abort())
  res.once('close', () => { if (!res.writableEnded) controller.abort() })
  return controller.signal
}

async function cancelBody(response) {
  try { await response?.body?.cancel() } catch {}
}

function isRasterImage(item) {
  const ext = String(item?.extension || item?.name?.split('.').pop() || '').toLowerCase()
  return RASTER_EXTENSIONS.has(ext)
}

async function resolveMediaResponse(provider, claims, item, { range, ifRange, signal, head = false }) {
  if (claims.purpose !== 'preview') {
    if (typeof provider.getFileResponse !== 'function') throw new StorageError('media_provider_unsupported', 501)
    if (head && !range && item.size === 0) {
      return { response: new Response(null, { status: 200, headers: { 'Content-Length': '0' } }) }
    }
    const headProbe = head && !range
    const response = await provider.getFileResponse(claims.fileId, { range: range?.header || (headProbe ? 'bytes=0-0' : undefined), ifRange, signal })
    return { response, headProbe }
  }
  const getPreview = claims.variant === 'thumbnail' ? provider.getThumbnail : provider.getPreview
  let previewError
  try {
    const response = await getPreview?.call(provider, claims.fileId, { item, signal })
    const type = response && contentTypeFor(response, item, 'preview')
    if (response?.status === 200 && type) return { response, contentTypeOverride: type }
    await cancelBody(response)
    previewError = new StorageError('preview_unavailable', 404)
  } catch (error) {
    previewError = error
  }
  if (claims.variant === 'preview' && isRasterImage(item) && typeof provider.getFileResponse === 'function') {
    const headProbe = head && !range
    const response = await provider.getFileResponse(claims.fileId, { range: range?.header || (headProbe ? 'bytes=0-0' : undefined), ifRange, signal })
    const type = contentTypeFor(response, item, 'preview')
    if ([200, 206].includes(response.status) && type) return { response, contentTypeOverride: type, headProbe }
    await cancelBody(response)
  }
  throw new StorageError(previewError?.code === 'preview_content_type_unsupported' ? 'preview_content_type_unsupported' : 'preview_unavailable', 404)
}

function headersForMedia(res, response, item, claims, contentType) {
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Disposition', disposition(claims.purpose, item, claims.disposition))
  if (claims.purpose === 'preview' || claims.disposition === 'inline') {
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
  }
  const length = safeHeader(response.headers.get('content-length'), /^\d+$/)
  if (length) res.setHeader('Content-Length', length)
  const range = contentRangeHeader(response)
  if (range) res.setHeader('Content-Range', range)
  const acceptsRanges = response.headers.get('accept-ranges')
  if (acceptsRanges === 'bytes' || response.status === 206) res.setHeader('Accept-Ranges', 'bytes')
  const etag = safeHeader(response.headers.get('etag'), /^(?:W\/)?"[^"\r\n]*"$/)
  if (etag) res.setHeader('ETag', etag)
  const lastModified = response.headers.get('last-modified')
  if (lastModified && !/[\r\n]/.test(lastModified) && Number.isFinite(Date.parse(lastModified))) res.setHeader('Last-Modified', lastModified)
}

export function createMediaGatewayHandler({
  env = process.env,
  resolveStorageImpl = resolveStorage,
  now = Date.now,
  logger = entry => console.info(JSON.stringify(entry)),
} = {}) {
  return async function mediaGatewayHandler(req, res) {
    const startedAt = now()
    const requestId = crypto.randomUUID()
    let claims = null
    let response = null
    let status = 500
    let contentType = null
    let errorCode = null
    let bytesStreamed = 0
    let stage = 'route'
    const requestRange = safeRangeForLog(req.headers.range)

    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    try {
      const parsed = new URL(req.url || '/', 'http://media-gateway.invalid')
      if (parsed.pathname === '/health') {
        if (req.method !== 'GET') throw new MediaHttpError('method_not_allowed', 405, { Allow: 'GET' })
        status = 200
        res.statusCode = status
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        return res.end(JSON.stringify({ ok: true, version: MEDIA_GATEWAY_VERSION }))
      }
      if (parsed.pathname !== '/v1/media') throw new MediaHttpError('not_found', 404)
      addCors(req, res, env)
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Range, If-Range')
        res.setHeader('Access-Control-Max-Age', '600')
        status = 204
        res.statusCode = status
        return res.end()
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new MediaHttpError('method_not_allowed', 405, { Allow: 'GET, HEAD' })
      if ([...parsed.searchParams.keys()].some(key => key !== 'ticket') || parsed.searchParams.getAll('ticket').length > 1) {
        throw new MediaHttpError('media_ticket_invalid', 400)
      }
      const secret = env.MEDIA_GATEWAY_SIGNING_SECRET
      if (!secret) throw new StorageError('media_gateway_not_configured', 503)
      let expiredTicketClaims = null
      const ticket = parsed.searchParams.get('ticket')
      if (ticket) {
        try { claims = verifyMediaTicket(ticket, secret, { now: now() }) } catch (error) {
          if (error?.code !== 'media_ticket_expired') throw error
          expiredTicketClaims = verifyMediaTicket(ticket, secret, { now: now(), allowExpired: true })
        }
      }
      if (!claims) {
        if (!expiredTicketClaims) throw new StorageError(ticket ? 'media_ticket_expired' : 'media_ticket_invalid', 401)
        claims = sessionFromCookie(req.headers.cookie, expiredTicketClaims, secret, now())
        if (!claims) throw new StorageError('media_ticket_expired', 401)
      }

      stage = 'storage_resolve'
      const { instance, provider, auth } = await resolveStorageImpl(claims.storageId)
      if (instance?.provider !== 'quark' || !auth?.accessToken) throw new StorageError('media_storage_unavailable', 404)
      stage = 'file_identity'
      const item = await provider.getItem(claims.fileId)
      const expectedParentId = claims.parentId === '0' ? '' : claims.parentId
      if (!item || item.isFolder || !quarkFidsMatch(item.id, claims.fileId) || !quarkFidsMatch(item.parentId, expectedParentId)) {
        throw new StorageError('file_not_found', 404)
      }
      let range
      try { range = parseSingleRange(req.headers.range, item.size) } catch (error) {
        if (error instanceof MediaHttpError) throw error
        throw new MediaHttpError('range_not_satisfiable', 416)
      }
      if (req.headers['if-range'] !== undefined) {
        const ifRange = req.headers['if-range']
        if (typeof ifRange !== 'string' || ifRange.length > 512 || /[\r\n]/.test(ifRange)) throw new MediaHttpError('range_not_satisfiable', 416)
      }
      const signal = requestAbortSignal(req, res)
      stage = 'upstream'
      const ifRange = typeof req.headers['if-range'] === 'string' ? req.headers['if-range'] : undefined
      const resolved = await resolveMediaResponse(provider, claims, item, { range, ifRange, signal, head: req.method === 'HEAD' })
      response = resolved.response || resolved
      if (response.status === 416) {
        await cancelBody(response)
        const upstreamRange = contentRangeHeader(response)
        const size = Number.isSafeInteger(item.size) ? item.size : null
        res.setHeader('Content-Range', upstreamRange || `bytes */${size ?? '*'}`)
        status = 416
        res.statusCode = status
        return res.end()
      }
      contentType = resolved.contentTypeOverride || contentTypeFor(response, item, claims.purpose)
      if (!contentType) {
        await cancelBody(response)
        throw new StorageError('preview_content_type_unsupported', 415)
      }
      const upstreamRange = range || (resolved.headProbe ? parseSingleRange('bytes=0-0', item.size) : null)
      if (!(range && ifRange && response.status === 200)) validatePartialResponse(response, upstreamRange, item.size)
      if (![200, 206].includes(response.status)) {
        await cancelBody(response)
        throw new StorageError('media_upstream_unavailable', 502)
      }
      if (resolved.headProbe) {
        await cancelBody(response)
        const headers = new Headers({ 'content-type': contentType, 'accept-ranges': 'bytes' })
        if (Number.isSafeInteger(item.size)) headers.set('content-length', String(item.size))
        for (const name of ['etag', 'last-modified']) {
          const value = response.headers.get(name)
          if (value) headers.set(name, value)
        }
        response = { status: 200, headers }
      }
      headersForMedia(res, response, item, claims, contentType)
      setSessionCookie(res, claims, secret, now(), req.headers.cookie, req.method)
      status = response.status
      res.statusCode = status
      if (req.method === 'HEAD') {
        await cancelBody(response)
        return res.end()
      }
      if (!response.body) return res.end()
      const counter = new Transform({ transform(chunk, encoding, callback) { bytesStreamed += chunk.length; callback(null, chunk) } })
      stage = 'stream'
      await pipeline(Readable.fromWeb(response.body), counter, res)
    } catch (error) {
      errorCode = typeof error?.code === 'string' && /^[a-z0-9_-]{1,64}$/i.test(error.code) ? error.code : 'media_gateway_unavailable'
      status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 502
      if (res.headersSent) {
        res.destroy(error)
        return
      }
      for (const [name, value] of Object.entries(error?.headers || {})) res.setHeader(name, value)
      if (status === 405 && !res.hasHeader('Allow')) res.setHeader('Allow', 'GET, HEAD')
      json(res, status, errorCode)
    } finally {
      const entry = {
        requestId,
        ...(claims ? { storageId: claims.storageId, purpose: claims.purpose, fileHash: fileHash(claims.storageId, claims.fileId, env.MEDIA_GATEWAY_SIGNING_SECRET) } : {}),
        range: requestRange,
        status,
        contentType,
        durationMs: Math.max(0, now() - startedAt),
        bytesStreamed,
        ...(errorCode ? { errorCode } : {}),
      }
      safeLog(logger, entry)
    }
  }
}

export function createMediaGatewayServer(options) {
  return http.createServer(createMediaGatewayHandler(options))
}
