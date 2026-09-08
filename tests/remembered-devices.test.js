'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {createBackend}=require('../service/backend');
const {DAY,YEAR}=require('../service/remembered-devices');
const transport=require('./offline-http');
const PORT=1877;
const bearer=token=>({Authorization:'Bearer '+token});
const cookieHeader=response=>response.headers['set-cookie'];
const cookie=response=>cookieHeader(response).split(';')[0];
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'still-home-remembered-'));
  let time=Date.now(),backend;
  async function start(){backend=await createBackend({stateDir:dir,listen:false,port:PORT,demo:true,now:()=>time,platform:{apps:async()=>[],launch:async()=>{}}});}
  await start();
  t.after(async()=>{await backend.close();await fs.rm(dir,{recursive:true,force:true});});
  const f={dir,get server(){return backend.server;},get token(){return backend.bootstrap().token;},get config(){return backend.getConfig();},get now(){return time;},advance(milliseconds){time+=milliseconds;},
    async restart(){await backend.close();await start();},
    call(method,route,body,headers={}){
      const data=body===undefined?undefined:Buffer.from(JSON.stringify(body));
      return new Promise((resolve,reject)=>{
        const req=transport.request(backend.server,{port:PORT,method,path:route,headers:{...(data?{'Content-Length':data.length,'Content-Type':'application/json'}:{}),...headers}},res=>{
          const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>{const buffer=Buffer.concat(chunks);let json=null;try{json=JSON.parse(buffer.toString());}catch(_e){}resolve({status:res.statusCode,headers:res.headers,json,buffer});});
        });req.on('error',reject);req.end(data);
      });
    },
    tv(method,route,body,headers={}){return f.call(method,route,body,{...bearer(f.token),...headers});},
    async code(){const r=await f.tv('POST','/api/pairing',{});assert.equal(r.status,200);return r.json.code;},
    async pair(body={},headers={}){return f.call('POST','/api/pair',{code:await f.code(),...body},headers);},
    async devices(){const r=await f.tv('GET','/api/devices');assert.equal(r.status,200);return r.json.devices;},
    async disk(){return fs.readFile(path.join(dir,'devices.json'),'utf8');}
  };return f;
}
function heldRequest(f,method,route,token,headers={}){
  let request;
  const result=new Promise((resolve,reject)=>{
    request=transport.request(f.server,{port:PORT,method,path:route,headers:{...bearer(token),...headers}},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);
      response.on('end',()=>resolve({status:response.statusCode,json:JSON.parse(Buffer.concat(chunks).toString())}));
    });request.on('error',reject);
  });
  return {request,result};
}

test('legacy pairing stays temporary; no device file or persistent cookie is created',async t=>{
  const f=await fixture(t),paired=await f.pair();
  assert.equal(paired.status,200);assert.equal(paired.json.remembered,false);assert.equal(paired.json.deviceId,null);
  assert.equal(cookieHeader(paired),undefined);assert.equal(paired.json.expiresAt,f.now+1800000);
  assert.equal((await f.call('GET','/api/state',undefined,bearer(paired.json.token))).status,200);
  await assert.rejects(f.disk(),e=>e.code==='ENOENT');
  const tv=f.token;await f.restart();
  assert.equal((await f.call('GET','/api/state',undefined,bearer(paired.json.token))).status,401);
  assert.equal((await f.call('GET','/api/state',undefined,bearer(tv))).status,401);
  assert.equal(f.config.revision,0);
});

test('remembered pairing stores only a hash and safe metadata, with an HttpOnly private cookie',async t=>{
  const f=await fixture(t);
  await f.tv('PATCH','/api/config',{revision:0,clock24:true});
  const before=await fs.readFile(path.join(f.dir,'config.json'),'utf8');
  const paired=await f.pair({remember:true,name:'Tom’s iPhone'});
  assert.equal(paired.status,200);assert.equal(paired.json.remembered,true);assert.match(paired.json.deviceId,/^[a-f0-9]{32}$/);
  assert.match(cookieHeader(paired),/^stillhome_device=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=31536000$/);
  assert.equal(paired.headers['cache-control'],'private, no-store');
  const credential=cookie(paired).split('=')[1];
  assert.notEqual(credential,paired.json.token);assert.equal(JSON.stringify(paired.json).includes(credential),false);
  const raw=await f.disk(),saved=JSON.parse(raw);
  assert.equal(raw.includes(credential),false);assert.equal(raw.includes(paired.json.token),false);assert.equal(raw.includes(f.token),false);
  assert.deepEqual(saved.devices,[{id:paired.json.deviceId,credentialHash:crypto.createHash('sha256').update(credential).digest('hex'),name:'Tom’s iPhone',createdAt:f.now,expiresAt:f.now+YEAR,lastUsed:f.now}]);
  assert.equal((await fs.stat(path.join(f.dir,'devices.json'))).mode&0o777,0o600);
  assert.equal((await fs.readdir(f.dir)).some(name=>name.endsWith('.tmp')),false);
  const listed=await f.devices();assert.deepEqual(Object.keys(listed[0]).sort(),['createdAt','expiresAt','id','lastUsed','name']);
  assert.equal(JSON.stringify(listed).includes(saved.devices[0].credentialHash),false);
  assert.equal(await fs.readFile(path.join(f.dir,'config.json'),'utf8'),before);assert.equal(f.config.revision,1);
});

