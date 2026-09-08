'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const status=require('../service/setup-status'),setup=require('../service/setup-tv'),client=require('../app/tv-setup');
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'still-setup-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const service=path.join(dir,'service'),hook=path.join(dir,'hooks','60-still-home'),elevate=path.join(dir,'elevate');
  fs.mkdirSync(service);fs.writeFileSync(service+'/autostart.sh','#!/bin/sh\n',{mode:0o755});fs.writeFileSync(elevate,'#!/bin/sh\n',{mode:0o755});
  return {dir,service,hook,elevate,uid:0};
}
test('jailed setup preflight returns a typed error without touching root storage',()=>{
  let touched=false;
  assert.deepEqual(status.check({uid:5000,fs:new Proxy({},{get(){touched=true;throw Error('must not read');}})}),{required:true,reason:'permissions'});
  assert.equal(touched,false);
  assert.throws(()=>status.assertReady({uid:5000}),e=>status.response(e).setupRequired===true&&e.code==='STILL_HOME_SETUP_REQUIRED');
});
test('root preflight requires the exact executable startup hook',t=>{
  const f=fixture(t),options={uid:0,hook:f.hook,target:f.service+'/autostart.sh'};
  assert.equal(status.check(options).required,true);fs.mkdirSync(path.dirname(f.hook));fs.symlinkSync(options.target,f.hook);
  assert.deepEqual(status.check(options),{required:false});fs.chmodSync(options.target,0o644);assert.equal(status.check(options).required,true);
});
test('on-TV setup is repeatable and only elevates Still Home, preserving all user data',async t=>{
  const f=fixture(t),sentinel=path.join(f.dir,'settings-and-photos');fs.writeFileSync(sentinel,'unchanged');let runs=0,restarts=0;
  f.run=async(file,args)=>{assert.equal(file,f.elevate);assert.deepEqual(args,['com.tomperry.stillhome.service']);runs++;};f.restart=async()=>restarts++;
  for(let i=0;i<2;i++)assert.equal(await setup.setup(f),'STILL_HOME_SETUP_OK');
  assert.equal(fs.readlinkSync(f.hook),f.service+'/autostart.sh');assert.equal(fs.readFileSync(sentinel,'utf8'),'unchanged');assert.equal(runs,2);assert.equal(restarts,2);
});
test('setup refuses foreign files, symlinks and broken foreign links before elevation',async t=>{
  const f=fixture(t);fs.mkdirSync(path.dirname(f.hook));let runs=0;f.run=async()=>runs++;f.restart=async()=>assert.fail('must not restart');
  for(const kind of ['file','link']){
    if(kind==='file')fs.writeFileSync(f.hook,'foreign');else fs.symlinkSync('/missing/foreign-hook',f.hook);
    await assert.rejects(setup.setup(f),/different startup hook/);assert.equal(runs,0);assert.equal(fs.lstatSync(f.hook).isSymbolicLink(),kind==='link');fs.unlinkSync(f.hook);
  }
});
test('unrooted, missing Homebrew and failed elevation cannot report setup success',async t=>{
  const f=fixture(t);f.restart=async()=>assert.fail('must not restart');f.run=async()=>{throw Error('elevation failed');};
  await assert.rejects(setup.setup({...f,uid:5000}),/root access/);
  await assert.rejects(setup.setup({...f,elevate:path.join(f.dir,'missing')}),/missing/);
  await assert.rejects(setup.setup(f),/elevation failed/);assert.equal(fs.existsSync(f.hook),false);
});
test('restart targets exact Still Home process arguments, never substring matches or other services',()=>{
  const rows={12:['node',status.SERVICE],13:['node','/other/service'],14:['sh','-c','echo '+status.SERVICE],15:['node',status.SERVICE+'/setup-tv.js'],16:['node',status.SERVICE.replace('/media/developer/','/media/cryptofs/')],17:['node',status.SERVICE+'/service.js'],18:['com.tomperry.stillhome.service','',''],19:['other.service','',''],20:['echo','com.tomperry.stillhome.service']};
  const io={readdirSync:()=>Object.keys(rows).concat('self'),readFileSync:p=>rows[p.split('/')[2]].join('\0')};
  assert.deepEqual(setup.matchingProcesses(io),[12,16,17,18]);
});
function bridgeFixture(options={}){
  const calls=[];class Bridge{call(uri,body){calls.push({uri,params:JSON.parse(body),bridge:this});}cancel(){this.cancelled=true;}}
  return {calls,client:client.create({Bridge,...options}),reply(index,data){calls[index].bridge.onservicecallback(JSON.stringify(data));}};
}
test('first-run service starts no backend when permissions are missing; only the TV app gets bootstrap details',async()=>{
  const handlers={};let backendCalls=0;
  class Service{register(name,fn){handlers[name]=fn;}}
  const fakeRequire=id=>{
    if(id==='./backend')return {VERSION:'test',createBackend:()=>{backendCalls++;throw Error('should not start');}};
    if(id==='./setup-status')return {...status,assertReady:()=>status.assertReady({uid:5000})};
    if(id==='webos-service')return Service;
    throw Error('Unexpected require '+id);
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../service/service.js'),'utf8'),{require:fakeRequire,process:{env:{},argv:[],on(){}},Promise,setTimeout,clearTimeout,console:{error(){}}});
  await new Promise(setImmediate);
  const reply=await new Promise(resolve=>handlers.bootstrap({sender:'com.tomperry.stillhome',respond:resolve}));
  assert.equal(reply.setupRequired,true);assert.equal(reply.errorCode,status.CODE);assert.equal(backendCalls,0);assert.equal(reply.token,undefined);
  const unauthorized=await new Promise(resolve=>handlers.bootstrap({sender:'unrelated.app',respond:resolve}));assert.equal(unauthorized.returnValue,false);assert.equal(unauthorized.setupRequired,undefined);
});
test('client preserves structured setup errors and recognizes the old storage failure only',async()=>{
  const f=bridgeFixture(),pending=f.client.call('luna://com.tomperry.stillhome.service/bootstrap',{});
  f.reply(0,{returnValue:false,errorCode:status.CODE,setupRequired:true,errorText:'Finish setup'});
  await assert.rejects(pending,e=>client.required(e));
  assert.equal(client.required(new Error("EACCES: permission denied, mkdir '/var/lib'")),true);
  assert.equal(client.required(new Error('Network failed')),false);
  assert.equal(client.required(new Error('EACCES: wallpaper file')),false);
});
test('setup is user-initiated, deduplicated, and sends only a fixed packaged command',async()=>{
  const f=bridgeFixture();assert.equal(f.calls.length,0);const first=f.client.run(),second=f.client.run();assert.equal(first,second);assert.equal(f.calls.length,1);
  assert.deepEqual(f.calls[0].params,{command:'/bin/sh /media/developer/apps/usr/palm/services/com.tomperry.stillhome.service/setup-tv.sh'});
  assert.equal(f.calls[0].uri,'luna://org.webosbrew.hbchannel.service/exec');
  f.reply(0,{returnValue:true,stdoutString:'STILL_HOME_SETUP_OK\n'});assert.equal(await first,true);assert.equal(f.calls[0].bridge.cancelled,true);
});
test('setup requires its completion marker and exposes useful failure text',async()=>{
  for(const data of [{returnValue:false,errorText:'Homebrew unavailable'},{returnValue:true,stdoutString:'',stderrString:'Root access unavailable'},{returnValue:true,error:'failed',stdoutString:'STILL_HOME_SETUP_OK\n'},{returnValue:true,stdoutString:'not STILL_HOME_SETUP_OK'}]){
    const f=bridgeFixture(),pending=f.client.run();f.reply(0,data);await assert.rejects(pending);
    const retry=f.client.run();f.reply(1,{returnValue:true,stdoutString:'STILL_HOME_SETUP_OK\n'});assert.equal(await retry,true);
  }
});
test('missing bridge, malformed replies, and timeouts fail closed; late callbacks are ignored',async()=>{
  await assert.rejects(client.create().run(),/Open Still Home/);
  const malformed=bridgeFixture(),pending=malformed.client.run();malformed.calls[0].bridge.onservicecallback('not json');await assert.rejects(pending);
  let expire;const f=bridgeFixture({setTimeout:fn=>(expire=fn,1),clearTimeout:()=>{}}),timeout=f.client.run();expire();await assert.rejects(timeout,/did not respond/);
  assert.equal(f.calls[0].bridge.cancelled,true);f.reply(0,{returnValue:true,stdoutString:'STILL_HOME_SETUP_OK\n'});
});
test('setup screen supports remote focus, consent and retry, and is bundled before application startup',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../app/index.html'),'utf8'),js=fs.readFileSync(path.join(__dirname,'../app/app.js'),'utf8');
  assert.match(html,/id="setup-dialog"[^>]*role="dialog"[^>]*aria-modal="true"/);
  for(const id of ['setup-finish','setup-exit'])assert.match(html,new RegExp('id="'+id+'"[^>]*data-focus'));
  assert.ok(html.indexOf('src="tv-setup.js"')<html.indexOf('src="app.js"'));assert.match(js,/if \(state.setupOpen\) return \$\('setup-dialog'\)/);assert.match(js,/setup-finish.*addEventListener\('click',finishSetup\)/);
});
