import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import CloudStoragePage from '../../src/components/CloudStoragePage.vue'
import { loadRawEmbeddedPreview } from '../../src/media/raw-preview-client.js'
vi.mock('../../src/media/raw-preview-client.js', () => ({ loadRawEmbeddedPreview: vi.fn() }))

const raw = { id:'raw',name:'camera.dng',extension:'dng',parentId:'',isFolder:false,size:22100373,previewAvailable:true }
const jpg = { id:'jpg',name:'photo.jpg',extension:'jpg',parentId:'',isFolder:false,size:2245317 }
const json = (data,status=200) => new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}})
let wrapper, originalFetch, originalUrl, createObjectURL, revokeObjectURL
async function open(items=[raw],album=false) {
  globalThis.fetch=vi.fn(async input=>{
    const url=new URL(input,location.href)
    if(url.pathname==='/api/storage-providers')return json({ok:true,defaultStorageId:'quark-main',providers:[{id:'quark-main',name:'夸克网盘',provider:'quark',selectable:true,capabilities:{list:true}}]})
    if(url.pathname==='/api/storage-about')return json({ok:true,status:'connected'})
    if(url.pathname==='/api/storage-files')return json({ok:true,storageId:'quark-main',items})
    if(url.pathname==='/api/storage-preview'&&url.searchParams.get('check')==='read')return json({ok:true})
    throw Error('unexpected request')
  })
  wrapper=mount(CloudStoragePage,{attachTo:document.body})
  await vi.waitFor(()=>expect(wrapper.find('.ocean-data-note').text()).toContain('覆盖当前有权限'))
  if(album){await wrapper.find('.ocean-category-card[aria-label^="相册"]').trigger('click');await wrapper.find('button[aria-label="查看图片 camera.dng"]').trigger('click')}
  else{await wrapper.find('.ocean-nav--main .ocean-nav-item').trigger('click');await wrapper.find('button[aria-label="预览 '+items[0].name+'"]').trigger('click')}
}
async function loaded(width,height) {
  const image=wrapper.find('.viewer-image')
  Object.defineProperties(image.element,{naturalWidth:{value:width,configurable:true},naturalHeight:{value:height,configurable:true},clientWidth:{value:300,configurable:true},clientHeight:{value:400,configurable:true}})
  await image.trigger('load'); await flushPromises()
}
beforeEach(()=>{
  originalFetch=globalThis.fetch;originalUrl=location.href
  window.history.replaceState(null,'','/?storageId=quark-main');window.requestIdleCallback=()=>0
  createObjectURL=URL.createObjectURL;revokeObjectURL=URL.revokeObjectURL
  URL.createObjectURL=vi.fn(()=>'blob:rendered-preview');URL.revokeObjectURL=vi.fn()
  loadRawEmbeddedPreview.mockReset()
})
afterEach(()=>{
  wrapper?.unmount();wrapper=null;globalThis.fetch=originalFetch
  window.history.replaceState(null,'',originalUrl);delete window.requestIdleCallback
  URL.createObjectURL=createObjectURL;URL.revokeObjectURL=revokeObjectURL
})

