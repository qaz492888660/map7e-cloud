import { bootstrapAdminAuthRecord, getAdminAuthRecord, sendPersistentStoreError } from '../admin-store.js'

const INITIAL_ADMIN_PASSWORD_HASH = 'scrypt$16384$8$1$14jy9YIMXGgnNRPHX2MQjQ$LlMrOTOkg1ca-046-FMl0Bj6vlhHm8A5AkP2QXDycNTiln1TwXpNMRb01JHkBTFT5ahwVCk23UFf0umVNUYd3Q'

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }
  if (process.env.VERCEL_ENV !== 'production') {
    return res.status(404).json({ ok: false, error: 'not_found' })
  }

  try {
    const current = await getAdminAuthRecord()
    if (!current.storageReady) {
      return res.status(503).json({ ok: false, error: 'persistent_storage_not_configured' })
    }
    if (current.passwordHash) {
      return res.status(200).json({ ok: true, state: 'existing' })
    }

    const created = await bootstrapAdminAuthRecord(INITIAL_ADMIN_PASSWORD_HASH)
    if (created) {
      return res.status(200).json({ ok: true, state: 'initialized' })
    }

    const latest = await getAdminAuthRecord()
    return res.status(200).json({ ok: Boolean(latest.passwordHash), state: latest.passwordHash ? 'existing' : 'missing' })
  } catch (error) {
    return sendPersistentStoreError(res, error)
  }
}
