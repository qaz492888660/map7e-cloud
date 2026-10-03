import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import { createMediaTicket } from '../../../lib/storage/media-ticket.js'
import {
  createMediaGatewayWorker,
  isAllowedQuarkUrl,
  MEDIA_SESSION_COOKIE,
  parseSingleRange,
  quarkFidsMatch,
  verifyGrant,
} from '../src/worker.js'

const ticketSecret = 'worker-test-signing-secret-has-at-least-32-bytes'
const encryptionSecret = 'worker-test-storage-encryption-key'
const allowedOrigin = 'https://cloud.example.test'
const fixedNow = 1_800_000_000_000
const redisUrl = 'https://test-redis.upstash.io'
const redisToken = 'redis-test-token-only-in-worker'
const defaultAuth = {
  accessToken: 'quark-access-token-server-only',
  refreshToken: 'quark-refresh-token-server-only',
  clientToken: 'quark-client-token-server-only',
  userId: 'test-user-id',
  deviceId: 'test-device-id',
  accessExpiresAt: null,
  refreshExpiresAt: null,
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function cookiePair(response) { return response.headers.get('set-cookie').split(';', 1)[0] }
function cookieValue(pair) { return pair.slice(pair.indexOf('=') + 1) }

async function sealAuth(storageId, auth, secret = encryptionSecret) {
  const key = crypto.createHash('sha256').update('map7e-storage-v1\u0000' + secret).digest()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(storageId))
  const data = Buffer.concat([cipher.update(JSON.stringify(auth), 'utf8'), cipher.final()])
  return JSON.stringify({
    version: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: data.toString('base64url'),
  })
}

function mediaFile(id, overrides = {}) {
  return {
    fid: id,
    pdir_fid: '0',
    file_name: 'sample.mp4',
    file_type: 1,
    size: 30 * 1024 * 1024 * 1024,
    mime_type: 'video/mp4',
    file_ext: 'mp4',
    ...overrides,
  }
}

function ticketFor(fileId, options = {}, now = fixedNow) {
  return createMediaTicket({
    storageId: options.storageId || 'quark-main',
    fileId,
    parentId: options.parentId || '',
    purpose: options.purpose || 'video',
    ...(options.purpose === 'preview' ? { variant: options.variant || 'preview' } : {}),
    ...(options.disposition ? { disposition: options.disposition } : {}),
  }, { secret: options.secret || ticketSecret, now })
}

