import * as Vue from 'https://unpkg.com/vue@3/dist/vue.esm-browser.prod.js'
import { loadModule } from 'https://unpkg.com/vue3-sfc-loader/dist/vue3-sfc-loader.esm.js'

const { createApp } = Vue

const loaderOptions = {
  moduleCache: {
    vue: Vue,
  },
  async getFile(url) {
    const response = await fetch(url, { cache: 'no-cache' })

    if (!response.ok) {
      throw new Error(`无法加载 ${url}`)
    }

    return response.text()
  },
  addStyle(textContent) {
    const style = document.createElement('style')
    style.textContent = textContent
    document.head.appendChild(style)
  },
}

try {
  const App = await loadModule('/components/CloudStoragePage.vue', loaderOptions)
  createApp(App).mount('#app')
} catch (error) {
  const appRoot = document.getElementById('app')
  if (appRoot) {
    appRoot.innerHTML = `
      <div style="min-height:100%;display:grid;place-items:center;background:#04172f;color:white;font-family:Manrope,system-ui,sans-serif;padding:24px;text-align:center;">
        <div>
          <h1 style="font-family:Sora,system-ui,sans-serif;margin:0 0 12px;font-size:28px;">Map7e</h1>
          <p style="margin:0;color:rgba(255,255,255,0.7);">\u9759\u6001\u76ee\u5f55\u9875\u9762\u52a0\u8f7d\u5931\u8d25\u3002</p>
          <p style="margin:12px 0 0;color:rgba(255,255,255,0.55);font-size:14px;">${error instanceof Error ? error.message : '未知错误'}</p>
        </div>
      </div>
    `
  }
}
