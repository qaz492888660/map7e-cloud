const DRIVE_API = 'https://api-drive.mypikpak.com/drive/v1/files'

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
  if (pageToken) params.set('page_token', pageToken)

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

    const items = Array.isArray(payload?.files) ? payload.files.map(normalize) : []

    return res.status(200).json({
      ok: true,
      parentId: parentId || null,
      items,
      nextPageToken: payload?.next_page_token || null,
      syncTime: payload?.sync_time || null,
    })
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: 'pikpak_unreachable',
      message: error instanceof Error ? error.message : 'unknown_error',
    })
  }
}
