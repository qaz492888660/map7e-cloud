import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import test from 'node:test'
import { createMediaTicket, verifyMediaSession, mediaSessionPath } from '../../../lib/storage/media-ticket.js'
import { createMediaGatewayHandler, MEDIA_SESSION_COOKIE, parseSingleRange } from '../src/gateway.js'
import { StorageError } from '../../../lib/storage/errors.js'
import { CookieJar, legacyCookie } from './session-cookie-fixture.js'

const secret = 'gateway-test-secret-with-at-least-32-bytes-long'
const allowedOrigin = 'https://cloud.map7e.com'

function createItem(overrides = {}) {
  return { id: 'video-1', parentId: '', isFolder: false, name: 'sample.mp4', extension: 'mp4', mimeType: 'video/mp4', size: 32212254720, ...overrides }
}

function partialResponse(range, total = '32212254720') {
  const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range)
  const length = Number(end) - Number(start) + 1
  return new Response(new Uint8Array(length).fill(7), { status: 206, headers: {
    'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${total}`,
    'Content-Length': String(length), ETag: '"media-v1"', 'Last-Modified': 'Thu, 01 Oct 2026 12:00:00 GMT',
  } })
}

function responseCookies(response) {
  return typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean)
}
function cookiePair(response) { return responseCookies(response).at(-1).split(';', 1)[0] }
function cookieValue(pair) { return pair.slice(pair.indexOf('=') + 1) }
function applySetCookies(lines, jar) {
  for (const line of lines) {
    const pair = line.split(';', 1)[0]
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    const name = pair.slice(0, separator)
    if (/(?:^|;)\s*Max-Age=0(?:;|$)/i.test(line)) jar.delete(name)
    else jar.set(name, pair.slice(separator + 1))
  }
}

async function startServer({ provider, resolveStorage, now = Date.now, logs = [] } = {}) {
  const storageProvider = provider || {
    getItem: async id => createItem({ id }),
    getFileResponse: async (id, { range }) => partialResponse(range || 'bytes=0-0'),
    getPreview: async () => new Response(new Uint8Array([1]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }),
    getThumbnail: async () => new Response(new Uint8Array([1]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }),
  }
  const resolver = resolveStorage || (async storageId => {
    if (storageId !== 'quark-main') throw Object.assign(new Error('storage_not_found'), { code: 'storage_not_found', status: 404 })
    return { instance: { storageId, provider: 'quark' }, auth: { accessToken: 'server-only-quark-secret' }, provider: storageProvider }
  })
  const handler = createMediaGatewayHandler({
    env: { MEDIA_GATEWAY_SIGNING_SECRET: secret, MEDIA_GATEWAY_ALLOWED_ORIGIN: allowedOrigin },
    resolveStorageImpl: resolver,
    now,
    logger: entry => logs.push(entry),
  })
  const originalFetch = globalThis.fetch
  const baseUrl = 'http://media-gateway.test'
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input)
    if (url.origin !== baseUrl) return originalFetch(input, init)
    const request = new EventEmitter()
    request.url = `${url.pathname}${url.search}`
    request.method = init.method || 'GET'
    request.headers = Object.fromEntries(new Headers(init.headers || {}).entries())
    request.aborted = false
    const chunks = []
    class MemoryResponse extends Writable {
      constructor() { super(); this.headers = {}; this.statusCode = 200; this.headersSent = false }
      _write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); this.headersSent = true; callback() }
      setHeader(name, value) { this.headers[name.toLowerCase()] = value }
      hasHeader(name) { return Object.hasOwn(this.headers, name.toLowerCase()) }
      end(chunk, encoding, callback) { this.headersSent = true; return super.end(chunk, encoding, callback) }
    }
    const response = new MemoryResponse()
    const onAbort = () => { request.aborted = true; request.emit('aborted') }
    if (init.signal?.aborted) onAbort()
    else init.signal?.addEventListener('abort', onAbort, { once: true })
    try { await handler(request, response) }
    finally { init.signal?.removeEventListener('abort', onAbort) }
    const body = request.method === 'HEAD' || chunks.length === 0 ? null : Buffer.concat(chunks)
    const headers = new Headers()
    for (const [name, value] of Object.entries(response.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item)
      else headers.set(name, value)
    }
    return new Response(body, { status: response.statusCode, headers })
  }
  const server = { close: async () => { globalThis.fetch = originalFetch } }
  return { server, baseUrl, provider: storageProvider, logs }
}

async function closeServer(server) {
  await server.close()
}

function ticket({ storageId = 'quark-main', fileId = 'video-1', parentId = '', purpose = 'video', variant, disposition } = {}, now = Date.now()) {
  return createMediaTicket({ storageId, fileId, parentId, purpose, ...(variant ? { variant } : {}), ...(disposition ? { disposition } : {}) }, { secret, now })
}

