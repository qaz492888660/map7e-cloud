import pikpakDownload from './pikpak-download.js'
import { DEFAULT_STORAGE_ID, getStorageProvider } from '../storage-registry.js'

export default async function handler(req, res) {
  const storageId = typeof req.query?.storageId === 'string' && req.query.storageId.trim()
    ? req.query.storageId.trim()
    : DEFAULT_STORAGE_ID
  const provider = getStorageProvider(storageId)

  if (!provider) {
    return res.status(404).json({ ok: false, error: 'storage_not_found' })
  }
  if (!provider.selectable) {
    return res.status(409).json({
      ok: false,
      error: 'storage_authorization_required',
      storageId,
      message: provider.type === 'quark' ? '夸克网盘尚未完成授权。' : '该存储尚未配置。',
    })
  }

  if (provider.type === 'pikpak') {
    return pikpakDownload(req, res)
  }

  return res.status(501).json({ ok: false, error: 'storage_provider_not_implemented', storageId })
}
