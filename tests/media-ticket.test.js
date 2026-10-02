import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMediaSession,
  createMediaTicket,
  mediaGatewayLocation,
  verifyMediaSession,
  verifyMediaTicket,
} from '../lib/storage/media-ticket.js'

const secret = 'media-gateway-test-secret-with-more-than-32-bytes'
const fixture = { storageId: 'quark-main', fileId: 'file-123', parentId: 'folder-7', purpose: 'preview', variant: 'preview' }

await test('media ticket signs file identity, purpose and a five-minute lifetime', () => {
  const now = 1_800_000_000_000
  const ticket = createMediaTicket(fixture, { secret, now })
  const claims = verifyMediaTicket(ticket, secret, { now: now + 299_000 })
  assert.deepEqual({
    storageId: claims.storageId,
    fileId: claims.fileId,
    parentId: claims.parentId,
    purpose: claims.purpose,
    variant: claims.variant,
  }, fixture)
  assert.equal(claims.issuedAt, Math.floor(now / 1000))
  assert.equal(claims.expiresAt - claims.issuedAt, 300)
})

await test('media ticket rejects expiration, tampering, invalid storage identity and invalid purpose', () => {
  const now = 1_800_000_000_000
  const ticket = createMediaTicket(fixture, { secret, now })
  assert.throws(() => verifyMediaTicket(ticket, secret, { now: now + 301_000 }), /media_ticket_expired/)
  assert.throws(() => verifyMediaTicket(`${ticket.slice(0, -1)}x`, secret, { now }), /media_ticket_invalid/)
  assert.throws(() => createMediaTicket({ ...fixture, storageId: '../../other' }, { secret, now }), /media_ticket_invalid/)
  assert.throws(() => createMediaTicket({ ...fixture, purpose: 'proxy' }, { secret, now }), /media_ticket_invalid/)
  assert.throws(() => verifyMediaTicket(ticket, `${secret}wrong`, { now }), /media_ticket_invalid/)
})

await test('media Gateway URL requires HTTPS and includes only a signed Map7e ticket', () => {
  const env = { MEDIA_GATEWAY_URL: 'https://media.map7e.test', MEDIA_GATEWAY_SIGNING_SECRET: secret }
  const location = mediaGatewayLocation(fixture, { env, now: 1_800_000_000_000 })
  const url = new URL(location)
  assert.equal(url.origin, 'https://media.map7e.test')
  assert.equal(url.pathname, '/v1/media')
  const claims = verifyMediaTicket(url.searchParams.get('ticket'), secret, { now: 1_800_000_000_000 })
  assert.equal(claims.fileId, fixture.fileId)
  assert.equal(location.includes('accessToken'), false)
  assert.throws(() => mediaGatewayLocation(fixture, { env: { ...env, MEDIA_GATEWAY_URL: 'http://media.map7e.test' } }), /media_gateway_not_configured/)
  assert.throws(() => mediaGatewayLocation(fixture, { env: { MEDIA_GATEWAY_URL: env.MEDIA_GATEWAY_URL } }), /media_gateway_not_configured/)
})

await test('short ticket can establish a file-scoped HttpOnly session for later video ranges', () => {
  const now = 1_800_000_000_000
  const ticket = createMediaTicket({ storageId: 'quark-main', fileId: 'video-1', parentId: '', purpose: 'video' }, { secret, now })
  const claims = verifyMediaTicket(ticket, secret, { now })
  const session = createMediaSession(claims, { secret, now: now + 60_000 })
  const sessionClaims = verifyMediaSession(session, secret, { now: now + 60_000 })
  assert.equal(sessionClaims.fileId, 'video-1')
  assert.equal(sessionClaims.purpose, 'video')
  assert.equal(sessionClaims.expiresAt - sessionClaims.issuedAt, 6 * 60 * 60)
  assert.throws(() => verifyMediaTicket(session, secret, { now: now + 60_000 }), /media_ticket_invalid/)
})