await test('health is minimal and media accepts only GET or HEAD', async () => {
  let resolutions = 0
  const { server, baseUrl } = await startServer({ resolveStorage: async () => { resolutions += 1; throw Error('unexpected') } })
  try {
    const health = await fetch(`${baseUrl}/health`)
    assert.deepEqual(await health.json(), { ok: true, version: '0.1.0' })
    const post = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(ticket())}`), { method: 'POST' })
    assert.equal(post.status, 405)
    assert.equal((await post.json()).error, 'method_not_allowed')
    assert.equal(resolutions, 0)
  } finally { await closeServer(server) }
})

await test('HEAD on an empty original returns 200 without an upstream probe', async () => {
  let upstreamCalls = 0
  const provider = {
    getItem: async id => createItem({ id, name: 'empty.mp4', size: 0 }),
    getFileResponse: async () => { upstreamCalls += 1; throw new Error('empty file should not be probed') },
  }
  const { server, baseUrl } = await startServer({ provider })
  try {
    const emptyTicket = ticket({ purpose: 'original', fileId: 'empty-video' })
    const response = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(emptyTicket)}`), { method: 'HEAD' })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'video/mp4')
    assert.equal(response.headers.get('content-length'), '0')
    assert.equal(upstreamCalls, 0)
  } finally { await closeServer(server) }
})

await test('Node Gateway exposes safe size-policy headers for GET and bodyless HEAD', async () => {
  let reads = 0
  const { server, baseUrl } = await startServer({ provider: {
    getItem: async () => createItem({ size: 848086961 }),
    getFileResponse: async () => {
      reads += 1
      throw Object.assign(new StorageError('quark_file_size_limit', 422), { limitBytes: 52428800 })
    },
  } })
  try {
    for (const method of ['GET', 'HEAD']) {
      const result = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(ticket())}`), { method, headers: { Range: 'bytes=0-0' } })
      assert.equal(result.status, 422)
      assert.equal(result.headers.get('x-media-error'), 'quark_file_size_limit')
      assert.equal(result.headers.get('x-media-limit-bytes'), '52428800')
      if (method === 'GET') assert.deepEqual(await result.json(), {
        ok: false, error: 'quark_file_size_limit', limitBytes: 52428800,
        message: '当前夸克接口限制单文件下载大小为 50 MiB，此文件暂不支持站内播放或下载。',
      })
      else assert.equal(await result.text(), '')
    }
    assert.equal(reads, 2, 'one upstream read per user request')
  } finally { await closeServer(server) }
})
await test('Range parser accepts a single range and rejects malformed, multi and out-of-file ranges', () => {
  assert.equal(parseSingleRange('bytes=0-1023', 2048).header, 'bytes=0-1023')
  assert.equal(parseSingleRange('bytes=1024-2047', 4096).start, 1024)
  assert.equal(parseSingleRange('bytes=1024-', 4096).end, null)
  assert.deepEqual(parseSingleRange('bytes=-1024', 4096), { header: 'bytes=-1024', start: null, end: 1024 })
  assert.throws(() => parseSingleRange('bytes=0-1,3-4', 10), /range_not_satisfiable/)
  assert.throws(() => parseSingleRange('bytes=5-3', 10), /range_not_satisfiable/)
  assert.throws(() => parseSingleRange('bytes=2048-2049', 2048), /range_not_satisfiable/)
})

await test('video first and middle Range requests stream as 206 with safe headers and no Quark credential', async () => {
  const ranges = []
  const ifRanges = []
  const logs = []
  const provider = {
    getItem: async id => createItem({ id }),
    getFileResponse: async (id, { range, ifRange }) => { ranges.push(range); ifRanges.push(ifRange || null); return partialResponse(range) },
  }
  const { server, baseUrl } = await startServer({ provider, logs })
  try {
    const grant = ticket({ disposition: 'inline' })
    const first = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(grant)}`), { headers: { Range: 'bytes=0-1023', 'If-Range': '"media-v1"', Origin: allowedOrigin } })
    assert.equal(first.status, 206)
    assert.equal(first.headers.get('content-type'), 'video/mp4')
    assert.equal(first.headers.get('content-range'), 'bytes 0-1023/32212254720')
    assert.equal(first.headers.get('content-length'), '1024')
    assert.equal(first.headers.get('accept-ranges'), 'bytes')
    assert.equal(first.headers.get('access-control-allow-origin'), allowedOrigin)
    const firstBytes = new Uint8Array(await first.arrayBuffer())
    assert.equal(firstBytes.length, 1024)
    assert.equal(first.headers.get('set-cookie').includes('server-only-quark-secret'), false)

    const middle = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(grant)}`), { headers: { Range: 'bytes=1048576-1049599', Origin: allowedOrigin } })
    assert.equal(middle.status, 206)
    assert.equal(middle.headers.get('content-range'), 'bytes 1048576-1049599/32212254720')
    assert.equal((await middle.arrayBuffer()).byteLength, 1024)
    assert.deepEqual(ranges, ['bytes=0-1023', 'bytes=1048576-1049599'])
    assert.deepEqual(ifRanges, ['"media-v1"', null])
    assert.equal(JSON.stringify(logs).includes(grant), false)
    assert.equal(JSON.stringify(logs).includes('server-only-quark-secret'), false)
    assert.equal('ticket' in logs[0], false)
    assert.equal(logs[0].fileHash.length, 16)
  } finally { await closeServer(server) }
})

await test('SVG previews receive a sandbox CSP on the media response', async () => {
  const provider = {
    getItem: async id => createItem({ id, name: 'user.svg', extension: 'svg', mimeType: 'image/svg+xml' }),
    getThumbnail: async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', {
      status: 200,
      headers: { 'Content-Type': 'image/svg+xml' },
    }),
  }
  const { server, baseUrl } = await startServer({ provider })
  try {
    const response = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(ticket({ purpose: 'preview', variant: 'thumbnail' }))}`))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/svg+xml')
    assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox")
    assert.equal(response.headers.get('set-cookie'), null, 'preview responses do not create long-lived file-scoped browser cookies')
    await response.arrayBuffer()
  } finally { await closeServer(server) }
})

