import { clearAdminSessionCookie } from '../lib/admin-auth.js'

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }
  clearAdminSessionCookie(res)
  return res.status(200).json({ ok: true })
}
