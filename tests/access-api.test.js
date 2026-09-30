import test from 'node:test'
import assert from 'node:assert/strict'
import dispatchHandler from '../api/dispatcher.js'
import filesHandler from '../lib/api-handlers/pikpak-files.js'
import downloadHandler from '../lib/api-handlers/pikpak-download.js'
import createFolderHandler from '../lib/api-handlers/pikpak-create-folder.js'
import adminLoginHandler from '../lib/api-handlers/admin-login.js'
import adminChangePasswordHandler from '../lib/api-handlers/admin-change-password.js'
import adminConfigHandler from '../lib/api-handlers/admin-config.js'
import adminFoldersHandler from '../lib/api-handlers/admin-folders.js'
import adminFileMetadataHandler from '../lib/api-handlers/admin-file-metadata.js'
import adminFolderMetadataHandler from '../lib/api-handlers/admin-folder-metadata.js'
import { createSessionToken } from '../lib/cloud-auth.js'
import { createAdminSessionToken } from '../lib/admin-auth.js'
import { getGlobalAccessState, isPersistentStoreConfigured, setFileMetadata, setFolderMetadata, setGlobalAccess } from '../lib/admin-store.js'

const originalFetch = globalThis.fetch
const envKeys = ['PIKPAK_PAT', 'CLOUD_PASSWORD', 'ADMIN_PASSWORD', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'VERCEL_ENV', 'QUARK_AUTH_BLOB']
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
process.env.VERCEL_ENV = 'production'
const redis = new Map()
const pikpakItems = new Map()
const directories = new Map()
const requestedDownloadLinks = []
const redisAuthHeaders = []
const ADMIN_AUTH_KEY = 'map7e-cloud:admin-auth:v1'
let createdFolderRequests = 0

function folderKey(folderId) {
  const prefix = process.env.VERCEL_ENV === 'preview' ? 'map7e-cloud:preview:' : 'map7e-cloud:'
  return `${prefix}folder:v1:${Buffer.from(folderId).toString('base64url')}`
}

function fileKey(fileId) {
  const prefix = process.env.VERCEL_ENV === 'preview' ? 'map7e-cloud:preview:' : 'map7e-cloud:'
  return `${prefix}file:v1:${Buffer.from(fileId).toString('base64url')}`
}

function resetFixtures() {
  redis.clear()
  pikpakItems.clear()
  directories.clear()
  requestedDownloadLinks.length = 0
  redisAuthHeaders.length = 0
  createdFolderRequests = 0
  directories.set('', [
    { id: 'root-file', name: 'root.txt', kind: 'drive#file', parent_id: '', links: { 'application/octet-stream': { url: 'https://cdn.example/root.txt' } } },
    { id: 'public-folder', name: 'Public', kind: 'drive#folder', parent_id: '', writable: true },
    { id: 'inherited-folder', name: 'Inherited', kind: 'drive#folder', parent_id: '', writable: true },
    { id: 'locked-folder', name: 'Locked', kind: 'drive#folder', parent_id: '', writable: true },
  ])
  for (const [parentId, items] of directories) {
    for (const item of items) pikpakItems.set(item.id, item)
  }
  directories.set('public-folder', [{ id: 'public-file', name: 'photo.jpg', kind: 'drive#file', parent_id: 'public-folder' }])
  directories.set('inherited-folder', [{ id: 'inherited-file', name: 'note.txt', kind: 'drive#file', parent_id: 'inherited-folder' }])
  directories.set('locked-folder', [{ id: 'protected-file', name: 'secret.txt', kind: 'drive#file', parent_id: 'locked-folder', links: { 'application/octet-stream': { url: 'https://cdn.example/secret.txt' } } }])
  for (const items of directories.values()) {
    for (const item of items) pikpakItems.set(item.id, item)
  }
}

