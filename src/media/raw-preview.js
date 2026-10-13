// Extract rendered JPEG previews, never the camera's compressed RAW sensor data.
// TIFF/DNG directories and reads are bounded because file contents are untrusted.
export const RAW_FILE_LIMIT = 50 * 1024 ** 2
export const RAW_JPEG_LIMIT = 12 * 1024 ** 2
const TAGS = new Set([254, 256, 257, 259, 262, 273, 274, 279, 324, 325, 330, 513, 514])

function fail(code = 'raw_preview_unavailable') { throw new Error(code) }

export function jpegDimensions(bytes) {
  if (bytes[0] !== 255 || bytes[1] !== 216) return null
  for (let offset = 2, segments = 0; offset + 4 <= bytes.length && segments < 512; segments++) {
    if (bytes[offset++] !== 255) return null
    while (bytes[offset] === 255) offset++
    const marker = bytes[offset++]
    if (marker === 217 || marker === 218) return null
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue
    const length = bytes[offset] * 256 + bytes[offset + 1]
    if (length < 2 || offset + length > bytes.length) return null
    // Baseline/progressive rendered JPEG only; lossless JPEG RAW is not a preview.
    if ([192, 193, 194].includes(marker) && length >= 8) {
      const height = bytes[offset + 3] * 256 + bytes[offset + 4]
      const width = bytes[offset + 5] * 256 + bytes[offset + 6]
      return width && height && width * height <= 80_000_000 ? { width, height } : null
    }
    offset += length
  }
  return null
}

function preserveOrientation(bytes, orientation) {
  // Renderers honor the JPEG's own EXIF first. Some TIFF RAWs only store it in
  // IFD0; add that orientation only when the rendered JPEG has none of its own.
  if (orientation === 1) return bytes
  for (let offset = 2, segments = 0; offset + 4 <= bytes.length && segments < 512; segments++) {
    if (bytes[offset++] !== 255) break
    while (bytes[offset] === 255) offset++
    const marker = bytes[offset++], length = bytes[offset] * 256 + bytes[offset + 1]
    if (marker === 218 || marker === 217 || length < 2 || offset + length > bytes.length) break
    if (marker === 225 && length >= 16 && String.fromCharCode(...bytes.subarray(offset + 2, offset + 8)) === 'Exif\u0000\u0000') {
      const tiff = bytes.subarray(offset + 8, offset + length), view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength)
      const little = tiff[0] === 73 && tiff[1] === 73
      const ifd = view.getUint32(4, little)
      if (ifd + 2 <= tiff.length) {
        const count = Math.min(512, view.getUint16(ifd, little))
        for (let i = 0; i < count && ifd + 2 + (i + 1) * 12 <= tiff.length; i++) {
          const entry = ifd + 2 + i * 12
          if (view.getUint16(entry, little) === 274 && view.getUint16(entry + 2, little) === 3 && view.getUint32(entry + 4, little) === 1) {
            const value = view.getUint16(entry + 8, little)
            if (value >= 1 && value <= 8) return bytes
          }
        }
      }
    }
    offset += length
  }
  const exif = new Uint8Array([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,orientation,0,0,0,0,0,0,0])
  const output = new Uint8Array(bytes.length + exif.length)
  output.set(bytes.subarray(0, 2)); output.set(exif, 2); output.set(bytes.subarray(2), 2 + exif.length)
  return output
}

