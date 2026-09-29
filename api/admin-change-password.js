import { changeAdminPassword, clearAdminSessionCookie, requireAdmin } from '../lib/admin-auth.js'
import { isPersistentStoreConfigured, sendPersistentStoreError } from '../lib/admin-store.js'

const MAX_PASSWORD_BYTES = 1024

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }
  if (!await requireAdmin(req, res)) return
  if (!isPersistentStoreConfigured()) {
    return res.status(503).json({
      ok: false,
      error: 'persistent_storage_not_configured',
      message: '修改管理员密码需要已配置的 Upstash 持久化存储。',
    })
  }

  const currentPassword = req.body?.currentPassword
  const newPassword = req.body?.newPassword
  const confirmPassword = req.body?.confirmPassword
  if ([currentPassword, newPassword, confirmPassword].some((value) => typeof value !== 'string')) {
    return res.status(400).json({ ok: false, error: 'invalid_password_input' })
  }
  if (
    Buffer.byteLength(currentPassword, 'utf8') > MAX_PASSWORD_BYTES ||
    Buffer.byteLength(confirmPassword, 'utf8') > MAX_PASSWORD_BYTES
  ) {
    return res.status(400).json({ ok: false, error: 'invalid_password_input' })
  }
  if (
    Array.from(newPassword).length < 12 ||
    Buffer.byteLength(newPassword, 'utf8') > MAX_PASSWORD_BYTES
  ) {
    return res.status(400).json({
      ok: false,
      error: 'new_password_too_short',
      message: '新密码至少需要 12 个字符。',
    })
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ ok: false, error: 'password_confirmation_mismatch', message: '两次输入的新密码不一致。' })
  }

  try {
    const result = await changeAdminPassword({ currentPassword, newPassword })
    if (result.reason === 'not_configured') {
      return res.status(503).json({ ok: false, error: 'admin_auth_not_configured' })
    }
    if (result.reason === 'current_password_invalid') {
      return res.status(401).json({ ok: false, error: 'current_admin_password_invalid', message: '当前管理员密码不正确。' })
    }
    if (result.reason === 'password_changed_concurrently') {
      return res.status(409).json({ ok: false, error: 'admin_password_changed_concurrently', message: '管理员密码已在其他请求中更改，请重新登录后再试。' })
    }

    clearAdminSessionCookie(res)
    return res.status(200).json({ ok: true, message: '管理员密码已更新，请使用新密码重新登录。' })
  } catch (error) {
    return sendPersistentStoreError(res, error)
  }
}
