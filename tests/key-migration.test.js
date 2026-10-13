import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { storeKeyPrefix } from '../lib/admin-store.js'
import { seal, readAuth, writeAuth, readPending, writePending, clearStorageCaches } from '../lib/storage/store.js'
import { keyringKeys, legacyStorageKey, resolveStorageDataKey, wrapStorageKey, unwrapStorageKey } from '../lib/storage/keyring.js'
import { inspectStorageKeyMigration, runStorageKeyMigration } from '../lib/storage/key-migration.js'
import { createAdminSessionToken, hasValidAdminSession } from '../lib/admin-auth.js'
import { createSessionToken, hasValidSession } from '../lib/cloud-auth.js'
import { createMediaTicket } from '../lib/storage/media-ticket.js'
import { createMediaGatewayWorker } from '../services/media-gateway/src/worker.js'
import dispatcher from '../api/dispatcher.js'

// Synthetic fixtures only. No project environment files or live services are read.
const OLD_PAT = 'synthetic-old-pat-for-migration-tests'
const NEW_PAT = 'synthetic-new-pat-for-migration-tests'
const MASTER = 'synthetic-independent-wrapping-key-at-least-32-characters'
const AUTH = { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', deviceId: 'synthetic-device' }
const originalFetch = globalThis.fetch
const envKeys = ['PIKPAK_PAT', 'STORAGE_ENCRYPTION_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'VERCEL_ENV', 'ADMIN_PASSWORD']
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const authKey = id => `${storeKeyPrefix()}storage:auth:v1:${id}`
function fixture() {
  process.env.PIKPAK_PAT = OLD_PAT
  delete process.env.STORAGE_ENCRYPTION_KEY
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test'
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic-redis-token'
  delete process.env.KV_REST_API_URL
  delete process.env.KV_REST_API_TOKEN
  process.env.VERCEL_ENV = 'production'
  process.env.ADMIN_PASSWORD = 'synthetic-admin-password'
  clearStorageCaches()
  const data = new Map(), deadlines = new Map(), commands = []
  const state = { now: Date.now(), beforeSnapshot: null, beforeCAS: null, scanOverride: null }
  function get(key) {
    if (deadlines.has(key) && deadlines.get(key) <= state.now) { data.delete(key); deadlines.delete(key) }
    return data.get(key) ?? null
  }
  function set(key, value, args = []) {
    if (args.includes('NX') && get(key) !== null) return null
    data.set(key, value); deadlines.delete(key)
    if (args.includes('EX')) deadlines.set(key, state.now + Number(args[args.indexOf('EX') + 1]) * 1000)
    return 'OK'
  }
  function execute(command) {
    commands.push(command)
    const [op, key, value, ...args] = command
    if (op === 'GET') return get(key)
    if (op === 'SET') return set(key, value, args)
    if (op === 'DEL') { deadlines.delete(key); return Number(data.delete(key)) }
    if (op === 'PTTL') return get(key) === null ? -2 : deadlines.has(key) ? deadlines.get(key) - state.now : -1
    if (op === 'SCAN') {
      if (state.scanOverride) return state.scanOverride(command)
      const prefix = args[0].slice(0, -1)
      const keys = [...data.keys()].filter(candidate => candidate.startsWith(prefix) && get(candidate) !== null).sort()
      // Multiple pages exercise cursor handling, duplicate-safe accumulation.
      const offset = Number(key), next = offset + 2
      return [next < keys.length ? String(next) : '0', keys.slice(offset, next)]
    }
    if (op === 'EVAL') {
      const count = Number(value), keys = args.slice(0, count), argv = args.slice(count)
      if (key.includes('map7e-key-migration-cas')) {
        state.beforeCAS?.(keys, argv)
        if ((get(keys[0]) || '') !== argv[0] || (get(keys[1]) || '') !== argv[1]) return 0
        set(keys[0], argv[2])
        if (argv[3] === '') data.delete(keys[1]); else set(keys[1], argv[3])
        return 1
      }
      if (key.includes('map7e-key-migration-snapshot')) {
        state.beforeSnapshot?.(keys, argv)
        if (get(keys[1]) !== null) return 0
        const raw = get(keys[0])
        if (raw === null) return -2
        if (raw !== argv[0]) return -1
        set(keys[1], JSON.stringify({ version: 1, kind: argv[1], id: argv[2], ciphertext: raw,
          checksum: argv[3], expiresAt: deadlines.get(keys[0]) || 0 }))
        return 1
      }
      return get(keys[0]) === argv[0] ? Number(data.delete(keys[0])) : 0
    }
    throw Error(`Unsupported fixture command: ${op}`)
  }
  const fetchRedis = async (url, init) => {
    assert.equal(new URL(url).hostname, 'redis.test', 'no live service is called')
    return json(JSON.parse(init.body).map(command => ({ result: execute(command) })))
  }
  globalThis.fetch = fetchRedis
  return { data, deadlines, commands, state, get, set, fetchRedis }
}
function activeCredentialSnapshot(f) {
  return [...f.data].filter(([key]) => /storage:(auth|oauth):v1:/.test(key))
    .map(([key, value]) => [key, value, f.deadlines.get(key)]).sort(([a], [b]) => a.localeCompare(b))
}
function assertNoCredentialWrites(f) {
  assert.equal(f.commands.some(([op, key]) => ['SET', 'DEL', 'EXPIRE', 'PEXPIRE'].includes(op) && /storage:(auth|oauth):v1:/.test(key)), false)
}
async function preparedFixture() {
  const f = fixture()
  await writeAuth('quark-main', AUTH)
  const result = await runStorageKeyMigration('prepare')
  return { f, id: result.id }
}
async function activeFixture() {
  const value = await preparedFixture()
  process.env.STORAGE_ENCRYPTION_KEY = MASTER
  const result = await runStorageKeyMigration('activate', { id: value.id })
  assert.equal(result.independentVerified, true)
  return value
}

await test('read-only inventory includes orphan auth and expiring OAuth, excludes Preview and plaintext metadata', async () => {
  const f = fixture()
  await writeAuth('quark-main', AUTH)
  await writeAuth('orphan-storage', AUTH)
  await writePending('quark-main', { state: 'synthetic-oauth-state', sessionBinding: 'synthetic-binding' })
  f.set('map7e-cloud:storage:config:v1:', '{}')
  f.set('map7e-cloud:preview:storage:auth:v1:preview-only', 'unreadable-preview-fixture')
  const before = [...f.data]
  f.commands.length = 0
  const result = await inspectStorageKeyMigration()
  assert.equal(result.recordCount, 3)
  assert.equal(result.unreadableCount, 0)
  assert.ok(result.records.some(record => record.id === 'orphan-storage'))
  assert.ok(result.records.some(record => record.kind === 'oauth' && record.ttlMs === 600_000))
  assert.deepEqual([...f.data], before)
  assert.ok(f.commands.every(([op]) => ['GET', 'PTTL', 'SCAN'].includes(op)))
  const output = JSON.stringify(result)
  for (const secret of [OLD_PAT, AUTH.accessToken, AUTH.refreshToken, 'synthetic-oauth-state']) assert.equal(output.includes(secret), false)
})
await test('prepare is resumable and idempotent with exact ciphertext backup and absolute OAuth expiry', async () => {
  const f = fixture()
  await writeAuth('quark-main', AUTH)
  await writePending('quark-main', { state: 'pending-only' })
  const before = activeCredentialSnapshot(f)
  let failed = false
  f.state.beforeSnapshot = ([key]) => {
    if (key.includes(':oauth:') && !failed) { failed = true; throw Error('synthetic-interruption') }
  }
  await assert.rejects(runStorageKeyMigration('prepare'))
  assert.equal(JSON.parse(f.get(keyringKeys().manifest)).state, 'preparing')
  f.state.beforeSnapshot = null
  f.commands.length = 0
  const prepared = await runStorageKeyMigration('prepare')
  const repeated = await runStorageKeyMigration('prepare')
  assert.equal(prepared.state, 'prepared')
  assert.equal(repeated.id, prepared.id)
  assert.equal(repeated.backupVerified, 2)
  const pendingBackup = JSON.parse(f.get(keyringKeys().record(prepared.id, 'backup:oauth:quark-main')))
  assert.equal(pendingBackup.expiresAt, f.state.now + 600_000)
  assert.equal(pendingBackup.ciphertext, before.find(([key]) => key.includes(':oauth:'))[1])
  assert.deepEqual(activeCredentialSnapshot(f), before)
  assertNoCredentialWrites(f)
})
await test('wrong old PAT, corrupt ciphertext, and unrecognized legacy records fail before any migration write', async () => {
  for (const kind of ['wrong-pat', 'tampered', 'wrong-storage']) {
    const f = fixture()
    await writeAuth('quark-main', AUTH)
    if (kind === 'wrong-pat') process.env.PIKPAK_PAT = NEW_PAT
    if (kind === 'tampered') f.set(authKey('quark-main'), JSON.stringify({ ...JSON.parse(f.get(authKey('quark-main'))), tag: 'tampered' }))
    if (kind === 'wrong-storage') f.set(authKey('other-storage'), f.get(authKey('quark-main')))
    const before = [...f.data]
    await assert.rejects(runStorageKeyMigration('prepare'), /storage_key_migration_unreadable_records/)
    assert.equal(f.get(keyringKeys().manifest), null)
    assert.deepEqual([...f.data], before)
  }
})
await test('concurrent refresh during prepare refuses a stale snapshot and retries with the latest ciphertext', async () => {
  const f = fixture()
  await writeAuth('quark-main', AUTH)
  const refreshed = { ...AUTH, accessToken: 'synthetic-concurrent-access' }
  const key = legacyStorageKey(OLD_PAT)
  const latest = JSON.stringify(seal('quark-main', refreshed, key)); key.fill(0)
  f.state.beforeSnapshot = ([source]) => { f.set(source, latest); f.state.beforeSnapshot = null }
  await assert.rejects(runStorageKeyMigration('prepare'), /storage_key_migration_source_changed/)
  const prepared = await runStorageKeyMigration('prepare')
  assert.equal(prepared.backupVerified, 1)
  assert.equal(f.get(authKey('quark-main')), latest)
  assert.equal(JSON.parse(f.get(keyringKeys().record(prepared.id, 'backup:auth:quark-main'))).ciphertext, latest)
})
await test('new master is inactive until activation; PAT rotation keeps Cloud credentials and pending OAuth decryptable', async () => {
  const { f, id } = await preparedFixture()
  await writePending('quark-main', { state: 'pending-before-activation' })
  await runStorageKeyMigration('prepare')
  const before = activeCredentialSnapshot(f)
  process.env.STORAGE_ENCRYPTION_KEY = MASTER
  assert.deepEqual(await readAuth('quark-main', { fresh: true }), AUTH)
  assert.equal((await readPending('quark-main')).state, 'pending-before-activation')
  f.commands.length = 0
  const active = await runStorageKeyMigration('activate', { id })
  assert.equal(active.independentVerified, true)
  assert.equal(active.patRotationApproved, false)
  assert.deepEqual(activeCredentialSnapshot(f), before)
  assertNoCredentialWrites(f)
  const metadata = JSON.stringify([...f.data].filter(([key]) => key.includes('key-migration') || key.includes('keyring')))
  for (const secret of [OLD_PAT, MASTER, AUTH.accessToken, AUTH.refreshToken]) assert.equal(metadata.includes(secret), false)
  process.env.PIKPAK_PAT = NEW_PAT
  assert.deepEqual(await readAuth('quark-main', { fresh: true }), AUTH)
  assert.equal((await readPending('quark-main')).state, 'pending-before-activation')
  assert.equal((await readAuth('pikpak-main')).accessToken, NEW_PAT)
  await writeAuth('quark-main', { ...AUTH, accessToken: 'synthetic-new-cloud-access' })
  const stableKey = legacyStorageKey(OLD_PAT)
  const record = JSON.parse(f.get(authKey('quark-main')))
  const decipher = crypto.createDecipheriv('aes-256-gcm', stableKey, Buffer.from(record.iv, 'base64url'))
  decipher.setAAD(Buffer.from('quark-main')); decipher.setAuthTag(Buffer.from(record.tag, 'base64url'))
  assert.equal(JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.data, 'base64url')), decipher.final()])).accessToken, 'synthetic-new-cloud-access')
  stableKey.fill(0)
  assert.equal((await runStorageKeyMigration('activate', { id })).independentVerified, true)
})
await test('unchanged Worker decrypts Cloud writes and persists refresh readable by Cloud after PAT rotation', async () => {
  const { f } = await activeFixture()
  const ticketSecret = 'synthetic-media-signing-secret-at-least-32-bytes'
  process.env.PIKPAK_PAT = NEW_PAT
  await writeAuth('quark-main', { ...AUTH, accessExpiresAt: Date.now() - 1 })
  const config = { version: 1, defaultStorageId: 'quark-main', instances: [
    { storageId: 'quark-main', provider: 'quark', displayName: 'Quark', enabled: true },
  ] }
  f.set(`${storeKeyPrefix()}storage:config:v1:`, JSON.stringify(config))
  let rotations = 0
  const worker = createMediaGatewayWorker({ logger() {}, fetchImpl: async (input, init = {}) => {
    const url = new URL(input)
    if (url.hostname === 'redis.test') return f.fetchRedis(input, init)
    if (url.pathname === '/agent/v1/oauth/access_token/rotate') {
      rotations++
      assert.equal(JSON.parse(init.body).refresh_token, AUTH.refreshToken)
      return json({ status: 0, data: { access_token: 'synthetic-worker-refreshed-access', refresh_token: 'synthetic-worker-refreshed-refresh', expires_in: 3600 } })
    }
    if (url.pathname === '/open/v1/file/info') {
      assert.equal(url.searchParams.get('access_token'), 'synthetic-worker-refreshed-access')
      return json({ status: 0, data: { fid: 'fixture-file', pdir_fid: '0', file_name: 'fixture.txt', file_type: 1, size: 2 } })
    }
    if (url.pathname === '/open/v1/file/get_download_url') return json({ status: 0, data: { download_url: 'https://cdn.quark.cn/fixture', size: 2, file_name: 'fixture.txt' } })
    if (url.hostname === 'cdn.quark.cn') return new Response(new Uint8Array([1]), { status: 206,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '1', 'Content-Range': 'bytes 0-0/2' } })
    throw Error('Unexpected synthetic upstream')
  } })
  const ticket = createMediaTicket({ storageId: 'quark-main', fileId: 'fixture-file', parentId: '', purpose: 'original', disposition: 'attachment' }, { secret: ticketSecret })
  const reply = await worker.fetch(new Request(`https://media.example.test/v1/media?ticket=${encodeURIComponent(ticket)}`, {
    method: 'HEAD', headers: { Origin: 'https://cloud.example.test' },
  }), { MEDIA_GATEWAY_SIGNING_SECRET: ticketSecret, MEDIA_GATEWAY_ALLOWED_ORIGIN: 'https://cloud.example.test',
    MEDIA_GATEWAY_SITE_DOMAIN: 'example.test', UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'synthetic-redis-token',
    STORAGE_ENCRYPTION_KEY: OLD_PAT })
  assert.equal(reply.status, 200, await reply.text())
  assert.equal(rotations, 1)
  assert.equal((await readAuth('quark-main', { fresh: true })).accessToken, 'synthetic-worker-refreshed-access')
})
await test('wrong master never falls back; legacy runtime fallback accepts only the proven old PAT', async () => {
  await activeFixture()
  process.env.STORAGE_ENCRYPTION_KEY = `${MASTER}-wrong`
  await assert.rejects(readAuth('quark-main', { fresh: true }), /storage_keyring_unreadable/)
  delete process.env.STORAGE_ENCRYPTION_KEY
  assert.deepEqual(await readAuth('quark-main', { fresh: true }), AUTH)
  process.env.PIKPAK_PAT = NEW_PAT
  await assert.rejects(readAuth('quark-main', { fresh: true }), /storage_keyring_unreadable/)
  const result = await inspectStorageKeyMigration()
  assert.equal(result.independentVerified, false)
  assert.equal(result.unknownCount, 1)
})
await test('rollback preserves latest tokens and never revives expired OAuth; rotated PAT blocks rollback', async () => {
  const { f, id } = await activeFixture()
  await writePending('quark-main', { state: 'expires-before-rollback' })
  const latest = { ...AUTH, accessToken: 'synthetic-latest-access' }
  await writeAuth('quark-main', latest)
  f.state.now += 600_001
  const before = f.get(authKey('quark-main'))
  const rolledBack = await runStorageKeyMigration('rollback', { id })
  assert.equal(rolledBack.state, 'prepared')
  assert.equal(f.get(authKey('quark-main')), before)
  assert.deepEqual(await readAuth('quark-main', { fresh: true }), latest)
  assert.equal(await readPending('quark-main'), null)
  await runStorageKeyMigration('activate', { id })
  process.env.PIKPAK_PAT = NEW_PAT
  await assert.rejects(runStorageKeyMigration('rollback', { id }), /storage_key_migration_legacy_key_mismatch/)
  assert.ok(f.get(keyringKeys().pointer))
})
await test('recovery after PAT rotation uses wrapped backup, preserves damaged slot and current credentials', async () => {
  const { f, id } = await activeFixture()
  process.env.PIKPAK_PAT = NEW_PAT
  await writeAuth('quark-main', { ...AUTH, accessToken: 'synthetic-latest-after-rotation' })
  const before = activeCredentialSnapshot(f), corrupt = '{"version":1,"data":"damaged"}'
  f.set(keyringKeys().record(id, 'wrapped'), corrupt)
  await assert.rejects(readAuth('quark-main', { fresh: true }), /storage_keyring_unreadable/)
  const recovered = await runStorageKeyMigration('recover', { id })
  assert.equal(recovered.independentVerified, true)
  assert.equal(f.get(keyringKeys().record(id, 'wrapped')), corrupt)
  assert.deepEqual(activeCredentialSnapshot(f), before)
  assert.equal((await readAuth('quark-main', { fresh: true })).accessToken, 'synthetic-latest-after-rotation')
  f.data.delete(keyringKeys().pointer)
  await assert.rejects(resolveStorageDataKey(), /storage_keyring_unreadable/)
  assert.equal((await runStorageKeyMigration('recover', { id })).independentVerified, true)
  await writeAuth('created-after-activation', AUTH)
  assert.equal((await inspectStorageKeyMigration()).independentVerified, false, 'new records need backup coverage')
  assert.equal((await runStorageKeyMigration('prepare')).independentVerified, true)
  f.set(keyringKeys().pointer, 'damaged-pointer')
  await assert.rejects(resolveStorageDataKey(), /storage_keyring_unreadable/)
  assert.equal((await runStorageKeyMigration('recover', { id })).independentVerified, true)
})
await test('corrupt backup and uncovered new credentials block activation without overwriting data', async () => {
  const { f, id } = await preparedFixture()
  process.env.STORAGE_ENCRYPTION_KEY = MASTER
  await writeAuth('another-storage', AUTH)
  await assert.rejects(runStorageKeyMigration('activate', { id }), /storage_key_migration_prepare_again/)
  await runStorageKeyMigration('prepare')
  const backupKey = keyringKeys().record(id, 'backup:auth:quark-main')
  f.set(backupKey, 'damaged-backup')
  const before = activeCredentialSnapshot(f)
  await assert.rejects(runStorageKeyMigration('activate', { id }), /storage_key_migration_backup_invalid/)
  assert.equal(f.get(keyringKeys().pointer), null)
  assert.equal(f.get(backupKey), 'damaged-backup')
  assert.deepEqual(activeCredentialSnapshot(f), before)
})
await test('pointer CAS conflict leaves active data and immutable recovery material intact', async () => {
  const { f, id } = await preparedFixture()
  process.env.STORAGE_ENCRYPTION_KEY = MASTER
  const before = activeCredentialSnapshot(f)
  f.state.beforeCAS = ([manifestKey]) => {
    f.set(manifestKey, JSON.stringify({ ...JSON.parse(f.get(manifestKey)), concurrentMarker: true }))
    f.state.beforeCAS = null
  }
  await assert.rejects(runStorageKeyMigration('activate', { id }), /storage_key_migration_state_changed/)
  assert.equal(f.get(keyringKeys().pointer), null)
  assert.ok(f.get(keyringKeys().record(id, 'wrapped-backup')))
  assert.deepEqual(activeCredentialSnapshot(f), before)
  assert.equal((await runStorageKeyMigration('activate', { id })).independentVerified, true)
})
await test('envelope AAD prevents cross-environment or migration reuse; Preview writes stay isolated', async () => {
  fixture()
  process.env.STORAGE_ENCRYPTION_KEY = MASTER
  const id = 'a'.repeat(32), key = legacyStorageKey(OLD_PAT), wrapped = wrapStorageKey(key, id)
  assert.throws(() => unwrapStorageKey(wrapped, 'b'.repeat(32)), /storage_keyring_unreadable/)
  process.env.VERCEL_ENV = 'preview'
  assert.throws(() => unwrapStorageKey(wrapped, id), /storage_keyring_unreadable/)
  key.fill(0)
  const f = fixture()
  await writeAuth('quark-main', AUTH)
  const productionBefore = [...f.data]
  process.env.VERCEL_ENV = 'preview'
  await writeAuth('quark-main', { ...AUTH, accessToken: 'synthetic-preview-access' })
  const result = await runStorageKeyMigration('prepare')
  assert.equal(result.environment, 'preview')
  for (const [name, raw] of productionBefore) assert.equal(f.get(name), raw)
  assert.equal(f.get('map7e-cloud:storage:key-migration:v1:manifest'), null)
})
await test('bounded inventory and empty-source safeguards never create an unproven migration', async () => {
  let f = fixture()
  await assert.rejects(runStorageKeyMigration('prepare'), /storage_key_migration_no_records/)
  assert.equal(f.get(keyringKeys().manifest), null)
  f = fixture()
  f.state.scanOverride = () => ['1', []]
  await assert.rejects(inspectStorageKeyMigration(), /storage_key_migration_inventory_limit/)
  f = fixture()
  await writeAuth('quark-main', AUTH)
  process.env.STORAGE_ENCRYPTION_KEY = MASTER
  await assert.rejects(runStorageKeyMigration('prepare'), /storage_key_migration_source_not_legacy/)
})
await test('migration endpoint requires admin, same origin and explicit action; status contains no credentials', async () => {
  const f = fixture()
  await writeAuth('quark-main', AUTH)
  const response = () => ({ headers: {}, status(n) { this.statusCode = n; return this }, setHeader(k, v) { this.headers[k] = v }, json(v) { this.body = v; return this } })
  const send = async (method, body, headers = {}) => {
    const reply = response()
    await dispatcher({ method, query: { route: 'admin-key-migration' }, body, headers }, reply)
    return reply
  }
  assert.equal((await send('GET')).statusCode, 401)
  const visitor = createSessionToken(OLD_PAT)
  assert.equal((await send('POST', { action: 'prepare', confirm: 'storage-key-migration:prepare' }, { cookie: `map7e_cloud_session=${visitor.token}` })).statusCode, 401)
  const admin = createAdminSessionToken(), headers = { cookie: `map7e_admin_session=${admin.token}`, host: 'cloud.example.test', origin: 'https://cloud.example.test' }
  assert.equal((await send('GET', undefined, headers)).body.recordCount, 1)
  assert.equal((await send('POST', { action: 'prepare' }, headers)).statusCode, 400)
  assert.equal((await send('POST', { action: 'prepare', confirm: 'storage-key-migration:prepare', secret: MASTER }, headers)).statusCode, 400)
  assert.equal((await send('POST', { action: 'prepare', confirm: 'storage-key-migration:prepare' }, { ...headers, origin: 'https://evil.example.test' })).statusCode, 403)
  assert.equal(f.get(keyringKeys().manifest), null)
  const prepared = await send('POST', { action: 'prepare', confirm: 'storage-key-migration:prepare' }, headers)
  assert.equal(prepared.statusCode, 200)
  assert.equal(prepared.headers['Cache-Control'], 'private, no-store')
  for (const secret of [OLD_PAT, AUTH.accessToken, AUTH.refreshToken]) assert.equal(JSON.stringify(prepared.body).includes(secret), false)
  const visitorRequest = { headers: { cookie: `map7e_cloud_session=${visitor.token}` } }
  assert.equal(hasValidSession(visitorRequest, OLD_PAT), true)
  assert.equal(await hasValidAdminSession({ headers }), true)
  process.env.PIKPAK_PAT = NEW_PAT
  assert.equal(hasValidSession(visitorRequest, NEW_PAT), false)
  assert.equal(await hasValidAdminSession({ headers }), false)
  assert.equal(f.get(`${storeKeyPrefix()}admin-auth:v1`), null, 'no password or session-version changes are made')
})

globalThis.fetch = originalFetch
for (const key of envKeys) {
  if (originalEnv[key] === undefined) delete process.env[key]
  else process.env[key] = originalEnv[key]
}
