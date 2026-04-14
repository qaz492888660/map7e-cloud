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
      throw new Error(`Unable to load ${url}`)
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
          <h1 style="font-family:Sora,system-ui,sans-serif;margin:0 0 12px;font-size:28px;">Map7e Cloud Resource Library</h1>
          <p style="margin:0;color:rgba(255,255,255,0.7);">Failed to load the static resource library.</p>
          <p style="margin:12px 0 0;color:rgba(255,255,255,0.55);font-size:14px;">${error instanceof Error ? error.message : 'Unknown error'}</p>
        </div>
      </div>
    `
  }
}
