export const DEFAULT_STORAGE_ID = 'pikpak-main'
export const QUARK_STORAGE_ID = 'quark-main'

function pikpakDescriptor() {
  const configured = Boolean(process.env.PIKPAK_PAT)
  return {
    id: DEFAULT_STORAGE_ID,
    type: 'pikpak',
    name: 'PikPak',
    configured,
    selectable: configured,
    status: configured ? 'connected' : 'not_configured',
    capabilities: {
      list: true,
      download: true,
      upload: true,
      createFolder: true,
      rename: true,
      trash: true,
    },
  }
}

function quarkDescriptor() {
  const configured = Boolean(process.env.QUARK_AUTH_BLOB)
  return {
    id: QUARK_STORAGE_ID,
    type: 'quark',
    name: '夸克网盘',
    configured,
    selectable: false,
    status: 'official_web_api_unavailable',
    capabilities: {
      list: false,
      download: false,
      upload: false,
      createFolder: false,
      rename: false,
      trash: false,
    },
  }
}

export function listStorageProviders() {
  return [pikpakDescriptor(), quarkDescriptor()]
}

export function getStorageProvider(storageId) {
  const id = String(storageId || DEFAULT_STORAGE_ID).trim() || DEFAULT_STORAGE_ID
  return listStorageProviders().find((provider) => provider.id === id) || null
}

export function scopedMetadataId(storageId, itemId) {
  const id = String(itemId || '')
  if (!id) return ''
  return storageId === DEFAULT_STORAGE_ID ? id : `${storageId}:${id}`
}
