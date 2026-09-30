const notice = document.querySelector('#notice')
const loginPanel = document.querySelector('#login-panel')
const dashboard = document.querySelector('#dashboard')
const folderList = document.querySelector('#folder-list')
const globalAccess = document.querySelector('#global-access')
const saveGlobalButton = document.querySelector('#save-global')
const refreshButton = document.querySelector('#refresh-folders')
const folderSummary = document.querySelector('#folder-summary')
let savedGlobalAccess = 'locked'
let storageReady = false

function showNotice(message, kind = 'info') {
  notice.textContent = message
  notice.dataset.kind = kind
  notice.hidden = !message
}

async function apiJson(path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
    headers: { Accept: 'application/json', ...(options.headers || {}) },
    ...options,
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

function appendOption(select, value, label) {
  const option = document.createElement('option')
  option.value = value
  option.textContent = label
  select.append(option)
}

function accessLabel(value) {
  return value === 'locked' ? '上锁' : '公开'
}

function renderFolder(folder) {
  const card = document.createElement('article')
  card.className = 'folder-card'

  const top = document.createElement('div')
  top.className = 'folder-top'
  const nameWrap = document.createElement('div')
  const name = document.createElement('h3')
  name.className = 'folder-name'
  name.textContent = folder.name
  const crumb = document.createElement('p')
  crumb.className = 'folder-crumb'
  crumb.textContent = folder.depth ? `层级 ${folder.depth} · 父目录 ${folder.parentId || '根目录'}` : '根目录下的文件夹'
  nameWrap.append(name, crumb)

  const state = document.createElement('span')
  state.className = 'folder-state'
  state.dataset.access = folder.effectiveAccess
  state.textContent = `当前生效：${accessLabel(folder.effectiveAccess)}`
  top.append(nameWrap, state)

  const id = document.createElement('code')
  id.className = 'folder-id'
  id.textContent = `folderId: ${folder.id}`

  const openLink = document.createElement('a')
  openLink.className = 'folder-public-link'
  if (folder.access === 'public') {
    openLink.href = `/?folderId=${encodeURIComponent(folder.id)}`
    openLink.textContent = '打开公开目录链接'
    openLink.target = '_blank'
    openLink.rel = 'noopener noreferrer'
  }

  const fields = document.createElement('div')
  fields.className = 'folder-fields'
  const typeWrap = document.createElement('div')
  typeWrap.className = 'folder-field'
  const typeLabel = document.createElement('label')
  typeLabel.textContent = '类型'
  const type = document.createElement('select')
  typeLabel.append(type)
  appendOption(type, 'folder', '普通文件夹')
  appendOption(type, 'album', '相册')
  type.value = folder.type
  typeWrap.append(typeLabel)

  const accessWrap = document.createElement('div')
  accessWrap.className = 'folder-field'
  const accessLabelEl = document.createElement('label')
  accessLabelEl.textContent = '权限'
  const access = document.createElement('select')
  accessLabelEl.append(access)
  appendOption(access, 'inherit', '继承')
  appendOption(access, 'public', '公开')
  appendOption(access, 'locked', '上锁')
  access.value = folder.access
  accessWrap.append(accessLabelEl)

  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'primary-button folder-save'
  save.textContent = '保存此文件夹'
  save.disabled = !storageReady
  const original = { type: folder.type, access: folder.access }
  const syncSaveState = () => {
    save.disabled = !storageReady || (type.value === original.type && access.value === original.access)
  }
  type.addEventListener('change', syncSaveState)
  access.addEventListener('change', syncSaveState)
  save.addEventListener('click', async () => {
    save.disabled = true
    save.textContent = '保存中…'
    try {
      await apiJson('/api/admin-folder-metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: folder.id, type: type.value, access: access.value }),
      })
      await loadDashboard()
      showNotice(`已保存「${folder.name}」的类型和权限，并重新读取当前状态。`, 'success')
    } catch (error) {
      showNotice(error.message, 'error')
      save.textContent = '重试保存'
      syncSaveState()
    }
  })

  fields.append(typeWrap, accessWrap, save)
  card.append(top, id)
  if (folder.access === 'public') card.append(openLink)
  card.append(fields)
  return card
}

