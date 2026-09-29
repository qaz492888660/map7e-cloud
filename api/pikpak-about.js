import { hasValidSession } from '../lib/cloud-auth.js'

const ABOUT_API = 'https://api-drive.mypikpak.com/drive/v1/about'

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

  if (!process.env.CLOUD_PASSWORD) {
    return res.status(503).json({ ok: false, error: 'cloud_login_not_configured' })
  }

  if (!hasValidSession(req, token)) {
    return res.status(401).json({ ok: false, error: 'authentication_required' })
  }

  try {
    const upstream = await fetch(ABOUT_API, {
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

    const quota = payload?.quota || {}
    const total = Number(quota?.limit ?? 0)
    const used = Number(quota?.usage ?? 0)

    return res.status(200).json({
      ok: true,
      quota: {
        total,
        used,
        free: Math.max(0, total - used),
      },
    })
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: 'pikpak_unreachable',
      message: error instanceof Error ? error.message : 'unknown_error',
    })
  }
}
