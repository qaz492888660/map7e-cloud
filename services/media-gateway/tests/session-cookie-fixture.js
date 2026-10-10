import crypto from 'node:crypto'
import { mediaSessionPath, verifyMediaTicket } from '../../../lib/storage/media-ticket.js'

// Browser cookie Path matching, independent of the Gateway's grant validation.
export class CookieJar {
  cookies = new Map()

  apply(lines) {
    for (const line of lines) {
      const [pair, ...attributes] = line.split(';')
      const separator = pair.indexOf('=')
      const name = pair.slice(0, separator)
      const path = attributes.find(value => value.trim().startsWith('Path='))?.trim().slice(5) || '/'
      const key = name + '\u0000' + path
      if (attributes.some(value => value.trim() === 'Max-Age=0')) this.cookies.delete(key)
      else this.cookies.set(key, { name, value: pair.slice(separator + 1), path })
    }
  }

  header(url) {
    const pathname = new URL(url).pathname
    return [...this.cookies.values()]
      .filter(cookie => pathname === cookie.path || pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : cookie.path + '/'))
      .map(cookie => cookie.name + '=' + cookie.value).join('; ')
  }
}

export function legacyCookie(ticket, secret, now, lifetime = 1800) {
  const original = verifyMediaTicket(ticket, secret, { now, allowExpired: true })
  const claims = {
    ...original,
    grantType: 'session',
    expiresAt: original.issuedAt + lifetime,
    record: { private_url: 'https://cdn.quark.cn/?secret=must-not-migrate' },
  }
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const token = encoded + '.' + crypto.createHmac('sha256', secret).update(encoded).digest('base64url')
  const name = '__Host-map7e-media-' + mediaSessionPath(claims, secret).split('/').at(-1)
  return { claims, line: name + '=' + token + '; Path=/; Max-Age=' + lifetime + '; Secure; HttpOnly; SameSite=Strict' }
}