test('a simulated closed browser resumes from its cookie after backend restart with a new bearer',async t=>{
  const f=await fixture(t),paired=await f.pair({remember:true,name:'Safari'});
  // Simulate closing the browser: only its persistent cookie jar survives.
  const reopenedContext={Cookie:cookie(paired)},oldBearer=paired.json.token;
  await f.restart();
  assert.equal((await f.call('GET','/api/state',undefined,bearer(oldBearer))).status,401);
  assert.equal((await f.call('GET','/api/state',undefined,reopenedContext)).status,401);
  const session=await f.call('POST','/api/session',{},reopenedContext);
  assert.equal(session.status,200);assert.equal(session.json.deviceId,paired.json.deviceId);assert.equal(session.json.remembered,true);
  assert.notEqual(session.json.token,oldBearer);assert.equal(cookie(session),reopenedContext.Cookie);
  assert.equal((await f.call('GET','/api/state',undefined,bearer(session.json.token))).status,200);
  assert.equal(JSON.stringify(session.json).includes(reopenedContext.Cookie.split('=')[1]),false);
});

test('copied Safari and Home Screen cookie contexts get independent sessions, revoked together',async t=>{
  const f=await fixture(t),paired=await f.pair({remember:true,name:'iPhone'});
  // Models iOS 17.2+ cookie copying; this is not a physical-iPhone browser test.
  const safari={Cookie:cookie(paired)},homeScreen={Cookie:cookie(paired)};
  const a=await f.call('POST','/api/session',{},safari),b=await f.call('POST','/api/session',{},homeScreen);
  assert.equal(a.status,200);assert.equal(b.status,200);assert.notEqual(a.json.token,b.json.token);assert.equal(a.json.deviceId,b.json.deviceId);
  assert.equal((await f.devices()).length,1);
  const revoked=await f.tv('POST','/api/devices/revoke',{id:paired.json.deviceId},{Origin:'null'});
  assert.equal(revoked.status,200);
  for(const token of [paired.json.token,a.json.token,b.json.token])assert.equal((await f.call('GET','/api/state',undefined,bearer(token))).status,401);
  for(const context of [safari,homeScreen])assert.equal((await f.call('POST','/api/session',{},context)).status,401);
  await f.restart();assert.equal((await f.call('POST','/api/session',{},safari)).status,401);assert.deepEqual(await f.devices(),[]);
});

test('activity renews the one-year expiry while activity-only disk writes occur at most daily',async t=>{
  const f=await fixture(t),paired=await f.pair({remember:true});
  const headers={Cookie:cookie(paired)},initial=await f.disk(),created=f.now;
  f.advance(6*60*60*1000);
  const first=await f.call('POST','/api/session',{},headers);assert.equal(first.status,200);assert.equal(await f.disk(),initial);
  assert.equal((await f.devices())[0].lastUsed,f.now);assert.equal((await f.devices())[0].expiresAt,f.now+YEAR);
  f.advance(18*60*60*1000);
  const daily=await f.call('POST','/api/session',{},headers);assert.equal(daily.status,200);
  const refreshed=JSON.parse(await f.disk()).devices[0];assert.equal(refreshed.createdAt,created);assert.equal(refreshed.lastUsed,f.now);assert.equal(refreshed.expiresAt,f.now+YEAR);
  const saved=await f.disk();f.advance(1000);await f.call('POST','/api/session',{},headers);assert.equal(await f.disk(),saved);
  await f.restart();assert.equal((await f.call('POST','/api/session',{},headers)).status,200);
  assert.equal(f.config.revision,0);
});

