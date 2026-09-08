'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const zlib=require('node:zlib');
const {createBackend,MAX_UPLOAD}=require('../service/backend');
function crc32(data){let crc=0xffffffff;for(const v of data){crc^=v;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function chunk(name,data){const type=Buffer.from(name),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length,0);type.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([type,data])),data.length+8);return out;}
function png(w=2,h=3,animated=false){
  const hdr=Buffer.alloc(13);hdr.writeUInt32BE(w,0);hdr.writeUInt32BE(h,4);hdr[8]=8;hdr[9]=6;
  const animation=Buffer.alloc(8);animation.writeUInt32BE(2,0);
  const pixels=w*h<=100?Buffer.alloc(h*(1+w*4),0):Buffer.from([0,0,0,0,0]);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',hdr),...(animated?[chunk('acTL',animation)]:[]),chunk('IDAT',zlib.deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
function call(port,token,method,route,body){
  const data=body===undefined?undefined:Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
  return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:route,method,agent:false,headers:{Authorization:'Bearer '+token,...(data?{'Content-Type':'application/octet-stream','Content-Length':data.length}:{})}},res=>{const pieces=[];res.on('data',d=>pieces.push(d));res.on('end',()=>{const buffer=Buffer.concat(pieces);let json;try{json=JSON.parse(buffer.toString());}catch(_e){}resolve({status:res.statusCode,buffer,json});});res.on('error',reject);});req.setTimeout(5000,()=>req.destroy(new Error('Request timed out')));req.on('error',reject);req.end(data);});
}
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'still-home-resize-'));
  const opts={demo:true,stateDir:dir,port:0,bind:'127.0.0.1',diskFree:async()=>MAX_UPLOAD*3,platform:{apps:async()=>[],launch:async()=>{}}};let backend=await createBackend(opts);
  const f={dir,get config(){return backend.getConfig();},get token(){return backend.bootstrap().token;},request:(method,route,body,token)=>call(backend.server.address().port,token||f.token,method,route,body),upload:(data,name='photo.png')=>f.request('POST','/api/upload?name='+encodeURIComponent(name),data),restart:async()=>{await backend.close();backend=await createBackend(opts);}};
  t.after(async()=>{await backend.close();await fs.rm(dir,{recursive:true,force:true});});return f;
}
test('real static PNG upload persists encoded dimensions and remains intact across restart',async t=>{
  const f=await fixture(t),data=png();const response=await f.upload(data);assert.equal(response.status,200,JSON.stringify(response.json));
  assert.equal(f.config.wallpaper.width,2);assert.equal(f.config.wallpaper.height,3);assert.equal(f.config.wallpaper.mime,'image/png');assert.deepEqual((await f.request('GET','/media/wallpaper')).buffer,data);
  const saved=f.config.wallpaper;await f.restart();assert.deepEqual(f.config.wallpaper,saved);assert.deepEqual((await f.request('GET','/media/wallpaper')).buffer,data);
});
test('oversized image dimensions and decoded pixel area are rejected without changing previous media or revision',async t=>{
  const f=await fixture(t),original=png();assert.equal((await f.upload(original)).status,200);const saved=f.config.wallpaper,revision=f.config.revision;
  for(const [w,h]of [[4097,1],[1,4097],[4096,2198],[5856,8784]]){
    const result=await f.upload(png(w,h),'oversized.png');assert([413,415].includes(result.status),JSON.stringify({w,h,result}));assert.equal(f.config.revision,revision);assert.deepEqual(f.config.wallpaper,saved);assert.deepEqual((await f.request('GET','/media/wallpaper')).buffer,original);
  }
  assert.deepEqual(await fs.readdir(path.join(f.dir,'media')),[saved.id+'.png']);
});
test('animated, malformed and content-extension mismatched images are rejected while existing wallpaper survives',async t=>{
  const f=await fixture(t),original=png();await f.upload(original);const saved=f.config.wallpaper,revision=f.config.revision;
  for(const [data,name]of [[png(2,3,true),'animated.png'],[original.subarray(0,18),'truncated.png'],[Buffer.concat([original.subarray(0,8),Buffer.from('garbage')]),'signature-only.png'],[original,'mismatch.jpg']]){
    const result=await f.upload(data,name);assert([400,413,415].includes(result.status),JSON.stringify(result.json));assert.equal(f.config.revision,revision);assert.deepEqual(f.config.wallpaper,saved);
  }
  assert.deepEqual((await f.request('GET','/media/wallpaper')).buffer,original);
});
test('new image validation preserves MP4 support and does not attach image dimensions to video',async t=>{
  const f=await fixture(t),mp4=Buffer.from('000000186674797069736f6d0000020069736f6d69736f32','hex');assert.equal((await f.upload(mp4,'aurora.mp4')).status,200);assert.equal(f.config.wallpaper.kind,'video');assert.equal(f.config.wallpaper.width,undefined);assert.equal(f.config.wallpaper.height,undefined);
});
test('Ken Burns preference defaults off, accepts booleans only, and persists independently of wallpaper changes',async t=>{
  const f=await fixture(t);assert.equal(f.config.kenBurns,false);
  for(const value of ['true',1,null,{},[]])assert.equal((await f.request('PATCH','/api/config',{revision:0,kenBurns:value})).status,400);
  assert.equal((await f.request('PATCH','/api/config',{revision:0,kenBurns:true})).status,200);await f.upload(png());assert.equal(f.config.kenBurns,true);await f.restart();assert.equal(f.config.kenBurns,true);assert.equal(f.config.wallpaper.width,2);
  assert.equal((await f.request('PATCH','/api/config',{revision:f.config.revision,kenBurns:false})).status,200);assert.equal(f.config.kenBurns,false);
});
test('paired phone can toggle Ken Burns and concurrent preference writes retain conflict protection',async t=>{
  const f=await fixture(t),p=await f.request('POST','/api/pairing',{}),phone=await f.request('POST','/api/pair',{code:p.json.code});assert.equal(phone.status,200);
  const results=await Promise.all([f.request('PATCH','/api/config',{revision:0,kenBurns:true},phone.json.token),f.request('PATCH','/api/config',{revision:0,textShade:0.4})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(f.config.revision,1);
});
test('legacy saved settings migrate Ken Burns off without requiring dimensions on an existing wallpaper',async t=>{
  const f=await fixture(t);await f.upload(png());const legacy=JSON.parse(JSON.stringify(f.config));delete legacy.kenBurns;delete legacy.wallpaper.width;delete legacy.wallpaper.height;
  await fs.writeFile(path.join(f.dir,'config.json'),JSON.stringify(legacy));await f.restart();assert.equal(f.config.kenBurns,false);assert.equal(f.config.revision,legacy.revision);assert.equal(f.config.wallpaper.id,legacy.wallpaper.id);assert.equal((await f.request('GET','/api/state')).json.warning,null);
});
test('legacy oversized wallpaper cannot be served as raw image bytes and remains preserved for recovery',async t=>{
  const f=await fixture(t);await f.upload(png());
  const old=JSON.parse(JSON.stringify(f.config)),unsafe=png(5856,8784);delete old.wallpaper.width;delete old.wallpaper.height;old.wallpaper.size=unsafe.length;
  const media=path.join(f.dir,'media',old.wallpaper.id+'.png'),configFile=path.join(f.dir,'config.json');
  await fs.writeFile(media,unsafe);await fs.writeFile(configFile,JSON.stringify(old));const configBefore=await fs.readFile(configFile);await f.restart();
  for(const method of ['GET','HEAD']){const result=await f.request(method,'/media/wallpaper');assert.equal(result.status,413);assert(!result.buffer.equals(unsafe));}
  assert.deepEqual(await fs.readFile(media),unsafe);assert.deepEqual(await fs.readFile(configFile),configBefore);assert.equal(f.config.wallpaper.id,old.wallpaper.id);assert.equal(f.config.revision,old.revision);
  assert.equal((await f.upload(png(),'resized-copy.png')).status,200);assert.equal(f.config.wallpaper.width,2);assert.equal((await f.request('GET','/media/wallpaper')).status,200);
});
