import { storageDescriptors } from '../storage/registry.js'
import { methodAllowed, sendStorageError } from '../storage/http.js'
export default async function handler(req, res) {
  if (!methodAllowed(req, res, 'GET')) return
  try { return res.status(200).json({ ok: true, ...await storageDescriptors() }) } catch (error) { return sendStorageError(res, error) }
}
