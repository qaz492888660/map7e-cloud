import { storageDescriptors } from '../storage/registry.js'
import { methodAllowed, sendStorageError } from '../storage/http.js'
import { withProviderPerf } from '../storage/provider-perf.js'
export default async function handler(req, res) {
  if (!methodAllowed(req, res, 'GET')) return
  return withProviderPerf(async (metrics) => {
    try { return res.status(200).json({ ok: true, ...await storageDescriptors() }) } catch (error) {
      metrics.outcome = 'error'
      return sendStorageError(res, error)
    }
  })
}
