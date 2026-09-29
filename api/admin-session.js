import { requireAdmin } from '../lib/admin-auth.js'

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }
  if (!await requireAdmin(req, res)) return
  return res.status(200).json({ ok: true, role: 'admin' })
}
