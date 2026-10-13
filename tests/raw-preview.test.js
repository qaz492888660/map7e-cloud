import test from 'node:test'
import assert from 'node:assert/strict'
import { createRawRangeReader, extractRawPreview, RAW_FILE_LIMIT } from '../src/media/raw-preview.js'

function fixture({ little = true, photometric = 6, width = 4032, height = 3024, subIfd = false } = {}) {
  const bytes = new Uint8Array(140000), v = new DataView(bytes.buffer)
  bytes.set(little ? [73, 73] : [77, 77]); v.setUint16(2, 42, little); v.setUint32(4, 8, little)
  const tags = [[254,1],[256,width],[257,height],[259,7],[262,photometric],[273,132000],[274,6],[279,15]]
  const write = (offset, entries) => {
    v.setUint16(offset, entries.length, little)
    entries.forEach(([tag,value],i) => { const p=offset+2+i*12; v.setUint16(p,tag,little); v.setUint16(p+2,4,little); v.setUint32(p+4,1,little); v.setUint32(p+8,value,little) })
  }
  if (subIfd) { write(8, [[330,256],[274,6]]); write(256,tags) } else write(8,tags)
  bytes.set([255,216,255,192,0,11,8,height>>8,height&255,width>>8,width&255,1,1,17,0],132000)
  return bytes
}

test('RAW: selects a rendered full JPEG from little/big endian TIFF and SubIFDs', async () => {
  for (const options of [{}, {little:false}, {subIfd:true}]) {
    const bytes=fixture(options), reads=[]
    const result=await extractRawPreview(async (offset,length)=>{reads.push([offset,length]);return bytes.slice(offset,offset+length)},bytes.length)
    assert.equal(result.width,4032); assert.equal(result.height,3024)
    assert.equal(result.bytes.length,51)
    assert.equal(new DataView(result.bytes.buffer).getUint16(30, true),6, 'IFD orientation is preserved for a JPEG without EXIF')
    assert.ok(reads.some(([offset])=>offset===132000))
    assert.equal(reads.some(([,length])=>length===bytes.length),false)
  }
})

test('RAW: rejects sensor data, oversized/malformed directories and unsupported formats', async () => {
  for (const mutate of [b=>new DataView(b.buffer).setUint16(8,513,true),b=>b.fill(0,0,8)]) {
    const bytes=fixture();mutate(bytes)
    await assert.rejects(extractRawPreview(async(o,n)=>bytes.slice(o,o+n),bytes.length),/raw_preview_/)
  }
  const bytes=fixture({photometric:34892})
  await assert.rejects(extractRawPreview(async(o,n)=>bytes.slice(o,o+n),bytes.length),/jpeg_missing/)
  await assert.rejects(extractRawPreview(()=>{throw Error('must not read')},RAW_FILE_LIMIT+1),/size_limit/)
})

test('RAW: Range reader validates headers/length, caches index reads and emits no URLs', async () => {
  const bytes=fixture(), evidence=[], calls=[]
  const read=createRawRangeReader({url:'/api/storage-download?id=private',fileSize:bytes.length,evidence,fetchImpl:async(url,options)=>{
    calls.push({url,options}); const [,a,b]=/bytes=(\d+)-(\d+)/.exec(options.headers.Range),start=Number(a),end=Number(b)
    return new Response(bytes.slice(start,end+1),{status:206,headers:{'Content-Type':'image/dng','Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Length':String(end-start+1)}})
  }})
  const result=await extractRawPreview(read,bytes.length)
  assert.equal(result.width,4032); assert.equal(calls.length,2)
  assert.equal(calls[0].options.credentials,'include')
  assert.equal(JSON.stringify(evidence).includes('private'),false)
  assert.equal(evidence[1].contentRange,'bytes 132000-132014/140000')
})

test('RAW: rejects ignored/mismatched Range and cleans late or oversized response streams', async () => {
  for (const status of [200,401,403,206]) {
    let cancelled=false
    const read=createRawRangeReader({url:'/api/storage-download',fileSize:100,fetchImpl:async()=>new Response(new ReadableStream({cancel(){cancelled=true}}),{status,headers:{'Content-Range':'bytes 1-9/100'}})})
    await assert.rejects(read(0,10),/raw_preview_/); assert.equal(cancelled,true)
  }
  let cancelled=false
  const read=createRawRangeReader({url:'/api/storage-download',fileSize:100,fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(11))},cancel(){cancelled=true}}),{status:206,headers:{'Content-Range':'bytes 0-9/100'}})})
  await assert.rejects(read(0,10),/size_limit/);assert.equal(cancelled,true)
  const controller=new AbortController(); let calls=0
  const stopped=createRawRangeReader({url:'/api/storage-download',fileSize:100,signal:controller.signal,fetchImpl:async()=>{calls++;controller.abort();return new Response(new ReadableStream({cancel(){cancelled=true}}),{status:206})}})
  await assert.rejects(stopped(0,10));await assert.rejects(stopped(0,10));assert.equal(calls,1)
})
