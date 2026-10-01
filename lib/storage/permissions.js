import { hasValidAdminSession } from '../admin-auth.js'
import { hasValidSession } from '../cloud-auth.js'
import { getGlobalAccessState, getFolderMetadataMany, getFileMetadata } from '../admin-store.js'
import { resolveFolderAccess, deriveChildFolderAccess } from '../pikpak-permissions.js'
import { metadataId } from './store.js'
import { StorageError } from './errors.js'
import { folderPathWithinRoot } from './root.js'

export async function storageSessionAuthorized(req) {
  return await hasValidAdminSession(req) || await hasValidSession(req, process.env.PIKPAK_PAT)
}

export async function folderPolicy(provider, storageId, folderId = '', { rootFolderId = '' } = {}) {
  const [state, folders] = await Promise.all([
    getGlobalAccessState(),
    folderPathWithinRoot(provider, folderId, rootFolderId),
  ])
  const metadata = await getFolderMetadataMany(folders.map(folder => metadataId(storageId, folder.id)))
  const policy = resolveFolderAccess(state.globalAccess, folders.map(folder => metadata.get(metadataId(storageId, folder.id))))
  const target = folders.at(-1), meta = target && metadata.get(metadataId(storageId, target.id))
  return {
    ...policy,
    folder: target ? {
      ...target,
      type: meta?.type || 'folder',
      access: meta?.access || 'inherit',
      effectiveAccess: policy.effectiveAccess,
    } : null,
  }
}

export async function requireStorageWrite(req) {
  if (!await storageSessionAuthorized(req)) throw new StorageError(process.env.CLOUD_PASSWORD ? 'authentication_required' : 'cloud_login_not_configured', process.env.CLOUD_PASSWORD ? 401 : 503)
}

export async function requireItemRead(req, provider, storageId, id, parentId, { rootFolderId = '' } = {}) {
  const item = await provider.getItem(id)
  const expectedParentId = provider?.instance?.provider === 'quark' && parentId === '0' ? '' : parentId
  if (item.parentId !== expectedParentId) throw new StorageError('file_not_found', 404)
  if (item.isFolder) throw new StorageError('cannot_download_folder', 400)
  const policy = await folderPolicy(provider, storageId, parentId, { rootFolderId })
  const metadata = await getFileMetadata(metadataId(storageId, id))
  if (deriveChildFolderAccess(policy.requiresAuth, metadata.access).requiresAuth && !await storageSessionAuthorized(req)) throw new StorageError(process.env.CLOUD_PASSWORD ? 'authentication_required' : 'cloud_login_not_configured', process.env.CLOUD_PASSWORD ? 401 : 503)
  return item
}
