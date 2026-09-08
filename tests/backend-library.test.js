'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {createBackend,MAX_UPLOAD}=require('../service/backend');
const OFFLINE=process.env.STILL_HOME_TEST_OFFLINE==='1';
const offlineServers=new Map();let offlinePort=18770;
function newRequest(options,callback){return OFFLINE?require('./offline-http').request(offlineServers.get(options.port),options,callback):http.request(options,callback);}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64');
const mp4=Buffer.from('000000186674797069736f6d0000020069736f6d69736f32','hex');
function call(port,token,method,route,body,extra={}){
  const data=body===undefined?undefined:Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
  return new Promise((resolve,reject)=>{const req=newRequest({host:'127.0.0.1',port,path:route,method,agent:false,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(data?{'Content-Type':'application/json','Content-Length':data.length}:{}),...extra}},res=>{const pieces=[];res.on('data',d=>pieces.push(d));res.on('error',reject);res.on('end',()=>{const buffer=Buffer.concat(pieces);let json;try{json=JSON.parse(buffer.toString());}catch(_e){}resolve({status:res.statusCode,headers:res.headers,buffer,json});});});req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('Request timed out')));req.end(data);});
}
async function fixture(t,options={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'still-home-library-'));
  const opts={demo:true,stateDir:dir,port:OFFLINE?offlinePort++:0,listen:!OFFLINE,bind:'127.0.0.1',diskFree:async()=>MAX_UPLOAD*3,platform:{apps:async()=>[],launch:async()=>{}},...options};let backend=await createBackend(opts);if(OFFLINE)offlineServers.set(opts.port,backend.server);
  const f={dir,get port(){return OFFLINE?opts.port:backend.server.address().port;},get token(){return backend.bootstrap().token;},get config(){return backend.getConfig();},request:(method,route,body,token,extra)=>call(f.port,token===undefined?f.token:token,method,route,body,extra),upload:(data=png,name='photo.png')=>f.request('POST','/api/upload?name='+encodeURIComponent(name),data),select:(id,revision=f.config.revision)=>f.request('POST','/api/wallpapers/select',{revision,id}),focal:(id,focalPoint,revision=f.config.revision)=>f.request('POST','/api/wallpapers/focal',{revision,id,focalPoint}),media:(id,headers)=>f.request('GET','/media/library?id='+encodeURIComponent(id),undefined,undefined,headers),restart:async()=>{await backend.close();backend=await createBackend(opts);if(OFFLINE)offlineServers.set(opts.port,backend.server);}};
  t.after(async()=>{await backend.close();if(OFFLINE)offlineServers.delete(opts.port);await fs.rm(dir,{recursive:true,force:true});});return f;
}
async function upload(f,name,data=png){const r=await f.upload(data,name);assert.equal(r.status,200,JSON.stringify(r.json));return r.json.config.wallpaper;}
async function eventually(fn){for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Timed out waiting for upload state');}

test('multiple photos and a video are retained across selecting, reset and restart',async t=>{
  const f=await fixture(t);assert.deepEqual(f.config.wallpaperLibrary,[]);assert.deepEqual(f.config.defaultFocalPoint,require('../service/default-wallpaper.json').focalPoint);
  const a=await upload(f,'first.png'),b=await upload(f,'second.png'),v=await upload(f,'video.mp4',mp4);
  assert.deepEqual(f.config.wallpaperLibrary.map(w=>w.id),[a.id,b.id,v.id]);assert.equal(f.config.wallpaper.id,v.id);
  assert.deepEqual((await fs.readdir(path.join(f.dir,'media'))).sort(),[a.id+'.png',b.id+'.png',v.id+'.mp4'].sort());
  assert.equal((await f.select(a.id)).status,200);assert.equal(f.config.wallpaper.id,a.id);
  assert.equal((await f.select('default')).status,200);assert.equal(f.config.wallpaper,null);assert.equal(f.config.wallpaperLibrary.length,3);
  await f.restart();assert.equal(f.config.wallpaper,null);assert.deepEqual(f.config.wallpaperLibrary.map(w=>w.id),[a.id,b.id,v.id]);
  assert.deepEqual((await f.media(a.id)).buffer,png);assert.deepEqual((await f.media(b.id)).buffer,png);assert.deepEqual((await f.media(v.id)).buffer,mp4);
});
test('PATCH reset preserves all library items while arbitrary library and focal writes are rejected',async t=>{
  const f=await fixture(t),a=await upload(f,'first.png');
  for(const patch of [{wallpaperLibrary:[]},{defaultFocalPoint:{x:0,y:0}},{focalPoint:null}])assert.equal((await f.request('PATCH','/api/config',{revision:f.config.revision,...patch})).status,400);
  assert.equal((await f.request('PATCH','/api/config',{revision:f.config.revision,wallpaper:null})).status,200);assert.equal(f.config.wallpaper,null);assert.equal(f.config.wallpaperLibrary[0].id,a.id);assert.deepEqual((await f.media(a.id)).buffer,png);
});
test('focal points are stored per photo and default, synchronize active snapshots, and survive restart',async t=>{
  const f=await fixture(t),a=await upload(f,'a.png'),b=await upload(f,'b.png');
  assert.equal((await f.focal(a.id,{x:0.25,y:0.75})).status,200);assert.equal(f.config.wallpaper.id,b.id);assert.equal(f.config.wallpaper.focalPoint,null);
  assert.equal((await f.select(a.id)).status,200);assert.deepEqual(f.config.wallpaper.focalPoint,{x:0.25,y:0.75});
  assert.equal((await f.focal(a.id,{x:0,y:1})).status,200);assert.deepEqual(f.config.wallpaper.focalPoint,{x:0,y:1});
  assert.equal((await f.focal('default',{x:1,y:0})).status,200);assert.deepEqual(f.config.defaultFocalPoint,{x:1,y:0});assert.equal(f.config.wallpaper.id,a.id);
  await f.restart();assert.deepEqual(f.config.wallpaper.focalPoint,{x:0,y:1});assert.deepEqual(f.config.defaultFocalPoint,{x:1,y:0});
  assert.equal((await f.focal(a.id,null)).status,200);assert.equal(f.config.wallpaper.focalPoint,null);assert.equal((await f.focal('default',null)).status,200);assert.equal(f.config.defaultFocalPoint,null);
});
test('focal values require finite normalized coordinates and videos reject focal editing',async t=>{
  const f=await fixture(t),a=await upload(f,'a.png'),v=await upload(f,'video.mp4',mp4),revision=f.config.revision;
  for(const point of [{x:-0.1,y:0},{x:1.1,y:0},{x:0,y:-0.1},{x:0,y:1.1},{x:'0.5',y:0},{x:null,y:0},{x:0},{y:0},[],false,0]){
    assert.equal((await f.focal(a.id,point)).status,400,JSON.stringify(point));assert.equal(f.config.revision,revision);
  }
  assert.equal((await f.focal(v.id,{x:0.5,y:0.5})).status,415);assert.equal(f.config.revision,revision);
});
test('unknown selections and focal targets are rejected without changing current wallpaper',async t=>{
  const f=await fixture(t),a=await upload(f,'a.png'),revision=f.config.revision;
  for(const id of ['f'.repeat(32),'../etc/passwd','default/../../etc/passwd','a'.repeat(32)+'.png','']){
    const selection=await f.select(id),focal=await f.focal(id,{x:0,y:0});assert([400,404].includes(selection.status));assert([400,404].includes(focal.status));assert.equal(f.config.wallpaper.id,a.id);assert.equal(f.config.revision,revision);
  }
  assert.equal((await f.select('f'.repeat(32))).status,404);
});
test('simultaneous focal and selection changes return one revision conflict rather than overwriting',async t=>{
  const f=await fixture(t),a=await upload(f,'a.png'),b=await upload(f,'b.png'),revision=f.config.revision;
  const out=await Promise.all([f.focal(a.id,{x:0.2,y:0.3},revision),f.select(a.id,revision)]);assert.deepEqual(out.map(r=>r.status).sort(),[200,409]);assert.equal(f.config.revision,revision+1);assert.equal(out.find(r=>r.status===409).json.config.revision,revision+1);assert.equal(f.config.wallpaperLibrary.length,2);assert(f.config.wallpaperLibrary.some(w=>w.id===b.id));
});
test('an in-flight upload merges a focal update and retains every prior library item',async t=>{
  const f=await fixture(t),a=await upload(f,'a.png');let req;
  const pending=new Promise((resolve,reject)=>{req=newRequest({host:'127.0.0.1',port:f.port,method:'POST',path:'/api/upload?name=second.png',agent:false,headers:{Authorization:'Bearer '+f.token,'Content-Length':png.length}},res=>{let out='';res.setEncoding('utf8');res.on('data',d=>out+=d);res.on('end',()=>resolve({status:res.statusCode,json:JSON.parse(out)}));});req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('Held upload timed out')));req.write(png.subarray(0,16));});
  pending.catch(()=>{});
  try {
    await eventually(async()=> (await fs.readdir(path.join(f.dir,'media'))).some(name=>name.endsWith('.upload')));
    assert.equal((await f.focal(a.id,{x:0.6,y:0.4})).status,200);req.end(png.subarray(16));const result=await pending;assert.equal(result.status,200);
  } finally { if(!req.writableEnded) req.destroy(); }
  assert.equal(f.config.wallpaperLibrary.length,2);assert.deepEqual(f.config.wallpaperLibrary.find(w=>w.id===a.id).focalPoint,{x:0.6,y:0.4});assert.notEqual(f.config.wallpaper.id,a.id);assert.deepEqual((await f.media(a.id)).buffer,png);
});
test('phone credentials allow scoped library selection and focal editing, and media query tokens cannot authorize writes',async t=>{
  const f=await fixture(t),a=await upload(f,'a.png'),pair=await f.request('POST','/api/pairing',{}),p=await f.request('POST','/api/pair',{code:pair.json.code},null),token=p.json.token;
  assert.equal((await f.request('GET','/media/library?id='+a.id,undefined,null)).status,401);
  assert.equal((await f.request('GET','/media/library?id='+a.id+'&token='+token,undefined,null)).status,200);
  assert.equal((await f.request('POST','/api/wallpapers/select',{revision:f.config.revision,id:a.id},token)).status,200);
  assert.equal((await f.request('POST','/api/wallpapers/focal',{revision:f.config.revision,id:a.id,focalPoint:{x:0.2,y:0.8}},token)).status,200);
  assert.equal((await f.request('POST','/api/wallpapers/select?token='+token,{revision:f.config.revision,id:'default'},null)).status,401);
  assert.equal((await f.request('POST','/api/launch',{id:'anything'},token)).status,403);
});
test('cross-origin library writes and rebinding media hosts are blocked',async t=>{
  const f=await fixture(t),a=await upload(f,'a.png'),revision=f.config.revision;
  assert.equal((await f.request('POST','/api/wallpapers/select',{revision,id:'default'},undefined,{Origin:'https://evil.example'})).status,403);
  assert.equal((await f.request('GET','/media/library?id='+a.id,undefined,undefined,{Host:'evil.example:'+f.port})).status,403);assert.equal(f.config.revision,revision);
});
test('library GET and HEAD are read-only and video byte ranges retain exact bytes',async t=>{
  const f=await fixture(t),a=await upload(f,'a.png'),v=await upload(f,'video.mp4',mp4),saved=await fs.readFile(path.join(f.dir,'config.json')),revision=f.config.revision;
  assert.equal((await f.media('default')).status,200);assert.deepEqual((await f.media(a.id)).buffer,png);
  const range=await f.media(v.id,{Range:'bytes=4-11'});assert.equal(range.status,206);assert.deepEqual(range.buffer,mp4.subarray(4,12));assert.equal(range.headers['content-range'],'bytes 4-11/'+mp4.length);
  const head=await f.request('HEAD','/media/library?id='+v.id);assert.equal(head.status,200);assert.equal(head.buffer.length,0);assert.equal(Number(head.headers['content-length']),mp4.length);
  assert.equal(f.config.revision,revision);assert.deepEqual(await fs.readFile(path.join(f.dir,'config.json')),saved);
});
test('legacy active wallpaper migrates in memory without rewriting saved configuration',async t=>{
  const f=await fixture(t),a=await upload(f,'a.png'),legacy=JSON.parse(JSON.stringify(f.config));delete legacy.wallpaperLibrary;delete legacy.defaultFocalPoint;delete legacy.wallpaper.focalPoint;
  await fs.writeFile(path.join(f.dir,'config.json'),JSON.stringify(legacy));const saved=await fs.readFile(path.join(f.dir,'config.json'));await f.restart();
  assert.equal(f.config.wallpaperLibrary.length,1);assert.equal(f.config.wallpaperLibrary[0].id,a.id);assert.equal(f.config.wallpaper.focalPoint,null);assert.deepEqual(f.config.defaultFocalPoint,require('../service/default-wallpaper.json').focalPoint);
  await f.request('GET','/api/state');await f.media(a.id);assert.deepEqual(await fs.readFile(path.join(f.dir,'config.json')),saved);
});
test('safe stored orphans are recovered while unsafe media and unrelated files are retained but unserved',async t=>{
  const f=await fixture(t);await upload(f,'active.png');const media=path.join(f.dir,'media'),safeID='a'.repeat(32),videoID='b'.repeat(32),badID='c'.repeat(32),largeID='d'.repeat(32),tempID='e'.repeat(32);
  const oversized=Buffer.from(png);oversized.writeUInt32BE(6000,16);oversized.writeUInt32BE(9000,20);
  await fs.writeFile(path.join(media,safeID+'.png'),png);await fs.writeFile(path.join(media,videoID+'.mp4'),mp4);await fs.writeFile(path.join(media,badID+'.jpg'),'not an image');await fs.writeFile(path.join(media,largeID+'.png'),oversized);await fs.writeFile(path.join(media,tempID+'.upload'),'interrupted');await fs.writeFile(path.join(media,'personal.png'),png);
  const saved=await fs.readFile(path.join(f.dir,'config.json'));await f.restart();
  assert(f.config.wallpaperLibrary.some(w=>w.id===safeID));assert(f.config.wallpaperLibrary.some(w=>w.id===videoID));assert(!f.config.wallpaperLibrary.some(w=>w.id===badID||w.id===largeID));
  assert.equal((await f.media(badID)).status,404);assert.equal((await f.media(largeID)).status,404);assert.equal((await f.select(largeID)).status,404);
  assert.deepEqual(await fs.readFile(path.join(media,largeID+'.png')),oversized);assert.equal(await fs.readFile(path.join(media,badID+'.jpg'),'utf8'),'not an image');assert.deepEqual(await fs.readFile(path.join(media,'personal.png')),png);
  assert(!(await fs.readdir(media)).includes(tempID+'.upload'));assert.deepEqual(await fs.readFile(path.join(f.dir,'config.json')),saved);
});
test('unsafe legacy active wallpaper stays retained and cannot be selected or served until replaced',async t=>{
  const f=await fixture(t),a=await upload(f,'a.png'),legacy=JSON.parse(JSON.stringify(f.config)),large=Buffer.from(png);large.writeUInt32BE(6000,16);large.writeUInt32BE(9000,20);delete legacy.wallpaperLibrary;delete legacy.defaultFocalPoint;
  await fs.writeFile(path.join(f.dir,'media',a.id+'.png'),large);await fs.writeFile(path.join(f.dir,'config.json'),JSON.stringify(legacy));await f.restart();
  assert(f.config.wallpaperLibrary.some(w=>w.id===a.id));assert.equal((await f.media(a.id)).status,413);assert.equal((await f.select(a.id)).status,413);assert.equal(f.config.wallpaper.id,a.id);assert.equal(f.config.revision,legacy.revision);
  assert.equal((await f.select('default')).status,200);assert.equal(f.config.wallpaper,null);assert.deepEqual(await fs.readFile(path.join(f.dir,'media',a.id+'.png')),large);
});
test('full storage rejects another upload without purging retained library assets',async t=>{
  let available=MAX_UPLOAD*3;const f=await fixture(t,{diskFree:async()=>available}),a=await upload(f,'a.png'),b=await upload(f,'b.png'),revision=f.config.revision;available=1;
  assert.equal((await f.upload(png,'third.png')).status,507);assert.equal(f.config.revision,revision);assert.deepEqual(f.config.wallpaperLibrary.map(w=>w.id),[a.id,b.id]);assert.deepEqual((await f.media(a.id)).buffer,png);assert.deepEqual((await f.media(b.id)).buffer,png);
});
test('corrupted library configuration preserves every file and refuses mutating endpoints',async t=>{
  const f=await fixture(t),a=await upload(f,'a.png');await fs.writeFile(path.join(f.dir,'media','f'.repeat(32)+'.upload'),'unfinished');const before=(await fs.readdir(path.join(f.dir,'media'))).sort();
  await fs.writeFile(path.join(f.dir,'config.json'),'corrupt config');await f.restart();
  assert.match((await f.request('GET','/api/state')).json.warning,/Recovery/);assert.equal((await f.select('default')).status,500);assert.deepEqual((await fs.readdir(path.join(f.dir,'media'))).sort(),before);assert.deepEqual(await fs.readFile(path.join(f.dir,'media',a.id+'.png')),png);
});
test('structured corrupt library metadata is surfaced instead of silently losing saved entries',async t=>{
  const f=await fixture(t),a=await upload(f,'a.png'),valid=JSON.parse(JSON.stringify(f.config));
  for(const library of [{},'invalid',[{}],[a,a],[{...a,focalPoint:{x:2,y:0}}]]){
    await fs.writeFile(path.join(f.dir,'config.json'),JSON.stringify({...valid,wallpaperLibrary:library}));await f.restart();
    assert.match((await f.request('GET','/api/state')).json.warning,/Recovery/);assert.equal((await f.select('default')).status,500);assert.deepEqual(await fs.readFile(path.join(f.dir,'media',a.id+'.png')),png);
  }
});
test('generated-name symlinks are not recovered or served even with saved video metadata',async t=>{
  const f=await fixture(t);await upload(f,'active.png');
  const externalPhoto=path.join(f.dir,'outside-media.png'),externalData=path.join(f.dir,'outside-media.dat'),photoID='a'.repeat(32),videoID='b'.repeat(32),secret=Buffer.from('private fixture outside media');
  await fs.writeFile(externalPhoto,png);await fs.writeFile(externalData,secret);await fs.symlink(externalPhoto,path.join(f.dir,'media',photoID+'.png'));await f.restart();
  assert(!f.config.wallpaperLibrary.some(w=>w.id===photoID));assert.equal((await f.media(photoID)).status,404);
  await fs.symlink(externalData,path.join(f.dir,'media',videoID+'.mp4'));
  const video={id:videoID,name:'old-video.mp4',kind:'video',mime:'video/mp4',size:secret.length,focalPoint:null};
  await fs.writeFile(path.join(f.dir,'config.json'),JSON.stringify({...f.config,wallpaper:video,wallpaperLibrary:f.config.wallpaperLibrary.concat([video])}));await f.restart();
  for(const response of [await f.media(videoID),await f.request('GET','/media/wallpaper'),await f.select(videoID)]){assert([403,404].includes(response.status));assert(!response.buffer.equals(secret));}
  assert.equal(await fs.readlink(path.join(f.dir,'media',videoID+'.mp4')),externalData);assert.deepEqual(await fs.readFile(externalData),secret);
});
test('the default library photo also receives a header safety check before bytes are served',async t=>{
  const assets=await fs.mkdtemp(path.join(os.tmpdir(),'still-home-library-default-'));t.after(()=>fs.rm(assets,{recursive:true,force:true}));
  function segment(marker,payload){const b=Buffer.alloc(payload.length+4);b[0]=255;b[1]=marker;b.writeUInt16BE(payload.length+2,2);payload.copy(b,4);return b;}
  const sof=Buffer.from([8,0,0,0,0,3,1,0x11,0,2,0x11,0,3,0x11,0]);sof.writeUInt16BE(9000,1);sof.writeUInt16BE(6000,3);
  const unsafe=Buffer.concat([Buffer.from([255,216]),segment(0xc0,sof),segment(0xda,Buffer.from([3,1,0,2,0,3,0,0,63,0])),Buffer.from([0,255,217])]),bundledPhoto=path.join(assets,'wallpaper.jpg');await fs.writeFile(bundledPhoto,unsafe);
  const f=await fixture(t,{bundledPhoto}),response=await f.media('default');assert.equal(response.status,413);assert(!response.buffer.equals(unsafe));assert.equal(f.config.wallpaper,null);assert.equal(f.config.revision,0);assert.deepEqual(await fs.readFile(bundledPhoto),unsafe);
});
