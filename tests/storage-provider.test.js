Warning: truncated output (original token count: 16291)
Total output lines: 1010

import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { Writable } from 'node:stream'
import { seal, unseal, metadataId, writeAuth, readAuth, readConfig, writeConfig, withLock, clearStorageCachesForTests } from '../lib/storage/store.js'
import { storageDescriptors, resolveStorage } from '../lib/storage/registry.js'
import storageProviders from '../lib/api-handlers/storage-providers.js'
import storageAbout, { clearStorageAboutCacheForTests } from '../lib/api-handlers/storage-about.js'
import { safeDirectUrl } from '../lib/storage/errors.js'
import { logPreviewDiagnostic, previewSourceFieldNames, previewSourceUrl, safeBrowserPreviewUrl, probeRange } from '../lib/storage/previews.js'
import { createPikPakProvider } from '../lib/storage/providers/pikpak.js'
import { createQuarkProvider, normalizeQuarkItem, quarkHeaders, beginQuarkAuthorization, finishQuarkAuthorization } from '../lib/storage/providers/quark.js'
import { OFFICIAL_SIGN_KEY } from '../lib/storage/providers/quark-client.js'
import { requireItemRead } from '../lib/storage/permissions.js'
import { folderPathWithinRoot } from '../lib/storage/root.js'
import { setFileMetadata, setGlobalAccess } from '../lib/admin-store.js'
import { createAdminSessionToken } from '../lib/admin-auth.js'
import { createSessionToken } from '../lib/cloud-auth.js'
import storageFiles from '../lib/api-handlers/storage-files.js'
import quarkOAuth from '../lib/api-handlers/quark-oauth.js'
import adminStorages from '../lib/api-handlers/admin-storages.js'
import { storageWrite } from '../lib/api-handlers/storage-write.js'
import storageDownload from '../lib/api-handlers/storage-download.js'
import storagePreview from '../lib/api-handlers/storage-preview.js'

process.env.PIKPAK_PAT = 'primary-test-secret'
process.env.STORAGE_ENCRYPTION_KEY = 'test-encryption-key'
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test'
process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-test-secret'
process.env.VERCEL_ENV = 'production'
const redis = new Map(), calls = [], redisReads = new Map()
let upstream = async () => ({ status: 0, data: {} })
const response = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
function quarkSuffix(value) { const fid = String(value || ''), separator = fid.lastIndexOf('|'); return separator >= 0 && separator < fid.length - 1 ? fid.slice(separator + 1) : fid }
globalThis.fetch = async (url, options = {}) => {
  if (String(url).startsWith('https://redis.test')) {
    return response(JSON.parse(options.body).map(([op, key, value, ...args]) => {
      if (op === 'GET') { redisReads.set(key, (redisReads.get(key) || 0) + 1); return { result: redis.get(key) ?? null } }
      if (op === 'SET') { if (args.includes('NX') && redis.has(key)) return { result: null }; redis.set(key, value); return { result: 'OK' } }
      if (op === 'DEL') return { result: Number(redis.delete(key)) }
      if (op === 'EVAL') { const lockKey = args[0], owner = args[1]; return { result: redis.get(lockKey) === owner ? Number(redis.delete(lockKey)) : 0 } }
      throw Error(`Unsupported Redis fixture: ${op}`)
    }))
  }
  calls.push({ url: new URL(url), ...options })
  const payload = await upstream(new URL(url), options)
  return payload instanceof Response ? payload : response(payload)
}
function res() { return { headers: {}, status(n) { this.statusCode = n; return this }, setHeader(k,v) { this.headers[k] = v }, json(v) { this.body = v; return this }, end(value) { this.body = value; return this } } }
function streamRes() {
  const chunks = []
  const target = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback() } })
  target.headers = {}
  target.status = function status(code) { this.statusCode = code; return this }
  target.setHeader = function setHeader(name, value) { this.headers[name] = value }
  target.json = function json(body) { this.body = body; return this }
  target.bytes = () => Buffer.concat(chunks)
  return target
}