await test('upstream 416 without a video MIME remains 416 for a stale unknown size', async () => {
  const provider = {
    getItem: async id => createItem({ id, size: null }),
    getFileResponse: async () => new Response('range rejected', {
      status: 416,
      headers: { 'Content-Range': 'bytes */32212254720', 'Content-Type': 'text/html' },
    }),
  }
  const { server, baseUrl } = await startServer({ provider })
  try {
    const response = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(ticket())}`), {
      headers: { Range: 'bytes=40000000000-', Origin: allowedOrigin },
    })
    assert.equal(response.status, 416)
    assert.equal(response.headers.get('content-range'), 'bytes */32212254720')
    await response.body?.cancel()
  } finally { await closeServer(server) }
})

await test('invalid upstream Content-Range and Content-Length are rejected', async () => {
  const provider = {
    getItem: async id => createItem({ id }),
    getFileResponse: async () => new Response(new Uint8Array(8), { status: 206, headers: {
      'Content-Type': 'video/mp4', 'Content-Range': 'bytes 100-109/32212254720', 'Content-Length': '8',
    } }),
  }
  const { server, baseUrl } = await startServer({ provider })
  try {
    const response = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(ticket())}`), { headers: { Range: 'bytes=100-109' } })
    assert.equal(response.status, 502)
    assert.equal((await response.json()).error, 'range_response_invalid')
  } finally { await closeServer(server) }
})

