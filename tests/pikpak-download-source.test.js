import test from 'node:test'
import assert from 'node:assert/strict'
import { createPikPakProvider } from '../lib/storage/providers/pikpak.js'

test('PikPak uses a safe existing fallback when the primary URL is unsafe', async () => {
  const originalFetch = globalThis.fetch
  const safe = 'https://cdn.test/original?signature=temporary'
  try {
    for (const primary of ['http://cdn.test/original', 'https://cdn.test/file?access_token=account-secret', 'https://cdn.test/account-secret']) {
      globalThis.fetch = async () => new Response(JSON.stringify({ id: 'file', links: { 'application/octet-stream': { url: primary } }, web_content_link: safe }))
      const provider = createPikPakProvider({}, { accessToken: 'account-secret' })
      assert.equal(await provider.getDownloadUrl('file'), safe)
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ id: 'file', links: { 'application/octet-stream': { url: 'http://cdn.test/original' } }, web_content_link: 'https://cdn.test/account-secret' }))
    await assert.rejects(createPikPakProvider({}, { accessToken: 'account-secret' }).getDownloadUrl('file'), /download_link_unavailable/)
  } finally { globalThis.fetch = originalFetch }
})
