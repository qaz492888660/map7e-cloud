import test from 'node:test'
import assert from 'node:assert/strict'
import { createQuarkProvider, quarkRequest } from '../lib/storage/providers/quark.js'

const auth = { accessToken: 'private-test-token', refreshToken: 'private-test-refresh' }
const instance = { storageId: 'quark-main' }
const fileInfo = () => new Response(JSON.stringify({ status: 0, data: { file_info: {
  fid: 'photo', pdir_fid: '0', file_type: 2, file_name: 'photo.jpg',
  preview_url: 'https://cdn.quark.cn/preview', thumbnail_url: 'https://cdn.quark.cn/thumbnail',
} } }), { headers: { 'Content-Type': 'application/json' } })
const cancelled = error => error.code === 'quark_request_cancelled' && error.status === 499 && !error.message.includes('private')

test('already cancelled previews and original reads start no metadata, rotation, source or CDN calls', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; throw new Error('must not start') })
  const provider = createQuarkProvider(instance, { ...auth, accessExpiresAt: 1 }, { fetchCdn: async () => { calls += 1; throw new Error('must not start') } })
  const controller = new AbortController()
  controller.abort(new Error('private reason'))
  for (const operation of ['getPreview', 'getThumbnail', 'getFileResponse']) {
    await assert.rejects(provider[operation]('photo', { signal: controller.signal }), cancelled)
  }
  assert.equal(calls, 0)
})

test('preview and thumbnail propagate cancellation to pending CDN fetches without refetching metadata', async t => {
  for (const operation of ['getPreview', 'getThumbnail']) {
    let apiCalls = 0, cdnCalls = 0
    const controller = new AbortController(), started = Promise.withResolvers()
    t.mock.method(globalThis, 'fetch', async (url, init) => { apiCalls += 1; assert.equal(url.pathname, '/open/v1/file/info'); assert.ok(init.signal); return fileInfo() })
    const provider = createQuarkProvider(instance, auth, { fetchCdn: async (url, { signal, headerTimeoutMs }) => {
      cdnCalls += 1
      assert.equal(signal, controller.signal)
      assert.equal(headerTimeoutMs, 15000)
      started.resolve()
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private error')), { once: true }))
    } })
    const result = provider[operation]('photo', { signal: controller.signal })
    await started.promise
    controller.abort()
    await assert.rejects(result, cancelled)
    assert.equal(apiCalls, 1)
    assert.equal(cdnCalls, 1)
  }
})

test('cancelled metadata and source URL requests stop without read retry, credential refresh or CDN connection', async t => {
  for (const operation of ['getPreview', 'getFileResponse']) {
    let apiCalls = 0, cdnCalls = 0, requestSignal
    const controller = new AbortController(), started = Promise.withResolvers()
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      apiCalls += 1
      assert.ok(url.pathname.endsWith(operation === 'getPreview' ? '/file/info' : '/file/get_download_url'))
      requestSignal = init.signal
      started.resolve()
      return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('private error')), { once: true }))
    })
    const provider = createQuarkProvider(instance, auth, { fetchCdn: async () => { cdnCalls += 1; throw new Error('must not start') } })
    const result = provider[operation]('photo', { signal: controller.signal })
    await started.promise
    controller.abort()
    await assert.rejects(result, cancelled)
    assert.equal(requestSignal.aborted, true)
    assert.equal(apiCalls, 1)
    assert.equal(cdnCalls, 0)
  }
})

test('cancel during retry backoff stops the next request and retains safe failure-only evidence', async t => {
  const controller = new AbortController(), logged = Promise.withResolvers(), logs = []
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; throw new TypeError('private fetch failure') })
  const result = quarkRequest('/open/v1/file/list', { method: 'POST', auth, signal: controller.signal, logger: entry => { logs.push(entry); logged.resolve() } })
  await logged.promise
  controller.abort(new Error('private cancellation'))
  await assert.rejects(result, cancelled)
  assert.equal(calls, 1)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].deadlineFired, false)
  assert.equal(JSON.stringify(logs).includes('private'), false)
})

test('a late denied preview response is released without starting a metadata refresh after cancellation', async t => {
  const controller = new AbortController()
  let apiCalls = 0, cdnCalls = 0, released = 0
  t.mock.method(globalThis, 'fetch', async () => { apiCalls += 1; return fileInfo() })
  const provider = createQuarkProvider(instance, auth, { fetchCdn: async () => {
    cdnCalls += 1
    controller.abort()
    return new Response(new ReadableStream({ cancel() { released += 1 } }), { status: 403 })
  } })
  await assert.rejects(provider.getPreview('photo', { signal: controller.signal }), cancelled)
  assert.equal(apiCalls, 1)
  assert.equal(cdnCalls, 1)
  assert.equal(released, 1)
})

test('late API headers after cancellation are released and classified as cancellation rather than a deadline', async t => {
  const controller = new AbortController(), logs = []
  let calls = 0, released = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1
    controller.abort(new Error('private cancellation'))
    return new Response(new ReadableStream({ cancel() { released += 1 } }), { status: 200 })
  })
  await assert.rejects(quarkRequest('/open/v1/file/list', { method: 'POST', auth, signal: controller.signal, logger: entry => logs.push(entry) }), cancelled)
  assert.equal(calls, 1)
  assert.equal(released, 1)
  assert.equal(logs.length, 1)
  assert.equal(logs[0].upstreamStatus, 200)
  assert.equal(logs[0].stage, 'body')
  assert.equal(Number.isFinite(logs[0].headersElapsedMs), true)
  assert.equal(logs[0].errorKind, 'cancelled')
  assert.equal(logs[0].deadlineFired, false)
  assert.equal(logs[0].retryPlanned, false)
  assert.equal(JSON.stringify(logs).includes('private'), false)
})