await test('failed GET and HEAD Range validation cancels the upstream body without hiding the original error', async () => {
  const cases = [
    { status: 200, headers: {}, error: 'range_not_supported' },
    { status: 206, headers: { 'Content-Range': 'bytes 1-1/32212254720', 'Content-Length': '1' }, error: 'range_response_invalid' },
    { status: 206, headers: { 'Content-Range': 'bytes 0-0/32212254720', 'Content-Length': '2' }, error: 'range_response_invalid', cancelRejects: true },
  ]
  for (const method of ['GET', 'HEAD']) for (const sample of cases) {
    let cancellations = 0
    const upstreamBody = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1])) },
      cancel() {
        cancellations += 1
        if (sample.cancelRejects) throw new Error('cancel failed')
      },
    })
    const provider = {
      getItem: async id => createItem({ id }),
      getFileResponse: async () => new Response(upstreamBody, {
        status: sample.status, headers: { 'Content-Type': 'video/mp4', ...sample.headers },
      }),
    }
    const { server, baseUrl, logs } = await startServer({ provider })
    try {
      const response = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(ticket())}`), {
        method, ...(method === 'GET' ? { headers: { Range: 'bytes=0-0' } } : {}),
      })
      assert.equal(response.status, 502)
      if (method === 'GET') assert.equal((await response.json()).error, sample.error)
      assert.equal(logs[0].errorCode, sample.error)
      assert.equal(logs[0].bytesStreamed, 0)
      assert.equal(cancellations, 1)
    } finally { await closeServer(server) }
  }
})

await test('short ticket establishes a scoped session so later Range requests survive ticket expiry', async () => {
  let now = 1_800_000_000_000
  const ranges = []
  const provider = {
    getItem: async id => createItem({ id }),
    getFileResponse: async (id, { range }) => { ranges.push(range); return partialResponse(range) },
  }
  const { server, baseUrl } = await startServer({ provider, now: () => now })
  try {
    const grant = ticket({ disposition: 'inline' }, now)
    const first = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(grant)}`), { headers: { Range: 'bytes=0-0' } })
    assert.equal(first.status, 206)
    const sessionCookie = cookiePair(first)
    assert.ok(sessionCookie.startsWith(MEDIA_SESSION_COOKIE))
    const sessionToken = cookieValue(sessionCookie)
    const initialSession = verifyMediaSession(sessionToken, secret, { now })
    assert.equal(initialSession.expiresAt, Math.floor(now / 1000) + 6 * 60 * 60)
    await first.arrayBuffer()
    now += 301_000
    const resumed = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(grant)}`), { headers: { Range: 'bytes=100-101', Cookie: sessionCookie } })
    assert.equal(resumed.status, 206)
    assert.equal(resumed.headers.get('content-range'), 'bytes 100-101/32212254720')
    assert.equal(resumed.headers.get('set-cookie'), null, 'session-authenticated ranges do not renew the six-hour grant')
    assert.equal((await resumed.arrayBuffer()).byteLength, 2)
    assert.equal(verifyMediaSession(sessionToken, secret, { now }).expiresAt, initialSession.expiresAt)
    assert.deepEqual(ranges, ['bytes=0-0', 'bytes=100-101'])
  } finally { await closeServer(server) }
})

await test('expired ticket cannot use a different file session and original downloads can be inline', async () => {
  let now = 1_800_000_000_000
  const reads = []
  const provider = {
    getItem: async id => { reads.push(id); return createItem({ id }) },
    getFileResponse: async (id, { range }) => partialResponse(range || 'bytes=0-0'),
  }
  const { server, baseUrl } = await startServer({ provider, now: () => now })
  try {
    const fileATicket = ticket({ fileId: 'video-A', disposition: 'inline' }, now)
    const first = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(fileATicket)}`), { headers: { Range: 'bytes=0-0' } })
    const cookie = cookiePair(first)
    await first.arrayBuffer()
    const inlineOriginal = ticket({ fileId: 'document.pdf', purpose: 'original', disposition: 'inline' }, now)
    const inline = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(inlineOriginal)}`))
    assert.equal(inline.status, 206)
    assert.match(inline.headers.get('content-disposition'), /^inline;/)
    assert.equal(inline.headers.get('content-security-policy'), "default-src 'none'; sandbox")
    assert.equal(inline.headers.get('set-cookie'), null, 'one-shot original responses do not create session cookies')
    await inline.arrayBuffer()

    const fileBTicket = ticket({ fileId: 'video-B', disposition: 'inline' }, now)
    now += 301_000
    const mismatched = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(fileBTicket)}`), {
      headers: { Range: 'bytes=1-1', Cookie: cookie },
    })
    assert.equal(mismatched.status, 401)
    assert.equal((await mismatched.json()).error, 'media_ticket_expired')
    assert.deepEqual(reads, ['video-A', 'document.pdf'], 'a mismatched expired ticket is rejected before a file lookup')

    const videoDownload = ticket({ fileId: 'video-download', disposition: 'attachment' }, now)
    const download = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(videoDownload)}`), {
      headers: { Range: 'bytes=0-0' },
    })
    assert.equal(download.status, 206)
    assert.equal(download.headers.get('set-cookie'), null, 'one-shot video downloads do not create session cookies')
    await download.arrayBuffer()
  } finally { await closeServer(server) }
})

await test('simultaneous first requests keep video sessions independent by media identity', async () => {
  let now = 1_800_000_000_000
  const provider = {
    getItem: async id => createItem({ id }),
    getFileResponse: async (_id, { range }) => partialResponse(range || 'bytes=0-0'),
  }
  const { server, baseUrl } = await startServer({ provider, now: () => now })
  try {
    const ticketA = ticket({ fileId: 'video-A', disposition: 'inline' }, now)
    const ticketB = ticket({ fileId: 'video-B', disposition: 'inline' }, now)
    // Both initial requests use the same empty cookie snapshot.
    const [firstA, firstB] = await Promise.all([
      fetch(scopedUrl(baseUrl + '/v1/media?ticket=' + encodeURIComponent(ticketA)), { headers: { Range: 'bytes=0-0' } }),
      fetch(scopedUrl(baseUrl + '/v1/media?ticket=' + encodeURIComponent(ticketB)), { headers: { Range: 'bytes=0-0' } }),
    ])
    assert.equal(firstA.status, 206)
    assert.equal(firstB.status, 206)
    const cookieA = cookiePair(firstA)
    const cookieB = cookiePair(firstB)
    await Promise.all([firstA.arrayBuffer(), firstB.arrayBuffer()])
    const nameA = cookieA.split('=', 1)[0]
    const nameB = cookieB.split('=', 1)[0]
    assert.ok(nameA.startsWith(MEDIA_SESSION_COOKIE))
    assert.ok(nameB.startsWith(MEDIA_SESSION_COOKIE))
    assert.notEqual(nameA, nameB)

    now += 301_000
    const cookieHeader = cookieA + '; ' + cookieB
    const resumedA = await fetch(scopedUrl(baseUrl + '/v1/media?ticket=' + encodeURIComponent(ticketA)), {
      headers: { Range: 'bytes=100-101', Cookie: cookieHeader },
    })
    assert.equal(resumedA.status, 206)
    await resumedA.arrayBuffer()
    const resumedB = await fetch(scopedUrl(baseUrl + '/v1/media?ticket=' + encodeURIComponent(ticketB)), {
      headers: { Range: 'bytes=200-201', Cookie: cookieHeader },
    })
    assert.equal(resumedB.status, 206)
    assert.equal(resumedB.headers.get('content-range'), 'bytes 200-201/32212254720')
    await resumedB.arrayBuffer()
  } finally { await closeServer(server) }
})

await test('video sessions use distinct cookie paths without evicting other files', async () => {
  let now = 1_800_000_000_000
  const provider = {
    getItem: async id => createItem({ id }),
    getFileResponse: async (_id, { range }) => partialResponse(range || 'bytes=0-0'),
  }
  const { server, baseUrl } = await startServer({ provider, now: () => now })
  try {
    const jar = new Map()
    const tickets = []
    for (let index = 0; index < 12; index += 1) {
      const grant = ticket({ fileId: 'bounded-video-' + index, disposition: 'inline' }, now)
      tickets.push(grant)
      const response = await fetch(scopedUrl(baseUrl + '/v1/media?ticket=' + encodeURIComponent(grant)), {
        headers: { Range: 'bytes=0-0', Cookie: [...jar].map(([name, value]) => name + '=' + value).join('; ') },
      })
      assert.equal(response.status, 206)
      applySetCookies(responseCookies(response), jar)
      assert.equal(jar.size, index + 1)
      await response.arrayBuffer()
    }
    assert.equal(jar.size, 12)
    now += 301_000
    const cookie = [...jar].map(([name, value]) => name + '=' + value).join('; ')
    const oldest = await fetch(scopedUrl(baseUrl + '/v1/media?ticket=' + encodeURIComponent(tickets[0])), {
      headers: { Range: 'bytes=100-100', Cookie: cookie },
    })
    assert.equal(oldest.status, 206)
    await oldest.arrayBuffer()
    const newest = await fetch(scopedUrl(baseUrl + '/v1/media?ticket=' + encodeURIComponent(tickets.at(-1))), {
      headers: { Range: 'bytes=200-200', Cookie: cookie },
    })
    assert.equal(newest.status, 206)
    assert.equal(newest.headers.get('content-range'), 'bytes 200-200/32212254720')
    await newest.arrayBuffer()
  } finally { await closeServer(server) }
})

await test('oversized legacy cookie headers are parsed and stale media cookies are cleared', async () => {
  const provider = {
    getItem: async id => createItem({ id }),
    getFileResponse: async (_id, { range }) => partialResponse(range || 'bytes=0-0'),
  }
  const { server, baseUrl } = await startServer({ provider })
  try {
    const legacyCookies = Array.from({ length: 24 }, (_, index) =>
      '__Host-map7e-media-' + index.toString(36).padStart(22, 'a') + '=' + 'x'.repeat(400))
    const cookie = legacyCookies.join('; ')
    assert.ok(cookie.length > 8192)
    const grant = ticket({ fileId: 'new-after-legacy-cookies', disposition: 'inline' })
    const response = await fetch(scopedUrl(baseUrl + '/v1/media?ticket=' + encodeURIComponent(grant)), {
      headers: { Range: 'bytes=0-0', Cookie: cookie },
    })
    assert.equal(response.status, 206)
    const setCookies = responseCookies(response)
    assert.equal(setCookies.filter(line => /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(line)).length, 24)
    assert.ok(setCookies.at(-1).startsWith(MEDIA_SESSION_COOKIE))
    await response.arrayBuffer()
  } finally { await closeServer(server) }
})

await test('filename truncation keeps Unicode Content-Disposition headers well formed', async () => {
  const names = {
    'emoji-video': 'x'.repeat(239) + '😀.mp4',
    'lone-video': 'bad\uD800.mp4',
  }
  const provider = {
    getItem: async id => createItem({ id, name: names[id] }),
    getFileResponse: async (_id, { range }) => partialResponse(range || 'bytes=0-0'),
  }
  const now = 1_800_000_000_000
  const { server, baseUrl } = await startServer({ provider, now: () => now })
  try {
    const cases = [
      ['emoji-video', 'x'.repeat(239)],
      ['lone-video', 'bad\uFFFD.mp4'],
    ]
    for (const [fileId, expected] of cases) {
      const grant = ticket({ fileId }, now)
      const response = await fetch(scopedUrl(baseUrl + '/v1/media?ticket=' + encodeURIComponent(grant)), {
        headers: { Range: 'bytes=0-0' },
      })
      assert.equal(response.status, 206)
      const disposition = response.headers.get('content-disposition')
      const encodedName = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1]
      assert.ok(encodedName)
      assert.equal(decodeURIComponent(encodedName), expected)
      await response.arrayBuffer()
    }
  } finally { await closeServer(server) }
})

await test('expired, tampered and wrong-storage tickets are refused before media reads', async () => {
  let now = 1_800_000_000_000
  let reads = 0
  const provider = { getItem: async id => { reads += 1; return createItem({ id }) }, getFileResponse: async () => partialResponse('bytes=0-0') }
  const { server, baseUrl } = await startServer({ provider, now: () => now })
  try {
    const expired = ticket({}, now)
    now += 301_000
    const expiredResponse = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(expired)}`))
    assert.equal(expiredResponse.status, 401)
    assert.equal((await expiredResponse.json()).error, 'media_ticket_expired')

    const invalid = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=bad`))
    assert.equal(invalid.status, 401)

    const otherStorage = ticket({ storageId: 'missing-storage' }, now)
    const wrongStorage = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(otherStorage)}`))
    assert.equal(wrongStorage.status, 404)
    assert.equal(reads, 0)
  } finally { await closeServer(server) }
})

