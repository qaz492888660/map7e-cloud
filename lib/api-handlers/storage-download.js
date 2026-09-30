import pikpakDownload from './pikpak-download.js'
import { resolveStorage } from '../storage/registry.js'
import { methodAllowed, sendStorageError, storageIdFrom } from '../storage/http.js'
import { requireItemRead } from '../storage/permissions.js'
import { StorageError } from '../storage/errors.js'
export default async function handler(req, res) {
  if (!methodAllowed(req, res, 'GET')) return
  try {
    const context = await resolveStorage(storageIdFrom(req)), { instance, provider, auth } = context
    if (!auth) throw new StorageError('storage_authorization_required', 409)
    if (instance.provider === 'pikpak') return pikpakDownload({ ...req, storageContext: context }, res)
    const id = typeof req.query?.id === 'string' ? req.query.id.trim() : '', parentId = typeof req.query?.parentId === 'string' ? req.query.parentId : ''
    if (!id) throw new StorageError('missing_file_id', 400)
    await requireItemRead(req, provider, instance.storageId, id, parentId)
    const url = await provider.getDownloadUrl(id)
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Location', url); return res.status(302).end()
  } catch (error) { return sendStorageError(res, error) }
}
