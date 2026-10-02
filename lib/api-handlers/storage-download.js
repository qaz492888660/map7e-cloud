import pikpakDownload from './pikpak-download.js'
import { resolveStorage } from '../storage/registry.js'
import { methodAllowed, sendStorageError, storageIdFrom } from '../storage/http.js'
import { requireItemRead } from '../storage/permissions.js'
import { StorageError } from '../storage/errors.js'
import { probeRange } from '../storage/previews.js'
import { mediaGatewayLocation } from '../storage/media-ticket.js'
const VIDEO_EXTENSIONS = new Set(['3g2', '3gp', 'avi', 'm2ts', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'mts', 'ogv', 'ts', 'webm', 'wmv'])
const AMBIGUOUS_VIDEO_EXTENSIONS = new Set(['mts', 'ts'])
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
    const item = await requireItemRead(req, provider, instance.storageId, id, parentId, { rootFolderId: instance.rootFolderId || '' })
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
    if (instance.provider === 'quark') {
      const extension = String(item.extension || item.name?.split('.').pop() || '').toLowerCase()
      const mimeType = String(item.mimeType || '').toLowerCase()
      const extensionIsVideo = VIDEO_EXTENSIONS.has(extension)
        && (!AMBIGUOUS_VIDEO_EXTENSIONS.has(extension) || !mimeType || mimeType === 'application/octet-stream' || mimeType.startsWith('video/'))
      const purpose = mimeType.startsWith('video/') || extensionIsVideo ? 'video' : 'original'
      const location = mediaGatewayLocation({ storageId: instance.storageId, fileId: id, parentId: item.parentId, purpose })
      res.setHeader('Cache-Control', 'private, no-store')
      res.setHeader('Vary', 'Cookie')
      res.setHeader('Referrer-Policy', 'no-referrer')
      res.setHeader('Location', location)
      return res.status(302).end()
    }
    const url = await provider.getDownloadUrl(id)
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Location', url); return res.status(302).end()
  } catch (error) { return sendStorageError(res, error) }
}
