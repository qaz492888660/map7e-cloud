import crypto from 'node:crypto'
import { runPipeline, storeKeyPrefix, isPersistentStoreConfigured } from '../admin-store.js'
import { StorageError } from './errors.js'
export const PRIMARY_ID = 'pikpak-main'
export const QUARK_ID = 'quark-main'
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
export async function readConfig() {
  if (!isPersistentStoreConfigured()) return defaults()
  const [raw] = await runPipeline([['GET', key('config')]])
  if (!raw) return defaults()
  try {
    const config = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (config.version !== 1 || !Array.isArray(config.instances) || !config.instances.length || config.instances.length > 50 || !config.instances.every(i => validateStorageId(i.storageId) && ['pikpak', 'quark'].includes(i.provider) && typeof i.displayName === 'string' && i.displayName.length <= 80 && typeof i.enabled === 'boolean') || new Set(config.instances.map(i => i.storageId)).size !== config.instances.length || !config.instances.some(i => i.storageId === config.defaultStorageId)) throw Error()
    return config
  } catch { throw new StorageError('storage_config_invalid', 503) }
}
export async function writeConfig(config) { await runPipeline([['SET', key('config'), JSON.stringify(config)]]) }
export async function readAuth(id) {
  if (id === PRIMARY_ID) return process.env.PIKPAK_PAT ? { accessToken: process.env.PIKPAK_PAT } : null
  if (!isPersistentStoreConfigured()) return null
  const [raw] = await runPipeline([['GET', key('auth', id)]])
  return raw ? unseal(id, typeof raw === 'string' ? JSON.parse(raw) : raw) : null
}
export async function writeAuth(id, auth) {
  if (id === PRIMARY_ID) throw new StorageError('primary_credentials_managed_by_environment', 400)
  await runPipeline([['SET', key('auth', id), JSON.stringify(seal(id, auth))]])
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
