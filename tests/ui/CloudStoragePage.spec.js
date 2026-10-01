import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import CloudStoragePage from '../../src/components/CloudStoragePage.vue'

const providers = {
  ok: true,
  defaultStorageId: 'pikpak-main',
  providers: [
    { id: 'pikpak-main', name: 'PikPak', selectable: true, capabilities: { list: true } },
    { id: 'quark-main', name: '夸克网盘', selectable: true, capabilities: { list: true } },
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

  beforeEach(() => {
    requests = []
    originalFetch = globalThis.fetch
    window.requestIdleCallback = () => 0
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(input, location.href)
      if (url.pathname === '/api/storage-providers') return jsonResponse(providers)
      if (url.pathname !== '/api/storage-files') throw new Error(`Unexpected API request: ${url.pathname}`)
      const requested = url.searchParams.get('storageId') || 'pikpak-main'
      const parentId = url.searchParams.get('parentId') || ''
      const pageToken = url.searchParams.get('pageToken') || ''
      requests.push({ storageId: requested, parentId, pageToken })
      if (requested === 'pikpak-main' && !parentId) {
        return jsonResponse({ ok: true, storageId: requested, items: [folder('photos', '图片'), file('root-doc', 'readme.txt')] })
      }
      if (requested === 'pikpak-main' && parentId === 'photos') {
        return jsonResponse({ ok: true, storageId: requested, items: [folder('nested', '二级目录', 'photos'), file('photo-note', '说明.txt', 'photos')] })
      }
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
    delete window.requestIdleCallback
  })

  it('loads providers and the root in parallel without requesting any child directory', async () => {
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.overview-footnote').exists()).toBe(true))
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
    expect(requests).toEqual([{ storageId: 'pikpak-main', parentId: '', pageToken: '' }])
    expect(wrapper.find('.background-video').attributes('preload')).toBe('none')
    expect([...wrapper.find('.background-video').element.querySelectorAll('source')].every((source) => !source.hasAttribute('src'))).toBe(true)
  })

  it('requests a folder only after the user opens it and does not scan its children', async () => {
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.overview-footnote').exists()).toBe(true))
    await wrapper.findAll('.directory-card')[1].trigger('click')
    await waitFor(() => expect(wrapper.find('.folder-open').exists()).toBe(true))
    await wrapper.find('.folder-open').trigger('click')
    await waitFor(() => expect(requests.some((request) => request.parentId === 'photos')).toBe(true))
    expect(requests).toEqual([
      { storageId: 'pikpak-main', parentId: '', pageToken: '' },
      { storageId: 'pikpak-main', parentId: 'photos', pageToken: '' },
    ])
  })

  it('ignores a Quark page response that arrives after switching back to PikPak', async () => {
    let resolveQuarkNext
    globalThis.fetch = vi.fn(async (input) => {
      const url = new URL(input, location.href)
      if (url.pathname === '/api/storage-providers') return jsonResponse(providers)
      const requested = url.searchParams.get('storageId') || 'pikpak-main'
      const parentId = url.searchParams.get('parentId') || ''
      const pageToken = url.searchParams.get('pageToken') || ''
      requests.push({ storageId: requested, parentId, pageToken })
      if (requested === 'pikpak-main') return jsonResponse({ ok: true, storageId: requested, items: [folder('photos', '图片')] })
      if (!pageToken) return jsonResponse({ ok: true, storageId: requested, items: [folder('quark-folder', 'Quark 文件夹')], nextPageToken: 'next', nextRequestDelayMs: 5 })
      return new Promise((resolve) => { resolveQuarkNext = () => resolve(jsonResponse({ ok: true, storageId: requested, items: [folder('stale-folder', '过期结果')] })) })
    })
    wrapper = mount(CloudStoragePage, { attachTo: document.body })
    await waitFor(() => expect(wrapper.find('.overview-footnote').exists()).toBe(true))
    await wrapper.findAll('.directory-card')[1].trigger('click')
    await waitFor(() => expect(wrapper.find('.folder-open').exists()).toBe(true))
    await wrapper.find('#cloud-storage-select').setValue('quark-main')
    await waitFor(() => expect(wrapper.find('.directory-card').exists()).toBe(true))
    await wrapper.findAll('.directory-card')[1].trigger('click')
    await waitFor(() => expect(requests.some((request) => request.storageId === 'quark-main' && request.pageToken === 'next')).toBe(true))
    await wrapper.find('#cloud-storage-select').setValue('pikpak-main')
    await wrapper.findAll('.directory-card')[1].trigger('click')
    await waitFor(() => expect(wrapper.text()).toContain('图片'))
    resolveQuarkNext()
    await flushPromises()
    expect(wrapper.text()).not.toContain('过期结果')
    expect(wrapper.find('#cloud-storage-select').element.value).toBe('pikpak-main')
  })
})
