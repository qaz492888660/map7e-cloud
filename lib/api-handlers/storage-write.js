import pikpakCreateFolder from './pikpak-create-folder.js'
import pikpakRename from './pikpak-rename.js'
import pikpakTrash from './pikpak-trash.js'
import pikpakUploadTicket from './pikpak-upload-ticket.js'
import { resolveStorage } from '../storage/registry.js'
import { metadataId } from '../storage/store.js'
import { methodAllowed, sendStorageError, storageIdFrom } from '../storage/http.js'
import { StorageError, unsupported } from '../storage/errors.js'
import { requireStorageWrite } from '../storage/permissions.js'
import { requireFolderWithinRoot } from '../storage/root.js'
import { hasValidAdminSession } from '../admin-auth.js'
import { getGlobalAccessState, setFolderMetadata } from '../admin-store.js'
const legacy = { createFolder: pikpakCreateFolder, rename: pikpakRename, trash: pikpakTrash, upload: pikpakUploadTicket }
export function storageWrite(capability) {
  return async function handler(req, res) {
    if (!methodAllowed(req, res, 'POST')) return
    try {
      const context = await resolveStorage(storageIdFrom(req)), { instance, provider, auth } = context
      if (!provider.capabilities[capability]) return unsupported(capability)
      if (!auth) throw new StorageError('storage_authorization_required', 409)
      let parentId = typeof req.body?.parentId === 'string' ? req.body.parentId : ''
      if (req.body?.parentId !== undefined && typeof req.body.parentId !== 'string') throw new StorageError('invalid_parent_id', 400)
      const rootFolderId = typeof instance.rootFolderId === 'string' ? instance.rootFolderId : ''
      let scopedParent = null
      if (rootFolderId) {
        const writesIntoParent = capability === 'createFolder' || capability === 'upload'
        if (writesIntoParent && !parentId) parentId = rootFolderId
        if (!parentId) throw new StorageError('file_not_found', 404)
        scopedParent = await requireFolderWithinRoot(provider, rootFolderId, parentId)
      }
      if (instance.provider === 'pikpak') {
        req.storageContext = context
        if (rootFolderId) req.body = { ...req.body, parentId }
        return legacy[capability](req, res)
      }
      await requireStorageWrite(req)
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
      if (!name || [...name].length > 255 || /[\u0000-\u001f\u007f/\\]/.test(name)) throw new StorageError('invalid_folder_name', 400)
      const type = req.body?.type ?? 'folder', access = req.body?.access ?? 'inherit'
      if (!['folder', 'album'].includes(type) || !['inherit', 'public', 'locked'].includes(access)) throw new StorageError('invalid_folder_metadata', 400)
      const saveMetadata = type !== 'folder' || access !== 'inherit'
      if (saveMetadata) {
        if (!await hasValidAdminSession(req)) throw new StorageError('admin_authentication_required', 401)
        if (!(await getGlobalAccessState()).storageReady) throw new StorageError('persistent_storage_not_configured', 503)
      }
      if (parentId && !(scopedParent || await provider.getItem(parentId)).isFolder) throw new StorageError('parent_is_not_folder', 400)
      const result = await provider.createFolder({ name, parentId })
      let metadataSaved = true
      if (saveMetadata) { try { await setFolderMetadata(metadataId(instance.storageId, result.item.id), { type, access }) } catch { metadataSaved = false } }
      return res.status(200).json({ ok: true, ...result, metadataSaved })
    } catch (error) { return sendStorageError(res, error) }
  }
}
