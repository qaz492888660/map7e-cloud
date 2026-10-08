import crypto from 'node:crypto'
import { OFFICIAL_CLIENT_ID, OFFICIAL_SIGN_KEY } from './quark-client.js'
import { StorageError, safeDirectUrl, unsupported } from '../errors.js'
import { QUARK_FILE_SIZE_LIMIT, quarkDownloadLimit } from '../quark-download-limit.js'
import { isAllowedPreviewContentType, logPreviewDiagnostic, previewSourceFieldNames, previewSourceUrl } from '../previews.js'
import { fetchQuarkCdn, isQuarkCdnUrl } from './quark-media.js'
import { readAuth, writeAuth, withLock } from '../store.js'
export const QUARK_HOST = 'https://open-api-drive.quark.cn'
const QUARK_RETRYABLE_READ_PATHS = new Set([
  '/open/v1/file/list',
  '/open/v1/file/info',
  '/open/v1/file/get_download_url',
  '/open/v1/user/info',
  '/open/v1/user/get_vip_info',
])
const QUARK_READ_RETRY_DELAY_MS = 250
const ROOT_PARENT_CACHE_TTL_MS = 5 * 60 * 1000
const QUARK_DOWNLOAD_URL_CACHE_TTL_MS = 30 * 1000
const QUARK_DOWNLOAD_URL_REFRESH_MARGIN_MS = 5 * 60 * 1000
const QUARK_PREVIEW_RECORD = Symbol('quark-preview-record')
const quarkRootParentCache = new Map()
const quarkDownloadUrlCache = new Map()
// P2 upload/rename require multipart/task workflows, not a PikPak form ticket.
// Official Skill deliberately does not expose trash/delete.
export const QUARK_CAPABILITIES = Object.freeze({ list: true, download: true, upload: false, createFolder: true, rename: false, trash: false })
export function quarkHeaders(method, path, now = Date.now()) {
  const timestamp = String(now), clientId = process.env.QUARK_CLIENT_ID || OFFICIAL_CLIENT_ID
  const signKey = process.env.QUARK_SIGN_KEY || OFFICIAL_SIGN_KEY
  return { Accept: 'application/json', 'Content-Type': 'application/json', 'x-pan-client-id': clientId, 'x-pan-tm': timestamp, 'x-pan-token': crypto.createHash('sha256').update(`${method}&${path}&${timestamp}&${signKey}`).digest('hex') }
}
export async function quarkRequest(path, { method = 'GET', query = {}, body, auth } = {}) {
  const url = new URL(path, QUARK_HOST)
  for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(name, String(value))
  if (auth?.accessToken) url.searchParams.set('access_token', auth.accessToken)
  if (auth?.deviceId) url.searchParams.set('device_id', auth.deviceId)
  let response, payload
  const retryableRead = QUARK_RETRYABLE_READ_PATHS.has(path) && ['GET', 'POST'].includes(method)
  const maxAttempts = retryableRead ? 2 : 1
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    url.searchParams.set('req_id', crypto.randomUUID())
    try {
      response = await fetch(url, { method, headers: quarkHeaders(method, path), ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) })
      payload = await response.json()
      break
    } catch {
      if (attempt + 1 >= maxAttempts) throw new StorageError('quark_unreachable')
      await new Promise(resolve => setTimeout(resolve, QUARK_READ_RETRY_DELAY_MS))
    }
  }
  // Never echo upstream bodies, request URLs or exceptions: OAuth tokens are query parameters.
  if (!response.ok || payload.status !== 0 || (payload.errno && payload.errno !== 0)) {
    const limitBytes = quarkDownloadLimit(path, response, payload)
    if (limitBytes !== null) {
      const error = new StorageError(QUARK_FILE_SIZE_LIMIT, 422)
      error.limitBytes = limitBytes
      throw error
    }
    const authError = response.status === 401 || /token|授权|认证/i.test(String(payload.error_info || payload.agent_msg || ''))
    throw new StorageError(authError ? 'storage_token_expired' : 'quark_request_failed', authError ? 401 : 502)
  }
  return payload
}
export function expiryMs(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : null
}
function firstDefined(...values) { return values.find(value => value !== undefined && value !== null) }
export function quarkFidIdentity(value) {
  const id = typeof value === 'string' ? value : ''
  const separator = id.lastIndexOf('|')
  if (separator >= 0 && separator < id.length - 1) return { kind: 'suffix', value: id.slice(separator + 1) }
  return { kind: 'full', value: id }
}
export function quarkFidsMatch(left, right) {
  const a = quarkFidIdentity(left), b = quarkFidIdentity(right)
  return a.kind === b.kind && a.value === b.value
}
export function normalizeQuarkItem(file) {
  const fileType = firstDefined(file?.file_type, file?.type)
  const isFolder = file?.isFolder === true || file?.kind === 'drive#folder' || Number(fileType) === 0 || ['folder', 'dir', 'directory'].includes(String(fileType || '').toLowerCase())
  const rawParentId = firstDefined(file?.pdir_fid, file?.parent_fid, file?.parent_id, file?.parentId, '')
  const parentId = String(rawParentId) === '0' ? '' : String(rawParentId)
  const rawSize = firstDefined(file?.size, file?.file_size)
  const size = rawSize == null ? null : byteCount(rawSize)
  const thumbnailSource = previewSourceUrl(file, 'thumbnail')
  const previewSource = previewSourceUrl(file, 'preview')
  return {
    id: String(firstDefined(file?.fid, file?.id, '')),
    parentId,
    name: String(firstDefined(file?.file_name, file?.filename, file?.name, '')),
    kind: isFolder ? 'drive#folder' : 'drive#file',
    isFolder,
    size,
    mimeType: String(firstDefined(file?.mime_type, file?.mimeType, '')),
    extension: String(firstDefined(file?.file_ext, file?.extension, '')),
    category: String(file?.category || ''),
    createdAt: firstDefined(file?.created_at, file?.createdAt, null),
    modifiedAt: firstDefined(file?.updated_at, file?.modified_at, file?.modifiedAt, null),
    // Quark CDN URLs stay server-side even when they look unsigned. The API
    // layer converts availability into a same-origin preview route instead.
    thumbnail: null,
    thumbnailAvailable: Boolean(thumbnailSource),
    previewAvailable: Boolean(previewSource || thumbnailSource),
    writable: true,
  }
}
function byteCount(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !/^\d+$/.test(value)) return null
  const result = Number(value)
  return Number.isSafeInteger(result) && result >= 0 ? result : null
}
function quarkUrlExpiryMs(value) {
  try {
    const url = new URL(value)
    const authKey = url.searchParams.get('auth_key')
    const authDeadline = authKey ? Number.parseInt(authKey.split('-', 1)[0], 10) : NaN
    const expires = Number.parseInt(url.searchParams.get('Expires') || url.searchParams.get('expires') || '', 10)
    const seconds = Number.isSafeInteger(authDeadline) && authDeadline > 0
      ? authDeadline
      : Number.isSafeInteger(expires) && expires > 0 ? expires : NaN
    return Number.isSafeInteger(seconds) ? seconds * 1000 : null
  } catch {
    return null
  }
}
function mediaCookieValue(value) {
  return typeof value === 'string' && value.length > 0 && !/[\u0000-\u0020\u007f;,\\"]/.test(value)
}
export function quarkMediaCookie(auth, clientId = process.env.QUARK_CLIENT_ID || OFFICIAL_CLIENT_ID) {
  if (!mediaCookieValue(clientId) || !mediaCookieValue(auth?.accessToken)) throw new StorageError('storage_authorization_required', 409)
  let cookie = `x_pan_client_id=${clientId};x_pan_access_token=${auth.accessToken}`
  if (auth?.clientToken) {
    if (!mediaCookieValue(auth.clientToken)) throw new StorageError('quark_media_auth_invalid', 502)
    cookie += `;x_pan_client_token=${auth.clientToken}`
  }
  return cookie
}
function rootParentCacheKey(instance, auth) {
  const account = crypto.createHash('sha256').update(`${auth?.userId || ''}\u0000${auth?.accessToken || ''}`).digest('hex')
  return `${instance?.storageId || ''}\u0000${account}`
}
function rememberRootParents(key, items) {
  const parentIds = new Set(items.map(item => quarkFidIdentity(item.parentId)).filter(identity => identity.value).map(identity => `${identity.kind}\u0000${identity.value}`))
  quarkRootParentCache.set(key, { parentIds, expiresAt: Date.now() + ROOT_PARENT_CACHE_TTL_MS })
  if (quarkRootParentCache.size > 128) {
    for (const [cacheKey, entry] of quarkRootParentCache) if (entry.expiresAt <= Date.now() || quarkRootParentCache.size > 128) quarkRootParentCache.delete(cacheKey)
  }
}
function fileInfoFrom(payload) {
  const data = payload?.data
  const candidates = [
    data?.file,
    data?.file_info,
    data?.fileInfo,
    data?.item,
    data?.item_info,
    data?.info,
    payload?.file,
    payload?.file_info,
    data,
  ]
  return candidates.find(value => value && typeof value === 'object' && !Array.isArray(value) && firstDefined(value.fid, value.id) !== undefined) || {}
}
export async function beginQuarkAuthorization(storageId) {
  const clientDeviceId = crypto.randomUUID()
  const payload = await quarkRequest('/agent/v1/get_authorize_page_url', { method: 'POST', body: { client_device_id: clientDeviceId, device_name: 'Map7e Cloud Vercel', agent_id: 'codex', client_id: process.env.QUARK_CLIENT_ID || OFFICIAL_CLIENT_ID, work_dir: `map7e-cloud/${storageId}`, is_cloud_agent: 'true', is_unsure_agent: 'false' } })
  const url = new URL(payload.data?.authorize_page_url || '')
  if (url.protocol !== 'https:' || url.hostname !== 'pan.quark.cn' || !payload.data.page_code || !payload.data.device_id) throw new StorageError('quark_authorization_invalid')
  return { authorizeUrl: url.toString(), pageCode: payload.data.page_code, deviceId: payload.data.device_id, clientDeviceId }
}
export async function finishQuarkAuthorization(pending) {
  const page = await quarkRequest('/agent/v1/oauth/get_aac_by_pagecode', { query: { page_code: pending.pageCode } })
  if (!page.data?.agent_auth_code) return null
  const payload = await quarkRequest('/agent/v1/oauth/agent_auth_code', { query: { agent_auth_code: page.data.agent_auth_code, client_device_id: pending.clientDeviceId, device_name: 'Map7e Cloud Vercel', agent_id: 'codex', work_dir: pending.workDir } })
  const data = payload.data
  if (!data?.access_token || !data.refresh_token || !data.user_id || !data.device_id) throw new StorageError('quark_authorization_invalid')
  return { accessToken: data.access_token, refreshToken: data.refresh_token, userId: data.user_id, deviceId: data.device_id, accessExpiresAt: expiryMs(data.access_token_expires_at), refreshExpiresAt: expiryMs(data.refresh_token_expires_at) }
}
export function createQuarkProvider(instance, initialAuth, {
  fetchCdn = fetchQuarkCdn,
  now = Date.now,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  let auth = initialAuth
  let rotation
  let accountSnapshot
  const rootParentKey = rootParentCacheKey(instance, initialAuth)
  async function rotate() {
    if (rotation) return rotation
    rotation = (async () => {
      const before = auth
      for (let attempt = 0; attempt < 120; attempt += 1) {
        try {
          return await withLock(`refresh-${instance.storageId}`, async () => {
        const stored = await readAuth(instance.storageId, { fresh: true })
            const changed = stored?.accessToken && (
              stored.accessToken !== before?.accessToken
              || stored.refreshToken !== before?.refreshToken
              || stored.accessExpiresAt !== before?.accessExpiresAt
            )
            if (changed) { auth = stored; return }
            if (!stored?.refreshToken || (stored.refreshExpiresAt && stored.refreshExpiresAt <= Date.now())) throw new StorageError('storage_authorization_required', 401)
            const payload = await quarkRequest('/agent/v1/oauth/access_token/rotate', { method: 'POST', body: { refresh_token: stored.refreshToken, device_id: stored.deviceId } })
            if (!payload.data?.access_token || !payload.data.refresh_token) throw new StorageError('quark_refresh_invalid')
            auth = { ...stored, accessToken: payload.data.access_token, refreshToken: payload.data.refresh_token, accessExpiresAt: Number(payload.data.expires_in) > 0 ? Date.now() + Number(payload.data.expires_in) * 1000 : null }
            await writeAuth(instance.storageId, auth)
          })
        } catch (error) {
          if (error.code !== 'storage_operation_busy') throw error
          await sleep(250)
          const stored = await readAuth(instance.storageId, { fresh: true })
          const changed = stored?.accessToken && (
            stored.accessToken !== before?.accessToken
            || stored.refreshToken !== before?.refreshToken
            || stored.accessExpiresAt !== before?.accessExpiresAt
          )
          if (changed) { auth = stored; return }
        }
      }
      throw new StorageError('storage_operation_busy', 409)
    })()
    try { return await rotation } finally { rotation = null }
  }
  async function call(path, options = {}) {
    if (!auth?.accessToken) throw new StorageError('storage_authorization_required', 409)
    if (auth.accessExpiresAt && auth.accessExpiresAt <= Date.now() + 60000) await rotate()
    try { return await quarkRequest(path, { ...options, auth }) } catch (error) {
      if (error.code !== 'storage_token_expired' || !auth.refreshToken) throw error
      await rotate()
      return quarkRequest(path, { ...options, auth })
    }
  }
  async function listFiles({ parentId = '', pageToken = '' } = {}) {
    let cursor
    if (pageToken) { try { cursor = JSON.parse(Buffer.from(pageToken, 'base64url').toString()); if (typeof cursor.version !== 'string' || typeof cursor.token !== 'string') throw Error() } catch { throw new StorageError('invalid_page_token', 400) } }
    const isDriveRoot = !parentId || String(parentId) === '0'
    const payload = await call('/open/v1/file/list', { method: 'POST', body: { parent_fid: parentId || '0', sort: 'updated_at:desc', size: 100, ...(cursor ? { query_cursor: cursor } : {}) } })
    const data = payload.data
    if (!data || typeof data.last_page !== 'boolean' || (data.file_list != null && !Array.isArray(data.file_list))) throw new StorageError('quark_list_protocol_invalid')
    const next = data.next_query_cursor
    if (!data.last_page && (!next || typeof next.version !== 'string' || typeof next.token !== 'string')) throw new StorageError('quark_cursor_invalid')
    const items = (data.file_list || []).map(normalizeQuarkItem)
    if (isDriveRoot && !cursor) rememberRootParents(rootParentKey, items)
    return { items, nextPageToken: data.last_page ? null : Buffer.from(JSON.stringify(next)).toString('base64url'), nextRequestDelayMs: Number(payload.metadata?.tq_gap || 0) }
  }
  async function getItemRecord(id) {
    const payload = await call('/open/v1/file/info', { query: { fid: id } })
    const record = fileInfoFrom(payload)
    const item = normalizeQuarkItem(record)
    if (!item.id || !quarkFidsMatch(item.id, String(id))) throw new StorageError('file_not_found', 404)
    const normalized = { ...item, id: String(id) }
    Object.defineProperty(normalized, QUARK_PREVIEW_RECORD, { value: record })
    return { item: normalized, record }
  }
  async function previewResponse(id, variant, suppliedItem) {
    let record = suppliedItem?.[QUARK_PREVIEW_RECORD] || (await getItemRecord(id)).record
    const headers = () => ({
      Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.1',
      Cookie: quarkMediaCookie(auth),
      Origin: 'https://pan.quark.cn',
      Referer: 'https://pan.quark.cn/',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
      'Sec-Fetch-Dest': 'image',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Site': 'same-site',
    })
    let sourceUrl = previewSourceUrl(record, variant)
    let fieldNames = previewSourceFieldNames(record)
    let host
    try { host = new URL(sourceUrl).hostname } catch {}
    logPreviewDiagnostic({ provider: 'quark', variant, stage: sourceUrl ? 'preview_source_resolved' : 'preview_source_missing', fieldNames, host })
    if (!sourceUrl) throw new StorageError('preview_unavailable', 404)
    const fetchStartedAt = Date.now()
    let response
    try { response = await fetchCdn(sourceUrl, { headers: headers(), headerTimeoutMs: 15000 }) } catch (error) {
      logPreviewDiagnostic({ provider: 'quark', variant, stage: 'upstream_fetch_failed', host, durationMs: Date.now() - fetchStartedAt, timeoutMs: 15000, errorName: error?.name })
      throw new StorageError('preview_unavailable', 502)
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {})
      record = (await getItemRecord(id)).record
      sourceUrl = previewSourceUrl(record, variant)
      fieldNames = previewSourceFieldNames(record)
      try { host = new URL(sourceUrl).hostname } catch { host = undefined }
      if (!sourceUrl) throw new StorageError('preview_unavailable', 404)
      try { response = await fetchCdn(sourceUrl, { headers: headers(), headerTimeoutMs: 15000 }) } catch (error) {
        logPreviewDiagnostic({ provider: 'quark', variant, stage: 'upstream_fetch_failed', host, durationMs: Date.now() - fetchStartedAt, timeoutMs: 15000, errorName: error?.name })
        throw new StorageError('preview_unavailable', 502)
      }
    }
    const contentType = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase()
    logPreviewDiagnostic({
      provider: 'quark', variant,
      stage: response.status === 200 && isAllowedPreviewContentType(contentType) ? 'upstream_response' : 'upstream_response_rejected',
      fieldNames, host, status: response.status, contentType, durationMs: Date.now() - fetchStartedAt, timeoutMs: 15000,
    })
    if (response.status !== 200 || !isAllowedPreviewContentType(contentType)) {
      await response.body?.cancel().catch(() => {})
      throw new StorageError(contentType.startsWith('image/') ? 'preview_content_type_unsupported' : 'preview_unavailable', contentType.startsWith('image/') ? 415 : 502)
    }
    return response
  }
  function downloadUrlCacheKey(id) {
    const account = crypto.createHash('sha256').update(`${auth?.userId || ''}\u0000${auth?.accessToken || ''}\u0000${auth?.clientToken || ''}`).digest('hex')
    return `${instance.storageId}\u0000${id}\u0000${account}`
  }
  async function getDownloadSource(id, { refresh = false } = {}) {
    const key = downloadUrlCacheKey(id)
    const cached = quarkDownloadUrlCache.get(key)
    if (!refresh && cached?.expiresAt > now()) return cached
    const readUrl = async () => {
      const payload = await call('/open/v1/file/get_download_url', { method: 'POST', body: { fid: id } })
      const url = safeDirectUrl(payload.data?.download_url, [auth?.accessToken, auth?.refreshToken])
      if (!url || !isQuarkCdnUrl(url)) throw new StorageError('download_link_unavailable')
      return { payload, url, expiryMs: quarkUrlExpiryMs(url) }
    }
    let { payload, url, expiryMs } = await readUrl()
    if (expiryMs !== null && expiryMs <= now() + QUARK_DOWNLOAD_URL_REFRESH_MARGIN_MS) {
      const refreshed = await readUrl()
      payload = refreshed.payload
      url = refreshed.url
      expiryMs = refreshed.expiryMs
    }
    const currentTime = now()
    const entry = {
      url,
      size: byteCount(payload.data?.size),
      fileName: String(payload.data?.file_name || ''),
      expiresAt: Math.min(currentTime + QUARK_DOWNLOAD_URL_CACHE_TTL_MS, expiryMs === null ? Infinity : expiryMs - QUARK_DOWNLOAD_URL_REFRESH_MARGIN_MS),
    }
    for (const [cacheKey, value] of quarkDownloadUrlCache) if (value.expiresAt <= now() || quarkDownloadUrlCache.size >= 512) quarkDownloadUrlCache.delete(cacheKey)
    quarkDownloadUrlCache.set(key, entry)
    return entry
  }
  async function requestDownload(id, { range, ifRange, signal, forceRefresh = false } = {}) {
    const headers = { Accept: '*/*', 'Accept-Encoding': 'identity' }
    if (range) headers.Range = range
    if (typeof ifRange === 'string' && ifRange.length <= 512 && !/[\r\n\u0000-\u001f\u007f]/.test(ifRange)) headers['If-Range'] = ifRange
    let source = await getDownloadSource(id, { refresh: forceRefresh })
    let response = await fetchCdn(source.url, { headers: { ...headers, Cookie: quarkMediaCookie(auth) }, signal })
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {})
      quarkDownloadUrlCache.delete(downloadUrlCacheKey(id))
      source = await getDownloadSource(id, { refresh: true })
      response = await fetchCdn(source.url, { headers: { ...headers, Cookie: quarkMediaCookie(auth) }, signal })
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {})
        throw new StorageError('quark_media_upstream_forbidden', 502)
      }
    }
    return { response, source }
  }
  async function isDriveRootParent(parentId) {
    const identity = quarkFidIdentity(parentId), parentKey = `${identity.kind}\u0000${identity.value}`
    if (!identity.value) return false
    let cached = quarkRootParentCache.get(rootParentKey)
    if (!cached || cached.expiresAt <= Date.now()) {
      quarkRootParentCache.delete(rootParentKey)
      // A cold serverless instance can receive a nested-directory request before it
      // has handled that browser's root listing. Re-read only the first root page to
      // verify Quark's opaque parent identity instead of probing it as a real file.
      await listFiles({ parentId: '' })
      cached = quarkRootParentCache.get(rootParentKey)
    }
    return Boolean(cached?.parentIds.has(parentKey))
  }
  return {
    instance, capabilities: QUARK_CAPABILITIES,
    listFiles,
    isDriveRootParent,
    async getItem(id) { return (await getItemRecord(id)).item },
    async getThumbnail(id, { item } = {}) { return previewResponse(id, 'thumbnail', item) },
    async getPreview(id, { item } = {}) { return previewResponse(id, 'preview', item) },
    async getDownloadInfo(id) {
      const { response, source } = await requestDownload(id, { range: 'bytes=0-0' })
      const contentRange = response.headers.get('content-range')
      const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(contentRange || ''))
      const totalLength = match && match[3] !== '*' ? byteCount(match[3]) : null
      const result = {
        rangeSupported: response.status === 206 && Boolean(match && match[1] === '0' && match[2] === '0'),
        status: response.status,
        acceptRanges: response.headers.get('accept-ranges') || null,
        contentRange: match ? contentRange : null,
        contentType: response.headers.get('content-type') || null,
        contentLength: byteCount(response.headers.get('content-length')),
        totalLength,
        etag: response.headers.get('etag') || null,
        lastModified: response.headers.get('last-modified') || null,
      }
      await response.body?.cancel().catch(() => {})
      return result
    },
    async getDownloadUrl(id) { return (await getDownloadSource(id)).url },
    async getFileResponse(id, { range, ifRange, signal } = {}) { return (await requestDownload(id, { range, ifRange, signal })).response },
    async getAccountInfo() {
      accountSnapshot ||= Promise.all([call('/open/v1/user/info'), call('/open/v1/user/get_vip_info')]).then(([user, vip]) => ({ user: user.data, vip: vip.data }))
      const { user, vip } = await accountSnapshot
      return { nickname: typeof user?.nickname === 'string' ? user.nickname : null, memberType: typeof vip?.vip_type === 'string' ? vip.vip_type : null }
    },
    async getQuota() {
      accountSnapshot ||= Promise.all([call('/open/v1/user/info'), call('/open/v1/user/get_vip_info')]).then(([user, vip]) => ({ user: user.data, vip: vip.data }))
      const { vip } = await accountSnapshot
      // Some Skill runtime/account responses omit capacity. Keep that unknown instead of
      // rendering missing values as a false 0 B quota in the admin UI.
      const total = byteCount(vip?.capacity), used = byteCount(vip?.used)
      if (total === null || used === null) return null
      return { total, used, free: Math.max(0, total - used) }
    },
    async createFolder({ name, parentId = '' }) { const payload = await call('/open/v1/dir', { method: 'POST', body: { dir_path: name, pdir_fid: parentId || '0' } }); if (!payload.data?.fid) throw new StorageError('quark_create_folder_unconfirmed'); return { item: { id: String(payload.data.fid), parentId, name, kind: 'drive#folder' } } },
    rename() { return unsupported('rename') }, trash() { return unsupported('trash') }, createUploadTicket() { return unsupported('upload') },
  }
}
