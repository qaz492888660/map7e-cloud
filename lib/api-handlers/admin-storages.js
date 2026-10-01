import { requireAdmin } from '../admin-auth.js'
import { readConfig, writeConfig, writeAuth, withLock, validateStorageId, PRIMARY_ID } from '../storage/store.js'
import { storageDescriptors, resolveStorage } from '../storage/registry.js'
import { methodAllowed, sendStorageError } from '../storage/http.js'
import { StorageError } from '../storage/errors.js'
import { createPikPakProvider } from '../storage/providers/pikpak.js'
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (!['GET', 'POST'].includes(req.method)) return methodAllowed(req, res, 'GET')
  if (!await requireAdmin(req, res)) return
  try {
    if (req.method === 'GET') {
      const [descriptors, config] = await Promise.all([
        storageDescriptors({ probe: true, fresh: true }),
        readConfig({ fresh: true }),
      ])
      const instances = new Map(config.instances.map(instance => [instance.storageId, instance]))
      return res.status(200).json({
        ok: true,
        ...descriptors,
        providers: descriptors.providers.map(provider => {
          const instance = instances.get(provider.id)
          return { ...provider, rootFolderId: instance?.rootFolderId || null, rootFolderName: instance?.rootFolderName || null }
        }),
      })
    }
    await withLock('configuration', async () => {
      const config = await readConfig({ fresh: true }), body = req.body || {}
      if (body.action === 'set-default') {
        const target = await resolveStorage(body.storageId, { config, freshAuth: true })
        if (!target.auth) throw new StorageError('storage_authorization_required', 409)
        await target.provider.getAccountInfo() // Probe credentials before changing the default.
        config.defaultStorageId = target.instance.storageId
      } else if (body.action === 'set-root-folder') {
        const target = config.instances.find(instance => instance.storageId === body.storageId)
        if (!target) throw new StorageError('storage_not_found', 404)
        const requestedRootId = body.rootFolderId == null || body.rootFolderId === '' ? '' : body.rootFolderId
        if (typeof requestedRootId !== 'string' || requestedRootId.length > 512 || /[\u0000-\u001f\u007f]/.test(requestedRootId)) throw new StorageError('invalid_root_folder', 400)
        if (requestedRootId) {
          const resolved = await resolveStorage(target.storageId, { config, freshAuth: true })
          if (!resolved.auth) throw new StorageError('storage_authorization_required', 409)
          const item = await resolved.provider.getItem(requestedRootId)
          const isFolder = Boolean(item?.isFolder || item?.kind === 'drive#folder' || Number(item?.file_type) === 0)
          const actualId = String(item?.id ?? item?.fid ?? '')
          if (!isFolder || (actualId && actualId !== requestedRootId)) throw new StorageError('invalid_root_folder', 400)
          target.rootFolderId = requestedRootId
          target.rootFolderName = String(item?.name ?? item?.file_name ?? item?.filename ?? '').slice(0, 255) || null
        } else {
          target.rootFolderId = null
          target.rootFolderName = null
        }
      } else if (body.action === 'add') {
        if (!validateStorageId(body.storageId) || config.instances.some(i => i.storageId === body.storageId) || !['pikpak', 'quark'].includes(body.provider) || typeof body.displayName !== 'string' || !body.displayName.trim() || body.displayName.length > 80 || config.instances.length >= 50) throw new StorageError('invalid_storage_instance', 400)
        if (body.provider === 'pikpak') {
          if (typeof body.accessToken !== 'string' || !body.accessToken || body.accessToken.length > 8192) throw new StorageError('invalid_storage_credentials', 400)
          const candidate = { storageId: body.storageId, provider: body.provider, displayName: body.displayName.trim(), enabled: true }
          await createPikPakProvider(candidate, { accessToken: body.accessToken }).getAccountInfo()
          await writeAuth(body.storageId, { accessToken: body.accessToken })
        }
        config.instances.push({ storageId: body.storageId, provider: body.provider, displayName: body.displayName.trim(), enabled: true })
      } else if (body.action === 'update') {
        const target = config.instances.find(i => i.storageId === body.storageId)
        if (!target) throw new StorageError('storage_not_found', 404)
        if (body.enabled !== undefined) { if (typeof body.enabled !== 'boolean' || (!body.enabled && (target.storageId === PRIMARY_ID || target.storageId === config.defaultStorageId))) throw new StorageError('invalid_storage_enabled', 400); target.enabled = body.enabled }
        if (body.displayName !== undefined) { if (typeof body.displayName !== 'string' || !body.displayName.trim() || body.displayName.length > 80) throw new StorageError('invalid_storage_name', 400); target.displayName = body.displayName.trim() }
        if (body.accessToken !== undefined) {
          if (target.provider !== 'pikpak' || target.storageId === PRIMARY_ID || typeof body.accessToken !== 'string' || !body.accessToken || body.accessToken.length > 8192) throw new StorageError('invalid_storage_credentials', 400)
          await createPikPakProvider(target, { accessToken: body.accessToken }).getAccountInfo()
          await writeAuth(target.storageId, { accessToken: body.accessToken })
        }
      } else throw new StorageError('invalid_storage_action', 400)
      await writeConfig(config)
    })
    const [descriptors, config] = await Promise.all([storageDescriptors({ fresh: true }), readConfig({ fresh: true })])
    const instances = new Map(config.instances.map(instance => [instance.storageId, instance]))
    return res.status(200).json({
      ok: true,
      ...descriptors,
      providers: descriptors.providers.map(provider => {
        const instance = instances.get(provider.id)
        return { ...provider, rootFolderId: instance?.rootFolderId || null, rootFolderName: instance?.rootFolderName || null }
      }),
    })
  } catch (error) { return sendStorageError(res, error) }
}
