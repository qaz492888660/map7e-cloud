import { hasValidAdminSession } from './admin-auth.js'
import { hasValidSession } from './cloud-auth.js'

export const DRIVE_FILES_API = 'https://api-drive.mypikpak.com/drive/v1/files'
export const MAX_PIKPAK_NAME_LENGTH = 255

export async function authorizePikPakWrite(req, res) {
  const token = process.env.PIKPAK_PAT
  if (!token) {
    res.status(500).json({ ok: false, error: 'missing_pikpak_pat' })
    return null
  }

  if (await hasValidAdminSession(req)) return token

  if (!process.env.CLOUD_PASSWORD) {
    res.status(503).json({ ok: false, error: 'cloud_login_not_configured' })
    return null
  }

  if (!hasValidSession(req, token)) {
    res.status(401).json({ ok: false, error: 'authentication_required' })
    return null
  }

  return token
}

export function normalizePikPakName(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function isValidPikPakName(value) {
  const name = normalizePikPakName(value)
  return Boolean(name) && [...name].length <= MAX_PIKPAK_NAME_LENGTH && !/[\u0000-\u001f\u007f]/.test(name)
}

export async function requestPikPak(token, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${DRIVE_FILES_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  const raw = await response.text()
  let payload = {}
  let invalidJson = false
  try {
    payload = raw ? JSON.parse(raw) : {}
  } catch {
    invalidJson = Boolean(raw)
    payload = raw ? { message: raw.slice(0, 500) } : {}
  }

  const errorCode = payload?.error_code ?? payload?.code
  const hasErrorCode = errorCode !== undefined && errorCode !== null && errorCode !== '' && errorCode !== 0 && errorCode !== '0'
  const hasError = Boolean(payload?.error) || (Array.isArray(payload?.errors) && payload.errors.length > 0)
  const ok = response.ok && !invalidJson && !hasErrorCode && !hasError

  return { ok, response, payload, invalidJson }
}

export function safePikPakMessage(value, token) {
  const message = String(value || '')
  return token ? message.split(token).join('[redacted]') : message
}

export function sendPikPakError(res, result, token) {
  const { response, payload } = result
  const nestedError = payload?.error && typeof payload.error === 'object' ? payload.error : null
  const errorCode = payload?.error_code ?? payload?.code ?? nestedError?.code ?? null
  const rawMessage =
    nestedError?.message ||
    (typeof payload?.error === 'string' ? payload.error : '') ||
    payload?.message ||
    (errorCode ? `PikPak 错误码 ${errorCode}` : '') ||
    (response ? `PikPak 返回 HTTP ${response.status}` : '无法连接 PikPak。')
  const message = safePikPakMessage(rawMessage, token)

  return res.status(502).json({
    ok: false,
    error: 'pikpak_request_failed',
    upstreamStatus: response?.status ?? null,
    errorCode,
    message,
  })
}

export async function readPikPakItem(token, id) {
  return requestPikPak(token, `/${encodeURIComponent(id)}`)
}

export function pikpakItemFromPayload(payload) {
  return payload?.file || payload?.item || payload || {}
}

export function denyNotWritable(res) {
  return res.status(403).json({
    ok: false,
    error: 'item_not_writable',
    message: 'PikPak 标记此项目为只读，无法修改。',
  })
}

export async function requireWritableParent(token, parentId, res) {
  if (!parentId) return true

  const result = await readPikPakItem(token, parentId)
  if (!result.ok) {
    sendPikPakError(res, result, token)
    return false
  }

  const folder = pikpakItemFromPayload(result.payload)
  if (folder.kind !== 'drive#folder') {
    res.status(400).json({ ok: false, error: 'parent_is_not_folder', message: '目标位置不是文件夹。' })
    return false
  }
  if (folder.writable === false) {
    denyNotWritable(res)
    return false
  }

  return true
}
