import {
  adminAuthConfigured,
  adminPasswordMatches,
  createAdminSessionToken,
  setAdminSessionCookie,
} from '../lib/admin-auth.js'

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }
  if (!adminAuthConfigured()) {
    return res.status(503).json({ ok: false, error: 'admin_auth_not_configured' })
  }
  if (!adminPasswordMatches(req.body?.password)) {
    return res.status(401).json({ ok: false, error: 'invalid_admin_password' })
  }

  const session = createAdminSessionToken()
  setAdminSessionCookie(res, session.token)
  return res.status(200).json({ ok: true, expiresAt: session.expires })
}
