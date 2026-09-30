import { requireAdmin } from '../admin-auth.js'
import { readConfig, writeConfig, writeAuth, withLock, validateStorageId, PRIMARY_ID } from '../storage/store.js'
import { storageDescriptors, resolveStorage } from '../storage/registry.js'
import { methodAllowed, sendStorageError } from '../storage/http.js'
import { StorageError } from '../storage/errors.js'
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (!['GET', 'POST'].includes(req.method)) return methodAllowed(req, res, 'GET')
  if (!await requireAdmin(req, res)) return
  try {
    if (req.method === 'GET') return res.status(200).json({ ok: true, ...await storageDescriptors({ probe: true }) })
    await withLock('configuration', async () => {
      const config = await readConfig(), body = req.body || {}
      if (body.action === 'set-default') {
        const target = await resolveStorage(body.storageId)
        if (!target.auth) throw new StorageError('storage_authorization_required', 409)
        await target.provider.getAccountInfo() // Probe credentials before changing the default.
        config.defaultStorageId = target.instance.storageId
      } else if (body.action === 'add') {
        if (!validateStorageId(body.storageId) || config.instances.some(i => i.storageId === body.storageId) || !['pikpak', 'quark'].includes(body.provider) || typeof body.displayName !== 'string' || !body.displayName.trim() || body.displayName.length > 80 || config.instances.length >= 50) throw new StorageError('invalid_storage_instance', 400)
        if (body.provider === 'pikpak') {
          if (typeof body.accessToken !== 'string' || !body.accessToken || body.accessToken.length > 8192) throw new StorageError('invalid_storage_credentials', 400)
          await writeAuth(body.storageId, { accessToken: body.accessToken })
        }
        config.instances.push({ storageId: body.storageId, provider: body.provider, displayName: body.displayName.trim(), enabled: true })
      } else if (body.action === 'update') {
        const target = config.instances.find(i => i.storageId === body.storageId)
        if (!target) throw new StorageError('storage_not_found', 404)
        if (body.enabled !== undefined) { if (typeof body.enabled !== 'boolean' || (!body.enabled && (target.storageId === PRIMARY_ID || target.storageId === config.defaultStorageId))) throw new StorageError('invalid_storage_enabled', 400); target.enabled = body.enabled }
        if (body.displayName !== undefined) { if (typeof body.displayName !== 'string' || !body.displayName.trim() || body.displayName.length > 80) throw new StorageError('invalid_storage_name', 400); target.displayName = body.displayName.trim() }
      } else throw new StorageError('invalid_storage_action', 400)
      await writeConfig(config)
    })
    return res.status(200).json({ ok: true, ...await storageDescriptors() })
  } catch (error) { return sendStorageError(res, error) }
}
