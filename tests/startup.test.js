'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const create=require('../service/startup-controller');
test('startup preference is opt-in, type checked, and survives restart',async()=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{createBackend}=require('../service/backend');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'still-start-')),opts={stateDir:dir,port:0,bind:'127.0.0.1',demo:true};let b;
 try{b=await createBackend(opts);assert.equal(b.startupEnabled(),false);
 async function patch(value){const a=b.bootstrap();return fetch(a.baseUrl+'/api/config',{method:'PATCH',headers:{Authorization:'Bearer '+a.token},body:JSON.stringify({revision:b.getConfig().revision,launchAtStart:value})});}
 for(const bad of ['true',1,null])assert.equal((await patch(bad)).status,400);
 assert.equal((await patch(true)).status,200);assert.equal(b.startupEnabled(),true);await b.close();b=await createBackend(opts);assert.equal(b.startupEnabled(),true);assert.equal((await patch(false)).status,200);assert.equal(b.startupEnabled(),false);
 }finally{if(b)await b.close();await fs.rm(dir,{recursive:true,force:true});}
});
test('startup handles boot and wake once, retaining a real wake across disconnection',async()=>{
 let enabled=false,launches=0,task=null;
 const c=create({enabled:()=>enabled,launch:async()=>{launches++;},setTimeout:fn=>{task=fn;return 1;},clearTimeout:()=>{task=null;}});
 async function tick(){const fn=task;task=null;if(fn)await fn();}
 c.update('Active');c.coldStart();await tick();assert.equal(launches,0);
 enabled=true;c.update('Active');await tick();assert.equal(launches,0);
 c.coldStart();c.update('Active');await tick();assert.equal(launches,1);
 c.update('Active');await tick();assert.equal(launches,1);
 c.update('Screen Saver');c.update('Active');await tick();assert.equal(launches,1);
 c.update('Screen Off');c.update('Active');await tick();assert.equal(launches,1);
 c.update('Suspend');c.update('Active');c.update('Active');await tick();assert.equal(launches,2);
 c.update('Active Standby');c.update('Active');enabled=false;await tick();assert.equal(launches,2);
 enabled=true;c.update('Suspend');c.update('Active');c.disconnected();c.update('Active');await tick();assert.equal(launches,3);
 c.disconnected();c.update('Active');await tick();assert.equal(launches,3);
 c.update('Suspend');c.update('Active');c.close();await tick();assert.equal(launches,3);
});
test('power-off processing arms wake before a subscription disconnect',async()=>{
 let task,launches=0;const c=create({enabled:()=>true,launch:async()=>launches++,setTimeout:fn=>(task=fn,1),clearTimeout:()=>task=null});
 c.update({state:'Active',processing:'Request Power Off'});c.disconnected();c.update({state:'Active',processing:'Screen On'});assert(task);await task();assert.equal(launches,1);
});
test('startup corrects LG Home takeover with bounded retries and respects another app',async()=>{
 let task=null,launches=0,foreground='com.webos.app.home',enabled=true;
 const c=create({enabled:()=>enabled,launch:async()=>launches++,foreground:async()=>foreground,setTimeout:fn=>(task=fn,1),clearTimeout:()=>task=null});
 async function tick(){const fn=task;task=null;if(fn)await fn();}
 c.update('Active');c.coldStart();await tick();assert.equal(launches,1);
 await tick();await tick();await tick();assert.equal(launches,3);
 for(let i=0;i<10;i++)await tick();assert.equal(launches,3);assert.equal(task,null);
 c.update('Suspend');c.update('Active');await tick();assert.equal(launches,4);foreground='netflix';await tick();assert.equal(task,null);
 c.update('Suspend');c.update('Active');await tick();enabled=false;await tick();assert.equal(launches,5);assert.equal(task,null);
});
