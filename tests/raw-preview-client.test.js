import test from 'node:test'
import assert from 'node:assert/strict'
import { loadRawEmbeddedPreview } from '../src/media/raw-preview-client.js'

test('RAW worker client: cancellation before start does no work; cancellation during read terminates and ignores late replies', async () => {
  const controller = new AbortController(); controller.abort()
  let created = 0
  await assert.rejects(loadRawEmbeddedPreview({sizeBytes:100,path:'/api/storage-download'}, {signal:controller.signal,workerFactory:()=>{created++}}),/cancelled/)
  assert.equal(created,0)
  const active = new AbortController(); let terminated = 0, started = 0
  const worker = { postMessage(){started++},terminate(){terminated++} }
  const task = loadRawEmbeddedPreview({sizeBytes:100,path:'/api/storage-download'}, {signal:active.signal,workerFactory:()=>worker})
  active.abort(); await assert.rejects(task,/cancelled/)
  worker.onmessage({data:{ok:true,buffer:new ArrayBuffer(10)}})
  assert.equal(terminated,1); assert.equal(started,1)
})

test('RAW worker client: returns only preview data and bounds errors/resources', async () => {
  const worker = { postMessage(){queueMicrotask(()=>this.onmessage({data:{ok:true,buffer:new ArrayBuffer(10),width:4032,height:3024}}))},terminate(){} }
  assert.equal((await loadRawEmbeddedPreview({sizeBytes:100,path:'/api/storage-download'}, {workerFactory:()=>worker})).width,4032)
  await assert.rejects(loadRawEmbeddedPreview({sizeBytes:100_000_000}, {workerFactory:()=>{throw Error('must not start')}}),/size_limit/)
})