export async function extractRawPreview(read, fileSize) {
  if (!Number.isSafeInteger(fileSize) || fileSize < 8 || fileSize > RAW_FILE_LIMIT) fail('raw_preview_size_limit')
  const header = await read(0, Math.min(131072, fileSize))
  const little = header[0] === 73 && header[1] === 73
  if (!little && !(header[0] === 77 && header[1] === 77)) fail('raw_preview_format_unsupported')
  const view = data => new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (view(header).getUint16(2, little) !== 42) fail('raw_preview_format_unsupported')
  const queue = [view(header).getUint32(4, little)], visited = new Set(), candidates = []
  let orientation = 1
  const boundedRead = async (offset, length) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0 || offset + length > fileSize) fail()
    const bytes = await read(offset, length)
    if (bytes.length !== length) fail()
    return bytes
  }
  while (queue.length && visited.size < 16) {
    const offset = queue.shift()
    if (!offset || visited.has(offset)) continue
    visited.add(offset)
    const count = view(await boundedRead(offset, 2)).getUint16(0, little)
    if (count > 512) fail()
    const bytes = await boundedRead(offset + 2, count * 12 + 4), directory = view(bytes), tags = {}
    for (let index = 0; index < count; index++) {
      const entry = index * 12, tag = directory.getUint16(entry, little)
      if (!TAGS.has(tag)) continue
      const type = directory.getUint16(entry + 2, little), values = directory.getUint32(entry + 4, little)
      const size = ({ 1: 1, 3: 2, 4: 4, 13: 4 })[type]
      if (!size || !values || values > 64) continue
      const length = size * values
      const data = length <= 4 ? bytes.subarray(entry + 8, entry + 8 + length)
        : await boundedRead(directory.getUint32(entry + 8, little), length)
      const numbers = view(data)
      tags[tag] = Array.from({ length: values }, (_, i) => size === 1 ? data[i] : size === 2 ? numbers.getUint16(i * size, little) : numbers.getUint32(i * size, little))
    }
    if (visited.size === 1 && tags[274]?.[0] >= 1 && tags[274][0] <= 8) orientation = tags[274][0]
    queue.push(...(tags[330] || []).slice(0, 16), directory.getUint32(count * 12, little))
    // CFA/LinearRaw/auxiliary data must never be mistaken for a rendered photo.
    const rendered = [0, 1, 2, 6].includes(tags[262]?.[0])
    let start, length
    if (rendered && tags[513]?.length === 1 && tags[514]?.length === 1) {
      start = tags[513][0]; length = tags[514][0]
    } else if (rendered && tags[259]?.[0] === 7) {
      const offsets = tags[273] || tags[324], lengths = tags[279] || tags[325]
      if (offsets?.length === 1 && lengths?.length === 1) { start = offsets[0]; length = lengths[0] }
    }
    if (start > 0 && length > 0 && length <= RAW_JPEG_LIMIT && start + length <= fileSize) {
      candidates.push({ start, length, area: (tags[256]?.[0] || 0) * (tags[257]?.[0] || 0) })
    }
  }
  // Only read the largest declared rendered preview; no brute-force JPEG scan.
  const candidate = candidates.sort((a, b) => b.area - a.area || b.length - a.length)[0]
  if (!candidate) fail('raw_preview_jpeg_missing')
  const bytes = await boundedRead(candidate.start, candidate.length)
  const dimensions = jpegDimensions(bytes)
  if (!dimensions) fail('raw_preview_format_unsupported')
  return { bytes: preserveOrientation(bytes, orientation), ...dimensions, orientation }
}

export function createRawRangeReader({ url, fileSize, signal, fetchImpl = fetch, evidence = [] }) {
  const chunks = []
  let requests = 0, transferred = 0
  return async (offset, length) => {
    if (!Number.isSafeInteger(fileSize) || fileSize < 8 || fileSize > RAW_FILE_LIMIT || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || offset + length > fileSize) fail('raw_preview_size_limit')
    if (signal?.aborted) throw signal.reason || new Error('raw_preview_cancelled')
    const cached = chunks.find(chunk => offset >= chunk.offset && offset + length <= chunk.offset + chunk.bytes.length)
    if (cached) return cached.bytes.subarray(offset - cached.offset, offset - cached.offset + length)
    if (++requests > 8 || length > RAW_JPEG_LIMIT || fileSize > RAW_FILE_LIMIT) fail('raw_preview_size_limit')
    const response = await fetchImpl(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` }, credentials: 'include', cache: 'no-store', signal })
    const cancel = () => response.body?.cancel().catch(() => {})
    if (signal?.aborted) { await cancel(); throw signal.reason || new Error('raw_preview_cancelled') }
    const range = response.headers.get('content-range'), match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range || '')
    if (response.status !== 206 || !match || Number(match[1]) !== offset || Number(match[2]) !== offset + length - 1 || Number(match[3]) !== fileSize) {
      await cancel(); fail(response.status === 401 || response.status === 403 ? 'raw_preview_authorization_failed' : 'raw_preview_range_unavailable')
    }
    const declared = response.headers.get('content-length')
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== length)) { await cancel(); fail() }
    const reader = response.body.getReader(), parts = []; let received = 0
    try {
      for (;;) {
        if (signal?.aborted) throw signal.reason || new Error('raw_preview_cancelled')
        const { done, value } = await reader.read()
        if (done) break
        received += value.length; transferred += value.length
        if (received > length || transferred > 24 * 1024 ** 2) fail('raw_preview_size_limit')
        parts.push(value)
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error }
    finally { reader.releaseLock() }
    if (received !== length) fail()
    const bytes = new Uint8Array(received); let position = 0
    for (const part of parts) { bytes.set(part, position); position += part.length }
    chunks.push({ offset, bytes })
    const contentType = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase()
    evidence.push({ status: response.status, contentType: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(contentType) ? contentType : null, contentLength: declared === null ? null : Number(declared), contentRange: range, bytes: received })
    return bytes
  }
}
