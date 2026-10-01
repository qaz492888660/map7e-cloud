import { createPikPakProvider } from '../storage/providers/pikpak.js'
import { safeDirectUrl } from '../storage/errors.js'
import { metadataId, PRIMARY_ID } from '../storage/store.js'
import { safePikPakMessage } from '../pikpak-write.js'
import crypto from 'node:crypto'

const DRIVE_API = 'https://api-drive.mypikpak.com/drive/v1/files'
const COOKIE_NAME = 'map7e_cloud_session'

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=')
        return index >= 0 ? [part.slice(0, index), part.slice(index + 1)] : [part, '']
      })
  )
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function hasValidSession(req, secret) {
  if (!secret) return false

  const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME]
  if (!token) return false

  const dot = token.lastIndexOf('.')
  if (dot <= 0) return false

  const payload = token.slice(0, dot)
  const signature = token.slice(dot + 1)
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url')

  if (!safeEqual(signature, expected)) return false

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return Number(data?.exp || 0) > Math.floor(Date.now() / 1000)
  } catch {
    return false
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }

  const token = req.storageContext?.auth?.accessToken || process.env.PIKPAK_PAT
  const storageId = req.storageContext?.instance.storageId || PRIMARY_ID
  if (!token) {
    return res.status(500).json({ ok: false, error: 'missing_pikpak_pat' })
  }

  if (!process.env.CLOUD_PASSWORD) {
    return res.status(503).json({ ok: false, error: 'cloud_login_not_configured' })
  }

  if (!hasValidSession(req, process.env.PIKPAK_PAT)) {
    return res.status(401).json({ ok: false, error: 'authentication_required' })
  }

  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
  const parentId = typeof req.body?.parentId === 'string' ? req.body.parentId.trim() : ''
  const size = Number(req.body?.size)
  const hash = typeof req.body?.hash === 'string' ? req.body.hash.trim().toUpperCase() : ''

  if (!name || name.length > 255) {
    return res.status(400).json({ ok: false, error: 'invalid_file_name' })
  }

  if (!Number.isSafeInteger(size) || size < 0) {
    return res.status(400).json({ ok: false, error: 'invalid_file_size' })
  }

  if (!/^[A-F0-9]{40}$/.test(hash)) {
    return res.status(400).json({ ok: false, error: 'invalid_gcid' })
  }

  try {
    const upstream = await createPikPakProvider({}, { accessToken: token }).request('', { method: 'POST', body: {
      kind: 'drive#file', name, parent_id: parentId, folder_type: 'NORMAL', size, hash, upload_type: 'UPLOAD_TYPE_FORM',
    } })

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
        message: safePikPakMessage(typeof payload?.error === 'string' ? payload.error : payload?.message || '', token),
      })
    }

    if (payload?.file?.phase === 'PHASE_TYPE_COMPLETE') {
      return res.status(200).json({
        ok: true,
        instant: true,
        file: {
          id: payload.file.id ?? '',
          name: payload.file.name ?? name,
          size: Number(payload.file.size ?? size),
          parentId: payload.file.parent_id ?? parentId,
        },
      })
    }

    const form = payload?.form
    if (!form?.url || !form?.multi_parts) {
      return res.status(502).json({
        ok: false,
        error: 'upload_form_unavailable',
        uploadType: payload?.upload_type ?? null,
      })
    }

    return res.status(200).json({
      ok: true,
      instant: false,
      file: {
        id: payload?.file?.id ?? '',
        name: payload?.file?.name ?? name,
        size: Number(payload?.file?.size ?? size),
        parentId: payload?.file?.parent_id ?? parentId,
      },
      upload: {
        method: form.method || 'POST',
        url: form.url,
        fields: form.multi_parts,
      },
    })
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: 'pikpak_unreachable',
      message: safePikPakMessage(error instanceof Error ? error.message : 'unknown_error', token),
    })
  }
}
