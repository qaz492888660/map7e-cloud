import {
  authorizePikPakWrite,
  denyNotWritable,
  pikpakItemFromPayload,
  requireWritableParent,
  readPikPakItem,
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

  const id = typeof req.body?.id === 'string' ? req.body.id.trim() : ''
  const parentId = typeof req.body?.parentId === 'string' ? req.body.parentId.trim() : ''
  if (!id) return res.status(400).json({ ok: false, error: 'missing_file_id' })
  if (typeof req.body?.parentId !== 'string') {
    return res.status(400).json({ ok: false, error: 'invalid_parent_id' })
  }

  try {
    const current = await readPikPakItem(token, id)
    if (!current.ok) return sendPikPakError(res, current, token)
    const currentItem = pikpakItemFromPayload(current.payload)
    if (currentItem.writable === false) return denyNotWritable(res)
    const actualParentId = String(currentItem.parent_id || '')
    if (actualParentId !== parentId) {
      return res.status(409).json({ ok: false, error: 'parent_directory_changed', message: '文件已不在当前目录或无法确认目录，请刷新后重试。' })
    }
    if (!await requireWritableParent(token, parentId, res)) return

    const result = await requestPikPak(token, ':batchTrash', {
      method: 'POST',
      body: { ids: [id] },
    })
    if (!result.ok) return sendPikPakError(res, result, token)

    return res.status(200).json({
      ok: true,
      action: 'moved_to_trash',
      item: {
        id,
        parentId: String(currentItem.parent_id || ''),
        name: String(currentItem.name || ''),
        kind: String(currentItem.kind || ''),
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
