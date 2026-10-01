export class StorageError extends Error {
  constructor(code, status = 502) { super(code); this.code = code; this.status = status }
}
export function unsupported(capability) { throw new StorageError(`storage_capability_unsupported:${capability}`, 501) }
export function safeDirectUrl(value, secrets = []) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || secrets.filter(Boolean).some(s => url.toString().includes(s) || url.toString().includes(encodeURIComponent(s)))) return null
    if ([...url.searchParams.keys()].some(k => /^(access_token|refresh_token|authorization)$/i.test(k))) return null
    return url.toString()
  } catch { return null }
}
