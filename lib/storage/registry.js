import { readConfig, readAuth } from './store.js'
import { providerPerfNow, recordProviderPerf } from './provider-perf.js'
import { StorageError } from './errors.js'
import { createPikPakProvider, PIKPAK_CAPABILITIES } from './providers/pikpak.js'
import { createQuarkProvider, QUARK_CAPABILITIES } from './providers/quark.js'
const factories = new Map([['pikpak', createPikPakProvider], ['quark', createQuarkProvider]])
export function registerProvider(name, factory) { if (factories.has(name)) throw new StorageError('provider_already_registered', 409); factories.set(name, factory) }
export async function resolveStorage(id, { config: suppliedConfig, freshAuth = false } = {}) {
  const config = suppliedConfig || await readConfig(), storageId = id || config.defaultStorageId
  const instance = config.instances.find(i => i.storageId === storageId)
  if (!instance) throw new StorageError('storage_not_found', 404)
  if (!instance.enabled) throw new StorageError('storage_disabled', 409)
  const factory = factories.get(instance.provider)
  if (!factory) throw new StorageError('storage_provider_not_implemented', 501)
  const auth = await readAuth(storageId, { fresh: freshAuth })
  return { instance, auth, provider: factory(instance, auth) }
}
export async function storageDescriptors({ probe = false, fresh = false } = {}) {
  const config = await readConfig({ fresh })
  const startedAt = providerPerfNow()
  const providers = await Promise.all(config.instances.map(async instance => {
    const { storageId, provider, displayName, enabled } = instance
    let auth, status = 'not_configured', authStatus = 'not_configured', accountInfo = null, quota = null
    try {
      auth = await readAuth(storageId)
      authStatus = auth ? 'unverified' : provider === 'quark' ? 'authorization_required' : 'not_configured'
      status = auth ? 'connected' : authStatus
      if (auth?.refreshExpiresAt && auth.refreshExpiresAt <= Date.now()) status = authStatus = 'authorization_required'
      if (probe && auth && enabled && status === 'connected') {
        const client = factories.get(provider)(instance, auth)
        ;[accountInfo, quota] = await Promise.all([client.getAccountInfo(), client.getQuota()])
        authStatus = 'valid'
      }
    } catch (error) { status = authStatus = ['storage_token_expired', 'storage_authorization_required'].includes(error.code) ? 'authorization_required' : 'unavailable' }
    const capabilities = provider === 'pikpak' ? PIKPAK_CAPABILITIES : QUARK_CAPABILITIES
    return { id: storageId, storageId, type: provider, provider, name: displayName, displayName, enabled, default: storageId === config.defaultStorageId, primary: storageId === 'pikpak-main', configured: Boolean(auth), selectable: enabled && status === 'connected', status: enabled ? status : 'disabled', authStatus, accountInfo, quota, capabilities }
  }))
  recordProviderPerf('providerDescriptorBuild', providerPerfNow() - startedAt, { providerCount: providers.length, probe })
  return { defaultStorageId: config.defaultStorageId, providers }
}