await test('encrypted credentials bind to storage, detect tampering, and stay out of descriptors', async () => {
  const auth = { accessToken: 'account-access-secret', refreshToken: 'account-refresh-secret', deviceId: 'device' }
  const encrypted = seal('quark-main', auth)
  assert.deepEqual(unseal('quark-main', encrypted), auth)
  assert.ok(!JSON.stringify(encrypted).includes(auth.accessToken))
  assert.throws(() => unseal('other-storage', encrypted), /storage_credentials_unreadable/)
  assert.throws(() => unseal('quark-main', { ...encrypted, tag: 'invalid' }), /storage_credentials_unreadable/)
  await writeAuth('quark-main', auth)
  assert.deepEqual(await readAuth('quark-main'), auth)
  const descriptors = JSON.stringify(await storageDescriptors())
  for (const token of [auth.accessToken, auth.refreshToken, process.env.PIKPAK_PAT]) assert.ok(!descriptors.includes(token))
  process.env.VERCEL_ENV = 'preview'
  assert.equal(await readAuth('quark-main'), null)
  process.env.VERCEL_ENV = 'production'
})
await test('provider list stays fast and storage-about probes only the selected provider quota', async () => {
  await writeConfig({ version: 1, defaultStorageId: 'pikpak-main', instances: [
    { storageId: 'pikpak-main', provider: 'pikpak', displayName: 'PikPak', enabled: true },
    { storageId: 'quark-main', provider: 'quark', displayName: '夸克网盘', enabled: true },
  ] })
  const quarkAuth = { accessToken: 'target-quark-access', refreshToken: 'target-quark-refresh', deviceId: 'target-device' }
  await writeAuth('quark-main', quarkAuth)
  clearStorageAboutCacheForTests()
  calls.length = 0
  upstream = async url => {
    if (url.pathname.endsWith('/drive/v1/about')) return { user: { name: 'PikPak owner' }, quota: { limit: '1024', usage: '256' } }
    if (url.pathname.endsWith('/user/info')) return { status: 0, data: { nickname: 'Quark owner' } }
    if (url.pathname.endsWith('/user/get_vip_info')) return { status: 0, data: { vip_type: 'SVIP', capacity: '4096', used: '1024' } }
    throw Error('Unexpected provider probe')
  }
  const anonymous = res()
  await storageAbout({ method: 'GET', query: { storageId: 'pikpak-main' }, headers: {} }, anonymous)
  assert.equal(anonymous.statusCode, 503, 'quota and account data require an authorized cloud session')
  assert.equal(calls.length, 0, 'unauthorized quota requests do not probe stored provider credentials')
  const cloudSession = createSessionToken(process.env.PIKPAK_PAT)
  const authorizedRequest = storageId => ({ method: 'GET', query: { storageId }, headers: { cookie: `map7e_cloud_session=${cloudSession.token}` } })

  const list = res()
  await storageProviders({ method: 'GET', query: {} }, list)
  assert.equal(list.statusCode, 200)
  assert.equal(calls.length, 0, 'ordinary provider discovery does not call any provider API')
  assert.equal(list.body.providers.find(item => item.id === 'pikpak-main').quota, null)
  assert.equal(list.body.providers.find(item => item.id === 'quark-main').quota, null)

  const pikpak = res()
  await storageAbout(authorizedRequest('pikpak-main'), pikpak)
  assert.equal(pikpak.statusCode, 200)
  assert.deepEqual(pikpak.body.quota, { total: 1024, used: 256, free: 768 })
  assert.deepEqual(pikpak.body.accountInfo, { provider: 'pikpak', nickname: 'PikPak owner' })
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/drive/v1/about')).length, 1, 'PikPak account and quota share one /about request')
  assert.equal(calls.filter(call => call.url.hostname === 'open-api-drive.quark.cn').length, 0, 'inactive Quark is not probed')

  clearStorageAboutCacheForTests()
  const quark = res()
  await storageAbout(authorizedRequest('quark-main'), quark)
  assert.equal(quark.statusCode, 200)
  assert.deepEqual(quark.body.quota, { total: 4096, used: 1024, free: 3072 })
  assert.deepEqual(quark.body.accountInfo, { nickname: 'Quark owner', memberType: 'SVIP' })
  assert.equal(calls.filter(call => call.url.hostname === 'open-api-drive.quark.cn').length, 2)
  assert.equal(JSON.stringify(quark.body).includes(quarkAuth.accessToken), false)
  assert.equal(JSON.stringify(quark.body).includes(quarkAuth.refreshToken), false)

  const cached = res()
  await storageAbout(authorizedRequest('quark-main'), cached)
  assert.equal(cached.body.cached, true)
  assert.equal(calls.filter(call => call.url.hostname === 'open-api-drive.quark.cn').length, 2, 'short quota cache avoids repeat upstream probes')
})
await test('legacy identity remains unchanged and new accounts have separate metadata', () => {
  assert.equal(metadataId('pikpak-main', 'same-id'), 'same-id')
  assert.notEqual(metadataId('quark-main', 'same-id'), metadataId('pikpak-two', 'same-id'))
  assert.notEqual(metadataId('quark-main', 'a:b'), metadataId('quark-main', 'b'))
})
await test('multiple PikPak instances route with individual credentials and generic reads preserve legacy output', async () => {
  await writeConfig({ version: 1, defaultStorageId: 'pikpak-two', instances: [
    { storageId: 'pikpak-main', provider: 'pikpak', displayName: 'PikPak', enabled: true },
    { storageId: 'pikpak-two', provider: 'pikpak', displayName: 'Second', enabled: true },
    { storageId: 'quark-main', provider: 'quark', displayName: 'Quark', enabled: true },
  ] })
  await writeAuth('pikpak-two', { accessToken: 'second-test-secret' })
  upstream = async () => ({ files: [{ id: 'same-id', name: 'test.txt', kind: 'drive#file', parent_id: '' }], next_page_token: '' })
  await setGlobalAccess('public')
  const target = res()
  await storageFiles({ method: 'GET', query: {}, headers: {} }, target)
  assert.equal(target.statusCode, 200)
  assert.equal(target.body.items[0].id, 'same-id')
  assert.equal(calls.at(-1).headers.Authorization, 'Bearer second-test-secret')
  const { provider } = await resolveStorage('pikpak-main')
  await provider.listFiles()
  assert.equal(calls.at(-1).headers.Authorization, 'Bearer primary-test-secret')
  const direct = createPikPakProvider({}, { accessToken: 'primary-test-secret' })
  await direct.rename({ id: 'same/id', name: 'new' }); assert.equal(calls.at(-1).method, 'PATCH'); assert.ok(calls.at(-1).url.pathname.endsWith('same%2Fid'))
  await direct.trash({ id: 'same-id' }); assert.deepEqual(JSON.parse(calls.at(-1).body), { ids: ['same-id'] })
  await direct.createUploadTicket({ name: 'a', size: '12', hash: 'hash' }); assert.equal(JSON.parse(calls.at(-1).body).upload_type, 'UPLOAD_TYPE_FORM')
})
await test('Quark official signature, root and cursor protocol, safe errors, unsupported writes', async () => {
  const h = quarkHeaders('POST', '/open/v1/file/list', 123)
  assert.equal(h['x-pan-token'], crypto.createHash('sha256').update(`POST&/open/v1/file/list&123&${OFFICIAL_SIGN_KEY}`).digest('hex'))
  const provider = createQuarkProvider({ storageId: 'quark-main' }, await readAuth('quark-main'))
  upstream = async () => ({ status: 0, data: { file_list: [{ fid: 'f', pdir_fid: '0', file_type: 0, file_name: 'Photos' }], last_page: false, next_query_cursor: { version: '1', token: 'next' } } })
  const listing = await provider.listFiles()
  assert.equal(JSON.parse(calls.at(-1).body).parent_fid, '0')
  assert.equal(listing.items[0].isFolder, true); assert.equal(listing.items[0].parentId, '')
  await provider.listFiles({ pageToken: listing.nextPageToken })
  assert.deepEqual(JSON.parse(calls.at(-1).body).query_cursor, { version: '1', token: 'next' })
  await assert.rejects(provider.listFiles({ pageToken: 'broken' }), /invalid_page_token/)
  assert.throws(() => provider.trash(), /storage_capability_unsupported:trash/)
  assert.throws(() => provider.createUploadTicket(), /storage_capability_unsupported:upload/)
  upstream = async () => ({ status: 1, agent_msg: 'sensitive account-access-secret' })
  await assert.rejects(provider.getQuota(), e => e.code === 'quark_request_failed' && !e.message.includes('secret'))
})
await test('Quark retries one transient read failure but never retries folder creation', async () => {
  const auth = { accessToken: 'retry-access', refreshToken: 'retry-refresh', deviceId: 'retry-device' }
  const provider = createQuarkProvider({ storageId: 'quark-main' }, auth)
  let listAttempts = 0
  calls.length = 0
  upstream = async url => {
    if (url.pathname.endsWith('/file/list') && listAttempts++ === 0) throw new TypeError('temporary network failure')
    return { status: 0, data: { file_list: [], last_page: true } }
  }
  const listing = await provider.listFiles()
  assert.deepEqual(listing.items, [])
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/file/list')).length, 2)

  calls.length = 0
  upstream = async () => { throw new TypeError('temporary network failure') }
  await assert.rejects(provider.createFolder({ name: 'retry-guard' }), error => error.code === 'quark_unreachable')
  assert.equal(calls.length, 1, 'write operations are never retried automatically')
})
await test('Quark account metadata, unknown quota, and thumbnail token redaction', async () => {
  const auth = { accessToken: 'quark-access-sensitive', refreshToken: 'quark-refresh-sensitive', deviceId: 'device' }
  await writeAuth('quark-main', auth)
  upstream = async url => {
    if (url.pathname.endsWith('/user/info')) return { status: 0, data: { user_id: 'user', nickname: '枫' } }
    if (url.pathname.endsWith('/user/get_vip_info')) return { status: 0, data: { vip_type: 'SVIP', capacity: '100000', used: '25000' } }
    if (url.pathname.endsWith('/file/list')) return { status: 0, data: { file_list: [
      { fid: 'photo', pdir_fid: '0', file_type: 2, file_name: 'photo.jpg', thumbnail_url: `https://thumb.quark.cn/photo?session=${auth.accessToken}` },
    ], last_page: true } }
    return { status: 0, data: {} }
  }
  const provider = createQuarkProvider({ storageId: 'quark-main' }, await readAuth('quark-main'))
  const [account, quota] = await Promise.all([provider.getAccountInfo(), provider.getQuota()])
  assert.deepEqual(account, { nickname: '枫', memberType: 'SVIP' })
  assert.deepEqual(quota, { total: 100000, used: 25000, free: 75000 })
  const listing = await provider.listFiles()
  assert.equal(listing.items[0].thumbnail, null)
  assert.equal(JSON.stringify(listing).includes(auth.accessToken), false)

  upstream = async url => url.pathname.endsWith('/user/get_vip_info')
    ? { status: 0, data: { vip_type: 'NORMAL' } }
    : { status: 0, data: { nickname: '枫' } }
  const providerWithoutQuota = createQuarkProvider({ storageId: 'quark-main' }, await readAuth('quark-main'))
  assert.equal(await providerWithoutQuota.getQuota(), null)
})
await test('RAW preview fields are detected without returning sensitive thumbnail URLs', async () => {
  const token = 'quark-preview-secret'
  const item = normalizeQuarkItem({
    fid: 'raw', pdir_fid: '0', file_type: 2, file_name: 'camera.dng', file_ext: 'dng',
    thumbnail_url: `https://thumb.quark.cn/raw.jpg?access_token=${token}`,
    preview: { image: { url: 'https://thumb.quark.cn/preview.webp?quality=high' } },
  }, [token])
  assert.equal(item.extension, 'dng')
  assert.equal(item.thumbnail, null, 'a URL with an account credential is not sent to the browser')
  assert.equal(item.thumbnailAvailable, true)
  assert.equal(item.previewAvailable, true)
  assert.equal(previewSourceUrl({ preview: { image: { url: 'https://thumb.quark.cn/preview.webp' } } }, 'preview'), 'https://thumb.quark.cn/preview.webp')
  assert.equal(safeBrowserPreviewUrl(`https://thumb.quark.cn/a?session=${token}`, [token]), null)
  assert.equal(safeBrowserPreviewUrl('https://thumb.quark.cn/a?signature=temporary', []), null)
  assert.equal(safeBrowserPreviewUrl('https://thumb.quark.cn/a?X-OSS-Credential=temporary', []), null)
  assert.equal(JSON.stringify(item).includes(token), false)
})
await test('Preview diagnostics record only safe field names, host, status, and content type', async () => {
  const originalInfo = console.info
  let output = ''
  console.info = value => { output += String(value) }
  try {
    const source = {
      thumbnail_url: 'https://dl-sz.open-drive.quark.cn/thumbnail?access_token=preview-secret',
      preview: { image: { url: 'https://dl-sz.open-drive.quark.cn/preview?signature=signed-secret' } },
      token_thumbnail: 'https://must-not-log.example/image?token=secret',
    }
    assert.deepEqual(previewSourceFieldNames(source), ['thumbnail_url', 'preview'])
    logPreviewDiagnostic({
      provider: 'quark', stage: 'upstream_response', variant: 'preview',
      fieldNames: ['thumbnail_url', 'preview', 'access_token_preview'],
      host: 'DL-SZ.OPEN-DRIVE.QUARK.CN', status: 200, contentType: 'IMAGE/JPEG',
      url: source.thumbnail_url, cookie: 'cookie-secret', accessToken: 'access-secret',
    })
  } finally {
    console.info = originalInfo
  }
  assert.match(output, /"host":"dl-sz\.open-drive\.quark\.cn"/)
  assert.match(output, /"status":200/)
  assert.match(output, /"contentType":"image\/jpeg"/)
  assert.match(output, /"fieldNames":\["thumbnail_url","preview"\]/)
  for (const secret of ['preview-secret', 'signed-secret', 'must-not-log', 'cookie-secret', 'access-secret', 'access_token_preview']) {
    assert.equal(output.includes(secret), false)
  }
})
await test('storage-preview streams a Quark thumbnail and never returns its token URL', async () => {
  const auth = { accessToken: 'preview-api-access-secret', refreshToken: 'preview-api-refresh-secret', deviceId: 'preview-device' }
  await writeConfig({ version: 1, defaultStorageId: 'quark-main', instances: [
    { storageId: 'quark-main', provider: 'quark', displayName: '夸克网盘', enabled: true },
  ] })
  await writeAuth('quark-main', auth)
  await setGlobalAccess('public')
  calls.length = 0
  const thumbnailUrl = `https://thumb.quark.cn/raw-thumbnail.jpg?access_token=${auth.accessToken}`
  upstream = async url => {
    if (url.hostname === 'thumb.quark.cn') {
      assert.equal(url.toString(), thumbnailUrl, 'the sensitive URL is used only inside the server-side provider call')
      return new Response(new Uint8Array([255, 216, 217]), { status: 200, headers: {
        'Content-Type': 'image/jpeg', 'Content-Length': '3', ETag: '"preview-v1"', 'Last-Modified': 'Thu, 01 Oct 2026 12:00:00 GMT',
      } })
    }
    if (url.pathname.endsWith('/file/list')) return { status: 0, data: { file_list: [
      { fid: 'raw-image', pdir_fid: '0', file_type: 2, file_name: 'camera.dng', file_ext: 'dng', thumbnail_url: thumbnailUrl },
    ], last_page: true } }
    if (url.pathname.endsWith('/file/info')) return { status: 0, data: { file_info: {
      fid: 'raw-image', pdir_fid: '0', file_type: 2, file_name: 'camera.dng', file_ext: 'dng', thumbnail_url: thumbnailUrl,
    } } }
    return { status: 0, data: {} }
  }
  const target = streamRes()
  const originalTimeout = AbortSignal.timeout
  const observedTimeouts = []
  AbortSignal.timeout = function (timeout) {
    observedTimeouts.push(timeout)
    return originalTimeout.call(this, timeout)
  }
  try {
    await storagePreview({ method: 'GET', query: { storageId: 'quark-main', id: 'raw-image', parentId: '', variant: 'preview' }, headers: {} }, target)
  } finally {
    AbortSignal.timeout = originalTimeout
  }
  assert.equal(target.statusCode, 200)
  assert.ok(observedTimeouts.includes(30000), 'Quark thumbnail requests have a bounded 30 second fetch deadline')
  assert.equal(target.headers['Content-Type'], 'image/jpeg')
  assert.equal(target.headers['Content-Length'], '3')
  assert.equal(target.headers.ETag, '"preview-v1"')
  assert.equal(target.headers['Last-Modified'], 'Thu, 01 Oct 2026 12:00:00 GMT')
  assert.match(target.headers['Cache-Control'], /private, max-age=60/)
  assert.equal(target.headers['X-Content-Type-Options'], 'nosniff')
  assert.deepEqual([...target.bytes()], [255, 216, 217])
  assert.equal(JSON.stringify(target.headers).includes(auth.accessToken), false)
  assert.equal(target.bytes().includes(Buffer.from(auth.accessToken)), fals…6291 tokens truncated…atusCode, 200)
  assert.equal(root.body.items[0].id, 'outer')
  const first = res()
  await storageFiles({ method: 'GET', query: { storageId: 'quark-main', parentId: 'outer' }, headers: {} }, first)
  assert.equal(first.statusCode, 200)
  assert.equal(first.body.items[0].id, 'inner')
  const second = res()
  await storageFiles({ method: 'GET', query: { storageId: 'quark-main', parentId: 'inner' }, headers: {} }, second)
  assert.equal(second.statusCode, 200)
  assert.equal(second.body.items[0].id, 'nested-file')
  assert.deepEqual(listParents, ['0', 'outer', 'inner'])

  const downloaded = res()
  await storageDownload({ method: 'GET', query: { storageId: 'quark-main', id: 'nested-file', parentId: 'inner' }, headers: {} }, downloaded)
  assert.equal(downloaded.statusCode, 302, JSON.stringify(downloaded.body))
  assert.equal(downloaded.headers.Location, 'https://download.example/nested-file')
  assert.equal(downloadLinkCalls.length, 1)

  const badParent = res()
  await storageDownload({ method: 'GET', query: { storageId: 'quark-main', id: 'nested-file', parentId: '0' }, headers: {} }, badParent)
  assert.equal(badParent.statusCode, 404, 'parent validation remains strict after root normalization')
  assert.equal(downloadLinkCalls.length, 1, 'a mismatched parent never requests a download URL')
})


