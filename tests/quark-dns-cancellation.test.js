import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import { fetchQuarkCdn } from '../lib/storage/providers/quark-media.js'

test('an already canceled CDN request does not start DNS or a connection', async () => {
  const controller = new AbortController()
  controller.abort(new Error('private cancellation reason'))
  let dnsCalls = 0, connections = 0
  await assert.rejects(fetchQuarkCdn('https://cdn.quark.cn/file', {
    signal: controller.signal,
    lookupImpl: async () => { dnsCalls += 1; return [{ address: '1.1.1.1', family: 4 }] },
    requestImpl: async () => { connections += 1 },
  }), error => error.message === 'quark_request_cancelled' && error.status === 499)
  assert.equal(dnsCalls, 0)
  assert.equal(connections, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('canceling stalled DNS releases the handler before its header deadline and ignores late answers', async t => {
  const controller = new AbortController()
  const started = Promise.withResolvers(), dnsResult = Promise.withResolvers()
  let connections = 0
  const result = fetchQuarkCdn('https://cdn.quark.cn/file', {
    signal: controller.signal,
    headerTimeoutMs: 15000,
    lookupImpl: () => { started.resolve(); return dnsResult.promise },
    requestImpl: async () => { connections += 1 },
  })
  await started.promise
  controller.abort(new Error('private cancellation reason'))
  let guard
  t.after(() => clearTimeout(guard))
  const bounded = Promise.race([result, new Promise((_, reject) => {
    guard = setTimeout(() => reject(new Error('handler did not release after cancellation')), 500)
  })])
  await assert.rejects(bounded, error => error.message === 'quark_request_cancelled' && error.status === 499)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  dnsResult.resolve([{ address: '1.1.1.1', family: 4 }])
  await Promise.resolve()
  assert.equal(connections, 0)
})

test('a DNS header deadline remains a transport failure instead of a client cancellation', async () => {
  const controller = new AbortController()
  let connections = 0
  await assert.rejects(fetchQuarkCdn('https://cdn.quark.cn/file', {
    signal: controller.signal,
    headerTimeoutMs: 20,
    lookupImpl: () => new Promise(() => {}),
    requestImpl: async () => { connections += 1 },
  }), error => error.message === 'quark_media_unavailable' && error.status === 502)
  assert.equal(controller.signal.aborted, false)
  assert.equal(connections, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})