async function createFixture({
  files = {},
  auth = defaultAuth,
  envOverrides = {},
  nowValue = fixedNow,
  cdnHandler,
  expireFirstMediaUrl = false,
  authorizeRefresh = false,
  redisHandler,
  quarkHandler,
  cdnHeaderTimeoutMs,
} = {}) {
  const state = {
    files,
    auth,
    authRecord: await sealAuth('quark-main', auth),
    apiRequests: [],
    cdnRequests: [],
    redisRequests: [],
    logs: [],
    mediaUrlCount: 0,
    media401Remaining: expireFirstMediaUrl ? 1 : 0,
    authExpired: authorizeRefresh,
    storedRefreshes: 0,
  }
  const env = {
    MEDIA_GATEWAY_SIGNING_SECRET: ticketSecret,
    MEDIA_GATEWAY_ALLOWED_ORIGIN: allowedOrigin,
    MEDIA_GATEWAY_SITE_DOMAIN: 'example.test',
    UPSTASH_REDIS_REST_URL: redisUrl,
    UPSTASH_REDIS_REST_TOKEN: redisToken,
    STORAGE_ENCRYPTION_KEY: encryptionSecret,
    ...envOverrides,
  }
  const config = {
    version: 1,
    defaultStorageId: 'quark-main',
    instances: [
      { storageId: 'quark-main', provider: 'quark', displayName: '夸克网盘', enabled: true },
    ],
  }
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    const headers = new Headers(init.headers || {})
    if (url.hostname.endsWith('.upstash.io')) {
      if (redisHandler) {
        const overridden = await redisHandler({ url, init, state })
        if (overridden) return overridden
      }
      const commands = JSON.parse(init.body)
      state.redisRequests.push(commands)
      const values = commands.map(command => {
        if (command[0] === 'GET' && command[1] === 'map7e-cloud:storage:config:v1:') return JSON.stringify(config)
        if (command[0] === 'GET' && command[1] === 'map7e-cloud:storage:auth:v1:quark-main') return state.authRecord
        if (command[0] === 'GET' && command[1] === 'map7e-cloud:storage:lock:v1:refresh-quark-main') return null
        if (command[0] === 'SET' && command[1] === 'map7e-cloud:storage:lock:v1:refresh-quark-main') return 'OK'
        if (command[0] === 'SET' && command[1] === 'map7e-cloud:storage:auth:v1:quark-main') {
          state.authRecord = command[2]
          state.storedRefreshes += 1
          return 'OK'
        }
        if (command[0] === 'EVAL') return 1
        throw new Error('unexpected_redis_command')
      })
      return jsonResponse(values.map(result => ({ result })))
    }
    if (url.hostname === 'open-api-drive.quark.cn' || url.hostname === 'api.quark.cn') {
      if (quarkHandler) {
        const overridden = await quarkHandler({ url, init, headers, state })
        if (overridden) return overridden
      }
      const accessToken = url.searchParams.get('access_token')
      state.apiRequests.push({ url: url.toString(), method: init.method || 'GET', headers, accessToken, body: init.body })
      if (url.pathname === '/agent/v1/oauth/access_token/rotate') {
        return jsonResponse({ status: 0, data: {
          access_token: 'quark-access-token-refreshed',
          refresh_token: 'quark-refresh-token-refreshed',
          expires_in: 3600,
        } })
      }
      if (state.authExpired && accessToken !== 'quark-access-token-refreshed') {
        return jsonResponse({ status: 1, error_info: 'access token expired' }, 401)
      }
      if (url.pathname === '/open/v1/file/info') {
        const id = url.searchParams.get('fid')
        const file = state.files[id] || mediaFile(id)
        return jsonResponse({ status: 0, data: file })
      }
      if (url.pathname === '/open/v1/file/get_download_url') {
        state.mediaUrlCount += 1
        const id = JSON.parse(init.body).fid
        const file = state.files[id] || mediaFile(id)
        const deadline = Math.floor(nowValue / 1000) + 1800
        return jsonResponse({ status: 0, data: {
          download_url: 'https://cdn.quark.cn/download/' + encodeURIComponent(id)
            + '?auth_key=' + deadline + '-signature-' + state.mediaUrlCount,
          size: file.size,
          file_name: file.file_name,
        } })
      }
      throw new Error('unexpected_quark_api_path')
    }
    if (url.hostname.endsWith('.quark.cn') || url.hostname === 'quark.cn') {
      if (cdnHandler) return cdnHandler(url, headers, state, init)
      state.cdnRequests.push({ url: url.toString(), headers, range: headers.get('range') })
      if (url.pathname.startsWith('/thumb/')) {
        return new Response(new Uint8Array([255, 216, 255]), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '3' },
        })
      }
      if (state.media401Remaining > 0) {
        state.media401Remaining -= 1
        return new Response('denied', { status: 403, headers: { 'Content-Type': 'text/plain' } })
      }
      const total = 30 * 1024 * 1024 * 1024
      const range = headers.get('range')
      if (!range) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '3', 'Accept-Ranges': 'bytes' },
        })
      }
      const match = /^bytes=(\d+)-(\d+)$/.exec(range)
      if (!match) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + total } })
      const start = Number(match[1])
      const end = Number(match[2])
      if (start >= total) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + total } })
      const boundedEnd = Math.min(end, total - 1)
      const length = boundedEnd - start + 1
      const fileId = decodeURIComponent(url.pathname.split('/').pop() || '')
      const file = state.files[fileId] || mediaFile(fileId)
      return new Response(new Uint8Array(length).fill(7), {
        status: 206,
        headers: {
          'Content-Type': file.mime_type || 'video/mp4',
          'Accept-Ranges': 'bytes',
          'Content-Range': 'bytes ' + start + '-' + boundedEnd + '/' + total,
          'Content-Length': String(length),
          ETag: '"worker-media-v1"',
          'Last-Modified': 'Thu, 01 Oct 2026 12:00:00 GMT',
        },
      })
    }
    throw new Error('unexpected_upstream_host')
  }
  const worker = createMediaGatewayWorker({
    fetchImpl,
    now: () => nowValue,
    logger: entry => state.logs.push(entry),
    ...(cdnHeaderTimeoutMs === undefined ? {} : { cdnHeaderTimeoutMs }),
  })
  return { worker, env, state, setNow(value) { nowValue = value } }
}

async function requestMedia(fixture, fileId, {
  method = 'GET',
  purpose = 'video',
  variant,
  disposition,
  parentId = '',
  range,
  ifRange,
  cookie,
  origin = allowedOrigin,
  now = fixedNow,
} = {}) {
  const token = ticketFor(fileId, { purpose, variant, disposition, parentId }, now)
  const headers = new Headers()
  if (range !== undefined) headers.set('Range', range)
  if (ifRange !== undefined) headers.set('If-Range', ifRange)
  if (cookie) headers.set('Cookie', cookie)
  if (origin) headers.set('Origin', origin)
  const url = 'https://media.example.test/v1/media?ticket=' + encodeURIComponent(token)
  return fixture.worker.fetch(new Request(url, { method, headers }), fixture.env)
}

test('Worker verifies Node-issued HMAC tickets and rejects expired or modified grants', async () => {
  const ticket = ticketFor('ticket-check')
  const claims = await verifyGrant(ticket, ticketSecret, { now: fixedNow, grantType: 'ticket' })
  assert.equal(claims.storageId, 'quark-main')
  assert.equal(claims.fileId, 'ticket-check')
  await assert.rejects(() => verifyGrant(ticket.slice(0, -1) + 'A', ticketSecret, { now: fixedNow, grantType: 'ticket' }), /media_ticket_invalid/)
  await assert.rejects(() => verifyGrant(ticket, ticketSecret, { now: fixedNow + 301_000, grantType: 'ticket' }), /media_ticket_expired/)
})

test('Worker health is minimal and works without media secrets', async () => {
  const fixture = await createFixture({ envOverrides: { MEDIA_GATEWAY_SIGNING_SECRET: undefined } })
  const response = await fixture.worker.fetch(new Request('https://media.example.test/health'), fixture.env)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, version: '0.2.6' })
  assert.equal(fixture.state.redisRequests.length, 0)
})

