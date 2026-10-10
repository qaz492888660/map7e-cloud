import test from 'node:test'
import assert from 'node:assert/strict'
import { quarkTransportDiagnostic } from '../lib/storage/quark-transport-diagnostic.js'
import { quarkRequest, createQuarkProvider } from '../lib/storage/providers/quark.js'

const listPath = '/open/v1/file/list'
const auth = { accessToken: 'test-access-secret', deviceId: 'test-device-secret' }
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
const success = () => json({ status: 0, data: { file_list: [], last_page: true } })
const fetchError = code => new TypeError('fetch failed https://host/?access_token=test-access-secret', {
  cause: Object.assign(new Error('secret URL and socket'), { name: 'ConnectTimeoutError', code }),
})

test('transport classifications separate connection, headers, DNS and redirect without raw exception data', () => {
  for (const code of ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'ENOTFOUND', 'ECONNRESET']) {
    const entry = quarkTransportDiagnostic(fetchError(code), new AbortController().signal)
    assert.equal(entry.causes[1].code, code)
    assert.equal(entry.abortReason, null)
    assert.equal(JSON.stringify(entry).includes('secret'), false)
    assert.equal(JSON.stringify(entry).includes('https://'), false)
  }
  assert.equal(quarkTransportDiagnostic(new TypeError('fetch failed', { cause: new Error('unexpected redirect') })).causes[1].code, 'FETCH_REDIRECT_REJECTED')
  const unsafe = Object.assign(new Error('private'), { name: 'secret-name', code: 'secret-code' })
  const entry = quarkTransportDiagnostic(unsafe, { aborted: true, reason: unsafe }, { node: 'secret', undici: '22.1.0?secret' })
  assert.deepEqual(entry, { causes: [{ name: 'unknown', code: 'unknown' }], abortReason: 'unknown', runtime: { node: 'unknown', undici: 'unknown' } })
})

test('diagnostics bound aggregate errors and cyclic causes and distinguish deadline aborts', () => {
  const aggregate = new AggregateError(Array.from({ length: 100 }, (_, i) => ({ code: i === 0 ? 'ETIMEDOUT' : 'private-secret' })), 'private')
  aggregate.cause = aggregate
  const controller = new AbortController()
  controller.abort(new DOMException('private timeout text', 'TimeoutError'))
  const entry = quarkTransportDiagnostic(new TypeError('private', { cause: aggregate }), controller.signal)
  assert.deepEqual(entry.causes[1].aggregateCodes, ['ETIMEDOUT', 'unknown'])
  assert.equal(entry.causes.length, 2)
  assert.equal(entry.abortReason, 'TimeoutError')
  assert.equal(JSON.stringify(entry).includes('private'), false)
})

test('list failures retain the existing two attempts and safe diagnostics, with counters released after success/failure', async t => {
  let attempts = 0
  const logs = [], signals = [], ids = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    attempts += 1
    assert.equal(options.redirect, 'error')
    assert.equal(options.signal.aborted, false)
    signals.push(options.signal)
    ids.push(url.searchParams.get('req_id'))
    if (attempts !== 2) throw fetchError('UND_ERR_CONNECT_TIMEOUT')
    return success()
  })
  await quarkRequest(listPath, { method: 'POST', body: { parent_fid: '0' }, auth, logger: entry => logs.push(entry) })
  assert.equal(attempts, 2)
  assert.notEqual(signals[0], signals[1])
  assert.notEqual(ids[0], ids[1])
  assert.equal(logs.length, 1, 'success does not add logs')
  assert.equal(logs[0].retryPlanned, true)
  assert.equal(logs[0].deadlineFired, false)
  assert.equal(logs[0].credentialRefreshAttempted, false)
  assert.equal(logs[0].causes[1].code, 'UND_ERR_CONNECT_TIMEOUT')
  assert.equal(logs[0].processAttemptsAtStart, 1)
  assert.equal(logs[0].processListAttemptsAtFailure, 1)
  await assert.rejects(quarkRequest(listPath, { method: 'POST', auth, logger: entry => logs.push(entry) }), e => e.code === 'quark_unreachable' && !e.message.includes('secret'))
  assert.equal(attempts, 4)
  assert.equal(logs.at(-1).retryPlanned, false)
  assert.equal(logs.at(-1).processAttemptsAtStart, 1)
  assert.equal(JSON.stringify(logs).includes('secret'), false)
})

test('body errors preserve the received status; failing diagnostic output never changes provider behavior', async t => {
  const logs = []
  t.mock.method(globalThis, 'fetch', async () => new Response('private-invalid-json', { status: 200 }))
  await assert.rejects(quarkRequest(listPath, { method: 'POST', auth, logger: entry => logs.push(entry) }), e => e.code === 'quark_unreachable')
  assert.equal(logs.length, 2)
  assert.equal(logs[0].stage, 'body')
  assert.equal(logs[0].upstreamStatus, 200)
  assert.equal(logs[0].causes[0].name, 'SyntaxError')
  assert.equal(logs[0].errorKind, 'json_invalid')
  assert.equal(JSON.stringify(logs).includes('private-invalid-json'), false)
  let attempt = 0
  globalThis.fetch = async () => { if (!attempt++) throw fetchError('ECONNRESET'); return success() }
  const result = await quarkRequest(listPath, { method: 'POST', auth, logger: () => { throw new Error('unavailable') } })
  assert.equal(result.status, 0)
  assert.equal(attempt, 2)
  const provider = createQuarkProvider({ storageId: 'quark-main' }, auth)
  assert.deepEqual((await provider.listFiles()).items, [])
})

test('concurrent failures expose only process counts and the refresh-attempt flag, without changing retry behavior', async t => {
  const pending = [], logs = []
  let attempts = 0
  t.mock.method(globalThis, 'fetch', async () => {
    if (++attempts <= 2) return new Promise((resolve, reject) => pending.push(reject))
    return success()
  })
  const first = quarkRequest(listPath, { method: 'POST', auth, credentialRefreshAttempted: true, logger: entry => logs.push(entry) })
  const second = quarkRequest(listPath, { method: 'POST', auth, logger: entry => logs.push(entry) })
  assert.equal(pending.length, 2)
  for (const reject of pending) reject(fetchError('UND_ERR_CONNECT_TIMEOUT'))
  await Promise.all([first, second])
  assert.equal(attempts, 4)
  assert.deepEqual(logs.map(entry => entry.processListAttemptsAtStart), [1, 2])
  assert.deepEqual(logs.map(entry => entry.credentialRefreshAttempted), [true, false])
  assert.equal(logs[0].processListAttemptsAtFailure, 2)
  assert.equal(logs[1].processListAttemptsAtFailure, 1)
  assert.equal(JSON.stringify(logs).includes('secret'), false)
})
