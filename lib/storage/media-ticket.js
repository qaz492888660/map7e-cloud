import crypto from 'node:crypto'
import { StorageError } from './errors.js'

export const MEDIA_TICKET_TTL_SECONDS = 5 * 60
export const MEDIA_SESSION_TTL_SECONDS = 6 * 60 * 60
const MEDIA_PURPOSES = new Set(['preview', 'original', 'video'])
const PREVIEW_VARIANTS = new Set(['preview', 'thumbnail'])
const STORAGE_ID = /^[a-z][a-z0-9-]{0,63}$/

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

function verifyGrant(token, secret, { now = Date.now(), grantType } = {}) {
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
  if (claims.expiresAt <= nowSeconds) throw new StorageError('media_ticket_expired', 401)
  return claims
}

export function createMediaTicket({ storageId, fileId, parentId = '', purpose, variant }, { secret, now = Date.now() } = {}) {
  const issuedAt = Math.floor(now / 1000)
  const claims = {
    version: 1,
    grantType: 'ticket',
    storageId,
    fileId,
    parentId,
    purpose,
    ...(purpose === 'preview' ? { variant } : {}),
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
    ...claims,
    grantType: 'session',
    issuedAt,
    expiresAt: issuedAt + MEDIA_SESSION_TTL_SECONDS,
  }
  if (!validateClaims(session)) throw new StorageError('media_ticket_invalid', 400)
  return signClaims(session, secret)
}

export function verifyMediaSession(token, secret, options = {}) {
  return verifyGrant(token, secret, { ...options, grantType: 'session' })
}

export function mediaGatewayLocation({ storageId, fileId, parentId = '', purpose, variant }, { env = process.env, now = Date.now() } = {}) {
  const base = env.MEDIA_GATEWAY_URL
  const secret = env.MEDIA_GATEWAY_SIGNING_SECRET
  if (!base || !secret) throw new StorageError('media_gateway_not_configured', 503)
  let gateway
  try { gateway = new URL(base) } catch { throw new StorageError('media_gateway_not_configured', 503) }
  if (gateway.protocol !== 'https:' || gateway.username || gateway.password || gateway.search || gateway.hash || gateway.pathname !== '/') {
    throw new StorageError('media_gateway_not_configured', 503)
  }
  const ticket = createMediaTicket({ storageId, fileId, parentId, purpose, variant }, { secret, now })
  gateway.pathname = '/v1/media'
  gateway.searchParams.set('ticket', ticket)
  return gateway.toString()
}
