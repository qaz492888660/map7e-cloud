import { resolveStorage } from '../storage/registry.js'
import { StorageError } from '../storage/errors.js'
import { methodAllowed, sendStorageError, storageIdFrom } from '../storage/http.js'
import { storageSessionAuthorized } from '../storage/permissions.js'

const CACHE_TTL_MS = 45_000
const cache = new Map()

function safeAccountInfo(value) {
  if (!value || typeof value !== 'object') return null
  const accountInfo = {}
  for (const key of ['provider', 'nickname', 'memberType']) {
    if (typeof value[key] === 'string' && value[key].length <= 160) accountInfo[key] = value[key]
  }
  return Object.keys(accountInfo).length ? accountInfo : null
}

function safeQuota(value) {
  if (!value || typeof value !== 'object') return null
  const total = Number(value.total)
  const used = Number(value.used)
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(used) || total <= 0 || used < 0) return null
  return { total, used, free: Math.max(0, total - used) }
}

export function clearStorageAboutCacheForTests() {
  cache.clear()
}

export default async function handler(req, res) {
  if (!methodAllowed(req, res, 'GET')) return
  try {
    if (!await storageSessionAuthorized(req)) {
      throw new StorageError(process.env.CLOUD_PASSWORD ? 'authentication_required' : 'cloud_login_not_configured', process.env.CLOUD_PASSWORD ? 401 : 503)
    }
    const storageId = storageIdFrom(req)
    if (!storageId) throw new StorageError('missing_storage_id', 400)
    const now = Date.now()
    const cached = cache.get(storageId)
    if (cached && cached.expiresAt > now) return res.status(200).json({ ok: true, ...cached.value, cached: true })

    const { instance, provider, auth } = await resolveStorage(storageId)
    if (!auth) throw new StorageError('storage_authorization_required', 409)
    const [accountInfo, quota] = await Promise.all([
      provider.getAccountInfo ? provider.getAccountInfo() : null,
      provider.getQuota ? provider.getQuota() : null,
    ])
    const value = {
      storageId: instance.storageId,
      status: 'connected',
      capabilities: provider.capabilities || {},
      accountInfo: safeAccountInfo(accountInfo),
      quota: safeQuota(quota),
    }
    cache.set(storageId, { value, expiresAt: now + CACHE_TTL_MS })
    return res.status(200).json({ ok: true, ...value, cached: false })
  } catch (error) {
    return sendStorageError(res, error)
  }
}
