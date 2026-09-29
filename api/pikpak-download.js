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
  if (!id) {
    return res.status(400).json({ ok: false, error: 'missing_file_id' })
  }

  try {
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
    return res.status(502).json({
      ok: false,
      error: 'pikpak_unreachable',
      message: error instanceof Error ? error.message : 'unknown_error',
    })
  }
}