test('Worker caches storage config and auth across independent Range requests for the storage TTL', async () => {
  const fixture = await createFixture()
  const getCount = key => fixture.state.redisRequests.flat()
    .filter(command => command[0] === 'GET' && command[1] === key).length
  const configKey = 'map7e-cloud:storage:config:v1:'
  const authKey = 'map7e-cloud:storage:auth:v1:quark-main'

  const first = await requestMedia(fixture, 'cached-range-video', { range: 'bytes=0-1' })
  assert.equal(first.status, 206)
  await first.arrayBuffer()
  const second = await requestMedia(fixture, 'cached-range-video', { range: 'bytes=2000000000-2000000001' })
  assert.equal(second.status, 206)
  await second.arrayBuffer()
  assert.equal(getCount(configKey), 1)
  assert.equal(getCount(authKey), 1)

  fixture.setNow(fixedNow + 10_001)
  const afterExpiry = await requestMedia(fixture, 'cached-range-video', { range: 'bytes=3000000000-3000000001' })
  assert.equal(afterExpiry.status, 206)
  await afterExpiry.arrayBuffer()
  assert.equal(getCount(configKey), 2)
  assert.equal(getCount(authKey), 2)
})

test('Worker returns media_gateway_not_configured instead of a generic 502 when storage secrets are absent', async () => {
  const fixture = await createFixture({ envOverrides: {
    UPSTASH_REDIS_REST_URL: undefined,
    UPSTASH_REDIS_REST_TOKEN: undefined,
    KV_REST_API_URL: undefined,
    KV_REST_API_TOKEN: undefined,
  } })
  const response = await requestMedia(fixture, 'no-store')
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error, 'media_gateway_not_configured')
})

test('Worker reports safe Redis request and HTTP error codes without returning upstream details', async () => {
  const rejected = await createFixture({
    redisHandler: async () => { throw new Error('https://secret-host.invalid token=do-not-return') },
  })
  const fetchFailure = await requestMedia(rejected, 'fetch-failure')
  const fetchBody = await fetchFailure.json()
  assert.equal(fetchFailure.status, 503)
  assert.equal(fetchBody.error, 'persistent_storage_request_failed')
  assert.doesNotMatch(JSON.stringify(fetchBody), /secret-host|do-not-return/)

  const network = await createFixture({
    redisHandler: async () => { throw new TypeError('fetch failed; token=do-not-return') },
  })
  const networkFailure = await requestMedia(network, 'network-failure')
  const networkBody = await networkFailure.json()
  assert.equal(networkFailure.status, 503)
  assert.equal(networkBody.error, 'persistent_storage_network_failed')
  assert.doesNotMatch(JSON.stringify(networkBody), /token=do-not-return/)

  const unauthorized = await createFixture({
    redisHandler: async () => jsonResponse({ error: 'secret token rejected' }, 401),
  })
  const httpFailure = await requestMedia(unauthorized, 'http-failure')
  const httpBody = await httpFailure.json()
  assert.equal(httpFailure.status, 503)
  assert.equal(httpBody.error, 'persistent_storage_http_401')
  assert.doesNotMatch(JSON.stringify(httpBody), /secret|token rejected/)
})

test('Worker follows bounded HTTPS redirects only within the configured Upstash host boundary', async () => {
  const redisCalls = []
  const fixture = await createFixture({
    redisHandler: async ({ url, init }) => {
      redisCalls.push({ hostname: url.hostname, redirect: init.redirect, authorization: new Headers(init.headers).get('authorization') })
      if (url.hostname === 'test-redis.upstash.io') {
        return new Response(null, { status: 307, headers: { Location: 'https://replica.upstash.io/pipeline' } })
      }
      return null
    },
  })
  const response = await requestMedia(fixture, 'redirected-redis', { range: 'bytes=0-0' })
  assert.equal(response.status, 206)
  assert.ok(redisCalls.some(call => call.hostname === 'replica.upstash.io'))
  assert.ok(redisCalls.every(call => call.redirect === 'manual'))
  assert.ok(redisCalls.every(call => call.authorization === 'Bearer ' + redisToken))

  const untrustedCalls = []
  const rejected = await createFixture({
    redisHandler: async ({ url }) => {
      untrustedCalls.push(url.hostname)
      return new Response(null, { status: 307, headers: { Location: 'https://attacker.example/pipeline' } })
    },
  })
  const blocked = await requestMedia(rejected, 'untrusted-redis-redirect')
  assert.equal(blocked.status, 503)
  assert.equal((await blocked.json()).error, 'persistent_storage_redirect_host_rejected')
  assert.deepEqual(untrustedCalls, ['test-redis.upstash.io'])
})