test('short-lived bearers expire and remembered credentials fail closed after their expiry',async t=>{
  const f=await fixture(t),paired=await f.pair({remember:true}),headers={Cookie:cookie(paired)};
  f.advance(1800000);
  assert.equal((await f.call('GET','/api/state',undefined,bearer(paired.json.token))).status,401);
  const newSession=await f.call('POST','/api/session',{},headers);assert.equal(newSession.status,200);
  f.advance(YEAR+1);
  const expired=await f.call('POST','/api/session',{},headers);assert.equal(expired.status,401);assert.match(cookieHeader(expired),/Max-Age=0$/);
  assert.equal((await f.call('GET','/api/state',undefined,bearer(newSession.json.token))).status,401);assert.deepEqual(await f.devices(),[]);
  await f.restart();assert.equal((await f.call('POST','/api/session',{},headers)).status,401);
});

test('an already connected phone can be remembered, and forgetting by bearer revokes every alias',async t=>{
  const f=await fixture(t),temporary=await f.pair();
  const remembered=await f.call('POST','/api/session/remember',{name:'Living room iPad'},bearer(temporary.json.token));
  assert.equal(remembered.status,200);assert.equal(remembered.json.remembered,true);
  assert.equal((await f.call('GET','/api/state',undefined,bearer(temporary.json.token))).status,401);
  const session=await f.call('POST','/api/session',{}, {Cookie:cookie(remembered)});
  const forgotten=await f.call('POST','/api/session/forget',{},bearer(remembered.json.token));
  assert.equal(forgotten.status,200);assert.deepEqual(forgotten.json,{ok:true,remembered:false,deviceId:null});assert.match(cookieHeader(forgotten),/Max-Age=0$/);
  for(const token of [remembered.json.token,session.json.token])assert.equal((await f.call('GET','/api/state',undefined,bearer(token))).status,401);
  assert.equal((await f.call('POST','/api/session',{}, {Cookie:cookie(remembered)})).status,401);assert.deepEqual(await f.devices(),[]);
});

test('forget accepts a valid cookie without a bearer and also disconnects a temporary session',async t=>{
  const f=await fixture(t),paired=await f.pair({remember:true});
  assert.equal((await f.call('POST','/api/session/forget',{}, {Cookie:cookie(paired)})).status,200);
  assert.equal((await f.call('GET','/api/state',undefined,bearer(paired.json.token))).status,401);
  await f.restart();assert.equal((await f.call('POST','/api/session',{}, {Cookie:cookie(paired)})).status,401);
  const temporary=await f.pair();assert.equal((await f.call('POST','/api/session/forget',{},bearer(temporary.json.token))).status,200);
  assert.equal((await f.call('GET','/api/state',undefined,bearer(temporary.json.token))).status,401);
  const repeat=await f.call('POST','/api/session/forget',{},bearer(temporary.json.token));
  assert.equal(repeat.status,200);assert.equal(repeat.json.remembered,false);assert.match(cookieHeader(repeat),/Max-Age=0$/);
});

test('re-pairing replaces a remembered record; opting out revokes it and clears its cookie',async t=>{
  const f=await fixture(t),first=await f.pair({remember:true,name:'iPhone'});
  const second=await f.pair({remember:true,name:'Renamed iPhone'},{Cookie:cookie(first)});
  assert.equal(second.status,200);assert.notEqual(second.json.deviceId,first.json.deviceId);assert.notEqual(cookie(second),cookie(first));
  assert.equal((await f.devices()).length,1);assert.equal((await f.devices())[0].name,'Renamed iPhone');
  assert.equal((await f.call('GET','/api/state',undefined,bearer(first.json.token))).status,401);
  assert.equal((await f.call('POST','/api/session',{}, {Cookie:cookie(first)})).status,401);
  const temporary=await f.pair({remember:false},{Cookie:cookie(second)});
  assert.equal(temporary.status,200);assert.equal(temporary.json.remembered,false);assert.match(cookieHeader(temporary),/Max-Age=0$/);
  assert.equal((await f.call('GET','/api/state',undefined,bearer(second.json.token))).status,401);
  assert.equal((await f.call('GET','/api/state',undefined,bearer(temporary.json.token))).status,200);assert.deepEqual(await f.devices(),[]);
});

