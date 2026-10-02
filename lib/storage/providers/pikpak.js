import { StorageError, safeDirectUrl } from '../errors.js'
import { fetchPreviewResponse, previewSourceUrl, probeRange } from '../previews.js'
export const PIKPAK_CAPABILITIES = Object.freeze({ list: true, download: true, upload: true, createFolder: true, rename: true, trash: true })
export const FILES_API = 'https://api-drive.mypikpak.com/drive/v1/files'
const PIKPAK_PREVIEW_HOSTS = ['mypikpak.com', 'pikpak.com']
function byteCount(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !/^\d+$/.test(value)) return null
  const result = Number(value)
  return Number.isSafeInteger(result) && result >= 0 ? result : null
}
export function createPikPakProvider(instance, auth) {
  const token = auth?.accessToken
  let aboutSnapshot
  async function request(path, { method = 'GET', body } = {}) {
    if (!token) throw new StorageError('storage_authorization_required', 409)
    return fetch(path.startsWith('https://api-drive.mypikpak.com/') ? path : `${FILES_API}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store', signal: AbortSignal.timeout(15000),
    })
  }
  async function json(path, options) {
    const response = await request(path, options)
    let payload
    try { payload = await response.json() } catch { throw new StorageError('storage_response_invalid') }
    if (!response.ok || payload?.error || [payload?.error_code, payload?.code].some(code => code !== undefined && code !== null && code !== '' && code !== 0 && code !== '0')) throw new StorageError(response.status === 401 ? 'storage_token_expired' : 'storage_upstream_failed', response.status === 401 ? 401 : 502)
    return payload
  }
  function about() {
    aboutSnapshot ||= json('https://api-drive.mypikpak.com/drive/v1/about').catch((error) => {
      aboutSnapshot = null
      throw error
    })
    return aboutSnapshot
  }
  async function previewResponse(id, variant, suppliedItem) {
    const item = suppliedItem || await provider.getItem(id)
    const sourceUrl = previewSourceUrl(variant === 'thumbnail' ? item : { ...item, icon_link: null }, variant)
    if (!sourceUrl) throw new StorageError('preview_unavailable', 404)
    return fetchPreviewResponse(sourceUrl, { allowedHosts: PIKPAK_PREVIEW_HOSTS })
  }
  function directDownloadUrl(item) {
    const url = safeDirectUrl(item.links?.['application/octet-stream']?.url || item.web_content_link, [token])
    if (!url) throw new StorageError('download_link_unavailable')
    return url
  }
  const provider = {
    instance, capabilities: PIKPAK_CAPABILITIES, request,
    async getAccountInfo() { const data = await about(); return { provider: 'pikpak', nickname: typeof data.user?.name === 'string' ? data.user.name : null } },
    async getQuota() {
      const data = await about()
      const total = byteCount(data.quota?.limit), used = byteCount(data.quota?.usage)
      if (total === null || used === null || total <= 0) return null
      return { total, used, free: Math.max(0, total - used) }
    },
    async listFiles({ parentId = '', pageToken = '' } = {}) {
      const params = new URLSearchParams({ thumbnail_size: 'SIZE_MEDIUM', limit: '100', with_audit: 'true', filters: JSON.stringify({ phase: { eq: 'PHASE_TYPE_COMPLETE' }, trashed: { eq: false } }) })
      if (parentId) params.set('parent_id', parentId)
      if (pageToken) params.set('page_token', pageToken)
      return json(`?${params}`)
    },
    async getItem(id) {
      const data = await json(`/${encodeURIComponent(id)}`)
      const item = data.file || data.item || data
      return { ...item, parentId: String(item.parent_id ?? item.parentId ?? ''), isFolder: item.isFolder === true || item.kind === 'drive#folder' }
    },
    async getDownloadUrl(id) { return directDownloadUrl(await this.getItem(id)) },
    async getDownloadInfo(id) {
      const url = directDownloadUrl(await this.getItem(id))
      const range = await probeRange(url)
      if (![200, 206].includes(range.status)) throw new StorageError('download_link_unavailable')
      return { url, ...range }
    },
    async getThumbnail(id, { item } = {}) { return previewResponse(id, 'thumbnail', item) },
    async getPreview(id, { item } = {}) { return previewResponse(id, 'preview', item) },
    createFolder({ name, parentId = '' }) { return json('', { method: 'POST', body: { kind: 'drive#folder', name, parent_id: parentId } }) },
    rename({ id, name }) { return json(`/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } }) },
    trash({ id }) { return json(':batchTrash', { method: 'POST', body: { ids: [id] } }) },
    createUploadTicket({ name, parentId = '', size, hash }) { return json('', { method: 'POST', body: { kind: 'drive#file', name, parent_id: parentId, folder_type: 'NORMAL', size, hash, upload_type: 'UPLOAD_TYPE_FORM' } }) },
  }
  return provider
}