test('Worker reports safe Quark network and malformed-response errors', async () => {
  let networkAttempts = 0
  const network = await createFixture({
    quarkHandler: async () => {
      networkAttempts += 1
      throw new TypeError('fetch failed for hidden endpoint; access_token=do-not-return')
    },
  })
  const networkResponse = await requestMedia(network, 'quark-network-failure')
  const networkBody = await networkResponse.json()
  assert.equal(networkResponse.status, 502)
  assert.equal(networkBody.error, 'quark_network_failed')
  assert.equal(networkAttempts, 2)
  assert.doesNotMatch(JSON.stringify(networkBody), /hidden endpoint|access_token|do-not-return/)

  let invalidAttempts = 0
  const malformed = await createFixture({
    quarkHandler: async () => {
      invalidAttempts += 1
      return new Response('<html>credential must stay private</html>', { status: 412, headers: { 'Content-Type': 'text/html' } })
    },
  })
  const malformedResponse = await requestMedia(malformed, 'quark-html-failure')
  const malformedBody = await malformedResponse.json()
  assert.equal(malformedResponse.status, 502)
  assert.equal(malformedBody.error, 'quark_response_invalid')
  assert.equal(invalidAttempts, 2)
  assert.doesNotMatch(JSON.stringify(malformedBody), /credential must stay private/)
})

test('Worker preserves only safe Quark HTTP/API error numbers', async () => {
  const apiFailure = await createFixture({
    quarkHandler: async () => jsonResponse({ status: 0, errno: 73421, error_info: 'private account details' }),
  })
  const apiResponse = await requestMedia(apiFailure, 'quark-api-error')
  assert.equal(apiResponse.status, 502)
  assert.deepEqual(await apiResponse.json(), { ok: false, error: 'quark_api_error_73421' })

  const httpFailure = await createFixture({
    quarkHandler: async () => jsonResponse({ errno: 73421, error_info: 'private account details' }, 412),
  })
  const httpResponse = await requestMedia(httpFailure, 'quark-http-error')
  assert.equal(httpResponse.status, 502)
  assert.deepEqual(await httpResponse.json(), { ok: false, error: 'quark_http_412_api_73421' })
})

test('Worker follows HTTPS Quark API redirects within the Quark China domain only', async () => {
  const calls = []
  const fixture = await createFixture({
    quarkHandler: async ({ url, init }) => {
      calls.push({ hostname: url.hostname, method: init.method || 'GET', redirect: init.redirect })
      if (url.hostname === 'open-api-drive.quark.cn') {
        return new Response(null, {
          status: 307,
          headers: { Location: 'https://api.quark.cn' + url.pathname + url.search },
        })
      }
      return null
    },
  })
  const response = await requestMedia(fixture, 'quark-redirect', { range: 'bytes=0-0' })
  assert.equal(response.status, 206)
  assert.ok(calls.some(call => call.hostname === 'api.quark.cn'))
  assert.ok(calls.every(call => call.redirect === 'manual'))

  const untrustedCalls = []
  const rejected = await createFixture({
    quarkHandler: async ({ url }) => {
      untrustedCalls.push(url.hostname)
      return new Response(null, { status: 307, headers: { Location: 'https://attacker.example/open/v1/file/info' } })
    },
  })
  const blocked = await requestMedia(rejected, 'quark-untrusted-redirect')
  assert.equal(blocked.status, 502)
  assert.equal((await blocked.json()).error, 'quark_redirect_host_rejected')
  assert.deepEqual(untrustedCalls, ['open-api-drive.quark.cn'])
})

test('Quark upstream URL allowlist blocks arbitrary hosts, IPs, localhost and non-HTTPS', () => {
  assert.equal(isAllowedQuarkUrl('https://cdn.quark.cn/file?auth_key=1-signature'), true)
  assert.equal(isAllowedQuarkUrl('https://download.quark.com/file'), true)
  assert.equal(isAllowedQuarkUrl('https://attacker.example/file'), false)
  assert.equal(isAllowedQuarkUrl('https://quark.cn.attacker.example/file'), false)
  assert.equal(isAllowedQuarkUrl('https://127.0.0.1/file'), false)
  assert.equal(isAllowedQuarkUrl('https://localhost/file'), false)
  assert.equal(isAllowedQuarkUrl('http://cdn.quark.cn/file'), false)
  assert.equal(isAllowedQuarkUrl('https://user:pass@cdn.quark.cn/file'), false)
})

test('single Range parser supports first/middle/suffix ranges and rejects multipart, invalid and out-of-file ranges', () => {
  assert.deepEqual(parseSingleRange('bytes=0-1023', 2048), { header: 'bytes=0-1023', start: 0, end: 1023 })
  assert.deepEqual(parseSingleRange('bytes=123456-123999', 2048 * 1024), { header: 'bytes=123456-123999', start: 123456, end: 123999 })
  assert.deepEqual(parseSingleRange('bytes=-1024', 4096), { header: 'bytes=-1024', start: null, end: 1024 })
  assert.throws(() => parseSingleRange('bytes=0-1,3-4', 10), /range_not_satisfiable/)
  assert.throws(() => parseSingleRange('bytes=10-2', 100), /range_not_satisfiable/)
  assert.throws(() => parseSingleRange('bytes=2048-2049', 2048), /range_not_satisfiable/)
})

test('first and middle video ranges return streamed 206 headers for 30 GB metadata', async () => {
  const fixture = await createFixture()
  for (const range of ['bytes=0-1023', 'bytes=1610612736-1610612738']) {
    const response = await requestMedia(fixture, 'large-video', { range })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-type'), 'video/mp4')
    assert.equal(response.headers.get('accept-ranges'), 'bytes')
    assert.equal(response.headers.get('content-range'), 'bytes ' + range.slice(6) + '/32212254720')
    assert.equal(response.headers.get('content-length'), range === 'bytes=0-1023' ? '1024' : '3')
    assert.equal((await response.arrayBuffer()).byteLength, range === 'bytes=0-1023' ? 1024 : 3)
  }
  assert.deepEqual(fixture.state.cdnRequests.map(value => value.range), ['bytes=0-1023', 'bytes=1610612736-1610612738'])
  assert.equal(fixture.state.logs.length, 2)
  assert.equal(fixture.state.logs[0].bytesStreamed, 1024)
})

