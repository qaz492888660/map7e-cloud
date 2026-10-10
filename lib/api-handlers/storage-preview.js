import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { resolveStorage } from '../storage/registry.js'
import { methodAllowed, sendStorageError, storageIdFrom } from '../storage/http.js'
import { requireItemRead } from '../storage/permissions.js'
import { StorageError } from '../storage/errors.js'
import { isAllowedPreviewContentType, logPreviewDiagnostic } from '../storage/previews.js'
import { mediaGatewayLocation } from '../storage/media-ticket.js'

function copySafeHeader(res, name, value, valid) {
  if (value && value.length <= 512 && !/[\r\n]/.test(value) && valid(value)) res.setHeader(name, value)
}

export default async function handler(req, res) {
  if (!methodAllowed(req, res, 'GET')) return
  let upstream
  let providerName = 'unknown'
  let stage = 'resolve_storage'
  const startedAt = Date.now()
  try {
    const { instance, provider, auth } = await resolveStorage(storageIdFrom(req))
    providerName = instance?.provider || provider?.instance?.provider || 'unknown'
    logPreviewDiagnostic({ provider: providerName, stage: 'storage_resolved' })
    if (!auth) throw new StorageError('storage_authorization_required', 409)
    const id = typeof req.query?.id === 'string' ? req.query.id.trim() : ''
    const parentId = typeof req.query?.parentId === 'string' ? req.query.parentId : ''
    const variant = req.query?.variant === 'thumbnail' ? 'thumbnail' : req.query?.variant === 'preview' ? 'preview' : ''
    if (!id) throw new StorageError('missing_file_id', 400)
    if (!variant) throw new StorageError('invalid_preview_variant', 400)

    stage = 'permission_check'
    const permissionStartedAt = Date.now()
    const item = await requireItemRead(req, provider, instance.storageId, id, parentId, { rootFolderId: instance.rootFolderId || '' })
    logPreviewDiagnostic({ provider: providerName, stage: 'permission_check_passed', durationMs: Date.now() - permissionStartedAt })
    if (instance.provider === 'quark') {
      const location = mediaGatewayLocation({ storageId: instance.storageId, fileId: id, parentId: item.parentId, purpose: 'preview', variant })
      res.setHeader('Cache-Control', 'private, no-store')
      res.setHeader('Vary', 'Cookie')
      res.setHeader('Referrer-Policy', 'no-referrer')
      res.setHeader('Location', location)
      return res.status(302).end()
    }
    const getAsset = variant === 'thumbnail' ? provider.getThumbnail : provider.getPreview
    if (typeof getAsset !== 'function') throw new StorageError('preview_unavailable', 404)
    stage = 'provider_preview'
    upstream = await getAsset.call(provider, id, { item })
    if (!upstream?.body || upstream.status !== 200) throw new StorageError('preview_unavailable', 502)

    stage = 'content_type_validation'
    const contentType = String(upstream.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase()
    if (!isAllowedPreviewContentType(contentType)) {
      logPreviewDiagnostic({ provider: providerName, variant, stage: 'content_type_rejected', status: upstream.status, contentType })
      throw new StorageError('preview_content_type_unsupported', 415)
    }

    res.setHeader('Cache-Control', 'private, max-age=60, must-revalidate')
    res.setHeader('Vary', 'Cookie')
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Disposition', 'inline')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
    copySafeHeader(res, 'Content-Length', upstream.headers.get('content-length'), value => /^\d+$/.test(value))
    copySafeHeader(res, 'ETag', upstream.headers.get('etag'), value => /^(?:W\/)?"[^"\r\n]*"$/.test(value))
    copySafeHeader(res, 'Last-Modified', upstream.headers.get('last-modified'), value => Number.isFinite(Date.parse(value)))

    res.status(200)
    stage = 'streaming'
    await pipeline(Readable.fromWeb(upstream.body), res)
    logPreviewDiagnostic({ provider: providerName, variant, stage: 'stream_complete', durationMs: Date.now() - startedAt })
  } catch (error) {
    logPreviewDiagnostic({
      provider: providerName,
      stage: `${stage}_failed`,
      durationMs: Date.now() - startedAt,
      errorCode: typeof error?.code === 'string' ? error.code : undefined,
      errorName: typeof error?.name === 'string' ? error.name : undefined,
    })
    if (upstream?.body && !res.headersSent) await upstream.body.cancel().catch(() => {})
    if (res.headersSent) {
      res.destroy?.(error)
      return
    }
    return sendStorageError(res, error)
  }
}