await test('OAuth restart tolerates unreadable stored Quark credentials', async () => {
  await writeConfig({ version: 1, defaultStorageId: 'pikpak-main', instances: [
    { storageId: 'pikpak-main', provider: 'pikpak', displayName: 'PikPak', enabled: true },
    { storageId: 'quark-main', provider: 'quark', displayName: '夸克网盘', enabled: true },
  ] })
  redis.set('map7e-cloud:storage:auth:v1:quark-main', JSON.stringify({ version: 1, iv: 'bad', tag: 'bad', data: 'bad' }))
  upstream = async url => url.pathname.endsWith('/get_authorize_page_url') ? { status: 0, data: {
    authorize_page_url: 'https://pan.quark.cn/open/v1/oauth/agent?page_code=restart', page_code: 'restart', device_id: 'device',
  } } : { status: 0, data: {} }
  const adminCookie = `map7e_admin_session=${createAdminSessionToken().token}`
  const start = res()
  await quarkOAuth({ method: 'POST', body: { action: 'start', storageId: 'quark-main' }, headers: { cookie: adminCookie } }, start)
  assert.equal(start.statusCode, 200)
  assert.equal(start.body.authorizeUrl, 'https://pan.quark.cn/open/v1/oauth/agent?page_code=restart')
  redis.delete('map7e-cloud:storage:auth:v1:quark-main')
})

