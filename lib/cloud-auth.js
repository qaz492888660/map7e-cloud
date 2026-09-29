import crypto from 'node:crypto'

export const COOKIE_NAME = 'map7e_cloud_session'
export const SESSION_SECONDS = 60 * 60 * 24 * 7

function encode(value) {
  return Buffer.from(value).toString('base64url')
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url')
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

export function createSessionToken(secret) {
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS
  const payload = encode(JSON.stringify({ exp: expires }))
  return {
    expires,
    token: `${payload}.${sign(payload, secret)}`,
  }
}

export function hasValidSession(req, secret) {
  if (!secret) return false

  const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME]
  if (!token) return false

  const dot = token.lastIndexOf('.')
  if (dot <= 0) return false

  const payload = token.slice(0, dot)
  const signature = token.slice(dot + 1)

  if (!safeEqual(signature, sign(payload, secret))) return false

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return Number(data?.exp || 0) > Math.floor(Date.now() / 1000)
  } catch {
    return false
  }
}

export function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`
  )
}

export function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
  )
}
