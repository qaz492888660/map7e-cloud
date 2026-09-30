import crypto from 'node:crypto'
import { requireAdmin, ADMIN_COOKIE_NAME } from '../admin-auth.js'
import { resolveStorage } from '../storage/registry.js'
import { writePending, readPending, clearPending, writeAuth, withLock } from '../storage/store.js'
import { beginQuarkAuthorization, finishQuarkAuthorization } from '../storage/providers/quark.js'
import { methodAllowed, sendStorageError } from '../storage/http.js'
import { StorageError } from '../storage/errors.js'
function sessionBinding(req) {
  const session = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${ADMIN_COOKIE_NAME}=`)) || ''
  return crypto.createHash('sha256').update(session).digest('hex')
}
export default async function handler(req, res) {
  if (!methodAllowed(req, res, 'POST')) return
  if (!await requireAdmin(req, res)) return
  try {
    const { instance } = await resolveStorage(req.body?.storageId)
    if (instance.provider !== 'quark') throw new StorageError('invalid_oauth_provider', 400)
    const id = instance.storageId
    if (req.body?.action === 'start') {
      const pending = await beginQuarkAuthorization(id), state = crypto.randomBytes(32).toString('base64url')
      await writePending(id, { ...pending, state, sessionBinding: sessionBinding(req), workDir: `map7e-cloud/${id}` })
      res.setHeader('Set-Cookie', `map7e_quark_oauth=${state}; Path=/api/quark-oauth; Max-Age=600; HttpOnly; Secure; SameSite=Strict`)
      return res.status(200).json({ ok: true, authorizeUrl: pending.authorizeUrl, expiresIn: 600 })
    }
    if (req.body?.action !== 'complete') throw new StorageError('invalid_oauth_action', 400)
    return await withLock(`oauth-${id}`, async () => {
      const pending = await readPending(id), cookie = String(req.headers.cookie || '')
      const state = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('map7e_quark_oauth='))?.slice('map7e_quark_oauth='.length)
      // Binding uses administrator session rather than the complete cookie header (OAuth adds a cookie).

      if (!pending || !state || state !== pending.state || sessionBinding(req) !== pending.sessionBinding) throw new StorageError('oauth_state_invalid', 400)
      const auth = await finishQuarkAuthorization(pending)
      if (!auth) return res.status(202).json({ ok: true, status: 'authorization_pending' })
      await writeAuth(id, auth); await clearPending(id)
      res.setHeader('Set-Cookie', 'map7e_quark_oauth=; Path=/api/quark-oauth; Max-Age=0; HttpOnly; Secure; SameSite=Strict')
      return res.status(200).json({ ok: true, status: 'authorized', storageId: id })
    })
  } catch (error) { return sendStorageError(res, error) }
}
