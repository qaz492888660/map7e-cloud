const LINK_TYPES = new Set(['application/octet-stream', 'application/pdf', 'text/plain',
  'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'audio/mpeg'])

// Failure-only structural evidence. Never log URLs, tokens, names, IDs or raw errors.
export function logPikPakDownloadFailure(item, { status, unsafe = false, secret, logger = console.warn } = {}) {
  const links = item?.links && typeof item.links === 'object' ? item.links : {}
  const types = Object.keys(links)
  const present = value => typeof value === 'string' && value.length > 0
  const diagnostic = {
    event: 'pikpak_download_source_unavailable',
    reason: unsafe ? 'source_rejected' : 'source_missing',
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { upstreamStatus: status } : {}),
    linkTypes: types.filter(type => LINK_TYPES.has(type)).slice(0, 9),
    otherLinkTypes: Math.min(100, types.filter(type => !LINK_TYPES.has(type)).length),
    hasOctetStreamUrl: present(links['application/octet-stream']?.url),
    hasWebContentLink: present(item?.web_content_link),
    hasDownloadUrl: present(item?.download_url),
    hasFileWrapper: Boolean(item?.file && typeof item.file === 'object'),
    hasItemWrapper: Boolean(item?.item && typeof item.item === 'object'),
    octetStreamReason: pikPakDownloadSourceReason(links['application/octet-stream']?.url, secret),
    webContentReason: pikPakDownloadSourceReason(item?.web_content_link, secret),
  }
  try { logger(JSON.stringify(diagnostic)) } catch { /* Logging cannot change the response. */ }
}

export function pikPakDownloadSourceReason(value, secret) {
  if (typeof value !== 'string' || !value) return 'missing'
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return 'non_https'
    if (url.username || url.password) return 'url_credentials'
    if (secret && (url.toString().includes(secret) || url.toString().includes(encodeURIComponent(secret)))) return 'embedded_token'
    if ([...url.searchParams.keys()].some(key => /^(access_token|refresh_token|authorization)$/i.test(key))) return 'auth_query'
    return 'accepted'
  } catch { return 'invalid_url' }
}
