<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const BLOG_VIDEO_URL = 'https://blog.map7e.com/videos/underwater.mp4'
const TEXT_EXTENSIONS = ['txt', 'md', 'markdown', 'json', 'csv', 'xml', 'yaml', 'yml', 'log', 'ini']
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'svg']
const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'm4v']
const rootFolders = ref([])
const folderMap = ref({})
const rootFiles = ref([])
const directoryMetadata = ref({})
const manifestUpdatedAt = ref('')
const storageProviders = ref([])
const activeStorageId = ref('pikpak-main')
const activeCapabilities = computed(() => storageProviders.value.find(p => p.id === activeStorageId.value)?.capabilities || {})
const activeStorageName = computed(() => storageProviders.value.find((provider) => provider.id === activeStorageId.value)?.name || '网盘')
const loadingLibrary = ref(true)
const errorMessage = ref('')
const authRequired = ref(false)
const authPassword = ref('')
const authenticating = ref(false)
const folderTrail = ref([])
const uploadInput = ref(null)
const uploading = ref(false)
const uploadStatus = ref('')
const currentView = ref('home')
const activeFileFolder = ref('')
const searchQuery = ref('')
const viewerItems = ref([])
const viewerIndex = ref(-1)
const viewerScale = ref(1)
const viewerDimensions = ref('')
const previewFile = ref(null)
const previewMode = ref('')
const previewText = ref('')
const previewLoading = ref(false)
const previewError = ref('')
const selectedAction = ref(null)
const managementDialog = ref('')
const managementItem = ref(null)
const managementParentId = ref('')
const managementWritable = ref(true)
const managementName = ref('')
const managementError = ref('')
const managementBusy = ref(false)
const managementStatus = ref('')
const newFolderType = ref('folder')
const newFolderAccess = ref('inherit')
const fileNameInput = ref(null)
let touchOrigin = null
let pendingDeepLinkFolderId = ''

const activeFolder = computed(() => folderMap.value[activeFileFolder.value] || null)
const allFiles = computed(() => {
  const unique = new Map()
  ;[...rootFiles.value, ...Object.values(folderMap.value).flatMap((folder) => folder.files || [])]
    .filter((item) => !item.isFolder)
    .forEach((item) => unique.set(item.id || item.path, item))
  return [...unique.values()]
})
const albumFiles = computed(() => allFiles.value)
const albumPhotos = computed(() => albumFiles.value.filter(isImageFile))
const allPhotos = computed(() => albumPhotos.value)
const allDocuments = computed(() => allFiles.value.filter((file) => !isImageFile(file)))
const photoCount = computed(() => allPhotos.value.length)
const fileCount = computed(() => allDocuments.value.length)
const contentCount = computed(() => photoCount.value + fileCount.value)
const photoRatio = computed(() => contentCount.value ? (photoCount.value / contentCount.value) * 100 : 0)
const modalOpen = computed(() => viewerIndex.value >= 0 || Boolean(previewFile.value) || Boolean(selectedAction.value) || Boolean(managementDialog.value))
const viewerImage = computed(() => viewerItems.value[viewerIndex.value] || null)
const visiblePhotos = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase()
  if (!query) return albumPhotos.value
  return albumPhotos.value.filter((file) => file.name.toLocaleLowerCase().includes(query))
})
const albumUpdatedAt = computed(() => latestDate(albumPhotos.value))
const latestFileDate = computed(() => latestDate(allDocuments.value))
const fileFolders = computed(() => {
  return rootFolders.value.map((folder) => ({
    ...folder,
    files: folderMap.value[folder.slug]?.files || [],
    fileCount: (folderMap.value[folder.slug]?.files || []).filter((file) => !file.isFolder).length,
  }))
})
const rootLooseFiles = computed(() => rootFiles.value.filter((item) => !item.isFolder))
const activeFileFolderData = computed(() => activeFolder.value)
const activeDirectoryWritable = computed(() => activeFileFolderData.value?.writable !== false)
const managementSubmitDisabled = computed(() => {
  if (managementBusy.value) return true
  if (managementDialog.value === 'trash') return false
  const name = managementDialog.value === 'rename'
    ? renamedFileName(managementName.value, managementItem.value)
    : managementName.value
  return !managementNameIsValid(name)
})
const currentFileItems = computed(() => activeFileFolderData.value?.files || [])
const visibleCurrentFiles = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase()
  return currentFileItems.value.filter((file) => !file.isFolder && (!query || file.name.toLocaleLowerCase().includes(query)))
})
const visibleAlbumFolderPhotos = computed(() => visibleCurrentFiles.value.filter(isImageFile))
const visibleNonImageFolderFiles = computed(() => visibleCurrentFiles.value.filter((file) => !isImageFile(file)))
const visibleCurrentFolders = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase()
  return currentFileItems.value.filter((file) => file.isFolder && (!query || file.name.toLocaleLowerCase().includes(query)))
})
const visibleFileFolders = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase()
  if (!query) return fileFolders.value
  return fileFolders.value.filter((folder) => folder.name.toLocaleLowerCase().includes(query))
})
const rootFileSearchResults = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase()
  if (!query) return rootLooseFiles.value
  return rootLooseFiles.value.filter((file) => file.name.toLocaleLowerCase().includes(query))
})
const locationLabel = computed(() => {
  if (currentView.value === 'home') return '家 / Map7e'
  if (currentView.value === 'albums') return '家 / 相册目录'
  return activeFileFolderData.value ? '家 / 文件目录 / ' + activeFileFolderData.value.name : '家 / 文件目录'
})
const backLabel = computed(() => currentView.value === 'files' && activeFileFolder.value ? '文件目录' : 'Map7e')
const currentHeading = computed(() => {
  if (currentView.value === 'albums') return '相册目录'
  if (activeFileFolderData.value) return activeFileFolderData.value.name
  return '文件目录'
})
const currentFileCount = computed(() => activeFileFolderData.value ? activeFileFolderData.value.files.filter((file) => !file.isFolder).length : rootLooseFiles.value.length)
const photoCounter = computed(() => viewerItems.value.length > 1 ? (viewerIndex.value + 1) + ' / ' + viewerItems.value.length : '图片预览')

function isImageFile(file) {
  if (file?.type === 'image') return true
  return IMAGE_EXTENSIONS.includes(file?.extension || extensionOf(file?.name))
}

function extensionOf(name) {
  const parts = String(name || '').split('.')
  return parts.length > 1 ? parts.pop().toLocaleLowerCase() : ''
}

function classifyType(item) {
  if (item?.isFolder) return 'folder'
  const mime = String(item?.mimeType || '').toLowerCase()
  const ext = String(item?.extension || extensionOf(item?.name)).toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) return 'archive'
  if (mime.startsWith('text/') || ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'json', 'csv'].includes(ext)) return 'document'
  return 'other'
}

function formatDate(value) {
  if (!value) return ''
  const text = String(value)
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : ''
}

function normalizePikPakItem(file) {
  const isFolder = Boolean(file?.isFolder)
  const extension = String(file?.extension || extensionOf(file?.name))
  const sizeBytes = file?.size === null || file?.size === undefined || file?.size === '' ? null : Number(file.size)
  return {
    id: String(file?.id || ''),
    parentId: String(file?.parentId || ''),
    name: String(file?.name || '未命名文件'),
    path: isFolder ? '' : '/api/storage-download?storageId=' + encodeURIComponent(activeStorageId.value) + '&id=' + encodeURIComponent(String(file?.id || '')) + '&parentId=' + encodeURIComponent(String(file?.parentId || '')),
    size: isFolder ? '' : (sizeBytes !== null && Number.isFinite(sizeBytes) && sizeBytes >= 0 ? formatBytes(sizeBytes) : ''),
    sizeBytes: !isFolder && sizeBytes !== null && Number.isFinite(sizeBytes) && sizeBytes >= 0 ? sizeBytes : null,
    rawSize: sizeBytes !== null && Number.isFinite(sizeBytes) && sizeBytes >= 0 ? sizeBytes : null,
    date: formatDate(file?.modifiedAt || file?.createdAt),
    modifiedAt: file?.modifiedAt || file?.createdAt || '',
    type: classifyType(file),
    mimeType: String(file?.mimeType || ''),
    description: '',
    extension: extension.toLocaleLowerCase(),
    isFolder,
    folderType: file?.folderType === 'album' ? 'album' : 'folder',
    access: ['inherit', 'public', 'locked'].includes(file?.access) ? file.access : 'inherit',
    effectiveAccess: file?.effectiveAccess === 'locked' ? 'locked' : 'public',
    writable: file?.writable !== false,
    thumbnail: file?.thumbnail || null,
  }
}

function normalizeRootFolder(item) {
  return {
    ...normalizePikPakItem(item),
    slug: String(item?.id || ''),
    description: activeStorageName.value + ' 实时目录',
    updatedLabel: formatDate(item?.modifiedAt || item?.createdAt),
    updatedAt: formatDate(item?.modifiedAt || item?.createdAt),
  }
}

function latestDate(files) {
  return files.map((file) => file.date || '').filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort().reverse()[0] || ''
}

function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const amount = bytes / 1024 ** index
  return (amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)) + ' ' + units[index]
}

function fileSizeLabel(file) {
  return file.sizeBytes !== null ? formatBytes(file.sizeBytes) : (file.size || '大小未知')
}

function fileTypeLabel(file) {
  if (file.isFolder) return '文件夹'
  if (file.extension) return file.extension.toLocaleUpperCase()
  const labels = { archive: '压缩包', document: '文档', image: '图片', video: '视频', other: '文件' }
  return labels[file.type] || labels.other
}

function fileIconClass(file) {
  if (file.isFolder) return 'file-icon--folder'
  if (file.type === 'archive') return 'file-icon--archive'
  if (isImageFile(file)) return 'file-icon--image'
  if (file.type === 'video' || VIDEO_EXTENSIONS.includes(file.extension)) return 'file-icon--video'
  if (file.extension === 'json') return 'file-icon--code'
  return 'file-icon--document'
}

function dateLabel(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : ''
}

async function apiJson(url, options = {}) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { Accept: 'application/json', ...(options.headers || {}) },
    ...options,
  })
  const payload = await response.json().catch(() => ({}))
  if (response.status === 401) {
    const error = new Error('需要先登录云盘。')
    error.code = 'authentication_required'
    throw error
  }
  if (!response.ok || payload?.ok === false) throw new Error(payload?.message || payload?.error || ('HTTP ' + response.status))
  return payload
}

async function listPikPakItems(parentId = '') {
  const storageId = activeStorageId.value
  const items = []
  let pageToken = ''
  const seenTokens = new Set()
  do {
    const params = new URLSearchParams()
    params.set('storageId', storageId)
    if (parentId) params.set('parentId', parentId)
    if (pageToken) params.set('pageToken', pageToken)
    const payload = await apiJson('/api/storage-files?' + params.toString())
    if (storageId !== activeStorageId.value) throw new Error('网盘已切换，请重新读取目录。')
    if (payload?.folder) {
      directoryMetadata.value = { ...directoryMetadata.value, [parentId]: payload.folder }
    }
    items.push(...(Array.isArray(payload?.items) ? payload.items : []).map(normalizePikPakItem))
    manifestUpdatedAt.value = formatDate(payload?.syncTime) || manifestUpdatedAt.value
    pageToken = String(payload?.nextPageToken || '')
    if (pageToken && seenTokens.has(pageToken)) break
    if (pageToken) seenTokens.add(pageToken)
  } while (pageToken && seenTokens.size < 200)
  return items
}

