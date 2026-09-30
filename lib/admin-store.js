const STORE_KEY_PREFIX = 'map7e-cloud:'
const DEFAULT_FOLDER_METADATA = Object.freeze({ type: 'folder', access: 'inherit', passwordMode: 'shared' })
const DEFAULT_FILE_METADATA = Object.freeze({ access: 'inherit', passwordMode: 'shared' })
const STORAGE_TIMEOUT_MS = 10000

const BOOTSTRAP_ADMIN_AUTH_SCRIPT = `-- map7e-bootstrap-admin-auth
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1])
return 1`

const CHANGE_ADMIN_PASSWORD_SCRIPT = `-- map7e-change-admin-password
local raw = redis.call('GET', KEYS[1])
if not raw then
  return redis.error_reply('admin_auth_record_missing')
end
local ok, record = pcall(cjson.decode, raw)
if not ok or type(record) ~= 'table' or type(record.passwordHash) ~= 'string' then
  return redis.error_reply('admin_auth_record_invalid')
end
if record.passwordHash ~= ARGV[1] then
  return 0
end
local version = tonumber(record.sessionVersion)
if not version or version < 0 then
  return redis.error_reply('admin_session_version_invalid')
end
record.passwordHash = ARGV[2]
record.sessionVersion = version + 1
redis.call('SET', KEYS[1], cjson.encode(record))
return version + 1`

export class PersistentStoreError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PersistentStoreError'
    this.code = code
  }
}

function redisCredentials() {
  const directUrl = process.env.UPSTASH_REDIS_REST_URL
  const directToken = process.env.UPSTASH_REDIS_REST_TOKEN
  if (directUrl && directToken) return { url: directUrl, token: directToken, configured: true }

  const integrationUrl = process.env.KV_REST_API_URL
  const integrationToken = process.env.KV_REST_API_TOKEN
  if (integrationUrl && integrationToken) return { url: integrationUrl, token: integrationToken, configured: true }

  return {
    configured: false,
    hasAny: Boolean(directUrl || directToken || integrationUrl || integrationToken),
  }
}

function storageStatus() {
  const credentials = redisCredentials()
  if (credentials.configured) return 'ready'
  return credentials.hasAny ? 'incomplete' : 'missing'
}

function storeKeyPrefix() {
  // Vercel Preview and Production share the connected Redis database, but not keys.
  // Production deliberately retains the legacy prefix so existing settings remain addressable.
  return process.env.VERCEL_ENV === 'preview'
    ? `${STORE_KEY_PREFIX}preview:`
    : STORE_KEY_PREFIX
}

function globalAccessKey() {
  return `${storeKeyPrefix()}global-access:v1`
}

function adminAuthKey() {
  return `${storeKeyPrefix()}admin-auth:v1`
}

export function isPersistentStoreConfigured() {
  return storageStatus() === 'ready'
}

function storeNotReadyError() {
  const partial = storageStatus() === 'incomplete'
  return new PersistentStoreError(
    'persistent_storage_not_configured',
    partial
      ? '持久化存储环境变量不完整。请同时配置 UPSTASH_REDIS_REST_URL 与 UPSTASH_REDIS_REST_TOKEN，或同时配置 KV_REST_API_URL 与 KV_REST_API_TOKEN。'
      : '管理配置需要持久化存储。请连接 Upstash Redis，或在 Vercel 中配置一组完整的 Upstash REST URL 和 token。'
  )
}

function redisEndpoint() {
  const raw = redisCredentials().url
  let endpoint
  try {
    endpoint = new URL(raw)
  } catch {
    throw new PersistentStoreError('persistent_storage_unavailable', '持久化存储地址无效。')
  }
  if (endpoint.protocol !== 'https:' || endpoint.search || endpoint.hash) {
    throw new PersistentStoreError('persistent_storage_unavailable', '持久化存储地址无效。')
  }
  return endpoint.toString().replace(/\/$/, '')
}

