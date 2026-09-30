import {
  adminAuthConfigured,
  createAdminSessionToken,
  setAdminSessionCookie,
  verifyAdminPassword,
} from '../admin-auth.js'
import { sendPersistentStoreError } from '../admin-store.js'

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }
  if (!adminAuthConfigured()) {
    return res.status(503).json({ ok: false, error: 'admin_auth_not_configured' })
  }

  try {
    const auth = await verifyAdminPassword(req.body?.password)
    if (!auth.configured) {
      return res.status(503).json({ ok: false, error: 'admin_auth_not_configured' })
    }
    if (!auth.ok) {
      return res.status(401).json({ ok: false, error: 'invalid_admin_password' })
    }

    const session = createAdminSessionToken(auth.sessionVersion)
    setAdminSessionCookie(res, session.token)
    return res.status(200).json({ ok: true, expiresAt: session.expires })
  } catch (error) {
    return sendPersistentStoreError(res, error)
  }
}