async function loadFolder(id, name = '', writable, parentId, metadata = {}) {
  const files = await listPikPakItems(id)
  const known = folderMap.value[id]
  const root = rootFolders.value.find((folder) => folder.slug === id)
  const actual = directoryMetadata.value[id] || {}
  folderMap.value = {
    ...folderMap.value,
    [id]: {
      id,
      slug: id,
      name: name || known?.name || root?.name || actual.name || '文件夹',
      description: activeStorageName.value + ' 实时目录',
      updatedAt: root?.updatedLabel || '',
      parentId: parentId ?? metadata.parentId ?? root?.parentId ?? known?.parentId ?? actual.parentId ?? '',
      writable: writable ?? metadata.writable ?? root?.writable ?? known?.writable ?? actual.writable ?? true,
      folderType: metadata.folderType ?? actual.type ?? known?.folderType ?? root?.folderType ?? 'folder',
      access: metadata.access ?? actual.access ?? known?.access ?? root?.access ?? 'inherit',
      effectiveAccess: metadata.effectiveAccess ?? actual.effectiveAccess ?? known?.effectiveAccess ?? root?.effectiveAccess ?? 'public',
      files,
    },
  }
  return folderMap.value[id]
}

async function readLibraryDirectory(strictFolderReads = false) {
  const items = await listPikPakItems()
  rootFiles.value = items.filter((item) => !item.isFolder)
  rootFolders.value = items.filter((item) => item.isFolder).map(normalizeRootFolder)
  folderMap.value = {}
  await Promise.all(rootFolders.value.map(async (folder) => {
    try {
      await loadFolder(folder.slug, folder.name, folder.writable, '')
    } catch (error) {
      if (strictFolderReads) throw error
    }
  }))
  return items
}

async function loadStorageProviders() {
  const payload = await apiJson('/api/storage-providers')
  storageProviders.value = Array.isArray(payload?.providers) ? payload.providers : []
  const preferred = new URLSearchParams(location.search).get('storageId') || payload.defaultStorageId
  const current = storageProviders.value.find((provider) => provider.id === preferred && provider.selectable)
  if (current) activeStorageId.value = current.id
  if (!current) {
    const fallback = storageProviders.value.find((provider) => provider.id === payload?.defaultStorageId && provider.selectable)
      || storageProviders.value.find((provider) => provider.selectable)
    if (fallback) activeStorageId.value = fallback.id
  }
}

async function switchStorage(event) {
  if (loadingLibrary.value || uploading.value || managementBusy.value) return
  activeStorageId.value = event.target.value
  rootFolders.value = []; rootFiles.value = []; folderMap.value = {}; directoryMetadata.value = {}; manifestUpdatedAt.value = ''
  closePhotoViewer(); closePreview(); selectedAction.value = null; managementDialog.value = ''; goHome()
  const url = new URL(location.href); url.searchParams.set('storageId', activeStorageId.value); url.searchParams.delete('folderId'); history.replaceState(null, '', url)
  await loadLibrary()
}

async function loadLibrary() {
  loadingLibrary.value = true
  errorMessage.value = ''
  uploadStatus.value = ''
  try {
    await readLibraryDirectory()
    authRequired.value = false
  } catch (error) {
    rootFiles.value = []
    rootFolders.value = []
    folderMap.value = {}
    if (error?.code === 'authentication_required') {
      authRequired.value = true
    } else {
      errorMessage.value = error instanceof Error ? error.message : '无法读取当前网盘。'
    }
  } finally {
    loadingLibrary.value = false
  }
}

async function refreshDirectory(parentId = '') {
  if (!parentId) {
    loadingLibrary.value = true
    try {
      const items = await readLibraryDirectory(true)
      authRequired.value = false
      return items
    } finally {
      loadingLibrary.value = false
    }
  }

  const known = folderMap.value[parentId] || rootFolders.value.find((folder) => folder.slug === parentId)
  const folder = await loadFolder(parentId, known?.name || '', known?.writable, known?.parentId)
  return folder.files
}

function goHome() {
  currentView.value = 'home'
  activeFileFolder.value = ''
  folderTrail.value = []
  searchQuery.value = ''
  uploadStatus.value = ''
}

function openAlbums() {
  currentView.value = 'albums'
  activeFileFolder.value = ''
  searchQuery.value = ''
}

function openFiles() {
  currentView.value = 'files'
  activeFileFolder.value = ''
  folderTrail.value = []
  searchQuery.value = ''
}

async function openFileFolder(folder) {
  if (!folder?.slug) return
  loadingLibrary.value = true
  errorMessage.value = ''
  try {
    const data = await loadFolder(folder.slug, folder.name, folder.writable, folder.parentId, folder)
    const actualDate = formatDate(folder.updatedAt || folder.date)
    if (actualDate && !data.updatedAt) {
      folderMap.value = { ...folderMap.value, [folder.slug]: { ...data, updatedAt: actualDate } }
    }
    authRequired.value = false
    activeFileFolder.value = folder.slug
    currentView.value = 'files'
    searchQuery.value = ''
    const existingIndex = folderTrail.value.findIndex((item) => item.slug === folder.slug)
    if (existingIndex >= 0) {
      folderTrail.value = folderTrail.value.slice(0, existingIndex + 1)
    } else {
      folderTrail.value = [...folderTrail.value, { slug: folder.slug, label: data.name }]
    }
    return true
  } catch (error) {
    if (error?.code === 'authentication_required') authRequired.value = true
    else errorMessage.value = error instanceof Error ? error.message : '无法打开此文件夹。'
    return false
  } finally {
    loadingLibrary.value = false
  }
}

async function openNestedFolder(item) {
  await openFileFolder({
    slug: item.id,
    name: item.name,
    date: item.date,
    writable: item.writable,
    parentId: item.parentId,
    folderType: item.folderType,
    access: item.access,
    effectiveAccess: item.effectiveAccess,
  })
}

function goParentFolder() {
  folderTrail.value = folderTrail.value.slice(0, -1)
  const parent = folderTrail.value[folderTrail.value.length - 1]
  activeFileFolder.value = parent?.slug || ''
  searchQuery.value = ''
}

function goBack() {
  if (currentView.value === 'files' && activeFileFolder.value) {
    goParentFolder()
    return
  }
  goHome()
}

function selectUploadFile() {
  if (!activeFileFolder.value || !activeDirectoryWritable.value || uploading.value || managementBusy.value) return
  uploadInput.value?.click()
}

async function sha1(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
}

async function calcGcid(file) {
  let blockSize = 0x40000
  while (file.size / blockSize > 0x200 && blockSize < 0x200000) blockSize <<= 1
  const hashes = []
  for (let offset = 0; offset < file.size; offset += blockSize) {
    const chunk = await file.slice(offset, Math.min(file.size, offset + blockSize)).arrayBuffer()
    hashes.push(await sha1(chunk))
  }
  const merged = new Uint8Array(hashes.length * 20)
  hashes.forEach((hash, index) => merged.set(hash, index * 20))
  return hex(await sha1(merged))
}

async function waitForUploadedFile(parentId, fileId, fileName) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const items = await listPikPakItems(parentId)
    const hit = items.find((item) => item.id === fileId || item.name === fileName)
    if (hit) return hit
  }
  return null
}

async function handleUpload(event) {
  const input = event?.target
  const file = input?.files?.[0]
  const parentId = activeFileFolder.value
  if (!file || !parentId || !activeDirectoryWritable.value || uploading.value || managementBusy.value) return
  uploading.value = true
  errorMessage.value = ''
  uploadStatus.value = '正在计算文件指纹…'
  let placeholder = null
  let form = null
  let iframe = null
  try {
    const hash = await calcGcid(file)
    uploadStatus.value = '正在申请 PikPak 上传凭证…'
    const ticket = await apiJson('/api/storage-upload-ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storageId: activeStorageId.value, name: file.name, size: file.size, hash, parentId }),
    })
    if (!ticket.instant) {
      uploadStatus.value = '正在直接上传到 PikPak…'
      iframe = document.createElement('iframe')
      iframe.name = 'pikpak-upload-' + Date.now()
      iframe.style.display = 'none'
      document.body.appendChild(iframe)
      form = document.createElement('form')
      form.method = ticket.upload?.method || 'POST'
      form.action = ticket.upload?.url || ''
      form.enctype = 'multipart/form-data'
      form.target = iframe.name
      form.style.display = 'none'
      for (const [key, value] of Object.entries(ticket.upload?.fields || {})) {
        const hidden = document.createElement('input')
        hidden.type = 'hidden'
        hidden.name = key
        hidden.value = String(value)
        form.appendChild(hidden)
      }
      placeholder = document.createComment('pikpak-upload-input')
      input.parentNode?.insertBefore(placeholder, input)
      input.name = 'file'
      form.appendChild(input)
      document.body.appendChild(form)
      form.submit()
    }
    uploadStatus.value = '已提交，正在确认文件…'
    const uploaded = await waitForUploadedFile(parentId, ticket.file?.id || '', file.name)
    if (!uploaded) throw new Error('上传已提交，但暂时没有在 PikPak 中确认到文件。')
    await loadFolder(parentId, activeFolder.value?.name || '')
    uploadStatus.value = '上传成功：' + uploaded.name
  } catch (error) {
    if (error?.code === 'authentication_required') {
      authRequired.value = true
      uploadStatus.value = ''
      errorMessage.value = '登录已失效，请重新输入云盘密码。'
    } else {
      uploadStatus.value = ''
      errorMessage.value = error instanceof Error ? error.message : '上传失败。'
    }
  } finally {
    if (placeholder?.parentNode) placeholder.replaceWith(input)
    form?.remove()
    iframe?.remove()
    if (input) input.value = ''
    uploading.value = false
  }
}

function openItemActions(item, source = 'files') {
  if (!item?.id || managementBusy.value || uploading.value) return
  const isRootItem = rootFiles.value.some((file) => file.id === item.id) || rootFolders.value.some((folder) => folder.id === item.id)
  const parentId = source === 'albums'
    ? (isRootItem ? '' : String(item.parentId || ''))
    : activeFileFolder.value
  const parentWritable = source === 'albums'
    ? (isRootItem || folderMap.value[parentId]?.writable !== false)
    : activeDirectoryWritable.value
  selectedAction.value = { item, source, parentId, writable: item.writable !== false && parentWritable }
}

function closeItemActions() {
  selectedAction.value = null
}

function chooseItemAction(action) {
  const selection = selectedAction.value
  if (!selection) return
  closeItemActions()

  if (action === 'open') {
    if (selection.item.isFolder) {
      if (selection.item.slug) openFileFolder(selection.item)
      else openNestedFolder(selection.item)
    } else if (selection.source === 'albums') {
      openPhotoViewer(selection.item, visiblePhotos.value)
    } else {
      openFile(selection.item)
    }
    return
  }

  if (action === 'rename' && selection.writable) {
    openManagementDialog('rename', selection.item, selection.parentId, selection.writable)
  } else if (action === 'trash' && selection.writable) {
    openManagementDialog('trash', selection.item, selection.parentId, selection.writable)
  }
}