test('Worker times out stalled CDN response headers with a safe gateway error', async () => {
  const fixture = await createFixture({
    cdnHeaderTimeoutMs: 20,
    cdnHandler: async (_url, _headers, _state, init) => new Promise((_, reject) => {
      const timeout = setTimeout(() => reject(new Error('mock fetch ignored its abort signal')), 1000)
      init.signal.addEventListener('abort', () => {
        clearTimeout(timeout)
        reject(new Error('mock fetch aborted before response headers'))
      }, { once: true })
    }),
  })
  const response = await requestMedia(fixture, 'stalled-cdn-video', { range: 'bytes=0-1' })
  assert.equal(response.status, 504)
  assert.deepEqual(await response.json(), { ok: false, error: 'quark_media_headers_timeout' })
  assert.doesNotMatch(JSON.stringify(fixture.state.logs), /quark-access-token|auth_key/)
})

test('Worker clears the CDN header timeout as soon as headers arrive and streams the longer body', async () => {
  let abortedAfterHeaders = false
  const fixture = await createFixture({
    cdnHeaderTimeoutMs: 20,
    cdnHandler: async (_url, headers, _state, init) => {
      assert.equal(headers.get('range'), 'bytes=0-1')
      return new Response(new ReadableStream({
        start(controller) {
          const onAbort = () => {
            abortedAfterHeaders = true
            controller.error(new Error('header timer aborted the response body'))
          }
          init.signal.addEventListener('abort', onAbort, { once: true })
          setTimeout(() => {
            init.signal.removeEventListener('abort', onAbort)
            controller.enqueue(new Uint8Array([7, 8]))
            controller.close()
          }, 50)
        },
      }), {
        status: 206,
        headers: {
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes',
          'Content-Range': 'bytes 0-1/32212254720',
          'Content-Length': '2',
        },
      })
    },
  })
  const response = await requestMedia(fixture, 'slow-stream-video', { range: 'bytes=0-1' })
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), 'bytes 0-1/32212254720')
  assert.equal(response.headers.get('content-length'), '2')
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [7, 8])
  assert.equal(abortedAfterHeaders, false)
})

test('Worker validates its synthetic HEAD Range probe before claiming range support', async () => {
  const supported = await createFixture()
  const head = await requestMedia(supported, 'head-probe-video', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('accept-ranges'), 'bytes')
  assert.equal(head.headers.get('content-length'), String(30 * 1024 * 1024 * 1024))
  assert.equal(supported.state.cdnRequests[0].range, 'bytes=0-0')
  assert.equal(head.body, null)

  const ignored = await createFixture({
    cdnHandler: async (_url, headers) => {
      assert.equal(headers.get('range'), 'bytes=0-0')
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'video/mp4', 'Content-Length': '3', 'Accept-Ranges': 'bytes' },
      })
    },
  })
  const rejected = await requestMedia(ignored, 'head-probe-ignored-video', { method: 'HEAD' })
  assert.equal(rejected.status, 502)
  assert.deepEqual(await rejected.json(), { ok: false, error: 'range_not_supported' })
  assert.equal(ignored.state.logs[0].status, 502)
})

test('Worker defaults video downloads to attachment and preserves explicit inline previews', async () => {
  const fixture = await createFixture()
  const download = await requestMedia(fixture, 'download-video')
  assert.equal(download.status, 200)
  assert.match(download.headers.get('content-disposition'), /^attachment;/)
  await download.arrayBuffer()

  const preview = await requestMedia(fixture, 'inline-video-preview', { disposition: 'inline' })
  assert.equal(preview.status, 200)
  assert.match(preview.headers.get('content-disposition'), /^inline;/)
  await preview.arrayBuffer()
})

test('Worker keeps explicitly inline original media inline', async () => {
  const fixture = await createFixture()
  const token = ticketFor('inline-document', { purpose: 'original', disposition: 'inline' })
  const response = await fixture.worker.fetch(new Request(
    'https://media.example.test/v1/media?ticket=' + encodeURIComponent(token),
  ), fixture.env)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-disposition'), /^inline;/)
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox")
  await response.arrayBuffer()
})

test('Worker infers all ticketed video extensions when Quark returns octet-stream', async () => {
  const expected = new Map([
    ['3gp', 'video/3gpp'],
    ['3g2', 'video/3gpp2'],
    ['m2ts', 'video/mp2t'],
    ['mts', 'video/mp2t'],
    ['ts', 'video/mp2t'],
    ['ogv', 'video/ogg'],
    ['wmv', 'video/x-ms-wmv'],
  ])
  for (const [extension, mime] of expected) {
    const fileId = 'video-' + extension
    const fixture = await createFixture({
      files: {
        [fileId]: mediaFile(fileId, {
          file_name: 'sample.' + extension,
          mime_type: '',
          file_ext: extension,
        }),
      },
      cdnHandler: async (url, headers, state) => {
        state.cdnRequests.push({ url: url.toString(), headers, range: headers.get('range') })
        return new Response(new Uint8Array([7]), {
          status: 206,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Accept-Ranges': 'bytes',
            'Content-Range': 'bytes 0-0/32212254720',
            'Content-Length': '1',
          },
        })
      },
    })
    const response = await requestMedia(fixture, fileId, { range: 'bytes=0-0' })
    assert.equal(response.status, 206, extension)
    assert.equal(response.headers.get('content-type'), mime, extension)
    assert.equal((await response.arrayBuffer()).byteLength, 1, extension)
  }
})