async function loadDashboard() {
  showNotice('正在读取管理配置和 PikPak 文件夹…')
  refreshButton.disabled = true
  saveGlobalButton.disabled = true
  folderList.replaceChildren()
  try {
    const [config, listing] = await Promise.all([
      apiJson('/api/admin-config'),
      apiJson('/api/admin-folders'),
    ])
    savedGlobalAccess = config.globalAccess
    globalAccess.value = config.globalAccess
    storageReady = Boolean(config.storageReady && listing.storageReady)
    folderSummary.textContent = `${listing.folders.length} 个文件夹 · 当前网盘访问：${config.globalAccess === 'locked' ? '上锁' : '公开'}`
    if (!storageReady) {
      showNotice('持久化存储尚未配置。请先创建 Upstash Redis REST 数据库，并在 Vercel 为 Production 配置 UPSTASH_REDIS_REST_URL 与 UPSTASH_REDIS_REST_TOKEN，然后部署一次；之后后台修改会即时生效，无需再次部署。', 'error')
    } else {
      showNotice('配置与 PikPak 文件夹已重新读取。')
    }
    if (!listing.folders.length) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.textContent = 'PikPak 当前没有可管理的文件夹。'
      folderList.append(empty)
    } else {
      listing.folders.forEach((folder) => folderList.append(renderFolder(folder)))
    }
  } catch (error) {
    if (error.status === 401) {
      dashboard.hidden = true
      loginPanel.hidden = false
      showNotice('请先使用独立管理员密码登录。', 'info')
    } else {
      showNotice(error.message, 'error')
    }
  } finally {
    refreshButton.disabled = false
    saveGlobalButton.disabled = !storageReady
  }
}

globalAccess.addEventListener('change', () => {
  saveGlobalButton.disabled = !storageReady || globalAccess.value === savedGlobalAccess
})

saveGlobalButton.addEventListener('click', async () => {
  saveGlobalButton.disabled = true
  saveGlobalButton.textContent = '保存中…'
  const next = globalAccess.value
  try {
    await apiJson('/api/admin-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ globalAccess: next }),
    })
    await loadDashboard()
    showNotice(`全局访问已改为「${next === 'locked' ? '上锁' : '公开'}」，并已重新读取当前状态。`, 'success')
  } catch (error) {
    globalAccess.value = savedGlobalAccess
    showNotice(error.message, 'error')
  } finally {
    saveGlobalButton.textContent = '保存全局设置'
    saveGlobalButton.disabled = !storageReady || globalAccess.value === savedGlobalAccess
  }
})

refreshButton.addEventListener('click', () => loadDashboard())

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const passwordInput = document.querySelector('#admin-password')
  const button = event.currentTarget.querySelector('button[type="submit"]')
  button.disabled = true
  showNotice('正在验证管理员密码…')
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
    button.disabled = false
  }
})

document.querySelector('#admin-password-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  const button = form.querySelector('button[type="submit"]')
  const currentPassword = document.querySelector('#current-admin-password').value
  const newPassword = document.querySelector('#new-admin-password').value
  const confirmPassword = document.querySelector('#confirm-admin-password').value
  button.disabled = true
  button.textContent = '正在更新…'

  try {
    await apiJson('/api/admin-change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
    })
    dashboard.hidden = true
    loginPanel.hidden = false
    showNotice('管理员密码已更新。旧的管理员会话已失效，请使用新密码重新登录。', 'success')
  } catch (error) {
    showNotice(error.message, 'error')
  } finally {
    form.reset()
    button.textContent = '更新管理员密码'
    button.disabled = false
  }
})

document.querySelector('#logout-button').addEventListener('click', async () => {
  try {
    await apiJson('/api/admin-logout', { method: 'POST' })
  } finally {
    dashboard.hidden = true
    loginPanel.hidden = false
    storageReady = false
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
      showNotice('后台尚未启用：请先在 Vercel 服务端配置 ADMIN_PASSWORD。', 'error')
    } else if (error.status === 401) {
      showNotice('请使用独立管理员密码登录。', 'info')
    } else {
      showNotice(error.message, 'error')
    }
  }
}

initialize()
