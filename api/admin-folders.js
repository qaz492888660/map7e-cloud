import { requireAdmin } from '../lib/admin-auth.js'
import {
  getFolderMetadataMany,
  getGlobalAccessState,
  PersistentStoreError,
  sendPersistentStoreError,
} from '../lib/admin-store.js'
import { deriveChildFolderAccess } from '../lib/pikpak-permissions.js'
import { sendPikPakError } from '../lib/pikpak-write.js'

const DRIVE_FILES_API = 'https://api-drive.mypikpak.com/drive/v1/files'
const MAX_FOLDERS = 5000
const MAX_DEPTH = 64
const PAGE_SIZE = 100
const FILTERS = JSON.stringify({ phase: { eq: 'PHASE_TYPE_COMPLETE' }, trashed: { eq: false } })

async function listDirectory(token, parentId) {
  const items = []
  const seenTokens = new Set()
  let pageToken = ''

  do {
    const params = new URLSearchParams({
      thumbnail_size: 'SIZE_MEDIUM',
      limit: String(PAGE_SIZE),
      with_audit: 'true',
      filters: FILTERS,
    })
    if (parentId) params.set('parent_id', parentId)
    if (pageToken) params.set('page_token', pageToken)

    const response = await fetch(`${DRIVE_FILES_API}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      cache: 'no-store',
    })
    const raw = await response.text()
    let payload = {}
    try {
      payload = raw ? JSON.parse(raw) : {}
    } catch {
      payload = {}
    }
    if (!response.ok) {
      return {
        error: {
          response,
          payload,
        },
      }
    }
    items.push(...(Array.isArray(payload?.files) ? payload.files : []))
    pageToken = String(payload?.next_page_token || '')
    if (pageToken && seenTokens.has(pageToken)) break
    if (pageToken) seenTokens.add(pageToken)
  } while (pageToken && seenTokens.size < 200)

  return { items }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }
  if (!requireAdmin(req, res)) return

  const token = process.env.PIKPAK_PAT
  if (!token) return res.status(503).json({ ok: false, error: 'missing_pikpak_pat' })

  try {
    const state = await getGlobalAccessState()
    const folders = []
    const seenFolderIds = new Set()
    let queue = [{ parentId: '', depth: 0 }]

    while (queue.length) {
      const batch = queue.splice(0, 4)
      const directories = await Promise.all(batch.map(({ parentId }) => listDirectory(token, parentId)))
      for (let index = 0; index < directories.length; index += 1) {
        const directory = directories[index]
        if (directory.error) {
          return sendPikPakError(res, directory.error, token)
        }
        const { parentId, depth } = batch[index]
        for (const item of directory.items) {
          if (item?.kind !== 'drive#folder' || !item?.id) continue
          const id = String(item.id)
          if (seenFolderIds.has(id)) continue
          if (depth >= MAX_DEPTH) {
            return res.status(413).json({ ok: false, error: 'folder_tree_too_deep' })
          }
          seenFolderIds.add(id)
          folders.push({
            id,
            parentId: String(item.parent_id || parentId || ''),
            name: String(item.name || '未命名文件夹'),
            writable: item.writable !== false,
            depth,
          })
          if (folders.length > MAX_FOLDERS) {
            return res.status(413).json({ ok: false, error: 'folder_tree_too_large' })
          }
          queue.push({ parentId: id, depth: depth + 1 })
        }
      }
    }

    const metadata = await getFolderMetadataMany(folders.map((folder) => folder.id))
    const effectiveById = new Map()
    const items = folders.map((folder) => {
      const meta = metadata.get(folder.id) || { folderId: folder.id, type: 'folder', access: 'inherit' }
      const parentLocked = folder.parentId
        ? (effectiveById.get(folder.parentId) ?? (state.globalAccess === 'locked'))
        : state.globalAccess === 'locked'
      const effective = deriveChildFolderAccess(parentLocked, meta.access)
      effectiveById.set(folder.id, effective.requiresAuth)
      return {
        ...folder,
        folderId: folder.id,
        type: meta.type,
        access: meta.access,
        effectiveAccess: effective.effectiveAccess,
      }
    })

    return res.status(200).json({
      ok: true,
      globalAccess: state.globalAccess,
      storageReady: state.storageReady,
      folders: items,
    })
  } catch (error) {
    if (error instanceof PersistentStoreError) return sendPersistentStoreError(res, error)
    return res.status(502).json({ ok: false, error: 'pikpak_unreachable', message: '无法读取 PikPak 文件夹。' })
  }
}
