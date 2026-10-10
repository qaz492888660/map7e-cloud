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

function mediaFetch(items, rangeResult = { ok: true, rangeSupported: true, status: 206, acceptRanges: 'bytes', contentRange: 'bytes 0-0/1' }) {
  return vi.fn(async (input) => {
    const url = new URL(input, location.href)
    if (url.pathname === '/api/storage-providers') return jsonResponse(providers)
    if (url.pathname === '/api/storage-about') return jsonResponse({ ok: true, storageId: url.searchParams.get('storageId'), status: 'connected', quota: null })
    if (url.pathname === '/api/storage-files') return jsonResponse({ ok: true, storageId: url.searchParams.get('storageId') || 'pikpak-main', items })
    if (url.pathname === '/api/storage-download' && ['range', 'download'].includes(url.searchParams.get('check'))) {
      if (rangeResult instanceof Error) throw rangeResult
      return jsonResponse(rangeResult.body || rangeResult, rangeResult.statusCode || 200)
    }
    throw new Error(`Unexpected API request: ${url.pathname}`)
  })
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
    expect(wrapper.find('.photo-viewer').text()).toContain('该 RAW 格式暂无可用预览')
    expect(wrapper.find('.photo-viewer img.viewer-image').exists()).toBe(false)
    expect(wrapper.find('.photo-viewer a[aria-label^="下载原图"]').attributes('href')).toContain('/api/storage-download')
    expect(requests).toHaveLength(requestCount)
  })

  it('uses the Provider preview for RAW while keeping the original RAW URL for download', async () => {
    globalThis.fetch = mediaFetch([{
      ...file('raw-preview', 'camera.dng'), extension: 'dng', previewAvailable: true, modifiedAt: '2026-10-02T01:00:00Z',
    }])
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.ocean-data-note').text()).toContain('覆盖当前有权限读取的目录'))
    await wrapper.find('.ocean-nav--main .ocean-nav-item').trigger('click')
    const raw = wrapper.find('button[aria-label="预览 camera.dng"]')
    await raw.trigger('click')
    const image = wrapper.find('.photo-viewer img.viewer-image')
    expect(image.exists()).toBe(true)
    expect(image.attributes('src')).toContain('/api/storage-preview?')
    expect(image.attributes('src')).toContain('variant=preview')
    expect(image.attributes('src')).not.toContain('.dng')
    expect(wrapper.find('.photo-viewer').text()).toContain('RAW 预览')
    const originalDownload = wrapper.find('.photo-viewer a[aria-label^="下载原图"]')
    expect(originalDownload.attributes('href')).toContain('/api/storage-download')
    expect(originalDownload.attributes('href')).toContain('id=raw-preview')
    expect(originalDownload.attributes('download')).toBe('camera.dng')
  })

  it('keeps JPG in the normal image viewer and loads its original only after opening it', async () => {
    globalThis.fetch = mediaFetch([{ ...file('jpg-file', 'photo.jpg'), extension: 'jpg' }])
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.ocean-data-note').text()).toContain('覆盖当前有权限读取的目录'))
    await wrapper.find('.ocean-nav--main .ocean-nav-item').trigger('click')
    await wrapper.find('button[aria-label="预览 photo.jpg"]').trigger('click')
    const imageSrc = wrapper.find('.photo-viewer img.viewer-image').attributes('src')
    expect(imageSrc).toContain('/api/storage-download')
    expect(new URL(imageSrc, location.href).searchParams.get('inline')).toBeNull()
    expect(wrapper.find('.photo-viewer img.viewer-image').attributes('src')).not.toContain('/api/storage-preview')
  })

  it('requests Quark JPG inline for image rendering', async () => {
    const url = new URL(window.location.href)
    url.searchParams.set('storageId', 'quark-main')
    window.history.replaceState(null, '', url.pathname + url.search)
    globalThis.fetch = mediaFetch([{ ...file('quark-jpg', 'photo.jpg'), extension: 'jpg' }])
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.ocean-data-note').text()).toContain('覆盖当前有权限读取的目录'))
    await wrapper.find('.ocean-nav--main .ocean-nav-item').trigger('click')
    await wrapper.find('button[aria-label="预览 photo.jpg"]').trigger('click')

    const imageSrc = wrapper.find('.photo-viewer img.viewer-image').attributes('src')
    expect(new URL(imageSrc, location.href).searchParams.get('inline')).toBe('1')
  })

  it('opens Quark PDFs inline while keeping the toolbar download as an attachment', async () => {
    const url = new URL(window.location.href)
    url.searchParams.set('storageId', 'quark-main')
    window.history.replaceState(null, '', url.pathname + url.search)
    globalThis.fetch = mediaFetch([{ ...file('pdf-file', 'report.pdf'), extension: 'pdf' }])
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.ocean-data-note').text()).toContain('覆盖当前有权限读取的目录'))
    await wrapper.find('.ocean-nav--main .ocean-nav-item').trigger('click')
    await wrapper.find('button[aria-label="预览 report.pdf"]').trigger('click')

    const preview = wrapper.find('.pdf-preview')
    const download = wrapper.find('.preview-header a[download="report.pdf"]')
    expect(preview.exists()).toBe(true)
    expect(new URL(preview.attributes('src'), location.href).searchParams.get('inline')).toBe('1')
    expect(new URL(download.attributes('href'), location.href).searchParams.get('inline')).toBeNull()
  })

  it('keeps a 30 GB video on the direct download URL after a successful Range check', async () => {
    const fetch = mediaFetch([{ ...file('huge-video', 'archive.mp4'), extension: 'mp4', type: 'video', size: 30 * 1024 ** 3 }])
    globalThis.fetch = fetch
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.ocean-data-note').text()).toContain('覆盖当前有权限读取的目录'))
    await wrapper.find('.ocean-nav--main .ocean-nav-item').trigger('click')
    await wrapper.find('button[aria-label="预览 archive.mp4"]').trigger('click')
    await waitFor(() => expect(wrapper.find('.file-video-preview').exists()).toBe(true))
    const video = wrapper.find('.file-video-preview')
    expect(video.attributes('src')).toContain('/api/storage-download')
    expect(video.attributes('preload')).toBe('metadata')
    expect(video.attributes('controls')).toBeDefined()
    expect(video.attributes('crossorigin')).toBeUndefined()
    expect(fetch.mock.calls.some(([input]) => {
      const url = new URL(input, location.href)
      return url.pathname === '/api/storage-download' && url.searchParams.get('check') === 'range'
    })).toBe(true)
    expect(wrapper.find('.file-video-preview').attributes('src')).not.toContain('storage-preview')
  })

  it('uses credentialed CORS for Quark video Range requests', async () => {
    window.history.replaceState(null, '', '/?storageId=quark-main')
    globalThis.fetch = mediaFetch([{ ...file('quark-video', 'quark.mp4'), extension: 'mp4', type: 'video', size: 809 * 1024 ** 2 }])
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.ocean-data-note').text()).toContain('覆盖当前有权限读取的目录'))
    await wrapper.find('.ocean-nav--main .ocean-nav-item').trigger('click')
    await wrapper.find('button[aria-label="预览 quark.mp4"]').trigger('click')
    await waitFor(() => expect(wrapper.find('.file-video-preview').exists()).toBe(true))
    expect(wrapper.find('.file-video-preview').attributes('crossorigin')).toBe('use-credentials')
  })

  async function openDeferredVideos() {
    const items = ['a', 'b'].map(id => ({ ...file(id, id + '.mp4'), extension: 'mp4', type: 'video', size: 1024 }))
    const ordinaryFetch = mediaFetch(items)
    const pending = []
    globalThis.fetch = vi.fn((input, options = {}) => {
      if (new URL(input, location.href).searchParams.get('check') === 'range') {
        return new Promise((resolve, reject) => pending.push({ resolve, reject, signal: options.signal }))
      }
      return ordinaryFetch(input, options)
    })
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.ocean-data-note').text()).toContain('覆盖当前有权限读取的目录'))
    await wrapper.find('.ocean-nav--main .ocean-nav-item').trigger('click')
    await wrapper.find('button[aria-label="预览 a.mp4"]').trigger('click')
    return pending
  }

  it.each(['late 422', 'late rejection', 'late success'])('video probe generation: ignores %s from a closed video after opening another', async kind => {
    const pending = await openDeferredVideos()
    await wrapper.find('button[aria-label="关闭文件预览"]').trigger('click')
    expect(pending[0].signal.aborted).toBe(true)
    await wrapper.find('button[aria-label="预览 b.mp4"]').trigger('click')
    pending[1].resolve(jsonResponse({ ok: true, rangeSupported: true }))
    await flushPromises()
    if (kind === 'late rejection') pending[0].reject(new TypeError('network failed'))
    else pending[0].resolve(kind === 'late 422'
      ? jsonResponse({ ok: false, error: 'quark_file_size_limit', limitBytes: 52428800 }, 422)
      : jsonResponse({ ok: true, rangeSupported: false }))
    await flushPromises()
    expect(wrapper.find('.preview-heading').text()).toContain('b.mp4')
    expect(wrapper.find('.file-video-preview').exists()).toBe(true)
    expect(wrapper.find('.preview-message').exists()).toBe(false)
    expect(wrapper.find('.preview-overlay a[download="b.mp4"]').exists()).toBe(true)
  })

  it('video probe generation: stale finally cannot clear the new probe loading state', async () => {
    const pending = await openDeferredVideos()
    await wrapper.find('button[aria-label="关闭文件预览"]').trigger('click')
    await wrapper.find('button[aria-label="预览 b.mp4"]').trigger('click')
    pending[0].reject(new TypeError('late abort'))
    await flushPromises()
    expect(wrapper.find('.preview-message').text()).toContain('正在检查视频流')
    expect(wrapper.find('.file-video-preview').exists()).toBe(false)
    pending[1].resolve(jsonResponse({ ok: false, error: 'quark_file_size_limit', limitBytes: 52428800 }, 422))
    await flushPromises()
    expect(wrapper.find('.preview-message').text()).toContain('50 MiB')
  })

  it('video probe generation: reopening the same file does not accept its old response', async () => {
    const pending = await openDeferredVideos()
    await wrapper.find('button[aria-label="关闭文件预览"]').trigger('click')
    await wrapper.find('button[aria-label="预览 a.mp4"]').trigger('click')
    pending[1].resolve(jsonResponse({ ok: true, rangeSupported: true }))
    await flushPromises()
    pending[0].resolve(jsonResponse({ ok: false, error: 'quark_file_size_limit', limitBytes: 52428800 }, 422))
    await flushPromises()
    expect(wrapper.find('.file-video-preview').exists()).toBe(true)
    expect(wrapper.find('.preview-overlay a[download="a.mp4"]').exists()).toBe(true)
  })

  it('video probe generation: closing aborts the probe and late results do not reopen preview', async () => {
    const pending = await openDeferredVideos()
    await wrapper.find('button[aria-label="关闭文件预览"]').trigger('click')
    pending[0].resolve(jsonResponse({ ok: false, error: 'quark_file_size_limit', limitBytes: 52428800 }, 422))
    await flushPromises()
    expect(pending[0].signal.aborted).toBe(true)
    expect(wrapper.find('.preview-overlay').exists()).toBe(false)
  })

  it('video probe generation: displays an explicit shared-deadline timeout message', async () => {
    const pending = await openDeferredVideos()
    pending[0].resolve(jsonResponse({ ok: false, error: 'storage_range_probe_timeout' }, 504))
    await flushPromises()
    expect(wrapper.find('.preview-message').text()).toContain('视频分段读取检查超时')
    expect(wrapper.find('.file-video-preview').exists()).toBe(false)
    expect(wrapper.find('.preview-overlay a[download="a.mp4"]').exists()).toBe(true)
  })

  it('shows the Provider Range limitation and keeps the original download available', async () => {
    globalThis.fetch = mediaFetch([{ ...file('no-range', 'large.mp4'), extension: 'mp4', type: 'video', size: 30 * 1024 ** 3 }], {
      ok: true, rangeSupported: false, status: 200, acceptRanges: null, contentRange: null,
    })
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.ocean-data-note').text()).toContain('覆盖当前有权限读取的目录'))
    await wrapper.find('.ocean-nav--main .ocean-nav-item').trigger('click')
    await wrapper.find('button[aria-label="预览 large.mp4"]').trigger('click')
    await waitFor(() => expect(wrapper.find('.preview-overlay').text()).toContain('未提供有效的 Range 分段读取'))
    expect(wrapper.find('.file-video-preview').exists()).toBe(false)
    expect(wrapper.find('.preview-overlay a[download="large.mp4"]').attributes('href')).toContain('/api/storage-download')
  })

  it('shows the explicit Quark 50 MiB policy without offering a failing playback or download retry', async () => {
    window.history.replaceState(null, '', '/?storageId=quark-main')
    const fetch = mediaFetch([{ ...file('limited-video', '07(1).mp4'), extension: 'mp4', type: 'video', size: 848086961 }], {
      statusCode: 422, body: { ok: false, error: 'quark_file_size_limit', limitBytes: 52428800 },
    })
    globalThis.fetch = fetch
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.ocean-data-note').text()).toContain('覆盖当前有权限读取的目录'))
    await wrapper.find('.ocean-nav--main .ocean-nav-item').trigger('click')
    await wrapper.find('button[aria-label="预览 07(1).mp4"]').trigger('click')
    await waitFor(() => expect(wrapper.find('.preview-overlay').text()).toContain('当前夸克接口限制单文件下载大小为 50 MiB，此文件暂不支持站内播放或下载。'))
    expect(wrapper.find('.file-video-preview').exists()).toBe(false)
    expect(wrapper.find('.preview-overlay a[download]').exists()).toBe(false)
    expect(wrapper.find('.preview-overlay').text()).not.toContain('重试')
    await flushPromises()
    expect(fetch.mock.calls.filter(([input]) => new URL(input, location.href).searchParams.get('check') === 'range')).toHaveLength(1)
  })

  it('checks large Quark downloads and keeps the file list, categories and search available after rejection', async () => {
    window.history.replaceState(null, '', '/?storageId=quark-main')
    const fetch = mediaFetch([{ ...file('limited-download', '07(1).mp4'), extension: 'mp4', type: 'video', size: 848086961 }], {
      statusCode: 422, body: { ok: false, error: 'quark_file_size_limit', limitBytes: 52428800 },
    })
    globalThis.fetch = fetch
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.ocean-data-note').text()).toContain('覆盖当前有权限读取的目录'))
    await wrapper.find('.ocean-nav--main .ocean-nav-item').trigger('click')
    await wrapper.find('button[aria-label="文件操作：07(1).mp4"]').trigger('click')
    await wrapper.find('a.sheet-action[download="07(1).mp4"]').trigger('click')
    await waitFor(() => expect(wrapper.text()).toContain('当前夸克接口限制单文件下载大小为 50 MiB，此文件暂不支持站内播放或下载。'))
    expect(wrapper.find('button[aria-label="预览 07(1).mp4"]').exists()).toBe(true)
    expect(wrapper.find('.ocean-file-category-tabs').exists()).toBe(true)
    expect(wrapper.find('input[type="search"]').exists()).toBe(true)
    expect(fetch.mock.calls.filter(([input]) => new URL(input, location.href).searchParams.get('check') === 'download')).toHaveLength(1)
  })

  it.each([
    ['large JPG', 'jpg', 60 * 1024 ** 2, false],
    ['unknown-size JPG', 'jpg', null, false],
    ['RAW without preview', 'dng', null, false],
    ['RAW with preview', 'dng', 60 * 1024 ** 2, true],
  ])('suppresses limited Quark photo retries for %s', async (_label, extension, size, previewAvailable) => {
    window.history.replaceState(null, '', '/?storageId=quark-main')
    const name = `limited.${extension}`
    const fetch = mediaFetch([{ ...file('limited-photo', name), extension, size, previewAvailable }], {
      statusCode: 422, body: { ok: false, error: 'quark_file_size_limit', limitBytes: 52428800 },
    })
    globalThis.fetch = fetch
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.ocean-data-note').text()).toContain('覆盖当前有权限读取的目录'))
    await wrapper.find('.ocean-nav--main .ocean-nav-item').trigger('click')
    await wrapper.find(`button[aria-label="预览 ${name}"]`).trigger('click')
    const image = wrapper.find('.photo-viewer img.viewer-image')
    if (image.exists()) await image.trigger('error')
    const toolbarDownload = wrapper.find('.photo-viewer a[aria-label^="下载原图"]')
    const fallbackDownload = wrapper.find('.photo-viewer a.primary-download')
    await toolbarDownload.trigger('click')
    await waitFor(() => expect(wrapper.find('.photo-viewer').text()).toContain('当前夸克接口限制单文件下载大小为 50 MiB'))
    expect(wrapper.find('.photo-viewer a[download]').exists()).toBe(false)
    await toolbarDownload.trigger('click')
    await fallbackDownload.trigger('click')
    if (image.exists()) {
      await image.trigger('load')
      await image.trigger('error')
    }
    expect(wrapper.find('.photo-viewer').text()).toContain('当前夸克接口限制单文件下载大小为 50 MiB')
    expect(wrapper.find('.photo-viewer a[download]').exists()).toBe(false)
    expect(fetch.mock.calls.filter(([input]) => new URL(input, location.href).searchParams.get('check') === 'download')).toHaveLength(1)
  })

  it('clears a Quark photo refusal when navigating to a different photo', async () => {
    window.history.replaceState(null, '', '/?storageId=quark-main')
    const fetch = mediaFetch([
      { ...file('limited-photo', 'limited.jpg'), extension: 'jpg', size: 60 * 1024 ** 2 },
      { ...file('other-photo', 'other.jpg'), extension: 'jpg', size: 2245317 },
    ], { statusCode: 422, body: { ok: false, error: 'quark_file_size_limit', limitBytes: 52428800 } })
    globalThis.fetch = fetch
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.ocean-data-note').text()).toContain('覆盖当前有权限读取的目录'))
    await wrapper.findAll('.ocean-nav--main .ocean-nav-item').find(button => button.text() === '相册').trigger('click')
    await wrapper.find('button[aria-label="查看图片 limited.jpg"]').trigger('click')
    await wrapper.find('.photo-viewer a[download]').trigger('click')
    await waitFor(() => expect(wrapper.find('.photo-viewer a[download]').exists()).toBe(false))
    await wrapper.find('button[aria-label="下一张"]').trigger('click')
    const download = wrapper.find('.photo-viewer a[download="other.jpg"]')
    expect(download.exists()).toBe(true)
    let preventedByApplication
    download.element.addEventListener('click', event => {
      preventedByApplication = event.defaultPrevented
      event.preventDefault()
    })
    await download.trigger('click')
    expect(preventedByApplication).toBe(false)
    expect(wrapper.find('.photo-viewer').text()).not.toContain('当前夸克接口限制单文件下载大小为 50 MiB')
    expect(fetch.mock.calls.filter(([input]) => new URL(input, location.href).searchParams.get('check') === 'download')).toHaveLength(1)
  })

  it('allows Quark photo download retries after a transient upstream error', async () => {
    window.history.replaceState(null, '', '/?storageId=quark-main')
    const fetch = mediaFetch([{ ...file('retry-photo', 'retry.jpg'), extension: 'jpg', size: null }], {
      statusCode: 504, body: { ok: false, error: 'quark_media_headers_timeout' },
    })
    globalThis.fetch = fetch
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.ocean-data-note').text()).toContain('覆盖当前有权限读取的目录'))
    await wrapper.find('.ocean-nav--main .ocean-nav-item').trigger('click')
    await wrapper.find('button[aria-label="预览 retry.jpg"]').trigger('click')
    await wrapper.find('.photo-viewer a[download]').trigger('click')
    await waitFor(() => expect(wrapper.find('.photo-viewer').text()).toContain('获取网盘下载地址失败，请稍后重试'))
    expect(wrapper.find('.photo-viewer a[aria-label^="下载原图"]').exists()).toBe(true)
    await wrapper.find('.photo-viewer a.primary-download').trigger('click')
    await flushPromises()
    expect(fetch.mock.calls.filter(([input]) => new URL(input, location.href).searchParams.get('check') === 'download')).toHaveLength(2)
  })

  it.each([
    ['quark-main', { ...file('small-original', 'photo.jpg'), extension: 'jpg', size: 2245317 }],
    ['pikpak-main', { ...file('pikpak-large', 'large.mp4'), extension: 'mp4', type: 'video', size: 848086961 }],
  ])('preserves ordinary downloads for %s without adding a Quark Range preflight', async (storageId, item) => {
    window.history.replaceState(null, '', '/?storageId=' + storageId)
    const fetch = mediaFetch([item])
    globalThis.fetch = fetch
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.ocean-data-note').text()).toContain('覆盖当前有权限读取的目录'))
    await wrapper.find('.ocean-nav--main .ocean-nav-item').trigger('click')
    await wrapper.find(`button[aria-label="文件操作：${item.name}"]`).trigger('click')
    const download = wrapper.find(`a.sheet-action[download="${item.name}"]`)
    let preventedByApplication
    download.element.addEventListener('click', event => {
      preventedByApplication = event.defaultPrevented
      event.preventDefault() // JSDOM does not navigate or download files.
    })
    await download.trigger('click')
    expect(preventedByApplication).toBe(false)
    expect(fetch.mock.calls.some(([input]) => new URL(input, location.href).searchParams.get('check') === 'range')).toBe(false)
  })

  it('shows a format fallback when the browser cannot decode the video', async () => {
    globalThis.fetch = mediaFetch([{ ...file('unsupported-video', 'movie.mkv'), extension: 'mkv', type: 'video', mimeType: 'video/x-matroska' }])
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.ocean-data-note').text()).toContain('覆盖当前有权限读取的目录'))
    await wrapper.find('.ocean-nav--main .ocean-nav-item').trigger('click')
    await wrapper.find('button[aria-label="预览 movie.mkv"]').trigger('click')
    await waitFor(() => expect(wrapper.find('.file-video-preview').exists()).toBe(true))
    Object.defineProperty(wrapper.find('.file-video-preview').element, 'error', { configurable: true, value: { code: 4 } })
    await wrapper.find('.file-video-preview').trigger('error')
    expect(wrapper.find('.preview-overlay').text()).toContain('当前视频格式或编码不支持网页播放')
    expect(wrapper.find('.preview-overlay a[download="movie.mkv"]').exists()).toBe(true)
  })

  it('distinguishes a download URL error from a network error before video playback', async () => {
    globalThis.fetch = mediaFetch([{ ...file('missing-video', 'missing.mp4'), extension: 'mp4', type: 'video' }], {
      statusCode: 502, body: { ok: false, error: 'download_link_unavailable' },
    })
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.ocean-data-note').text()).toContain('覆盖当前有权限读取的目录'))
    await wrapper.find('.ocean-nav--main .ocean-nav-item').trigger('click')
    await wrapper.find('button[aria-label="预览 missing.mp4"]').trigger('click')
    await waitFor(() => expect(wrapper.find('.preview-overlay').text()).toContain('获取网盘播放地址失败'))
    expect(wrapper.find('.preview-overlay').text()).toContain('获取网盘播放地址失败')
    expect(wrapper.find('.preview-overlay a[download="missing.mp4"]').exists()).toBe(true)

    wrapper.unmount()
    wrapper = null
    globalThis.fetch = mediaFetch([{ ...file('network-video', 'network.mp4'), extension: 'mp4', type: 'video' }], new TypeError('network failed'))
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.ocean-data-note').text()).toContain('覆盖当前有权限读取的目录'))
    await wrapper.find('.ocean-nav--main .ocean-nav-item').trigger('click')
    await wrapper.find('button[aria-label="预览 network.mp4"]').trigger('click')
    await waitFor(() => expect(wrapper.find('.preview-overlay').text()).toContain('网络连接失败'))
    expect(wrapper.find('.preview-overlay').text()).toContain('网络连接失败')
    expect(wrapper.find('.preview-overlay a[download="network.mp4"]').exists()).toBe(true)
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