function redisResponse(commands) {
  return commands.map((command) => {
    const [name, key, value] = command
    if (name === 'GET') return { result: redis.get(key) ?? null }
    if (name === 'SET') {
      redis.set(key, String(value))
      return { result: 'OK' }
    }
    if (name === 'EVAL') {
      const script = String(command[1])
      const recordKey = String(command[3])
      if (script.includes('map7e-bootstrap-admin-auth')) {
        if (redis.has(recordKey)) return { result: 0 }
        redis.set(recordKey, String(command[4]))
        return { result: 1 }
      }
      if (script.includes('map7e-change-admin-password')) {
        const raw = redis.get(recordKey)
        if (!raw) return { error: 'admin_auth_record_missing' }
        const record = JSON.parse(raw)
        if (record.passwordHash !== String(command[4])) return { result: 0 }
        record.passwordHash = String(command[5])
        record.sessionVersion = Number(record.sessionVersion) + 1
        redis.set(recordKey, JSON.stringify(record))
        return { result: record.sessionVersion }
      }
    }
    return { error: `unsupported command ${name}` }
  })
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input)
  if (url.hostname === 'redis.test') {
    redisAuthHeaders.push(options.headers?.Authorization)
    const commands = JSON.parse(options.body)
    return new Response(JSON.stringify(redisResponse(commands)), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  if (url.hostname === 'api-drive.mypikpak.com') {
    if (url.pathname === '/drive/v1/files' && options.method === 'POST') {
      createdFolderRequests += 1
      const request = JSON.parse(options.body)
      const item = {
        id: `created-folder-${createdFolderRequests}`,
        name: request.name,
        kind: 'drive#folder',
        parent_id: request.parent_id || '',
        writable: true,
      }
      pikpakItems.set(item.id, item)
      directories.set(item.id, [])
      directories.set(item.parent_id, [...(directories.get(item.parent_id) || []), item])
      return new Response(JSON.stringify(item), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.pathname.startsWith('/drive/v1/files/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop())
      const item = pikpakItems.get(id)
      return item
        ? new Response(JSON.stringify(item), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    }

    const parentId = url.searchParams.get('parent_id') || ''
    const allItems = directories.get(parentId) || []
    const page = Number(url.searchParams.get('page_token') || 0)
    const start = page * 100
    const pageItems = allItems.slice(start, start + 100)
    const nextPageToken = start + 100 < allItems.length ? String(page + 1) : null
    return new Response(JSON.stringify({ files: pageItems, next_page_token: nextPageToken, sync_time: '2026-09-29T00:00:00Z' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (url.hostname === 'cdn.example') requestedDownloadLinks.push(url.href)
  return new Response('', { status: 404 })
}

function responseStub() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    status(code) { this.statusCode = code; return this },
    setHeader(name, value) { this.headers[name] = value },
    json(payload) { this.body = payload; return this },
    end() { this.ended = true; return this },
  }
}

async function invoke(handler, { method = 'GET', query = {}, body = {}, cookie = '' } = {}) {
  const req = { method, query, body, headers: { cookie } }
  const res = responseStub()
  await handler(req, res)
  return res
}

function setGlobal(access) {
  const prefix = process.env.VERCEL_ENV === 'preview' ? 'map7e-cloud:preview:' : 'map7e-cloud:'
  redis.set(`${prefix}global-access:v1`, access)
}

function setFolder(folderId, access, type = 'folder') {
  redis.set(folderKey(folderId), JSON.stringify({ folderId, access, type }))
}

function setFile(fileId, access) {
  redis.set(fileKey(fileId), JSON.stringify({ fileId, access }))
}

test('API enforces global and folder access before returning file listings', async () => {
  process.env.PIKPAK_PAT = 'test-pikpak-token-signing-key'
  process.env.CLOUD_PASSWORD = 'visitor-password'
  process.env.ADMIN_PASSWORD = 'separate-admin-password'
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test'
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-redis-token'
  resetFixtures()

  setGlobal('public')
  let response = await invoke(filesHandler)
  assert.equal(response.statusCode, 200, 'global public permits an anonymous root read')
  assert.equal(response.body.items.some((item) => item.id === 'root-file'), true)

  setGlobal('locked')
  response = await invoke(filesHandler)
  assert.equal(response.statusCode, 401, 'global locked denies an anonymous root read')

  const cloudCookie = `map7e_cloud_session=${createSessionToken(process.env.PIKPAK_PAT).token}`
  response = await invoke(filesHandler, { cookie: cloudCookie })
  assert.equal(response.statusCode, 200, 'the existing cloud password session grants access')

  for (const [globalAccess, folderId, explicitAccess, expected] of [
    ['locked', 'inherited-folder', 'inherit', 401],
    ['locked', 'public-folder', 'public', 200],
    ['locked', 'locked-folder', 'locked', 401],
    ['public', 'inherited-folder', 'inherit', 200],
    ['public', 'locked-folder', 'locked', 401],
  ]) {
    setGlobal(globalAccess)
    if (explicitAccess === 'inherit') redis.delete(folderKey(folderId))
    else setFolder(folderId, explicitAccess)
    response = await invoke(filesHandler, { query: { parentId: folderId } })
    assert.equal(response.statusCode, expected, `${globalAccess}/${explicitAccess} on ${folderId}`)
  }

  setGlobal('locked')
  setFolder('public-folder', 'public', 'album')
  response = await invoke(filesHandler)
  assert.equal(response.statusCode, 200, 'a public root folder stays discoverable under a locked global policy')
  assert.equal(response.body.restrictedPreview, true)
  assert.deepEqual(response.body.items.map((item) => item.id), ['public-folder'])
  assert.equal(response.body.items[0].folderType, 'album')
  assert.equal(response.body.items[0].effectiveAccess, 'public')

  setFile('root-file', 'public')
  response = await invoke(filesHandler)
  assert.equal(response.statusCode, 200, 'an explicitly public root file stays discoverable under a locked global policy')
  assert.equal(response.body.items.some((item) => item.id === 'root-file' && item.effectiveAccess === 'public'), true)

  const manyRootFiles = Array.from({ length: 100 }, (_, index) => ({
    id: `page-file-${index}`,
    name: `file-${index}.txt`,
    kind: 'drive#file',
    parent_id: '',
  }))
  directories.set('', [...manyRootFiles, pikpakItems.get('public-folder')])
  response = await invoke(filesHandler)
  assert.equal(response.statusCode, 200, 'public folders on later root pages remain discoverable')
  assert.deepEqual(response.body.items.map((item) => item.id), ['public-folder'])
})

test('dispatcher maps API paths to handlers and rejects unknown or unauthenticated admin routes', async () => {
  process.env.PIKPAK_PAT = 'test-pikpak-token-signing-key'
  process.env.CLOUD_PASSWORD = 'visitor-password'
  process.env.ADMIN_PASSWORD = 'separate-admin-password'
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test'
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-redis-token'
  resetFixtures()

  const protectedRoute = await invoke(dispatchHandler, { query: { route: 'admin-config' } })
  assert.equal(protectedRoute.statusCode, 401, 'the routed admin API still requires an admin session')

  const unknownRoute = await invoke(dispatchHandler, { query: { route: 'not-a-route' } })
  assert.equal(unknownRoute.statusCode, 404)
})

test('generic storage APIs expose providers and keep PikPak behavior compatible', async () => {
  process.env.PIKPAK_PAT = 'test-pikpak-token-signing-key'
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test'
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-redis-token'
  delete process.env.QUARK_AUTH_BLOB
  resetFixtures()
  setGlobal('public')

  let response = await invoke(dispatchHandler, { query: { route: 'storage-providers' } })
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.defaultStorageId, 'pikpak-main')
  assert.deepEqual(
    response.body.providers.map((provider) => [provider.id, provider.status, provider.selectable]),
    [
      ['pikpak-main', 'connected', true],
      ['quark-main', 'authorization_required', false],
    ],
  )

  response = await invoke(dispatchHandler, { query: { route: 'storage-files', storageId: 'pikpak-main' } })
  assert.equal(response.statusCode, 200)
  assert.ok(response.body.items.some((item) => item.id === 'root-file'))

  response = await invoke(dispatchHandler, { query: { route: 'storage-files', storageId: 'quark-main' } })
  assert.equal(response.statusCode, 409)
  assert.equal(response.body.error, 'storage_authorization_required')
})

test('direct downloads check the actual parent path and do not disclose a URL when locked', async () => {
  process.env.PIKPAK_PAT = 'test-pikpak-token-signing-key'
  process.env.CLOUD_PASSWORD = 'visitor-password'
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test'
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-redis-token'
  resetFixtures()
  setGlobal('locked')
  setFolder('locked-folder', 'locked')

  let response = await invoke(downloadHandler, { query: { id: 'protected-file', parentId: 'locked-folder' } })
  assert.equal(response.statusCode, 401)
  assert.equal(response.headers.Location, undefined)
  assert.equal(requestedDownloadLinks.length, 0)

  const cloudCookie = `map7e_cloud_session=${createSessionToken(process.env.PIKPAK_PAT).token}`
  response = await invoke(downloadHandler, { query: { id: 'protected-file', parentId: 'locked-folder' }, cookie: cloudCookie })
  assert.equal(response.statusCode, 302)
  assert.equal(response.headers.Location, 'https://cdn.example/secret.txt')

  setFolder('public-folder', 'public')
  pikpakItems.set('public-file', {
    id: 'public-file',
    name: 'public.jpg',
    kind: 'drive#file',
    parent_id: 'public-folder',
    links: { 'application/octet-stream': { url: 'https://cdn.example/public.jpg' } },
  })
  response = await invoke(downloadHandler, { query: { id: 'public-file', parentId: 'public-folder' } })
  assert.equal(response.statusCode, 302, 'a public folder can be downloaded while the global policy is locked')
  assert.equal(response.headers.Location, 'https://cdn.example/public.jpg')

  const publicChild = { id: 'public-child', name: 'Open Child', kind: 'drive#folder', parent_id: 'locked-folder' }
  pikpakItems.set(publicChild.id, publicChild)
  directories.set('locked-folder', [publicChild])
  directories.set('public-child', [{
    id: 'nested-public-file',
    name: 'open.txt',
    kind: 'drive#file',
    parent_id: 'public-child',
    links: { 'application/octet-stream': { url: 'https://cdn.example/nested.txt' } },
  }])
  pikpakItems.set('nested-public-file', directories.get('public-child')[0])
  setFolder('public-child', 'public')
  response = await invoke(downloadHandler, { query: { id: 'nested-public-file', parentId: 'public-child' } })
  assert.equal(response.statusCode, 302, 'an explicit public child overrides its locked ancestor')
  assert.equal(response.headers.Location, 'https://cdn.example/nested.txt')

  setGlobal('public')
  setFile('root-file', 'locked')
  response = await invoke(downloadHandler, { query: { id: 'root-file', parentId: '' } })
  assert.equal(response.statusCode, 401, 'a file-level lock overrides a public parent')
  response = await invoke(downloadHandler, { query: { id: 'root-file', parentId: '' }, cookie: cloudCookie })
  assert.equal(response.statusCode, 302)

  setGlobal('locked')
  setFile('root-file', 'public')
  response = await invoke(downloadHandler, { query: { id: 'root-file', parentId: '' } })
  assert.equal(response.statusCode, 302, 'a file-level public override can expose one root file while the drive is locked')
  assert.equal(response.headers.Location, 'https://cdn.example/root.txt')
})

test('admin writes require the separate administrator cookie and persist metadata', async () => {
  process.env.PIKPAK_PAT = 'test-pikpak-token-signing-key'
  process.env.CLOUD_PASSWORD = 'visitor-password'
  process.env.ADMIN_PASSWORD = 'separate-admin-password'
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test'
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-redis-token'
  resetFixtures()
  setGlobal('locked')

  const cloudCookie = `map7e_cloud_session=${createSessionToken(process.env.PIKPAK_PAT).token}`
  let response = await invoke(adminConfigHandler, {
    method: 'POST',
    body: { globalAccess: 'public' },
    cookie: cloudCookie,
  })
  assert.equal(response.statusCode, 401, 'a normal cloud session cannot change global settings')

  response = await invoke(adminLoginHandler, { method: 'POST', body: { password: 'separate-admin-password' } })
  assert.equal(response.statusCode, 200)
  assert.equal(Object.hasOwn(response.body, 'password'), false)
  assert.match(response.headers['Set-Cookie'], /HttpOnly/)
  const adminCookie = response.headers['Set-Cookie'].split(';')[0]

  setGlobal('locked')
  const adminRead = await invoke(filesHandler, { cookie: adminCookie })
  assert.equal(adminRead.statusCode, 200, 'administrator authentication can read locked content without a visitor session')

  response = await invoke(adminConfigHandler, {
    method: 'POST',
    body: { globalAccess: 'public' },
    cookie: adminCookie,
  })
  assert.equal(response.statusCode, 200)
  assert.equal(redis.get('map7e-cloud:global-access:v1'), 'public')

  response = await invoke(adminFolderMetadataHandler, {
    method: 'POST',
    body: { folderId: 'locked-folder', type: 'album', access: 'locked' },
    cookie: adminCookie,
  })
  assert.equal(response.statusCode, 200)
  const storedMetadata = JSON.parse(redis.get(folderKey('locked-folder')))
  assert.equal(storedMetadata.folderId, 'locked-folder')
  assert.equal(storedMetadata.type, 'album')
  assert.equal(storedMetadata.access, 'locked')
  assert.match(storedMetadata.updatedAt, /^\d{4}-\d{2}-\d{2}T/)

  response = await invoke(adminFileMetadataHandler, {
    method: 'POST',
    body: { fileId: 'root-file', access: 'locked' },
    cookie: adminCookie,
  })
  assert.equal(response.statusCode, 200)
  const storedFileMetadata = JSON.parse(redis.get(fileKey('root-file')))
  assert.equal(storedFileMetadata.fileId, 'root-file')
  assert.equal(storedFileMetadata.access, 'locked')
})

test('bootstrap password is hashed, changed password takes precedence, and old admin sessions expire', async () => {
  process.env.PIKPAK_PAT = 'test-pikpak-token-signing-key'
  process.env.ADMIN_PASSWORD = 'initial-bootstrap-admin-password'
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test'
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-redis-token'
  resetFixtures()

  let response = await invoke(adminLoginHandler, { method: 'POST', body: { password: 'wrong-bootstrap-password' } })
  assert.equal(response.statusCode, 401)
  assert.equal(redis.has(ADMIN_AUTH_KEY), false)

  response = await invoke(adminLoginHandler, { method: 'POST', body: { password: 'initial-bootstrap-admin-password' } })
  assert.equal(response.statusCode, 200)
  assert.equal(Object.hasOwn(response.body, 'passwordHash'), false)
  assert.equal(Object.hasOwn(response.body, 'password'), false)
  const firstCookie = response.headers['Set-Cookie'].split(';')[0]
  const initialRecord = JSON.parse(redis.get(ADMIN_AUTH_KEY))
  assert.match(initialRecord.passwordHash, /^scrypt\$16384\$8\$1\$/)
  assert.equal(initialRecord.sessionVersion, 0)
  assert.equal(redis.get(ADMIN_AUTH_KEY).includes('initial-bootstrap-admin-password'), false)

  const visitorCookie = `map7e_cloud_session=${createSessionToken(process.env.PIKPAK_PAT).token}`
  response = await invoke(adminChangePasswordHandler, {
    method: 'POST',
    cookie: visitorCookie,
    body: {
      currentPassword: 'initial-bootstrap-admin-password',
      newPassword: 'a-new-admin-password-long-enough',
      confirmPassword: 'a-new-admin-password-long-enough',
    },
  })
  assert.equal(response.statusCode, 401, 'a visitor session cannot change the administrator password')

  process.env.ADMIN_PASSWORD = 'rotated-environment-bootstrap-password'
  response = await invoke(adminLoginHandler, {
    method: 'POST',
    body: { password: 'rotated-environment-bootstrap-password' },
  })
  assert.equal(response.statusCode, 401, 'a stored password hash takes precedence over a changed deployment secret')

  response = await invoke(adminChangePasswordHandler, {
    method: 'POST',
    cookie: firstCookie,
    body: {
      currentPassword: 'incorrect-current-password',
      newPassword: 'a-new-admin-password-long-enough',
      confirmPassword: 'a-new-admin-password-long-enough',
    },
  })
  assert.equal(response.statusCode, 401, 'changing the password requires the current password')

  response = await invoke(adminChangePasswordHandler, {
    method: 'POST',
    cookie: firstCookie,
    body: {
      currentPassword: 'initial-bootstrap-admin-password',
      newPassword: 'a-new-admin-password-long-enough',
      confirmPassword: 'a-different-password-long-enough',
    },
  })
  assert.equal(response.statusCode, 400, 'new password confirmation must match')

  response = await invoke(adminChangePasswordHandler, {
    method: 'POST',
    cookie: firstCookie,
    body: {
      currentPassword: 'initial-bootstrap-admin-password',
      newPassword: '1',
      confirmPassword: '1',
    },
  })
  assert.equal(response.statusCode, 200, 'a one-character non-empty admin password is allowed')
  assert.equal(response.body.passwordHash, undefined)
  assert.match(response.headers['Set-Cookie'], /Max-Age=0/)
  const changedRecord = JSON.parse(redis.get(ADMIN_AUTH_KEY))
  assert.equal(changedRecord.sessionVersion, 1)
  assert.notEqual(changedRecord.passwordHash, initialRecord.passwordHash)
  assert.match(changedRecord.passwordHash, /^scrypt\$/)

  response = await invoke(adminConfigHandler, { cookie: firstCookie })
  assert.equal(response.statusCode, 401, 'old signed administrator sessions are invalid after a password change')

  response = await invoke(adminLoginHandler, {
    method: 'POST',
    body: { password: 'initial-bootstrap-admin-password' },
  })
  assert.equal(response.statusCode, 401)

  response = await invoke(adminLoginHandler, {
    method: 'POST',
    body: { password: '1' },
  })
  assert.equal(response.statusCode, 200)
  assert.equal(Object.hasOwn(response.body, 'passwordHash'), false)
  const newCookie = response.headers['Set-Cookie'].split(';')[0]
  response = await invoke(adminConfigHandler, { cookie: newCookie })
  assert.equal(response.statusCode, 200, 'the newly stored password can create a valid admin session')
})

test('admin folder listing reads PikPak folders and returns default metadata for old folders', async () => {
  process.env.PIKPAK_PAT = 'test-pikpak-token-signing-key'
  process.env.ADMIN_PASSWORD = 'separate-admin-password'
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test'
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-redis-token'
  resetFixtures()
  setGlobal('locked')
  setFolder('public-folder', 'public', 'album')

  const session = createAdminSessionToken()
  const response = await invoke(adminFoldersHandler, {
    cookie: `map7e_admin_session=${session.token}`,
  })
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.folders.length, 3)
  const publicFolder = response.body.folders.find((folder) => folder.id === 'public-folder')
  const oldFolder = response.body.folders.find((folder) => folder.id === 'inherited-folder')
  assert.equal(publicFolder.type, 'album')
  assert.equal(publicFolder.access, 'public')
  assert.equal(publicFolder.effectiveAccess, 'public')
  assert.equal(oldFolder.type, 'folder')
  assert.equal(oldFolder.access, 'inherit')
  assert.equal(oldFolder.effectiveAccess, 'locked')
})

test('new-folder metadata options require admin auth and persist after PikPak creation', async () => {
  process.env.PIKPAK_PAT = 'test-pikpak-token-signing-key'
  process.env.CLOUD_PASSWORD = 'visitor-password'
  process.env.ADMIN_PASSWORD = 'separate-admin-password'
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test'
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-redis-token'
  resetFixtures()
  setGlobal('locked')

  const cloudCookie = `map7e_cloud_session=${createSessionToken(process.env.PIKPAK_PAT).token}`
  let response = await invoke(createFolderHandler, {
    method: 'POST',
    body: { name: 'New Album', parentId: '', type: 'album', access: 'locked' },
    cookie: cloudCookie,
  })
  assert.equal(response.statusCode, 401)
  assert.equal(createdFolderRequests, 0, 'the folder is not created when the metadata write is unauthorized')

  const adminSession = createAdminSessionToken()
  response = await invoke(createFolderHandler, {
    method: 'POST',
    body: { name: 'New Album', parentId: '', type: 'album', access: 'locked' },
    cookie: `map7e_admin_session=${adminSession.token}`,
  })
  assert.equal(response.statusCode, 200, 'the admin session alone can create and classify a folder')
  assert.equal(response.body.metadataSaved, true)
  const id = response.body.item.id
  const metadata = JSON.parse(redis.get(folderKey(id)))
  assert.equal(metadata.folderId, id)
  assert.equal(metadata.type, 'album')
  assert.equal(metadata.access, 'locked')
  assert.equal(metadata.passwordMode, 'shared')
  assert.match(metadata.updatedAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('missing persistent storage preserves locked legacy access and refuses config writes', async () => {
  process.env.PIKPAK_PAT = 'test-pikpak-token-signing-key'
  process.env.ADMIN_PASSWORD = 'separate-admin-password'
  delete process.env.UPSTASH_REDIS_REST_URL
  delete process.env.UPSTASH_REDIS_REST_TOKEN

  assert.deepEqual(await getGlobalAccessState(), { globalAccess: 'locked', storageReady: false })
  const session = createAdminSessionToken()
  const response = await invoke(adminConfigHandler, {
    method: 'POST',
    body: { globalAccess: 'public' },
    cookie: `map7e_admin_session=${session.token}`,
  })
  assert.equal(response.statusCode, 503)
  assert.equal(response.body.error, 'persistent_storage_not_configured')
})

test('Vercel Upstash variables work and Preview settings are isolated from Production', async () => {
  delete process.env.UPSTASH_REDIS_REST_URL
  delete process.env.UPSTASH_REDIS_REST_TOKEN
  process.env.KV_REST_API_URL = 'https://redis.test'
  process.env.KV_REST_API_TOKEN = 'test-kv-token'
  resetFixtures()

  process.env.VERCEL_ENV = 'production'
  await setGlobalAccess('locked')
  await setFolderMetadata('shared-folder', { type: 'folder', access: 'inherit' })
  await setFileMetadata('shared-file', { access: 'locked' })
  assert.equal(redis.get('map7e-cloud:global-access:v1'), 'locked')
  assert.equal(redis.has(`map7e-cloud:folder:v1:${Buffer.from('shared-folder').toString('base64url')}`), true)
  assert.equal(redis.has(`map7e-cloud:file:v1:${Buffer.from('shared-file').toString('base64url')}`), true)

  process.env.VERCEL_ENV = 'preview'
  assert.equal(isPersistentStoreConfigured(), true, 'the Upstash integration REST variables enable persistent storage')
  assert.deepEqual(await getGlobalAccessState(), { globalAccess: 'locked', storageReady: true }, 'Preview defaults independently when it has no saved global setting')
  assert.equal(redisAuthHeaders.at(-1), 'Bearer test-kv-token')
  await setGlobalAccess('public')
  await setFolderMetadata('shared-folder', { type: 'album', access: 'locked' })
  await setFileMetadata('shared-file', { access: 'public' })
  assert.equal(redis.get('map7e-cloud:preview:global-access:v1'), 'public')
  assert.equal(redis.get(`map7e-cloud:preview:folder:v1:${Buffer.from('shared-folder').toString('base64url')}`) !== redis.get(`map7e-cloud:folder:v1:${Buffer.from('shared-folder').toString('base64url')}`), true)
  assert.equal(redis.get(`map7e-cloud:preview:file:v1:${Buffer.from('shared-file').toString('base64url')}`) !== redis.get(`map7e-cloud:file:v1:${Buffer.from('shared-file').toString('base64url')}`), true)
  assert.equal(redis.get('map7e-cloud:global-access:v1'), 'locked', 'Preview writes leave Production settings unchanged')
})

test.after(() => {
  globalThis.fetch = originalFetch
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
})
