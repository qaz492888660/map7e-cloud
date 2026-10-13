import { RAW_FILE_LIMIT } from './raw-preview.js'

export function loadRawEmbeddedPreview(file, { signal, workerFactory = () => new Worker(new URL('./raw-preview.worker.js', import.meta.url), { type: 'module' }) } = {}) {
  if (signal?.aborted) return Promise.reject(new Error('raw_preview_cancelled'))
  if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 8 || file.sizeBytes > RAW_FILE_LIMIT) return Promise.reject(new Error('raw_preview_size_limit'))
  return new Promise((resolve, reject) => {
    const worker = workerFactory()
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout); signal?.removeEventListener('abort', abort); worker.terminate()
      if (error) reject(error); else resolve(value)
    }
    const abort = () => finish(new Error('raw_preview_cancelled'))
    const timeout = setTimeout(() => finish(new Error('raw_preview_timeout')), 65000)
    signal?.addEventListener('abort', abort, { once: true })
    worker.onerror = () => finish(new Error('raw_preview_unavailable'))
    worker.onmessage = ({ data }) => data.ok && data.buffer instanceof ArrayBuffer
      ? finish(null, data) : finish(new Error(/^raw_preview_[a-z_]+$/.test(data.error) ? data.error : 'raw_preview_unavailable'))
    worker.postMessage({ path: file.path, fileSize: file.sizeBytes })
  })
}
