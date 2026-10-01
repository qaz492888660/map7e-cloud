import { requireAdmin } from '../admin-auth.js'
import storageFiles from './storage-files.js'
import { methodAllowed } from '../storage/http.js'

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (!methodAllowed(req, res, 'GET')) return
  if (!await requireAdmin(req, res)) return
  req.storageAdminBrowse = true
  return storageFiles(req, res)
}
