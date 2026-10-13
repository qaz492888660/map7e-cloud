import crypto from 'node:crypto'
import { isPersistentStoreConfigured, runPipeline, storeKeyPrefix } from '../admin-store.js'
import { StorageError } from './errors.js'

const ID = /^[a-f0-9]{32}$/
const fail = () => new StorageError('storage_keyring_unreadable', 503)
export function keyringKeys() {
  const base = `${storeKeyPrefix()}storage:key-migration:v1:`
  return {
    pointer: `${storeKeyPrefix()}storage:keyring:v1`,
    manifest: `${base}manifest`,
    record: (id, slot) => `${base}${id}:${slot}`,
  }
}
export function legacyStorageKey(secret) {
  if (!secret) throw new StorageError('storage_encryption_not_configured', 503)
  return crypto.createHash('sha256').update(`map7e-storage-v1\0${secret}`).digest()
}
function wrappingKey() {
  const secret = process.env.STORAGE_ENCRYPTION_KEY
  if (typeof secret !== 'string' || secret.length < 32) throw new StorageError('storage_independent_key_not_configured', 503)
  return crypto.createHash('sha256').update(`map7e-storage-wrapping-v1\0${secret}`).digest()
}
function binding(id) {
  if (!ID.test(id)) throw fail()
  return Buffer.from(`map7e-storage-keyring-v1\0${storeKeyPrefix()}\0${id}`)
}
export function keyProof(key, id) {
  return crypto.createHmac('sha256', key).update(binding(id)).digest('hex')
}
export function proofMatches(key, manifest) {
  if (!manifest || !ID.test(manifest.id) || !/^[a-f0-9]{64}$/.test(manifest.sourceProof || '')) return false
  return crypto.timingSafeEqual(Buffer.from(keyProof(key, manifest.id), 'hex'), Buffer.from(manifest.sourceProof, 'hex'))
}
export function wrapStorageKey(key, id) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw fail()
  const kek = wrappingKey(), iv = crypto.randomBytes(12)
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv)
    cipher.setAAD(binding(id))
    return { version: 1, id, iv: iv.toString('base64url'),
      data: Buffer.concat([cipher.update(key), cipher.final()]).toString('base64url'), tag: cipher.getAuthTag().toString('base64url') }
  } finally { kek.fill(0) }
}
export function unwrapStorageKey(value, id) {
  const kek = wrappingKey()
  try {
    if (value?.version !== 1 || value.id !== id || ![value.iv, value.tag, value.data].every(text => typeof text === 'string' && /^[A-Za-z0-9_-]+$/.test(text))) throw fail()
    const iv = Buffer.from(value.iv, 'base64url'), tag = Buffer.from(value.tag, 'base64url'), data = Buffer.from(value.data, 'base64url')
    if (iv.length !== 12 || tag.length !== 16 || data.length !== 32) throw fail()
    const cipher = crypto.createDecipheriv('aes-256-gcm', kek, iv)
    cipher.setAAD(binding(id)); cipher.setAuthTag(tag)
    return Buffer.concat([cipher.update(data), cipher.final()])
  } catch { throw fail() } finally { kek.fill(0) }
}
export function parseManifest(raw) {
  if (raw === null || raw === undefined) return null
  try {
    const value = JSON.parse(raw)
    if (value.version !== 1 || !ID.test(value.id) || !['preparing', 'prepared', 'active'].includes(value.state)
      || !/^[a-f0-9]{64}$/.test(value.sourceProof) || !Array.isArray(value.records) || value.records.length > 256
      || !value.records.every(record => ['auth', 'oauth'].includes(record.kind) && /^[a-z][a-z0-9-]{0,63}$/.test(record.id))) throw fail()
    return value
  } catch { throw fail() }
}
export function parsePointer(raw) {
  if (raw === null || raw === undefined) return null
  try {
    const value = JSON.parse(raw)
    if (value.version !== 1 || !ID.test(value.id) || !/^(wrapped|recovered-[a-f0-9]{32})$/.test(value.slot)) throw fail()
    return value
  } catch { throw fail() }
}
export async function readKeyringState({ recovering = false } = {}) {
  const keys = keyringKeys()
  const [pointerRaw, manifestRaw] = await runPipeline([['GET', keys.pointer], ['GET', keys.manifest]])
  let pointer
  try { pointer = parsePointer(pointerRaw) } catch (error) { if (!recovering) throw error }
  // Recovery still requires the authenticated manifest and immutable wrapped
  // backup. A malformed pointer is compared byte-for-byte, never trusted.
  return { pointerRaw, manifestRaw, pointer, manifest: parseManifest(manifestRaw) }
}
export async function resolveStorageDataKey({ requireIndependent = false } = {}) {
  if (!isPersistentStoreConfigured()) {
    if (requireIndependent) throw new StorageError('storage_independent_key_not_configured', 503)
    return legacyStorageKey(process.env.STORAGE_ENCRYPTION_KEY || process.env.PIKPAK_PAT)
  }
  const { pointer, manifest } = await readKeyringState()
  if (pointer) {
    if (!manifest || manifest.state !== 'active' || pointer.id !== manifest.id) throw fail()
    if (process.env.STORAGE_ENCRYPTION_KEY) {
      const [raw] = await runPipeline([['GET', keyringKeys().record(pointer.id, pointer.slot)]])
      let value
      try { value = JSON.parse(raw) } catch { throw fail() }
      const key = unwrapStorageKey(value, pointer.id)
      if (!proofMatches(key, manifest)) { key.fill(0); throw fail() }
      return key
    }
    // Already-running deployments may still have only the old PAT. The proof
    // permits that exact data key during rollout, never a new PAT or a bad KEK.
    if (requireIndependent) throw new StorageError('storage_independent_key_not_configured', 503)
  } else {
    if (manifest?.state === 'active') throw fail()
    if (requireIndependent) throw new StorageError('storage_key_migration_not_active', 409)
  }
  if (manifest) {
    const key = legacyStorageKey(process.env.PIKPAK_PAT)
    if (!proofMatches(key, manifest)) { key.fill(0); throw fail() }
    return key
  }
  return legacyStorageKey(process.env.STORAGE_ENCRYPTION_KEY || process.env.PIKPAK_PAT)
}
