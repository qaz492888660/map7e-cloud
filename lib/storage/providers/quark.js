import crypto from 'node:crypto'
import { OFFICIAL_CLIENT_ID, OFFICIAL_SIGN_KEY } from './quark-client.js'
import { StorageError, safeDirectUrl, unsupported } from '../errors.js'
import { readAuth, writeAuth, withLock } from '../store.js'
export const QUARK_HOST = 'https://open-api-drive.quark.cn'
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
  url.searchParams.set('req_id', crypto.randomUUID())
  for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(name, String(value))
  if (auth?.accessToken) url.searchParams.set('access_token', auth.accessToken)
  if (auth?.deviceId) url.searchParams.set('device_id', auth.deviceId)
  let response, payload
  try {
    response = await fetch(url, { method, headers: quarkHeaders(method, path), ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) })
    payload = await response.json()
  } catch { throw new StorageError('quark_unreachable') }
  // Never echo upstream bodies, request URLs or exceptions: OAuth tokens are query parameters.
  if (!response.ok || payload.status !== 0 || (payload.errno && payload.errno !== 0)) {
    const authError = response.status === 401 || /token|授权|认证/i.test(String(payload.error_info || payload.agent_msg || ''))
    throw new StorageError(authError ? 'storage_token_expired' : 'quark_request_failed', authError ? 401 : 502)
  }
  return payload
}
export function expiryMs(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : null
}
export function normalizeQuarkItem(file, secrets = []) {
  const isFolder = Number(file.file_type) === 0
  return { id: String(file.fid || ''), parentId: String(file.pdir_fid || file.parent_fid || '') === '0' ? '' : String(file.pdir_fid || file.parent_fid || ''), name: String(file.file_name || file.filename || ''), kind: isFolder ? 'drive#folder' : 'drive#file', isFolder, size: Number(file.size || 0), mimeType: String(file.mime_type || ''), extension: String(file.file_ext || ''), category: String(file.category || ''), createdAt: file.created_at || null, modifiedAt: file.updated_at || null, thumbnail: safeDirectUrl(file.thumbnail_url || file.thumbnail, secrets), writable: true }
}
function byteCount(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !/^\d+$/.test(value)) return null
  const result = Number(value)
  return Number.isSafeInteger(result) && result >= 0 ? result : null
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
export function createQuarkProvider(instance, initialAuth) {
  let auth = initialAuth
  let rotation
  let accountSnapshot
  async function rotate() {
    if (rotation) return rotation
    rotation = (async () => {
      const before = auth
      for (let attempt = 0; attempt < 20; attempt += 1) {
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
          await new Promise(resolve => setTimeout(resolve, 250))
          const stored = await readAuth(instance.storageId)
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
  return {
    instance, capabilities: QUARK_CAPABILITIES,
    async listFiles({ parentId = '', pageToken = '' } = {}) {
      let cursor
      if (pageToken) { try { cursor = JSON.parse(Buffer.from(pageToken, 'base64url').toString()); if (typeof cursor.version !== 'string' || typeof cursor.token !== 'string') throw Error() } catch { throw new StorageError('invalid_page_token', 400) } }
      const payload = await call('/open/v1/file/list', { method: 'POST', body: { parent_fid: parentId || '0', sort: 'updated_at:desc', size: 100, ...(cursor ? { query_cursor: cursor } : {}) } })
      const data = payload.data
      if (!data || typeof data.last_page !== 'boolean' || (data.file_list != null && !Array.isArray(data.file_list))) throw new StorageError('quark_list_protocol_invalid')
      const next = data.next_query_cursor
      if (!data.last_page && (!next || typeof next.version !== 'string' || typeof next.token !== 'string')) throw new StorageError('quark_cursor_invalid')
      return { items: (data.file_list || []).map(file => normalizeQuarkItem(file, [auth?.accessToken, auth?.refreshToken])), nextPageToken: data.last_page ? null : Buffer.from(JSON.stringify(next)).toString('base64url'), nextRequestDelayMs: Number(payload.metadata?.tq_gap || 0) }
    },
    async getItem(id) { const payload = await call('/open/v1/file/info', { query: { fid: id } }); const item = normalizeQuarkItem(payload.data || {}, [auth?.accessToken, auth?.refreshToken]); if (item.id !== id) throw new StorageError('file_not_found', 404); return item },
    async getDownloadUrl(id) { const payload = await call('/open/v1/file/get_download_url', { method: 'POST', body: { fid: id } }); const url = safeDirectUrl(payload.data?.download_url, [auth.accessToken, auth.refreshToken]); if (!url) throw new StorageError('download_link_unavailable'); // The official SDK sends account cookies on the data request. Validate a credential-free
      // URL before redirecting: the account token must never become a browser cookie.
      let probe
      try { probe = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000) }); await probe.body?.cancel() } catch { throw new StorageError('quark_direct_download_unverified', 501) }
      if (![200, 206].includes(probe.status)) throw new StorageError('quark_direct_download_requires_account_cookie', 501)
      return url },
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
