export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ ok: false, error: 'method_not_allowed' })
  }

  res.setHeader(
    'Set-Cookie',
    'map7e_cloud_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'
  )

  return res.status(200).json({ ok: true })
}
