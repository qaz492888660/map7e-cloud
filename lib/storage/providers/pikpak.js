import { StorageError, safeDirectUrl } from '../errors.js'
export const PIKPAK_CAPABILITIES = Object.freeze({ list: true, download: true, upload: true, createFolder: true, rename: true, trash: true })
export const FILES_API = 'https://api-drive.mypikpak.com/drive/v1/files'
export function createPikPakProvider(instance, auth) {
  const token = auth?.accessToken
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
  return {
    instance, capabilities: PIKPAK_CAPABILITIES, request,
    async getAccountInfo() { const data = await json('https://api-drive.mypikpak.com/drive/v1/about'); return { provider: 'pikpak', nickname: typeof data.user?.name === 'string' ? data.user.name : null } },
    async getQuota() { const data = await json('https://api-drive.mypikpak.com/drive/v1/about'); const total = Number(data.quota?.limit || 0), used = Number(data.quota?.usage || 0); return { total, used, free: Math.max(0, total - used) } },
    async listFiles({ parentId = '', pageToken = '' } = {}) {
      const params = new URLSearchParams({ thumbnail_size: 'SIZE_MEDIUM', limit: '100', with_audit: 'true', filters: JSON.stringify({ phase: { eq: 'PHASE_TYPE_COMPLETE' }, trashed: { eq: false } }) })
      if (parentId) params.set('parent_id', parentId)
      if (pageToken) params.set('page_token', pageToken)
      return json(`?${params}`)
    },
    async getItem(id) { const data = await json(`/${encodeURIComponent(id)}`); return data.file || data.item || data },
    async getDownloadUrl(id) { const item = await this.getItem(id); const url = safeDirectUrl(item.links?.['application/octet-stream']?.url || item.web_content_link, [token]); if (!url) throw new StorageError('download_link_unavailable'); return url },
    createFolder({ name, parentId = '' }) { return json('', { method: 'POST', body: { kind: 'drive#folder', name, parent_id: parentId } }) },
    rename({ id, name }) { return json(`/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } }) },
    trash({ id }) { return json(':batchTrash', { method: 'POST', body: { ids: [id] } }) },
    createUploadTicket({ name, parentId = '', size, hash }) { return json('', { method: 'POST', body: { kind: 'drive#file', name, parent_id: parentId, folder_type: 'NORMAL', size, hash, upload_type: 'UPLOAD_TYPE_FORM' } }) },
  }
}
