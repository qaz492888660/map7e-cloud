import { requireAdmin } from '../admin-auth.js'
import { methodAllowed, sendStorageError } from '../storage/http.js'
import { StorageError } from '../storage/errors.js'
import { resolveStorage } from '../storage/registry.js'
import { fileInfoFrom, normalizeQuarkItem } from '../storage/providers/quark.js'

const ITEM_FIELDS = [
  'fid', 'pdir_fid', 'file_type', 'file_name', 'id', 'type', 'isFolder', 'kind',
  'parent_fid', 'parent_id', 'parentId', 'mime_type', 'file_ext',
]
const PRIVATE_KEY = /token|secret|cookie|signature|device|auth|credential|password/i

function safeScalar(value) {
  if (typeof value === 'string') return value.slice(0, 255)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  return undefined
}

function safeItem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return Object.fromEntries(ITEM_FIELDS
    .filter(key => Object.hasOwn(value, key))
    .map(key => [key, safeScalar(value[key])])
    .filter(([, entry]) => entry !== undefined))
}

function safeKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).filter(key => !PRIVATE_KEY.test(key)).slice(0, 80)
    : []
}

function summarize(result) {
  const payload = result?.payload || {}
  const data = payload.data
  const rawItems = Array.isArray(data?.file_list) ? data.file_list : []
  const candidates = ['file', 'file_info', 'fileInfo', 'item', 'item_info', 'info']
  const wrappers = Object.fromEntries(candidates
    .filter(key => data && Object.hasOwn(data, key))
    .map(key => [key, safeItem(data[key])]))
  if (payload.file || payload.file_info) {
    wrappers.topLevel = safeItem(payload.file || payload.file_info)
  }
  return {
    httpStatus: result?.httpStatus ?? null,
    quarkStatus: safeScalar(payload.status),
    errno: safeScalar(payload.errno),
    payloadKeys: safeKeys(payload),
    dataKeys: safeKeys(data),
    lastPage: typeof data?.last_page === 'boolean' ? data.last_page : null,
    tqGapMs: Number(payload.metadata?.tq_gap || 0) || 0,
    fileListCount: Array.isArray(data?.file_list) ? data.file_list.length : null,
    fileList: rawItems.slice(0, 20).map(safeItem),
    wrappers,
  }
}

async function waitForGap(result) {
  const gap = Number(result?.payload?.metadata?.tq_gap || 0)
  if (Number.isFinite(gap) && gap > 0 && gap <= 30000) await new Promise(resolve => setTimeout(resolve, gap))
}

async function listRequest(provider, parentId) {
  return provider.inspectRequest('/open/v1/file/list', {
    method: 'POST',
    body: { parent_fid: parentId || '0', sort: 'updated_at:desc', size: 100 },
  })
}

async function infoRequest(provider, requestedId, options) {
  try {
    const result = await provider.inspectRequest('/open/v1/file/info', options)
    const raw = result?.payload ? fileInfoFrom(result.payload) : null
    const item = raw ? normalizeQuarkItem(raw) : null
    return {
      ...summarize(result),
      requestedId,
      normalized: item ? { id: item.id, parentId: item.parentId, isFolder: item.isFolder } : null,
    }
  } catch (error) {
    return { requestedId, error: error?.code || 'quark_request_failed', status: error?.status || null }
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (!methodAllowed(req, res, 'GET')) return
  if (!await requireAdmin(req, res)) return
  try {
    const storageId = typeof req.query?.storageId === 'string' ? req.query.storageId : 'quark-main'
    if (storageId !== 'quark-main') throw new StorageError('invalid_storage_instance', 400)
    const { instance, provider } = await resolveStorage(storageId, { freshAuth: true })
    if (instance.provider !== 'quark' || typeof provider.inspectRequest !== 'function') throw new StorageError('storage_provider_unsupported', 400)

    const root = await listRequest(provider, '')
    const rootItems = Array.isArray(root.payload?.data?.file_list) ? root.payload.data.file_list : []
    const folder = rootItems.find(raw => normalizeQuarkItem(raw).isFolder)
    const fid = String(folder?.fid ?? folder?.id ?? '')
    const fileInfo = {}
    let childList = null
    if (fid) {
      await waitForGap(root)
      fileInfo.getFid = await infoRequest(provider, fid, { query: { fid } })
      await new Promise(resolve => setTimeout(resolve, 200))
      fileInfo.postFid = await infoRequest(provider, fid, { method: 'POST', body: { fid } })
      await new Promise(resolve => setTimeout(resolve, 200))
      fileInfo.postFids = await infoRequest(provider, fid, { method: 'POST', body: { fids: [fid] } })
      await new Promise(resolve => setTimeout(resolve, 200))
      childList = await listRequest(provider, fid)
      const childItems = Array.isArray(childList.payload?.data?.file_list) ? childList.payload.data.file_list : []
      const nestedFolder = childItems.find(raw => normalizeQuarkItem(raw).isFolder)
      const nestedFid = String(nestedFolder?.fid ?? nestedFolder?.id ?? '')
      if (nestedFid) {
        await waitForGap(childList)
        fileInfo.secondGetFid = await infoRequest(provider, nestedFid, { query: { fid: nestedFid } })
      }
    }

    let configuredRoot = null
    if (instance.rootFolderId) {
      await waitForGap(childList || fileInfo || root)
      configuredRoot = await listRequest(provider, String(instance.rootFolderId))
    }

    return res.status(200).json({
      ok: true,
      storageId,
      configuredRootFolderId: instance.rootFolderId || null,
      rootList: summarize(root),
      selectedFolder: safeItem(folder),
      fileInfo: Object.keys(fileInfo).length ? fileInfo : null,
      childList: childList ? summarize(childList) : null,
      configuredRootList: configuredRoot ? summarize(configuredRoot) : null,
    })
  } catch (error) {
    return sendStorageError(res, error)
  }
}