await test('secondary PikPak credentials can be validated and rotated through admin update', async () => {
  await writeConfig({ version: 1, defaultStorageId: 'pikpak-main', instances: [
    { storageId: 'pikpak-main', provider: 'pikpak', displayName: 'PikPak', enabled: true },
    { storageId: 'pikpak-two', provider: 'pikpak', displayName: 'Second', enabled: true },
    { storageId: 'quark-main', provider: 'quark', displayName: '夸克网盘', enabled: true },
  ] })
  await writeAuth('pikpak-two', { accessToken: 'old-secondary-token' })
  upstream = async url => url.pathname.endsWith('/about') ? { user: { name: 'Secondary' }, quota: { limit: 100, usage: 1 } } : { status: 0, data: {} }
  const adminCookie = `map7e_admin_session=${createAdminSessionToken().token}`
  const updated = res()
  await adminStorages({ method: 'POST', body: { action: 'update', storageId: 'pikpak-two', accessToken: 'new-secondary-token' }, headers: { cookie: adminCookie } }, updated)
  assert.equal(updated.statusCode, 200)
  assert.equal((await readAuth('pikpak-two')).accessToken, 'new-secondary-token')
  assert.equal(calls.at(-1).headers.Authorization, 'Bearer new-secondary-token')
})

await test('authorized Quark pagination returns the provider pacing delay', async () => {
  await writeConfig({ version: 1, defaultStorageId: 'quark-main', instances: [
    { storageId: 'pikpak-main', provider: 'pikpak', displayName: 'PikPak', enabled: true },
    { storageId: 'quark-main', provider: 'quark', displayName: '夸克网盘', enabled: true },
  ] })
  await writeAuth('quark-main', { accessToken: 'paged-access', refreshToken: 'paged-refresh', deviceId: 'device' })
  await setGlobalAccess('public')
  upstream = async url => url.pathname.endsWith('/file/list') ? {
    status: 0,
    metadata: { tq_gap: 120 },
    data: { file_list: [], last_page: false, next_query_cursor: { version: '1', token: 'next' } },
  } : { status: 0, data: {} }
  const target = res()
  await storageFiles({ method: 'GET', query: { storageId: 'quark-main' }, headers: {} }, target)
  assert.equal(target.statusCode, 200)
  assert.equal(target.body.nextRequestDelayMs, 120)
  assert.ok(target.body.nextPageToken)
})


