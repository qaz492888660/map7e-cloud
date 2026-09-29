import { requireAdmin } from '../lib/admin-auth.js'
import { PersistentStoreError, sendPersistentStoreError, setFolderMetadata } from '../lib/admin-store.js'
import { pikpakItemFromPayload, readPikPakItem, sendPikPakError } from '../lib/pikpak-write.js'

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }
  if (!requireAdmin(req, res)) return

  const token = process.env.PIKPAK_PAT
  if (!token) return res.status(503).json({ ok: false, error: 'missing_pikpak_pat' })

  const folderId = typeof req.body?.folderId === 'string' ? req.body.folderId.trim() : ''
  const type = req.body?.type
  const access = req.body?.access
  if (!folderId || folderId.length > 512) {
    return res.status(400).json({ ok: false, error: 'invalid_folder_id' })
  }
  if (!['folder', 'album'].includes(type) || !['inherit', 'public', 'locked'].includes(access)) {
    return res.status(400).json({ ok: false, error: 'invalid_folder_metadata' })
  }

  try {
    const result = await readPikPakItem(token, folderId)
    if (!result.ok) return sendPikPakError(res, result, token)
    const item = pikpakItemFromPayload(result.payload)
    if (item.kind !== 'drive#folder') {
      return res.status(400).json({ ok: false, error: 'pikpak_item_is_not_folder' })
    }
    const metadata = await setFolderMetadata(folderId, { type, access })
    return res.status(200).json({ ok: true, metadata })
  } catch (error) {
    if (error instanceof PersistentStoreError) return sendPersistentStoreError(res, error)
    return res.status(502).json({ ok: false, error: 'pikpak_unreachable', message: '无法确认 PikPak 文件夹。' })
  }
}
