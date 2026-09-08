'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const zlib=require('node:zlib');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const {inspect,targetSize}=require('../service/public/image-info');

function segment(marker,payload){const out=Buffer.alloc(payload.length+4);out[0]=255;out[1]=marker;out.writeUInt16BE(payload.length+2,2);payload.copy(out,4);return out;}
function exif(orientation,little=true){
  const t=Buffer.alloc(26);t.write(little?'II':'MM',0,'ascii');
  const u16=(v,o)=>little?t.writeUInt16LE(v,o):t.writeUInt16BE(v,o),u32=(v,o)=>little?t.writeUInt32LE(v,o):t.writeUInt32BE(v,o);
  u16(42,2);u32(8,4);u16(1,8);u16(0x112,10);u16(3,12);u32(1,14);u16(orientation,18);u32(0,22);
  return segment(0xe1,Buffer.concat([Buffer.from('Exif\0\0','ascii'),t]));
}
function jpeg(w,h,orientation=null,little=true,progressive=false){
  const sof=Buffer.from([8,0,0,0,0,3,1,0x11,0,2,0x11,0,3,0x11,0]);sof.writeUInt16BE(h,1);sof.writeUInt16BE(w,3);
  return Buffer.concat([Buffer.from([255,216]),...(orientation===null?[]:[exif(orientation,little)]),segment(progressive?0xc2:0xc0,sof),segment(0xda,Buffer.from([3,1,0,2,0,3,0,0,63,0])),Buffer.from([0,255,217])]);
}
function crc32(data){let crc=0xffffffff;for(const v of data){crc^=v;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function chunk(name,data){const type=Buffer.from(name),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length,0);type.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([type,data])),data.length+8);return out;}
function png(w,h,animated=false){
  const hdr=Buffer.alloc(13);hdr.writeUInt32BE(w,0);hdr.writeUInt32BE(h,4);hdr[8]=8;hdr[9]=6;
  const animation=Buffer.alloc(8);animation.writeUInt32BE(2,0);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',hdr),...(animated?[chunk('acTL',animation)]:[]),chunk('IDAT',zlib.deflateSync(Buffer.from([0,255,255,255,255]))),chunk('IEND',Buffer.alloc(0))]);
}
function webpChunk(name,data){const b=Buffer.alloc(8+data.length+(data.length%2));b.write(name,0,'ascii');b.writeUInt32LE(data.length,4);data.copy(b,8);return b;}
function webp(w,h,kind='VP8 ',animated=false){
  let payload;
  if(kind==='VP8 '){payload=Buffer.from([0x10,0,0,0x9d,1,0x2a,0,0,0,0]);payload.writeUInt16LE(w,6);payload.writeUInt16LE(h,8);}
  else if(kind==='VP8L'){payload=Buffer.alloc(5);payload[0]=0x2f;payload.writeUInt32LE(((w-1)|((h-1)<<14))>>>0,1);}
  else{payload=Buffer.alloc(10);payload[0]=animated?2:0;payload.writeUIntLE(w-1,4,3);payload.writeUIntLE(h-1,7,3);}
  const body=Buffer.concat([Buffer.from('WEBP'),webpChunk(kind,payload),...(animated?[webpChunk('ANIM',Buffer.alloc(6))]:kind==='VP8X'?[webp(w,h,'VP8 ').subarray(12)]:[])]),out=Buffer.alloc(8);out.write('RIFF');out.writeUInt32LE(body.length,4);return Buffer.concat([out,body]);
}
function read(data,total=data.length){return inspect(new Uint8Array(data.buffer,data.byteOffset,data.byteLength),total);}

