import { getFolderMetadataMany, PersistentStoreError, sendPersistentStoreError } from '../lib/admin-store.js'
import { deriveChildFolderAccess, requireFolderReadAccess } from '../lib/pikpak-permissions.js'

const DRIVE_API = 'https://api-drive.mypikpak.com/drive/v1/files'
const MAX_RESTRICTED_ROOT_PAGES = 50

function normalize(item) {
  return {
    id: item?.id ?? '',
    parentId: item?.parent_id ?? '',
    name: item?.name ?? '',
    kind: item?.kind ?? '',
    isFolder: item?.kind === 'drive#folder',
    size: Number(item?.size ?? 0),
    mimeType: item?.mime_type ?? '',
    extension: item?.file_extension ?? '',
    category: item?.file_category ?? '',
    createdAt: item?.created_time ?? null,
    modifiedAt: item?.modified_time ?? null,
    thumbnail: item?.thumbnail_link ?? item?.icon_link ?? null,
    writable: item?.writable !== false,
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }

  const token = process.env.PIKPAK_PAT
  if (!token) {
    return res.status(500).json({ ok: false, error: 'missing_pikpak_pat' })
  }

  const parentId = typeof req.query?.parentId === 'string' ? req.query.parentId : ''
  const pageToken = typeof req.query?.pageToken === 'string' ? req.query.pageToken : ''

  try {
    const access = await requireFolderReadAccess(req, res, token, parentId, { allowPublicChildren: !parentId })
    if (!access) return

    const params = new URLSearchParams({
      thumbnail_size: 'SIZE_MEDIUM',
      limit: '100',
      with_audit: 'true',
      filters: JSON.stringify({
        phase: { eq: 'PHASE_TYPE_COMPLETE' },
        trashed: { eq: false },
      }),
    })

    if (parentId) params.set('parent_id', parentId)
    if (pageToken && access.authorized) params.set('page_token', pageToken)

    const upstream = await fetch(`${DRIVE_API}?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    })

    const raw = await upstream.text()
    let payload = {}
    try {
      payload = raw ? JSON.parse(raw) : {}
    } catch {
      payload = {}
    }

    if (!upstream.ok) {
      return res.status(502).json({
        ok: false,
        error: 'pikpak_request_failed',
        upstreamStatus: upstream.status,
        errorCode: payload?.error_code ?? payload?.code ?? null,
        message: payload?.error ?? payload?.message ?? null,
      })
    }

    const rawItems = Array.isArray(payload?.files) ? [...payload.files] : []
    if (!access.authorized) {
      const seenPageTokens = new Set()
      let nextPageToken = String(payload?.next_page_token || '')
      let pageCount = 1
      while (nextPageToken && pageCount < MAX_RESTRICTED_ROOT_PAGES && !seenPageTokens.has(nextPageToken)) {
        seenPageTokens.add(nextPageToken)
        const nextParams = new URLSearchParams(params)
        nextParams.set('page_token', nextPageToken)
        const pageResponse = await fetch(`${DRIVE_API}?${nextParams.toString()}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        })
        const pageRaw = await pageResponse.text()
        let pagePayload = {}
        try {
          pagePayload = pageRaw ? JSON.parse(pageRaw) : {}
        } catch {
          pagePayload = {}
        }
        if (!pageResponse.ok) {
          return res.status(502).json({ ok: false, error: 'pikpak_request_failed', upstreamStatus: pageResponse.status })
        }
        rawItems.push(...(Array.isArray(pagePayload?.files) ? pagePayload.files : []))
        nextPageToken = String(pagePayload?.next_page_token || '')
        payload = pagePayload
        pageCount += 1
      }
      if (nextPageToken && pageCount >= MAX_RESTRICTED_ROOT_PAGES) {
        return res.status(413).json({ ok: false, error: 'public_folder_preview_too_large' })
      }
    }

    const items = rawItems.map(normalize)
    const folderItems = items.filter((item) => item.isFolder)
    const metadata = await getFolderMetadataMany(folderItems.map((item) => item.id))
    const effectiveItems = items.map((item) => {
      if (!item.isFolder) return item
      const folder = metadata.get(item.id) || { type: 'folder', access: 'inherit' }
      const childAccess = deriveChildFolderAccess(access.requiresAuth, folder.access)
      return {
        ...item,
        folderType: folder.type,
        access: folder.access,
        effectiveAccess: childAccess.effectiveAccess,
      }
    })

    if (!access.authorized) {
      const publicFolders = effectiveItems.filter((item) => item.isFolder && item.access === 'public')
      if (!publicFolders.length) {
        if (!process.env.CLOUD_PASSWORD) {
          return res.status(503).json({ ok: false, error: 'cloud_login_not_configured' })
        }
        return res.status(401).json({ ok: false, error: 'authentication_required' })
      }
      return res.status(200).json({
        ok: true,
        parentId: null,
        access: 'locked',
        restrictedPreview: true,
        items: publicFolders,
        nextPageToken: null,
        syncTime: payload?.sync_time || null,
      })
    }

    return res.status(200).json({
      ok: true,
      parentId: parentId || null,
      access: access.effectiveAccess,
      folder: access.folder || null,
      items: effectiveItems,
      nextPageToken: payload?.next_page_token || null,
      syncTime: payload?.sync_time || null,
    })
  } catch (error) {
    if (error instanceof PersistentStoreError) return sendPersistentStoreError(res, error)
    return res.status(502).json({
      ok: false,
      error: 'pikpak_unreachable',
      message: error instanceof Error ? error.message : '无法连接 PikPak。',
    })
  }
}
