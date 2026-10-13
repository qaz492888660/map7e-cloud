export const QUARK_FILE_SIZE_LIMIT = 'quark_file_size_limit'

// Classify only Quark's explicit download policy, never errno 23018 alone.
export function quarkDownloadLimit(path, response, payload) {
  if (path !== '/open/v1/file/get_download_url' || response?.status !== 400
    || payload?.errno !== 23018 || typeof payload.error_info !== 'string') return null
  const match = /^download file size limit\[(\d{1,15})\]$/i.exec(payload.error_info.trim())
  const bytes = match ? Number(match[1]) : null
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null
}

export function quarkDownloadLimitMessage(limitBytes) {
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
    return '当前夸克接口限制此文件的下载大小，此文件暂不支持站内播放或下载。'
  }
  const mib = Math.round(limitBytes / (1024 ** 2) * 100) / 100
  return `当前夸克接口限制单文件下载大小为 ${mib} MiB，此文件暂不支持站内播放或下载。`
}

export function quarkDownloadLimitBody(limitBytes) {
  return { ok: false, error: QUARK_FILE_SIZE_LIMIT,
    ...(Number.isSafeInteger(limitBytes) && limitBytes > 0 ? { limitBytes } : {}),
    message: quarkDownloadLimitMessage(limitBytes) }
}