test('cookie endpoints enforce origin and host checks while TV-only management enforces bearer scope',async t=>{
  const f=await fixture(t),paired=await f.pair({remember:true}),headers={Cookie:cookie(paired),...bearer(paired.json.token)};
  for(const route of ['/api/pair','/api/session','/api/session/remember','/api/session/forget']){
    for(const extra of [{Origin:'null'},{Origin:'http://foreign.example'},{Host:'foreign.example:'+PORT}]){
      const r=await f.call('POST',route,{code:'123456'},{...headers,...extra});assert.equal(r.status,403,route+JSON.stringify(extra));
    }
    assert.equal((await f.call('OPTIONS',route,undefined,{Origin:'null'})).status,403);
  }
  assert.equal((await f.call('GET','/api/devices',undefined,headers)).status,403);
  assert.equal((await f.call('POST','/api/devices/revoke',{id:paired.json.deviceId},headers)).status,403);
  assert.equal((await f.tv('POST','/api/session/remember',{})).status,403);
  assert.equal((await f.call('GET','/api/devices',undefined,{Cookie:cookie(paired)})).status,401);
  assert.equal((await f.call('POST','/api/session',{}, {Cookie:cookie(paired),Origin:'http://127.0.0.1:'+PORT})).status,200);
  assert.equal((await f.call('POST','/api/session',{}, {Cookie:cookie(paired)})).status,200);
  assert.equal((await f.call('POST','/api/session',{}, {Cookie:'stillhome_device='+'0'.repeat(64)})).status,401);
  assert.equal((await f.call('POST','/api/session',{}, {Cookie:cookie(paired)+'; '+cookie(paired)})).status,401);
  assert.equal((await f.tv('POST','/api/devices/revoke',{id:'bad'})).status,400);
  assert.equal((await f.tv('POST','/api/devices/revoke',{id:'0'.repeat(32)})).status,404);
  assert.equal((await f.devices()).length,1);
});

test('corrupted credential stores are preserved and disable remembering without blocking temporary pairing',async t=>{
  const f=await fixture(t),paired=await f.pair({remember:true}),saved=JSON.parse(await f.disk());
  for(const corrupted of ['broken JSON',JSON.stringify({...saved,rawToken:'unrecognized field'}),JSON.stringify({version:1,devices:[{...saved.devices[0],credentialHash:'bad'}]})]){
    await fs.writeFile(path.join(f.dir,'devices.json'),corrupted);await f.restart();
    assert.equal((await f.tv('GET','/api/devices')).status,503);
    assert.equal((await f.call('POST','/api/session',{}, {Cookie:cookie(paired)})).status,503);
    assert.equal((await f.pair({remember:true})).status,503);
    const temporary=await f.pair({}, {Cookie:cookie(paired)});assert.equal(temporary.status,200);assert.equal(temporary.json.remembered,false);assert.match(cookieHeader(temporary),/Max-Age=0$/);
    assert.equal((await f.call('POST','/api/session/remember',{},bearer(temporary.json.token))).status,503);
    assert.equal((await f.call('GET','/api/state',undefined,bearer(temporary.json.token))).status,200);
    assert.equal((await f.call('POST','/api/session/forget',{},bearer(temporary.json.token))).status,200);
    assert.equal(await f.disk(),corrupted);assert.equal(f.config.revision,0);
  }
});

test('twenty remembered devices are supported, replacements do not consume another slot',async t=>{
  const f=await fixture(t),paired=[];
  for(let index=0;index<20;index++){const p=await f.pair({remember:true,name:'Phone '+index});assert.equal(p.status,200);paired.push(p);}
  assert.equal((await f.devices()).length,20);assert.equal((await f.pair({remember:true})).status,429);
  const replacement=await f.pair({remember:true,name:'Replacement'},{Cookie:cookie(paired[0])});assert.equal(replacement.status,200);assert.equal((await f.devices()).length,20);
  assert.equal((await f.tv('POST','/api/devices/revoke',{id:paired[1].json.deviceId})).status,200);
  assert.equal((await f.pair({remember:true})).status,200);assert.equal((await f.devices()).length,20);
  await f.restart();assert.equal((await f.devices()).length,20);
});

test('a pairing code remains one-time under concurrent durable enrollment',async t=>{
  const f=await fixture(t),code=await f.code();
  const results=await Promise.all([f.call('POST','/api/pair',{code,remember:true,name:'First'}),f.call('POST','/api/pair',{code,remember:true,name:'Second'})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,401]);assert.equal((await f.devices()).length,1);
  assert.equal(JSON.parse(await f.disk()).devices.length,1);
});

