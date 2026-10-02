import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import CloudStoragePage from '../../src/components/CloudStoragePage.vue'

const providers = {
  ok: true,
  defaultStorageId: 'pikpak-main',
  providers: [
    { id: 'pikpak-main', name: 'PikPak', provider: 'pikpak', selectable: true, capabilities: { list: true } },
    { id: 'quark-main', name: '夸克网盘', provider: 'quark', selectable: true, capabilities: { list: true } },
  ],
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

function folder(id, name, parentId = '') {
  return { id, name, parentId, isFolder: true, kind: 'drive#folder', writable: true, access: 'inherit', effectiveAccess: 'public' }
}

function file(id, name, parentId = '') {
  return { id, name, parentId, isFolder: false, kind: 'drive#file', extension: 'txt', size: 3, writable: true }
}

async function waitFor(assertion) {
  await vi.waitFor(assertion, { timeout: 2000 })
  await flushPromises()
}

describe('CloudStoragePage directory loading', () => {
  let requests
  let wrapper
  let originalFetch
  let originalLocation

  beforeEach(() => {
    requests = []
    originalFetch = globalThis.fetch
    originalLocation = window.location.href
    window.requestIdleCallback = () => 0
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(input, location.href)
      if (url.pathname === '/api/storage-providers') return jsonResponse(providers)
      if (url.pathname === '/api/storage-about') return jsonResponse({ ok: true, storageId: url.searchParams.get('storageId'), status: 'connected', quota: { total: 100, used: 40, free: 60 } })
      if (url.pathname !== '/api/storage-files') throw new Error(`Unexpected API request: ${url.pathname}`)
      const requested = url.searchParams.get('storageId') || 'pikpak-main'
      const parentId = url.searchParams.get('parentId') || ''
      const pageToken = url.searchParams.get('pageToken') || ''
      requests.push({ storageId: requested, parentId, pageToken })
      if (requested === 'pikpak-main' && !parentId) {
        return jsonResponse({ ok: true, storageId: requested, items: [folder('photos', '图片'), file('root-doc', 'readme.txt')] })
      }
      if (requested === 'pikpak-main' && parentId === 'photos') {
        return jsonResponse({ ok: true, storageId: requested, items: [folder('nested', '二级目录', 'photos'), { ...file('photo', 'photo.jpg', 'photos'), extension: 'jpg' }, { ...file('raw-photo', 'camera.dng', 'photos'), extension: 'dng' }] })
      }
      if (requested === 'pikpak-main' && parentId === 'nested') return jsonResponse({ ok: true, storageId: requested, items: [{ ...file('deep-pdf', 'report.pdf', 'nested'), extension: 'pdf' }] })
      if (requested === 'quark-main' && !parentId && !pageToken) {
        return jsonResponse({
          ok: true, storageId: requested, items: [folder('quark-folder', 'Quark 文件夹')],
          nextPageToken: 'next', nextRequestDelayMs: 10,
        })
      }
      if (requested === 'quark-main' && pageToken === 'next') return jsonResponse({ ok: true, storageId: requested, items: [folder('stale-folder', '过期结果')] })
      return jsonResponse({ ok: true, storageId: requested, items: [] })
    })
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    globalThis.fetch = originalFetch
    window.history.replaceState(null, '', originalLocation)
    delete window.requestIdleCallback
  })

  it('automatically indexes two folder levels and uses the complete tree for categories and recent files', async () => {
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.ocean-data-note').text()).toContain('覆盖当前有权限读取的目录'))
    expect(requests).toEqual(expect.arrayContaining([
      { storageId: 'pikpak-main', parentId: '', pageToken: '' },
      { storageId: 'pikpak-main', parentId: 'photos', pageToken: '' },
      { storageId: 'pikpak-main', parentId: 'nested', pageToken: '' },
    ]))
    expect(wrapper.text()).toContain('report.pdf')
    expect(wrapper.text()).toContain('photo.jpg')
    expect(wrapper.text()).toContain('camera.dng')
    expect(wrapper.find('.ocean-category-card[aria-label^="相册"]').attributes('aria-label')).toContain('2 项')
    expect(wrapper.find('.ocean-category-card[aria-label^="文档"]').attributes('aria-label')).toContain('1 项')
    expect(globalThis.fetch.mock.calls.some(([input]) => new URL(input, location.href).pathname === '/api/storage-about')).toBe(true)
    expect(wrapper.find('.background-video').attributes('preload')).toBe('none')
    expect([...wrapper.find('.background-video').element.querySelectorAll('source')].every((source) => !source.hasAttribute('src'))).toBe(true)
  })

  it('uses already indexed directory data when the user opens a folder', async () => {
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.ocean-data-note').text()).toContain('覆盖当前有权限读取的目录'))
    const requestCount = requests.length
    await wrapper.find('.ocean-nav--main .ocean-nav-item').trigger('click')
    await waitFor(() => expect(wrapper.find('.folder-open').exists()).toBe(true))
    await wrapper.find('.folder-open').trigger('click')
    await waitFor(() => expect(wrapper.text()).toContain('photo.jpg'))
    const rawPhoto = wrapper.findAll('.file-open').find(button => button.attributes('aria-label') === '预览 camera.dng')
    expect(rawPhoto).toBeTruthy()
    await rawPhoto.trigger('click')
    expect(wrapper.find('.preview-overlay').text()).toContain('这个格式暂不支持站内预览')
    expect(requests).toHaveLength(requestCount)
  })

  it('filters loaded files and folders locally without another directory request', async () => {
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.ocean-data-note').text()).toContain('覆盖当前有权限读取的目录'))
    await wrapper.find('.ocean-nav--main .ocean-nav-item').trigger('click')
    await waitFor(() => expect(wrapper.find('.folder-open').exists()).toBe(true))
    const folderTab = wrapper.findAll('.ocean-file-category-tabs [role="tab"]').find((tab) => tab.text() === '文件夹')
    await folderTab.trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.folder-open')).toHaveLength(1)
    expect(wrapper.find('.file-row').exists()).toBe(false)
    expect(requests.length).toBeGreaterThan(1)
  })

  it('walks every root and child pagination page before marking the tree complete', async () => {
    requests = []
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(input, location.href)
      if (url.pathname === '/api/storage-providers') return jsonResponse(providers)
      if (url.pathname === '/api/storage-about') return jsonResponse({ ok: true, storageId: url.searchParams.get('storageId'), status: 'connected', quota: { total: 100, used: 25, free: 75 } })
      const storageId = url.searchParams.get('storageId') || 'pikpak-main'
      const parentId = url.searchParams.get('parentId') || ''
      const pageToken = url.searchParams.get('pageToken') || ''
      requests.push({ storageId, parentId, pageToken })
      if (!parentId && !pageToken) return jsonResponse({ ok: true, storageId, items: [folder('root-a', '根目录 A')], nextPageToken: 'root-page-2', nextRequestDelayMs: 3 })
      if (!parentId && pageToken === 'root-page-2') return jsonResponse({ ok: true, storageId, items: [{ ...file('root-video', 'root.mp4'), extension: 'mp4' }, folder('root-b', '根目录 B')] })
      if (parentId === 'root-a' && !pageToken) return jsonResponse({ ok: true, storageId, items: [folder('nested-a', '嵌套目录')], nextPageToken: 'folder-page-2', nextRequestDelayMs: 3 })
      if (parentId === 'root-a' && pageToken === 'folder-page-2') return jsonResponse({ ok: true, storageId, items: [{ ...file('page-file', 'page-two.pdf', 'root-a'), extension: 'pdf' }] })
      if (parentId === 'nested-a') return jsonResponse({ ok: true, storageId, items: [{ ...file('deep-image', 'deep.jpg', 'nested-a'), extension: 'jpg' }] })
      if (parentId === 'root-b') return jsonResponse({ ok: true, storageId, items: [{ ...file('other-file', 'other.pdf', 'root-b'), extension: 'pdf' }] })
      return jsonResponse({ ok: true, storageId, items: [] })
    })
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.ocean-data-note').text()).toContain('覆盖当前有权限读取的目录'))
    for (const parentId of ['', 'root-a', 'nested-a', 'root-b']) {
      expect(requests.some((request) => request.parentId === parentId && request.pageToken === '')).toBe(true)
    }
    expect(requests).toContainEqual({ storageId: 'pikpak-main', parentId: '', pageToken: 'root-page-2' })
    expect(requests).toContainEqual({ storageId: 'pikpak-main', parentId: 'root-a', pageToken: 'folder-page-2' })
    expect(wrapper.text()).toContain('page-two.pdf')
    expect(wrapper.text()).toContain('deep.jpg')
    expect(wrapper.text()).toContain('other.pdf')
    expect(wrapper.find('.ocean-category-card[aria-label^="视频"]').attributes('aria-label')).toContain('1 项')
  })

  it('keeps Quark directory scans serial if root data beats the provider list', async () => {
    let resolveProviders
    let activeChildren = 0
    let maxConcurrentChildren = 0
    let completedChildren = 0
    const providersPending = new Promise(resolve => { resolveProviders = resolve })
    window.history.replaceState(null, '', '/?storageId=quark-main')
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(input, location.href)
      if (url.pathname === '/api/storage-providers') return providersPending
      if (url.pathname === '/api/storage-about') return jsonResponse({ ok: true, storageId: 'quark-main', status: 'connected', quota: null })
      if (url.pathname !== '/api/storage-files') throw new Error(`Unexpected API request: ${url.pathname}`)
      const parentId = url.searchParams.get('parentId') || ''
      if (!parentId) return jsonResponse({ ok: true, storageId: 'quark-main', items: [folder('q1', '夸克目录一'), folder('q2', '夸克目录二'), folder('q3', '夸克目录三')] })
      activeChildren += 1
      maxConcurrentChildren = Math.max(maxConcurrentChildren, activeChildren)
      await new Promise(resolve => setTimeout(resolve, 5))
      activeChildren -= 1
      completedChildren += 1
      return jsonResponse({ ok: true, storageId: 'quark-main', items: [file(`file-${parentId}`, `${parentId}.txt`, parentId)] })
    })
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(completedChildren).toBe(3))
    expect(maxConcurrentChildren).toBe(1)
    resolveProviders(jsonResponse({ ...providers, defaultStorageId: 'quark-main' }))
    await waitFor(() => expect(globalThis.fetch.mock.calls.some(([input]) => new URL(input, location.href).pathname === '/api/storage-about')).toBe(true))
  })

  it('routes locked folders through storage-files and excludes their contents from home data', async () => {
    requests = []
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(input, location.href)
      if (url.pathname === '/api/storage-providers') return jsonResponse(providers)
      if (url.pathname === '/api/storage-about') return jsonResponse({ ok: true, storageId: url.searchParams.get('storageId'), status: 'connected', quota: null })
      const storageId = url.searchParams.get('storageId') || 'pikpak-main'
      const parentId = url.searchParams.get('parentId') || ''
      requests.push({ storageId, parentId, pageToken: url.searchParams.get('pageToken') || '' })
      if (!parentId) return jsonResponse({ ok: true, storageId, items: [{ ...folder('private-folder', '私密文件夹'), access: 'locked', effectiveAccess: 'locked' }] })
      if (parentId === 'private-folder') return jsonResponse({ ok: false, error: 'authentication_required' }, 401)
      return jsonResponse({ ok: true, storageId, items: [{ ...file('secret-file', 'secret.mp4'), extension: 'mp4' }] })
    })
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.ocean-data-note').text()).toContain('覆盖当前有权限读取的目录'))
    expect(requests).toContainEqual({ storageId: 'pikpak-main', parentId: 'private-folder', pageToken: '' })
    expect(wrapper.text()).not.toContain('secret.mp4')
    expect(wrapper.find('.ocean-category-card[aria-label^="视频"]').attributes('aria-label')).toContain('0 项')
  })

  it('ignores a Quark page response that arrives after switching back to PikPak', async () => {
    let resolveQuarkNext
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(input, location.href)
      if (url.pathname === '/api/storage-providers') return jsonResponse(providers)
      if (url.pathname === '/api/storage-about') return jsonResponse({ ok: true, storageId: url.searchParams.get('storageId'), status: 'connected', quota: null })
      const requested = url.searchParams.get('storageId') || 'pikpak-main'
      const parentId = url.searchParams.get('parentId') || ''
      const pageToken = url.searchParams.get('pageToken') || ''
      requests.push({ storageId: requested, parentId, pageToken })
      if (requested === 'pikpak-main') return jsonResponse({ ok: true, storageId: requested, items: [folder('photos', '图片')] })
      if (!pageToken) return jsonResponse({ ok: true, storageId: requested, items: [folder('quark-folder', 'Quark 文件夹')], nextPageToken: 'next', nextRequestDelayMs: 5 })
      return new Promise((resolve) => { resolveQuarkNext = () => resolve(jsonResponse({ ok: true, storageId: requested, items: [folder('stale-folder', '过期结果')] })) })
    })
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('#cloud-storage-select').element.disabled).toBe(false))
    await wrapper.find('.ocean-nav--main .ocean-nav-item').trigger('click')
    await waitFor(() => expect(wrapper.find('.folder-open').exists()).toBe(true))
    await wrapper.find('#cloud-storage-select').setValue('quark-main')
    await waitFor(() => expect(wrapper.find('.ocean-recent-panel').exists()).toBe(true))
    await wrapper.find('.ocean-nav--main .ocean-nav-item').trigger('click')
    await waitFor(() => expect(requests.some((request) => request.storageId === 'quark-main' && request.pageToken === 'next')).toBe(true))
    await wrapper.find('#cloud-storage-select').setValue('pikpak-main')
    await wrapper.find('.ocean-nav--main .ocean-nav-item').trigger('click')
    await waitFor(() => expect(wrapper.text()).toContain('图片'))
    resolveQuarkNext()
    await flushPromises()
    expect(wrapper.text()).not.toContain('过期结果')
    expect(wrapper.find('#cloud-storage-select').element.value).toBe('pikpak-main')
  })

  it('retries the active account quota after cloud login succeeds', async () => {
    let loggedIn = false
    const aboutRequests = []
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(input, location.href)
      if (url.pathname === '/api/storage-providers') return jsonResponse(providers)
      if (url.pathname === '/api/storage-about') {
        aboutRequests.push(url.searchParams.get('storageId'))
        return loggedIn
          ? jsonResponse({ ok: true, storageId: 'pikpak-main', status: 'connected', quota: { total: 100, used: 40, free: 60 } })
          : jsonResponse({ ok: false, error: 'authentication_required' }, 401)
      }
      if (url.pathname === '/api/cloud-login') {
        loggedIn = true
        return jsonResponse({ ok: true })
      }
      if (url.pathname === '/api/storage-files') {
        return loggedIn
          ? jsonResponse({ ok: true, storageId: 'pikpak-main', items: [] })
          : jsonResponse({ ok: false, error: 'authentication_required' }, 401)
      }
      throw new Error(`Unexpected API request: ${url.pathname}`)
    })
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('#auth-title').text()).toBe('登录私人云盘'))
    await wrapper.find('[aria-label="云盘访问密码"]').setValue('test-password')
    await wrapper.find('.auth-form').trigger('submit')
    await waitFor(() => expect(wrapper.find('.ocean-quota-value').text()).toContain('40 B'))
    expect(aboutRequests).toEqual(['pikpak-main', 'pikpak-main'])
  })

  it('shows a friendly message when Quark is temporarily unreachable', async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(input, location.href)
      if (url.pathname === '/api/storage-providers') return jsonResponse(providers)
      const storageId = url.searchParams.get('storageId') || 'pikpak-main'
      if (url.pathname === '/api/storage-about') {
        if (storageId === 'quark-main') return jsonResponse({ ok: false, error: 'quark_unreachable' }, 502)
        return jsonResponse({ ok: true, storageId, status: 'connected', quota: null })
      }
      if (storageId === 'quark-main') return jsonResponse({ ok: false, error: 'quark_unreachable' }, 502)
      return jsonResponse({ ok: true, storageId, items: [] })
    })
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('#cloud-storage-select').element.disabled).toBe(false))
    await wrapper.find('#cloud-storage-select').setValue('quark-main')
    await waitFor(() => expect(wrapper.find('.ocean-alert').text()).toContain('夸克网盘暂时无法连接'))
    expect(wrapper.text()).not.toContain('quark_unreachable')
  })
})