function openManagementDialog(mode, item = null, parentId = '', writable = item?.writable !== false) {
  if (managementBusy.value) return
  managementError.value = ''
  managementName.value = item?.name || ''
  managementItem.value = item
  managementParentId.value = parentId
  managementWritable.value = writable
  managementDialog.value = mode
}

function openCreateFolderDialog() {
  if (!activeDirectoryWritable.value || managementBusy.value) return
  managementStatus.value = ''
  newFolderType.value = 'folder'
  newFolderAccess.value = 'inherit'
  openManagementDialog('create-folder')
}

function closeManagementDialog(force = false) {
  if (managementBusy.value && !force) return
  managementDialog.value = ''
  managementItem.value = null
  managementParentId.value = ''
  managementWritable.value = true
  managementName.value = ''
  newFolderType.value = 'folder'
  newFolderAccess.value = 'inherit'
  managementError.value = ''
}

function fileExtensionSuffix(file) {
  const name = String(file?.name || '')
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot) : ''
}

function renamedFileName(value, file) {
  const name = String(value || '').trim()
  if (!name || file?.isFolder) return name
  const suffix = fileExtensionSuffix(file)
  return suffix && !name.toLocaleLowerCase().endsWith(suffix.toLocaleLowerCase()) ? name + suffix : name
}

function clearCachedFolderTree(folderId) {
  const removed = new Set([folderId])
  let changed = true
  while (changed) {
    changed = false
    for (const [id, folder] of Object.entries(folderMap.value)) {
      if (!removed.has(id) && removed.has(folder.parentId)) {
        removed.add(id)
        changed = true
      }
    }
  }
  const next = { ...folderMap.value }
  for (const id of removed) delete next[id]
  folderMap.value = next
}

function managementNameIsValid(value) {
  const name = String(value || '').trim()
  return Boolean(name) && [...name].length <= 255 && !/[\u0000-\u001f\u007f]/.test(name)
}

async function submitManagementDialog() {
  if (managementBusy.value || !managementDialog.value) return

  const mode = managementDialog.value
  const item = managementItem.value
  const parentId = mode === 'create-folder' ? activeFileFolder.value : managementParentId.value
  let requestedName = ''
  if (mode === 'create-folder') {
    requestedName = String(managementName.value || '').trim()
  } else if (mode === 'rename') {
    requestedName = renamedFileName(managementName.value, item)
  }

  if (mode !== 'trash' && !managementNameIsValid(requestedName)) {
    managementError.value = '名称不能为空，且不能超过 255 个字符。'
    return
  }
  if (mode === 'create-folder' && !activeDirectoryWritable.value) {
    managementError.value = '此目录为只读，无法新建文件夹。'
    return
  }
  if (mode !== 'create-folder' && !managementWritable.value) {
    managementError.value = 'PikPak 标记此项目或所在目录为只读，无法修改。'
    return
  }

  managementBusy.value = true
  managementError.value = ''
  managementStatus.value = ''
  errorMessage.value = ''
  let requestAccepted = false

  try {
    if (mode === 'create-folder') {
      const before = parentId
        ? (folderMap.value[parentId]?.files || [])
        : [...rootFolders.value, ...rootFiles.value]
      const previousIds = new Set(before.map((entry) => entry.id))
      const result = await apiJson('/api/storage-create-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storageId: activeStorageId.value,
          name: requestedName,
          parentId,
          type: newFolderType.value,
          access: newFolderAccess.value,
        }),
      })
      requestAccepted = true
      const items = await refreshDirectory(parentId)
      const createdId = String(result?.item?.id || '')
      const created = items.find((entry) => entry.isFolder && (
        createdId ? entry.id === createdId : entry.name === requestedName && !previousIds.has(entry.id)
      ))
      if (!created || created.name !== requestedName) {
        throw new Error('PikPak 已接受创建请求，但重新读取目录后未能确认新文件夹。')
      }
      managementStatus.value = result.metadataSaved === false
        ? '文件夹已创建，但类型或权限尚未保存；请在管理后台重试。'
        : '文件夹已创建：' + created.name
      closeManagementDialog(true)
      return
    }

    if (!item?.id) throw new Error('缺少 PikPak 项目 ID，无法执行操作。')

    if (mode === 'rename') {
      await apiJson('/api/storage-rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storageId: activeStorageId.value, id: item.id, parentId, name: requestedName }),
      })
      requestAccepted = true
      const items = await refreshDirectory(parentId)
      const renamed = items.find((entry) => entry.id === item.id)
      if (!renamed || renamed.name !== requestedName) {
        throw new Error('PikPak 已接受改名请求，但重新读取目录后名称未能确认。')
      }
      if (renamed.isFolder && folderMap.value[renamed.id]) {
        folderMap.value = { ...folderMap.value, [renamed.id]: { ...folderMap.value[renamed.id], name: requestedName } }
      }
      managementStatus.value = '已重命名为：' + renamed.name
      closeManagementDialog(true)
      return
    }

    await apiJson('/api/storage-trash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storageId: activeStorageId.value, id: item.id, parentId }),
    })
    requestAccepted = true
    const items = await refreshDirectory(parentId)
    if (items.some((entry) => entry.id === item.id)) {
      throw new Error('PikPak 已接受移入回收站请求，但重新读取目录后仍能看到该项目。')
    }
    if (item.isFolder) clearCachedFolderTree(item.id)
    managementStatus.value = '已移到回收站：' + item.name
    closeManagementDialog(true)
  } catch (error) {
    if (error?.code === 'authentication_required') {
      authRequired.value = true
      errorMessage.value = '登录已失效，请重新输入云盘密码。'
      managementDialog.value = ''
      managementItem.value = null
      managementParentId.value = ''
      managementWritable.value = true
      return
    }
    const message = error instanceof Error ? error.message : 'PikPak 文件操作失败。'
    if (requestAccepted) {
      errorMessage.value = message + ' 最终状态尚未确认，请刷新目录后再检查，暂时不要重复操作。'
      managementDialog.value = ''
      managementItem.value = null
      managementParentId.value = ''
      managementWritable.value = true
    } else {
      managementError.value = message
    }
  } finally {
    managementBusy.value = false
  }
}

async function loginCloud() {
  if (!authPassword.value || authenticating.value) return
  authenticating.value = true
  errorMessage.value = ''
  try {
    await apiJson('/api/cloud-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storageId: activeStorageId.value, password: authPassword.value }),
    })
    authPassword.value = ''
    authRequired.value = false
    await loadLibrary()
    if (pendingDeepLinkFolderId) {
      const opened = await openFileFolder({ slug: pendingDeepLinkFolderId })
      if (opened) pendingDeepLinkFolderId = ''
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '登录失败。'
  } finally {
    authenticating.value = false
  }
}

function openPhotoViewer(file, items) {
  viewerItems.value = items
  viewerIndex.value = Math.max(0, items.findIndex((item) => item.path === file.path))
  viewerScale.value = 1
  viewerDimensions.value = ''
}

function closePhotoViewer() {
  viewerIndex.value = -1
  viewerItems.value = []
  viewerScale.value = 1
  viewerDimensions.value = ''
}

function movePhoto(direction) {
  if (viewerItems.value.length < 2) return
  const length = viewerItems.value.length
  viewerIndex.value = (viewerIndex.value + direction + length) % length
  viewerScale.value = 1
  viewerDimensions.value = ''
}

function handleViewerImageLoad(event) {
  const image = event.target
  viewerDimensions.value = image.naturalWidth + ' × ' + image.naturalHeight
}

function toggleZoom() {
  viewerScale.value = viewerScale.value > 1 ? 1 : 2
}

function distanceBetweenTouches(touches) {
  const dx = touches[0].clientX - touches[1].clientX
  const dy = touches[0].clientY - touches[1].clientY
  return Math.sqrt(dx * dx + dy * dy)
}

function handleViewerTouchStart(event) {
  if (event.touches.length >= 2) {
    touchOrigin = {
      pinch: true,
      distance: distanceBetweenTouches(event.touches),
      scale: viewerScale.value,
    }
    return
  }
  if (event.touches.length === 1) {
    touchOrigin = {
      pinch: false,
      x: event.touches[0].clientX,
      y: event.touches[0].clientY,
      scale: viewerScale.value,
    }
  }
}

function handleViewerTouchMove(event) {
  if (event.touches.length >= 2 && touchOrigin?.pinch) {
    event.preventDefault()
    const nextScale = touchOrigin.scale * distanceBetweenTouches(event.touches) / Math.max(1, touchOrigin.distance)
    viewerScale.value = Math.min(4, Math.max(1, nextScale))
  }
}

function handleViewerTouchEnd(event) {
  if (!touchOrigin) return
  const origin = touchOrigin
  touchOrigin = null
  if (origin.pinch || event.changedTouches.length === 0 || origin.scale > 1.05) return
  const dx = event.changedTouches[0].clientX - origin.x
  const dy = event.changedTouches[0].clientY - origin.y
  if (Math.abs(dx) > 48 && Math.abs(dy) < 90) movePhoto(dx < 0 ? 1 : -1)
}

async function openFile(file) {
  if (isImageFile(file)) {
    openPhotoViewer(file, [file])
    return
  }

  previewFile.value = file
  previewText.value = ''
  previewError.value = ''
  previewLoading.value = false
  if (file.extension === 'pdf') {
    previewMode.value = 'pdf'
    return
  }
  if (file.type === 'video' || VIDEO_EXTENSIONS.includes(file.extension)) {
    previewMode.value = 'video'
    return
  }
  if (TEXT_EXTENSIONS.includes(file.extension) || String(file.mimeType || '').toLowerCase().startsWith('text/')) {
    previewMode.value = 'text'
    previewLoading.value = true
    try {
      const response = await fetch(file.path)
      if (!response.ok) throw new Error('文件暂时无法预览。')
      const text = await response.text()
      if (text.length > 600000) throw new Error('文件内容较大，请下载后查看。')
      if (file.extension === 'json') {
        try {
          previewText.value = JSON.stringify(JSON.parse(text), null, 2)
        } catch {
          previewText.value = text
        }
      } else {
        previewText.value = text
      }
    } catch (error) {
      previewError.value = error instanceof Error ? error.message : '文件暂时无法预览。'
    } finally {
      previewLoading.value = false
    }
    return
  }
  previewMode.value = 'unsupported'
}

function closePreview() {
  previewFile.value = null
  previewMode.value = ''
  previewText.value = ''
  previewError.value = ''
}

function handleKeydown(event) {
  if (managementDialog.value) {
    if (event.key === 'Escape') closeManagementDialog()
    return
  }
  if (selectedAction.value) {
    if (event.key === 'Escape') closeItemActions()
    return
  }
  if (viewerImage.value) {
    if (event.key === 'Escape') closePhotoViewer()
    if (event.key === 'ArrowLeft') movePhoto(-1)
    if (event.key === 'ArrowRight') movePhoto(1)
    return
  }
  if (previewFile.value && event.key === 'Escape') closePreview()
}

