import crypto from 'node:crypto'
import { runPipeline, storeKeyPrefix, isPersistentStoreConfigured } from '../admin-store.js'
import { StorageError } from './errors.js'
export const PRIMARY_ID = 'pikpak-main'
export const QUARK_ID = 'quark-main'
const STORAGE_CACHE_TTL_MS = 10_000
let configCache = null
const authCache = new Map()
const authReadInFlight = new Map()
let configReadInFlight = null
const authCacheEpoch = new Map()
let configCacheEpoch = 0
export function validateStorageId(id) { return typeof id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(id) }
export function metadataId(storageId, itemId) {
  const id = String(itemId || '')
  // Keep all original PikPak keys. New keys cannot collide with arbitrary provider IDs.
  return !id ? '' : storageId === PRIMARY_ID ? id : `storage:v2:${JSON.stringify([storageId, id])}`
}
function key(kind, id = '') { return `${storeKeyPrefix()}storage:${kind}:v1:${id}` }
function encryptionKey() {
  const secret = process.env.STORAGE_ENCRYPTION_KEY || process.env.PIKPAK_PAT
  if (!secret) throw new StorageError('storage_encryption_not_configured', 503)
  return crypto.createHash('sha256').update(`map7e-storage-v1\0${secret}`).digest()
}
export function seal(id, value) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  cipher.setAAD(Buffer.from(id))
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return { version: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: body.toString('base64url') }
}
export function unseal(id, value) {
  try {
    const cipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(value.iv, 'base64url'))
    cipher.setAAD(Buffer.from(id)); cipher.setAuthTag(Buffer.from(value.tag, 'base64url'))
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data, 'base64url')), cipher.final()]).toString('utf8'))
  } catch { throw new StorageError('storage_credentials_unreadable', 503) }
}
function defaults() { return { version: 1, defaultStorageId: PRIMARY_ID, instances: [
  { storageId: PRIMARY_ID, provider: 'pikpak', displayName: 'PikPak', enabled: true },
  { storageId: QUARK_ID, provider: 'quark', displayName: '夸克网盘', enabled: true },
] } }
function clone(value) { return value == null ? value : structuredClone(value) }
function clearConfigCache() {
  configCacheEpoch += 1
  configCache = null
  configReadInFlight = null
  for (const cacheKey of new Set([...authCache.keys(), ...authCacheEpoch.keys(), ...authReadInFlight.keys()])) {
    authCacheEpoch.set(cacheKey, (authCacheEpoch.get(cacheKey) || 0) + 1)
  }
  authCache.clear()
  authReadInFlight.clear()
}
function invalidateAuthCache(cacheKey) {
  authCache.delete(cacheKey)
  authCacheEpoch.set(cacheKey, (authCacheEpoch.get(cacheKey) || 0) + 1)
}
export function clearStorageCachesForTests() { clearConfigCache() }
export async function readConfig({ fresh = false } = {}) {
  if (!isPersistentStoreConfigured()) return defaults()
  const configKey = key('config')
  const currentFlight = configReadInFlight
  if (currentFlight?.key === configKey && currentFlight.epoch === configCacheEpoch && (!fresh || currentFlight.fresh)) {
    return clone(await currentFlight.promise)
  }
  if (fresh) { configCacheEpoch += 1; configCache = null }
  const epoch = configCacheEpoch
  if (!fresh && configCache?.key === configKey && configCache.expiresAt > Date.now()) return clone(configCache.value)
  const promise = (async () => {
    const [raw] = await runPipeline([['GET', configKey]])
    if (!raw) {
      const value = defaults()
      if (epoch === configCacheEpoch) configCache = { key: configKey, value, expiresAt: Date.now() + STORAGE_CACHE_TTL_MS }
      return value
    }
    try {
      const config = typeof raw === 'string' ? JSON.parse(raw) : raw
      const validRoot = i => (i.rootFolderId === undefined || i.rootFolderId === null || (typeof i.rootFolderId === 'string' && i.rootFolderId.length <= 512 && !/[\u0000-\u001f\u007f]/.test(i.rootFolderId))) && (i.rootFolderName === undefined || i.rootFolderName === null || (typeof i.rootFolderName === 'string' && i.rootFolderName.length <= 255))
      if (config.version !== 1 || !Array.isArray(config.instances) || !config.instances.length || config.instances.length > 50 || !config.instances.every(i => validateStorageId(i.storageId) && ['pikpak', 'quark'].includes(i.provider) && typeof i.displayName === 'string' && i.displayName.length <= 80 && typeof i.enabled === 'boolean' && validRoot(i)) || new Set(config.instances.map(i => i.storageId)).size !== config.instances.length || !config.instances.some(i => i.storageId === config.defaultStorageId)) throw Error()
      if (epoch === configCacheEpoch) configCache = { key: configKey, value: config, expiresAt: Date.now() + STORAGE_CACHE_TTL_MS }
      return config
    } catch { throw new StorageError('storage_config_invalid', 503) }
  })()
  configReadInFlight = { key: configKey, epoch, fresh, promise }
  try { return clone(await promise) } finally { if (configReadInFlight?.promise === promise) configReadInFlight = null }
}
export async function writeConfig(config) {
  clearConfigCache()
  await runPipeline([['SET', key('config'), JSON.stringify(config)]])
  clearConfigCache()
}
export async function readAuth(id, { fresh = false } = {}) {
  if (id === PRIMARY_ID) return process.env.PIKPAK_PAT ? { accessToken: process.env.PIKPAK_PAT } : null
  if (!isPersistentStoreConfigured()) return null
  const authKey = key('auth', id)
  const epochNow = authCacheEpoch.get(authKey) || 0
  const currentFlight = authReadInFlight.get(authKey)
  if (currentFlight?.epoch === epochNow && (!fresh || currentFlight.fresh)) return clone(await currentFlight.promise)
  if (fresh) invalidateAuthCache(authKey)
  const epoch = authCacheEpoch.get(authKey) || 0
  const cached = authCache.get(authKey)
  if (!fresh && cached?.expiresAt > Date.now()) return clone(cached.value)
  const promise = (async () => {
    const [raw] = await runPipeline([['GET', authKey]])
    const value = raw ? unseal(id, typeof raw === 'string' ? JSON.parse(raw) : raw) : null
    if (epoch === (authCacheEpoch.get(authKey) || 0)) authCache.set(authKey, { value, expiresAt: Date.now() + STORAGE_CACHE_TTL_MS })
    return value
  })()
  authReadInFlight.set(authKey, { epoch, fresh, promise })
  try { return clone(await promise) } finally { if (authReadInFlight.get(authKey)?.promise === promise) authReadInFlight.delete(authKey) }
}
export async function writeAuth(id, auth) {
  if (id === PRIMARY_ID) throw new StorageError('primary_credentials_managed_by_environment', 400)
  const authKey = key('auth', id)
  invalidateAuthCache(authKey)
  await runPipeline([['SET', authKey, JSON.stringify(seal(id, auth))]])
  invalidateAuthCache(authKey)
}
export async function writePending(id, pending) { await runPipeline([['SET', key('oauth', id), JSON.stringify(seal(id, pending)), 'EX', '600']]) }
export async function readPending(id) {
  const [raw] = await runPipeline([['GET', key('oauth', id)]])
  return raw ? unseal(id, JSON.parse(raw)) : null
}
export async function clearPending(id) { await runPipeline([['DEL', key('oauth', id)]]) }
export async function withLock(id, task) {
  const lockKey = key('lock', id), owner = crypto.randomUUID()
  const [acquired] = await runPipeline([['SET', lockKey, owner, 'NX', 'EX', '90']])
  if (!acquired) throw new StorageError('storage_operation_busy', 409)
  try { return await task() } finally {
    await runPipeline([['EVAL', "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0", '1', lockKey, owner]])
  }
}
