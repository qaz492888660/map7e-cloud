import pikpakFiles from './pikpak-files.js'
import { resolveStorage } from '../storage/registry.js'
import { metadataId } from '../storage/store.js'
import { methodAllowed, sendStorageError, storageIdFrom } from '../storage/http.js'
import { StorageError } from '../storage/errors.js'
import { folderPolicy, storageSessionAuthorized } from '../storage/permissions.js'
import { getFolderMetadataMany, getFileMetadataMany } from '../admin-store.js'
import { deriveChildFolderAccess } from '../pikpak-permissions.js'
export default async function handler(req, res) {
  if (!methodAllowed(req, res, 'GET')) return
  try {
    const context = await resolveStorage(storageIdFrom(req)), { instance, provider, auth } = context
    if (!auth) throw new StorageError('storage_authorization_required', 409)
    if (instance.provider === 'pikpak') {
      req.storageContext = req.storageAdminBrowse
        ? { ...context, instance: { ...instance, rootFolderId: null, rootFolderName: null } }
        : context
      if (!req.storageAdminBrowse && instance.rootFolderId) {
        const requestedParentId = typeof req.query?.parentId === 'string' ? req.query.parentId : ''
        const parentId = requestedParentId || instance.rootFolderId
        req.query = { ...req.query, parentId }
      }
      return pikpakFiles(req, res)
    }
    const requestedParentId = typeof req.query?.parentId === 'string' ? req.query.parentId : ''
    const virtualRoot = !req.storageAdminBrowse && !requestedParentId && Boolean(instance.rootFolderId)
    const parentId = virtualRoot ? instance.rootFolderId : requestedParentId
    const policy = await folderPolicy(provider, instance.storageId, parentId, { rootFolderId: req.storageAdminBrowse ? '' : (instance.rootFolderId || '') })
    const authorized = !policy.requiresAuth || await storageSessionAuthorized(req)
    if (!authorized && parentId) throw new StorageError('authentication_required', 401)
    let pageToken = authorized && typeof req.query?.pageToken === 'string' ? req.query.pageToken : '', items = [], listing, seen = new Set(), pages = 0
    do {
      listing = await provider.listFiles({ parentId, pageToken }); items.push(...listing.items); pages++
      if (authorized || !listing.nextPageToken) break
      if (seen.has(listing.nextPageToken) || pages >= 50) throw new StorageError('public_folder_preview_too_large', 413)
      seen.add(listing.nextPageToken); pageToken = listing.nextPageToken
      if (listing.nextRequestDelayMs > 0) { if (listing.nextRequestDelayMs > 1000) throw new StorageError('quark_rate_limited', 429); await new Promise(resolve => setTimeout(resolve, listing.nextRequestDelayMs)) }
    } while (pageToken)
    const [folders, files] = await Promise.all([
      getFolderMetadataMany(items.filter(i => i.isFolder).map(i => metadataId(instance.storageId, i.id))),
      getFileMetadataMany(items.filter(i => !i.isFolder).map(i => metadataId(instance.storageId, i.id))),
    ])
    items = items.map(item => {
      const metadata = (item.isFolder ? folders : files).get(metadataId(instance.storageId, item.id)), access = metadata?.access || 'inherit'
      return { ...item, storageId: instance.storageId, thumbnail: item.thumbnail, ...(item.isFolder ? { folderType: metadata?.type || 'folder' } : {}), access, effectiveAccess: deriveChildFolderAccess(policy.requiresAuth, access).effectiveAccess }
    })
    if (!authorized) { items = items.filter(i => i.access === 'public'); if (!items.length) throw new StorageError('authentication_required', 401) }
    const nextRequestDelayMs = authorized && listing.nextPageToken ? Number(listing.nextRequestDelayMs || 0) : 0
    if (!Number.isFinite(nextRequestDelayMs) || nextRequestDelayMs < 0) throw new StorageError('storage_response_invalid', 502)
    return res.status(200).json({ ok: true, storageId: instance.storageId, parentId: virtualRoot || !parentId ? null : parentId, access: policy.effectiveAccess, folder: policy.folder, items, restrictedPreview: !authorized, nextPageToken: authorized ? listing.nextPageToken : null, nextRequestDelayMs })
  } catch (error) { return sendStorageError(res, error) }
}
