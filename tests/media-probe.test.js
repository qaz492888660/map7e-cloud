import test from 'node:test'
import assert from 'node:assert/strict'
import { createMediaProbeScope, MEDIA_PROBE_DEADLINE_HEADER, MEDIA_PROBE_DEADLINE_ERROR } from '../lib/storage/media-probe.js'
import { quarkGatewayRangeCheck } from '../lib/api-handlers/storage-download.js'
import { quarkRequest } from '../lib/storage/providers/quark.js'

process.env.MEDIA_GATEWAY_URL = 'https://media.map7e.com'
process.env.MEDIA_GATEWAY_SIGNING_SECRET = 'media-probe-test-signing-secret-at-least-32-bytes'
process.env.MEDIA_GATEWAY_SITE_DOMAIN = 'map7e.com'
const instance = { storageId: 'quark-main' }
const item = { parentId: '', name: 'sample.mp4', mimeType: 'video/mp4' }
const fail = code => Object.assign(new Error(code), { code })
const pending = signal => new Promise((resolve, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true })
})

test('probe contract: deadline aborts owned fetch and cancels a late response', async () => {
  const scope = createMediaProbeScope({ timeoutMs: 30, errorFor: fail })
  let cancelled = false, signal, finish
  const operation = scope.fetch((input, init) => {
    signal = init.signal
    return new Promise(resolve => { finish = resolve })
  })('https://example.test')
  await assert.rejects(operation, { code: MEDIA_PROBE_DEADLINE_ERROR })
  assert.equal(signal.aborted, true)
  finish(new Response(new ReadableStream({ cancel() { cancelled = true } })))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cancelled, true)
  scope.dispose()
})

test('probe contract: caller cancellation propagates and disposal removes its listener', async () => {
  const parent = new AbortController()
  const scope = createMediaProbeScope({ timeoutMs: 1000, signal: parent.signal, errorFor: fail })
  const operation = scope.fetch((input, init) => pending(init.signal))('https://example.test')
  parent.abort()
  await assert.rejects(operation, { code: 'media_probe_cancelled' })
  scope.dispose()
  const other = new AbortController()
  const completed = createMediaProbeScope({ timeoutMs: 1000, signal: other.signal, errorFor: fail })
  completed.dispose()
  other.abort()
  assert.equal(completed.signal.aborted, false)
})

test('Cloud probe contract: forwards absolute deadline and preserves strict 206 headers', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (url, init) => {
    assert.equal(init.method, 'HEAD')
    assert.equal(init.headers[MEDIA_PROBE_DEADLINE_HEADER], '1800000020000')
    assert.equal(init.headers.Range, 'bytes=0-0')
    return new Response(null, { status: 206, headers: { 'Content-Range': 'bytes 0-0/1024',
      'Content-Length': '1', 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4' } })
  }
  const result = await quarkGatewayRangeCheck(instance, item, 'sample', { now: () => 1800000000000 })
  assert.equal(result.rangeSupported, true)
  assert.equal(result.totalLength, 1024)
})

test('Cloud probe contract: timeout and Worker deadline are 504, policy remains 422', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  let signal
  globalThis.fetch = (url, init) => { signal = init.signal; return pending(signal) }
  await assert.rejects(quarkGatewayRangeCheck(instance, item, 'sample', { timeoutMs: 25 }),
    { code: 'storage_range_probe_timeout', status: 504 })
  assert.equal(signal.aborted, true)
  globalThis.fetch = async () => new Response(null, { status: 504, headers: { 'X-Media-Error': MEDIA_PROBE_DEADLINE_ERROR } })
  await assert.rejects(quarkGatewayRangeCheck(instance, item, 'sample'), { code: 'storage_range_probe_timeout', status: 504 })
  globalThis.fetch = async () => new Response(null, { status: 422, headers: {
    'X-Media-Error': 'quark_file_size_limit', 'X-Media-Limit-Bytes': '52428800' } })
  await assert.rejects(quarkGatewayRangeCheck(instance, item, 'sample'),
    { code: 'quark_file_size_limit', status: 422, limitBytes: 52428800 })
})

test('Cloud probe contract: cancelled caller retains cancellation rather than generic 502', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const parent = new AbortController()
  globalThis.fetch = (url, init) => { parent.abort(); return pending(init.signal) }
  await assert.rejects(quarkGatewayRangeCheck(instance, item, 'sample', { signal: parent.signal }),
    { code: 'storage_range_probe_cancelled', status: 499 })
})

test('directory diagnostics: distinguish absent headers and invalid JSON without leaking secrets', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const logs = []
  let requests = 0
  globalThis.fetch = async () => {
    requests += 1
    if (requests === 1) throw new TypeError('secret-token signed-url cookie')
    return new Response('secret-token invalid JSON', { status: 200 })
  }
  await assert.rejects(quarkRequest('/open/v1/file/list', { method: 'POST', auth: { accessToken: 'secret-token' },
    body: { pdir_fid: 'private-directory' }, logger: entry => logs.push(entry) }), { code: 'quark_unreachable' })
  assert.equal(requests, 2)
  assert.deepEqual(logs.map(log => [log.attempt, log.stage, log.errorKind, log.upstreamStatus, log.retryPlanned]),
    [[1, 'headers', 'fetch_error', undefined, true], [2, 'body', 'json_invalid', 200, false]])
  assert.ok(logs.every(log => /^[0-9a-f-]{36}$/.test(log.upstreamRequestId) && log.elapsedMs >= 0))
  assert.doesNotMatch(JSON.stringify(logs), /secret-token|signed-url|cookie|private-directory|access_token|Authorization/)
})

test('directory diagnostics: body read failure records received status; logging failure is harmless', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const logs = []
  globalThis.fetch = async () => ({ status: 200, json: async () => { throw new TypeError('private upstream text') } })
  await assert.rejects(quarkRequest('/open/v1/file/list', { logger: entry => logs.push(entry) }), { code: 'quark_unreachable' })
  assert.ok(logs.every(log => log.stage === 'body' && log.upstreamStatus === 200 && log.errorKind === 'body_error'))
  await assert.rejects(quarkRequest('/open/v1/file/list', { logger: () => { throw new Error('logger failure') } }),
    { code: 'quark_unreachable' })
})

test('directory diagnostics: timeout classification does not retain a previous response status', async t => {
  const original = globalThis.fetch, originalTimeout = AbortSignal.timeout
  t.after(() => { globalThis.fetch = original; AbortSignal.timeout = originalTimeout })
  AbortSignal.timeout = () => {
    const controller = new AbortController()
    setImmediate(() => controller.abort(new DOMException('sensitive timeout text', 'TimeoutError')))
    return controller.signal
  }
  let attempt = 0
  const logs = []
  globalThis.fetch = async (url, init) => {
    if (++attempt === 1) return { status: 503, json: () => pending(init.signal) }
    return pending(init.signal)
  }
  await assert.rejects(quarkRequest('/open/v1/file/list', { logger: entry => logs.push(entry) }), { code: 'quark_unreachable' })
  assert.deepEqual(logs.map(log => [log.stage, log.errorKind, log.upstreamStatus, log.deadlineFired]),
    [['body', 'deadline', 503, true], ['headers', 'deadline', undefined, true]])
  assert.doesNotMatch(JSON.stringify(logs), /sensitive timeout text/)
})
