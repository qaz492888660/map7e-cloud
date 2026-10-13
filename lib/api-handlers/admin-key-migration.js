import { requireAdmin } from '../admin-auth.js'
import { inspectStorageKeyMigration, runStorageKeyMigration } from '../storage/key-migration.js'
import { sendStorageError } from '../storage/http.js'

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Vary', 'Cookie')
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }
  if (!await requireAdmin(req, res)) return
  try {
    if (req.method === 'GET') return res.status(200).json(await inspectStorageKeyMigration())
    // No key, credential, database URL or ciphertext is accepted over HTTP.
    const body = req.body || {}, allowed = new Set(['action', 'id', 'confirm'])
    if (Object.keys(body).some(key => !allowed.has(key)) || body.confirm !== `storage-key-migration:${body.action}`) {
      return res.status(400).json({ ok: false, error: 'storage_key_migration_confirmation_required' })
    }
    const origin = req.headers?.origin
    if ((origin && origin !== `https://${req.headers?.host}`) || req.headers?.['sec-fetch-site'] === 'cross-site') {
      return res.status(403).json({ ok: false, error: 'storage_key_migration_origin_forbidden' })
    }
    return res.status(200).json(await runStorageKeyMigration(body.action, { id: body.id }))
  } catch (error) { return sendStorageError(res, error) }
}
