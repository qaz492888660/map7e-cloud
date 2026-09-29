import { requireAdmin } from '../lib/admin-auth.js'
import { getGlobalAccessState, sendPersistentStoreError, setGlobalAccess } from '../lib/admin-store.js'

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }
  if (!requireAdmin(req, res)) return

  try {
    if (req.method === 'GET') {
      const state = await getGlobalAccessState()
      return res.status(200).json({ ok: true, ...state })
    }

    const globalAccess = req.body?.globalAccess
    if (!['public', 'locked'].includes(globalAccess)) {
      return res.status(400).json({ ok: false, error: 'invalid_global_access' })
    }
    const state = await setGlobalAccess(globalAccess)
    return res.status(200).json({ ok: true, ...state })
  } catch (error) {
    return sendPersistentStoreError(res, error)
  }
}
