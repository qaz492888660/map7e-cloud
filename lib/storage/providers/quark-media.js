import dns from 'node:dns/promises'
import https from 'node:https'
import net from 'node:net'
import { Readable } from 'node:stream'
import { StorageError } from '../errors.js'

const QUARK_CDN_ROOTS = ['quark.cn', 'quark.com']
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const privateIpv4Ranges = new net.BlockList()
for (const [subnet, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['192.88.99.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) privateIpv4Ranges.addSubnet(subnet, prefix, 'ipv4')

export function isQuarkCdnUrl(value) {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    const allowedHost = QUARK_CDN_ROOTS.some(root => host === root || host.endsWith(`.${root}`))
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && (!url.port || url.port === '443')
      && !net.isIP(host)
      && allowedHost
  } catch {
    return false
  }
}

export function validateQuarkCdnUrl(value) {
  if (!isQuarkCdnUrl(value)) throw new StorageError('quark_media_host_rejected', 502)
  return new URL(value)
}

function isPublicAddress(value) {
  const family = net.isIP(value)
  if (!family) return false
  if (family === 4) return !privateIpv4Ranges.check(value, 'ipv4')
  const groups = expandIpv6(value)
  if (groups?.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    const mappedAddress = [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.')
    return !privateIpv4Ranges.check(mappedAddress, 'ipv4')
  }
  // Only global unicast IPv6 addresses are accepted. This also excludes
  // loopback, link-local, unique-local, NAT64, and transition ranges.
  if (!groups || groups[0] < 0x2000 || groups[0] > 0x3fff) return false
  if (groups[0] === 0x2001 && groups[1] <= 0x01ff) return false // IANA special-purpose block.
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false // Documentation.
  if (groups[0] === 0x2002) return false // 6to4 embeds an IPv4 destination.
  if (groups[0] === 0x3fff && groups[1] <= 0x0fff) return false // Documentation.
  return true
}

function expandIpv6(value) {
  let normalized = String(value).toLowerCase()
  if (normalized.includes('.')) {
    const splitAt = normalized.lastIndexOf(':')
    const octets = normalized.slice(splitAt + 1).split('.').map(Number)
    if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null
    normalized = `${normalized.slice(0, splitAt + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`
  }
  const halves = normalized.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null
  const parts = [...left, ...Array(missing).fill('0'), ...right]
  if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null
  return parts.map(part => Number.parseInt(part, 16))
}

async function validatePublicDns(url, lookupImpl, timeoutMs, signal) {
  let records
  let timeout
  let abort
  try {
    const cancellation = new Promise((_, reject) => {
      abort = () => reject(new StorageError('quark_media_unavailable', 502))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
    records = await Promise.race([
      cancellation,
      Promise.resolve().then(() => {
        if (signal.aborted) throw new StorageError('quark_media_unavailable', 502)
        return lookupImpl(url.hostname, { all: true, verbatim: true })
      }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('dns_timeout')), timeoutMs) }),
    ])
  } catch {
    if (signal.aborted) throw new StorageError('quark_media_unavailable', 502)
    throw new StorageError('quark_media_host_rejected', 502)
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
  }
  if (!Array.isArray(records) || records.length === 0 || records.some(record => !isPublicAddress(record.address))) {
    throw new StorageError('quark_media_host_rejected', 502)
  }
  return records
}

export function createPinnedQuarkLookup(expectedHost, records) {
  const host = String(expectedHost).toLowerCase()
  return function pinnedLookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = {}
    }
    if (hostname.toLowerCase() !== host) return callback(new Error('quark_media_dns_mismatch'))
    const family = typeof options === 'object' && options ? options.family : Number(options) || 0
    const matching = records.filter(record => !family || record.family === family)
    if (matching.length === 0) return callback(new Error('quark_media_dns_mismatch'))
    if (typeof options === 'object' && options?.all) return callback(null, matching)
    return callback(null, matching[0].address, matching[0].family)
  }
}

function pinnedHttpsRequest(url, { headers, signal, headerTimeoutMs, records }) {
  return new Promise((resolve, reject) => {
    let responseReceived = false
    const request = https.request(url, {
      method: 'GET',
      headers,
      servername: url.hostname,
      lookup: createPinnedQuarkLookup(url.hostname, records),
    }, incoming => {
      responseReceived = true
      clearTimeout(timeout)
      const responseHeaders = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === 'string') responseHeaders.set(name, value)
        else if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) responseHeaders.set(name, value.join(', '))
      }
      const wrapped = {
        status: incoming.statusCode || 0,
        headers: responseHeaders,
        body: Readable.toWeb(incoming),
      }
      resolve(wrapped)
    })
    const timeout = setTimeout(() => request.destroy(new Error('quark_cdn_headers_timeout')), headerTimeoutMs)
    const abort = () => request.destroy(signal?.reason instanceof Error ? signal.reason : new Error('quark_cdn_aborted'))
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    request.once('close', () => signal?.removeEventListener('abort', abort))
    request.once('error', error => {
      clearTimeout(timeout)
      if (!responseReceived) reject(error)
    })
    request.end()
  })
}

export async function fetchQuarkCdn(value, { headers = {}, signal, fetchImpl, requestImpl = pinnedHttpsRequest, lookupImpl = dns.lookup, headerTimeoutMs = 20000, maxRedirects = 3 } = {}) {
  let url = validateQuarkCdnUrl(value)
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(signal?.reason)
  if (signal?.aborted) abortFromCaller()
  else signal?.addEventListener('abort', abortFromCaller, { once: true })
  const cleanup = () => signal?.removeEventListener('abort', abortFromCaller)
  let handedOffBody = false
  try {
    for (let redirects = 0; ; redirects += 1) {
      let response
      const timeout = setTimeout(() => controller.abort(new Error('quark_cdn_headers_timeout')), headerTimeoutMs)
      try {
        const records = await validatePublicDns(url, lookupImpl, headerTimeoutMs, controller.signal)
        if (controller.signal.aborted) throw new StorageError('quark_media_unavailable', 502)
        response = fetchImpl
          ? await fetchImpl(url, { method: 'GET', headers, cache: 'no-store', redirect: 'manual', signal: controller.signal })
          : await requestImpl(url, { headers, signal: controller.signal, headerTimeoutMs, records })
      } catch (error) {
        if (signal?.aborted) throw new StorageError('quark_request_cancelled', 499)
        if (error instanceof StorageError) throw error
        throw new StorageError('quark_media_unavailable', 502)
      } finally {
        clearTimeout(timeout)
      }
      if (!REDIRECT_STATUSES.has(response.status)) {
        if (!response.body) {
          cleanup()
          return response
        }
        handedOffBody = true
        const body = response.body.pipeThrough(new TransformStream({ flush: cleanup, cancel: cleanup }))
        return new Response(body, { status: response.status, headers: response.headers })
      }
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => {})
      if (!location || redirects >= maxRedirects) throw new StorageError('quark_media_redirect_rejected', 502)
      let next
      try { next = new URL(location, url) } catch { throw new StorageError('quark_media_redirect_rejected', 502) }
      validateQuarkCdnUrl(next)
      url = next
    }
  } finally {
    if (!handedOffBody) cleanup()
  }
}
