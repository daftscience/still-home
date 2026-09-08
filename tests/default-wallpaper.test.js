'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createBackend}=require('../service/backend'),wallpaper=require('../service/default-wallpaper.json');
test('Cape Cod Sunset starts at its saved focal point; edits and original framing survive restart',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'still-default-')),opts={demo:true,stateDir:dir,port:0,bind:'127.0.0.1'};let b;
 try{b=await createBackend(opts);assert.equal(b.getConfig().wallpaper,null);assert.equal(b.getConfig().defaultWallpaper.name,'Cape Cod Sunset');assert.deepEqual(b.getConfig().defaultFocalPoint,wallpaper.focalPoint);
 for(const point of [{x:0.2,y:0.4},null]){const a=b.bootstrap();const r=await fetch(a.baseUrl+'/api/wallpapers/focal',{method:'POST',headers:{Authorization:'Bearer '+a.token},body:JSON.stringify({revision:b.getConfig().revision,id:'default',focalPoint:point})});assert.equal(r.status,200);await b.close();b=await createBackend(opts);assert.deepEqual(b.getConfig().defaultFocalPoint,point);}
 }finally{if(b)await b.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('upgrading an older default adopts the sunset focal point without altering selected uploads or saved files',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'still-default-migration-')),opts={demo:true,stateDir:dir,port:0,bind:'127.0.0.1'};let b;
 try{b=await createBackend(opts);const a=b.bootstrap(),headers={Authorization:'Bearer '+a.token};
 const photo=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64');
 assert.equal((await fetch(a.baseUrl+'/api/upload?name=existing.png',{method:'POST',headers,body:photo})).status,200);
 const selected=b.getConfig().wallpaper;
 assert.equal((await fetch(a.baseUrl+'/api/wallpapers/focal',{method:'POST',headers,body:JSON.stringify({revision:b.getConfig().revision,id:selected.id,focalPoint:{x:0.3,y:0.7}})})).status,200);
 const old=b.getConfig();old.defaultWallpaper={id:'neutral-v1',name:'Neutral'};old.defaultFocalPoint={x:0.1,y:0.1};old.clock24=true;await b.close();b=null;await fs.writeFile(path.join(dir,'config.json'),JSON.stringify(old));const before=await fs.readFile(path.join(dir,'config.json'));
 b=await createBackend(opts);assert.deepEqual(b.getConfig().defaultFocalPoint,wallpaper.focalPoint);assert.equal(b.getConfig().defaultWallpaper.id,wallpaper.id);assert.equal(b.getConfig().clock24,true);assert.deepEqual(b.getConfig().wallpaper,old.wallpaper);assert.deepEqual(b.getConfig().wallpaperLibrary,old.wallpaperLibrary);assert.deepEqual(await fs.readFile(path.join(dir,'config.json')),before);assert.deepEqual(await fs.readFile(path.join(dir,'media',selected.id+'.png')),photo);
 }finally{if(b)await b.close();await fs.rm(dir,{recursive:true,force:true});}
});
