import {
  authorizePikPakWrite,
  isValidPikPakName,
  normalizePikPakName,
  pikpakItemFromPayload,
  requireWritableParent,
  requestPikPak,
  safePikPakMessage,
  sendPikPakError,
} from '../lib/pikpak-write.js'

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }

  const token = authorizePikPakWrite(req, res)
  if (!token) return

  const name = normalizePikPakName(req.body?.name)
  const parentId = typeof req.body?.parentId === 'string' ? req.body.parentId.trim() : ''
  if (!isValidPikPakName(name)) {
    return res.status(400).json({ ok: false, error: 'invalid_folder_name', message: '文件夹名称不能为空且不能超过 255 个字符。' })
  }
  if (req.body?.parentId !== undefined && typeof req.body.parentId !== 'string') {
    return res.status(400).json({ ok: false, error: 'invalid_parent_id' })
  }

  try {
    if (!await requireWritableParent(token, parentId, res)) return

    const result = await requestPikPak(token, '', {
      method: 'POST',
      body: { kind: 'drive#folder', parent_id: parentId, name },
    })
    if (!result.ok) return sendPikPakError(res, result, token)

    const item = pikpakItemFromPayload(result.payload)
    return res.status(200).json({
      ok: true,
      item: {
        id: String(item.id || ''),
        parentId: String(item.parent_id || parentId),
        name: String(item.name || name),
        kind: String(item.kind || 'drive#folder'),
      },
    })
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: 'pikpak_unreachable',
      message: safePikPakMessage(error instanceof Error ? error.message : '无法连接 PikPak。', token),
    })
  }
}
