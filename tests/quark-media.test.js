import assert from 'node:assert/strict'
import test from 'node:test'
import { createQuarkProvider, quarkMediaCookie } from '../lib/storage/providers/quark.js'
import { createPinnedQuarkLookup, fetchQuarkCdn, isQuarkCdnUrl, validateQuarkCdnUrl } from '../lib/storage/providers/quark-media.js'

await test('Quark CDN allowlist requires HTTPS Quark hosts and rejects local or arbitrary URLs', () => {
  assert.equal(isQuarkCdnUrl('https://dl-sz.open-drive.quark.cn/video.mp4?sig=opaque'), true)
  assert.equal(isQuarkCdnUrl('https://thumb.quark.com/image.jpg'), true)
  assert.equal(isQuarkCdnUrl('http://dl-sz.quark.cn/file'), false)
  assert.equal(isQuarkCdnUrl('https://127.0.0.1/file'), false)
  assert.equal(isQuarkCdnUrl('https://localhost/file'), false)
  assert.equal(isQuarkCdnUrl('https://quark.cn.attacker.test/file'), false)
  assert.throws(() => validateQuarkCdnUrl('https://169.254.169.254/latest/meta-data'), /quark_media_host_rejected/)
})

await test('Quark CDN redirects stay on the allowlist', async () => {
  const urls = []
  const response = await fetchQuarkCdn('https://dl-sz.quark.cn/file', {
    lookupImpl: async () => [{ address: '1.1.1.1', family: 4 }],
    fetchImpl: async input => {
      urls.push(new URL(input).toString())
      if (urls.length === 1) return new Response(null, { status: 302, headers: { Location: 'https://video.quark.cn/stream' } })
      return new Response(new Uint8Array([1]), { status: 206, headers: { 'Content-Range': 'bytes 0-0/1' } })
    },
  })
  assert.equal(response.status, 206)
  assert.deepEqual(urls, ['https://dl-sz.quark.cn/file', 'https://video.quark.cn/stream'])
  await assert.rejects(fetchQuarkCdn('https://dl-sz.quark.cn/file', {
    lookupImpl: async () => [{ address: '1.1.1.1', family: 4 }],
    fetchImpl: async () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } }),
  }), /quark_media_host_rejected/)
})

await test('Quark CDN hosts resolving to a private or loopback IP are rejected before connecting', async () => {
  for (const address of ['127.0.0.1', '::ffff:127.0.0.1', 'fec0::1', '2001:db8::1', '2002:0808:0808::1', '192.88.99.1']) {
    let connected = false
    await assert.rejects(fetchQuarkCdn('https://cdn.quark.cn/file', {
      lookupImpl: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
      fetchImpl: async () => { connected = true; return new Response('unexpected') },
    }), /quark_media_host_rejected/)
    assert.equal(connected, false)
  }
})

