import crypto from 'node:crypto'

export const ADMIN_COOKIE_NAME = 'map7e_admin_session'
export const ADMIN_SESSION_SECONDS = 60 * 60 * 24 * 7

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

export function adminAuthConfigured() {
  return Boolean(process.env.ADMIN_PASSWORD && process.env.PIKPAK_PAT)
}

export function adminPasswordMatches(supplied) {
  const expected = process.env.ADMIN_PASSWORD
  return Boolean(expected) && safeEqual(typeof supplied === 'string' ? supplied : '', expected)
}

export function createAdminSessionToken() {
  const expires = Math.floor(Date.now() / 1000) + ADMIN_SESSION_SECONDS
  const payload = encode(JSON.stringify({ role: 'admin', exp: expires }))
  return { expires, token: `${payload}.${sign(payload, process.env.PIKPAK_PAT)}` }
}

export function hasValidAdminSession(req) {
  const secret = process.env.PIKPAK_PAT
  if (!secret || !process.env.ADMIN_PASSWORD) return false

  const token = parseCookies(req.headers.cookie || '')[ADMIN_COOKIE_NAME]
  if (!token) return false
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return false

  const payload = token.slice(0, dot)
  if (!safeEqual(token.slice(dot + 1), sign(payload, secret))) return false
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return data?.role === 'admin' && Number(data?.exp || 0) > Math.floor(Date.now() / 1000)
  } catch {
    return false
  }
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

export function requireAdmin(req, res) {
  if (!adminAuthConfigured()) {
    res.status(503).json({ ok: false, error: 'admin_auth_not_configured', message: '请在服务端配置 ADMIN_PASSWORD。' })
    return false
  }
  if (!hasValidAdminSession(req)) {
    res.status(401).json({ ok: false, error: 'admin_authentication_required' })
    return false
  }
  return true
}
