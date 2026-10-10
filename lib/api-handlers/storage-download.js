import pikpakDownload from './pikpak-download.js'
import { resolveStorage } from '../storage/registry.js'
import { methodAllowed, sendStorageError, storageIdFrom } from '../storage/http.js'
import { requireItemRead } from '../storage/permissions.js'
import { StorageError } from '../storage/errors.js'
import { probeRange } from '../storage/previews.js'
import { mediaGatewayLocation } from '../storage/media-ticket.js'
import { QUARK_FILE_SIZE_LIMIT } from '../storage/quark-download-limit.js'
import { createMediaProbeScope, MEDIA_PROBE_DEADLINE_HEADER, MEDIA_PROBE_DEADLINE_ERROR, MEDIA_PROBE_TIMEOUT_MS } from '../storage/media-probe.js'
const VIDEO_EXTENSIONS = new Set(['3g2', '3gp', 'avi', 'm2ts', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'mts', 'ogv', 'ts', 'webm', 'wmv'])
const AMBIGUOUS_VIDEO_EXTENSIONS = new Set(['mts', 'ts'])

function mediaPurpose(item) {
  const extension = String(item.extension || item.name?.split('.').pop() || '').toLowerCase()
  const mimeType = String(item.mimeType || '').toLowerCase()
  const extensionIsVideo = VIDEO_EXTENSIONS.has(extension)
    && (!AMBIGUOUS_VIDEO_EXTENSIONS.has(extension) || !mimeType || mimeType === 'application/octet-stream' || mimeType.startsWith('video/'))
  return mimeType.startsWith('video/') || extensionIsVideo ? 'video' : 'original'
}

export async function quarkGatewayRangeCheck(instance, item, id, { signal, timeoutMs = MEDIA_PROBE_TIMEOUT_MS, now = Date.now } = {}) {
  const location = mediaGatewayLocation({
    storageId: instance.storageId,
    fileId: id,
    parentId: item.parentId,
    purpose: mediaPurpose(item),
  })
  let response
  const probe = createMediaProbeScope({ timeoutMs, signal,
    errorFor: code => new StorageError(code === MEDIA_PROBE_DEADLINE_ERROR ? 'storage_range_probe_timeout' : 'storage_range_probe_cancelled', code === MEDIA_PROBE_DEADLINE_ERROR ? 504 : 499) })
  try {
    response = await probe.fetch(fetch)(location, {
      method: 'HEAD',
      headers: { Range: 'bytes=0-0', [MEDIA_PROBE_DEADLINE_HEADER]: String(now() + timeoutMs) },
      cache: 'no-store',
      redirect: 'manual',
    })
  } catch {
    if (probe.signal.aborted) throw probe.signal.reason
    throw new StorageError('storage_range_probe_failed', 502)
  } finally { probe.dispose() }
  const contentRange = response.headers.get('content-range')
  const match = /^bytes 0-0\/(\d+|\*)$/i.exec(String(contentRange || ''))
  const contentLength = response.headers.get('content-length')
  const rangeSupported = response.status === 206 && Boolean(match) && (contentLength === null || contentLength === '1')
  const totalLength = match && match[1] !== '*' ? Number(match[1]) : null
  const result = {
    ok: true,
    rangeSupported,
    status: response.status,
    acceptRanges: response.headers.get('accept-ranges'),
    contentRange: match ? contentRange : null,
    contentType: response.headers.get('content-type'),
    contentLength: contentLength === null ? null : Number(contentLength),
    totalLength: Number.isSafeInteger(totalLength) ? totalLength : null,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
  }
  await response.body?.cancel().catch(() => {})
  if (response.status === 422 && response.headers.get('x-media-error') === QUARK_FILE_SIZE_LIMIT) {
    const value = response.headers.get('x-media-limit-bytes')
    const error = new StorageError(QUARK_FILE_SIZE_LIMIT, 422)
    if (/^[1-9]\d{0,14}$/.test(value || '')) error.limitBytes = Number(value)
    throw error
  }
  if (response.status === 504 && response.headers.get('x-media-error') === MEDIA_PROBE_DEADLINE_ERROR) {
    throw new StorageError('storage_range_probe_timeout', 504)
  }
  if (response.status >= 400) throw new StorageError('storage_range_probe_failed', 502)
  return result
}

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
    if (instance.provider === 'quark' && req.query?.check === 'download') {
      // Source availability/policy is independent of CDN Range support.
      // Signed source URLs stay server-side; attachment GET uses the normal
      // authenticated Worker route.
      await provider.getDownloadUrl(id)
      res.setHeader('Cache-Control', 'private, no-store')
      res.setHeader('Vary', 'Cookie')
      return res.status(200).json({ ok: true })
    }
    if (rangeCheck) {
      if (instance.provider === 'quark') {
        const controller = new AbortController()
        const cancel = () => { if (!res.writableEnded) controller.abort() }
        req.once?.('aborted', cancel)
        res.once?.('close', cancel)
        if (req.aborted || res.destroyed) cancel()
        try {
          const result = await quarkGatewayRangeCheck(instance, item, id, { signal: controller.signal })
          return res.status(200).json(result)
        } finally {
          req.removeListener?.('aborted', cancel)
          res.removeListener?.('close', cancel)
        }
      }
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
      const purpose = mediaPurpose(item)
      const disposition = req.query?.inline === '1' ? 'inline' : 'attachment'
      const location = mediaGatewayLocation({ storageId: instance.storageId, fileId: id, parentId: item.parentId, purpose, disposition })
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
