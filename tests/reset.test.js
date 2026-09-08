'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {createBackend,defaults}=require('../service/backend');
const video=Buffer.from('000000186674797069736f6d0000020069736f6d69736f32','hex');
async function fixture(t,options={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'still-home-reset-test-'));
  const settings={stateDir:dir,port:0,bind:'127.0.0.1',demo:true,platform:{apps:async()=>[{id:'one',title:'One'},{id:'com.github.afonsojramos.magicmapper',title:'Magic Mapper'}],launch:async()=>{}},...options};
  let b=await createBackend(settings);
  t.after(async()=>{await b.close();await fs.rm(dir,{recursive:true,force:true});});
  const f={dir,get b(){return b;},async restart(){await b.close();b=await createBackend(settings);},async call(route,body,token,headers={}){
    const auth=b.bootstrap();const response=await fetch(auth.baseUrl+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+(token||auth.token),...headers},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});
    const data=await response.json();return {status:response.status,data,headers:response.headers};
  },async preview(){const r=await f.call('/api/reset/preview',{});assert.equal(r.status,200,JSON.stringify(r.data));return r.data;},async confirm(p){return f.call('/api/reset/confirm',{id:p.id,token:p.token});}};
  return f;
}
test('reset removes every owned upload and leftover, retains included/external files, revokes phones and persists',async t=>{
  const f=await fixture(t);
  const first=await f.call('/api/upload?name=one.mp4',video),second=await f.call('/api/upload?name=two.mp4',video);
  assert.equal(first.status,200);assert.equal(second.status,200);
  const id='a'.repeat(32);await fs.writeFile(path.join(f.dir,'media',id+'.mp4'),video);
  await fs.writeFile(path.join(f.dir,'media','b'.repeat(32)+'.upload'),video);
  await fs.writeFile(path.join(f.dir,'config.pre-v0.2.json'),'old preferences');
  await fs.writeFile(path.join(f.dir,'unrelated.txt'),'keep');
  const pair=await f.call('/api/pairing',{}),phone=await f.call('/api/pair',{code:pair.data.code,remember:true,name:'Fixture phone'});
  const cookie=phone.headers.get('set-cookie').split(';')[0],oldToken=phone.data.token;
  const before=f.b.getConfig().revision,p=await f.preview();assert.equal(p.count,3);
  assert.equal((await f.call('/api/reset/preview',{},oldToken)).status,403);
  const r=await f.confirm(p);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.operation.status,'complete');
  assert.deepEqual(f.b.getConfig(),{...defaults(),revision:before+1});
  assert.deepEqual(await fs.readdir(path.join(f.dir,'media')),[]);
  assert.equal(await fs.readFile(path.join(f.dir,'unrelated.txt'),'utf8'),'keep');
  assert.equal((await f.call('/api/state',undefined,oldToken)).status,401);
  assert.equal((await f.call('/api/session',{},undefined,{Cookie:cookie})).status,401);
  assert.equal((await f.call('/media/library?id='+first.data.config.wallpaper.id)).status,404);
  assert.equal((await f.confirm(p)).status,200,'same operation retry is idempotent');
  await f.restart();assert.deepEqual(await fs.readdir(path.join(f.dir,'media')),[]);assert.equal(f.b.getConfig().revision,before+1);
  assert.equal((await f.confirm(p)).status,200,'completed operation remains idempotent after restart');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.dir,'devices.json'),'utf8')).devices.length,0);
});
test('preview is read-only, confirmation is bound to token and settings revision',async t=>{
  const f=await fixture(t);await f.call('/api/upload?name=keep.mp4',video);const before=JSON.stringify(f.b.getConfig()),p=await f.preview();
  assert.equal(JSON.stringify(f.b.getConfig()),before);
  assert.equal((await f.confirm({...p,token:'wrong'})).status,409);
  await f.call('/api/upload?name=new.mp4',video);
  assert.equal((await f.confirm(p)).status,409);assert.equal(f.b.getConfig().wallpaperLibrary.length,2);
});
for(const phase of ['journal','retired','config','devices','deleted'])test('interrupted reset recovers before orphan scanning: '+phase,async t=>{
  let failed=false;const f=await fixture(t,{resetHook:async stage=>{if(stage===phase&&!failed){failed=true;throw Error('Injected crash');}}});
  await f.call('/api/upload?name=old.mp4',video);const p=await f.preview();
  assert.equal((await f.confirm(p)).status,503);
  const status=await f.call('/api/reset/status');assert.equal(status.data.operation.status,'failed');assert.equal(status.data.operation.token,undefined);
  await f.restart();assert.equal(f.b.getConfig().wallpaper,null);assert.equal(f.b.getConfig().revision,2);
  assert.deepEqual(await fs.readdir(path.join(f.dir,'media')),[]);
  assert.equal((await f.call('/api/reset/status')).data.operation.status,'complete');
});
test('failed reset can be resumed without another operation or data resurrection',async t=>{
  let fail=true;const f=await fixture(t,{resetHook:async stage=>{if(stage==='retired'&&fail){fail=false;throw Error('injected');}}});
  await f.call('/api/upload?name=old.mp4',video);const p=await f.preview();assert.equal((await f.confirm(p)).status,503);
  assert.equal((await f.confirm(p)).status,200);assert.deepEqual(await fs.readdir(path.join(f.dir,'media')),[]);
});
test('unknown files and symlinks block reset without touching their targets',async t=>{
  const f=await fixture(t);const target=path.join(f.dir,'keep.txt');await fs.writeFile(target,'keep');
  const link=path.join(f.dir,'media','c'.repeat(32)+'.mp4');await fs.symlink(target,link);
  assert.equal((await f.call('/api/reset/preview',{})).status,409);assert.equal(await fs.readFile(target,'utf8'),'keep');
  await fs.unlink(link);await fs.writeFile(path.join(f.dir,'media','unknown.bin'),'keep');
  assert.equal((await f.call('/api/reset/preview',{})).status,409);
});
test('reset refuses an in-flight upload and remains usable after it finishes',async t=>{
  let release,entered;const waiting=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const f=await fixture(t,{diskFree:async()=>{entered();await gate;return 1024*1024*1024;}});
  const upload=f.call('/api/upload?name=held.mp4',video);await waiting;
  assert.equal((await f.call('/api/reset/preview',{})).status,409);release();assert.equal((await upload).status,200);
  assert.equal((await f.confirm(await f.preview())).status,200);
});
test('settings body accepted before reset cannot commit after reset',async t=>{
  const f=await fixture(t),auth=f.b.bootstrap();const body=JSON.stringify({revision:0,clock24:true});
  let finish;const response=new Promise((resolve,reject)=>{
    const req=http.request(auth.baseUrl+'/api/config',{method:'PATCH',headers:{Authorization:'Bearer '+auth.token,'Content-Length':Buffer.byteLength(body)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
    req.on('error',reject);req.flushHeaders();finish=()=>req.end(body);
  });
  await new Promise(r=>setTimeout(r,25));const p=await f.preview();assert.equal((await f.confirm(p)).status,200);
  finish();assert.equal(await response,409);assert.equal(f.b.getConfig().clock24,false);
});
test('pairing validity detects consumption and regeneration; default Home is an honest TV-only guided action',async t=>{
  const f=await fixture(t),p=await f.call('/api/pairing',{});
  assert.equal((await f.call('/api/pairing/status?id='+p.data.id)).data.valid,true);
  const phone=await f.call('/api/pair',{code:p.data.code});
  assert.equal((await f.call('/api/pairing/status?id='+p.data.id)).data.valid,false);
  const home=await f.call('/api/default-home');assert.equal(home.data.mode,'guided');assert.equal(home.data.managed,false);assert.equal(home.data.mapperId,'com.github.afonsojramos.magicmapper');
  assert.equal((await f.call('/api/default-home',undefined,phone.data.token)).status,403);
});