await test('concurrent Quark providers wait for the winning token refresh instead of returning 409', async () => {
  await writeAuth('quark-main', { accessToken: 'shared-expired', refreshToken: 'shared-refresh', deviceId: 'device', accessExpiresAt: 1 })
  const initial = await readAuth('quark-main')
  const first = createQuarkProvider({ storageId: 'quark-main' }, { ...initial })
  const second = createQuarkProvider({ storageId: 'quark-main' }, { ...initial })
  let rotateCount = 0
  upstream = async url => {
    if (url.pathname.endsWith('/rotate')) {
      rotateCount += 1
      await new Promise(resolve => setTimeout(resolve, 80))
      return { status: 0, data: { access_token: 'shared-rotated', refresh_token: 'shared-refresh-2', expires_in: 7200 } }
    }
    if (url.pathname.endsWith('/user/get_vip_info')) return { status: 0, data: { capacity: '100', used: '25' } }
    return { status: 0, data: { nickname: 'test' } }
  }
  const [a, b] = await Promise.all([first.getQuota(), second.getQuota()])
  assert.deepEqual(a, { total: 100, used: 25, free: 75 })
  assert.deepEqual(b, { total: 100, used: 25, free: 75 })
  assert.equal(rotateCount, 1)
})

await test('adding a secondary PikPak instance validates its PAT before persistence', async () => {
  await writeConfig({ version: 1, defaultStorageId: 'pikpak-main', instances: [
    { storageId: 'pikpak-main', provider: 'pikpak', displayName: 'PikPak', enabled: true },
    { storageId: 'quark-main', provider: 'quark', displayName: '夸克网盘', enabled: true },
  ] })
  const adminCookie = `map7e_admin_session=${createAdminSessionToken().token}`
  upstream = async url => url.pathname.endsWith('/about')
    ? new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
    : { status: 0, data: {} }
  const rejected = res()
  await adminStorages({ method: 'POST', body: { action: 'add', storageId: 'pikpak-bad', provider: 'pikpak', displayName: 'Bad', accessToken: 'bad-token' }, headers: { cookie: adminCookie } }, rejected)
  assert.equal(rejected.statusCode, 401)
  assert.equal(await readAuth('pikpak-bad'), null)
  assert.equal((await readConfig()).instances.some(item => item.storageId === 'pikpak-bad'), false)

  upstream = async url => url.pathname.endsWith('/about') ? { user: { name: 'Good' }, quota: { limit: 100, usage: 1 } } : { status: 0, data: {} }
  const added = res()
  await adminStorages({ method: 'POST', body: { action: 'add', storageId: 'pikpak-good', provider: 'pikpak', displayName: 'Good', accessToken: 'good-token' }, headers: { cookie: adminCookie } }, added)
  assert.equal(added.statusCode, 200)
  assert.equal((await readAuth('pikpak-good')).accessToken, 'good-token')
  assert.equal((await readConfig()).instances.some(item => item.storageId === 'pikpak-good'), true)
})


