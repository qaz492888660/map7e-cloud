import { createRawRangeReader, extractRawPreview } from './raw-preview.js'

self.onmessage = async ({ data }) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('raw_preview_timeout')), 60000)
  try {
    const url = new URL(data.path, self.location.origin)
    if (url.origin !== self.location.origin || url.pathname !== '/api/storage-download') throw new Error('raw_preview_unavailable')
    const evidence = []
    const read = createRawRangeReader({ url: url.href, fileSize: data.fileSize, signal: controller.signal, evidence })
    const result = await extractRawPreview(read, data.fileSize)
    const buffer = result.bytes.slice().buffer
    self.postMessage({ ok: true, buffer, width: result.width, height: result.height, orientation: result.orientation, evidence }, [buffer])
  } catch (error) {
    const code = controller.signal.aborted ? 'raw_preview_timeout' : /^raw_preview_[a-z_]+$/.test(error?.message) ? error.message : 'raw_preview_unavailable'
    self.postMessage({ ok: false, error: code })
  } finally { clearTimeout(timeout) }
}