test('concurrent cookie resume and revocation cannot leave an authorized orphan bearer',async t=>{
  const f=await fixture(t),paired=await f.pair({remember:true}),headers={Cookie:cookie(paired)};
  const [session,revoke]=await Promise.all([f.call('POST','/api/session',{},headers),f.tv('POST','/api/devices/revoke',{id:paired.json.deviceId})]);
  assert.equal(revoke.status,200);assert.ok([200,401].includes(session.status));
  if(session.status===200)assert.equal((await f.call('GET','/api/state',undefined,bearer(session.json.token))).status,401);
  assert.equal((await f.call('GET','/api/state',undefined,bearer(paired.json.token))).status,401);
  assert.equal((await f.call('POST','/api/session',{},headers)).status,401);assert.deepEqual(await f.devices(),[]);
});

test('invalid remember preferences and device names fail before enrolling anything',async t=>{
  const f=await fixture(t);
  for(const body of [{remember:'true'},{remember:true,name:''},{remember:true,name:'a'.repeat(65)},{remember:true,name:'Bad\nname'},{remember:true,name:42}])assert.equal((await f.pair(body)).status,400);
  assert.deepEqual(await f.devices(),[]);await assert.rejects(f.disk(),e=>e.code==='ENOENT');
});

test('repeated resumes keep remembered access usable without exhausting temporary pairing slots',async t=>{
  const f=await fixture(t),paired=await f.pair({remember:true}),headers={Cookie:cookie(paired)};
  let latest;
  for(let index=0;index<25;index++){latest=await f.call('POST','/api/session',{},headers);assert.equal(latest.status,200);}
  assert.equal((await f.call('GET','/api/state',undefined,bearer(paired.json.token))).status,401);
  assert.equal((await f.call('GET','/api/state',undefined,bearer(latest.json.token))).status,200);
  for(let index=0;index<20;index++)assert.equal((await f.pair()).status,200);
  assert.equal((await f.pair()).status,429);
  assert.equal((await f.call('POST','/api/session',{},headers)).status,200);
});

test('Home Screen manifest and icons are public, correctly typed, and do not expose private data',async t=>{
  const f=await fixture(t);
  for(const [route,mime]of [['/manifest.webmanifest','application/manifest+json'],['/icon.svg','image/svg+xml'],['/icon-192.png','image/png'],['/icon-512.png','image/png'],['/apple-touch-icon.png','image/png']]){
    const get=await f.call('GET',route);assert.equal(get.status,200,route);assert.equal(get.headers['content-type'],mime);assert.equal(get.headers['cache-control'],'no-store');assert.equal(cookieHeader(get),undefined);
    const head=await f.call('HEAD',route);assert.equal(head.status,200);assert.equal(head.buffer.length,0);assert.equal(Number(head.headers['content-length']),get.buffer.length);
  }
  assert.equal((await f.call('GET','/devices.json')).status,401);
  assert.equal((await f.call('GET','/config.json')).status,401);
});

test('revocation rejects settings and focal writes whose request bodies were already in flight',async t=>{
  const f=await fixture(t);
  for(const [method,route,body]of [
    ['PATCH','/api/config',{revision:0,clock24:true}],
    ['POST','/api/wallpapers/select',{revision:0,id:'default'}],
    ['POST','/api/wallpapers/focal',{revision:0,id:'default',focalPoint:{x:0.2,y:0.7}}]
  ]){
    const paired=await f.pair({remember:true}),serialized=JSON.stringify(body),pending=heldRequest(f,method,route,paired.json.token);
    pending.request.write(serialized.slice(0,10));await new Promise(resolve=>setImmediate(resolve));
    assert.equal((await f.tv('POST','/api/devices/revoke',{id:paired.json.deviceId})).status,200);
    pending.request.end(serialized.slice(10));assert.equal((await pending.result).status,401,route);
    assert.equal(f.config.revision,0);assert.equal(f.config.clock24,false);assert.equal(f.config.defaultFocalPoint,null);
  }
  await assert.rejects(fs.readFile(path.join(f.dir,'config.json')),e=>e.code==='ENOENT');
});

test('an upload streaming during revocation cannot commit media or configuration afterward',async t=>{
  const f=await fixture(t),paired=await f.pair({remember:true});
  const media=Buffer.from('000000186674797069736f6d0000020069736f6d69736f32','hex');
  const pending=heldRequest(f,'POST','/api/upload?name=revoked.mp4',paired.json.token,{'Content-Length':media.length,'Content-Type':'video/mp4'});
  pending.request.write(media.subarray(0,8));await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await f.tv('POST','/api/devices/revoke',{id:paired.json.deviceId})).status,200);
  pending.request.end(media.subarray(8));assert.equal((await pending.result).status,401);
  assert.equal(f.config.revision,0);assert.equal(f.config.wallpaper,null);assert.deepEqual(f.config.wallpaperLibrary,[]);
  assert.deepEqual(await fs.readdir(path.join(f.dir,'media')),[]);
  await assert.rejects(fs.readFile(path.join(f.dir,'config.json')),e=>e.code==='ENOENT');
});