watch(modalOpen, (open) => {
  if (typeof document !== 'undefined') document.body.classList.toggle('modal-open', open)
})

onMounted(async () => {
  window.addEventListener('keydown', handleKeydown)
  const background = document.querySelector('.background-video')
  if (background instanceof HTMLVideoElement) {
    background.muted = true
    const playAttempt = background.play()
    if (playAttempt && typeof playAttempt.catch === 'function') playAttempt.catch(() => {})
  }
  try { await loadStorageProviders() } catch (error) { errorMessage.value = error.message; return }
  const folderId = new URLSearchParams(window.location.search).get('folderId') || ''
  if (folderId) {
    pendingDeepLinkFolderId = folderId
    await loadLibrary()
    if (await openFileFolder({ slug: folderId })) pendingDeepLinkFolderId = ''
  } else {
    loadLibrary()
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  document.body.classList.remove('modal-open')
})
</script>

<template>
  <div class="app-root" :class="{ 'app-root--browse': currentView !== 'home' }">
    <div class="wallpaper" aria-hidden="true">
      <video
        class="background-video"
        autoplay
        muted
        loop
        playsinline
        webkit-playsinline
        preload="metadata"
        tabindex="-1"
        aria-hidden="true"
      >
        <source src="/assets/underwater-h264.mp4" type='video/mp4; codecs="avc1.640028"' />
        <source :src="BLOG_VIDEO_URL" type='video/mp4; codecs="hvc1.1.6.L120.B0"' />
      </video>
      <div class="wallpaper-shade" />
    </div>

    <div class="app-shell">
      <div class="content-width">
        <header v-if="currentView === 'home'" class="home-header">
          <div class="brand-lockup">
            <img class="brand-symbol" src="/assets/logo.png" alt="" />
            <span class="brand-name">Map7e</span>
          </div>
          <div class="location-chip" aria-label="当前位置">
            <span>家</span><span class="location-separator">/</span><span>Map7e</span>
          </div>
        </header>

        <header v-else class="inner-header">
          <button class="back-button" type="button" @click="goBack" :aria-label="'返回' + backLabel">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
            <span>{{ backLabel }}</span>
          </button>
          <span class="inner-location">{{ locationLabel }}</span>
        </header>

        <main>
          <div v-if="errorMessage" class="error-banner" role="alert">{{ errorMessage }}</div>
          <div v-if="managementStatus" class="operation-status" role="status">{{ managementStatus }}</div>

          <label class="cloud-storage-picker" for="cloud-storage-select">
            <span>当前网盘</span>
            <select id="cloud-storage-select" :value="activeStorageId" :disabled="loadingLibrary || uploading || managementBusy" @change="switchStorage">
              <option v-for="storage in storageProviders" :key="storage.id" :value="storage.id" :disabled="!storage.selectable">{{ storage.name }}{{ storage.selectable ? '' : '（待授权）' }}</option>
            </select>
          </label>
          <section v-if="authRequired" class="auth-gate" aria-labelledby="auth-title">
            <div class="auth-mark"><img src="/assets/logo.png" alt="" /></div>
            <p class="eyebrow">Map7e Cloud</p>
            <h1 id="auth-title">登录私人云盘</h1>
            <p class="auth-copy">输入云盘访问密码以读取 {{ activeStorageName }} 目录。</p>
            <form class="auth-form" @submit.prevent="loginCloud">
              <input v-model="authPassword" type="password" autocomplete="current-password" placeholder="云盘访问密码" aria-label="云盘访问密码" />
              <button class="auth-submit" type="submit" :disabled="!authPassword || authenticating">
                {{ authenticating ? '正在登录…' : '登录' }}
              </button>
            </form>
          </section>

          <section v-else-if="currentView === 'home'" class="home-view" aria-labelledby="overview-title">
            <section class="overview-card">
              <div class="overview-topline">
                <div class="overview-brand">
                  <img class="overview-symbol" src="/assets/logo.png" alt="" />
                  <div>
                    <p class="eyebrow">Cloud Storage</p>
                    <h1 id="overview-title">Map7e</h1>
                  </div>
                </div>
                <span class="private-label">私人空间</span>
              </div>
              <p class="overview-subtitle">私人云端空间</p>

              <div v-if="loadingLibrary" class="stats-loading">正在读取空间目录…</div>
              <template v-else>
                <div class="overview-stats">
                  <div class="stat-block">
                    <span class="stat-value">{{ photoCount }}</span>
                    <span class="stat-label">图片</span>
                  </div>
                  <div class="stat-block">
                    <span class="stat-value">{{ fileCount }}</span>
                    <span class="stat-label">文件</span>
                  </div>
                </div>
                <div class="content-composition" aria-label="图片与文件数量构成">
                  <div class="composition-bar">
                    <span class="composition-photos" :style="{ width: photoRatio + '%' }" />
                    <span class="composition-files" :style="{ width: (100 - photoRatio) + '%' }" />
                  </div>
                  <div class="composition-labels">
                    <span><i class="legend-dot legend-dot--photo" />图片 {{ photoCount }}</span>
                    <span><i class="legend-dot legend-dot--file" />文件 {{ fileCount }}</span>
                  </div>
                </div>
                <p class="overview-footnote">统计已读取的 {{ activeStorageName }} 目录项目，不包含未展开子文件夹中的内容。</p>
              </template>
            </section>

            <div class="directory-list" aria-label="目录">
              <button class="directory-card" type="button" @click="openAlbums">
                <span class="directory-icon directory-icon--photos" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="17" height="16" rx="3" /><circle cx="9" cy="9" r="1.4" /><path d="m5 17 4.2-4.2a1.8 1.8 0 0 1 2.6 0l2 2 1.6-1.6a1.8 1.8 0 0 1 2.6 0L20 16.2" /></svg>
                </span>
                <span class="directory-copy">
                  <span class="directory-title">相册目录</span>
                  <span class="directory-meta">{{ albumPhotos.length }} 张图片<span v-if="albumUpdatedAt"> · 更新于 {{ albumUpdatedAt }}</span></span>
                </span>
                <svg class="directory-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
              </button>

              <button class="directory-card" type="button" @click="openFiles">
                <span class="directory-icon directory-icon--files" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M4.5 6.5h6l2 2h7A1.5 1.5 0 0 1 21 10v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a1.5 1.5 0 0 1 1.5-1.5Z" /><path d="M3.5 10h17" /></svg>
                </span>
                <span class="directory-copy">
                  <span class="directory-title">文件目录</span>
                  <span class="directory-meta">{{ fileCount }} 个文件<span v-if="latestFileDate"> · 更新于 {{ latestFileDate }}</span></span>
                </span>
                <svg class="directory-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
              </button>
            </div>
          </section>

          <section v-else-if="currentView === 'albums'" class="browse-view" aria-labelledby="album-title">
            <div class="section-heading">
              <div>
                <p class="eyebrow">照片</p>
                <h1 id="album-title">相册目录</h1>
              </div>
              <span class="result-count">{{ visiblePhotos.length }} 张</span>
            </div>

            <label class="search-box">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></svg>
              <input v-model.trim="searchQuery" type="search" placeholder="搜索图片" aria-label="搜索相册中的图片" />
              <button v-if="searchQuery" class="clear-search" type="button" aria-label="清除搜索" @click="searchQuery = ''">×</button>
            </label>

            <div class="collection-meta">
              <span>{{ albumPhotos.length }} 张图片</span>
              <span v-if="albumUpdatedAt" class="meta-divider">·</span>
              <span v-if="albumUpdatedAt">更新于 {{ albumUpdatedAt }}</span>
            </div>

            <div v-if="loadingLibrary" class="loading-state">正在加载相册…</div>
            <div v-else-if="visiblePhotos.length" class="photo-grid">
              <article
                v-for="photo in visiblePhotos"
                :key="photo.id || photo.path"
                class="photo-tile"
              >
                <button class="photo-open" type="button" :aria-label="'查看图片 ' + photo.name" @click="openPhotoViewer(photo, visiblePhotos)">
                  <span class="photo-thumb"><img v-if="photo.thumbnail" :src="photo.thumbnail" :alt="photo.name" loading="lazy" decoding="async" /><span v-else class="photo-placeholder">图片</span></span>
                  <span class="photo-name">{{ photo.name }}</span>
                </button>
                <button class="photo-more" type="button" :aria-label="'图片操作：' + photo.name" @click.stop="openItemActions(photo, 'albums')">···</button>
              </article>
            </div>
            <div v-else class="empty-state">
              <span class="empty-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="17" height="16" rx="3" /><circle cx="9" cy="9" r="1.4" /><path d="m5 17 4.2-4.2a1.8 1.8 0 0 1 2.6 0l2 2 1.6-1.6a1.8 1.8 0 0 1 2.6 0L20 16.2" /></svg>
              </span>
              <strong>{{ searchQuery ? '没有找到匹配的图片' : '相册还是空的' }}</strong>
              <span>{{ searchQuery ? '试试其他文件名。' : '添加图片后会在这里按网格显示。' }}</span>
            </div>
          </section>

          <section v-else class="browse-view file-browser" aria-labelledby="files-title">
            <div class="section-heading">
              <div>
                <p class="eyebrow">{{ activeFileFolderData ? (activeFileFolderData.folderType === 'album' ? '相册' : '文件夹') : '云端文件' }}</p>
                <h1 id="files-title">{{ currentHeading }}</h1>
              </div>
              <span class="result-count">{{ activeFileFolderData ? currentFileCount + ' 个文件' : fileCount + ' 个文件' }}</span>
            </div>

            <label class="search-box">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></svg>
              <input
                v-model.trim="searchQuery"
                type="search"
                :placeholder="activeFileFolderData ? '搜索此文件夹' : '搜索文件或文件夹'"
                aria-label="搜索当前文件目录"
              />
              <button v-if="searchQuery" class="clear-search" type="button" aria-label="清除搜索" @click="searchQuery = ''">×</button>
            </label>

            <div class="collection-meta">
              <template v-if="activeFileFolderData">
                <span>{{ currentFileCount }} 个文件</span>
                <span v-if="dateLabel(activeFileFolderData.updatedAt)" class="meta-divider">·</span>
                <span v-if="dateLabel(activeFileFolderData.updatedAt)">更新于 {{ activeFileFolderData.updatedAt }}</span>
              </template>
              <template v-else>
                <span>{{ fileFolders.length }} 个文件夹</span>
                <span class="meta-divider">·</span>
                <span>{{ fileCount }} 个文件</span>
              </template>
            </div>

            <div v-if="activeDirectoryWritable" class="upload-toolbar manage-toolbar">
              <button class="upload-button" type="button" :disabled="managementBusy || uploading || !activeCapabilities.createFolder" @click="openCreateFolderDialog">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                <span>新建文件夹</span>
              </button>
              <template v-if="activeFileFolderData && activeCapabilities.upload">
                <input ref="uploadInput" class="visually-hidden" type="file" @change="handleUpload" />
                <button class="upload-button" type="button" :disabled="uploading || managementBusy" @click="selectUploadFile">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4m0 0L8 8m4-4 4 4M5 14v5h14v-5" /></svg>
                  <span>{{ uploading ? '上传中…' : '上传文件' }}</span>
                </button>
              </template>
              <span v-if="uploadStatus" class="upload-status" role="status">{{ uploadStatus }}</span>
            </div>
            <div v-else class="read-only-note">此目录为只读，不能新建文件夹或上传文件。</div>

            <div v-if="loadingLibrary" class="loading-state">正在加载文件…</div>
            <div v-else-if="!activeFileFolderData" class="file-list">
              <article v-for="folder in visibleFileFolders" :key="folder.slug" class="folder-row">
                <button class="folder-open" type="button" @click="openFileFolder(folder)">
                  <span class="folder-row-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h5l2 2h7A1.5 1.5 0 0 1 20.5 9.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z" /><path d="M3.5 10h17" /></svg>
                  </span>
                  <span class="row-copy">
                    <span class="row-title">{{ folder.name }}</span>
                    <span class="row-meta">{{ folder.folderType === 'album' ? '相册' : '文件夹' }} · {{ folder.fileCount }} 个文件<span v-if="folder.effectiveAccess === 'locked'"> · 上锁</span><span v-if="dateLabel(folder.updatedAt)"> · {{ folder.updatedAt }}</span></span>
                  </span>
                  <svg class="row-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
                </button>
                <button class="item-more" type="button" :aria-label="'文件夹操作：' + folder.name" @click.stop="openItemActions(folder)">···</button>
              </article>

              <article v-for="file in rootFileSearchResults" :key="'root-' + file.id" class="file-row">
                <button class="file-open" type="button" :aria-label="'预览 ' + file.name" @click="openFile(file)">
                  <span class="file-type-icon" :class="fileIconClass(file)"><span>{{ fileTypeLabel(file) }}</span></span>
                  <span class="row-copy">
                    <span class="row-title">{{ file.name }}</span>
                    <span class="row-meta">{{ fileTypeLabel(file) }} · {{ fileSizeLabel(file) }}<span v-if="dateLabel(file.date)"> · {{ file.date }}</span></span>
                  </span>
                </button>
                <button class="item-more" type="button" :aria-label="'文件操作：' + file.name" @click.stop="openItemActions(file)">···</button>
              </article>

              <div v-if="searchQuery && !visibleFileFolders.length && !rootFileSearchResults.length" class="empty-state empty-state--compact">
                <strong>没有找到匹配的文件</strong><span>试试其他文件名。</span>
              </div>
              <div v-if="!searchQuery && !fileFolders.length && !rootLooseFiles.length" class="empty-state empty-state--compact">
                <strong>文件目录为空</strong><span>当前没有可浏览的文件夹。</span>
              </div>
            </div>

            <div v-else class="file-list">
              <div v-if="activeFileFolderData.folderType === 'album' && visibleAlbumFolderPhotos.length" class="photo-grid folder-photo-grid">
                <article v-for="photo in visibleAlbumFolderPhotos" :key="photo.id || photo.path" class="photo-tile">
                  <button class="photo-open" type="button" :aria-label="'查看图片 ' + photo.name" @click="openPhotoViewer(photo, visibleAlbumFolderPhotos)">
                    <span class="photo-thumb"><img v-if="photo.thumbnail" :src="photo.thumbnail" :alt="photo.name" loading="lazy" decoding="async" /><span v-else class="photo-placeholder">图片</span></span>
                    <span class="photo-name">{{ photo.name }}</span>
                  </button>
                  <button class="photo-more" type="button" :aria-label="'图片操作：' + photo.name" @click.stop="openItemActions(photo)">···</button>
                </article>
              </div>
              <article v-for="folder in visibleCurrentFolders" :key="folder.id" class="folder-row">
                <button class="folder-open" type="button" @click="openNestedFolder(folder)">
                  <span class="folder-row-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h5l2 2h7A1.5 1.5 0 0 1 20.5 9.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z" /><path d="M3.5 10h17" /></svg>
                  </span>
                  <span class="row-copy">
                    <span class="row-title">{{ folder.name }}</span>
                    <span class="row-meta">{{ folder.folderType === 'album' ? '相册' : '文件夹' }}<span v-if="folder.effectiveAccess === 'locked'"> · 上锁</span><span v-if="dateLabel(folder.date)"> · {{ folder.date }}</span></span>
                  </span>
                  <svg class="row-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
                </button>
                <button class="item-more" type="button" :aria-label="'文件夹操作：' + folder.name" @click.stop="openItemActions(folder)">···</button>
              </article>
              <article v-for="file in (activeFileFolderData.folderType === 'album' ? visibleNonImageFolderFiles : visibleCurrentFiles)" :key="file.id" class="file-row">
                <button class="file-open" type="button" :aria-label="'预览 ' + file.name" @click="openFile(file)">
                  <span class="file-type-icon" :class="fileIconClass(file)"><span>{{ fileTypeLabel(file) }}</span></span>
                  <span class="row-copy">
                    <span class="row-title">{{ file.name }}</span>
                    <span class="row-meta">{{ fileTypeLabel(file) }} · {{ fileSizeLabel(file) }}<span v-if="dateLabel(file.date)"> · {{ file.date }}</span></span>
                  </span>
                </button>
                <button class="item-more" type="button" :aria-label="'文件操作：' + file.name" @click.stop="openItemActions(file)">···</button>
              </article>
              <div v-if="searchQuery && !visibleCurrentFiles.length && !visibleCurrentFolders.length" class="empty-state empty-state--compact">
                <strong>没有找到匹配的文件</strong><span>试试其他文件名。</span>
              </div>
              <div v-if="!searchQuery && !currentFileItems.length" class="empty-state empty-state--compact">
                <strong>这个文件夹是空的</strong><span>当前没有可下载的文件。</span>
              </div>
            </div>
          </section>
        </main>

        <footer class="page-footer">© 2026 Map7e</footer>
      </div>
    </div>

    <Transition name="viewer-fade">
      <div v-if="viewerImage" class="photo-viewer" role="dialog" aria-modal="true" :aria-label="'图片预览：' + viewerImage.name" @click.self="closePhotoViewer">
        <div class="viewer-layout">
          <header class="viewer-topbar">
            <button class="viewer-icon-button" type="button" aria-label="关闭图片预览" @click="closePhotoViewer">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
            </button>
            <span class="viewer-counter">{{ photoCounter }}</span>
            <a class="viewer-icon-button" :href="viewerImage.path" :download="viewerImage.name" :aria-label="'下载原图 ' + viewerImage.name">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5v11m0 0 4-4m-4 4-4-4M5 17v3h14v-3" /></svg>
            </a>
          </header>

          <button v-if="viewerItems.length > 1" class="viewer-arrow viewer-arrow--left" type="button" aria-label="上一张" @click="movePhoto(-1)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          </button>
          <div class="viewer-stage" @touchstart="handleViewerTouchStart" @touchmove="handleViewerTouchMove" @touchend="handleViewerTouchEnd">
            <img
              :key="viewerImage.path"
              class="viewer-image"
              :src="viewerImage.path"
              :alt="viewerImage.name"
              :style="{ transform: 'scale(' + viewerScale + ')' }"
              @load="handleViewerImageLoad"
            />
          </div>
          <button v-if="viewerItems.length > 1" class="viewer-arrow viewer-arrow--right" type="button" aria-label="下一张" @click="movePhoto(1)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
          </button>

          <footer class="viewer-details">
            <div class="viewer-file-info">
              <strong class="viewer-filename">{{ viewerImage.name }}</strong>
              <span class="viewer-metadata">
                <span v-if="viewerDimensions">{{ viewerDimensions }}</span>
                <span v-if="viewerImage.sizeBytes !== null">{{ fileSizeLabel(viewerImage) }}</span>
                <span v-if="dateLabel(viewerImage.date)">{{ viewerImage.date }}</span>
              </span>
            </div>
            <button class="zoom-button" type="button" :aria-label="viewerScale > 1 ? '缩小图片' : '放大图片'" @click="toggleZoom">
              <span>{{ viewerScale > 1 ? '适合屏幕' : '放大' }}</span>
            </button>
          </footer>
        </div>
      </div>
    </Transition>

    <Transition name="viewer-fade">
      <div v-if="previewFile" class="preview-overlay" role="dialog" aria-modal="true" :aria-label="'文件预览：' + previewFile.name" @click.self="closePreview">
        <div class="preview-panel">
          <header class="preview-header">
            <button class="viewer-icon-button" type="button" aria-label="关闭文件预览" @click="closePreview">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
            </button>
            <div class="preview-heading"><strong>{{ previewFile.name }}</strong><span>{{ fileTypeLabel(previewFile) }} · {{ fileSizeLabel(previewFile) }}</span></div>
            <a class="viewer-icon-button" :href="previewFile.path" :download="previewFile.name" :aria-label="'下载 ' + previewFile.name">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5v11m0 0 4-4m-4 4-4-4M5 17v3h14v-3" /></svg>
            </a>
          </header>
          <div v-if="previewLoading" class="preview-message">正在打开文件…</div>
          <div v-else-if="previewError" class="preview-message">
            <strong>{{ previewError }}</strong>
            <a class="primary-download" :href="previewFile.path" :download="previewFile.name">下载原文件</a>
          </div>
          <iframe v-else-if="previewMode === 'pdf'" class="pdf-preview" :src="previewFile.path" :title="previewFile.name" />
          <video v-else-if="previewMode === 'video'" class="file-video-preview" :src="previewFile.path" controls playsinline />
          <pre v-else-if="previewMode === 'text'" class="text-preview">{{ previewText }}</pre>
          <div v-else class="preview-message">
            <strong>这个格式暂不支持站内预览</strong>
            <span>你可以下载原文件后查看。</span>
            <a class="primary-download" :href="previewFile.path" :download="previewFile.name">下载原文件</a>
          </div>
        </div>
      </div>
    </Transition>

    <Transition name="sheet">
      <div v-if="selectedAction" class="action-sheet-backdrop" @click.self="closeItemActions">
        <section class="action-sheet" role="dialog" aria-modal="true" :aria-label="'操作：' + selectedAction.item.name">
          <span class="sheet-grabber" aria-hidden="true" />
          <p class="sheet-eyebrow">{{ selectedAction.item.isFolder ? '文件夹' : '文件' }}</p>
          <strong class="sheet-title">{{ selectedAction.item.name }}</strong>
          <button class="sheet-action" type="button" @click="chooseItemAction('open')">
            {{ selectedAction.item.isFolder ? '打开' : (selectedAction.source === 'albums' ? '查看' : '预览') }}
          </button>
          <a v-if="!selectedAction.item.isFolder" class="sheet-action" :href="selectedAction.item.path" :download="selectedAction.item.name" @click="closeItemActions">下载</a>
          <button v-if="selectedAction.writable && activeCapabilities.rename" class="sheet-action" type="button" @click="chooseItemAction('rename')">重命名</button>
          <button v-if="selectedAction.writable && activeCapabilities.trash" class="sheet-action sheet-action--danger" type="button" @click="chooseItemAction('trash')">删除</button>
          <button class="sheet-cancel" type="button" @click="closeItemActions">取消</button>
        </section>
      </div>
    </Transition>

    <Transition name="viewer-fade">
      <div v-if="managementDialog" class="management-backdrop" @click.self="closeManagementDialog">
        <form class="management-panel" role="dialog" aria-modal="true" :aria-label="managementDialog === 'trash' ? '确认移到回收站' : (managementDialog === 'rename' ? '重命名' : '新建文件夹')" @submit.prevent="submitManagementDialog">
          <span class="sheet-grabber" aria-hidden="true" />
          <p class="sheet-eyebrow">云端文件管理</p>
          <h2>
            {{ managementDialog === 'trash' ? '确认删除' : (managementDialog === 'rename' ? '重命名' : '新建文件夹') }}
          </h2>
          <p v-if="managementDialog === 'trash'" class="management-confirm-copy">
            确定将「{{ managementItem?.name }}」移到回收站吗？
          </p>
          <template v-else>
            <label class="management-label" for="management-name-input">{{ managementDialog === 'rename' ? '新名称' : '文件夹名称' }}</label>
            <input
              id="management-name-input"
              ref="fileNameInput"
              v-model="managementName"
              class="management-input"
              type="text"
              maxlength="255"
              autocomplete="off"
              :placeholder="managementDialog === 'rename' ? '输入新名称' : '输入文件夹名称'"
            />
            <template v-if="managementDialog === 'create-folder'">
              <label class="management-label management-select-label" for="new-folder-type">显示类型</label>
              <select id="new-folder-type" v-model="newFolderType" class="management-input management-select">
                <option value="folder">普通文件夹</option>
                <option value="album">相册</option>
              </select>
              <label class="management-label management-select-label" for="new-folder-access">访问权限</label>
              <select id="new-folder-access" v-model="newFolderAccess" class="management-input management-select">
                <option value="inherit">继承上级</option>
                <option value="public">公开</option>
                <option value="locked">上锁</option>
              </select>
              <p class="management-hint">非默认类型或权限需要先登录管理后台，并配置持久化存储。</p>
            </template>
            <p v-if="managementDialog === 'rename' && !managementItem?.isFolder && fileExtensionSuffix(managementItem)" class="management-hint">文件扩展名会自动保留。</p>
          </template>
          <p v-if="managementError" class="management-error" role="alert">{{ managementError }}</p>
          <div class="management-buttons">
            <button class="dialog-button dialog-button--quiet" type="button" :disabled="managementBusy" @click="closeManagementDialog">取消</button>
            <button class="dialog-button" :class="{ 'dialog-button--danger': managementDialog === 'trash' }" type="submit" :disabled="managementSubmitDisabled">
              {{ managementBusy ? '处理中…' : (managementDialog === 'trash' ? '移到回收站' : (managementDialog === 'rename' ? '保存' : '创建')) }}
            </button>
          </div>
        </form>
      </div>
    </Transition>
  </div>
</template>

<style>
:root {
  --ink: #06111c;
  --ink-soft: #0b1a28;
  --panel: rgba(9, 22, 35, 0.84);
  --panel-strong: rgba(8, 19, 31, 0.91);
  --line: rgba(214, 231, 248, 0.12);
  --line-strong: rgba(214, 231, 248, 0.19);
  --text: #f5f8fc;
  --muted: rgba(226, 236, 247, 0.68);
  --subtle: rgba(216, 228, 241, 0.48);
  --accent: #86c8f3;
}

.app-root {
  position: relative;
  min-height: 100vh;
  min-height: 100dvh;
  isolation: isolate;
  color: var(--text);
}

.wallpaper,
.background-video,
.wallpaper-shade {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.wallpaper {
  z-index: -1;
  overflow: hidden;
  background: #07131f;
}

.background-video {
  object-fit: cover;
  object-position: center;
  background: #07131f;
  filter: brightness(0.58) saturate(0.82);
}

.wallpaper-shade {
  background:
    linear-gradient(180deg, rgba(2, 8, 15, 0.26) 0%, rgba(2, 8, 15, 0.30) 40%, rgba(2, 8, 15, 0.63) 100%),
    radial-gradient(ellipse at 50% 34%, rgba(7, 25, 43, 0.02), rgba(3, 11, 19, 0.30) 78%);
  transition: background 220ms ease;
}

.app-root--browse .background-video {
  filter: brightness(0.38) saturate(0.7);
}

.app-root--browse .wallpaper-shade {
  background: linear-gradient(180deg, rgba(3, 9, 16, 0.58), rgba(3, 9, 16, 0.72));
}

.app-shell {
  display: flex;
  min-height: 100vh;
  min-height: 100dvh;
  flex-direction: column;
  padding: calc(env(safe-area-inset-top, 0px) + 16px) 22px calc(env(safe-area-inset-bottom, 0px) + 30px);
}

.content-width {
  display: flex;
  width: min(100%, 900px);
  min-height: calc(100vh - 46px);
  min-height: calc(100dvh - 46px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
  flex-direction: column;
  margin: 0 auto;
}

.home-header,
.inner-header {
  display: flex;
  min-height: 48px;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 28px;
}

.brand-lockup {
  display: inline-flex;
  align-items: center;
  gap: 9px;
}

.brand-symbol {
  display: block;
  width: 34px;
  height: 34px;
  object-fit: contain;
}

.brand-name {
  font-size: 18px;
  font-weight: 720;
  letter-spacing: 0.1em;
}

.location-chip,
.inner-location {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 13px;
}

.location-chip {
  padding: 8px 12px;
  border: 1px solid rgba(223, 237, 250, 0.12);
  border-radius: 999px;
  background: rgba(6, 17, 28, 0.52);
}

.location-separator,
.inner-location {
  color: var(--subtle);
}

.inner-header {
  margin-bottom: 26px;
}

.back-button {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  gap: 7px;
  padding: 0 10px 0 0;
  border: 0;
  background: transparent;
  color: #eff6fc;
  font-size: 15px;
  font-weight: 620;
  cursor: pointer;
}

.back-button svg,
.directory-chevron,
.row-chevron,
.viewer-icon-button svg,
.viewer-arrow svg,
.download-button svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.inner-location {
  overflow: hidden;
  justify-content: flex-end;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

main {
  flex: 1 0 auto;
}

.home-view {
  display: grid;
  gap: 14px;
}

.overview-card {
  position: relative;
  overflow: hidden;
  padding: 20px 22px 18px;
  border: 1px solid var(--line-strong);
  border-radius: 23px;
  background: linear-gradient(135deg, rgba(11, 29, 46, 0.92), rgba(13, 33, 51, 0.78));
  box-shadow: 0 18px 52px rgba(1, 7, 13, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}

.overview-card::after {
  position: absolute;
  top: -82px;
  right: -50px;
  width: 210px;
  height: 210px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(126, 196, 238, 0.14), transparent 70%);
  content: "";
  pointer-events: none;
}

.overview-topline,
.overview-brand,
.overview-stats,
.composition-labels {
  display: flex;
  align-items: center;
}

.overview-topline {
  justify-content: space-between;
  gap: 14px;
}

.overview-brand {
  gap: 12px;
}

.overview-symbol {
  width: 44px;
  height: 44px;
  flex: 0 0 auto;
  object-fit: contain;
}

.eyebrow {
  margin: 0 0 4px;
  color: #a9d7f3;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.overview-brand h1,
.section-heading h1 {
  margin: 0;
  color: var(--text);
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 0.01em;
  line-height: 1.18;
}

.private-label {
  padding: 7px 11px;
  border: 1px solid rgba(207, 231, 248, 0.12);
  border-radius: 999px;
  background: rgba(224, 239, 252, 0.055);
  color: rgba(235, 244, 251, 0.74);
  font-size: 11px;
  white-space: nowrap;
}

.overview-subtitle {
  margin: 7px 0 15px 56px;
  color: rgba(228, 239, 249, 0.67);
  font-size: 14px;
}

.overview-stats {
  gap: 0;
  padding: 13px 0 12px;
  border-top: 1px solid rgba(225, 239, 251, 0.095);
}

.stat-block {
  display: flex;
  flex: 1;
  align-items: baseline;
  gap: 8px;
}

.stat-block + .stat-block {
  padding-left: 18px;
  border-left: 1px solid rgba(225, 239, 251, 0.11);
}

.stat-value {
  font-size: 25px;
  font-weight: 700;
  letter-spacing: -0.04em;
  line-height: 1;
}

.stat-label {
  color: var(--muted);
  font-size: 13px;
}

.stats-loading {
  padding: 16px 0 3px 56px;
  color: var(--muted);
  font-size: 13px;
}

.content-composition {
  padding-top: 2px;
}

.composition-bar {
  display: flex;
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(219, 233, 245, 0.13);
}

.composition-photos {
  min-width: 0;
  background: linear-gradient(90deg, #78c8ec, #8db6ef);
  transition: width 300ms ease;
}

.composition-files {
  min-width: 0;
  background: rgba(145, 165, 188, 0.54);
}

.composition-labels {
  justify-content: space-between;
  gap: 14px;
  margin-top: 9px;
  color: var(--subtle);
  font-size: 11px;
}

.composition-labels span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.overview-footnote {
  margin: 9px 0 0;
  color: var(--subtle);
  font-size: 10px;
  line-height: 1.45;
}

.auth-gate {
  display: flex;
  min-height: min(58vh, 520px);
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 28px 22px;
  border: 1px solid var(--line);
  border-radius: 22px;
  background: rgba(7, 19, 31, 0.88);
  text-align: center;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
}

.auth-mark {
  display: grid;
  width: 58px;
  height: 58px;
  margin-bottom: 18px;
  place-items: center;
  border: 1px solid rgba(164, 211, 239, 0.18);
  border-radius: 18px;
  background: rgba(87, 157, 198, 0.13);
}

.auth-mark img {
  width: 42px;
  height: 42px;
  object-fit: contain;
}

.auth-gate h1 {
  margin: 0;
  font-size: 23px;
}

.auth-copy {
  margin: 10px 0 22px;
  color: var(--muted);
  font-size: 13px;
}

.auth-form {
  display: grid;
  width: min(100%, 380px);
  gap: 10px;
}

.auth-form input {
  min-width: 0;
  min-height: 48px;
  padding: 0 15px;
  border: 1px solid rgba(222, 237, 250, 0.15);
  border-radius: 14px;
  outline: none;
  background: rgba(3, 12, 20, 0.68);
  color: var(--text);
}

.auth-submit,
.upload-button {
  display: inline-flex;
  min-height: 44px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 16px;
  border: 1px solid rgba(148, 206, 239, 0.24);
  border-radius: 13px;
  background: rgba(77, 143, 183, 0.24);
  color: #e9f6fd;
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
}

.auth-submit:disabled,
.upload-button:disabled {
  cursor: wait;
  opacity: 0.62;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  clip-path: inset(50%);
}

.legend-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.legend-dot--photo {
  background: #8bd0f2;
}

.legend-dot--file {
  background: #9aaabd;
}

.directory-list {
  display: grid;
  gap: 10px;
}

.directory-card {
  display: grid;
  width: 100%;
  min-height: 82px;
  grid-template-columns: 46px minmax(0, 1fr) 24px;
  align-items: center;
  gap: 13px;
  padding: 13px 16px;
  border: 1px solid rgba(219, 235, 250, 0.13);
  border-radius: 19px;
  background: rgba(9, 22, 35, 0.82);
  box-shadow: 0 10px 28px rgba(1, 7, 13, 0.16);
  text-align: left;
  cursor: pointer;
  transition: transform 160ms ease, border-color 160ms ease, background 160ms ease;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

.directory-card:hover,
.directory-card:focus-visible {
  border-color: rgba(155, 210, 243, 0.32);
  background: rgba(12, 29, 45, 0.9);
}

.directory-card:active {
  transform: scale(0.99);
}

.directory-icon {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border: 1px solid rgba(201, 229, 247, 0.14);
  border-radius: 15px;
}

.directory-icon svg,
.empty-icon svg {
  width: 23px;
  height: 23px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.65;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.directory-icon--photos {
  background: rgba(84, 156, 202, 0.19);
  color: #a8dafa;
}

.directory-icon--files {
  background: rgba(133, 155, 183, 0.17);
  color: #c4d2e2;
}

.directory-copy,
.row-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.directory-title {
  overflow: hidden;
  color: #f5f8fc;
  font-size: 16px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.directory-meta {
  overflow: hidden;
  margin-top: 5px;
  color: var(--muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.directory-chevron {
  color: rgba(226, 239, 250, 0.56);
}

.page-footer {
  margin-top: 24px;
  padding: 24px 4px 2px;
  color: rgba(218, 231, 243, 0.46);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-align: center;
}

.error-banner {
  margin-bottom: 14px;
  padding: 12px 14px;
  border: 1px solid rgba(255, 175, 170, 0.22);
  border-radius: 13px;
  background: rgba(91, 25, 30, 0.54);
  color: #ffe4e0;
  font-size: 13px;
}

.browse-view {
  display: flex;
  min-height: 320px;
  flex-direction: column;
}

.section-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.section-heading h1 {
  font-size: 25px;
}

.result-count {
  padding: 7px 10px;
  border: 1px solid rgba(221, 236, 249, 0.12);
  border-radius: 999px;
  background: rgba(8, 19, 31, 0.60);
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}

.search-box {
  display: flex;
  min-height: 48px;
  align-items: center;
  gap: 10px;
  padding: 0 13px;
  border: 1px solid rgba(222, 237, 249, 0.15);
  border-radius: 15px;
  background: rgba(8, 19, 31, 0.75);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.025);
}

.search-box:focus-within {
  border-color: rgba(142, 204, 238, 0.45);
  box-shadow: 0 0 0 3px rgba(108, 183, 225, 0.10);
}

.search-box > svg {
  width: 19px;
  height: 19px;
  flex: 0 0 auto;
  fill: none;
  stroke: rgba(225, 237, 248, 0.58);
  stroke-width: 1.7;
  stroke-linecap: round;
}

.search-box input {
  width: 100%;
  min-width: 0;
  height: 46px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text);
  font-size: 14px;
}

.search-box input::placeholder {
  color: rgba(218, 231, 243, 0.44);
}

.search-box input::-webkit-search-cancel-button {
  display: none;
}

.clear-search {
  display: grid;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: rgba(228, 239, 249, 0.1);
  color: rgba(239, 246, 252, 0.78);
  font-size: 19px;
  line-height: 1;
  cursor: pointer;
}

.collection-meta {
  display: flex;
  min-height: 34px;
  align-items: center;
  gap: 7px;
  margin: 5px 1px 9px;
  color: var(--subtle);
  font-size: 12px;
}

.upload-toolbar {
  display: flex;
  min-height: 42px;
  align-items: center;
  gap: 12px;
  margin: 0 0 10px;
}

.manage-toolbar {
  flex-wrap: wrap;
  gap: 8px;
}

.upload-button {
  min-height: 40px;
  border-radius: 12px;
}

.upload-button svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.upload-status {
  min-width: 0;
  color: var(--muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.read-only-note,
.operation-status {
  margin: 0 0 12px;
  padding: 10px 12px;
  border: 1px solid rgba(221, 236, 249, 0.12);
  border-radius: 12px;
  background: rgba(8, 20, 32, 0.72);
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

.operation-status {
  border-color: rgba(134, 200, 243, 0.22);
  color: #c8eafa;
}

.meta-divider {
  color: rgba(220, 232, 244, 0.34);
}

.photo-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-content: start;
  gap: 10px;
}

.photo-tile {
  position: relative;
  min-width: 0;
}

.photo-open {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.photo-thumb {
  display: block;
  overflow: hidden;
  aspect-ratio: 1 / 1;
  border: 1px solid rgba(223, 237, 249, 0.17);
  border-radius: 14px;
  background: rgba(9, 23, 37, 0.9);
}

.photo-thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 220ms ease;
}

.photo-open:hover .photo-thumb img {
  transform: scale(1.035);
}

.photo-more {
  position: absolute;
  top: 7px;
  right: 7px;
  z-index: 2;
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  padding: 0 0 6px;
  border: 1px solid rgba(241, 248, 252, 0.23);
  border-radius: 11px;
  background: rgba(4, 13, 21, 0.68);
  color: #fff;
  font-size: 19px;
  line-height: 1;
  cursor: pointer;
  backdrop-filter: blur(10px);
}

.photo-name {
  display: block;
  overflow: hidden;
  margin: 7px 2px 0;
  color: rgba(237, 244, 251, 0.72);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-list {
  display: grid;
  align-content: start;
  gap: 8px;
}

.folder-row,
.file-row {
  display: grid;
  width: 100%;
  min-height: 72px;
  grid-template-columns: minmax(0, 1fr) 40px;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid rgba(221, 236, 249, 0.10);
  border-radius: 15px;
  background: rgba(8, 20, 32, 0.83);
  color: inherit;
  text-align: left;
  box-shadow: 0 7px 20px rgba(1, 6, 11, 0.11);
}

.folder-row {
  border-color: rgba(131, 190, 225, 0.16);
  background: linear-gradient(100deg, rgba(20, 45, 65, 0.89), rgba(10, 25, 39, 0.85));
  padding: 0 10px 0 12px;
}

.folder-row:hover,
.folder-row:focus-visible,
.file-row:hover {
  border-color: rgba(161, 210, 239, 0.28);
  background-color: rgba(13, 30, 46, 0.92);
}

.folder-row-icon,
.file-type-icon {
  display: grid;
  width: 42px;
  height: 42px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 13px;
}

.folder-row-icon {
  border: 1px solid rgba(135, 202, 239, 0.16);
  background: rgba(82, 157, 206, 0.17);
  color: #9bd5f4;
}

.folder-row-icon svg {
  width: 22px;
  height: 22px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.65;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.row-title {
  overflow: hidden;
  color: #f3f7fb;
  font-size: 14px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-meta {
  overflow: hidden;
  margin-top: 5px;
  color: rgba(221, 233, 244, 0.58);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-location {
  margin-top: 4px;
  color: rgba(173, 203, 226, 0.56);
  font-size: 10px;
}

.row-chevron {
  justify-self: center;
  color: rgba(217, 233, 247, 0.52);
}

.folder-open {
  display: grid;
  min-width: 0;
  min-height: 70px;
  grid-template-columns: 42px minmax(0, 1fr) 18px;
  align-items: center;
  gap: 12px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.file-row {
  grid-template-columns: minmax(0, 1fr) 40px;
  padding: 0 10px 0 12px;
}

.item-more {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  padding: 0 0 7px;
  border: 1px solid rgba(221, 237, 250, 0.12);
  border-radius: 13px;
  background: rgba(220, 235, 247, 0.06);
  color: rgba(232, 242, 250, 0.82);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  transition: border-color 160ms ease, background 160ms ease, color 160ms ease;
}

.item-more:hover,
.item-more:focus-visible {
  border-color: rgba(147, 207, 240, 0.35);
  background: rgba(144, 199, 232, 0.14);
  color: #fff;
}

.file-open {
  display: grid;
  min-width: 0;
  min-height: 70px;
  grid-template-columns: 42px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.file-type-icon {
  position: relative;
  border: 1px solid rgba(204, 223, 240, 0.12);
  background: rgba(146, 169, 193, 0.13);
  color: #d0ddeb;
}

.file-type-icon::before {
  position: absolute;
  inset: 8px 10px 12px;
  border: 1.3px solid currentColor;
  border-radius: 3px;
  content: "";
  opacity: 0.8;
}

.file-type-icon::after {
  top: 14px;
  left: 13px;
  width: 15px;
  height: 1px;
  background: currentColor;
  box-shadow: 0 4px 0 currentColor;
  content: "";
  opacity: 0.64;
}

.file-type-icon span {
  position: absolute;
  right: 2px;
  bottom: 2px;
  z-index: 1;
  padding: 1px 3px;
  border-radius: 4px;
  background: rgba(5, 15, 25, 0.92);
  color: #e4edf5;
  font-size: 7px;
  font-weight: 750;
  letter-spacing: 0.01em;
}

.file-icon--archive {
  border-color: rgba(205, 178, 136, 0.18);
  background: rgba(137, 101, 52, 0.15);
  color: #e3c89b;
}

.file-icon--image {
  border-color: rgba(120, 195, 177, 0.18);
  background: rgba(44, 119, 100, 0.18);
  color: #a8ddcd;
}

.file-icon--video {
  border-color: rgba(163, 160, 227, 0.2);
  background: rgba(87, 82, 150, 0.2);
  color: #c4c2f1;
}

.file-icon--code {
  border-color: rgba(124, 184, 220, 0.2);
  background: rgba(48, 102, 140, 0.2);
  color: #a9d8f4;
}

.download-button,
.viewer-icon-button {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border: 1px solid rgba(221, 237, 250, 0.12);
  border-radius: 13px;
  background: rgba(220, 235, 247, 0.06);
  color: rgba(232, 242, 250, 0.76);
  text-decoration: none;
  cursor: pointer;
}

.download-button svg {
  width: 19px;
  height: 19px;
}

.download-button:hover,
.viewer-icon-button:hover {
  border-color: rgba(147, 207, 240, 0.35);
  background: rgba(144, 199, 232, 0.14);
  color: #fff;
}

.empty-state {
  display: flex;
  min-height: 220px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 26px;
  border: 1px solid rgba(220, 235, 248, 0.10);
  border-radius: 18px;
  background: rgba(7, 19, 31, 0.73);
  color: var(--muted);
  text-align: center;
}

.empty-state strong {
  color: rgba(245, 249, 253, 0.92);
  font-size: 14px;
}

.empty-state > span:last-child {
  font-size: 12px;
}

.empty-state--compact {
  min-height: 100px;
}

.empty-icon {
  display: grid;
  width: 48px;
  height: 48px;
  margin-bottom: 3px;
  place-items: center;
  border-radius: 16px;
  background: rgba(123, 183, 219, 0.12);
  color: #a3d4f0;
}

.loading-state {
  padding: 24px 8px;
  color: var(--muted);
  font-size: 13px;
}

.action-sheet-backdrop,
.management-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 12px 12px 0;
  background: rgba(1, 6, 11, 0.72);
  backdrop-filter: blur(8px);
  overscroll-behavior: contain;
}

.action-sheet,
.management-panel {
  width: min(100%, 560px);
  padding: 12px 18px calc(18px + env(safe-area-inset-bottom, 0px));
  border: 1px solid rgba(214, 231, 248, 0.16);
  border-radius: 24px 24px 0 0;
  background: rgba(8, 19, 31, 0.97);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
  color: var(--text);
}

.sheet-grabber {
  display: block;
  width: 38px;
  height: 4px;
  margin: 0 auto 16px;
  border-radius: 99px;
  background: rgba(235, 244, 251, 0.32);
}

.sheet-eyebrow {
  margin: 0 0 5px;
  color: #9fcce6;
  font-size: 11px;
  letter-spacing: 0.08em;
}

.sheet-title {
  display: block;
  overflow: hidden;
  margin: 0 0 12px;
  color: #f6f9fc;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sheet-action,
.sheet-cancel {
  display: flex;
  width: 100%;
  min-height: 48px;
  align-items: center;
  padding: 0 12px;
  border: 0;
  border-radius: 13px;
  background: transparent;
  color: #edf5fb;
  font: inherit;
  font-size: 14px;
  text-align: left;
  text-decoration: none;
  cursor: pointer;
}

.sheet-action:hover,
.sheet-action:focus-visible,
.sheet-cancel:hover,
.sheet-cancel:focus-visible {
  background: rgba(156, 202, 231, 0.12);
}

.sheet-action--danger {
  color: #ffb9b7;
}

.sheet-cancel {
  justify-content: center;
  margin-top: 7px;
  border: 1px solid rgba(221, 237, 250, 0.12);
  background: rgba(221, 237, 250, 0.05);
}

.management-panel h2 {
  margin: 0 0 14px;
  color: #f6f9fc;
  font-size: 19px;
}

.management-confirm-copy {
  margin: 0;
  color: rgba(235, 243, 250, 0.84);
  font-size: 14px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.management-label {
  display: block;
  margin: 0 0 7px;
  color: var(--muted);
  font-size: 12px;
}

.management-input {
  width: 100%;
  min-height: 48px;
  padding: 0 13px;
  border: 1px solid rgba(222, 237, 250, 0.17);
  border-radius: 13px;
  outline: none;
  background: rgba(3, 12, 20, 0.8);
  color: var(--text);
  font: inherit;
  font-size: 14px;
}

.management-input:focus {
  border-color: rgba(134, 200, 243, 0.62);
  box-shadow: 0 0 0 3px rgba(134, 200, 243, 0.12);
}

.management-hint {
  margin: 7px 0 0;
  color: var(--subtle);
  font-size: 11px;
}

.management-select-label {
  margin-top: 13px;
}

.management-select {
  appearance: auto;
  color-scheme: dark;
}

.management-select option {
  background: #0b1a28;
  color: #f5f8fc;
}

.folder-photo-grid {
  width: 100%;
  margin-bottom: 3px;
}

.management-error {
  margin: 10px 0 0;
  color: #ffb9b7;
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.management-buttons {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 18px;
}

.dialog-button {
  min-height: 44px;
  padding: 0 14px;
  border: 1px solid rgba(148, 206, 239, 0.25);
  border-radius: 13px;
  background: rgba(77, 143, 183, 0.25);
  color: #e9f6fd;
  font: inherit;
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
}

.dialog-button--quiet {
  border-color: rgba(221, 237, 250, 0.12);
  background: rgba(221, 237, 250, 0.05);
  color: var(--muted);
}

.dialog-button--danger {
  border-color: rgba(231, 111, 111, 0.4);
  background: rgba(142, 53, 58, 0.4);
  color: #ffe5e3;
}

.dialog-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.sheet-enter-active,
.sheet-leave-active {
  transition: opacity 160ms ease, transform 160ms ease;
}

.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}

.sheet-enter-from .action-sheet,
.sheet-leave-to .action-sheet {
  transform: translateY(18px);
}

.action-sheet,
.management-panel {
  transition: transform 160ms ease;
}

.photo-viewer,
.preview-overlay {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: stretch;
  justify-content: center;
  background: rgba(2, 4, 8, 0.985);
  color: #f6f8fb;
  overscroll-behavior: contain;
}

.viewer-layout {
  position: relative;
  display: flex;
  width: min(100%, 1440px);
  min-height: 100vh;
  min-height: 100dvh;
  flex-direction: column;
  padding: max(12px, env(safe-area-inset-top, 0px)) 18px calc(14px + env(safe-area-inset-bottom, 0px));
}

.viewer-topbar,
.preview-header {
  display: grid;
  min-height: 48px;
  grid-template-columns: 44px minmax(0, 1fr) 44px;
  align-items: center;
  gap: 10px;
}

.viewer-icon-button {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.07);
}

.viewer-counter {
  color: rgba(238, 243, 249, 0.8);
  font-size: 13px;
  text-align: center;
}

.viewer-topbar > :last-child,
.preview-header > :last-child {
  justify-self: end;
}

.viewer-stage {
  display: grid;
  min-height: 0;
  flex: 1;
  place-items: center;
  overflow: hidden;
  padding: 16px 56px;
  touch-action: none;
}

.viewer-image {
  display: block;
  max-width: 100%;
  max-height: calc(100vh - 172px);
  max-height: calc(100dvh - 172px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
  object-fit: contain;
  transform-origin: center;
  transition: transform 160ms ease-out;
  user-select: none;
  -webkit-user-drag: none;
}

.viewer-arrow {
  position: absolute;
  top: 50%;
  z-index: 1;
  display: grid;
  width: 46px;
  height: 46px;
  place-items: center;
  transform: translateY(-50%);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(246, 249, 252, 0.86);
  cursor: pointer;
}

.viewer-arrow--left {
  left: 18px;
}

.viewer-arrow--right {
  right: 18px;
}

.viewer-details {
  display: flex;
  min-height: 60px;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 10px 2px 0;
}

.viewer-file-info {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
}

.viewer-filename {
  overflow: hidden;
  color: #f8fafc;
  font-size: 14px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.viewer-metadata {
  display: flex;
  flex-wrap: wrap;
  gap: 7px 12px;
  color: rgba(218, 228, 238, 0.60);
  font-size: 11px;
}

.zoom-button,
.primary-download {
  display: inline-flex;
  min-height: 40px;
  align-items: center;
  justify-content: center;
  padding: 0 14px;
  border: 1px solid rgba(142, 204, 239, 0.28);
  border-radius: 999px;
  background: rgba(83, 148, 190, 0.18);
  color: #e7f5fd;
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
}

.preview-overlay {
  z-index: 21;
  align-items: center;
  padding: 20px;
  background: rgba(2, 5, 9, 0.94);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}

.preview-panel {
  display: flex;
  width: min(100%, 900px);
  max-height: min(86vh, 900px);
  max-height: min(86dvh, 900px);
  min-height: min(360px, 74vh);
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgba(229, 239, 248, 0.12);
  border-radius: 20px;
  background: #08121d;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.44);
}

.preview-header {
  flex: 0 0 auto;
  padding: 12px 14px;
  border-bottom: 1px solid rgba(229, 239, 248, 0.10);
}

.preview-heading {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
  text-align: center;
}

.preview-heading strong {
  overflow: hidden;
  color: #f5f8fb;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-heading span {
  color: var(--subtle);
  font-size: 11px;
}

.preview-message {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 30px;
  color: var(--muted);
  text-align: center;
}

.preview-message strong {
  color: #f1f5f9;
  font-size: 15px;
}

.preview-message > span {
  font-size: 13px;
}

.text-preview {
  flex: 1;
  overflow: auto;
  margin: 0;
  padding: 20px;
  color: #dce8f2;
  font: 13px/1.7 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.pdf-preview,
.file-video-preview {
  width: 100%;
  min-height: 0;
  flex: 1;
  border: 0;
  background: #0b1117;
}

.file-video-preview {
  object-fit: contain;
}

.viewer-fade-enter-active,
.viewer-fade-leave-active {
  transition: opacity 160ms ease;
}

.viewer-fade-enter-from,
.viewer-fade-leave-to {
  opacity: 0;
}

@media (min-width: 700px) {
  .action-sheet-backdrop,
  .management-backdrop {
    align-items: center;
  }

  .action-sheet,
  .management-panel {
    border-radius: 24px;
  }

  .app-shell {
    padding-top: calc(env(safe-area-inset-top, 0px) + 28px);
    padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 34px);
  }

  .content-width {
    min-height: calc(100vh - 62px);
    min-height: calc(100dvh - 62px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
  }

  .home-header,
  .inner-header {
    margin-bottom: 34px;
  }

  .home-view {
    gap: 16px;
  }

  .overview-card {
    padding: 24px 28px 20px;
  }

  .directory-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }

  .directory-card {
    min-height: 90px;
    padding: 15px 17px;
  }

  .photo-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 14px;
  }

  .photo-thumb {
    border-radius: 16px;
  }

  .file-list {
    gap: 9px;
  }

  .folder-row,
  .file-row {
    min-height: 78px;
    padding-top: 11px;
    padding-bottom: 11px;
  }
}

@media (max-width: 430px) {
  .app-shell {
    padding-right: 17px;
    padding-left: 17px;
  }

  .home-header,
  .inner-header {
    margin-bottom: 22px;
  }

  .overview-card {
    padding: 18px 17px 16px;
    border-radius: 20px;
  }

  .overview-brand h1 {
    font-size: 22px;
  }

  .private-label {
    padding: 6px 9px;
  }

  .overview-subtitle {
    margin-left: 54px;
    font-size: 13px;
  }

  .directory-card {
    min-height: 76px;
    grid-template-columns: 42px minmax(0, 1fr) 20px;
    gap: 11px;
    padding: 11px 13px;
    border-radius: 17px;
  }

  .directory-icon {
    width: 42px;
    height: 42px;
    border-radius: 14px;
  }

  .directory-title {
    font-size: 15px;
  }

  .directory-meta {
    font-size: 11px;
  }

  .photo-grid {
    gap: 7px;
  }

  .photo-thumb {
    border-radius: 11px;
  }

  .photo-name {
    font-size: 10px;
  }
}

@media (max-width: 360px) {
  .location-chip {
    gap: 6px;
    padding-right: 9px;
    padding-left: 9px;
    font-size: 12px;
  }

  .overview-stats {
    padding-top: 11px;
  }

  .stat-value {
    font-size: 23px;
  }

  .directory-card {
    grid-template-columns: 38px minmax(0, 1fr) 18px;
    gap: 9px;
  }

  .directory-icon {
    width: 38px;
    height: 38px;
  }

  .directory-meta {
    font-size: 10px;
  }
}

@media (max-width: 560px) {
  .viewer-layout {
    padding-right: 12px;
    padding-left: 12px;
  }

  .viewer-stage {
    padding: 14px 4px;
  }

  .viewer-image {
    max-width: 100%;
    max-height: calc(100vh - 176px);
    max-height: calc(100dvh - 176px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
  }

  .viewer-arrow {
    display: none;
  }

  .viewer-details {
    gap: 10px;
  }

  .viewer-filename {
    max-width: 66vw;
    font-size: 13px;
  }

  .zoom-button {
    min-height: 38px;
    padding: 0 11px;
    font-size: 11px;
  }

  .preview-overlay {
    padding: 10px;
  }

  .preview-panel {
    max-height: calc(100vh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 20px);
    max-height: calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 20px);
    min-height: min(420px, 78vh);
    border-radius: 17px;
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
</style>
