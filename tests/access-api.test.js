import test from 'node:test'
import assert from 'node:assert/strict'
import filesHandler from '../api/pikpak-files.js'
import downloadHandler from '../api/pikpak-download.js'
import createFolderHandler from '../api/pikpak-create-folder.js'
import adminLoginHandler from '../api/admin-login.js'
import adminConfigHandler from '../api/admin-config.js'
import adminFoldersHandler from '../api/admin-folders.js'
import adminFolderMetadataHandler from '../api/admin-folder-metadata.js'
import { createSessionToken } from '../lib/cloud-auth.js'
import { createAdminSessionToken } from '../lib/admin-auth.js'
import { getGlobalAccessState } from '../lib/admin-store.js'

const originalFetch = globalThis.fetch
const envKeys = ['PIKPAK_PAT', 'CLOUD_PASSWORD', 'ADMIN_PASSWORD', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
const redis = new Map()
const pikpakItems = new Map()
const directories = new Map()
const requestedDownloadLinks = []
let createdFolderRequests = 0

function folderKey(folderId) {
  return `map7e-cloud:folder:v1:${Buffer.from(folderId).toString('base64url')}`
}

function resetFixtures() {
  redis.clear()
  pikpakItems.clear()
  directories.clear()
  requestedDownloadLinks.length = 0
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
    return { error: `unsupported command ${name}` }
  })
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input)
  if (url.hostname === 'redis.test') {
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
  redis.set('map7e-cloud:global-access:v1', access)
}

function setFolder(folderId, access, type = 'folder') {
  redis.set(folderKey(folderId), JSON.stringify({ folderId, access, type }))
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
    cookie: `${cloudCookie}; map7e_admin_session=${adminSession.token}`,
  })
  assert.equal(response.statusCode, 200)
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

test.after(() => {
  globalThis.fetch = originalFetch
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
})