await test('the HTTPS lookup pins the socket to only the validated public DNS answers', async () => {
  const lookup = createPinnedQuarkLookup('cdn.quark.cn', [
    { address: '1.1.1.1', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ])
  const ipv4 = await new Promise((resolve, reject) => lookup('cdn.quark.cn', { family: 4 }, (error, address, family) => error ? reject(error) : resolve({ address, family })))
  assert.deepEqual(ipv4, { address: '1.1.1.1', family: 4 })
  const all = await new Promise((resolve, reject) => lookup('cdn.quark.cn', { all: true }, (error, records) => error ? reject(error) : resolve(records)))
  assert.equal(all.length, 2)
  await assert.rejects(new Promise((resolve, reject) => lookup('attacker.test', { family: 4 }, error => error ? reject(error) : resolve())), /quark_media_dns_mismatch/)
})

await test('official media Cookie uses required fields and adds client token only when configured', () => {
  assert.equal(quarkMediaCookie({ accessToken: 'access-value' }, 'public-client'), 'x_pan_client_id=public-client;x_pan_access_token=access-value')
  assert.equal(quarkMediaCookie({ accessToken: 'access-value', clientToken: 'client-value' }, 'public-client'), 'x_pan_client_id=public-client;x_pan_access_token=access-value;x_pan_client_token=client-value')
  assert.throws(() => quarkMediaCookie({ accessToken: 'bad;token' }, 'public-client'), /storage_authorization_required/)
})

await test('Quark media GET carries Cookie and Range only to the server-side CDN', async () => {
  const savedFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async input => {
    const url = new URL(input)
    calls.push(url)
    return new Response(JSON.stringify({ status: 0, data: { download_url: 'https://video.quark.cn/stream?temporary_signature=opaque', size: '32212254720' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const cdnCalls = []
  const provider = createQuarkProvider({ storageId: 'quark-test-media' }, { accessToken: 'account-token-value', userId: 'account-1' }, {
    fetchCdn: async (url, options) => {
      cdnCalls.push({ url, options })
      return new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: {
        'Content-Type': 'video/mp4', 'Content-Length': '3', 'Content-Range': 'bytes 1024-1026/32212254720', 'Accept-Ranges': 'bytes',
      } })
    },
  })
  try {
    const response = await provider.getFileResponse('video-1', { range: 'bytes=1024-1026', ifRange: '"quark-etag"' })
    assert.equal(response.status, 206)
    assert.equal(cdnCalls[0].options.headers.Cookie, 'x_pan_client_id=third_party_agent;x_pan_access_token=account-token-value')
    assert.equal(cdnCalls[0].options.headers.Range, 'bytes=1024-1026')
    assert.equal(cdnCalls[0].options.headers['If-Range'], '"quark-etag"')
    assert.equal(calls[0].pathname, '/open/v1/file/get_download_url')
    assert.equal(calls[0].searchParams.get('access_token'), 'account-token-value')
    assert.equal(cdnCalls[0].options.headers['Accept-Encoding'], 'identity')
  } finally {
    globalThis.fetch = savedFetch
  }
})

await test('Quark media URL refreshes once after an upstream 401 or 403', async () => {
  const savedFetch = globalThis.fetch
  let apiCalls = 0
  globalThis.fetch = async () => {
    apiCalls += 1
    return new Response(JSON.stringify({ status: 0, data: { download_url: `https://video.quark.cn/stream?v=${apiCalls}` } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const requested = []
  const provider = createQuarkProvider({ storageId: 'quark-test-refresh' }, { accessToken: 'account-token-value', userId: 'account-refresh' }, {
    fetchCdn: async (url, options) => {
      requested.push({ url, headers: options.headers })
      return requested.length === 1
        ? new Response('denied', { status: 403 })
        : new Response(new Uint8Array([1]), { status: 206, headers: { 'Content-Range': 'bytes 0-0/1' } })
    },
  })
  try {
    const response = await provider.getFileResponse('video-2', { range: 'bytes=0-0' })
    assert.equal(response.status, 206)
    assert.equal(apiCalls, 2)
    assert.equal(requested.length, 2)
    assert.notEqual(requested[0].url, requested[1].url)
    assert.equal(requested[1].headers.Range, 'bytes=0-0')
  } finally {
    globalThis.fetch = savedFetch
  }
})

await test('Quark media URL with an official signed expiry is refreshed inside the five-minute margin', async () => {
  const savedFetch = globalThis.fetch
  const now = 1_800_000_000_000
  const nowSeconds = Math.floor(now / 1000)
  let apiCalls = 0
  globalThis.fetch = async () => {
    apiCalls += 1
    const expires = nowSeconds + (apiCalls === 1 ? 120 : 3600)
    return new Response(JSON.stringify({ status: 0, data: { download_url: `https://video.quark.cn/stream?auth_key=${expires}-signature-${apiCalls}`, size: '3' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const requested = []
  const provider = createQuarkProvider({ storageId: 'quark-test-url-expiry' }, { accessToken: 'account-token-value', userId: 'account-url-expiry' }, {
    now: () => now,
    fetchCdn: async url => {
      requested.push(url)
      return new Response(new Uint8Array([1]), { status: 206, headers: { 'Content-Range': 'bytes 0-0/3', 'Content-Length': '1' } })
    },
  })
  try {
    const response = await provider.getFileResponse('video-expiry', { range: 'bytes=0-0' })
    assert.equal(response.status, 206)
    assert.equal(apiCalls, 2)
    assert.equal(requested.length, 1)
    assert.match(requested[0], /auth_key=1800003600-signature-2/)
  } finally {
    globalThis.fetch = savedFetch
  }
})
