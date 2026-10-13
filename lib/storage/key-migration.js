import crypto from 'node:crypto'
import { runPipeline, storeKeyPrefix } from '../admin-store.js'
import { unseal, withLock, clearStorageCaches } from './store.js'
import { StorageError } from './errors.js'
import { keyringKeys, keyProof, proofMatches, legacyStorageKey, wrapStorageKey, unwrapStorageKey, readKeyringState, resolveStorageDataKey } from './keyring.js'

const MAX_RECORDS = 256
const ID = /^[a-f0-9]{32}$/
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const recordKey = ({ kind, id }) => `${storeKeyPrefix()}storage:${kind}:v1:${id}`
const backupKey = (migrationId, record) => keyringKeys().record(migrationId, `backup:${record.kind}:${record.id}`)
const error = code => new StorageError(`storage_key_migration_${code}`, 409)

// Only new migration metadata is changed. Existing credential keys are never set,
// deleted, expired or restored by this module, including during rollback/recovery.
const CAS = `-- map7e-key-migration-cas
local manifest = redis.call('GET', KEYS[1]) or ''
local pointer = redis.call('GET', KEYS[2]) or ''
if manifest ~= ARGV[1] or pointer ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[1], ARGV[3])
if ARGV[4] == '' then redis.call('DEL', KEYS[2]) else redis.call('SET', KEYS[2], ARGV[4]) end
return 1`
const SNAPSHOT = `-- map7e-key-migration-snapshot
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
local value = redis.call('GET', KEYS[1])
if not value then return -2 end
if value ~= ARGV[1] then return -1 end
local ttl = redis.call('PTTL', KEYS[1])
local now = redis.call('TIME')
local expires = 0
if ttl >= 0 then expires = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000) + ttl end
local backup = cjson.encode({version=1, kind=ARGV[2], id=ARGV[3], ciphertext=value, checksum=ARGV[4], expiresAt=expires})
redis.call('SET', KEYS[2], backup, 'NX')
return 1`