await test('storage router preserves non-enumerable request headers for PikPak auth', async () => {
  await writeConfig({ version: 1, defaultStorageId: 'pikpak-main', instances: [
    { storageId: 'pikpak-main', provider: 'pikpak', displayName: 'PikPak', enabled: true },
    { storageId: 'quark-main', provider: 'quark', displayName: '夸克网盘', enabled: true },
  ] })
  await setGlobalAccess('locked')
  upstream = async () => ({ files: [], next_page_token: '' })
  const adminCookie = `map7e_admin_session=${createAdminSessionToken().token}`
  const request = { method: 'GET', query: {} }
  Object.defineProperty(request, 'headers', { value: { cookie: adminCookie }, enumerable: false })
  const target = res()
  await storageFiles(request, target)
  assert.equal(target.statusCode, 200)
  assert.deepEqual(target.body.items, [])
})


await test('storage write router preserves non-enumerable request headers for PikPak auth', async () => {
  await writeConfig({ version: 1, defaultStorageId: 'pikpak-main', instances: [
    { storageId: 'pikpak-main', provider: 'pikpak', displayName: 'PikPak', enabled: true },
    { storageId: 'quark-main', provider: 'quark', displayName: '夸克网盘', enabled: true },
  ] })
  await setGlobalAccess('locked')
  const adminCookie = `map7e_admin_session=${createAdminSessionToken().token}`
  upstream = async url => url.pathname.endsWith('/drive/v1/files')
    ? { file: { id: 'created-folder', parent_id: '', name: 'Created', kind: 'drive#folder' } }
    : { status: 0, data: {} }
  const request = { method: 'POST', query: {}, body: { name: 'Created', parentId: '' } }
  Object.defineProperty(request, 'headers', { value: { cookie: adminCookie }, enumerable: false })
  const target = res()
  await storageWrite('createFolder')(request, target)
  assert.equal(target.statusCode, 200)
  assert.equal(target.body.item.id, 'created-folder')
})

await test('storage download router preserves non-enumerable request headers for PikPak auth', async () => {
  await writeConfig({ version: 1, defaultStorageId: 'pikpak-main', instances: [
    { storageId: 'pikpak-main', provider: 'pikpak', displayName: 'PikPak', enabled: true },
    { storageId: 'quark-main', provider: 'quark', displayName: '夸克网盘', enabled: true },
  ] })
  await setGlobalAccess('locked')
  const adminCookie = `map7e_admin_session=${createAdminSessionToken().token}`
  upstream = async url => url.pathname.endsWith('/drive/v1/files/file-1')
    ? { id: 'file-1', parent_id: '', kind: 'drive#file', links: { 'application/octet-stream': { url: 'https://download.test/file-1' } } }
    : { status: 0, data: {} }
  const request = { method: 'GET', query: { id: 'file-1', parentId: '' } }
  Object.defineProperty(request, 'headers', { value: { cookie: adminCookie }, enumerable: false })
  const target = { ...res(), end() { this.ended = true; return this } }
  await storageDownload(request, target)
  assert.equal(target.statusCode, 302)
  assert.equal(target.headers.Location, 'https://download.test/file-1')
  assert.equal(target.ended, true)
})

