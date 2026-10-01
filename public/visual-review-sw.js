const quota = { used: 3.7 * 1024 ** 4, total: 6 * 1024 ** 4 }
const providers = {
  ok: true,
  defaultStorageId: 'pikpak-main',
  providers: [
    { id: 'pikpak-main', name: 'PikPak', selectable: true, status: 'connected', quota, capabilities: { list: true, download: true, upload: true, createFolder: true, rename: true, trash: true } },
    { id: 'quark-main', name: '夸克网盘', selectable: true, status: 'connected', quota: null, capabilities: { list: true, download: true, upload: false, createFolder: true, rename: false, trash: false } },
  ],
}
const stamp = (day, time = '12:00:00') => `2026-09-${day}T${time}.000Z`
const files = [
  { id: 'visual-video-1', name: '潮汐纪录.mp4', extension: 'mp4', mimeType: 'video/mp4', size: 1288490188, modifiedAt: stamp('30', '16:38:00') },
  { id: 'visual-video-2', name: '深蓝海域.webm', extension: 'webm', mimeType: 'video/webm', size: 812646400, modifiedAt: stamp('30', '10:59:00') },
  { id: 'visual-image', name: '北岸采样.png', extension: 'png', mimeType: 'image/png', size: 2411724, modifiedAt: stamp('29'), thumbnail: '/downloads/albums/ocean-postcard.svg' },
  { id: 'visual-pdf', name: '观察日志.pdf', extension: 'pdf', mimeType: 'application/pdf', size: 12582912, modifiedAt: stamp('28') },
  { id: 'visual-audio', name: '水下漫游.flac', extension: 'flac', mimeType: 'audio/flac', size: 53162800, modifiedAt: stamp('27') },
  { id: 'visual-novel', name: '蓝鲸与光.epub', extension: 'epub', mimeType: 'application/epub+zip', size: 824832, modifiedAt: stamp('26') },
  { id: 'visual-notes', name: '研发计划.txt', extension: 'txt', mimeType: 'text/plain', size: 4096, modifiedAt: stamp('25') },
  { id: 'visual-video-3', name: '海底峡谷.mp4', extension: 'mp4', mimeType: 'video/mp4', size: 394264576, modifiedAt: stamp('24') },
]

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } })
}

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname === '/api/storage-providers') {
    event.respondWith(jsonResponse(providers))
    return
  }
  if (url.pathname === '/api/storage-files') {
    const storageId = url.searchParams.get('storageId') || 'pikpak-main'
    const parentId = url.searchParams.get('parentId') || ''
    const items = !parentId
      ? [...files,
          { id: 'visual-album', name: '远航影集', parentId: '', isFolder: true, folderType: 'album', modifiedAt: stamp('29'), access: 'inherit', effectiveAccess: 'public', writable: true },
          { id: 'visual-private', name: '深蓝档案', parentId: '', isFolder: true, folderType: 'folder', modifiedAt: stamp('28'), access: 'locked', effectiveAccess: 'locked', writable: false },
        ]
      : [
          { id: 'visual-folder-nested', name: '原始片段', parentId, isFolder: true, modifiedAt: stamp('28') },
          { id: 'visual-folder-image', name: '海湾全景.png', parentId, extension: 'png', mimeType: 'image/png', size: 2411724, modifiedAt: stamp('29'), thumbnail: '/downloads/albums/ocean-postcard.svg' },
        ]
    event.respondWith(jsonResponse({ ok: true, storageId, parentId: parentId || null, folder: parentId ? { name: '远航影集', writable: true, type: 'album' } : null, items }))
  }
})
