const notice = document.querySelector('#notice')
const loginPanel = document.querySelector('#login-panel')
const dashboard = document.querySelector('#dashboard')
const globalAccess = document.querySelector('#global-access')
const saveGlobalButton = document.querySelector('#save-global')
const itemList = document.querySelector('#item-list')
const directorySummary = document.querySelector('#directory-summary')
const breadcrumb = document.querySelector('#breadcrumb')
const searchInput = document.querySelector('#item-search')
const refreshButton = document.querySelector('#refresh-directory')
const createButton = document.querySelector('#create-folder-button')
const createDialog = document.querySelector('#create-dialog')
const renameDialog = document.querySelector('#rename-dialog')
const deleteDialog = document.querySelector('#delete-dialog')
const rootFolderDialog = document.querySelector('#root-folder-dialog')
const storageList = document.querySelector('#storage-list')
const storageSelect = document.querySelector('#storage-select')

let savedGlobalAccess = 'locked'
let storageProviders = []
let activeStorageId = new URLSearchParams(location.search).get('storageId') || ''
let storageReady = false
let currentFolderId = ''
let currentItems = []
let folderStack = [{ id: '', name: '根目录' }]
let renameItem = null
let deleteItem = null
let rootPickerProvider = null
let rootPickerStack = [{ id: '', name: '网盘根目录' }]
let rootPickerDirectory = null
let rootPickerLoadToken = 0
const rootPickerCache = new Map()

function showNotice(message, kind = 'info') {
  notice.textContent = message
  notice.dataset.kind = kind
  notice.hidden = !message
}

async function apiJson(path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.message || payload?.error || `HTTP ${response.status}`)
    error.status = response.status
    error.code = payload?.error
    throw error
  }
  return payload
}

