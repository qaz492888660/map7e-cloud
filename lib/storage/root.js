import { StorageError } from './errors.js'

export async function folderPathWithinRoot(provider, folderId, rootFolderId = '') {
  const normalizeId = (value) => {
    const id = typeof value === 'string' ? value : ''
    return provider?.instance?.provider === 'quark' && id === '0' ? '' : id
  }
  const rootId = normalizeId(rootFolderId)
  const startId = normalizeId(folderId)
  if (rootId && !startId) throw new StorageError('file_not_found', 404)
  if (!startId) return []

  const reversed = []
  const seen = new Set()
  let id = startId
  let reachedRoot = !rootId
  while (id) {
    if (seen.has(id) || seen.size >= 64) throw new StorageError('invalid_folder_hierarchy', 404)
    seen.add(id)
    if (rootId && id === rootId) {
      reversed.push({ id: rootId, parentId: '', name: '', isFolder: true, kind: 'drive#folder' })
      reachedRoot = true
      break
    }
    const raw = await provider.getItem(id)
    const item = {
      ...raw,
      id: String(raw?.id ?? raw?.fid ?? id),
      parentId: String(raw?.parentId ?? raw?.parent_id ?? ''),
      isFolder: Boolean(raw?.isFolder || raw?.kind === 'drive#folder' || Number(raw?.file_type) === 0),
    }
    if (!item.isFolder) throw new StorageError('file_not_found', 404)
    reversed.push(item)
    const parentId = item.parentId
    if (parentId === id) throw new StorageError('invalid_folder_hierarchy', 404)
    id = parentId
  }
  if (!reachedRoot) throw new StorageError('file_not_found', 404)
  return reversed.reverse()
}

export async function requireFolderWithinRoot(provider, rootFolderId, folderId) {
  if (!rootFolderId) return null
  const path = await folderPathWithinRoot(provider, folderId, rootFolderId)
  return path.at(-1) || null
}
