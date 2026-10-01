import { PersistentStoreError, sendPersistentStoreError } from '../admin-store.js'
import { StorageError } from './errors.js'
export function sendStorageError(res, error) {
  if (error instanceof PersistentStoreError) return sendPersistentStoreError(res, error)
  const known = error instanceof StorageError
  return res.status(known ? error.status : 502).json({ ok: false, error: known ? error.code : 'storage_unavailable' })
}
export function methodAllowed(req, res, method) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === method) return true
  res.setHeader('Allow', method); res.status(405).json({ ok: false, error: 'method_not_allowed' }); return false
}
export function storageIdFrom(req) { return typeof req.query?.storageId === 'string' ? req.query.storageId : typeof req.body?.storageId === 'string' ? req.body.storageId : undefined }
