import { hasValidAdminSession } from '../admin-auth.js'
import { getFileMetadata, PersistentStoreError, sendPersistentStoreError } from '../admin-store.js'
import { hasValidSession } from '../cloud-auth.js'
import { deriveChildFolderAccess, getEffectiveFolderAccess } from '../pikpak-permissions.js'

const DRIVE_API = 'https://api-drive.mypikpak.com/drive/v1/files'

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

  const id = typeof req.query?.id === 'string' ? req.query.id.trim() : ''
  const parentId = typeof req.query?.parentId === 'string' ? req.query.parentId.trim() : ''
  if (!id) {
    return res.status(400).json({ ok: false, error: 'missing_file_id' })
  }

  try {
    const parentAccess = await getEffectiveFolderAccess(token, parentId)
    if (parentAccess.pikpakError) {
      return res.status(502).json({ ok: false, error: 'pikpak_request_failed', message: '无法确认文件夹权限。' })
    }
    if (parentAccess.invalidFolder) {
      return res.status(404).json({ ok: false, error: 'folder_not_found' })
    }

    const upstream = await fetch(`${DRIVE_API}/${encodeURIComponent(id)}`, {
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
      if (upstream.status === 404) return res.status(404).json({ ok: false, error: 'file_not_found' })
      return res.status(502).json({
        ok: false,
        error: 'pikpak_request_failed',
        upstreamStatus: upstream.status,
        errorCode: payload?.error_code ?? payload?.code ?? null,
        message: payload?.error ?? payload?.message ?? null,
      })
    }

    if (payload?.kind === 'drive#folder') {
      return res.status(400).json({ ok: false, error: 'cannot_download_folder' })
    }
    if (String(payload?.parent_id || '') !== parentId) {
      return res.status(404).json({ ok: false, error: 'file_not_found' })
    }

    const metadata = await getFileMetadata(id)
    const itemAccess = deriveChildFolderAccess(parentAccess.requiresAuth, metadata.access)
    const authorized =
      !itemAccess.requiresAuth ||
      await hasValidAdminSession(req) ||
      hasValidSession(req, token)

    if (!authorized) {
      if (!process.env.CLOUD_PASSWORD) {
        return res.status(503).json({ ok: false, error: 'cloud_login_not_configured' })
      }
      return res.status(401).json({ ok: false, error: 'authentication_required' })
    }

    const url =
      payload?.links?.['application/octet-stream']?.url ||
      payload?.web_content_link ||
      null

    if (!url) {
      return res.status(502).json({ ok: false, error: 'download_link_unavailable' })
    }

    res.setHeader('Location', url)
    return res.status(302).end()
  } catch (error) {
    if (error instanceof PersistentStoreError) return sendPersistentStoreError(res, error)
    return res.status(502).json({
      ok: false,
      error: 'pikpak_unreachable',
      message: error instanceof Error ? error.message : '无法连接 PikPak。',
    })
  }
}