async function runPipeline(commands) {
  if (storageStatus() !== 'ready') throw storeNotReadyError()
  const credentials = redisCredentials()

  let response
  try {
    response = await fetch(`${redisEndpoint()}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
      cache: 'no-store',
      signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
    })
  } catch {
    throw new PersistentStoreError('persistent_storage_unavailable', '持久化存储暂时不可用，请稍后重试。')
  }

  let payload
  try {
    payload = await response.json()
  } catch {
    throw new PersistentStoreError('persistent_storage_unavailable', '持久化存储返回了无效响应。')
  }

  if (!response.ok || !Array.isArray(payload) || payload.some((item) => item?.error)) {
    throw new PersistentStoreError('persistent_storage_unavailable', '持久化存储暂时不可用，请稍后重试。')
  }
  if (payload.length !== commands.length) {
    throw new PersistentStoreError('persistent_storage_unavailable', '持久化存储返回了不完整响应。')
  }
  return payload.map((item) => item?.result)
}

function defaultFolderMetadata(folderId) {
  return { folderId: String(folderId), ...DEFAULT_FOLDER_METADATA }
}

function parseFolderMetadata(folderId, value) {
  if (value === null || value === undefined) return defaultFolderMetadata(folderId)

  let parsed
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    throw new PersistentStoreError('persistent_storage_unavailable', '文件夹配置数据无法读取。')
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    String(parsed.folderId || '') !== String(folderId) ||
    !['folder', 'album'].includes(parsed.type) ||
    !['inherit', 'public', 'locked'].includes(parsed.access)
  ) {
    throw new PersistentStoreError('persistent_storage_unavailable', '文件夹配置数据格式无效。')
  }
  return {
    folderId: String(folderId),
    type: parsed.type,
    access: parsed.access,
    passwordMode: parsed.passwordMode === 'custom' ? 'custom' : 'shared',
    ...(typeof parsed.updatedAt === 'string' ? { updatedAt: parsed.updatedAt } : {}),
  }
}

function folderKey(folderId) {
  return `${storeKeyPrefix()}folder:v1:${Buffer.from(String(folderId)).toString('base64url')}`
}

function defaultFileMetadata(fileId) {
  return { fileId: String(fileId), ...DEFAULT_FILE_METADATA }
}

function parseFileMetadata(fileId, value) {
  if (value === null || value === undefined) return defaultFileMetadata(fileId)

  let parsed
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    throw new PersistentStoreError('persistent_storage_unavailable', '文件配置数据无法读取。')
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    String(parsed.fileId || '') !== String(fileId) ||
    !['inherit', 'public', 'locked'].includes(parsed.access)
  ) {
    throw new PersistentStoreError('persistent_storage_unavailable', '文件配置数据格式无效。')
  }
  return {
    fileId: String(fileId),
    access: parsed.access,
    passwordMode: parsed.passwordMode === 'custom' ? 'custom' : 'shared',
    ...(typeof parsed.updatedAt === 'string' ? { updatedAt: parsed.updatedAt } : {}),
  }
}

function fileKey(fileId) {
  return `${storeKeyPrefix()}file:v1:${Buffer.from(String(fileId)).toString('base64url')}`
}

export async function getGlobalAccessState() {
  if (storageStatus() === 'missing') return { globalAccess: 'locked', storageReady: false }
  const [value] = await runPipeline([['GET', globalAccessKey()]])
  if (value === null || value === undefined) return { globalAccess: 'locked', storageReady: true }
  if (!['public', 'locked'].includes(value)) {
    throw new PersistentStoreError('persistent_storage_unavailable', '全局权限配置格式无效。')
  }
  return { globalAccess: value, storageReady: true }
}

export async function setGlobalAccess(globalAccess) {
  if (!['public', 'locked'].includes(globalAccess)) {
    throw new PersistentStoreError('invalid_global_access', '网盘访问权限无效。')
  }
  await runPipeline([['SET', globalAccessKey(), globalAccess]])
  return { globalAccess, storageReady: true }
}

export async function getFolderMetadataMany(folderIds) {
  const ids = [...new Set(folderIds.map((id) => String(id)).filter(Boolean))]
  if (!ids.length) return new Map()
  if (storageStatus() === 'missing') {
    return new Map(ids.map((id) => [id, defaultFolderMetadata(id)]))
  }

  const result = new Map()
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200)
    const values = await runPipeline(batch.map((id) => ['GET', folderKey(id)]))
    batch.forEach((id, index) => result.set(id, parseFolderMetadata(id, values[index])))
  }
  return result
}

export async function getFolderMetadata(folderId) {
  const values = await getFolderMetadataMany([folderId])
  return values.get(String(folderId)) || defaultFolderMetadata(folderId)
}

export async function setFolderMetadata(folderId, { type, access }) {
  const id = String(folderId || '').trim()
  if (!id || id.length > 512) {
    throw new PersistentStoreError('invalid_folder_id', '文件夹 ID 无效。')
  }
  if (!['folder', 'album'].includes(type) || !['inherit', 'public', 'locked'].includes(access)) {
    throw new PersistentStoreError('invalid_folder_metadata', '文件夹类型或权限无效。')
  }

  const metadata = { folderId: id, type, access, passwordMode: 'shared', updatedAt: new Date().toISOString() }
  await runPipeline([['SET', folderKey(id), JSON.stringify(metadata)]])
  return metadata
}

export async function getFileMetadataMany(fileIds) {
  const ids = [...new Set(fileIds.map((id) => String(id)).filter(Boolean))]
  if (!ids.length) return new Map()
  if (storageStatus() === 'missing') {
    return new Map(ids.map((id) => [id, defaultFileMetadata(id)]))
  }

  const result = new Map()
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200)
    const values = await runPipeline(batch.map((id) => ['GET', fileKey(id)]))
    batch.forEach((id, index) => result.set(id, parseFileMetadata(id, values[index])))
  }
  return result
}

export async function getFileMetadata(fileId) {
  const values = await getFileMetadataMany([fileId])
  return values.get(String(fileId)) || defaultFileMetadata(fileId)
}

export async function setFileMetadata(fileId, { access }) {
  const id = String(fileId || '').trim()
  if (!id || id.length > 512) {
    throw new PersistentStoreError('invalid_file_id', '文件 ID 无效。')
  }
  if (!['inherit', 'public', 'locked'].includes(access)) {
    throw new PersistentStoreError('invalid_file_metadata', '文件权限无效。')
  }

  const metadata = { fileId: id, access, passwordMode: 'shared', updatedAt: new Date().toISOString() }
  await runPipeline([['SET', fileKey(id), JSON.stringify(metadata)]])
  return metadata
}

export async function getAdminAuthRecord() {
  if (storageStatus() === 'missing') {
    return { passwordHash: null, sessionVersion: 0, storageReady: false }
  }

  const [value] = await runPipeline([['GET', adminAuthKey()]])
  if (value === null || value === undefined) {
    return { passwordHash: null, sessionVersion: 0, storageReady: true }
  }

  let parsed
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    throw new PersistentStoreError('persistent_storage_unavailable', '管理员认证数据无法读取。')
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.passwordHash !== 'string' ||
    parsed.passwordHash.length > 512 ||
    !Number.isSafeInteger(parsed.sessionVersion) ||
    parsed.sessionVersion < 0
  ) {
    throw new PersistentStoreError('persistent_storage_unavailable', '管理员认证数据格式无效。')
  }
  return {
    passwordHash: parsed.passwordHash,
    sessionVersion: parsed.sessionVersion,
    storageReady: true,
  }
}

export async function bootstrapAdminAuthRecord(passwordHash) {
  if (typeof passwordHash !== 'string' || !passwordHash || passwordHash.length > 512) {
    throw new PersistentStoreError('invalid_admin_password_hash', '管理员密码记录无效。')
  }
  const record = JSON.stringify({ passwordHash, sessionVersion: 0 })
  const [result] = await runPipeline([
    ['EVAL', BOOTSTRAP_ADMIN_AUTH_SCRIPT, '1', adminAuthKey(), record],
  ])
  return Number(result) === 1
}

export async function replaceAdminPasswordHash(expectedHash, nextHash) {
  if (
    typeof expectedHash !== 'string' || !expectedHash || expectedHash.length > 512 ||
    typeof nextHash !== 'string' || !nextHash || nextHash.length > 512
  ) {
    throw new PersistentStoreError('invalid_admin_password_hash', '管理员密码记录无效。')
  }
  const [version] = await runPipeline([
    ['EVAL', CHANGE_ADMIN_PASSWORD_SCRIPT, '1', adminAuthKey(), expectedHash, nextHash],
  ])
  return Number.isSafeInteger(Number(version)) && Number(version) > 0
    ? { changed: true, sessionVersion: Number(version) }
    : { changed: false, sessionVersion: null }
}

export async function forceSetAdminPasswordHash(passwordHash) {
  if (typeof passwordHash !== 'string' || !passwordHash || passwordHash.length > 512) {
    throw new PersistentStoreError('invalid_admin_password_hash', '管理员密码记录无效。')
  }
  const current = await getAdminAuthRecord()
  const sessionVersion = Number(current.sessionVersion || 0) + 1
  await runPipeline([
    ['SET', adminAuthKey(), JSON.stringify({ passwordHash, sessionVersion })],
  ])
  return { changed: true, sessionVersion }
}

export function sendPersistentStoreError(res, error) {
  const known = error instanceof PersistentStoreError
  return res.status(503).json({
    ok: false,
    error: known ? error.code : 'persistent_storage_unavailable',
    message: known ? error.message : '持久化存储暂时不可用，请稍后重试。',
  })
}
