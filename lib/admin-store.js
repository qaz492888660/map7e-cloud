const GLOBAL_ACCESS_KEY = 'map7e-cloud:global-access:v1'
const FOLDER_KEY_PREFIX = 'map7e-cloud:folder:v1:'
const ADMIN_AUTH_KEY = 'map7e-cloud:admin-auth:v1'
const DEFAULT_FOLDER_METADATA = Object.freeze({ type: 'folder', access: 'inherit', passwordMode: 'shared' })
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

function storageStatus() {
  const hasUrl = Boolean(process.env.UPSTASH_REDIS_REST_URL)
  const hasToken = Boolean(process.env.UPSTASH_REDIS_REST_TOKEN)
  if (hasUrl && hasToken) return 'ready'
  if (!hasUrl && !hasToken) return 'missing'
  return 'incomplete'
}

export function isPersistentStoreConfigured() {
  return storageStatus() === 'ready'
}

function storeNotReadyError() {
  const partial = storageStatus() === 'incomplete'
  return new PersistentStoreError(
    'persistent_storage_not_configured',
    partial
      ? '持久化存储环境变量不完整，请同时配置 UPSTASH_REDIS_REST_URL 和 UPSTASH_REDIS_REST_TOKEN。'
      : '管理配置需要持久化存储。请在 Vercel 环境变量中配置 UPSTASH_REDIS_REST_URL 和 UPSTASH_REDIS_REST_TOKEN。'
  )
}

function redisEndpoint() {
  const raw = process.env.UPSTASH_REDIS_REST_URL
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

  let response
  try {
    response = await fetch(`${redisEndpoint()}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
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
  return FOLDER_KEY_PREFIX + Buffer.from(String(folderId)).toString('base64url')
}

export async function getGlobalAccessState() {
  if (storageStatus() === 'missing') return { globalAccess: 'locked', storageReady: false }
  const [value] = await runPipeline([['GET', GLOBAL_ACCESS_KEY]])
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
  await runPipeline([['SET', GLOBAL_ACCESS_KEY, globalAccess]])
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

export async function getAdminAuthRecord() {
  if (storageStatus() === 'missing') {
    return { passwordHash: null, sessionVersion: 0, storageReady: false }
  }

  const [value] = await runPipeline([['GET', ADMIN_AUTH_KEY]])
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
    ['EVAL', BOOTSTRAP_ADMIN_AUTH_SCRIPT, '1', ADMIN_AUTH_KEY, record],
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
    ['EVAL', CHANGE_ADMIN_PASSWORD_SCRIPT, '1', ADMIN_AUTH_KEY, expectedHash, nextHash],
  ])
  return Number.isSafeInteger(Number(version)) && Number(version) > 0
    ? { changed: true, sessionVersion: Number(version) }
    : { changed: false, sessionVersion: null }
}

export function sendPersistentStoreError(res, error) {
  const known = error instanceof PersistentStoreError
  return res.status(503).json({
    ok: false,
    error: known ? error.code : 'persistent_storage_unavailable',
    message: known ? error.message : '持久化存储暂时不可用，请稍后重试。',
  })
}