await test('gateway rejects arbitrary URL input, extra purpose input, and unapproved Origin', async () => {
  let reads = 0
  const provider = { getItem: async id => { reads += 1; return createItem({ id }) }, getFileResponse: async () => partialResponse('bytes=0-0') }
  const { server, baseUrl } = await startServer({ provider })
  try {
    const grant = ticket()
    const arbitrary = await fetch(scopedUrl(`${baseUrl}/v1/media?url=${encodeURIComponent('https://attacker.test/file')}&ticket=${encodeURIComponent(grant)}`))
    assert.equal(arbitrary.status, 400)
    const suppliedPurpose = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(grant)}&purpose=original`))
    assert.equal(suppliedPurpose.status, 400)
    const wrongOrigin = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(grant)}`), { headers: { Origin: 'https://attacker.test' } })
    assert.equal(wrongOrigin.status, 403)
    assert.equal(reads, 0)
  } finally { await closeServer(server) }
})

await test('JPG preview falls back to original streaming while DNG preview remains unavailable', async () => {
  let originalCalls = 0
  const provider = {
    getItem: async id => createItem({ id, name: id === 'jpg' ? 'photo.jpg' : 'raw.dng', extension: id === 'jpg' ? 'jpg' : 'dng', mimeType: '' }),
    getPreview: async () => new Response('blocked', { status: 412, headers: { 'Content-Type': 'text/html' } }),
    getThumbnail: async () => new Response('blocked', { status: 412, headers: { 'Content-Type': 'text/html' } }),
    getFileResponse: async () => { originalCalls += 1; return new Response(new Uint8Array([255, 216, 217]), { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '3' } }) },
  }
  const { server, baseUrl } = await startServer({ provider })
  try {
    const jpg = ticket({ fileId: 'jpg', purpose: 'preview', variant: 'preview' })
    const jpgResponse = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(jpg)}`))
    assert.equal(jpgResponse.status, 200)
    assert.equal(jpgResponse.headers.get('content-type'), 'image/jpeg')
    assert.deepEqual([...new Uint8Array(await jpgResponse.arrayBuffer())], [255, 216, 217])
    const raw = ticket({ fileId: 'raw', purpose: 'preview', variant: 'preview' })
    const rawResponse = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(raw)}`))
    assert.equal(rawResponse.status, 404)
    assert.equal((await rawResponse.json()).error, 'preview_unavailable')
    assert.equal(originalCalls, 1)
  } finally { await closeServer(server) }
})