await test('Storage config and auth reads are coalesced and writes invalidate their short cache', async () => {
  clearStorageCachesForTests()
  const configKey = 'map7e-cloud:storage:config:v1:'
  const authKey = 'map7e-cloud:storage:auth:v1:quark-main'
  redisReads.delete(configKey)
  redisReads.delete(authKey)
  const [configA, configB] = await Promise.all([readConfig(), readConfig()])
  assert.deepEqual(configA, configB)
  assert.equal(redisReads.get(configKey), 1, 'parallel config reads share one Upstash GET')

  await writeAuth('quark-main', { accessToken: 'cache-access-1', refreshToken: 'cache-refresh-1', deviceId: 'cache-device' })
  redisReads.delete(authKey)
  const [authA, authB] = await Promise.all([readAuth('quark-main'), readAuth('quark-main')])
  assert.deepEqual(authA, authB)
  assert.equal(redisReads.get(authKey), 1, 'parallel auth reads share one Upstash GET')

  await writeConfig({ ...configA, defaultStorageId: 'pikpak-main' })
  redisReads.delete(configKey)
  await readConfig()
  assert.equal(redisReads.get(configKey), 1, 'writing config invalidates the cached value')
  await writeAuth('quark-main', { accessToken: 'cache-access-2', refreshToken: 'cache-refresh-2', deviceId: 'cache-device' })
  redisReads.delete(authKey)
  assert.equal((await readAuth('quark-main')).accessToken, 'cache-access-2')
  assert.equal(redisReads.get(authKey), 1, 'writing credentials invalidates the cached value')
})

await test('Quark website root maps to one folder and blocks out-of-tree reads and writes', async () => {
  await writeConfig({ version: 1, defaultStorageId: 'quark-main', instances: [
    { storageId: 'pikpak-main', provider: 'pikpak', displayName: 'PikPak', enabled: true },
    { storageId: 'quark-main', provider: 'quark', displayName: 'Quark', enabled: true, rootFolderId: 'map-root', rootFolderName: 'Map7e' },
  ] })
  await writeAuth('quark-main', { accessToken: 'root-access', refreshToken: 'root-refresh', userId: 'root-user', deviceId: 'root-device' })
  await setGlobalAccess('public')
  const listParents = [], createdParents = [], downloadRequests = []
  upstream = async (url, options = {}) => {
    if (url.pathname.endsWith('/file/list')) {
      const body = JSON.parse(options.body)
      listParents.push(body.parent_fid)
      return { status: 0, data: { file_list: [{ fid: 'photos', pdir_fid: 'map-root', file_type: 0, file_name: '图片' }], last_page: true } }
    }
    if (url.pathname.endsWith('/file/info')) {
      const id = url.searchParams.get('fid')
      const items = {
        'map-root': { fid: 'map-root', pdir_fid: 'outside-parent', file_type: 0, file_name: 'Map7e' },
        outside: { fid: 'outside', pdir_fid: '0', file_type: 0, file_name: 'Backup' },
        'outside-file': { fid: 'outside-file', pdir_fid: 'outside', file_type: 2, file_name: 'secret.txt' },
      }
      return items[id] ? { status: 0, data: items[id] } : { status: 1, error_info: 'missing' }
    }
    if (url.pathname.endsWith('/file/get_download_url')) { downloadRequests.push(url.pathname); return { status: 0, data: { download_url: 'https://download.example/secret.txt' } } }
    if (url.pathname.endsWith('/dir')) {
      createdParents.push(JSON.parse(options.body).pdir_fid)
      return { status: 0, data: { fid: 'created-at-root' } }
    }
    return { status: 0, data: {} }
  }

  const rootListing = res()
  await storageFiles({ method: 'GET', query: { storageId: 'quark-main' }, headers: {} }, rootListing)
  assert.equal(rootListing.statusCode, 200)
  assert.equal(rootListing.body.storageId, 'quark-main')
  assert.equal(rootListing.body.parentId, null, 'the configured folder appears as virtual /')
  assert.deepEqual(listParents, ['map-root'], 'Quark lists only the selected root')

  const escapedListing = res()
  await storageFiles({ method: 'GET', query: { storageId: 'quark-main', parentId: 'outside' }, headers: {} }, escapedListing)
  assert.equal(escapedListing.statusCode, 404)
  assert.deepEqual(listParents, ['map-root'], 'an outside folder never reaches the list endpoint')

  const escapedDownload = res()
  await storageDownload({ method: 'GET', query: { storageId: 'quark-main', id: 'outside-file', parentId: 'outside' }, headers: {} }, escapedDownload)
  assert.equal(escapedDownload.statusCode, 404)
  assert.equal(escapedDownload.headers.Location, undefined)
  assert.deepEqual(downloadRequests, [], 'an outside file never receives a download URL')

  const adminCookie = `map7e_admin_session=${createAdminSessionToken().token}`
  const createAtVirtualRoot = res()
  await storageWrite('createFolder')({ method: 'POST', query: {}, body: { storageId: 'quark-main', name: 'New folder', parentId: '' }, headers: { cookie: adminCookie } }, createAtVirtualRoot)
  assert.equal(createAtVirtualRoot.statusCode, 200)
  assert.deepEqual(createdParents, ['map-root'], 'creating at / writes inside the selected root')

  const createOutside = res()
  await storageWrite('createFolder')({ method: 'POST', query: {}, body: { storageId: 'quark-main', name: 'Bad folder', parentId: 'outside' }, headers: { cookie: adminCookie } }, createOutside)
  assert.equal(createOutside.statusCode, 404)
  assert.deepEqual(createdParents, ['map-root'], 'an outside parent never reaches Quark create')

  await writeConfig({ version: 1, defaultStorageId: 'quark-main', instances: [
    { storageId: 'pikpak-main', provider: 'pikpak', displayName: 'PikPak', enabled: true },
    { storageId: 'quark-main', provider: 'quark', displayName: 'Quark', enabled: true },
  ] })
  listParents.length = 0
  const wholeDrive = res()
  await storageFiles({ method: 'GET', query: { storageId: 'quark-main' }, headers: {} }, wholeDrive)
  assert.equal(wholeDrive.statusCode, 200)
  assert.equal(wholeDrive.body.parentId, null)
  assert.deepEqual(listParents, ['0'], 'null root configuration preserves whole-drive mode')

  process.env.ADMIN_PASSWORD = 'root-picker-admin-password'
  const rootSelectionAdminCookie = `map7e_admin_session=${createAdminSessionToken().token}`
  const selectedRoot = res()
  await adminStorages({ method: 'POST', body: { action: 'set-root-folder', storageId: 'quark-main', rootFolderId: 'map-root' }, headers: { cookie: rootSelectionAdminCookie } }, selectedRoot)
  assert.equal(selectedRoot.statusCode, 200)
  assert.equal(selectedRoot.body.providers.find((provider) => provider.id === 'quark-main').rootFolderId, 'map-root')
  assert.equal(selectedRoot.body.providers.find((provider) => provider.id === 'quark-main').rootFolderName, 'Map7e')
})

