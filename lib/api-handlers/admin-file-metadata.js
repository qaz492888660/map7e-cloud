import { resolveStorage } from '../storage/registry.js'
import { metadataId, PRIMARY_ID } from '../storage/store.js'
import { sendStorageError } from '../storage/http.js'
import { StorageError } from '../storage/errors.js'
import { requireAdmin } from '../admin-auth.js'
import { PersistentStoreError, sendPersistentStoreError, setFileMetadata } from '../admin-store.js'
import { pikpakItemFromPayload, readPikPakItem, sendPikPakError } from '../pikpak-write.js'

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }
  if (!await requireAdmin(req, res)) return

  const token = process.env.PIKPAK_PAT
  if (!token) return res.status(503).json({ ok: false, error: 'missing_pikpak_pat' })

  const fileId = typeof req.body?.fileId === 'string' ? req.body.fileId.trim() : ''
  const access = req.body?.access
  if (!fileId || fileId.length > 512) {
    return res.status(400).json({ ok: false, error: 'invalid_file_id' })
  }
  if (!['inherit', 'public', 'locked'].includes(access)) {
    return res.status(400).json({ ok: false, error: 'invalid_file_metadata' })
  }

  try {
    if (req.body?.storageId && req.body.storageId !== PRIMARY_ID) {
      const { instance, provider, auth } = await resolveStorage(req.body.storageId)
      if (!auth) throw new StorageError('storage_authorization_required', 409)
      const item = await provider.getItem(fileId)
      const isFolder = item.isFolder ?? (item.kind === 'drive#folder')
      if (isFolder !== false) throw new StorageError('invalid_item_kind', 400)
      const metadata = await setFileMetadata(metadataId(instance.storageId, fileId), { access })
      return res.status(200).json({ ok: true, metadata })
    }
    const result = await readPikPakItem(token, fileId)
    if (!result.ok) return sendPikPakError(res, result, token)
    const item = pikpakItemFromPayload(result.payload)
    if (item.kind === 'drive#folder') {
      return res.status(400).json({ ok: false, error: 'pikpak_item_is_folder' })
    }
    const metadata = await setFileMetadata(fileId, { access })
    return res.status(200).json({ ok: true, metadata })
  } catch (error) {
    if (error instanceof StorageError) return sendStorageError(res, error)
    if (error instanceof PersistentStoreError) return sendPersistentStoreError(res, error)
    return res.status(502).json({ ok: false, error: 'pikpak_unreachable', message: '无法确认 PikPak 文件。' })
  }
}
