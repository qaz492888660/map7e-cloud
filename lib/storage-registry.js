// Compatibility exports for the first multi-storage release.
import { PRIMARY_ID, QUARK_ID, metadataId } from './storage/store.js'
export const DEFAULT_STORAGE_ID = PRIMARY_ID
export const QUARK_STORAGE_ID = QUARK_ID
export const scopedMetadataId = metadataId
export { storageDescriptors as listStorageProviders, resolveStorage as getStorageProvider } from './storage/registry.js'
