import { listStorageProviders } from '../storage-registry.js'

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }

  const providers = listStorageProviders().map((provider) => ({
    id: provider.id,
    type: provider.type,
    name: provider.name,
    configured: provider.configured,
    selectable: provider.selectable,
    status: provider.status,
    capabilities: provider.capabilities,
  }))

  return res.status(200).json({
    ok: true,
    defaultStorageId: providers.find((provider) => provider.selectable)?.id || null,
    providers,
  })
}
