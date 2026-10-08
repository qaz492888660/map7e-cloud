import test from 'node:test'
import assert from 'node:assert/strict'
import { quarkDownloadLimit, quarkDownloadLimitBody } from '../lib/storage/quark-download-limit.js'

test('Quark size errors require the exact download endpoint, HTTP status, errno and explicit policy', () => {
  const path = '/open/v1/file/get_download_url'
  const payload = { status: -1, errno: 23018, error_info: 'download file size limit[52428800]' }
  assert.equal(quarkDownloadLimit(path, { status: 400 }, payload), 52428800)
  for (const [endpoint, http, body] of [
    ['/open/v1/file/info', 400, payload],
    [path, 200, payload],
    [path, 401, payload],
    [path, 400, { ...payload, errno: 23019 }],
    [path, 400, { ...payload, error_info: 'permission denied' }],
    [path, 400, { ...payload, error_info: 'download file size limit[0]' }],
    [path, 400, { ...payload, error_info: 'download file size limit[-1]' }],
    [path, 400, { ...payload, error_info: 'download file size limit[9999999999999999]' }],
    [path, 400, { ...payload, error_info: 'download file size limit[52428800] private-token' }],
    [path, 400, null],
  ]) assert.equal(quarkDownloadLimit(endpoint, { status: http }, body), null)
  assert.deepEqual(quarkDownloadLimitBody(52428800), {
    ok: false, error: 'quark_file_size_limit', limitBytes: 52428800,
    message: '当前夸克接口限制单文件下载大小为 50 MiB，此文件暂不支持站内播放或下载。',
  })
  assert.deepEqual(quarkDownloadLimitBody(undefined), {
    ok: false, error: 'quark_file_size_limit',
    message: '当前夸克接口限制此文件的下载大小，此文件暂不支持站内播放或下载。',
  })
})
