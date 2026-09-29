import { hasValidAdminSession } from './admin-auth.js'
import { hasValidSession } from './cloud-auth.js'
import { getFolderMetadataMany, getGlobalAccessState, PersistentStoreError } from './admin-store.js'
import { pikpakItemFromPayload, readPikPakItem } from './pikpak-write.js'

export function normalizeFolderAccess(access) {
  return ['inherit', 'public', 'locked'].includes(access) ? access : 'inherit'
}

export function resolveFolderAccess(globalAccess, folderMetadata = []) {
  let requiresAuth = globalAccess === 'locked'
  for (const metadata of folderMetadata) {
    const access = normalizeFolderAccess(metadata?.access)
    if (access === 'public') requiresAuth = false
    if (access === 'locked') requiresAuth = true
  }
  return { requiresAuth, effectiveAccess: requiresAuth ? 'locked' : 'public' }
}

export function deriveChildFolderAccess(parentRequiresAuth, access) {
  const normalized = normalizeFolderAccess(access)
  if (normalized === 'public') return { requiresAuth: false, effectiveAccess: 'public' }
  if (normalized === 'locked') return { requiresAuth: true, effectiveAccess: 'locked' }
  return {
    requiresAuth: Boolean(parentRequiresAuth),
    effectiveAccess: parentRequiresAuth ? 'locked' : 'public',
  }
}

async function readFolderAncestors(token, folderId) {
  const reversed = []
  const seen = new Set()
  let currentId = String(folderId || '')

  while (currentId) {
    if (seen.has(currentId)) {
      throw new PersistentStoreError('invalid_folder_hierarchy', 'PikPak 返回了循环文件夹路径。')
    }
    if (seen.size >= 64) {
      throw new PersistentStoreError('folder_hierarchy_too_deep', '文件夹层级超过可读取范围。')
    }
    seen.add(currentId)

    const result = await readPikPakItem(token, currentId)
    if (!result.ok) return { error: result }
    const item = pikpakItemFromPayload(result.payload)
    if (item.kind !== 'drive#folder') {
      return { invalidFolder: true }
    }
    reversed.push(item)
    const parentId = String(item.parent_id || '')
    if (parentId === currentId) {
      throw new PersistentStoreError('invalid_folder_hierarchy', 'PikPak 返回了循环文件夹路径。')
    }
    currentId = parentId
  }

  return { folders: reversed.reverse() }
}

export async function getEffectiveFolderAccess(token, folderId = '') {
  const globalState = await getGlobalAccessState()
  if (!folderId) {
    return {
      ...resolveFolderAccess(globalState.globalAccess),
      globalAccess: globalState.globalAccess,
      storageReady: globalState.storageReady,
    }
  }

  const path = await readFolderAncestors(token, folderId)
  if (path.error) return { pikpakError: path.error }
  if (path.invalidFolder) return { invalidFolder: true }

  const metadata = await getFolderMetadataMany(path.folders.map((folder) => folder.id))
  const folderMetadata = path.folders.map((folder) => metadata.get(String(folder.id)))
  const policy = resolveFolderAccess(
    globalState.globalAccess,
    folderMetadata
  )
  const targetFolder = path.folders[path.folders.length - 1]
  const targetMetadata = folderMetadata[folderMetadata.length - 1]
  return {
    ...policy,
    globalAccess: globalState.globalAccess,
    storageReady: globalState.storageReady,
    folders: path.folders,
    folder: {
      id: String(targetFolder.id),
      parentId: String(targetFolder.parent_id || ''),
      name: String(targetFolder.name || '未命名文件夹'),
      writable: targetFolder.writable !== false,
      type: targetMetadata.type,
      access: targetMetadata.access,
      effectiveAccess: policy.effectiveAccess,
    },
  }
}

export async function requireFolderReadAccess(req, res, token, folderId = '', { allowPublicChildren = false } = {}) {
  const policy = await getEffectiveFolderAccess(token, folderId)
  if (policy.pikpakError) {
    res.status(502).json({ ok: false, error: 'pikpak_request_failed', message: '无法确认文件夹权限。' })
    return null
  }
  if (policy.invalidFolder) {
    res.status(404).json({ ok: false, error: 'folder_not_found' })
    return null
  }
  if (!policy.requiresAuth || hasValidAdminSession(req) || hasValidSession(req, token)) {
    return { ...policy, authorized: true }
  }

  if (allowPublicChildren && !folderId) {
    return { ...policy, authorized: false }
  }

  if (!process.env.CLOUD_PASSWORD) {
    res.status(503).json({ ok: false, error: 'cloud_login_not_configured' })
    return null
  }
  res.status(401).json({ ok: false, error: 'authentication_required' })
  return null
}