describe('RAW photo viewer',()=>{
  it('prefers an adequate Provider preview and never decodes/downloads RAW unnecessarily',async()=>{
    await open();await loaded(2048,2730)
    expect(loadRawEmbeddedPreview).not.toHaveBeenCalled()
    expect(wrapper.find('.viewer-image').attributes('src')).toContain('variant=preview')
  })
  it('replaces a 100×133 thumbnail with the extracted JPEG, preserves download and revalidates cache',async()=>{
    loadRawEmbeddedPreview.mockResolvedValue({buffer:new ArrayBuffer(32),width:4032,height:3024,evidence:[{status:206,bytes:32}]})
    await open();await loaded(100,133)
    expect(wrapper.find('.viewer-image').attributes('src')).toBe('blob:rendered-preview')
    await loaded(3024,4032)
    expect(wrapper.find('.photo-viewer').text()).toContain('3024 × 4032')
    expect(wrapper.find('.photo-viewer').text()).toContain('内嵌 JPEG')
    expect(wrapper.find('.photo-viewer').text()).not.toContain('低清预览')
    expect(wrapper.find('a[download="camera.dng"]').attributes('href')).toContain('/api/storage-download')
    await wrapper.find('button[aria-label="关闭图片预览"]').trigger('click')
    await wrapper.find('button[aria-label="预览 camera.dng"]').trigger('click');await loaded(100,133)
    expect(loadRawEmbeddedPreview).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls.some(([input])=>String(input).includes('check=read'))).toBe(true)
  })
  it('labels low-resolution fallback and settles a failed upgrade once',async()=>{
    loadRawEmbeddedPreview.mockRejectedValue(new Error('raw_preview_jpeg_missing'))
    await open();await loaded(100,133)
    expect(wrapper.find('.photo-viewer').text()).toContain('低清预览')
    expect(wrapper.find('.viewer-loading').exists()).toBe(false)
    await loaded(100,133);expect(loadRawEmbeddedPreview).toHaveBeenCalledTimes(1)
  })
  it('discards late RAW responses after switching and keeps JPG on its ordinary source',async()=>{
    let finish;loadRawEmbeddedPreview.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
    await open([raw,jpg],true);await loaded(100,133)
    const signal=loadRawEmbeddedPreview.mock.calls[0][1].signal
    await wrapper.find('button[aria-label="下一张"]').trigger('click')
    expect(signal.aborted).toBe(true)
    finish({buffer:new ArrayBuffer(32),width:4032,height:3024});await flushPromises()
    expect(wrapper.find('.viewer-image').attributes('src')).toContain('/api/storage-download')
    expect(wrapper.find('.viewer-image').attributes('src')).toContain('id=jpg')
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
  it('zooms, clamps mouse/touch panning, resets fit and preserves image aspect styling',async()=>{
    await open([jpg]);await loaded(3024,4032)
    const stage=wrapper.find('.viewer-stage')
    Object.defineProperties(stage.element,{clientWidth:{value:300,configurable:true},clientHeight:{value:400,configurable:true}})
    await wrapper.find('button[aria-label="放大图片"]').trigger('click')
    await stage.trigger('mousedown',{button:0,clientX:100,clientY:100});await stage.trigger('mousemove',{clientX:400,clientY:400});await stage.trigger('mouseup')
    expect(wrapper.find('.viewer-image').attributes('style')).toContain('translate(75px, 100px) scale(1.5)')
    await stage.trigger('touchstart',{touches:[{clientX:0,clientY:0},{clientX:100,clientY:0}]})
    await stage.trigger('touchmove',{touches:[{clientX:0,clientY:0},{clientX:200,clientY:0}]})
    expect(wrapper.find('.viewer-image').attributes('style')).toContain('scale(3)')
    await wrapper.find('button[aria-label="图片适合屏幕"]').trigger('click')
    expect(wrapper.find('.viewer-image').attributes('style')).toContain('translate(0px, 0px) scale(1)')
  })
  it('rejects reuse of a cached private preview when permission changes',async()=>{
    loadRawEmbeddedPreview.mockResolvedValue({buffer:new ArrayBuffer(32),width:4032,height:3024})
    await open();await loaded(100,133);await loaded(3024,4032)
    await wrapper.find('button[aria-label="关闭图片预览"]').trigger('click')
    const original=fetch;globalThis.fetch=vi.fn((input,options)=>String(input).includes('check=read')?Promise.resolve(json({ok:false,error:'authentication_required'},401)):original(input,options))
    await wrapper.find('button[aria-label="预览 camera.dng"]').trigger('click');await loaded(100,133)
    expect(wrapper.find('.photo-viewer').text()).toContain('授权已失效')
    expect(wrapper.find('.viewer-image').exists()).toBe(false)
    expect(loadRawEmbeddedPreview).toHaveBeenCalledTimes(1)
  })
})
