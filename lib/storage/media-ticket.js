import crypto from 'node:crypto'
import { StorageError } from './errors.js'

export const MEDIA_TICKET_TTL_SECONDS = 5 * 60
export const MEDIA_SESSION_TTL_SECONDS = 6 * 60 * 60
const MEDIA_PURPOSES = new Set(['preview', 'original', 'video'])
const PREVIEW_VARIANTS = new Set(['preview', 'thumbnail'])
const STORAGE_ID = /^[a-z][a-z0-9-]{0,63}$/
const CANONICAL_CLOUD_HOST = 'cloud.map7e.com'

function isHostWithinDomain(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

function validSiteDomain(value) {
  if (typeof value !== 'string' || value !== value.toLowerCase()
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)) return false
  return isHostWithinDomain(CANONICAL_CLOUD_HOST, value)
}

function requireSecret(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new StorageError('media_gateway_not_configured', 503)
  }
  return secret
}

function safeIdentity(value, required = false) {
  if (typeof value !== 'string' || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value) || (required && !value)) return false
  return true
}

function validateClaims(claims) {
  if (!claims || typeof claims !== 'object' || claims.version !== 1) return false
  if (claims.grantType !== 'ticket' && claims.grantType !== 'session') return false
  if (typeof claims.storageId !== 'string' || !STORAGE_ID.test(claims.storageId)) return false
  if (!safeIdentity(claims.fileId, true) || !safeIdentity(claims.parentId)) return false
  if (!MEDIA_PURPOSES.has(claims.purpose)) return false
  if (claims.purpose === 'preview') {
    if (!PREVIEW_VARIANTS.has(claims.variant)) return false
  } else if (claims.variant !== undefined) return false
  if (claims.disposition !== undefined && !['inline', 'attachment'].includes(claims.disposition)) return false
  if (!Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.expiresAt)) return false
  if (claims.expiresAt <= claims.issuedAt) return false
  return true
}

function signature(encoded, secret) {
  return crypto.createHmac('sha256', requireSecret(secret)).update(encoded).digest()
}

function signClaims(claims, secret) {
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const mac = signature(encoded, secret).toString('base64url')
  return `${encoded}.${mac}`
}

function verifyGrant(token, secret, { now = Date.now(), grantType, allowExpired = false } = {}) {
  if (typeof token !== 'string' || token.length > 4096) throw new StorageError('media_ticket_invalid', 401)
  const parts = token.split('.')
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) {
    throw new StorageError('media_ticket_invalid', 401)
  }
  let actual
  try { actual = Buffer.from(parts[1], 'base64url') } catch { throw new StorageError('media_ticket_invalid', 401) }
  const expected = signature(parts[0], secret)
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new StorageError('media_ticket_invalid', 401)
  let claims
  try { claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) } catch { throw new StorageError('media_ticket_invalid', 401) }
  if (!validateClaims(claims) || claims.grantType !== grantType) throw new StorageError('media_ticket_invalid', 401)
  const nowSeconds = Math.floor(now / 1000)
  const maxLifetime = grantType === 'ticket' ? MEDIA_TICKET_TTL_SECONDS : MEDIA_SESSION_TTL_SECONDS
  if (claims.issuedAt > nowSeconds + 30 || claims.expiresAt - claims.issuedAt > maxLifetime) throw new StorageError('media_ticket_invalid', 401)
  if (claims.expiresAt <= nowSeconds && !(allowExpired && grantType === 'ticket')) {
    throw new StorageError('media_ticket_expired', 401)
  }
  return claims
}

export function sameMediaIdentity(left, right) {
  if (!left || !right) return false
  const defaultDisposition = claims => claims.disposition
    ?? (claims.purpose === 'preview' ? 'inline' : 'attachment')
  return ['storageId', 'fileId', 'parentId', 'purpose', 'variant'].every(key => left[key] === right[key])
    && defaultDisposition(left) === defaultDisposition(right)
}

export function mediaSessionPath(claims, secret) {
  const disposition = claims.disposition ?? (claims.purpose === 'preview' ? 'inline' : 'attachment')
  const identity = JSON.stringify([
    claims.storageId, claims.fileId, claims.parentId, claims.purpose,
    claims.purpose === 'preview' ? claims.variant ?? null : null, disposition,
  ])
  const suffix = crypto.createHmac('sha256', requireSecret(secret)).update(identity).digest('base64url').slice(0, 22)
  return '/v1/media/' + suffix
}

export function createMediaTicket({ storageId, fileId, parentId = '', purpose, variant, disposition }, { secret, now = Date.now() } = {}) {
  const issuedAt = Math.floor(now / 1000)
  const contentDisposition = disposition ?? (purpose === 'preview' ? 'inline' : 'attachment')
  const claims = {
    version: 1,
    grantType: 'ticket',
    storageId,
    fileId,
    parentId,
    purpose,
    ...(purpose === 'preview' ? { variant } : {}),
    disposition: contentDisposition,
    issuedAt,
    expiresAt: issuedAt + MEDIA_TICKET_TTL_SECONDS,
  }
  if (!validateClaims(claims)) throw new StorageError('media_ticket_invalid', 400)
  return signClaims(claims, secret)
}

export function verifyMediaTicket(token, secret, options = {}) {
  return verifyGrant(token, secret, { ...options, grantType: 'ticket' })
}

export function createMediaSession(claims, { secret, now = Date.now() } = {}) {
  const issuedAt = Math.floor(now / 1000)
  const session = {
    version: claims?.version,
    grantType: 'session',
    storageId: claims?.storageId,
    fileId: claims?.fileId,
    parentId: claims?.parentId,
    purpose: claims?.purpose,
    ...(claims?.variant === undefined ? {} : { variant: claims.variant }),
    ...(claims?.disposition === undefined ? {} : { disposition: claims.disposition }),
    issuedAt,
    expiresAt: claims?.grantType === 'session' ? Math.min(claims.expiresAt, issuedAt + MEDIA_SESSION_TTL_SECONDS) : issuedAt + MEDIA_SESSION_TTL_SECONDS,
  }
  if (!validateClaims(session)) throw new StorageError('media_ticket_invalid', 400)
  return signClaims(session, secret)
}

export function verifyMediaSession(token, secret, options = {}) {
  return verifyGrant(token, secret, { ...options, grantType: 'session' })
}

export function mediaGatewayLocation({ storageId, fileId, parentId = '', purpose, variant, disposition }, { env = process.env, now = Date.now() } = {}) {
  const base = env.MEDIA_GATEWAY_URL
  const secret = env.MEDIA_GATEWAY_SIGNING_SECRET
  const siteDomain = env.MEDIA_GATEWAY_SITE_DOMAIN
  if (!base || !secret || !validSiteDomain(siteDomain)) throw new StorageError('media_gateway_not_configured', 503)
  let gateway
  try { gateway = new URL(base) } catch { throw new StorageError('media_gateway_not_configured', 503) }
  if (gateway.protocol !== 'https:' || gateway.username || gateway.password || gateway.search || gateway.hash || gateway.pathname !== '/') {
    throw new StorageError('media_gateway_not_configured', 503)
  }
  if (!isHostWithinDomain(gateway.hostname.toLowerCase(), siteDomain)) {
    throw new StorageError('media_gateway_not_configured', 503)
  }
  const ticket = createMediaTicket({ storageId, fileId, parentId, purpose, variant, disposition }, { secret, now })
  gateway.pathname = mediaSessionPath({ storageId, fileId, parentId, purpose, variant, disposition }, secret)
  gateway.searchParams.set('ticket', ticket)
  return gateway.toString()
}