test('bad and out-of-file Range requests return 416 before downloading media', async () => {
  const fixture = await createFixture()
  const multi = await requestMedia(fixture, 'invalid-range', { range: 'bytes=0-1,4-6' })
  assert.equal(multi.status, 416)
  assert.equal(multi.headers.get('content-range'), 'bytes */*')
  const overrun = await requestMedia(fixture, 'out-of-file-range', { range: 'bytes=32212254720-32212254721' })
  assert.equal(overrun.status, 416)
  assert.equal(overrun.headers.get('content-range'), 'bytes */32212254720')
  assert.equal(fixture.state.cdnRequests.length, 0)
})

test('JPG thumbnail streams with server-side Quark cookie and never returns credentials or CDN URL', async () => {
  const fixture = await createFixture({ files: {
    'photo-thumb': mediaFile('photo-thumb', {
      file_name: '壁纸_8.jpg',
      mime_type: 'image/jpeg',
      file_ext: 'jpg',
      thumbnail_url: 'https://cdn.quark.cn/thumb/photo-thumb?auth_key=secret-cdn-query',
      extra_metadata: 'unneeded-record-data-'.repeat(400),
    }),
  } })
  const response = await requestMedia(fixture, 'photo-thumb', { purpose: 'preview', variant: 'thumbnail' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/jpeg')
  const imageBytes = await response.arrayBuffer()
  assert.equal(imageBytes.byteLength, 3)
  assert.equal(fixture.state.cdnRequests[0].headers.get('cookie'),
    'x_pan_client_id=third_party_agent;x_pan_access_token=quark-access-token-server-only;x_pan_client_token=quark-client-token-server-only')
  const cookie = cookiePair(response)
  assert.ok(cookie.startsWith(MEDIA_SESSION_COOKIE))
  const sessionToken = cookieValue(cookie)
  assert.ok(sessionToken.length < 4096)
  const sessionClaims = await verifyGrant(sessionToken, ticketSecret, { now: fixedNow, grantType: 'session' })
  assert.equal('record' in sessionClaims, false)
  assert.equal('extra_metadata' in sessionClaims, false)
  assert.equal(JSON.stringify(sessionClaims).includes('secret-cdn-query'), false)
  const returned = JSON.stringify({
    headers: [...response.headers.entries()],
    logs: fixture.state.logs,
    bodyBytes: imageBytes.byteLength,
  })
  assert.equal(returned.includes('quark-access-token-server-only'), false)
  assert.equal(returned.includes('quark-refresh-token-server-only'), false)
  assert.equal(returned.includes('quark-client-token-server-only'), false)
  assert.equal(returned.includes('secret-cdn-query'), false)
})

test('SVG preview responses apply sandbox CSP', async () => {
  const fixture = await createFixture({
    files: {
      'user-svg': mediaFile('user-svg', {
        file_name: 'user.svg',
        mime_type: 'image/svg+xml',
        file_ext: 'svg',
        thumbnail_url: 'https://cdn.quark.cn/thumb/user-svg',
      }),
    },
    cdnHandler: async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', {
      status: 200,
      headers: { 'Content-Type': 'image/svg+xml' },
    }),
  })
  const response = await requestMedia(fixture, 'user-svg', { purpose: 'preview', variant: 'thumbnail' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/svg+xml')
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox")
  await response.arrayBuffer()
})

test('upstream 416 without a video MIME remains 416 when Quark file size is unknown', async () => {
  const fixture = await createFixture({
    files: { 'stale-size-video': mediaFile('stale-size-video', { size: null, mime_type: 'video/mp4' }) },
    cdnHandler: async (_url, headers) => headers.get('range')
      ? new Response('range rejected', { status: 416, headers: { 'Content-Range': 'bytes */32212254720', 'Content-Type': 'text/html' } })
      : new Response(null, { status: 200, headers: { 'Content-Type': 'video/mp4' } }),
  })
  const response = await requestMedia(fixture, 'stale-size-video', { range: 'bytes=40000000000-' })
  assert.equal(response.status, 416)
  assert.equal(response.headers.get('content-range'), 'bytes */32212254720')
  await response.body?.cancel()
})

test('configured site domain rejects cross-site Worker media hosts', async () => {
  const fixture = await createFixture()
  const token = ticketFor('cross-site-video', {}, fixedNow)
  const response = await fixture.worker.fetch(new Request(
    'https://map7e-cloud.workers.dev/v1/media?ticket=' + encodeURIComponent(token),
    { headers: { Origin: allowedOrigin } },
  ), fixture.env)
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error, 'media_gateway_site_mismatch')
})

test('JPG preview falls back to original bytes as a stream; DNG does not fall back to original', async () => {
  const fixture = await createFixture({
    files: {
      'jpg-fallback': mediaFile('jpg-fallback', {
        file_name: '壁纸_8.jpg',
        mime_type: '',
        file_ext: 'jpg',
        preview_url: 'https://cdn.quark.cn/thumb/blocked-jpg',
      }),
      'raw-no-fallback': mediaFile('raw-no-fallback', {
        file_name: 'IMG_6069_20260722.DNG',
        mime_type: '',
        file_ext: 'dng',
        preview_url: 'https://cdn.quark.cn/thumb/blocked-raw',
      }),
    },
    cdnHandler: async (url, headers, state) => {
      state.cdnRequests.push({ url: url.toString(), headers, range: headers.get('range') })
      if (url.pathname.startsWith('/thumb/')) return new Response('blocked', { status: 412, headers: { 'Content-Type': 'text/html' } })
      return new Response(new Uint8Array([255, 216, 255]), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '3' },
      })
    },
  })
  const jpg = await requestMedia(fixture, 'jpg-fallback', { purpose: 'preview', variant: 'preview' })
  assert.equal(jpg.status, 200)
  assert.equal(jpg.headers.get('content-type'), 'image/jpeg')
  assert.equal((await jpg.arrayBuffer()).byteLength, 3)
  const dng = await requestMedia(fixture, 'raw-no-fallback', { purpose: 'preview', variant: 'preview' })
  assert.equal(dng.status, 404)
  assert.equal((await dng.json()).error, 'preview_unavailable')
  assert.equal(fixture.state.mediaUrlCount, 1)
})

