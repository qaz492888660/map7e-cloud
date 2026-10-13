import test from 'node:test'
import assert from 'node:assert/strict'
import { logPikPakDownloadFailure } from '../lib/storage/pikpak-download-diagnostic.js'

test('PikPak download diagnostics expose only bounded structure and fixed reasons', () => {
  const records = []
  logPikPakDownloadFailure({ id: 'private-id', name: 'private-name', parent_id: 'private-parent',
    web_content_link: 'https://cdn.test/file?access_token=private-access',
    download_url: 'https://cdn.test/file?signature=private-signature',
    links: { 'text/plain': { url: 'https://cdn.test/private-url' }, 'private-token': { url: 'private-link' } },
    file: { access_token: 'private-access' }, error: 'private-upstream-error',
  }, { status: 200, unsafe: true, logger: value => records.push(value) })
  assert.deepEqual(JSON.parse(records[0]), { event: 'pikpak_download_source_unavailable', reason: 'source_rejected',
    upstreamStatus: 200, linkTypes: ['text/plain'], otherLinkTypes: 1,
    hasOctetStreamUrl: false, hasWebContentLink: true, hasDownloadUrl: true, hasFileWrapper: true, hasItemWrapper: false })
  assert.doesNotMatch(records[0], /private|https|signature|access_token/)
  logPikPakDownloadFailure(null, { status: 'private-status', logger: value => records.push(value) })
  assert.equal(JSON.parse(records[1]).reason, 'source_missing')
  assert.equal(Object.hasOwn(JSON.parse(records[1]), 'upstreamStatus'), false)
})

test('PikPak diagnostic logging failures cannot alter the download failure flow', () => {
  assert.doesNotThrow(() => logPikPakDownloadFailure({}, { logger() { throw new Error('log unavailable') } }))
})