function readable(raw, record, key) {
  if (!key) return null
  try {
    if (typeof raw !== 'string' || raw.length > 131072) return false
    const envelope = JSON.parse(raw)
    if (envelope.version !== 1 || ![envelope.iv, envelope.tag, envelope.data].every(value => typeof value === 'string')) return false
    const value = unseal(record.id, envelope, key)
    return Boolean(value && typeof value === 'object' && !Array.isArray(value)
      && (record.kind !== 'auth' || (typeof value.accessToken === 'string' && value.accessToken)))
  } catch { return false }
}
async function scanRecords(key) {
  const records = []
  for (const kind of ['auth', 'oauth']) {
    const prefix = `${storeKeyPrefix()}storage:${kind}:v1:`, seen = new Set()
    let cursor = '0', pages = 0
    do {
      if (pages++ >= 100) throw error('inventory_limit')
      const [page] = await runPipeline([['SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', '100']])
      if (!Array.isArray(page) || page.length !== 2 || !Array.isArray(page[1]) || !/^\d+$/.test(String(page[0]))) throw error('response_invalid')
      cursor = String(page[0])
      const batch = []
      for (const fullKey of page[1]) {
        if (typeof fullKey !== 'string' || !fullKey.startsWith(prefix)) throw error('unrecognized_record')
        if (seen.has(fullKey)) continue
        seen.add(fullKey)
        const id = fullKey.slice(prefix.length)
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || records.length + batch.length >= MAX_RECORDS) throw error('inventory_limit')
        batch.push({ kind, id })
      }
      const values = batch.length ? await runPipeline(batch.flatMap(record => [['GET', recordKey(record)], ['PTTL', recordKey(record)]])) : []
      for (const [index, item] of batch.entries()) {
        const [raw, ttlMs] = values.slice(index * 2, index * 2 + 2)
        if (raw === null || ttlMs === -2) continue // OAuth may expire while scanning.
        if (!Number.isInteger(ttlMs) || ttlMs < -1) throw error('response_invalid')
        const record = { ...item, raw, ttlMs }
        record.readable = readable(raw, record, key)
        records.push(record)
      }
    } while (cursor !== '0')
  }
  return records.sort((a, b) => recordKey(a).localeCompare(recordKey(b)))
}
function requireReadable(records) {
  if (records.some(record => record.readable !== true)) throw error('unreadable_records')
}
async function verifyBackups(manifest, key) {
  if (!manifest) return 0
  let verified = 0
  const values = manifest.records.length ? await runPipeline(manifest.records.map(record => ['GET', backupKey(manifest.id, record)])) : []
  for (const [index, record] of manifest.records.entries()) {
    const raw = values[index]
    try {
      const value = JSON.parse(raw)
      if (value.version !== 1 || value.id !== record.id || value.kind !== record.kind
        || typeof value.ciphertext !== 'string' || hash(value.ciphertext) !== value.checksum
        || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0
        || !readable(value.ciphertext, record, key)) throw error('backup_invalid')
      verified++
    } catch { throw error('backup_invalid') }
  }
  return verified
}
async function verifiedWrappedBackup(manifest) {
  const [raw] = await runPipeline([['GET', keyringKeys().record(manifest.id, 'wrapped-backup')]])
  let key
  try {
    key = unwrapStorageKey(JSON.parse(raw), manifest.id)
    if (!proofMatches(key, manifest)) throw error('backup_invalid')
    return { raw, key }
  } catch {
    key?.fill(0)
    throw error('backup_invalid')
  }
}
async function compareAndSet(state, manifest, pointer) {
  const keys = keyringKeys()
  const [changed] = await runPipeline([['EVAL', CAS, 2, keys.manifest, keys.pointer,
    state.manifestRaw || '', state.pointerRaw || '', JSON.stringify(manifest), pointer ? JSON.stringify(pointer) : '']])
  if (changed !== 1) throw error('state_changed')
  clearStorageCaches()
}
async function immutableSet(key, value) {
  await runPipeline([['SET', key, value, 'NX']])
  const [stored] = await runPipeline([['GET', key]])
  return stored
}
function requireMigration(state, id) {
  if (!ID.test(id || '') || !state.manifest || state.manifest.id !== id) throw error('id_mismatch')
}
function requireCovered(records, manifest) {
  const backed = new Set(manifest.records.map(recordKey))
  if (records.some(record => !backed.has(recordKey(record)))) throw error('prepare_again')
}
function legacySource(manifest) {
  const key = legacyStorageKey(process.env.PIKPAK_PAT)
  if (!proofMatches(key, manifest)) { key.fill(0); throw error('legacy_key_mismatch') }
  return key
}
async function snapshotRecords(manifest, key, records) {
  const covered = new Map(manifest.records.map(record => [recordKey(record), record]))
  for (const record of records) {
    const [result] = await runPipeline([['EVAL', SNAPSHOT, 2, recordKey(record), backupKey(manifest.id, record),
      record.raw, record.kind, record.id, hash(record.raw)]])
    if (result === -1) throw error('source_changed')
    if (![0, 1, -2].includes(result)) throw error('response_invalid')
    if (result !== -2) covered.set(recordKey(record), { kind: record.kind, id: record.id })
  }
  const updated = { ...manifest, records: [...covered.values()] }
  if (updated.records.length > MAX_RECORDS) throw error('inventory_limit')
  await verifyBackups(updated, key)
  return updated
}

export async function inspectStorageKeyMigration() {
  const state = await readKeyringState()
  let key, keyError = null, backupVerified = 0, independentVerified = false
  try {
    try { key = await resolveStorageDataKey() } catch (failure) { keyError = failure instanceof StorageError ? failure.code : 'storage_keyring_unreadable' }
    const records = await scanRecords(key)
    if (key && state.manifest) {
      try { backupVerified = await verifyBackups(state.manifest, key) } catch { keyError = 'storage_key_migration_backup_invalid' }
    }
    if (state.pointer && process.env.STORAGE_ENCRYPTION_KEY && !keyError && records.every(record => record.readable === true)) {
      let independent, backup
      try {
        independent = await resolveStorageDataKey({ requireIndependent: true })
        backup = await verifiedWrappedBackup(state.manifest)
        independentVerified = proofMatches(independent, state.manifest) && backupVerified === state.manifest.records.length
        requireCovered(records, state.manifest)
      } catch { independentVerified = false } finally { independent?.fill(0); backup?.key.fill(0) }
    }
    return {
      ok: true, environment: process.env.VERCEL_ENV === 'preview' ? 'preview' : 'production',
      id: state.manifest?.id || null, state: state.pointer ? 'active' : state.manifest?.state || 'legacy',
      independentKeyConfigured: Boolean(process.env.STORAGE_ENCRYPTION_KEY), keyError,
      records: records.map(({ kind, id, ttlMs, readable }) => ({ kind, id, ttlMs, readable })),
      recordCount: records.length, unreadableCount: records.filter(record => record.readable === false).length,
      unknownCount: records.filter(record => record.readable === null).length, backupVerified,
      independentVerified,
      // This is encryption evidence only. Actual Quark/Worker validation and the
      // owner's approval remain required before changing any Production PAT.
      patRotationApproved: false,
    }
  } finally { key?.fill(0) }
}