test('untrusted thumbnail URL and redirect target are blocked before Worker fetches them', async () => {
  const fixture = await createFixture({
    files: {
      'bad-preview': mediaFile('bad-preview', {
        file_name: 'bad.jpg',
        file_ext: 'jpg',
        thumbnail_url: 'https://attacker.invalid/image.jpg',
      }),
      'redirect-preview': mediaFile('redirect-preview', {
        file_name: 'redirect.jpg',
        file_ext: 'jpg',
        thumbnail_url: 'https://cdn.quark.cn/thumb/redirect',
      }),
    },
    cdnHandler: async (url, headers, state) => {
      state.cdnRequests.push({ url: url.toString(), headers, range: headers.get('range') })
      return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } })
    },
  })
  const before = fixture.state.cdnRequests.length
  const bad = await requestMedia(fixture, 'bad-preview', { purpose: 'preview', variant: 'thumbnail' })
  assert.equal(bad.status, 502)
  assert.equal(fixture.state.cdnRequests.length, before)
  const redirected = await requestMedia(fixture, 'redirect-preview', { purpose: 'preview', variant: 'thumbnail' })
  assert.equal(redirected.status, 502)
  assert.equal(fixture.state.cdnRequests.length, before + 1)
})

test('Quark CDN 403 refreshes the download URL and retries exactly once', async () => {
  const fixture = await createFixture({ expireFirstMediaUrl: true })
  const response = await requestMedia(fixture, 'url-refresh-video', { range: 'bytes=0-1' })
  assert.equal(response.status, 206)
  assert.equal(await response.text(), '\u0007\u0007')
  assert.equal(fixture.state.mediaUrlCount, 2)
  assert.equal(fixture.state.cdnRequests.length, 2)
})

test('expired Quark access token is refreshed once and encrypted auth is written back to the shared Redis key', async () => {
  const expiredAuth = { ...defaultAuth, accessExpiresAt: fixedNow - 1 }
  const fixture = await createFixture({ auth: expiredAuth, authorizeRefresh: true })
  const response = await requestMedia(fixture, 'auth-refresh-video', { range: 'bytes=0-0' })
  assert.equal(response.status, 206)
  await response.arrayBuffer()
  assert.equal(fixture.state.storedRefreshes, 1)
  const fileInfo = fixture.state.apiRequests.find(value => value.url.includes('/open/v1/file/info'))
  assert.equal(fileInfo.accessToken, 'quark-access-token-refreshed')
  const saved = JSON.parse(fixture.state.authRecord)
  assert.equal(saved.version, 1)
  assert.notEqual(saved.data, '')
  assert.equal(fixture.state.redisRequests.some(commands => commands.some(command => command[0] === 'EVAL')), true)

  const nextRange = await requestMedia(fixture, 'auth-refresh-video', { range: 'bytes=100-100' })
  assert.equal(nextRange.status, 206)
  await nextRange.arrayBuffer()
  assert.equal(fixture.state.storedRefreshes, 1, 'cached auth is updated after the refresh is persisted')
  assert.equal(fixture.state.apiRequests
    .filter(value => value.url.includes('/open/v1/file/info'))
    .every(value => value.accessToken === 'quark-access-token-refreshed'), true)
})

