import { requireFolderReadAccess } from '../pikpak-permissions.js'
import { PersistentStoreError, sendPersistentStoreError } from '../admin-store.js'

const DRIVE_API = 'https://api-drive.mypikpak.com/drive/v1/files'

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }

  const token = process.env.PIKPAK_PAT
  if (!token) {
    return res.status(500).json({ ok: false, error: 'missing_pikpak_pat' })
  }

  try {
    const access = await requireFolderReadAccess(req, res, token)
    if (!access) return
  } catch (error) {
    if (error instanceof PersistentStoreError) return sendPersistentStoreError(res, error)
    return res.status(502).json({ ok: false, error: 'pikpak_unreachable' })
  }

  const params = new URLSearchParams({
    limit: '20',
    parent_id: '',
    with_audit: 'true',
    filters: JSON.stringify({
      phase: { eq: 'PHASE_TYPE_COMPLETE' },
      trashed: { eq: false },
    }),
  })

  try {
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

    const files = Array.isArray(payload?.files) ? payload.files : []

    return res.status(200).json({
      ok: true,
      upstreamStatus: upstream.status,
      fileCount: files.length,
      hasNextPage: Boolean(payload?.next_page_token),
    })
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: 'pikpak_unreachable',
      message: error instanceof Error ? error.message : 'unknown_error',
    })
  }
}
