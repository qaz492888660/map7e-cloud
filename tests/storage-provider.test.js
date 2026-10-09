import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { seal, unseal, metadataId, writeAuth, readAuth, readConfig, writeConfig, withLock, clearStorageCachesForTests } from '../lib/storage/store.js'
import { storageDescriptors, resolveStorage } from '../lib/storage/registry.js'
import storageProviders from '../lib/api-handlers/storage-providers.js'
import storageAbout, { clearStorageAboutCacheForTests } from '../lib/api-handlers/storage-about.js'
import { safeDirectUrl } from '../lib/storage/errors.js'
import { attachPreviewLinks, logPreviewDiagnostic, previewSourceFieldNames, previewSourceUrl, safeBrowserPreviewUrl } from '../lib/storage/previews.js'
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
import { verifyMediaTicket } from '../lib/storage/media-ticket.js'

const MEDIA_TEST_SECRET = 'map7e-media-gateway-test-signing-secret-at-least-32-bytes'
process.env.PIKPAK_PAT = 'primary-test-secret'
process.env.STORAGE_ENCRYPTION_KEY = 'test-encryption-key'
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test'
process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-test-secret'
process.env.VERCEL_ENV = 'production'
process.env.MEDIA_GATEWAY_URL = 'https://media.map7e.com'
process.env.MEDIA_GATEWAY_SIGNING_SECRET = MEDIA_TEST_SECRET
process.env.MEDIA_GATEWAY_SITE_DOMAIN = 'map7e.com'
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
function mediaClaimsFromResponse(target) {
  const location = new URL(target.headers.Location)
  return verifyMediaTicket(location.searchParams.get('ticket'), MEDIA_TEST_SECRET)
}
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
function mockQuarkHttps(getResponse) {
  const originalRequest = https.request
  const requests = []
  https.request = (url, options, callback) => {
    const request = new EventEmitter()
    request.destroy = error => { if (error) queueMicrotask(() => request.emit('error', error)); return request }
    request.end = () => {
      const parsed = new URL(url)
      options.lookup(parsed.hostname, { family: 4 }, (error, address) => {
        if (error) { request.emit('error', error); return }
        requests.push({ url: parsed, headers: options.headers, address })
        Promise.resolve(getResponse(parsed, options.headers)).then(upstreamResponse => {
          const incoming = upstreamResponse.body ? Readable.fromWeb(upstreamResponse.body) : Readable.from([])
          incoming.statusCode = upstreamResponse.status
          incoming.headers = Object.fromEntries(upstreamResponse.headers.entries())
          let closed = false
          const closeRequest = () => { if (!closed) { closed = true; request.emit('close') } }
          incoming.once('end', closeRequest)
          incoming.once('close', closeRequest)
          callback(incoming)
        }, error => request.emit('error', error))
      })
      return request
    }
    return request
  }
  return { requests, restore() { https.request = originalRequest } }
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
await test('Quark listing thumbnail URLs stay server-side even without signed query fields', () => {
  const item = normalizeQuarkItem({
    fid: 'photo', pdir_fid: '0', file_type: 2, file_name: 'photo.jpg', file_ext: 'jpg',
    thumbnail_url: 'https://thumb.quark.cn/photo.jpg?quality=small',
  })
  assert.equal(item.thumbnail, null)
  assert.equal(item.thumbnailAvailable, true)
  const linked = attachPreviewLinks(item, 'quark-main')
  assert.match(linked.thumbnail, /^\/api\/storage-preview\?/)
  assert.equal(linked.thumbnail.includes('thumb.quark.cn'), false)
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
await test('Quark preview uses a signed Gateway ticket and the server sends official media credentials', async () => {
  const auth = { accessToken: 'preview-api-access-secret', refreshToken: 'preview-api-refresh-secret', deviceId: 'preview-device' }
  await writeConfig({ version: 1, defaultStorageId: 'quark-main', instances: [
    { storageId: 'quark-main', provider: 'quark', displayName: '夸克网盘', enabled: true },
  ] })
  await writeAuth('quark-main', auth)
  await setGlobalAccess('public')
  calls.length = 0
  const thumbnailUrl = `https://thumb.quark.cn/raw-thumbnail.jpg?access_token=${auth.accessToken}`
  upstream = async (url, options = {}) => {
    if (url.hostname === 'thumb.quark.cn') {
      assert.equal(url.toString(), thumbnailUrl, 'the sensitive URL is used only inside the server-side provider call')
      assert.equal(options.headers.Origin, 'https://pan.quark.cn')
      assert.equal(options.headers.Referer, 'https://pan.quark.cn/')
      assert.match(options.headers['User-Agent'], /^Mozilla\/5\.0 /)
      assert.equal(options.headers['Sec-Fetch-Dest'], 'image')
      assert.equal(options.headers['Sec-Fetch-Mode'], 'no-cors')
      assert.equal(options.headers['Sec-Fetch-Site'], 'same-site')
      assert.equal(options.headers['Accept-Language'], 'zh-CN,zh;q=0.9,en;q=0.8')
      assert.equal(options.headers.Cookie, `x_pan_client_id=third_party_agent;x_pan_access_token=${auth.accessToken}`)
      assert.equal(options.headers.Authorization, undefined)
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
  const provider = createQuarkProvider({ storageId: 'quark-main', provider: 'quark' }, await readAuth('quark-main'), {
    fetchCdn: (url, options) => upstream(new URL(url), options),
  })
  const originalLookup = dns.lookup
  dns.lookup = async () => [{ address: '1.1.1.1', family: 4 }]
  try {
    const quarkPreview = await provider.getPreview('raw-image')
    assert.equal(quarkPreview.status, 200)
    assert.deepEqual([...new Uint8Array(await quarkPreview.arrayBuffer())], [255, 216, 217])
  } finally {
    dns.lookup = originalLookup
  }

  const target = res()
  await storagePreview({ method: 'GET', query: { storageId: 'quark-main', id: 'raw-image', parentId: '', variant: 'preview' }, headers: {} }, target)
  assert.equal(target.statusCode, 302)
  assert.equal(target.headers['Cache-Control'], 'private, no-store')
  assert.equal(target.headers['Referrer-Policy'], 'no-referrer')
  assert.equal(new URL(target.headers.Location).origin, 'https://media.map7e.com')
  const claims = mediaClaimsFromResponse(target)
  assert.deepEqual({ storageId: claims.storageId, fileId: claims.fileId, parentId: claims.parentId, purpose: claims.purpose, variant: claims.variant }, {
    storageId: 'quark-main', fileId: 'raw-image', parentId: '', purpose: 'preview', variant: 'preview',
  })
  assert.equal(JSON.stringify(target.headers).includes(auth.accessToken), false)
  assert.equal(target.headers.Location.includes('thumb.quark.cn'), false)

  const listing = res()
  await storageFiles({ method: 'GET', query: { storageId: 'quark-main' }, headers: {} }, listing)
  assert.equal(listing.statusCode, 200, JSON.stringify(listing.body))
  assert.ok(listing.body.items[0].thumbnail.startsWith('/api/storage-preview?'))
  assert.equal(listing.body.items[0].previewAvailable, true)
  assert.equal(JSON.stringify(listing.body).includes(auth.accessToken), false)
})
await test('Quark .ts and .mts only use video tickets when MIME is absent or video-compatible', async () => {
  await writeConfig({ version: 1, defaultStorageId: 'quark-main', instances: [
    { storageId: 'quark-main', provider: 'quark', displayName: 'Quark', enabled: true },
  ] })
  await writeAuth('quark-main', { accessToken: 'mime-access', refreshToken: 'mime-refresh', deviceId: 'mime-device' })
  await setGlobalAccess('public')
  upstream = async url => {
    if (url.pathname.endsWith('/file/info')) {
      const id = url.searchParams.get('fid')
      const files = {
        'source-ts': { fid: 'source-ts', pdir_fid: '0', file_type: 1, file_name: 'source.ts', file_ext: 'ts', mime_type: 'text/typescript' },
        'video-ts': { fid: 'video-ts', pdir_fid: '0', file_type: 1, file_name: 'clip.ts', file_ext: 'ts', mime_type: 'video/mp2t' },
        'unknown-mts': { fid: 'unknown-mts', pdir_fid: '0', file_type: 1, file_name: 'clip.mts', file_ext: 'mts', mime_type: '' },
      }
      return { status: 0, data: files[id] }
    }
    return { status: 0, data: {} }
  }

  const source = res()
  await storageDownload({ method: 'GET', query: { storageId: 'quark-main', id: 'source-ts', parentId: '' }, headers: {} }, source)
  assert.equal(source.statusCode, 302)
  assert.equal(mediaClaimsFromResponse(source).purpose, 'original')

  const video = res()
  await storageDownload({ method: 'GET', query: { storageId: 'quark-main', id: 'video-ts', parentId: '' }, headers: {} }, video)
  assert.equal(video.statusCode, 302)
  assert.equal(mediaClaimsFromResponse(video).purpose, 'video')

  const unknown = res()
  await storageDownload({ method: 'GET', query: { storageId: 'quark-main', id: 'unknown-mts', parentId: '' }, headers: {} }, unknown)
  assert.equal(unknown.statusCode, 302)
  assert.equal(mediaClaimsFromResponse(unknown).purpose, 'video')
})

await test('PikPak RAW thumbnails use the same credential-safe Preview API', async () => {
  const auth = { accessToken: 'pikpak-preview-account-secret' }
  const sourceUrl = `https://thumb.mypikpak.com/raw.webp?token=${auth.accessToken}`
  await writeConfig({ version: 1, defaultStorageId: 'pikpak-main', instances: [
    { storageId: 'pikpak-main', provider: 'pikpak', displayName: 'PikPak', enabled: true },
    { storageId: 'pikpak-two', provider: 'pikpak', displayName: 'PikPak secondary', enabled: true },
  ] })
  await writeAuth('pikpak-two', auth)
  await setGlobalAccess('public')
  let thumbnailRequest
  upstream = async (url, options = {}) => {
    if (url.hostname === 'thumb.mypikpak.com') {
      thumbnailRequest = options
      assert.equal(url.toString(), sourceUrl)
      return new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'Content-Type': 'image/webp', 'Content-Length': '2' } })
    }
    if (url.hostname === 'api-drive.mypikpak.com') return {
      id: 'pikpak-raw', parent_id: '', kind: 'drive#file', name: 'camera.dng', file_extension: 'dng', thumbnail_link: sourceUrl,
    }
    return { status: 0, data: {} }
  }
  const target = streamRes()
  await storagePreview({ method: 'GET', query: { storageId: 'pikpak-two', id: 'pikpak-raw', parentId: '', variant: 'preview' }, headers: {} }, target)
  assert.equal(target.statusCode, 200)
  assert.equal(target.headers['Content-Type'], 'image/webp')
  assert.deepEqual([...target.bytes()], [1, 2])
  assert.equal(thumbnailRequest.headers.Authorization, undefined)
  assert.equal(thumbnailRequest.headers.Cookie, undefined)
  assert.equal(JSON.stringify(target.headers).includes(auth.accessToken), false)
})
await test('storage-preview permission checks and storageId-scoped same-id previews stay isolated', async () => {
  const firstAuth = { accessToken: 'first-storage-preview-token', refreshToken: 'first-refresh', deviceId: 'first-device' }
  const secondAuth = { accessToken: 'second-storage-preview-token', refreshToken: 'second-refresh', deviceId: 'second-device' }
  await writeConfig({ version: 1, defaultStorageId: 'quark-main', instances: [
    { storageId: 'quark-main', provider: 'quark', displayName: 'Quark A', enabled: true },
    { storageId: 'quark-secondary', provider: 'quark', displayName: 'Quark B', enabled: true },
  ] })
  await writeAuth('quark-main', firstAuth)
  await writeAuth('quark-secondary', secondAuth)
  await setGlobalAccess('public')
  calls.length = 0
  upstream = async url => {
    if (url.hostname === 'thumb.quark.cn') {
      const isSecond = url.pathname.startsWith('/quark-secondary/')
      return new Response(new Uint8Array([isSecond ? 2 : 1]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
    }
    if (url.pathname.endsWith('/file/info')) {
      const isSecond = url.searchParams.get('access_token') === secondAuth.accessToken
      const storage = isSecond ? 'quark-secondary' : 'quark-main'
      return { status: 0, data: { file_info: {
        fid: 'same-id', pdir_fid: '0', file_type: 2, file_name: 'same.dng', file_ext: 'dng',
        thumbnail_url: `https://thumb.quark.cn/${storage}/same.jpg?temporary-preview=opaque`,
      } } }
    }
    return { status: 0, data: {} }
  }

  const forbidden = res()
  const oldPassword = process.env.CLOUD_PASSWORD
  process.env.CLOUD_PASSWORD = 'preview-access-password'
  await setFileMetadata(metadataId('quark-main', 'same-id'), { access: 'locked' })
  await storagePreview({ method: 'GET', query: { storageId: 'quark-main', id: 'same-id', parentId: '', variant: 'preview' }, headers: {} }, forbidden)
  assert.equal(forbidden.statusCode, 401)
  assert.equal(forbidden.body.error, 'authentication_required')
  assert.equal(forbidden.headers.Location, undefined, 'locked content cannot issue a media ticket')
  assert.equal(calls.some(call => call.url.hostname === 'thumb.quark.cn'), false, 'locked preview data is not fetched before authorization')
  if (oldPassword === undefined) delete process.env.CLOUD_PASSWORD
  else process.env.CLOUD_PASSWORD = oldPassword
  await setFileMetadata(metadataId('quark-main', 'same-id'), { access: 'inherit' })

  const gatewayUrl = process.env.MEDIA_GATEWAY_URL
  delete process.env.MEDIA_GATEWAY_URL
  const unavailable = res()
  await storagePreview({ method: 'GET', query: { storageId: 'quark-main', id: 'same-id', parentId: '', variant: 'preview' }, headers: {} }, unavailable)
  assert.equal(unavailable.statusCode, 503)
  assert.equal(unavailable.body.error, 'media_gateway_not_configured')
  process.env.MEDIA_GATEWAY_URL = gatewayUrl

  const signingSecret = process.env.MEDIA_GATEWAY_SIGNING_SECRET
  delete process.env.MEDIA_GATEWAY_SIGNING_SECRET
  const downloadUnavailable = res()
  await storageDownload({ method: 'GET', query: { storageId: 'quark-main', id: 'same-id', parentId: '' }, headers: {} }, downloadUnavailable)
  assert.equal(downloadUnavailable.statusCode, 503)
  assert.equal(downloadUnavailable.body.error, 'media_gateway_not_configured')
  process.env.MEDIA_GATEWAY_SIGNING_SECRET = signingSecret

  const target = streamRes()
  await storagePreview({ method: 'GET', query: { storageId: 'quark-secondary', id: 'same-id', parentId: '', variant: 'preview' }, headers: {} }, target)
  assert.equal(target.statusCode, 302)
  assert.equal(mediaClaimsFromResponse(target).storageId, 'quark-secondary', 'the same file ID resolves through the selected Storage only')
  assert.equal(mediaClaimsFromResponse(target).fileId, 'same-id')
  assert.equal(JSON.stringify(target.headers).includes(secondAuth.accessToken), false)
  assert.equal(JSON.stringify(target.headers).includes(firstAuth.accessToken), false)
})
await test('Range contract stops before the gateway if the response closed during permission checks', async () => {
  await writeConfig({ version: 1, defaultStorageId: 'quark-main', instances: [
    { storageId: 'quark-main', provider: 'quark', displayName: '夸克网盘', enabled: true },
  ] })
  await writeAuth('quark-main', { accessToken: 'cancel-probe-access', refreshToken: 'cancel-probe-refresh', deviceId: 'cancel-probe-device' })
  await setGlobalAccess('public')
  const request = Object.assign(new EventEmitter(), { method: 'GET', headers: {},
    query: { storageId: 'quark-main', id: 'cancelled-video', parentId: '', check: 'range' } })
  const target = Object.assign(new EventEmitter(), res())
  let gatewayRequests = 0
  upstream = async url => {
    if (url.hostname === 'media.map7e.com') { gatewayRequests += 1; throw new Error('should not reach Worker') }
    if (url.pathname.endsWith('/file/info')) {
      target.destroyed = true
      target.emit('close')
      return { status: 0, data: { file_info: { fid: 'cancelled-video', pdir_fid: '0', file_type: 2, file_name: 'sample.mp4' } } }
    }
    return { status: 0, data: {} }
  }
  await storageDownload(request, target)
  assert.equal(target.statusCode, 499, JSON.stringify(target.body))
  assert.equal(target.body.error, 'storage_range_probe_cancelled')
  assert.equal(gatewayRequests, 0)
  assert.equal(target.listenerCount('close'), 0)
  assert.equal(request.listenerCount('aborted'), 0)
})

await test('video Range check reports actual upstream headers without moving file bytes through Vercel', async () => {
  const auth = { accessToken: 'range-check-access', refreshToken: 'range-check-refresh', deviceId: 'range-device' }
  const directUrl = 'https://video.quark.cn/large.mp4?temporary_signature=range-secret'
  await writeConfig({ version: 1, defaultStorageId: 'quark-main', instances: [
    { storageId: 'quark-main', provider: 'quark', displayName: '夸克网盘', enabled: true },
  ] })
  await writeAuth('quark-main', auth)
  await setGlobalAccess('public')
  calls.length = 0
  const gatewayRangeRequests = []
  upstream = async (url, options = {}) => {
    if (url.hostname === 'media.map7e.com') {
      gatewayRangeRequests.push({ url, options })
      return new Response(null, { status: 206, headers: {
        'Accept-Ranges': 'bytes', 'Content-Range': 'bytes 0-0/32212254720', 'Content-Length': '1', 'Content-Type': 'video/mp4', ETag: '"range-etag"',
      } })
    }
    if (url.hostname === 'video.quark.cn') {
      const range = options.headers?.Range || 'bytes=0-0'
      const contentRange = range === 'bytes=0-0' ? 'bytes 0-0/32212254720' : 'bytes 1024-2047/32212254720'
      return new Response(new Uint8Array([0]), { status: 206, headers: {
        'Accept-Ranges': 'bytes', 'Content-Range': contentRange, 'Content-Length': range === 'bytes=0-0' ? '1' : '1024', 'Content-Type': 'video/mp4', ETag: '"range-etag"',
      } })
    }
    if (url.pathname.endsWith('/file/info')) return { status: 0, data: { file_info: { fid: 'large-video', pdir_fid: '0', file_type: 2, file_name: 'large.mp4' } } }
    if (url.pathname.endsWith('/file/get_download_url')) return { status: 0, data: { download_url: directUrl } }
    return { status: 0, data: {} }
  }
  const originalLookup = dns.lookup
  dns.lookup = async () => [{ address: '1.1.1.1', family: 4 }]
  const httpsMock = mockQuarkHttps((url, headers) => upstream(url, { headers }))
  try {
  const check = res()
  await storageDownload({ method: 'GET', query: { storageId: 'quark-main', id: 'large-video', parentId: '', check: 'range' }, headers: {} }, check)
  assert.equal(check.statusCode, 200)
  assert.equal(check.body.rangeSupported, true)
  assert.equal(check.body.status, 206)
  assert.equal(check.body.acceptRanges, 'bytes')
  assert.equal(check.body.contentRange, 'bytes 0-0/32212254720')
  assert.equal(check.body.contentType, 'video/mp4')
  assert.equal(check.body.contentLength, 1)
  assert.equal(check.body.totalLength, 32212254720)
  assert.equal(JSON.stringify(check.body).includes('video.quark.cn'), false)
  assert.equal(JSON.stringify(check.body).includes('range-secret'), false)
  assert.equal(gatewayRangeRequests.length, 1)
  assert.equal(gatewayRangeRequests[0].options.method, 'HEAD')
  assert.equal(gatewayRangeRequests[0].options.headers.Range, 'bytes=0-0')
  assert.equal(gatewayRangeRequests[0].options.redirect, 'manual')
  assert.equal(gatewayRangeRequests[0].url.searchParams.get('ticket') !== null, true)
  assert.equal(gatewayRangeRequests[0].url.searchParams.get('url'), null)
  assert.equal(httpsMock.requests.some(call => call.url.hostname === 'video.quark.cn'), false, 'the Quark media body is requested by the Gateway rather than Vercel')

  const provider = createQuarkProvider({ storageId: 'quark-main', provider: 'quark' }, await readAuth('quark-main'))
  const middle = await provider.getFileResponse('large-video', { range: 'bytes=1024-2047' })
  assert.equal(middle.status, 206)
  assert.equal(middle.headers.get('content-range'), 'bytes 1024-2047/32212254720')
  const mediaCall = httpsMock.requests.filter(call => call.url.hostname === 'video.quark.cn').at(-1)
  assert.equal(mediaCall.headers.Range, 'bytes=1024-2047')
  assert.equal(mediaCall.headers.Cookie, `x_pan_client_id=third_party_agent;x_pan_access_token=${auth.accessToken}`)
  await middle.body.cancel()

  const download = res()
  await storageDownload({ method: 'GET', query: { storageId: 'quark-main', id: 'large-video', parentId: '' }, headers: {} }, download)
  assert.equal(download.statusCode, 302)
  const claims = mediaClaimsFromResponse(download)
  assert.equal(claims.purpose, 'video')
  assert.equal(claims.storageId, 'quark-main')
  assert.equal(claims.fileId, 'large-video')
  assert.equal(claims.disposition, 'attachment')
  assert.equal(download.headers.Location.includes('video.quark.cn'), false)
  assert.equal(download.headers.Location.includes('range-secret'), false)
  assert.equal(download.body, undefined, 'the video body remains on the Provider CDN')

  const inlinePreview = res()
  await storageDownload({ method: 'GET', query: { storageId: 'quark-main', id: 'large-video', parentId: '', inline: '1' }, headers: {} }, inlinePreview)
  assert.equal(inlinePreview.statusCode, 302)
  assert.equal(mediaClaimsFromResponse(inlinePreview).disposition, 'inline')
  } finally {
    httpsMock.restore()
    dns.lookup = originalLookup
  }
})
await test('Vercel preserves a Gateway size-policy error from a bodyless HEAD probe', async () => {
  await writeConfig({ version: 1, defaultStorageId: 'quark-main', instances: [
    { storageId: 'quark-main', provider: 'quark', displayName: '夸克网盘', enabled: true },
  ] })
  await writeAuth('quark-main', { accessToken: 'size-limit-access', refreshToken: 'size-limit-refresh', deviceId: 'device' })
  await setGlobalAccess('public')
  for (const sample of [
    { status: 422, code: 'quark_file_size_limit', bytes: '52428800', expected: 422 },
    { status: 422, code: 'quark_file_size_limit', bytes: 'invalid-private-token', expected: 422 },
    { status: 502, code: 'quark_http_400_api_23018', bytes: '52428800', expected: 502 },
  ]) {
    calls.length = 0
    upstream = async (url, options) => {
      if (url.pathname.endsWith('/file/info')) return { status: 0, data: { fid: 'policy-video', pdir_fid: '0', file_type: 1, file_name: '07(1).mp4', size: 848086961 } }
      if (url.hostname === 'media.map7e.com') {
        assert.equal(options.method, 'HEAD')
        assert.equal(options.headers.Range, 'bytes=0-0')
        return new Response(null, { status: sample.status, headers: { 'X-Media-Error': sample.code, 'X-Media-Limit-Bytes': sample.bytes } })
      }
      throw Error('unexpected upstream request')
    }
    const target = res()
    await storageDownload({ method: 'GET', query: { storageId: 'quark-main', id: 'policy-video', parentId: '', check: 'range' }, headers: {} }, target)
    assert.equal(target.statusCode, sample.expected)
    assert.equal(calls.filter(call => call.url.hostname === 'media.map7e.com').length, 1)
    assert.equal(target.headers.Location, undefined, 'a rejected file never produces a browser media redirect')
    if (sample.expected === 422) {
      assert.equal(target.body.error, 'quark_file_size_limit')
      assert.equal(target.body.limitBytes, sample.bytes === '52428800' ? 52428800 : undefined)
      if (sample.bytes === '52428800') assert.equal(target.body.message, '当前夸克接口限制单文件下载大小为 50 MiB，此文件暂不支持站内播放或下载。')
    } else assert.equal(target.body.error, 'storage_range_probe_failed')
    for (const hidden of ['size-limit-access', 'size-limit-refresh', 'invalid-private-token', 'ticket=', 'media.map7e.com']) {
      assert.ok(!JSON.stringify(target.body).includes(hidden))
    }
  }
})
await test('Quark Provider surfaces explicit size rejection without retrying or refreshing credentials', async () => {
  calls.length = 0
  upstream = async url => {
    if (url.pathname.endsWith('/get_download_url')) return response({ status: -1, errno: 23018, error_info: 'download file size limit[52428800]' }, 400)
    throw Error('size rejection must not refresh or fetch another endpoint')
  }
  const provider = createQuarkProvider({ storageId: 'quark-main', provider: 'quark' }, {
    accessToken: 'limit-provider-access', refreshToken: 'limit-provider-refresh', deviceId: 'limit-device',
  })
  await assert.rejects(() => provider.getFileResponse('large-limit-file', { range: 'bytes=0-0' }), error => {
    assert.equal(error.code, 'quark_file_size_limit')
    assert.equal(error.status, 422)
    assert.equal(error.limitBytes, 52428800)
    return true
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers.Range, undefined)
  assert.deepEqual(JSON.parse(calls[0].body), { fid: 'large-limit-file' })
})
await test('OAuth uses official exchange and stores expiry fields from response', async () => {
  upstream = async url => url.pathname.endsWith('get_authorize_page_url') ? { status: 0, data: { authorize_page_url: 'https://pan.quark.cn/open/v1/oauth/agent?page_code=page', page_code: 'page', device_id: 'device' } } : url.pathname.endsWith('get_aac_by_pagecode') ? { status: 0, data: {} } : { status: 0, data: { access_token: 'new-access', refresh_token: 'new-refresh', user_id: 'user', device_id: 'device', access_token_expires_at: 1900000000, refresh_token_expires_at: 2000000000 } }
  const pending = await beginQuarkAuthorization('quark-main')
  assert.equal(new URL(pending.authorizeUrl).hostname, 'pan.quark.cn')
  assert.equal(await finishQuarkAuthorization(pending), null)
  upstream = async url => url.pathname.endsWith('get_aac_by_pagecode') ? { status: 0, data: { agent_auth_code: 'code' } } : { status: 0, data: { access_token: 'new-access', refresh_token: 'new-refresh', user_id: 'user', device_id: 'device', access_token_expires_at: 1900000000 } }
  assert.equal((await finishQuarkAuthorization(pending)).accessExpiresAt, 1900000000000)
})
await test('OAuth start, state-bound completion, encrypted persistence and admin descriptor redaction', async () => {
  process.env.ADMIN_PASSWORD = 'test-admin-password'
  await writeConfig({ version: 1, defaultStorageId: 'pikpak-main', instances: [
    { storageId: 'pikpak-main', provider: 'pikpak', displayName: 'PikPak', enabled: true },
    { storageId: 'quark-main', provider: 'quark', displayName: '夸克网盘', enabled: true },
  ] })
  const sessionToken = createAdminSessionToken().token
  const adminCookie = `map7e_admin_session=${sessionToken}`
  upstream = async url => {
    if (url.pathname.endsWith('/get_authorize_page_url')) return { status: 0, data: {
      authorize_page_url: 'https://pan.quark.cn/open/v1/oauth/agent?page_code=page', page_code: 'page', device_id: 'device',
    } }
    if (url.pathname.endsWith('/get_aac_by_pagecode')) return { status: 0, data: { agent_auth_code: 'authorization-code' } }
    if (url.pathname.endsWith('/agent_auth_code')) return { status: 0, data: {
      access_token: 'oauth-access-sensitive', refresh_token: 'oauth-refresh-sensitive', user_id: 'user', device_id: 'device',
      access_token_expires_at: 1900000000, refresh_token_expires_at: 2000000000,
    } }
    if (url.pathname.endsWith('/user/info')) return { status: 0, data: { nickname: '枫', user_id: 'user' } }
    if (url.pathname.endsWith('/user/get_vip_info')) return { status: 0, data: { vip_type: 'SVIP', capacity: '100000', used: '25000' } }
    return { status: 0, data: {} }
  }
  const unauthenticatedStart = res()
  await quarkOAuth({ method: 'POST', body: { action: 'start', storageId: 'quark-main' }, headers: { cookie: '' } }, unauthenticatedStart)
  assert.equal(unauthenticatedStart.statusCode, 401)
  const start = res()
  await quarkOAuth({ method: 'POST', body: { action: 'start', storageId: 'quark-main' }, headers: { cookie: adminCookie } }, start)
  assert.equal(start.statusCode, 200)
  assert.equal(start.body.authorizeUrl, 'https://pan.quark.cn/open/v1/oauth/agent?page_code=page')
  assert.equal(JSON.stringify(start.body).includes('oauth-access-sensitive'), false)
  const stateCookie = start.headers['Set-Cookie'].split(';')[0]

  const otherPayload = Buffer.from(JSON.stringify({ role: 'admin', exp: createAdminSessionToken().expires, sessionVersion: 0, nonce: 'different-session' })).toString('base64url')
  const otherSignature = crypto.createHmac('sha256', process.env.PIKPAK_PAT).update(`admin.${otherPayload}`).digest('base64url')
  const wrongSession = res()
  await quarkOAuth({ method: 'POST', body: { action: 'complete', storageId: 'quark-main' }, headers: { cookie: `map7e_admin_session=${otherPayload}.${otherSignature}; ${stateCookie}` } }, wrongSession)
  assert.equal(wrongSession.statusCode, 400)
  assert.equal(wrongSession.body.error, 'oauth_state_invalid')

  const complete = res()
  await quarkOAuth({ method: 'POST', body: { action: 'complete', storageId: 'quark-main' }, headers: { cookie: `${adminCookie}; ${stateCookie}` } }, complete)
  assert.equal(complete.statusCode, 200)
  assert.deepEqual(complete.body, { ok: true, status: 'authorized', storageId: 'quark-main' })
  for (const secret of ['oauth-access-sensitive', 'oauth-refresh-sensitive']) {
    assert.equal(JSON.stringify(complete.body).includes(secret), false)
    assert.equal(redis.get('map7e-cloud:storage:auth:v1:quark-main').includes(secret), false)
  }
  assert.deepEqual(await readAuth('quark-main'), {
    accessToken: 'oauth-access-sensitive', refreshToken: 'oauth-refresh-sensitive', userId: 'user', deviceId: 'device',
    accessExpiresAt: 1900000000000, refreshExpiresAt: 2000000000000,
  })

  const descriptors = res()
  await adminStorages({ method: 'GET', query: {}, body: {}, headers: { cookie: adminCookie } }, descriptors)
  assert.equal(descriptors.statusCode, 200)
  const publicDescriptors = JSON.stringify(descriptors.body)
  assert.ok(publicDescriptors.includes('枫'))
  assert.ok(publicDescriptors.includes('100000'))
  assert.equal(publicDescriptors.includes('oauth-access-sensitive'), false)
  assert.equal(publicDescriptors.includes('oauth-refresh-sensitive'), false)

  const replay = res()
  await quarkOAuth({ method: 'POST', body: { action: 'complete', storageId: 'quark-main' }, headers: { cookie: `${adminCookie}; ${stateCookie}` } }, replay)
  assert.equal(replay.statusCode, 400)
  assert.equal(replay.body.error, 'oauth_state_invalid')
})
await test('expired token rotation persists rotated credentials and locks exclude concurrent refresh', async () => {
  await writeAuth('quark-main', { accessToken: 'expired-access', refreshToken: 'rotate-refresh', deviceId: 'device', accessExpiresAt: 1 })
  const provider = createQuarkProvider({ storageId: 'quark-main' }, await readAuth('quark-main'))
  let rotateCount = 0
  upstream = async url => {
    if (url.pathname.endsWith('/rotate')) { rotateCount += 1; return { status: 0, data: { access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 7200 } } }
    if (url.pathname.endsWith('/user/get_vip_info')) return { status: 0, data: { capacity: '100', used: '40' } }
    return { status: 0, data: { nickname: 'test' } }
  }
  const quotas = await Promise.all([provider.getQuota(), provider.getQuota()])
  assert.deepEqual(quotas, [{ total: 100, used: 40, free: 60 }, { total: 100, used: 40, free: 60 }])
  assert.equal(rotateCount, 1)
  assert.equal((await readAuth('quark-main')).refreshToken, 'rotated-refresh')
  await withLock('exclusive', async () => assert.rejects(withLock('exclusive', async () => {}), /storage_operation_busy/))
  await withLock('exclusive', async () => {})
})
await test('Quark Gateway download routes never hand an upstream URL or account credential to the browser', async () => {
  assert.equal(safeDirectUrl('https://cdn.test/a?access_token=secret'), null)
  assert.equal(safeDirectUrl('https://user:password@cdn.test/a'), null)
  assert.equal(safeDirectUrl('https://cdn.test/secret', ['secret']), null)
  const provider = createQuarkProvider({ storageId: 'quark-main' }, await readAuth('quark-main'))
  upstream = async url => url.pathname.endsWith('/file/get_download_url')
    ? { status: 0, data: { download_url: 'https://cdn.test/file?temporary_signature=ok' } }
    : { status: 0, data: {} }
  await assert.rejects(provider.getFileResponse('f'), /download_link_unavailable/)
})
await test('permissions use actual parent and scope identical file ids to each storage', async () => {
  await setGlobalAccess('public')
  await setFileMetadata(metadataId('quark-main', 'same-id'), { access: 'locked' })
  const provider = { getItem: async () => ({ id: 'same-id', parentId: '', isFolder: false }) }
  await assert.rejects(requireItemRead({ headers: {} }, provider, 'quark-main', 'same-id', 'fake-parent'), /file_not_found/)
  await assert.rejects(requireItemRead({ headers: {} }, provider, 'quark-main', 'same-id', ''), /authentication_required|cloud_login_not_configured/)
  assert.equal((await requireItemRead({ headers: {} }, provider, 'pikpak-two', 'same-id', '')).id, 'same-id')
})

await test('Quark info response wrappers normalize root and nested item parents consistently', async () => {
  const auth = { accessToken: 'info-access', refreshToken: 'info-refresh', deviceId: 'info-device' }
  await writeAuth('quark-main', auth)
  const records = {
    root: { fid: 'root', pdir_fid: 0, file_type: '0', file_name: 'Root' },
    folder: { fid: 'folder', pdir_fid: 'root', file_type: 0, file_name: 'Nested' },
    file: { fid: 'file', pdir_fid: '0', file_type: 2, file_name: 'readme.txt' },
  }
  upstream = async url => {
    if (url.pathname.endsWith('/file/list')) return { status: 0, data: { file_list: [records.root], last_page: true } }
    const id = url.searchParams.get('fid')
    if (id === 'root') return { status: 0, data: { file: records.root } }
    if (id === 'folder') return { status: 0, data: { file_info: records.folder } }
    if (id === 'file') return { status: 0, data: records.file }
    return { status: 0, data: { file_info: records.root } }
  }
  const provider = createQuarkProvider({ storageId: 'quark-main', provider: 'quark' }, auth)
  const root = await provider.getItem('root')
  const nested = await provider.getItem('folder')
  const file = await provider.getItem('file')
  assert.equal(root.id, 'root')
  assert.equal(root.parentId, '', 'numeric/string root 0 maps to the project root sentinel')
  assert.equal(root.isFolder, true)
  assert.equal(nested.parentId, 'root')
  assert.equal(file.parentId, '')
  await assert.rejects(provider.getItem('missing'), error => error.code === 'file_not_found')

  const path = await folderPathWithinRoot(provider, 'folder', '0')
  assert.deepEqual(path.map(item => item.id), ['root', 'folder'], 'a configured Quark root 0 is the same as an empty project root')
})

await test('Quark FID suffix identity supports live info prefixes through nested listing and download checks', async () => {
  await writeConfig({ version: 1, defaultStorageId: 'quark-main', instances: [
    { storageId: 'pikpak-main', provider: 'pikpak', displayName: 'PikPak', enabled: true },
    { storageId: 'quark-main', provider: 'quark', displayName: '夸克网盘', enabled: true },
  ] })
  await writeAuth('quark-main', { accessToken: 'fid-access', refreshToken: 'fid-refresh', userId: 'fid-user', deviceId: 'fid-device' })
  await setGlobalAccess('public')
  const listedOuter = 'listed-outer-prefix|outer-key'
  const listedInner = 'listed-inner-prefix|inner-key'
  const listedFile = 'listed-file-prefix|file-key'
  const listParents = [], downloadLinkCalls = []
  let virtualRootInfoCalls = 0
  upstream = async (url, options = {}) => {
    if (url.pathname.endsWith('/file/list')) {
      const parent = JSON.parse(options.body).parent_fid
      listParents.push(parent)
      if (parent === '0') return { status: 0, data: { file_list: [{ fid: listedOuter, pdir_fid: 'list-root-alias|drive-key', file_type: '0', filename: '夸克云盘' }], last_page: true } }
      if (quarkSuffix(parent) === 'outer-key') return { status: 0, data: { file_list: [{ fid: listedInner, pdir_fid: 'other-outer-prefix|outer-key', file_type: '0', filename: '旅行照片' }], last_page: true } }
      if (quarkSuffix(parent) === 'inner-key') return { status: 0, data: { file_list: [{ fid: listedFile, pdir_fid: 'other-inner-prefix|inner-key', file_type: '1', filename: 'photo.jpg', size: '2048' }], last_page: true } }
      return { status: 0, data: { file_list: [], last_page: true } }
    }
    if (url.pathname.endsWith('/file/info')) {
      const key = quarkSuffix(url.searchParams.get('fid'))
      const records = {
        'outer-key': { fid: 'info-outer-prefix|outer-key', parent_fid: 'info-root-alias|drive-key', file_type: '0', filename: '夸克云盘' },
        'inner-key': { fid: 'info-inner-prefix|inner-key', parent_fid: 'info-outer-prefix|outer-key', file_type: '0', filename: '旅行照片' },
        'file-key': { fid: 'info-file-prefix|file-key', parent_fid: 'info-inner-prefix|inner-key', file_type: '1', filename: 'photo.jpg' },
      }
      if (key === 'drive-key') { virtualRootInfoCalls += 1; return { status: 1, errno: 404, error_info: 'virtual root is not an item' } }
      return records[key] ? { status: 0, data: records[key] } : { status: 1, error_info: 'missing' }
    }
    if (url.pathname.endsWith('/file/get_download_url')) {
      downloadLinkCalls.push(JSON.parse(options.body).fid)
      return { status: 0, data: { download_url: 'https://download.example/live-quark-file' } }
    }
    if (url.hostname === 'download.example') return new Response(null, { status: 206, headers: { 'Content-Range': 'bytes 0-0/1' } })
    return { status: 0, data: {} }
  }

  const root = res()
  await storageFiles({ method: 'GET', query: { storageId: 'quark-main' }, headers: {} }, root)
  assert.equal(root.statusCode, 200)
  assert.equal(root.body.items[0].id, listedOuter)

  const firstLevel = res()
  await storageFiles({ method: 'GET', query: { storageId: 'quark-main', parentId: listedOuter }, headers: {} }, firstLevel)
  assert.equal(firstLevel.statusCode, 200, JSON.stringify(firstLevel.body))
  assert.equal(firstLevel.body.items[0].id, listedInner)

  const secondLevel = res()
  await storageFiles({ method: 'GET', query: { storageId: 'quark-main', parentId: listedInner }, headers: {} }, secondLevel)
  assert.equal(secondLevel.statusCode, 200, JSON.stringify(secondLevel.body))
  assert.equal(secondLevel.body.items[0].id, listedFile)

  const downloaded = res()
  await storageDownload({ method: 'GET', query: { storageId: 'quark-main', id: listedFile, parentId: secondLevel.body.items[0].parentId }, headers: {} }, downloaded)
  assert.equal(downloaded.statusCode, 302, JSON.stringify(downloaded.body))
  assert.equal(mediaClaimsFromResponse(downloaded).fileId, listedFile, 'the original full FID is preserved in the signed ticket')
  assert.equal(mediaClaimsFromResponse(downloaded).purpose, 'original')
  assert.equal(downloadLinkCalls.length, 0, 'Quark bytes are read by the Gateway after ticket validation')

  const falseParent = res()
  await storageDownload({ method: 'GET', query: { storageId: 'quark-main', id: listedFile, parentId: 'wrong-prefix|wrong-key' }, headers: {} }, falseParent)
  assert.equal(falseParent.statusCode, 404, 'a different identity suffix remains rejected')
  assert.equal(downloadLinkCalls.length, 0, 'neither valid nor mismatched requests fetch an upstream URL on Vercel')
  assert.deepEqual(listParents.slice(0, 3), ['0', listedOuter, listedInner])
  assert.equal(virtualRootInfoCalls, 0, 'the opaque root parent from Quark list is recognized without treating it as a file')
})

await test('Quark nested folder reads and storage downloads accept normalized real item parents', async () => {
  await writeConfig({ version: 1, defaultStorageId: 'quark-main', instances: [
    { storageId: 'pikpak-main', provider: 'pikpak', displayName: 'PikPak', enabled: true },
    { storageId: 'quark-main', provider: 'quark', displayName: '夸克网盘', enabled: true, rootFolderId: '0' },
  ] })
  const auth = { accessToken: 'nested-access', refreshToken: 'nested-refresh', userId: 'nested-user', deviceId: 'nested-device' }
  await writeAuth('quark-main', auth)
  await setGlobalAccess('public')
  const listParents = [], downloadLinkCalls = []
  upstream = async (url, options = {}) => {
    if (url.pathname.endsWith('/file/list')) {
      const parent = JSON.parse(options.body).parent_fid
      listParents.push(parent)
      if (parent === '0') return { status: 0, data: { file_list: [{ fid: 'outer', pdir_fid: 0, file_type: 0, file_name: 'Outer' }], last_page: true } }
      if (parent === 'outer') return { status: 0, data: { file_list: [{ fid: 'inner', pdir_fid: 'outer', file_type: 0, file_name: 'Inner' }], last_page: true } }
      if (parent === 'inner') return { status: 0, data: { file_list: [{ fid: 'nested-file', pdir_fid: 'inner', file_type: 2, file_name: 'notes.txt' }], last_page: true } }
      return { status: 0, data: { file_list: [], last_page: true } }
    }
    if (url.pathname.endsWith('/file/info')) {
      const id = url.searchParams.get('fid')
      const records = {
        outer: { fid: 'outer', pdir_fid: '0', file_type: 0, file_name: 'Outer' },
        inner: { fid: 'inner', pdir_fid: 'outer', file_type: 0, file_name: 'Inner' },
        'nested-file': { fid: 'nested-file', pdir_fid: 'inner', file_type: 2, file_name: 'notes.txt' },
      }
      return records[id] ? { status: 0, data: { file_info: records[id] } } : { status: 1, error_info: 'missing' }
    }
    if (url.pathname.endsWith('/file/get_download_url')) {
      downloadLinkCalls.push(url.pathname)
      return { status: 0, data: { download_url: 'https://download.example/nested-file' } }
    }
    if (url.hostname === 'download.example') return new Response(null, { status: 206, headers: { 'Content-Range': 'bytes 0-0/1' } })
    return { status: 0, data: {} }
  }

  const root = res()
  await storageFiles({ method: 'GET', query: { storageId: 'quark-main' }, headers: {} }, root)
  assert.equal(root.statusCode, 200)
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
  assert.equal(mediaClaimsFromResponse(downloaded).fileId, 'nested-file')
  assert.equal(downloadLinkCalls.length, 0)

  const badParent = res()
  await storageDownload({ method: 'GET', query: { storageId: 'quark-main', id: 'nested-file', parentId: '0' }, headers: {} }, badParent)
  assert.equal(badParent.statusCode, 404, 'parent validation remains strict after root normalization')
  assert.equal(downloadLinkCalls.length, 0, 'neither valid nor mismatched requests fetch an upstream URL on Vercel')
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

await test('Quark refresh lock waiter reads a rotation that completes after more than 20 polls', async () => {
  await writeAuth('quark-main', { accessToken: 'late-expired', refreshToken: 'late-refresh', deviceId: 'device', accessExpiresAt: 1 })
  const initial = await readAuth('quark-main')
  let releaseLock
  const lockHeld = withLock('refresh-quark-main', () => new Promise(resolve => { releaseLock = resolve }))
  await new Promise(resolve => setImmediate(resolve))
  let polls = 0
  const provider = createQuarkProvider({ storageId: 'quark-main' }, { ...initial }, {
    sleep: async () => {
      polls += 1
      if (polls === 25) {
        await writeAuth('quark-main', {
          ...initial,
          accessToken: 'late-rotated',
          refreshToken: 'late-refresh-2',
          accessExpiresAt: Date.now() + 7_200_000,
        })
        releaseLock()
      }
    },
  })
  upstream = async url => url.pathname.endsWith('/user/get_vip_info')
    ? { status: 0, data: { capacity: '100', used: '25' } }
    : { status: 0, data: { nickname: 'test' } }
  const quota = await provider.getQuota()
  await lockHeld
  assert.deepEqual(quota, { total: 100, used: 25, free: 75 })
  assert.equal(polls, 25)
  assert.equal((await readAuth('quark-main', { fresh: true })).accessToken, 'late-rotated')
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