await test('cancelled Node raster preview does not start an original fallback', async () => {
  const controller = new AbortController(), started = Promise.withResolvers()
  let originals = 0, previews = 0
  const provider = {
    getItem: async id => createItem({ id, name: 'photo.jpg', extension: 'jpg' }),
    getPreview: async (id, { signal }) => { previews += 1; started.resolve(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private cancellation')), { once: true })) },
    getFileResponse: async () => { originals += 1; throw new Error('original must not start') },
  }
  const { server, baseUrl, logs } = await startServer({ provider })
  try {
    const response = fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(ticket({ purpose: 'preview', variant: 'preview' }))}`), { signal: controller.signal })
    await started.promise
    controller.abort()
    const result = await response
    assert.equal(result.status, 499)
    assert.equal((await result.json()).error, 'media_request_cancelled')
    assert.equal(previews, 1)
    assert.equal(originals, 0)
    assert.equal(logs.at(-1).bytesStreamed, 0)
    assert.equal(JSON.stringify(logs).includes('private'), false)
  } finally { await closeServer(server) }
})

await test('already cancelled Node request never starts a preview or original', async () => {
  const controller = new AbortController()
  controller.abort()
  let mediaCalls = 0
  const provider = {
    getItem: async id => createItem({ id, name: 'photo.jpg', extension: 'jpg' }),
    getPreview: async () => { mediaCalls += 1; throw new Error('preview must not start') },
    getFileResponse: async () => { mediaCalls += 1; throw new Error('original must not start') },
  }
  const { server, baseUrl } = await startServer({ provider })
  try {
    const result = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(ticket({ purpose: 'preview', variant: 'preview' }))}`), { signal: controller.signal })
    assert.equal(result.status, 499)
    assert.equal(mediaCalls, 0)
  } finally { await closeServer(server) }
})

