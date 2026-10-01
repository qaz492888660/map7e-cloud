import adminStorages from '../lib/api-handlers/admin-storages.js'
import quarkOAuth from '../lib/api-handlers/quark-oauth.js'
import { storageWrite } from '../lib/api-handlers/storage-write.js'
import adminChangePassword from '../lib/api-handlers/admin-change-password.js'
import adminConfig from '../lib/api-handlers/admin-config.js'
import adminFileMetadata from '../lib/api-handlers/admin-file-metadata.js'
import adminFolderMetadata from '../lib/api-handlers/admin-folder-metadata.js'
import adminFolders from '../lib/api-handlers/admin-folders.js'
import adminLogin from '../lib/api-handlers/admin-login.js'
import adminLogout from '../lib/api-handlers/admin-logout.js'
import adminSession from '../lib/api-handlers/admin-session.js'
import cloudLogin from '../lib/api-handlers/cloud-login.js'
import cloudLogout from '../lib/api-handlers/cloud-logout.js'
import storageDownload from '../lib/api-handlers/storage-download.js'
import storageFiles from '../lib/api-handlers/storage-files.js'
import storageProviders from '../lib/api-handlers/storage-providers.js'
import pikpakAbout from '../lib/api-handlers/pikpak-about.js'
import pikpakCreateFolder from '../lib/api-handlers/pikpak-create-folder.js'
import pikpakDownload from '../lib/api-handlers/pikpak-download.js'
import pikpakFiles from '../lib/api-handlers/pikpak-files.js'
import pikpakRename from '../lib/api-handlers/pikpak-rename.js'
import pikpakTest from '../lib/api-handlers/pikpak-test.js'
import pikpakTrash from '../lib/api-handlers/pikpak-trash.js'
import pikpakUploadTicket from '../lib/api-handlers/pikpak-upload-ticket.js'

const handlers = new Map([
  ['admin-storages', adminStorages],
  ['quark-oauth', quarkOAuth],
  ['storage-create-folder', storageWrite('createFolder')],
  ['storage-rename', storageWrite('rename')],
  ['storage-trash', storageWrite('trash')],
  ['storage-upload-ticket', storageWrite('upload')],
  ['admin-change-password', adminChangePassword],
  ['admin-config', adminConfig],
  ['admin-file-metadata', adminFileMetadata],
  ['admin-folder-metadata', adminFolderMetadata],
  ['admin-folders', adminFolders],
  ['admin-login', adminLogin],
  ['admin-logout', adminLogout],
  ['admin-session', adminSession],
  ['cloud-login', cloudLogin],
  ['cloud-logout', cloudLogout],
  ['storage-download', storageDownload],
  ['storage-files', storageFiles],
  ['storage-providers', storageProviders],
  ['pikpak-about', pikpakAbout],
  ['pikpak-create-folder', pikpakCreateFolder],
  ['pikpak-download', pikpakDownload],
  ['pikpak-files', pikpakFiles],
  ['pikpak-rename', pikpakRename],
  ['pikpak-test', pikpakTest],
  ['pikpak-trash', pikpakTrash],
  ['pikpak-upload-ticket', pikpakUploadTicket],
])

export default async function handler(req, res) {
  const route = req.query?.route
  const name = typeof route === 'string' ? route : ''
  const target = handlers.get(name)
  if (!target) return res.status(404).json({ ok: false, error: 'not_found' })
  return target(req, res)
}
