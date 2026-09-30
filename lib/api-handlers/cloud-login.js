import crypto from 'node:crypto'

const COOKIE_NAME = 'map7e_cloud_session'
const SESSION_SECONDS = 60 * 60 * 24 * 7

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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }

  const password = process.env.CLOUD_PASSWORD
  const signingSecret = process.env.PIKPAK_PAT

  if (!password || !signingSecret) {
    return res.status(503).json({ ok: false, error: 'cloud_login_not_configured' })
  }

  const supplied = typeof req.body?.password === 'string' ? req.body.password : ''
  if (!safeEqual(supplied, password)) {
    return res.status(401).json({ ok: false, error: 'invalid_password' })
  }

  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS
  const payload = encode(JSON.stringify({ exp: expires }))
  const signature = sign(payload, signingSecret)
  const token = `${payload}.${signature}`

  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`
  )

  return res.status(200).json({ ok: true, expiresAt: expires })
}