test('JPEG headers preserve encoded dimensions and parse all eight EXIF orientations in both byte orders',()=>{
  for(const little of [true,false])for(let orientation=1;orientation<=8;orientation++){
    const info=read(jpeg(5856,8784,orientation,little));assert.equal(info.width,5856);assert.equal(info.height,8784);assert.equal(info.orientation,orientation);assert.equal(info.mime,'image/jpeg');assert.equal(info.animated,false);
  }
});
test('baseline and progressive JPEG without EXIF use orientation one and honor typed-array offsets',()=>{
  for(const progressive of [false,true]){const original=jpeg(2400,1350,null,true,progressive);const wrapped=Buffer.concat([Buffer.alloc(17,9),original,Buffer.alloc(9)]);const info=read(wrapped.subarray(17,17+original.length));assert.equal(info.width,2400);assert.equal(info.height,1350);assert.equal(info.orientation,1);}
});
test('JPEG rejects missing dimensions, zero dimensions, truncated segments and invalid segment lengths',()=>{
  for(const data of [Buffer.from([255,216,255,217]),jpeg(0,100),jpeg(100,0),jpeg(100,100).subarray(0,10),Buffer.from([255,216,255,225,0,1,255,217])])assert.throws(()=>read(data));
});
test('JPEG rejects empty or inconsistent frame and scan component headers',()=>{
  const sof=Buffer.from([8,0,10,0,10,0]);
  const zeroComponents=Buffer.concat([Buffer.from([255,216]),segment(0xc0,sof),segment(0xda,Buffer.from([0,0,63,0])),Buffer.from([0,255,217])]);
  const valid=jpeg(100,100),sos=valid.indexOf(Buffer.from([255,218]));
  const emptyScan=Buffer.concat([valid.subarray(0,sos),segment(0xda,Buffer.alloc(0)),Buffer.from([0,255,217])]);
  const mismatch=Buffer.from(valid);mismatch[sos+4]=4;
  for(const data of [zeroComponents,emptyScan,mismatch])assert.throws(()=>read(data));
});
test('PNG reads a real one-pixel image and detects APNG before image data',()=>{
  const info=read(png(1,1));assert.deepEqual({width:info.width,height:info.height,orientation:info.orientation,mime:info.mime,animated:info.animated},{width:1,height:1,orientation:1,mime:'image/png',animated:false});
  assert.equal(read(png(1,1,true)).animated,true);
});
test('PNG rejects truncated IHDR, invalid first chunk, zero dimensions and impossible chunk lengths',()=>{
  const invalidFirst=png(1,1);invalidFirst.write('IDAT',12,'ascii');
  const invalidLength=png(1,1);invalidLength.writeUInt32BE(0xffffffff,8);
  for(const data of [png(1,1).subarray(0,24),invalidFirst,png(0,1),png(1,0),invalidLength])assert.throws(()=>read(data));
});
test('PNG rejects undefined color types and invalid bit-depth combinations',()=>{
  for(const [depth,color]of [[8,1],[8,5],[4,2],[1,4],[16,3],[0,6]]){const invalid=png(1,1);invalid[24]=depth;invalid[25]=color;assert.throws(()=>read(invalid));}
});
test('WebP parses lossy VP8, lossless VP8L and extended VP8X dimensions',()=>{
  for(const kind of ['VP8 ','VP8L','VP8X']){const info=read(webp(321,123,kind));assert.equal(info.width,321);assert.equal(info.height,123);assert.equal(info.orientation,1);assert.equal(info.mime,'image/webp');assert.equal(info.animated,false);}
});
test('WebP extended animation is detected and truncated or impossible RIFF data is rejected',()=>{
  assert.equal(read(webp(320,240,'VP8X',true)).animated,true);
  const invalidSize=webp(100,100);invalidSize.writeUInt32LE(0xffffffff,4);
  const invalidKeyframe=webp(100,100);invalidKeyframe[23]=0;
  for(const data of [webp(100,100).subarray(0,23),invalidSize,invalidKeyframe])assert.throws(()=>read(data));
});
test('WebP extended canvas cannot claim smaller dimensions than its actual encoded bitstream',()=>{
  const forged=webp(3000,3000,'VP8X');forged.writeUIntLE(9,24,3);forged.writeUIntLE(9,27,3);assert.throws(()=>read(forged));
});
test('unsupported signatures and total-file-size inconsistencies cannot pass inspection',()=>{
  for(const data of [Buffer.alloc(0),Buffer.from('GIF89a'),Buffer.from('<svg/>'),Buffer.from('not an image')])assert.throws(()=>read(data));
  const p=png(1,1);assert.throws(()=>read(p,p.length-1));
});
test('image inspection cannot silently accept dimensions hidden beyond its one-MiB header budget',()=>{
  const comments=[];for(let i=0;i<17;i++)comments.push(segment(0xfe,Buffer.alloc(65530)));
  const large=Buffer.concat([Buffer.from([255,216]),...comments,jpeg(10,10).subarray(2)]);
  assert.throws(()=>read(large.subarray(0,1024*1024),large.length));
});
test('target sizing preserves ordinary aspect ratios without upscaling and exactly follows the agreed bound formula',()=>{
  for(const [w,h]of [[5856,8784],[9504,6336],[1920,1080],[100,300],[2400,1350],[8000,8000],[8000,1000],[1000,8000],[16000,4000]]){
    const scale=Math.min(1,Math.max(2400/w,1350/h),4096/w,4096/h,Math.sqrt(9e6/(w*h)));
    const out=targetSize(w,h);assert.deepEqual(out,{width:Math.floor(w*scale),height:Math.floor(h*scale)});assert(out.width<=w&&out.height<=h);assert(out.width<=4096&&out.height<=4096);assert(out.width*out.height<=9e6);
  }
});
test('target sizing rejects nonsensical dimensions and never returns a zero-sized image',()=>{
  for(const [w,h]of [[0,1],[1,0],[-1,100],[100,NaN],[Infinity,100],['100',100],[null,100]])assert.throws(()=>targetSize(w,h));
  for(const [w,h]of [[65535,1],[1,65535]]){let out;try{out=targetSize(w,h);}catch(_e){continue;}assert(out.width>=1&&out.height>=1);assert(out.width<=4096&&out.height<=4096);}
});
test('image inspector also works as a browser-global bundle without Node dependencies',()=>{
  const context=vm.createContext({});vm.runInContext(fs.readFileSync(path.join(__dirname,'../service/public/image-info.js'),'utf8'),context);
  const data=png(1,1);const result=vm.runInContext('StillImageInfo.inspect(new Uint8Array('+JSON.stringify(Array.from(data))+'),'+data.length+')',context);
  assert.equal(result.width,1);assert.equal(result.height,1);assert.equal(result.mime,'image/png');
  const size=vm.runInContext('StillImageInfo.targetSize(5856,8784)',context);assert.equal(size.width,2400);assert.equal(size.height,3600);
});
