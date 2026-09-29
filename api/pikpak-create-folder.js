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
import { requireAdmin } from '../lib/admin-auth.js'
import {
  getGlobalAccessState,
  sendPersistentStoreError,
  setFolderMetadata,
} from '../lib/admin-store.js'

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
  const type = req.body?.type === undefined ? 'folder' : req.body.type
  const access = req.body?.access === undefined ? 'inherit' : req.body.access
  if (!isValidPikPakName(name)) {
    return res.status(400).json({ ok: false, error: 'invalid_folder_name', message: '文件夹名称不能为空且不能超过 255 个字符。' })
  }
  if (req.body?.parentId !== undefined && typeof req.body.parentId !== 'string') {
    return res.status(400).json({ ok: false, error: 'invalid_parent_id' })
  }
  if (!['folder', 'album'].includes(type) || !['inherit', 'public', 'locked'].includes(access)) {
    return res.status(400).json({ ok: false, error: 'invalid_folder_metadata' })
  }

  const saveMetadata = type !== 'folder' || access !== 'inherit'
  if (saveMetadata) {
    if (!await requireAdmin(req, res)) return
    try {
      const state = await getGlobalAccessState()
      if (!state.storageReady) {
        return res.status(503).json({
          ok: false,
          error: 'persistent_storage_not_configured',
          message: '先配置 Upstash 持久化存储，才能为新文件夹保存类型或权限。',
        })
      }
    } catch (error) {
      return sendPersistentStoreError(res, error)
    }
  }

  try {
    if (!await requireWritableParent(token, parentId, res)) return

    const result = await requestPikPak(token, '', {
      method: 'POST',
      body: { kind: 'drive#folder', parent_id: parentId, name },
    })
    if (!result.ok) return sendPikPakError(res, result, token)

    const item = pikpakItemFromPayload(result.payload)
    let metadataSaved = true
    if (saveMetadata && item.id) {
      try {
        await setFolderMetadata(String(item.id), { type, access })
      } catch {
        metadataSaved = false
      }
    }
    return res.status(200).json({
      ok: true,
      metadataSaved,
      ...(metadataSaved ? {} : { warning: '文件夹已创建，但类型/权限暂未保存；可在管理后台重试。' }),
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