test('ticket and session support independent seeks after the five-minute ticket expires without renewing the grant', async () => {
  const fixture = await createFixture()
  const token = ticketFor('seek-video', {}, fixedNow)
  const first = await fixture.worker.fetch(new Request(
    'https://media.example.test/v1/media?ticket=' + encodeURIComponent(token),
    { headers: { Range: 'bytes=0-0', Origin: allowedOrigin } },
  ), fixture.env)
  assert.equal(first.status, 206)
  const cookie = cookiePair(first)
  const sessionToken = cookieValue(cookie)
  const initialSession = await verifyGrant(sessionToken, ticketSecret, { now: fixedNow, grantType: 'session' })
  assert.equal(initialSession.expiresAt, Math.floor(fixedNow / 1000) + 6 * 60 * 60)
  fixture.setNow(fixedNow + 301_000)
  const second = await fixture.worker.fetch(new Request(
    'https://media.example.test/v1/media?ticket=' + encodeURIComponent(token),
    { headers: { Range: 'bytes=2000000000-2000000001', Cookie: cookie, Origin: allowedOrigin } },
  ), fixture.env)
  assert.equal(second.status, 206)
  assert.equal(second.headers.get('content-range'), 'bytes 2000000000-2000000001/32212254720')
  assert.equal(second.headers.get('set-cookie'), null, 'session-authenticated ranges do not extend their expiry')
  const verifiedAgain = await verifyGrant(sessionToken, ticketSecret, { now: fixedNow + 301_000, grantType: 'session' })
  assert.equal(verifiedAgain.expiresAt, initialSession.expiresAt)
})

test('expired Worker ticket cannot consume another file session', async () => {
  const fixture = await createFixture()
  const firstToken = ticketFor('video-A', {}, fixedNow)
  const first = await fixture.worker.fetch(new Request(
    'https://media.example.test/v1/media?ticket=' + encodeURIComponent(firstToken),
    { headers: { Range: 'bytes=0-0', Origin: allowedOrigin } },
  ), fixture.env)
  assert.equal(first.status, 206)
  const cookie = cookiePair(first)
  await first.arrayBuffer()
  const apiCalls = fixture.state.apiRequests.length
  fixture.setNow(fixedNow + 301_000)
  const secondToken = ticketFor('video-B', {}, fixedNow)
  const second = await fixture.worker.fetch(new Request(
    'https://media.example.test/v1/media?ticket=' + encodeURIComponent(secondToken),
    { headers: { Range: 'bytes=1-1', Cookie: cookie, Origin: allowedOrigin } },
  ), fixture.env)
  assert.equal(second.status, 401)
  assert.equal((await second.json()).error, 'media_ticket_expired')
  assert.equal(fixture.state.apiRequests.length, apiCalls, 'a mismatched grant is rejected before Provider lookup')
})

test('Worker keeps independent sessions for concurrently opened media files', async () => {
  const fixture = await createFixture()
  const tokenA = ticketFor('video-A', {}, fixedNow)
  const tokenB = ticketFor('video-B', {}, fixedNow)
  const firstA = await fixture.worker.fetch(new Request(
    'https://media.example.test/v1/media?ticket=' + encodeURIComponent(tokenA),
    { headers: { Range: 'bytes=0-0', Origin: allowedOrigin } },
  ), fixture.env)
  assert.equal(firstA.status, 206)
  const cookieA = cookiePair(firstA)
  await firstA.arrayBuffer()
  const firstB = await fixture.worker.fetch(new Request(
    'https://media.example.test/v1/media?ticket=' + encodeURIComponent(tokenB),
    { headers: { Range: 'bytes=0-0', Origin: allowedOrigin } },
  ), fixture.env)
  assert.equal(firstB.status, 206)
  const cookieB = cookiePair(firstB)
  await firstB.arrayBuffer()
  assert.notEqual(cookieA.split('=', 1)[0], cookieB.split('=', 1)[0])

  fixture.setNow(fixedNow + 301_000)
  const cookieHeader = cookieA + '; ' + cookieB
  const resumedA = await fixture.worker.fetch(new Request(
    'https://media.example.test/v1/media?ticket=' + encodeURIComponent(tokenA),
    { headers: { Range: 'bytes=100-101', Cookie: cookieHeader, Origin: allowedOrigin } },
  ), fixture.env)
  assert.equal(resumedA.status, 206)
  await resumedA.arrayBuffer()
  const resumedB = await fixture.worker.fetch(new Request(
    'https://media.example.test/v1/media?ticket=' + encodeURIComponent(tokenB),
    { headers: { Range: 'bytes=200-201', Cookie: cookieHeader, Origin: allowedOrigin } },
  ), fixture.env)
  assert.equal(resumedB.status, 206)
  assert.equal(resumedB.headers.get('content-range'), 'bytes 200-201/32212254720')
  await resumedB.arrayBuffer()
})

test('wrong Origin, method, arbitrary URL and invalid FID do not reach Quark media', async () => {
  const fixture = await createFixture()
  const grant = ticketFor('guarded-video')
  const url = 'https://media.example.test/v1/media?ticket=' + encodeURIComponent(grant)
  const wrongOrigin = await fixture.worker.fetch(new Request(url, { headers: { Origin: 'https://evil.example' } }), fixture.env)
  assert.equal(wrongOrigin.status, 403)
  const post = await fixture.worker.fetch(new Request(url, { method: 'POST' }), fixture.env)
  assert.equal(post.status, 405)
  const arbitrary = await fixture.worker.fetch(new Request(url + '&url=https%3A%2F%2Fevil.example%2Ffile'), fixture.env)
  assert.equal(arbitrary.status, 400)
  assert.equal(fixture.state.apiRequests.length, 0)
  assert.equal(quarkFidsMatch('a|opaque', 'b|opaque'), true)
  assert.equal(quarkFidsMatch('opaque-a', 'opaque-b'), false)
})
