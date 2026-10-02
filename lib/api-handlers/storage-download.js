import pikpakDownload from './pikpak-download.js'
import { resolveStorage } from '../storage/registry.js'
import { methodAllowed, sendStorageError, storageIdFrom } from '../storage/http.js'
import { requireItemRead } from '../storage/permissions.js'
import { StorageError } from '../storage/errors.js'
import { probeRange } from '../storage/previews.js'
export default async function handler(req, res) {
  if (!methodAllowed(req, res, 'GET')) return
  try {
    const context = await resolveStorage(storageIdFrom(req)), { instance, provider, auth } = context
    if (!auth) throw new StorageError('storage_authorization_required', 409)
    const rangeCheck = req.query?.check === 'range'
    if (instance.provider === 'pikpak' && !rangeCheck) {
      req.storageContext = context
      return pikpakDownload(req, res)
    }
    const id = typeof req.query?.id === 'string' ? req.query.id.trim() : '', parentId = typeof req.query?.parentId === 'string' ? req.query.parentId : ''
    if (!id) throw new StorageError('missing_file_id', 400)
    await requireItemRead(req, provider, instance.storageId, id, parentId, { rootFolderId: instance.rootFolderId || '' })
    if (rangeCheck) {
      let info
      if (typeof provider.getDownloadInfo === 'function') info = await provider.getDownloadInfo(id)
      else {
        const url = await provider.getDownloadUrl(id)
        info = { url, ...await probeRange(url) }
      }
      return res.status(200).json({
        ok: true,
        rangeSupported: Boolean(info.rangeSupported),
        status: info.status ?? null,
        acceptRanges: info.acceptRanges ?? null,
        contentRange: info.contentRange ?? null,
        contentType: info.contentType ?? null,
        contentLength: info.contentLength ?? null,
        totalLength: info.totalLength ?? null,
        etag: info.etag ?? null,
        lastModified: info.lastModified ?? null,
      })
    }
    const url = await provider.getDownloadUrl(id)
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Location', url); return res.status(302).end()
  } catch (error) { return sendStorageError(res, error) }
}