await test('thumbnail 412 does not fall back to full original and HEAD probes one byte only', async () => {
  const fullRanges = []
  const provider = {
    getItem: async id => createItem({ id, name: 'photo.jpg', extension: 'jpg' }),
    getThumbnail: async () => new Response('blocked', { status: 412, headers: { 'Content-Type': 'text/html' } }),
    getFileResponse: async (id, { range }) => { fullRanges.push(range); return partialResponse(range || 'bytes=0-0') },
  }
  const { server, baseUrl } = await startServer({ provider })
  try {
    const thumb = ticket({ purpose: 'preview', variant: 'thumbnail' })
    const response = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(thumb)}`))
    assert.equal(response.status, 404)
    await response.arrayBuffer()
    assert.deepEqual(fullRanges, [])

    const video = ticket({ fileId: 'video-1', purpose: 'video' })
    const head = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(video)}`), { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), '32212254720')
    assert.equal(head.headers.get('accept-ranges'), 'bytes')
    assert.equal(head.headers.get('content-range'), null)
    assert.deepEqual(fullRanges, ['bytes=0-0'])
  } finally { await closeServer(server) }
})

await test('invalid and multipart Range requests return 416 before an upstream read', async () => {
  let reads = 0
  const provider = {
    getItem: async id => createItem({ id }),
    getFileResponse: async () => { reads += 1; return partialResponse('bytes=0-0') },
  }
  const { server, baseUrl } = await startServer({ provider })
  try {
    const grant = ticket()
    for (const range of ['bytes=5-2', 'bytes=0-1,3-4', 'bytes=32212254720-']) {
      const response = await fetch(scopedUrl(`${baseUrl}/v1/media?ticket=${encodeURIComponent(grant)}`), { headers: { Range: range } })
      assert.equal(response.status, 416)
      assert.equal((await response.json()).error, 'range_not_satisfiable')
    }
    assert.equal(reads, 0)
  } finally { await closeServer(server) }
})

await test('30 GB Content-Length streams independently of the total file size', async () => {
  const grant = ticket()
  const provider = {
    getItem: async id => createItem({ id }),
    getFileResponse: async () => {
      const response = new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })
      response.headers.set('Content-Length', '32212254720')
      response.arrayBuffer = async () => { throw new Error('whole-response-buffering-forbidden') }
      return response
    },
  }
  const handler = createMediaGatewayHandler({
    env: { MEDIA_GATEWAY_SIGNING_SECRET: secret },
    resolveStorageImpl: async storageId => ({ instance: { storageId, provider: 'quark' }, auth: { accessToken: 'secret' }, provider }),
    logger: () => {},
  })
  const req = new EventEmitter()
  req.url = scopedUrl(`/v1/media?ticket=${encodeURIComponent(grant)}`)
  req.method = 'GET'
  req.headers = {}
  class CaptureResponse extends Writable {
    constructor() { super(); this.headers = {}; this.bytes = [] }
    _write(chunk, encoding, callback) { this.bytes.push(Buffer.from(chunk)); this.headersSent = true; callback() }
    setHeader(name, value) { this.headers[name.toLowerCase()] = value }
    hasHeader(name) { return Object.keys(this.headers).some(key => key.toLowerCase() === name.toLowerCase()) }
    getHeader(name) { return this.headers[name.toLowerCase()] }
    end(chunk, encoding, callback) { return super.end(chunk, encoding, callback) }
  }
  const res = new CaptureResponse()
  await handler(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-length'], '32212254720')
  assert.equal(Buffer.concat(res.bytes).length, 3)
})

// Fixture URLs follow the same identity path that Cloud now issues.
function scopedUrl(input) {
  const url = new URL(input, 'http://media-gateway.test')
  if (url.pathname !== '/v1/media') return input
  try {
    const token = url.searchParams.get('ticket')
    const claims = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'))
    url.pathname = mediaSessionPath(claims, secret)
    return url.toString()
  } catch { return input }
}

await test('concurrent videos at the former eight-cookie cap send only their own grant and retain six-hour expiry', async () => {
  let now = 1_800_000_000_000
  const { server, baseUrl } = await startServer({ now: () => now })
  const jar = new CookieJar()
  const urls = Array.from({ length: 20 }, (_, index) => scopedUrl(baseUrl + '/v1/media?ticket='
    + encodeURIComponent(ticket({ fileId: 'parallel-' + index, disposition: 'inline' }, now))))
  const request = url => fetch(url, { headers: { Range: 'bytes=0-0', Cookie: jar.header(url) } })
  try {
    for (const url of urls.slice(0, 8)) {
      const response = await request(url)
      assert.equal(response.status, 206)
      jar.apply(responseCookies(response))
      await response.arrayBuffer()
    }
    const responses = await Promise.all(urls.slice(8).map(request))
    for (const response of responses.reverse()) {
      assert.equal(response.status, 206)
      const lines = responseCookies(response)
      assert.equal(lines.length, 1)
      assert.match(lines[0], /; Path=\/v1\/media\/[A-Za-z0-9_-]{22};/)
      assert.match(lines[0], /; Secure; HttpOnly; SameSite=Strict$/)
      assert.doesNotMatch(lines[0], /; Domain=/i)
      jar.apply(lines)
      await response.arrayBuffer()
    }
    assert.equal(jar.cookies.size, 20)
    now += 301_000
    for (const url of urls) {
      assert.equal(jar.header(url).split('; ').length, 1)
      const response = await request(url)
      assert.equal(response.status, 206)
      assert.equal(response.headers.get('set-cookie'), null)
      await response.arrayBuffer()
    }
    now += 6 * 60 * 60 * 1000
    assert.equal((await request(urls[0])).status, 401)
  } finally { await closeServer(server) }
})