test('revocation waits for a phone configuration commit already writing to disk', {timeout:5000}, async t=>{
  const f=await fixture(t),paired=await f.pair({remember:true}),originalRename=fs.rename;
  let release,entered,revoked=false;
  const gate=new Promise(resolve=>{release=resolve;}),writing=new Promise(resolve=>{entered=resolve;});
  fs.rename=async(source,target)=>{if(target===path.join(f.dir,'config.json')){entered();await gate;}return originalRename(source,target);};
  try{
    const saving=f.call('PATCH','/api/config',{revision:0,clock24:true},bearer(paired.json.token));
    await writing;
    const revoking=f.tv('POST','/api/devices/revoke',{id:paired.json.deviceId}).then(result=>{revoked=true;return result;});
    await new Promise(resolve=>setImmediate(resolve));assert.equal(revoked,false);
    release();assert.equal((await saving).status,200);assert.equal((await revoking).status,200);
    assert.equal(f.config.revision,1);assert.equal(f.config.clock24,true);
    assert.equal((await f.call('PATCH','/api/config',{revision:1,clock24:false},bearer(paired.json.token))).status,401);
  }finally{release();fs.rename=originalRename;}
});

test('revocation is acknowledged only after the credential directory entry is synced', {timeout:5000}, async t=>{
  const f=await fixture(t),paired=await f.pair({remember:true}),originalOpen=fs.open;
  let release,entered,revoked=false;
  const gate=new Promise(resolve=>{release=resolve;}),syncing=new Promise(resolve=>{entered=resolve;});
  fs.open=async(...args)=>{
    const handle=await originalOpen(...args);
    if(args[0]===f.dir){const sync=handle.sync.bind(handle);handle.sync=async()=>{entered();await gate;return sync();};}
    return handle;
  };
  try{
    const revoking=f.tv('POST','/api/devices/revoke',{id:paired.json.deviceId}).then(result=>{revoked=true;return result;});
    await syncing;await new Promise(resolve=>setImmediate(resolve));assert.equal(revoked,false);
    release();assert.equal((await revoking).status,200);
    assert.equal((await f.call('POST','/api/session',{}, {Cookie:cookie(paired)})).status,401);
  }finally{release();fs.open=originalOpen;}
});

test('a directory-sync failure is not acknowledged as a successful revocation and fails closed',async t=>{
  const f=await fixture(t),paired=await f.pair({remember:true}),originalOpen=fs.open;
  fs.open=async(...args)=>{
    const handle=await originalOpen(...args);
    if(args[0]===f.dir)handle.sync=async()=>{throw Error('Simulated directory-sync failure');};
    return handle;
  };
  try{
    assert.equal((await f.tv('POST','/api/devices/revoke',{id:paired.json.deviceId})).status,500);
    assert.equal((await f.call('GET','/api/state',undefined,bearer(paired.json.token))).status,401);
    assert.equal((await f.call('POST','/api/session',{}, {Cookie:cookie(paired)})).status,503);
    assert.equal((await f.tv('GET','/api/devices')).status,503);
    assert.equal((await f.pair()).status,200);
  }finally{fs.open=originalOpen;}
  await f.restart();assert.deepEqual(await f.devices(),[]);
  assert.equal((await fs.readdir(f.dir)).some(name=>name.endsWith('.tmp')),false);
});

test('a backward TV clock correction preserves valid remembered metadata across restart',async t=>{
  const f=await fixture(t),paired=await f.pair({remember:true}),created=f.now,headers={Cookie:cookie(paired)};
  f.advance(-DAY);
  assert.equal((await f.call('POST','/api/session',{},headers)).status,200);
  // Another enrollment persists the first device's most recent activity too.
  assert.equal((await f.pair({remember:true,name:'Another phone'})).status,200);
  const saved=JSON.parse(await f.disk()).devices.find(device=>device.id===paired.json.deviceId);
  assert.equal(saved.lastUsed,created);assert.equal(saved.expiresAt,created+YEAR);
  await f.restart();assert.equal((await f.devices()).length,2);
  assert.equal((await f.call('POST','/api/session',{},headers)).status,200);
});
