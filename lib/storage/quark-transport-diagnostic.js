// Exceptions may embed OAuth queries, IP addresses or response data. Emit only
// known classifications, never messages, stacks, URLs or socket information.
const NAMES = new Set(['Error', 'TypeError', 'SyntaxError', 'AggregateError',
  'AbortError', 'TimeoutError', 'ConnectTimeoutError', 'HeadersTimeoutError',
  'BodyTimeoutError', 'SocketError', 'RequestAbortedError', 'HTTPParserError'])
const CODES = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'UND_ERR_ABORT',
  'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_SSL_WRONG_VERSION_NUMBER'])
const safeName = value => NAMES.has(value) ? value : 'unknown'
const safeCode = value => CODES.has(value) ? value : 'unknown'
const safeVersion = value => /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value || '') ? value : 'unknown'

export function quarkTransportDiagnostic(error, signal, versions = process.versions) {
  const causes = [], seen = new Set()
  let current = error
  // Bounded and cycle-safe, including Node's multi-address AggregateError.
  while (current && typeof current === 'object' && causes.length < 4 && !seen.has(current)) {
    seen.add(current)
    causes.push({ name: safeName(current.name),
      code: current.message === 'unexpected redirect' ? 'FETCH_REDIRECT_REJECTED' : safeCode(current.code),
      ...(current instanceof AggregateError ? {
        aggregateCodes: [...new Set(current.errors.slice(0, 8).map(child => safeCode(child?.code)))],
      } : {}),
    })
    current = current.cause
  }
  return { causes, abortReason: signal?.aborted ? safeName(signal.reason?.name) : null,
    runtime: { node: safeVersion(versions.node), undici: safeVersion(versions.undici) } }
}