await test('legacy URLs redirect without reading upstream and legacy grants migrate without prolonging expiry or metadata', async () => {
  let now = 1_800_000_000_000
  const reads = []
  const provider = { getItem: async id => { reads.push(id); return createItem({ id }) }, getFileResponse: async (_id, { range }) => partialResponse(range || 'bytes=0-0') }
  const { server, baseUrl } = await startServer({ provider, now: () => now })
  const tokens = ['legacy-A', 'legacy-B'].map(fileId => ticket({ fileId, disposition: 'inline' }, now))
  const jar = new CookieJar()
  jar.apply(tokens.map(token => legacyCookie(token, secret, now).line))
  try {
    now += 301_000
    const redirect = await fetch(baseUrl + '/v1/media?ticket=' + encodeURIComponent(tokens[0]), { redirect: 'manual' })
    assert.equal(redirect.status, 307)
    assert.deepEqual(reads, [])
    assert.equal(redirect.headers.get('set-cookie'), null)
    assert.equal(redirect.headers.get('cache-control'), 'private, no-store')
    const urlA = new URL(redirect.headers.get('location'), baseUrl).toString()
    const upgraded = await fetch(urlA, { headers: { Range: 'bytes=0-0', Cookie: jar.header(urlA) } })
    assert.equal(upgraded.status, 206)
    jar.apply(responseCookies(upgraded))
    await upgraded.arrayBuffer()
    assert.equal(jar.cookies.size, 2, 'other valid legacy grants remain available for their own file request')
    for (const cookie of jar.cookies.values()) {
      const claims = verifyMediaSession(cookie.value, secret, { now })
      assert.equal(claims.expiresAt, 1_800_000_000 + 1800)
      if (cookie.path !== '/') assert.equal(claims.record, undefined)
    }
    const urlB = scopedUrl(baseUrl + '/v1/media?ticket=' + encodeURIComponent(tokens[1]))
    const migratedB = await fetch(urlB, { headers: { Range: 'bytes=0-0', Cookie: jar.header(urlB) } })
    assert.equal(migratedB.status, 206)
    jar.apply(responseCookies(migratedB))
    await migratedB.arrayBuffer()
    assert.ok([...jar.cookies.values()].every(cookie => cookie.path.startsWith('/v1/media/')))
    now = 1_800_000_000_000 + 1801_000
    assert.equal((await fetch(urlB, { headers: { Range: 'bytes=0-0', Cookie: jar.header(urlB) } })).status, 401)
  } finally { await closeServer(server) }
})

await test('scoped media path mismatches are rejected before Provider reads', async () => {
  const reads = []
  const { server, baseUrl } = await startServer({ provider: { getItem: async id => { reads.push(id); return createItem({ id }) } } })
  try {
    const urlA = new URL(scopedUrl(baseUrl + '/v1/media?ticket=' + encodeURIComponent(ticket({ fileId: 'path-A' }))))
    const urlB = new URL(scopedUrl(baseUrl + '/v1/media?ticket=' + encodeURIComponent(ticket({ fileId: 'path-B' }))))
    urlA.pathname = urlB.pathname
    assert.equal((await fetch(urlA.toString())).status, 401)
    assert.deepEqual(reads, [])
  } finally { await closeServer(server) }
})

await test('legacy HEAD stays compatible with Cloud manual range checks and invalid duplicate cookies cannot shadow a valid grant', async () => {
  let now = 1_800_000_000_000
  const { server, baseUrl } = await startServer({ now: () => now })
  const token = ticket({ fileId: 'legacy-head', disposition: 'inline' }, now)
  try {
    const legacy = baseUrl + '/v1/media?ticket=' + encodeURIComponent(token)
    const head = await fetch(legacy, { method: 'HEAD', headers: { Range: 'bytes=0-0' }, redirect: 'manual' })
    assert.equal(head.status, 206)
    assert.equal(head.headers.get('content-range'), 'bytes 0-0/32212254720')
    assert.equal(head.headers.get('set-cookie'), null)
    const url = scopedUrl(legacy)
    const first = await fetch(url, { headers: { Range: 'bytes=0-0' } })
    const cookie = cookiePair(first)
    await first.arrayBuffer()
    now += 301_000
    const spoofed = cookie.split('=', 1)[0] + '=' + 'x'.repeat(80) + '; ' + cookie
    const resumed = await fetch(url, { headers: { Range: 'bytes=100-100', Cookie: spoofed } })
    assert.equal(resumed.status, 206)
    await resumed.arrayBuffer()
  } finally { await closeServer(server) }
})