function formatBytes(bytes) {
  const value = Number(bytes || 0)
  if (!Number.isFinite(value) || value <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`
}

function accessText(value) {
  if (value === 'locked') return '上锁'
  if (value === 'public') return '公开'
  return '继承'
}

function typeText(item) {
  if (!item.isFolder) return item.extension ? item.extension.toUpperCase() : '文件'
  return item.folderType === 'album' ? '相册' : '文件夹'
}

function appendOption(select, value, label) {
  const option = document.createElement('option')
  option.value = value
  option.textContent = label
  select.append(option)
}

function renderRootPickerBreadcrumb() {
  const nav = document.querySelector('#root-picker-breadcrumb')
  nav.replaceChildren()
  rootPickerStack.forEach((entry, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'crumb-button'
    button.textContent = entry.name
    button.disabled = index === rootPickerStack.length - 1
    button.addEventListener('click', () => {
      rootPickerStack = rootPickerStack.slice(0, index + 1)
      loadRootPickerDirectory()
    })
    nav.append(button)
    if (index < rootPickerStack.length - 1) {
      const divider = document.createElement('span')
      divider.className = 'crumb-divider'
      divider.textContent = '›'
      nav.append(divider)
    }
  })
}

function renderRootPickerItems() {
  const list = document.querySelector('#root-picker-list')
  list.replaceChildren()
  const folders = rootPickerDirectory?.items?.filter((item) => item.isFolder) || []
  if (!folders.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = rootPickerDirectory?.nextPageToken ? '这一页没有文件夹，可继续加载。' : '当前目录没有子文件夹。'
    list.append(empty)
  }
  for (const item of folders) {
    const row = document.createElement('article')
    row.className = 'item-card'
    const name = document.createElement('button')
    name.type = 'button'
    name.className = 'item-title item-open'
    name.textContent = item.name || '未命名文件夹'
    name.addEventListener('click', () => {
      rootPickerStack = [...rootPickerStack, { id: item.id, name: item.name || '未命名文件夹' }]
      loadRootPickerDirectory()
    })
    const enter = document.createElement('button')
    enter.type = 'button'
    enter.className = 'quiet-button'
    enter.textContent = '进入'
    enter.addEventListener('click', () => name.click())
    row.append(name, enter)
    list.append(row)
  }
  if (rootPickerDirectory?.nextPageToken) {
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'quiet-button'
    more.textContent = '加载更多文件夹'
    more.addEventListener('click', () => loadRootPickerDirectory({ append: true }))
    list.append(more)
  }
}

async function loadRootPickerDirectory({ append = false } = {}) {
  if (!rootPickerProvider) return
  const token = ++rootPickerLoadToken
  const current = rootPickerStack.at(-1)
  const cacheKey = `${rootPickerProvider.id}\u0000${current.id}`
  const cached = rootPickerCache.get(cacheKey)
  if (!append && cached) {
    rootPickerDirectory = cached
    document.querySelector('#root-picker-message').textContent = ''
    renderRootPickerBreadcrumb()
    renderRootPickerItems()
    return
  }
  const message = document.querySelector('#root-picker-message')
  message.textContent = '正在读取当前目录…'
  renderRootPickerBreadcrumb()
  if (append && cached?.nextRequestDelayMs > 0) {
    message.textContent = `夸克请求间隔中，等待 ${cached.nextRequestDelayMs} 毫秒…`
    await new Promise((resolve) => window.setTimeout(resolve, cached.nextRequestDelayMs))
    if (token !== rootPickerLoadToken) return
  }
  const params = new URLSearchParams({ storageId: rootPickerProvider.id })
  if (current.id) params.set('parentId', current.id)
  if (append && cached?.nextPageToken) params.set('pageToken', cached.nextPageToken)
  try {
    const payload = await apiJson(`/api/admin-storage-files?${params.toString()}`)
    if (token !== rootPickerLoadToken) return
    const prior = append && cached ? cached.items : []
    rootPickerDirectory = {
      items: [...prior, ...(Array.isArray(payload.items) ? payload.items : [])],
      nextPageToken: payload.nextPageToken || '',
      nextRequestDelayMs: Number(payload.nextRequestDelayMs || 0),
    }
    rootPickerCache.set(cacheKey, rootPickerDirectory)
    message.textContent = ''
    renderRootPickerItems()
  } catch (error) {
    if (token !== rootPickerLoadToken) return
    message.textContent = error.message
    rootPickerDirectory = null
    renderRootPickerItems()
  }
}

async function saveWebsiteRoot(rootFolderId) {
  if (!rootPickerProvider) return
  const button = document.querySelector('#root-picker-select')
  button.disabled = true
  try {
    await apiJson('/api/admin-storages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set-root-folder', storageId: rootPickerProvider.id, rootFolderId }),
    })
    rootPickerDialog.close()
    rootPickerCache.clear()
    await loadStorageProviders()
    showNotice(rootFolderId ? '网站根目录已更新。' : '网站根目录已设为整个网盘。', 'success')
  } catch (error) {
    document.querySelector('#root-picker-message').textContent = error.message
  } finally {
    button.disabled = false
  }
}

function setBusy(button, busy, busyText, normalText) {
  button.disabled = busy
  button.textContent = busy ? busyText : normalText
}

function renderBreadcrumb() {
  breadcrumb.replaceChildren()
  folderStack.forEach((entry, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'crumb-button'
    button.textContent = entry.name
    button.disabled = index === folderStack.length - 1
    button.addEventListener('click', () => {
      folderStack = folderStack.slice(0, index + 1)
      currentFolderId = entry.id
      loadDirectory()
    })
    breadcrumb.append(button)
    if (index < folderStack.length - 1) {
      const divider = document.createElement('span')
      divider.className = 'crumb-divider'
      divider.textContent = '›'
      breadcrumb.append(divider)
    }
  })
}

function makeAccessSelect(value) {
  const select = document.createElement('select')
  appendOption(select, 'inherit', '继承')
  appendOption(select, 'public', '公开')
  appendOption(select, 'locked', '上锁')
  select.value = value || 'inherit'
  return select
}

function renderItem(item) {
  const card = document.createElement('article')
  card.className = 'item-card'

  const main = document.createElement('div')
  main.className = 'item-main'

  const icon = document.createElement('div')
  icon.className = 'item-icon'
  icon.textContent = item.isFolder ? (item.folderType === 'album' ? '◫' : '▣') : '▤'

  const copy = document.createElement('div')
  copy.className = 'item-copy'

  const titleRow = document.createElement('div')
  titleRow.className = 'item-title-row'
  const title = document.createElement(item.isFolder ? 'button' : 'div')
  title.className = item.isFolder ? 'item-title item-open' : 'item-title'
  title.textContent = item.name || '未命名'
  if (item.isFolder) {
    title.type = 'button'
    title.addEventListener('click', () => openFolder(item))
  }
  const state = document.createElement('span')
  state.className = 'access-badge'
  state.dataset.access = item.effectiveAccess || 'public'
  state.textContent = `当前：${accessText(item.effectiveAccess || 'public')}`
  titleRow.append(title, state)

  const meta = document.createElement('p')
  meta.className = 'item-meta'
  const parts = [typeText(item)]
  if (!item.isFolder) parts.push(formatBytes(item.size))
  if (item.modifiedAt) parts.push(new Date(item.modifiedAt).toLocaleString('zh-CN'))
  meta.textContent = parts.join(' · ')

  copy.append(titleRow, meta)
  main.append(icon, copy)

  const controls = document.createElement('div')
  controls.className = 'item-controls'

  let typeSelect = null
  if (item.isFolder) {
    const typeField = document.createElement('label')
    typeField.className = 'compact-field'
    typeField.textContent = '类型'
    typeSelect = document.createElement('select')
    appendOption(typeSelect, 'folder', '文件夹')
    appendOption(typeSelect, 'album', '相册')
    typeSelect.value = item.folderType || 'folder'
    typeField.append(typeSelect)
    controls.append(typeField)
  }

  const accessField = document.createElement('label')
  accessField.className = 'compact-field'
  accessField.textContent = '权限'
  const accessSelect = makeAccessSelect(item.access)
  accessField.append(accessSelect)
  controls.append(accessField)

  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'primary-button compact-button'
  save.textContent = '保存权限'
  const syncSave = () => {
    const changed = accessSelect.value !== (item.access || 'inherit') ||
      (item.isFolder && typeSelect.value !== (item.folderType || 'folder'))
    save.disabled = !storageReady || !changed
  }
  accessSelect.addEventListener('change', syncSave)
  if (typeSelect) typeSelect.addEventListener('change', syncSave)
  syncSave()
  save.addEventListener('click', async () => {
    setBusy(save, true, '保存中…', '保存权限')
    try {
      if (item.isFolder) {
        await apiJson('/api/admin-folder-metadata', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            storageId: activeStorageId, folderId: item.id,
            type: typeSelect.value,
            access: accessSelect.value,
          }),
        })
      } else {
        await apiJson('/api/admin-file-metadata', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storageId: activeStorageId, fileId: item.id, access: accessSelect.value }),
        })
      }
      await loadDirectory()
      showNotice(`已保存「${item.name}」的权限设置。`, 'success')
    } catch (error) {
      showNotice(error.message, 'error')
    } finally {
      setBusy(save, false, '保存中…', '保存权限')
      syncSave()
    }
  })
  controls.append(save)

  const actions = document.createElement('div')
  actions.className = 'item-actions'
  if (item.isFolder) {
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'quiet-button'
    open.textContent = '进入'
    open.addEventListener('click', () => openFolder(item))
    actions.append(open)
  }

  const rename = document.createElement('button')
  rename.type = 'button'
  rename.className = 'quiet-button'
  rename.textContent = '重命名'
  rename.disabled = item.writable === false || !activeCapabilities().rename
  rename.addEventListener('click', () => openRename(item))

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'danger-ghost'
  remove.textContent = '删除'
  remove.disabled = item.writable === false || !activeCapabilities().trash
  remove.addEventListener('click', () => openDelete(item))
  actions.append(rename, remove)

  card.append(main, controls, actions)
  return card
}

function renderItems() {
  const query = searchInput.value.trim().toLocaleLowerCase('zh-CN')
  const filtered = query
    ? currentItems.filter((item) => String(item.name || '').toLocaleLowerCase('zh-CN').includes(query))
    : currentItems

  itemList.replaceChildren()
  if (!filtered.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = query ? '当前目录没有匹配项目。' : '这个目录是空的。'
    itemList.append(empty)
    return
  }
  filtered.forEach((item) => itemList.append(renderItem(item)))
}

function storageStatusText(status) {
  if (status === 'connected') return '已连接'
  if (status === 'authorization_required') return '待授权'
  if (status === 'unavailable') return '暂不可用'
  if (status === 'disabled') return '已停用'
  if (status === 'not_configured') return '未配置'
  if (status === 'integration_pending') return '接入中'
  if (status === 'official_web_api_unavailable') return '官方 Web 接入未开放'
  return '不可用'
}

function activeCapabilities() { return storageProviders.find(p => p.id === activeStorageId)?.capabilities || {} }

function renderStorageProviders() {
  storageList.replaceChildren()
  storageSelect.replaceChildren()

  storageProviders.forEach((provider) => {
    const card = document.createElement('article')
    card.className = 'storage-card'

    const head = document.createElement('div')
    head.className = 'storage-card__head'
    const copy = document.createElement('div')
    const name = document.createElement('div')
    name.className = 'storage-card__name'
    name.textContent = provider.name
    const type = document.createElement('p')
    type.className = 'storage-card__type'
    type.textContent = provider.type + (provider.default ? ' · 默认盘' : '')
    copy.append(name, type)

    const status = document.createElement('span')
    status.className = 'storage-status'
    status.dataset.status = provider.status || ''
    status.textContent = storageStatusText(provider.status)
    head.append(copy, status)
    card.append(head)

    const detail = document.createElement('p')
    detail.className = 'muted'
    const member = { NORMAL: '普通用户', VIP: '会员', SVIP: '超级会员' }[provider.accountInfo?.memberType] || provider.accountInfo?.memberType || ''
    const hasQuota = provider.quota && Number.isFinite(provider.quota.used) && Number.isFinite(provider.quota.total)
    detail.textContent = [provider.accountInfo?.nickname, member, hasQuota ? `已用 ${formatBytes(provider.quota.used)} / ${formatBytes(provider.quota.total)}` : '容量尚不可用', provider.authStatus === 'valid' ? '认证有效' : '等待认证检查'].filter(Boolean).join(' · ')
    card.append(detail)
    const rootSetting = document.createElement('div')
    rootSetting.className = 'storage-root-setting'
    const rootLabel = document.createElement('p')
    rootLabel.className = 'muted'
    rootLabel.textContent = `网站根目录：${provider.rootFolderId ? (provider.rootFolderName || '已指定文件夹') : '整个网盘'}`
    const chooseRoot = document.createElement('button')
    chooseRoot.type = 'button'
    chooseRoot.className = 'quiet-button'
    chooseRoot.textContent = '选择根目录'
    chooseRoot.addEventListener('click', () => {
      rootPickerProvider = provider
      rootPickerStack = [{ id: '', name: '网盘根目录' }]
      rootPickerDirectory = null
      rootFolderDialog.showModal()
      loadRootPickerDirectory()
    })
    rootSetting.append(rootLabel, chooseRoot)
    card.append(rootSetting)
    if (provider.selectable) {
      const enter = document.createElement('a'); enter.className = 'quiet-button'; enter.textContent = '进入网盘'; enter.href = '/?storageId=' + encodeURIComponent(provider.id); card.append(enter)
      const primary = document.createElement('button'); primary.type = 'button'; primary.className = 'quiet-button'; primary.textContent = provider.default ? '当前默认盘' : '设为默认盘'; primary.disabled = provider.default
      primary.addEventListener('click', async () => { primary.disabled = true; try { await apiJson('/api/admin-storages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set-default', storageId: provider.id }) }); await loadStorageProviders(); showNotice('默认网盘已更新。', 'success') } catch (error) { showNotice(error.message, 'error'); primary.disabled = false } })
      card.append(primary)
    }
    if (provider.type === 'pikpak' && !provider.primary) {
      const rotate = document.createElement('button'); rotate.type = 'button'; rotate.className = 'quiet-button'; rotate.textContent = '更新 PikPak 凭据'
      rotate.addEventListener('click', async () => {
        const accessToken = window.prompt('请输入新的 PikPak PAT。该值只会提交到管理 API，不会显示在状态信息中。')
        if (accessToken === null) return
        if (!accessToken) { showNotice('PikPak PAT 不能为空。', 'error'); return }
        rotate.disabled = true
        try {
          await apiJson('/api/admin-storages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'update', storageId: provider.id, accessToken }) })
          await loadStorageProviders(); showNotice('PikPak 凭据已验证并更新。', 'success')
        } catch (error) { showNotice(error.message, 'error') } finally { rotate.disabled = false }
      })
      card.append(rotate)
    }
    if (provider.type === 'quark') {
      const authorize = document.createElement('button'); authorize.type = 'button'; authorize.className = 'quiet-button'; authorize.textContent = provider.configured ? '重新授权' : '授权夸克网盘'
      authorize.addEventListener('click', async () => {
        authorize.disabled = true
        // Open during the user gesture so mobile browsers allow the authorization tab.
        const authWindow = window.open('about:blank', '_blank')
        try {
          const result = await apiJson('/api/quark-oauth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start', storageId: provider.id }) })
          if (authWindow) { authWindow.opener = null; authWindow.location = result.authorizeUrl }
          const link = document.createElement('a'); link.textContent = '打开夸克授权页'; link.href = result.authorizeUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link)
          const complete = document.createElement('button'); complete.type = 'button'; complete.className = 'primary-button'; complete.textContent = '我已授权，检查连接'
          complete.addEventListener('click', async () => {
            complete.disabled = true
            try { const result = await apiJson('/api/quark-oauth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'complete', storageId: provider.id }) }); if (result.status === 'authorization_pending') showNotice('夸克授权尚未完成，请先在授权页确认。'); else { await loadStorageProviders(); showNotice('夸克授权已保存，连接状态已重新读取。', 'success') } } catch (error) { showNotice(error.message, 'error') } finally { complete.disabled = false }
          }); card.append(complete)
        } catch (error) { authWindow?.close(); showNotice(error.message, 'error') } finally { authorize.disabled = false }
      }); card.append(authorize)

    }
    if (provider.type === 'quark') { const note = document.createElement('p'); note.className = 'muted'; note.textContent = '授权使用夸克官方 Agent Skill 流程；普通网站 API 尚无公开的通用接入文档。文件列表、创建文件夹与免账号凭据直链需授权后验证；上传、重命名/移动和回收站暂不开放。'; card.append(note) }
    storageList.append(card)

    if (provider.selectable) {
      appendOption(storageSelect, provider.id, provider.name)
    }
  })

  if ([...storageSelect.options].some((option) => option.value === activeStorageId)) {
    storageSelect.value = activeStorageId
  } else if (storageSelect.options.length) {
    activeStorageId = storageSelect.options[0].value
    storageSelect.value = activeStorageId
  }
  storageSelect.disabled = storageSelect.options.length <= 1
}

async function loadStorageProviders() {
  const payload = await apiJson('/api/admin-storages')
  storageProviders = Array.isArray(payload.providers) ? payload.providers : []
  const current = storageProviders.find((provider) => provider.id === activeStorageId && provider.selectable)
  if (!current) {
    const fallback = storageProviders.find((provider) => provider.id === payload.defaultStorageId && provider.selectable)
      || storageProviders.find((provider) => provider.selectable)
    if (fallback) activeStorageId = fallback.id
  }
  renderStorageProviders()
}

async function loadConfig() {
  const config = await apiJson('/api/admin-config')
  savedGlobalAccess = config.globalAccess
  globalAccess.value = config.globalAccess
  storageReady = Boolean(config.storageReady)
  saveGlobalButton.disabled = !storageReady
  if (!storageReady) {
    showNotice('持久化存储不可用：目前可以浏览文件，但权限设置无法保存。', 'error')
  }
}

async function loadDirectory() {
  refreshButton.disabled = true
  createButton.disabled = true
  itemList.replaceChildren()
  const loading = document.createElement('div')
  loading.className = 'empty'
  loading.textContent = '正在读取当前目录…'
  itemList.append(loading)
  renderBreadcrumb()

  try {
    const params = new URLSearchParams({ storageId: activeStorageId })
    if (currentFolderId) params.set('parentId', currentFolderId)
    const listing = await apiJson(`/api/storage-files?${params.toString()}`)
    currentItems = Array.isArray(listing.items) ? listing.items : []
    const folders = currentItems.filter((item) => item.isFolder).length
    const files = currentItems.length - folders
    directorySummary.textContent = `${folderStack.at(-1)?.name || '根目录'} · ${folders} 个文件夹/相册 · ${files} 个文件`
    renderItems()
  } catch (error) {
    currentItems = []
    itemList.replaceChildren()
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = error.message
    itemList.append(empty)
    if (error.status === 401) {
      dashboard.hidden = true
      loginPanel.hidden = false
    }
    showNotice(error.message, 'error')
  } finally {
    refreshButton.disabled = false
    createButton.disabled = !activeCapabilities().createFolder
  }
}

async function loadDashboard() {
  showNotice('正在读取后台配置和云盘目录…')
  try {
    await loadConfig()
    await loadStorageProviders()
    await loadDirectory()
    if (storageReady) showNotice('后台已读取最新状态。')
  } catch (error) {
    if (error.status === 401) {
      dashboard.hidden = true
      loginPanel.hidden = false
      showNotice('请先使用管理员密码登录。')
    } else {
      showNotice(error.message, 'error')
    }
  }
}

function openFolder(item) {
  currentFolderId = item.id
  folderStack.push({ id: item.id, name: item.name || '未命名文件夹' })
  searchInput.value = ''
  loadDirectory()
}

function openRename(item) {
  renameItem = item
  document.querySelector('#rename-target').textContent = item.name
  document.querySelector('#rename-name').value = item.name || ''
  renameDialog.showModal()
  queueMicrotask(() => document.querySelector('#rename-name').select())
}

function openDelete(item) {
  deleteItem = item
  document.querySelector('#delete-target').textContent = `确定把「${item.name}」移到回收站吗？`
  deleteDialog.showModal()
}

globalAccess.addEventListener('change', () => {
  saveGlobalButton.disabled = !storageReady || globalAccess.value === savedGlobalAccess
})

saveGlobalButton.addEventListener('click', async () => {
  const next = globalAccess.value
  setBusy(saveGlobalButton, true, '保存中…', '保存入口设置')
  try {
    await apiJson('/api/admin-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ globalAccess: next }),
    })
    savedGlobalAccess = next
    await loadDirectory()
    showNotice(`云盘入口已改为「${next === 'locked' ? '需要密码' : '公开进入'}」。`, 'success')
  } catch (error) {
    globalAccess.value = savedGlobalAccess
    showNotice(error.message, 'error')
  } finally {
    saveGlobalButton.textContent = '保存入口设置'
    saveGlobalButton.disabled = !storageReady || globalAccess.value === savedGlobalAccess
  }
})

storageSelect.addEventListener('change', () => {
  activeStorageId = storageSelect.value || 'pikpak-main'
  currentFolderId = ''
  currentItems = []
  folderStack = [{ id: '', name: '根目录' }]
  searchInput.value = ''
  loadDirectory()
})

searchInput.addEventListener('input', renderItems)
refreshButton.addEventListener('click', loadDirectory)
createButton.addEventListener('click', () => {
  document.querySelector('#create-folder-form').reset()
  createDialog.showModal()
  queueMicrotask(() => document.querySelector('#create-folder-name').focus())
})

document.querySelectorAll('[data-close-dialog]').forEach((button) => {
  button.addEventListener('click', () => button.closest('dialog').close())
})

document.querySelector('#root-picker-close').addEventListener('click', () => rootFolderDialog.close())
document.querySelector('#root-picker-select').addEventListener('click', () => {
  const current = rootPickerStack.at(-1)
  saveWebsiteRoot(current.id || null)
})
document.querySelector('#root-picker-whole-drive').addEventListener('click', () => saveWebsiteRoot(null))

document.querySelector('#create-folder-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const button = event.currentTarget.querySelector('button[type="submit"]')
  const name = document.querySelector('#create-folder-name').value.trim()
  const type = document.querySelector('#create-folder-type').value
  const access = document.querySelector('#create-folder-access').value
  setBusy(button, true, '创建中…', '创建')
  try {
    await apiJson('/api/storage-create-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storageId: activeStorageId, name, parentId: currentFolderId, type, access }),
    })
    createDialog.close()
    await loadDirectory()
    showNotice(`已创建「${name}」。`, 'success')
  } catch (error) {
    showNotice(error.message, 'error')
  } finally {
    setBusy(button, false, '创建中…', '创建')
  }
})

document.querySelector('#rename-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!renameItem) return
  const button = event.currentTarget.querySelector('button[type="submit"]')
  const name = document.querySelector('#rename-name').value.trim()
  setBusy(button, true, '保存中…', '保存名称')
  try {
    await apiJson('/api/storage-rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storageId: activeStorageId, id: renameItem.id, parentId: currentFolderId, name }),
    })
    renameDialog.close()
    renameItem = null
    await loadDirectory()
    showNotice(`已重命名为「${name}」。`, 'success')
  } catch (error) {
    showNotice(error.message, 'error')
  } finally {
    setBusy(button, false, '保存中…', '保存名称')
  }
})

document.querySelector('#delete-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!deleteItem) return
  const button = event.currentTarget.querySelector('button[type="submit"]')
  const name = deleteItem.name
  setBusy(button, true, '处理中…', '移到回收站')
  try {
    await apiJson('/api/storage-trash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storageId: activeStorageId, id: deleteItem.id, parentId: currentFolderId }),
    })
    deleteDialog.close()
    deleteItem = null
    await loadDirectory()
    showNotice(`「${name}」已移到回收站。`, 'success')
  } catch (error) {
    showNotice(error.message, 'error')
  } finally {
    setBusy(button, false, '处理中…', '移到回收站')
  }
})

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const passwordInput = document.querySelector('#admin-password')
  const button = event.currentTarget.querySelector('button[type="submit"]')
  setBusy(button, true, '验证中…', '进入后台')
  try {
    await apiJson('/api/admin-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: passwordInput.value }),
    })
    passwordInput.value = ''
    loginPanel.hidden = true
    dashboard.hidden = false
    await loadDashboard()
  } catch (error) {
    passwordInput.value = ''
    showNotice(error.message, 'error')
  } finally {
    setBusy(button, false, '验证中…', '进入后台')
  }
})

document.querySelector('#admin-password-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  const button = form.querySelector('button[type="submit"]')
  const currentPassword = document.querySelector('#current-admin-password').value
  const newPassword = document.querySelector('#new-admin-password').value
  const confirmPassword = document.querySelector('#confirm-admin-password').value
  setBusy(button, true, '更新中…', '更新管理员密码')

  try {
    await apiJson('/api/admin-change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
    })
    dashboard.hidden = true
    loginPanel.hidden = false
    showNotice('管理员密码已更新，请使用新密码重新登录。', 'success')
  } catch (error) {
    showNotice(error.message, 'error')
  } finally {
    form.reset()
    setBusy(button, false, '更新中…', '更新管理员密码')
  }
})

document.querySelector('#logout-button').addEventListener('click', async () => {
  try {
    await apiJson('/api/admin-logout', { method: 'POST' })
  } finally {
    dashboard.hidden = true
    loginPanel.hidden = false
    storageReady = false
    currentFolderId = ''
    currentItems = []
    folderStack = [{ id: '', name: '根目录' }]
    showNotice('已退出管理后台。', 'success')
  }
})

async function initialize() {
  loginPanel.hidden = true
  dashboard.hidden = true
  try {
    await apiJson('/api/admin-session')
    dashboard.hidden = false
    await loadDashboard()
  } catch (error) {
    loginPanel.hidden = false
    if (error.code === 'admin_auth_not_configured') {
      showNotice('后台尚未启用：请先配置 ADMIN_PASSWORD。', 'error')
    } else if (error.status === 401) {
      showNotice('请使用管理员密码登录。')
    } else {
      showNotice(error.message, 'error')
    }
  }
}

initialize()

document.querySelector('#add-storage-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget, button = form.querySelector('button[type="submit"]')
  const data = new FormData(form), accessToken = data.get('accessToken')
  button.disabled = true
  try {
    await apiJson('/api/admin-storages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add', storageId: data.get('storageId'), provider: data.get('provider'), displayName: data.get('displayName'), ...(accessToken ? { accessToken } : {}) }) })
    form.reset(); await loadStorageProviders(); showNotice('存储实例已添加。', 'success')
  } catch (error) { showNotice(error.message, 'error') } finally { button.disabled = false }
})
