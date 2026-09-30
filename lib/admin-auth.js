import crypto from 'node:crypto'
import { promisify } from 'node:util'
import {
  bootstrapAdminAuthRecord,
  getAdminAuthRecord,
  isPersistentStoreConfigured,
  replaceAdminPasswordHash,
  sendPersistentStoreError,
} from './admin-store.js'

export const ADMIN_COOKIE_NAME = 'map7e_admin_session'
export const ADMIN_SESSION_SECONDS = 60 * 60 * 24 * 7

const scrypt = promisify(crypto.scrypt)
const SCRYPT_COST = 16384
const SCRYPT_BLOCK_SIZE = 8
const SCRYPT_PARALLELIZATION = 1
const PASSWORD_HASH_BYTES = 64
const PASSWORD_SALT_BYTES = 16
const MAX_PASSWORD_BYTES = 1024

function encode(value) {
  return Buffer.from(value).toString('base64url')
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(`admin.${payload}`).digest('base64url')
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=')
        return index >= 0 ? [part.slice(0, index), part.slice(index + 1)] : [part, '']
      })
  )
}

async function derivePasswordHash(password, salt) {
  return scrypt(password, salt, PASSWORD_HASH_BYTES, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: 64 * 1024 * 1024,
  })
}

export function adminAuthConfigured() {
  return Boolean(process.env.PIKPAK_PAT && (process.env.ADMIN_PASSWORD || isPersistentStoreConfigured()))
}

export async function hashAdminPassword(password) {
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new TypeError('管理员密码长度无效。')
  }
  const salt = crypto.randomBytes(PASSWORD_SALT_BYTES)
  const hash = await derivePasswordHash(password, salt)
  return `scrypt$${SCRYPT_COST}$${SCRYPT_BLOCK_SIZE}$${SCRYPT_PARALLELIZATION}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

export async function adminPasswordHashMatches(supplied, encodedHash) {
  if (typeof supplied !== 'string' || Buffer.byteLength(supplied, 'utf8') > MAX_PASSWORD_BYTES) return false
  if (typeof encodedHash !== 'string') return false

  const [algorithm, cost, blockSize, parallelization, saltText, hashText, extra] = encodedHash.split('$')
  if (
    algorithm !== 'scrypt' ||
    cost !== String(SCRYPT_COST) ||
    blockSize !== String(SCRYPT_BLOCK_SIZE) ||
    parallelization !== String(SCRYPT_PARALLELIZATION) ||
    !saltText || !hashText || extra !== undefined
  ) {
    return false
  }

  const salt = Buffer.from(saltText, 'base64url')
  const expected = Buffer.from(hashText, 'base64url')
  if (salt.length !== PASSWORD_SALT_BYTES || expected.length !== PASSWORD_HASH_BYTES) return false

  const actual = await derivePasswordHash(supplied, salt)
  return crypto.timingSafeEqual(actual, expected)
}

export async function verifyAdminPassword(supplied) {
  if (!process.env.PIKPAK_PAT || typeof supplied !== 'string') {
    return { ok: false, configured: false, sessionVersion: 0, passwordHash: null }
  }

  const record = await getAdminAuthRecord()
  if (record.passwordHash) {
    return {
      ok: await adminPasswordHashMatches(supplied, record.passwordHash),
      configured: true,
      sessionVersion: record.sessionVersion,
      passwordHash: record.passwordHash,
    }
  }

  const bootstrapPassword = process.env.ADMIN_PASSWORD
  if (!bootstrapPassword || Buffer.byteLength(bootstrapPassword, 'utf8') > MAX_PASSWORD_BYTES) {
    return { ok: false, configured: false, sessionVersion: record.sessionVersion, passwordHash: null }
  }
  if (!safeEqual(supplied, bootstrapPassword)) {
    return { ok: false, configured: true, sessionVersion: record.sessionVersion, passwordHash: null }
  }

  if (!record.storageReady) {
    return { ok: true, configured: true, sessionVersion: record.sessionVersion, passwordHash: null }
  }

  const bootstrapHash = await hashAdminPassword(bootstrapPassword)
  const bootstrapped = await bootstrapAdminAuthRecord(bootstrapHash)
  if (bootstrapped) {
    return { ok: true, configured: true, sessionVersion: 0, passwordHash: bootstrapHash }
  }

  // A concurrent first login or password change may have won the atomic bootstrap.
  // In that case, the environment value must not override or bypass the stored hash.
  const latest = await getAdminAuthRecord()
  if (!latest.passwordHash) {
    throw new Error('管理员密码初始化状态无法读取。')
  }
  const matches = await adminPasswordHashMatches(supplied, latest.passwordHash)
  return {
    ok: matches,
    configured: true,
    sessionVersion: latest.sessionVersion,
    passwordHash: matches ? latest.passwordHash : null,
  }
}

function readAdminSession(req) {
  const secret = process.env.PIKPAK_PAT
  if (!secret) return null

  const token = parseCookies(req?.headers?.cookie || '')[ADMIN_COOKIE_NAME]
  if (!token) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null

  const payload = token.slice(0, dot)
  if (!safeEqual(token.slice(dot + 1), sign(payload, secret))) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    const sessionVersion = data?.sessionVersion === undefined ? 0 : Number(data.sessionVersion)
    if (
      data?.role !== 'admin' ||
      Number(data?.exp || 0) <= Math.floor(Date.now() / 1000) ||
      !Number.isSafeInteger(sessionVersion) ||
      sessionVersion < 0
    ) {
      return null
    }
    return { sessionVersion }
  } catch {
    return null
  }
}

export function createAdminSessionToken(sessionVersion = 0) {
  const expires = Math.floor(Date.now() / 1000) + ADMIN_SESSION_SECONDS
  const version = Number.isSafeInteger(sessionVersion) && sessionVersion >= 0 ? sessionVersion : 0
  const payload = encode(JSON.stringify({ role: 'admin', exp: expires, sessionVersion: version }))
  return { expires, token: `${payload}.${sign(payload, process.env.PIKPAK_PAT)}` }
}

export async function hasValidAdminSession(req) {
  const session = readAdminSession(req)
  if (!session) return false
  const record = await getAdminAuthRecord()
  return session.sessionVersion === record.sessionVersion
}

export function setAdminSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `${ADMIN_COOKIE_NAME}=${token}; Path=/; Max-Age=${ADMIN_SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`
  )
}

export function clearAdminSessionCookie(res) {
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`)
}

export async function requireAdmin(req, res) {
  if (!adminAuthConfigured()) {
    res.status(503).json({ ok: false, error: 'admin_auth_not_configured', message: '请在服务端配置管理员初始化密码或已有管理员密码记录。' })
    return false
  }
  try {
    if (!await hasValidAdminSession(req)) {
      res.status(401).json({ ok: false, error: 'admin_authentication_required' })
      return false
    }
    return true
  } catch (error) {
    sendPersistentStoreError(res, error)
    return false
  }
}

export async function changeAdminPassword({ currentPassword, newPassword }) {
  const auth = await verifyAdminPassword(currentPassword)
  if (!auth.configured) return { ok: false, reason: 'not_configured' }
  if (!auth.ok || !auth.passwordHash) return { ok: false, reason: 'current_password_invalid' }

  const nextHash = await hashAdminPassword(newPassword)
  const result = await replaceAdminPasswordHash(auth.passwordHash, nextHash)
  return result.changed
    ? { ok: true, sessionVersion: result.sessionVersion }
    : { ok: false, reason: 'password_changed_concurrently' }
}
