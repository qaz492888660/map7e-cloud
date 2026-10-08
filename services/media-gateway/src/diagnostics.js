// Opt-in, short-lived diagnostics for one already-authorized media identity.
// Callers pass fixed classifications, never URLs, credentials or error messages.
export const MEDIA_DIAGNOSTIC_MAX_EVENTS = 48
const MAX_WINDOW_MS = 60 * 60_000
const STAGES = new Set([
  'request_start', 'url_cache', 'url_ready', 'auth_refresh_start', 'auth_refresh_result',
  'cdn_headers_start', 'cdn_headers_result', 'cdn_redirect', 'cdn_retry', 'media_response_ready',
])
const NUMBER_FIELDS = new Set(['attempt', 'hop', 'redirects', 'status', 'timeoutMs', 'elapsedMs'])
const BOOL_FIELDS = new Set([
  'cacheHit', 'urlChanged', 'authChanged', 'authRefreshOccurred', 'deadlineFired', 'parentAborted', 'ifRangePresent',
])
const ENUMS = {
  flow: new Set(['download', 'preview']),
  reason: new Set(['new', 'cache', 'forced', 'near_expiry', 'proactive', 'api_expired', 'cdn_unauthorized']),
  result: new Set(['headers', 'deadline', 'client_cancel', 'fetch_error', 'rotated', 'adopted', 'failed']),
  expiry: new Set(['unknown', 'expired', 'within_margin', 'fresh']),
  errorKind: new Set(['abort', 'type_error', 'other']),
}

function safeFields(fields) {
  const result = {}
  for (const [key, value] of Object.entries(fields)) {
    if (NUMBER_FIELDS.has(key) && Number.isFinite(value) && value >= 0) result[key] = Math.round(value)
    else if (BOOL_FIELDS.has(key) && typeof value === 'boolean') result[key] = value
    else if (Object.hasOwn(ENUMS, key) && ENUMS[key].has(value)) result[key] = value
    else if ((key === 'host' || key === 'nextHost') && typeof value === 'string'
      && value.length <= 253 && /^[a-z0-9.-]+$/.test(value)
      && /(?:^|\.)quark\.(?:cn|com)$/.test(value)) result[key] = value
    else if (key === 'range' && typeof value === 'string' && value.length <= 128
      && /^bytes=\d*-\d*$/.test(value)) result[key] = value
    else if (key === 'accept' && ['*/*', 'image'].includes(value)) result[key] = value
    else if (key === 'acceptEncoding' && value === 'identity') result[key] = value
    else if (['contentType', 'upstreamContentType'].includes(key) && typeof value === 'string'
      && /^(?:image\/(?:avif|bmp|gif|heic|heif|jpeg|png|svg\+xml|tiff|webp|x-icon)|video\/(?:mp4|webm)|application\/(?:json|octet-stream|pdf)|text\/(?:plain|html))$/.test(value)) result[key] = value
    else if (key === 'contentLength' && typeof value === 'string' && /^\d{1,20}$/.test(value)) result[key] = value
    else if (key === 'contentRange' && typeof value === 'string'
      && /^bytes (?:\d{1,20}-\d{1,20}|\*)\/(?:\d{1,20}|\*)$/.test(value)) result[key] = value
    else if (key === 'acceptRanges' && ['bytes', 'none'].includes(value)) result[key] = value
    else if (key === 'transferEncoding' && ['chunked', 'identity'].includes(value)) result[key] = value
  }
  return result
}

export function diagnosticResponseHeaders(headers, upstream = false) {
  return safeFields({
    [upstream ? 'upstreamContentType' : 'contentType']: String(headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase(),
    contentLength: headers.get('content-length'),
    contentRange: headers.get('content-range'),
    acceptRanges: headers.get('accept-ranges'),
    transferEncoding: headers.get('transfer-encoding'),
  })
}

export function createMediaDiagnostics({ env, requestId, fileHash, claims, method, version, logger, now, monotonicNow }) {
  const until = Number(env.MEDIA_GATEWAY_DIAGNOSTIC_UNTIL)
  if (!/^[A-Za-z0-9_-]{16}$/.test(String(env.MEDIA_GATEWAY_DIAGNOSTIC_FILE_HASH || ''))
    || env.MEDIA_GATEWAY_DIAGNOSTIC_FILE_HASH !== fileHash
    || !Number.isSafeInteger(until) || until <= now() || until - now() > MAX_WINDOW_MS) return null
  let sequence = 0
  let attempts = 0
  let authRefreshOccurred = false
  const identity = { requestId, fileHash, version, purpose: claims.purpose,
    disposition: claims.disposition || (claims.purpose === 'preview' ? 'inline' : 'attachment'), method }
  return {
    emit(stage, fields = {}) {
      if (!STAGES.has(stage) || sequence >= MEDIA_DIAGNOSTIC_MAX_EVENTS || now() >= until) return
      if (stage === 'auth_refresh_start') authRefreshOccurred = true
      try { logger({ event: 'media_diagnostic', ...identity, stage, sequence: ++sequence,
        authRefreshOccurred, ...safeFields(fields) }) } catch {}
    },
    nextAttempt() { return ++attempts },
    clock: monotonicNow,
  }
}
