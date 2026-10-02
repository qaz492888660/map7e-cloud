import net from 'node:net'
import { StorageError, safeDirectUrl } from './errors.js'

const SENSITIVE_PREVIEW_QUERY = /(?:access[_-]?token|refresh[_-]?token|(?:^|[_-])token(?:$|[_-])|session(?:id)?|cookie|authorization|(?:^|[_-])auth(?:$|[_-])|auth[_-]?key|signature|(?:^|[_-])sign(?:$|[_-])|(?:^|[_-])sig(?:$|[_-])|secret|credential|access.?key|security.?token|(?:^|[_-])expires?(?:$|[_-])|(?:^|[_-])key(?:$|[_-])|x-(?:amz|goog|oss)-)/i
const IMAGE_CONTENT_TYPES = new Set([
  'image/avif', 'image/bmp', 'image/gif', 'image/heic', 'image/heif', 'image/x-icon',
  'image/jpeg', 'image/png', 'image/svg+xml', 'image/tiff', 'image/webp',
])
const RAW_IMAGE_EXTENSIONS = new Set(['dng', 'cr2', 'cr3', 'nef', 'arw', 'rw2', 'orf', 'raf', 'pef'])

const PREVIEW_KEYS = [
  'image_preview_url', 'preview_url', 'preview_image_url', 'image_preview', 'preview_image', 'preview',
]
const THUMBNAIL_KEYS = [
  'thumbnail_url', 'thumbnail_link', 'thumbnail', 'thumb_url', 'thumb', 'image_thumbnail_url', 'image_thumbnail', 'icon_link',
]

function normalizeKey(value) {
  return String(value || '').toLowerCase().replaceAll('-', '_')
}

function urlsFromValue(value, depth = 0) {
  if (depth > 4 || value == null) return []
  if (typeof value === 'string') return /^https:\/\//i.test(value) ? [value] : []
  if (Array.isArray(value)) return value.flatMap(child => urlsFromValue(child, depth + 1))
  if (typeof value !== 'object') return []
  const preferred = ['url', 'link', 'src', 'href', 'image_url', 'thumbnail_url', 'preview_url']
  const rank = key => {
    const index = preferred.indexOf(normalizeKey(key))
    return index < 0 ? preferred.length : index
  }
  return Object.entries(value)
    .sort(([a], [b]) => rank(a) - rank(b))
    .flatMap(([, child]) => urlsFromValue(child, depth + 1))
}

export function previewSourceUrl(item, variant = 'preview') {
  const priorities = variant === 'thumbnail'
    ? [...THUMBNAIL_KEYS, ...PREVIEW_KEYS]
    : [...PREVIEW_KEYS, ...THUMBNAIL_KEYS]
  const entries = Object.entries(item || {})
  for (const key of priorities) {
    const value = entries.find(([candidate]) => normalizeKey(candidate) === key)?.[1]
    const url = urlsFromValue(value)[0]
    if (url) return url
  }
  const matched = entries
    .filter(([key]) => {
      const normalized = normalizeKey(key)
      return variant === 'thumbnail'
        ? /thumb|thumbnail/.test(normalized) || /preview/.test(normalized)
        : /preview/.test(normalized) || /thumb|thumbnail/.test(normalized)
    })
    .flatMap(([, value]) => urlsFromValue(value))
  return matched[0] || null
}

export function previewSourceFieldNames(item) {
  return Object.entries(item || {})
    .filter(([key, value]) => /^[a-z0-9_-]{1,64}$/i.test(key) && /preview|thumb|image/i.test(key) && !SENSITIVE_PREVIEW_QUERY.test(key) && urlsFromValue(value).length > 0)
    .map(([key]) => key)
    .slice(0, 16)
}

export function logPreviewDiagnostic(details = {}) {
  const safe = { event: 'storage-preview' }
  if (['quark', 'pikpak', 'unknown'].includes(details.provider)) safe.provider = details.provider
  if (typeof details.stage === 'string' && /^[a-z0-9_-]{1,48}$/i.test(details.stage)) safe.stage = details.stage
  if (['preview', 'thumbnail'].includes(details.variant)) safe.variant = details.variant
  if (Array.isArray(details.fieldNames)) {
    safe.fieldNames = details.fieldNames
      .filter(value => typeof value === 'string' && /^[a-z0-9_-]{1,64}$/i.test(value) && /preview|thumb|image/i.test(value) && !SENSITIVE_PREVIEW_QUERY.test(value))
      .slice(0, 16)
  }
  if (typeof details.host === 'string' && /^[a-z0-9.-]{1,253}$/i.test(details.host)) safe.host = details.host.toLowerCase()
  if (Number.isInteger(details.status) && details.status >= 100 && details.status <= 599) safe.status = details.status
  if (typeof details.contentType === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(details.contentType)) safe.contentType = details.contentType.toLowerCase()
  if (Number.isFinite(details.durationMs) && details.durationMs >= 0 && details.durationMs <= 600000) safe.durationMs = Math.round(details.durationMs)
  if (Number.isInteger(details.timeoutMs) && details.timeoutMs >= 1000 && details.timeoutMs <= 60000) safe.timeoutMs = details.timeoutMs
  if (typeof details.errorName === 'string' && /^[a-z0-9]{1,32}$/i.test(details.errorName)) safe.errorName = details.errorName
  if (typeof details.errorCode === 'string' && /^[a-z0-9_-]{1,64}$/i.test(details.errorCode)) safe.errorCode = details.errorCode
  console.info(JSON.stringify(safe))
}