async function prepare() {
  let state = await readKeyringState()
  if (state.manifest?.state === 'active' && !state.pointer) throw error('not_active')
  if (!state.manifest && process.env.STORAGE_ENCRYPTION_KEY) throw error('source_not_legacy')
  const id = state.manifest?.id || crypto.randomBytes(16).toString('hex')
  const key = state.pointer ? await resolveStorageDataKey() : state.manifest ? legacySource(state.manifest) : legacyStorageKey(process.env.PIKPAK_PAT)
  try {
    const records = await scanRecords(key)
    requireReadable(records)
    if (!records.length && !state.manifest) throw error('no_records')
    if (!state.manifest) {
      const manifest = { version: 1, id, state: 'preparing', sourceProof: keyProof(key, id), records: [], createdAt: Date.now() }
      await compareAndSet(state, manifest, null)
      state = await readKeyringState()
    }
    const manifest = await snapshotRecords(state.manifest, key, records)
    await compareAndSet(state, { ...manifest, state: state.pointer ? 'active' : 'prepared' }, state.pointer)
    return inspectStorageKeyMigration()
  } finally { key.fill(0) }
}
async function activate(id) {
  const state = await readKeyringState()
  requireMigration(state, id)
  if (state.pointer) {
    const result = await inspectStorageKeyMigration()
    if (!result.independentVerified) throw error('verification_failed')
    return result
  }
  if (state.manifest.state !== 'prepared') throw error('not_prepared')
  const key = legacySource(state.manifest)
  let decoded
  try {
    const records = await scanRecords(key)
    requireReadable(records); requireCovered(records, state.manifest)
    await verifyBackups(state.manifest, key)
    const keys = keyringKeys(), candidateKey = keys.record(id, 'wrapped')
    const [existing] = await runPipeline([['GET', candidateKey]])
    const candidate = existing || JSON.stringify(wrapStorageKey(key, id))
    const stored = await immutableSet(candidateKey, candidate)
    try { decoded = unwrapStorageKey(JSON.parse(stored), id) } catch { throw error('candidate_invalid') }
    if (!proofMatches(decoded, state.manifest)) throw error('candidate_invalid')
    const backup = await immutableSet(keys.record(id, 'wrapped-backup'), stored)
    if (backup !== stored) throw error('backup_invalid')
    await compareAndSet(state, { ...state.manifest, state: 'active' }, { version: 1, id, slot: 'wrapped' })
    return inspectStorageKeyMigration()
  } finally { key.fill(0); decoded?.fill(0) }
}
async function rollback(id) {
  const state = await readKeyringState()
  requireMigration(state, id)
  // Never fall back to a rotated PAT. Do not restore stale OAuth credentials.
  const key = legacySource(state.manifest)
  try {
    const records = await scanRecords(key)
    requireReadable(records); await verifyBackups(state.manifest, key)
    await compareAndSet(state, { ...state.manifest, state: 'prepared' }, null)
    return inspectStorageKeyMigration()
  } finally { key.fill(0) }
}
async function recover(id) {
  const state = await readKeyringState({ recovering: true })
  requireMigration(state, id)
  if (state.manifest.state !== 'active') throw error('not_active')
  if (state.pointer) {
    const current = await inspectStorageKeyMigration()
    if (current.independentVerified) return current
  }
  const keys = keyringKeys()
  let key
  try {
    const backup = await verifiedWrappedBackup(state.manifest)
    key = backup.key
    const records = await scanRecords(key)
    requireReadable(records)
    const manifest = await snapshotRecords(state.manifest, key, records)
    const slot = `recovered-${crypto.randomBytes(16).toString('hex')}`
    if (await immutableSet(keys.record(id, slot), backup.raw) !== backup.raw) throw error('state_changed')
    // The unreadable original wrapper remains intact; only our pointer changes.
    await compareAndSet(state, manifest, { version: 1, id, slot })
    return inspectStorageKeyMigration()
  } finally { key?.fill(0) }
}
export async function runStorageKeyMigration(action, { id } = {}) {
  if (!['prepare', 'activate', 'rollback', 'recover'].includes(action)) throw error('invalid_action')
  return withLock('key-migration', () => ({ prepare, activate, rollback, recover })[action](id))
}
