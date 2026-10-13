import test from 'node:test'
import assert from 'node:assert/strict'
import { createPikPakProvider, safePikPakDownloadUrl } from '../lib/storage/providers/pikpak.js'

test('PikPak uses a safe existing fallback when the primary URL is unsafe', async () => {
  const originalFetch = globalThis.fetch
  const safe = 'https://cdn.test/original?signature=temporary'
  try {
    for (const primary of ['ftp://cdn.test/original', 'https://cdn.test/file?access_token=account-secret', 'https://cdn.test/account-secret']) {
      globalThis.fetch = async () => new Response(JSON.stringify({ id: 'file', links: { 'application/octet-stream': { url: primary } }, web_content_link: safe }))
      const provider = createPikPakProvider({}, { accessToken: 'account-secret' })
      assert.equal(await provider.getDownloadUrl('file'), safe)
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ id: 'file', links: { 'application/octet-stream': { url: 'ftp://cdn.test/original' } }, web_content_link: 'https://cdn.test/account-secret' }))
    await assert.rejects(createPikPakProvider({}, { accessToken: 'account-secret' }).getDownloadUrl('file'), /download_link_unavailable/)
  } finally { globalThis.fetch = originalFetch }
})

test('PikPak HTTP sources become HTTPS with identical host, path and signed query', () => {
  const source = 'http://download.mypikpak.com/a%20b.txt?signature=temporary&expires=1900000000'
  assert.equal(safePikPakDownloadUrl(source), source.replace('http:', 'https:'))
  assert.equal(safePikPakDownloadUrl(source.replace('http:', 'https:')), source.replace('http:', 'https:'))
  for (const unsafe of ['ftp://cdn.test/a', 'http://user:password@cdn.test/a', 'http://cdn.test/a?access_token=private',
    'http://cdn.test/account-secret', 'not-a-url']) {
    assert.equal(safePikPakDownloadUrl(unsafe, ['account-secret']), null)
  }
})