export function safeBrowserPreviewUrl(value, secrets = []) {
  const safe = safeDirectUrl(value, secrets)
  if (!safe) return null
  try {
    const url = new URL(safe)
    if ([...url.searchParams.keys()].some(key => SENSITIVE_PREVIEW_QUERY.test(key))) return null
    return safe
  } catch {
    return null
  }
}

export function isAllowedPreviewContentType(value) {
  return IMAGE_CONTENT_TYPES.has(String(value || '').split(';', 1)[0].trim().toLowerCase())
}

export function previewPath(storageId, item, variant = 'thumbnail') {
  const query = new URLSearchParams({
    storageId: String(storageId || ''),
    id: String(item?.id || ''),
    parentId: String(item?.parentId || ''),
    variant,
  })
  const version = item?.modifiedAt || item?.modified_time || item?.updated_at || item?.createdAt || item?.created_time
  if (version) query.set('v', String(version))
  return `/api/storage-preview?${query}`
}

export function attachPreviewLinks(item, storageId) {
  if (item?.isFolder) return { ...item, previewAvailable: false }
  const thumbnailAvailable = Boolean(item?.thumbnailAvailable || item?.thumbnail)
  const previewAvailable = typeof item?.previewAvailable === 'boolean' ? item.previewAvailable : thumbnailAvailable
  const extension = String(item?.extension || String(item?.name || '').split('.').pop() || '').toLowerCase()
  const rawImage = RAW_IMAGE_EXTENSIONS.has(extension)
  return {
    ...item,
    thumbnail: rawImage
      ? (previewAvailable ? previewPath(storageId, item, 'thumbnail') : null)
      : (item?.thumbnail || (thumbnailAvailable || previewAvailable ? previewPath(storageId, item, 'thumbnail') : null)),
    thumbnailAvailable,
    previewAvailable,
  }
}

export async function fetchPreviewResponse(value, { allowedHosts = [], headers = {}, timeoutMs = 15000, diagnostics = {} } = {}) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new StorageError('preview_unavailable', 404)
  }
  const host = url.hostname.toLowerCase()
  const hostAllowed = allowedHosts.some(root => host === root || host.endsWith(`.${root}`))
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || net.isIP(host) || !hostAllowed) {
    throw new StorageError('preview_unavailable', 404)
  }

  const safeTimeoutMs = Number.isInteger(timeoutMs) ? Math.min(Math.max(timeoutMs, 1000), 60000) : 15000
  const startedAt = Date.now()
  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.1', ...headers },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(safeTimeoutMs),
    })
  } catch (error) {
    logPreviewDiagnostic({
      ...diagnostics,
      stage: 'upstream_fetch_failed',
      host,
      durationMs: Date.now() - startedAt,
      timeoutMs: safeTimeoutMs,
      errorName: error?.name,
    })
    throw new StorageError('preview_unavailable', 502)
  }

  const contentType = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase()
  logPreviewDiagnostic({
    ...diagnostics,
    stage: response.status === 200 && isAllowedPreviewContentType(contentType) ? 'upstream_response' : 'upstream_response_rejected',
    host,
    status: response.status,
    contentType,
    durationMs: Date.now() - startedAt,
    timeoutMs: safeTimeoutMs,
  })
  if (response.status !== 200 || !isAllowedPreviewContentType(contentType)) {
    await response.body?.cancel().catch(() => {})
    throw new StorageError(contentType.startsWith('image/') ? 'preview_content_type_unsupported' : 'preview_unavailable', contentType.startsWith('image/') ? 415 : 502)
  }
  return response
}

function contentLengthOf(value) {
  return /^\d+$/.test(String(value || '')) ? Number(value) : null
}

export async function probeRange(value, range = 'bytes=0-0') {
  let response
  try {
    response = await fetch(value, {
      method: 'GET',
      headers: { Range: range },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    })
  } catch {
    throw new StorageError('storage_range_probe_failed', 502)
  }

  const contentRangeHeader = response.headers.get('content-range')
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(contentRangeHeader || ''))
  const requested = /^bytes=(\d+)-(\d+)$/.exec(range)
  const total = match && match[3] !== '*' ? Number(match[3]) : null
  const expectedEnd = requested && total !== null ? Math.min(Number(requested[2]), total - 1) : Number(requested?.[2])
  const rangeSupported = response.status === 206 && Boolean(
    match && requested && match[1] === requested[1] && Number(match[2]) === expectedEnd && Number(match[2]) >= Number(match[1]),
  )
  const result = {
    status: response.status,
    rangeSupported,
    acceptRanges: response.headers.get('accept-ranges') || null,
    contentRange: match ? contentRangeHeader : null,
    contentType: response.headers.get('content-type') || null,
    contentLength: contentLengthOf(response.headers.get('content-length')),
    totalLength: total,
    etag: response.headers.get('etag') || null,
    lastModified: response.headers.get('last-modified') || null,
  }
  await response.body?.cancel().catch(() => {})
  return result
}
