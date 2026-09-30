import { hasValidAdminSession } from '../admin-auth.js'
import { hasValidSession } from '../cloud-auth.js'
import { getGlobalAccessState, getFolderMetadataMany, getFileMetadata } from '../admin-store.js'
import { resolveFolderAccess, deriveChildFolderAccess } from '../pikpak-permissions.js'
import { metadataId } from './store.js'
import { StorageError } from './errors.js'
export async function storageSessionAuthorized(req) { return await hasValidAdminSession(req) || hasValidSession(req, process.env.PIKPAK_PAT) }
export async function folderPolicy(provider, storageId, folderId = '') {
  const state = await getGlobalAccessState(), folders = [], seen = new Set()
  let id = folderId
  while (id) {
    if (seen.has(id) || seen.size >= 64) throw new StorageError('invalid_folder_hierarchy')
    seen.add(id)
    const item = await provider.getItem(id)
    if (!item.isFolder) throw new StorageError('folder_not_found', 404)
    folders.unshift(item); id = item.parentId
  }
  const metadata = await getFolderMetadataMany(folders.map(f => metadataId(storageId, f.id)))
  const policy = resolveFolderAccess(state.globalAccess, folders.map(f => metadata.get(metadataId(storageId, f.id))))
  const target = folders.at(-1), meta = target && metadata.get(metadataId(storageId, target.id))
  return { ...policy, folder: target ? { ...target, type: meta.type, access: meta.access, effectiveAccess: policy.effectiveAccess } : null }
}
export async function requireStorageWrite(req) {
  if (!await storageSessionAuthorized(req)) throw new StorageError(process.env.CLOUD_PASSWORD ? 'authentication_required' : 'cloud_login_not_configured', process.env.CLOUD_PASSWORD ? 401 : 503)
}
export async function requireItemRead(req, provider, storageId, id, parentId) {
  const item = await provider.getItem(id)
  if (item.parentId !== parentId) throw new StorageError('file_not_found', 404)
  if (item.isFolder) throw new StorageError('cannot_download_folder', 400)
  const policy = await folderPolicy(provider, storageId, parentId), metadata = await getFileMetadata(metadataId(storageId, id))
  if (deriveChildFolderAccess(policy.requiresAuth, metadata.access).requiresAuth && !await storageSessionAuthorized(req)) throw new StorageError(process.env.CLOUD_PASSWORD ? 'authentication_required' : 'cloud_login_not_configured', process.env.CLOUD_PASSWORD ? 401 : 503)
  return item
}