await test('PikPak scoped root preserves create and rename inside the tree and rejects outside parents', async () => {
  await writeConfig({ version: 1, defaultStorageId: 'pikpak-main', instances: [
    { storageId: 'pikpak-main', provider: 'pikpak', displayName: 'PikPak', enabled: true, rootFolderId: 'map-root' },
    { storageId: 'quark-main', provider: 'quark', displayName: 'Quark', enabled: true },
  ] })
  const adminCookie = `map7e_admin_session=${createAdminSessionToken().token}`
  const writes = []
  upstream = async (url, options = {}) => {
    const id = decodeURIComponent(url.pathname.split('/').pop())
    if (options.method === 'POST' && url.pathname.endsWith('/drive/v1/files')) {
      const body = JSON.parse(options.body)
      writes.push(['create', body.parent_id])
      return { file: { id: 'inside-created', name: body.name, parent_id: body.parent_id, kind: 'drive#folder' } }
    }
    if (options.method === 'PATCH') {
      writes.push(['rename', id])
      return { id, name: JSON.parse(options.body).name, parent_id: 'map-root', kind: 'drive#file' }
    }
    const items = {
      'map-root': { id: 'map-root', name: 'Map7e', parent_id: '', kind: 'drive#folder', writable: true },
      outside: { id: 'outside', name: 'Backup', parent_id: '', kind: 'drive#folder', writable: true },
      'inside-file': { id: 'inside-file', name: 'old.txt', parent_id: 'map-root', kind: 'drive#file', writable: true },
      'outside-file': { id: 'outside-file', name: 'old.txt', parent_id: 'outside', kind: 'drive#file', writable: true },
    }
    return items[id] || { error: 'not found' }
  }

  const create = res()
  await storageWrite('createFolder')({ method: 'POST', query: {}, body: { name: 'New folder', parentId: '' }, headers: { cookie: adminCookie } }, create)
  assert.equal(create.statusCode, 200)
  assert.deepEqual(writes, [['create', 'map-root']], 'empty parent maps to the configured PikPak root')

  const outsideCreate = res()
  await storageWrite('createFolder')({ method: 'POST', query: {}, body: { name: 'Outside', parentId: 'outside' }, headers: { cookie: adminCookie } }, outsideCreate)
  assert.equal(outsideCreate.statusCode, 404)
  assert.deepEqual(writes, [['create', 'map-root']])

  const outsideRename = res()
  await storageWrite('rename')({ method: 'POST', query: {}, body: { id: 'outside-file', parentId: 'outside', name: 'renamed.txt' }, headers: { cookie: adminCookie } }, outsideRename)
  assert.equal(outsideRename.statusCode, 404)
  assert.deepEqual(writes, [['create', 'map-root']])

  const insideRename = res()
  await storageWrite('rename')({ method: 'POST', query: {}, body: { id: 'inside-file', parentId: 'map-root', name: 'renamed.txt' }, headers: { cookie: adminCookie } }, insideRename)
  assert.equal(insideRename.statusCode, 200)
  assert.deepEqual(writes, [['create', 'map-root'], ['rename', 'inside-file']])
})
