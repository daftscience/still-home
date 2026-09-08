'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createBackend}=require('../service/backend');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64');
async function fixture(t,extra={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'still-home-manage-'));const options={stateDir:dir,port:0,bind:'127.0.0.1',demo:true,...extra};let b=await createBackend(options);
  t.after(async()=>{await b.close();await fs.rm(dir,{recursive:true,force:true});});
  const f={dir,get b(){return b;},async restart(){await b.close();b=await createBackend(options);},async call(route,body,token){const r=await fetch(b.bootstrap().baseUrl+route,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+(token||b.bootstrap().token)},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});return{status:r.status,data:await r.json().catch(()=>null)};},async upload(name){const r=await f.call('/api/upload?name='+name,png);assert.equal(r.status,200);return r.data.config.wallpaper;},async action(action,id,fields={}){return f.call('/api/wallpapers/'+action,{revision:b.getConfig().revision,id,...fields});}};return f;
}
test('rename preserves identity, bytes, focal point, active selection and survives restart',async t=>{
  const f=await fixture(t),w=await f.upload('original.png');await f.action('focal',w.id,{focalPoint:{x:.2,y:.7}});
  const file=path.join(f.dir,'media',w.id+'.png'),before=await fs.readFile(file);
  const r=await f.action('rename',w.id,{name:'  Neutral over the mountain  '});assert.equal(r.status,200);
  assert.equal(r.data.config.wallpaper.name,'Neutral over the mountain');assert.equal(r.data.config.wallpaper.id,w.id);assert.deepEqual(r.data.config.wallpaper.focalPoint,{x:.2,y:.7});assert.deepEqual(await fs.readFile(file),before);
  await f.restart();assert.equal(f.b.getConfig().wallpaperLibrary[0].name,'Neutral over the mountain');
});
test('delete inactive wallpaper preserves current selection and other media',async t=>{
  const f=await fixture(t),a=await f.upload('a.png'),b=await f.upload('b.png');
  assert.equal((await f.action('delete',a.id)).status,200);assert.equal(f.b.getConfig().wallpaper.id,b.id);
  assert.deepEqual(await fs.readdir(path.join(f.dir,'media')),[b.id+'.png']);assert.deepEqual(await fs.readFile(path.join(f.dir,'media',b.id+'.png')),png);
});
test('delete active wallpaper falls back to included photo and cannot resurrect on restart',async t=>{
  const f=await fixture(t),w=await f.upload('active.png');assert.equal((await f.action('delete',w.id)).status,200);
  assert.equal(f.b.getConfig().wallpaper,null);assert.deepEqual(f.b.getConfig().wallpaperLibrary,[]);
  assert.equal((await f.call('/media/library?id='+w.id)).status,404);
  const revision=f.b.getConfig().revision;assert.equal((await f.action('delete',w.id)).status,200);assert.equal(f.b.getConfig().revision,revision);
  await fs.writeFile(path.join(f.dir,'media',w.id+'.png'),png);await f.restart();assert.deepEqual(await fs.readdir(path.join(f.dir,'media')),[]);
});
for(const retry of [false,true])test('interrupted deletion finishes '+(retry?'by retry':'on startup'),async t=>{
  let fail=true;const f=await fixture(t,{deleteHook:async()=>{if(fail){fail=false;throw Error('Injected interruption');}}});const w=await f.upload('held.png');
  assert.equal((await f.action('delete',w.id)).status,500);assert.equal(f.b.getConfig().wallpaper,null);assert.ok(await fs.stat(path.join(f.dir,'media',w.id+'.png')));
  if(retry)assert.equal((await f.action('delete',w.id)).status,200);else await f.restart();
  assert.deepEqual(await fs.readdir(path.join(f.dir,'media')),[]);assert.deepEqual(f.b.getConfig().wallpaperLibrary,[]);
});
test('validation and revision conflicts do not delete or rename unintended media',async t=>{
  const f=await fixture(t),w=await f.upload('keep.png'),revision=f.b.getConfig().revision;
  for(const name of ['', ' ', 'x'.repeat(121), '\nunsafe',42])assert.equal((await f.action('rename',w.id,{name})).status,400);
  assert.equal((await f.action('delete','default')).status,400);assert.equal((await f.action('rename','default',{name:'new'})).status,400);
  assert.equal((await f.action('delete','../config.json')).status,400);assert.equal((await f.action('delete',w.id,{revision:revision-1})).status,409);
  assert.equal((await f.action('rename',w.id,{name:'New',other:true})).status,400);assert.equal(f.b.getConfig().wallpaper.name,'keep.png');assert.deepEqual(await fs.readFile(path.join(f.dir,'media',w.id+'.png')),png);
});
test('paired phones can manage uploads but invalid credentials and symlinks fail safely',async t=>{
  const f=await fixture(t),w=await f.upload('phone.png'),p=await f.call('/api/pairing',{}),phone=await f.call('/api/pair',{code:p.data.code});
  assert.equal((await f.call('/api/wallpapers/rename',{revision:f.b.getConfig().revision,id:w.id,name:'Phone label'},phone.data.token)).status,200);
  assert.equal((await f.call('/api/wallpapers/delete',{revision:f.b.getConfig().revision,id:w.id},'a'.repeat(64))).status,401);
  const file=path.join(f.dir,'media',w.id+'.png'),target=path.join(f.dir,'original.txt');await fs.writeFile(target,'keep');await fs.unlink(file);await fs.symlink(target,file);
  assert.equal((await f.action('delete',w.id)).status,409);assert.equal(await fs.readFile(target,'utf8'),'keep');assert.equal(f.b.getConfig().wallpaper.id,w.id);
});
