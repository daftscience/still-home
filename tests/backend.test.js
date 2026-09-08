'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {createBackend, MAX_UPLOAD, parseRange} = require('../service/backend');

const catalog = [
  {id:'youtube',title:'YouTube',params:{entry:'launcher'}},
  {id:'netflix',title:'Netflix'},
  {id:'com.webos.app.hdmi1',title:'HDMI 1'},
  {id:'hidden',title:'Hidden',hidden:true},
  {id:'nodisplay',title:'System',noDisplay:true},
  {id:'com.tomperry.stillhome',title:'Still Home'},
  {id:'youtube',title:'Duplicate'}
];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=','base64');
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32','hex');
const location = {name:'Boston, MA, US',latitude:42.36,longitude:-71.06};

function call(port, method, route, body, headers={}) {
  const data=body===undefined?undefined:Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:route,method,agent:false,headers:{
      ...(data?{'Content-Length':data.length,'Content-Type':'application/json'}:{}),...headers
    }},res=>{
      const chunks=[];
      res.on('data',c=>chunks.push(c));
      res.on('error',reject);
      res.on('end',()=>{
        const buffer=Buffer.concat(chunks);let json=null;
        try{json=JSON.parse(buffer.toString());}catch(_e){}
        resolve({status:res.statusCode,headers:res.headers,buffer,json});
      });
    });
    req.setTimeout(4000,()=>req.destroy(new Error('Test request timeout')));
    req.on('error',reject);req.end(data);
  });
}

async function fixture(t, options={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'still-home-test-'));
  const launches=[];const queried=[];
  const getJSON=options.getJSON||(async url=>{queried.push(url);return {current:{temperature_2m:63,weather_code:2,is_day:1}};});
  let backend=await createBackend({stateDir:dir,port:0,bind:'127.0.0.1',demo:true,
    diskFree:async()=>MAX_UPLOAD*3,getJSON,
    platform:{apps:async()=>catalog,launch:async(id,params)=>launches.push({id,params})},...options});
  t.after(async()=>{await backend.close();await fs.rm(dir,{recursive:true,force:true});});
  const f={dir,launches,queried,get backend(){return backend;},
    get port(){return backend.server.address().port;},get token(){return backend.bootstrap().token;},
    request(method,route,body,extra={}){return call(f.port,method,route,body,{Authorization:'Bearer '+f.token,...extra});},
    async pair(){const p=await f.request('POST','/api/pairing',{});assert.equal(p.status,200);const r=await call(f.port,'POST','/api/pair',{code:p.json.code});assert.equal(r.status,200);return r.json.token;},
    async restart(){await backend.close();backend=await createBackend({stateDir:dir,port:0,bind:'127.0.0.1',demo:true,diskFree:async()=>MAX_UPLOAD*3,getJSON,platform:{apps:async()=>catalog,launch:async(id,params)=>launches.push({id,params})},...options});}
  };return f;
}

test('authentication protects API and query tokens only authorize media',async t=>{
  const f=await fixture(t);
  assert.equal((await call(f.port,'GET','/api/state')).status,401);
  assert.equal((await call(f.port,'GET','/api/state',undefined,{Authorization:'Bearer '+'a'.repeat(64)})).status,401);
  assert.equal((await call(f.port,'GET','/api/state?token='+f.token)).status,401);
  const state=await f.request('GET','/api/state');
  assert.equal(state.status,200);assert.equal(state.json.config.revision,0);
  assert.equal(state.headers['cache-control'],'no-store');
});

test('Host and Origin checks reject cross-origin and DNS-rebinding requests',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('GET','/api/state',undefined,{Host:'evil.example:'+f.port})).status,403);
  assert.equal((await f.request('GET','/api/state',undefined,{Origin:'https://evil.example'})).status,403);
  const allowed=await f.request('GET','/api/state',undefined,{Origin:'null'});
  assert.equal(allowed.status,200);assert.equal(allowed.headers['access-control-allow-origin'],'null');
  assert.equal((await call(f.port,'POST','/api/pair',{code:'123456'},{Origin:'null'})).status,403);
});

test('pairing is single use and phone scope excludes launch and new pairing',async t=>{
  const f=await fixture(t);
  const p=await f.request('POST','/api/pairing',{});assert.match(p.json.code,/^\d{6}$/);
  const wrong=p.json.code==='111111'?'222222':'111111';
  assert.equal((await call(f.port,'POST','/api/pair',{code:wrong})).status,401);
  const paired=await call(f.port,'POST','/api/pair',{code:p.json.code});assert.equal(paired.status,200);
  assert.equal((await call(f.port,'POST','/api/pair',{code:p.json.code})).status,401);
  const headers={Authorization:'Bearer '+paired.json.token};
  assert.equal((await call(f.port,'GET','/api/state',undefined,headers)).status,200);
  assert.equal((await call(f.port,'POST','/api/launch',{id:'youtube'},headers)).status,403);
  assert.equal((await call(f.port,'POST','/api/pairing',{},headers)).status,403);
  assert.deepEqual(f.launches,[]);
});

test('malformed non-ASCII pairing codes produce authentication failure, not internal error',async t=>{
  const f=await fixture(t);await f.request('POST','/api/pairing',{});
  assert.equal((await call(f.port,'POST','/api/pair',{code:'éééééé'})).status,401);
});

test('pairing attempts are rate limited and expired codes and sessions rejected',async t=>{
  const f=await fixture(t);const realNow=Date.now;
  const p=await f.request('POST','/api/pairing',{});
  for(let i=0;i<8;i++)assert.equal((await call(f.port,'POST','/api/pair',{code:'wrong'})).status,401);
  assert.equal((await call(f.port,'POST','/api/pair',{code:p.json.code})).status,429);
  try{
    Date.now=()=>realNow()+16*60*1000;
    assert.equal((await call(f.port,'POST','/api/pair',{code:p.json.code})).status,401);
    const phone=await f.pair();Date.now=()=>realNow()+47*60*1000;
    assert.equal((await call(f.port,'GET','/api/state',undefined,{Authorization:'Bearer '+phone})).status,401);
  }finally{Date.now=realNow;}
});

test('catalog filters hidden apps, own app and duplicates, retaining HDMI',async t=>{
  const f=await fixture(t);const r=await f.request('GET','/api/apps');
  assert.equal(r.status,200);assert.deepEqual(r.json.apps.map(a=>a.id),['youtube','netflix','com.webos.app.hdmi1']);
});

test('launch uses installed app metadata and rejects uninstalled or injected IDs',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('POST','/api/launch',{id:'youtube',params:{exec:'touch /tmp/unsafe'}})).status,200);
  assert.deepEqual(f.launches,[{id:'youtube',params:{entry:'launcher'}}]);
  for(const id of ['hidden','missing','youtube; reboot','../../etc/passwd',null])assert.equal((await f.request('POST','/api/launch',{id})).status,400);
  assert.equal(f.launches.length,1);
});

test('configuration rejects invalid types, unknown keys and unavailable apps',async t=>{
  const f=await fixture(t);
  const invalid=[{clock24:'true'},{temperatureUnit:'kelvin'},{dim:-1},{dim:1},{location:{name:'bad',latitude:100,longitude:0}},{wallpaper:{id:'evil'}},{unknown:true},{appIds:['missing']},{appIds:['youtube','youtube']},{appIds:'youtube'}];
  for(const change of invalid)assert.equal((await f.request('PATCH','/api/config',{revision:0,...change})).status,400,JSON.stringify(change));
  assert.equal(f.backend.getConfig().revision,0);
});

test('concurrent configuration writers produce one success and one conflict without data loss',async t=>{
  const f=await fixture(t);
  const results=await Promise.all([
    f.request('PATCH','/api/config',{revision:0,clock24:true}),
    f.request('PATCH','/api/config',{revision:0,dim:0.5})
  ]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const conflict=results.find(r=>r.status===409);assert.equal(conflict.json.config.revision,1);
  const retry=await f.request('PATCH','/api/config',{revision:1,clock24:true,dim:0.5,appIds:['netflix','youtube']});
  assert.equal(retry.status,200);assert.equal(retry.json.config.revision,2);
  assert.equal(retry.json.config.clock24,true);assert.equal(retry.json.config.dim,0.5);
  assert.deepEqual(retry.json.config.appIds,['netflix','youtube']);
  assert.equal((await f.request('PATCH','/api/config',{clock24:false})).status,409);
});

test('deliberately empty app selection is different from default null selection',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('PATCH','/api/config',{revision:0,appIds:[]})).status,200);
  assert.deepEqual(f.backend.getConfig().appIds,[]);
  assert.equal((await f.request('PATCH','/api/config',{revision:1,appIds:null})).status,200);
  assert.equal(f.backend.getConfig().appIds,null);
});

test('weather is opt-in, uses configured units and caches per location and unit',async t=>{
  const f=await fixture(t);
  assert.deepEqual((await f.request('GET','/api/weather')).json,{configured:false});assert.equal(f.queried.length,0);
  assert.equal((await f.request('PATCH','/api/config',{revision:0,location})).status,200);
  const w=await f.request('GET','/api/weather');assert.equal(w.status,200);assert.equal(w.json.temperature,63);assert.equal(w.json.location,location.name);
  await f.request('GET','/api/weather');assert.equal(f.queried.length,1);
  assert.equal(new URL(f.queried[0]).searchParams.get('temperature_unit'),'fahrenheit');
  await f.request('PATCH','/api/config',{revision:1,temperatureUnit:'celsius'});await f.request('GET','/api/weather');
  assert.equal(f.queried.length,2);assert.equal(new URL(f.queried[1]).searchParams.get('temperature_unit'),'celsius');
});

test('weather retains stale cached data offline but does not reuse a different location',async t=>{
  let offline=false;
  const f=await fixture(t,{getJSON:async()=>{if(offline)throw Error('offline');return {current:{temperature_2m:12,weather_code:3,is_day:0}};}});
  await f.request('PATCH','/api/config',{revision:0,location});
  assert.equal((await f.request('GET','/api/weather')).json.stale,false);
  const realNow=Date.now;
  try{
    Date.now=()=>realNow()+16*60*1000;offline=true;
    const stale=await f.request('GET','/api/weather');assert.equal(stale.status,200);assert.equal(stale.json.stale,true);assert.equal(stale.json.temperature,12);
    await f.request('PATCH','/api/config',{revision:1,location:{...location,name:'Other',latitude:50}});
    assert.equal((await f.request('GET','/api/weather')).status,503);
  }finally{Date.now=realNow;}
});

test('geocoding validates input and safely URL-encodes special characters',async t=>{
  const urls=[];const f=await fixture(t,{getJSON:async url=>{urls.push(url);return {results:[{name:'Boston',admin1:'Massachusetts',country:'United States',latitude:42,longitude:-71}]};}});
  assert.equal((await f.request('GET','/api/location?q=a')).status,400);
  const query='Boston & count=1000';const r=await f.request('GET','/api/location?q='+encodeURIComponent(query));
  assert.equal(r.status,200);assert.equal(r.json.results[0].name,'Boston, Massachusetts, United States');
  assert.equal(new URL(urls[0]).searchParams.get('name'),query);assert.equal(new URL(urls[0]).searchParams.get('count'),'8');
});

test('phone upload commits wallpaper, persists metadata and supports authenticated media',async t=>{
  const f=await fixture(t);const phone=await f.pair();
  const upload=await call(f.port,'POST','/api/upload?name=Neutral.mp4',mp4,{Authorization:'Bearer '+phone,'Content-Type':'video/mp4'});
  assert.equal(upload.status,200);assert.equal(upload.json.config.wallpaper.kind,'video');assert.equal(upload.json.config.wallpaper.size,mp4.length);
  assert.equal((await call(f.port,'GET','/media/wallpaper')).status,401);
  assert.deepEqual((await call(f.port,'GET','/media/wallpaper?token='+phone)).buffer,mp4);
});

test('invalid signature, filename, extension and oversized upload preserve previous wallpaper',async t=>{
  const f=await fixture(t);const good=await f.request('POST','/api/upload?name=first.png',png);assert.equal(good.status,200);
  const old=good.json.config.wallpaper.id;
  for(const [name,data,status] of [['bad.png',Buffer.from('not a PNG'),415],['../other.png',png,400],['bad.svg',Buffer.from('<svg/>'),415],['bad.mp4',png,415]]){
    assert.equal((await f.request('POST','/api/upload?name='+encodeURIComponent(name),data)).status,status,name);
    assert.equal(f.backend.getConfig().wallpaper.id,old);
  }
  assert.equal((await call(f.port,'POST','/api/upload?name=too-big.mp4',undefined,{Authorization:'Bearer '+f.token,'Content-Length':String(MAX_UPLOAD+1)})).status,413);
  assert.equal(f.backend.getConfig().wallpaper.id,old);
  const names=await fs.readdir(path.join(f.dir,'media'));assert.equal(names.length,1);assert.equal(names.some(n=>n.endsWith('.upload')),false);
});

test('interrupted upload preserves prior media and releases the upload lock',async t=>{
  const f=await fixture(t);await f.request('POST','/api/upload?name=first.png',png);const old=f.backend.getConfig().wallpaper.id;
  await new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:f.port,path:'/api/upload?name=interrupted.png',method:'POST',agent:false,headers:{Authorization:'Bearer '+f.token,'Content-Length':4096}});
    req.on('error',()=>resolve());req.write(png);
    setTimeout(()=>{req.destroy();resolve();},50);
    req.setTimeout(2000,()=>reject(Error('abort timed out')));
  });
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(f.backend.getConfig().wallpaper.id,old);
  assert.equal((await f.request('POST','/api/upload?name=next.mp4',mp4)).status,200);
  assert.equal((await fs.readdir(path.join(f.dir,'media'))).some(n=>n.endsWith('.upload')),false);
});

test('insufficient disk space rejects upload before changing wallpaper',async t=>{
  const f=await fixture(t,{diskFree:async()=>1});
  assert.equal((await f.request('POST','/api/upload?name=wallpaper.png',png)).status,507);
  assert.equal(f.backend.getConfig().wallpaper,null);
  assert.deepEqual(await fs.readdir(path.join(f.dir,'media')),[]);
});

test('byte ranges support bounded, open, suffix and HEAD responses',async t=>{
  const f=await fixture(t);await f.request('POST','/api/upload?name=wallpaper.png',png);
  const route='/media/wallpaper?token='+f.token;
  for(const [range,start,end] of [['bytes=0-7',0,7],['bytes=8-',8,png.length-1],['bytes=-4',png.length-4,png.length-1],['bytes=0-999',0,png.length-1]]){
    const r=await call(f.port,'GET',route,undefined,{Range:range});assert.equal(r.status,206);assert.deepEqual(r.buffer,png.subarray(start,end+1));assert.equal(r.headers['content-range'],`bytes ${start}-${end}/${png.length}`);
  }
  const head=await call(f.port,'HEAD',route,undefined,{Range:'bytes=0-7'});assert.equal(head.status,206);assert.equal(head.buffer.length,0);assert.equal(head.headers['content-length'],'8');
  for(const range of ['bytes=999-','bytes=9-2','bytes=-0','bytes=0-1,3-4','bytes=0-1;evil','bytes=9007199254740993-']){
    const r=await call(f.port,'GET',route,undefined,{Range:range});assert.equal(r.status,416,range);assert.equal(r.headers['content-range'],'bytes */'+png.length);
  }
});

test('range parser handles empty resource and invalid numeric boundaries',()=>{
  assert.equal(parseRange(undefined,10),null);
  for(const [header,size] of [['bytes=-1',0],['bytes=-',1],['items=0-1',10],['bytes=0-9007199254740993',10]])assert.throws(()=>parseRange(header,size),e=>e.status===416);
});

test('restart retains selected app order, settings and wallpaper but invalidates old tokens',async t=>{
  const f=await fixture(t);await f.request('PATCH','/api/config',{revision:0,appIds:['netflix','youtube'],clock24:true,location,temperatureUnit:'celsius',dim:0.5});
  await f.request('POST','/api/upload?name=persist.png',png);const before=f.backend.getConfig();const oldToken=f.token;const phone=await f.pair();
  await f.restart();assert.deepEqual(f.backend.getConfig(),before);
  assert.equal((await call(f.port,'GET','/api/state',undefined,{Authorization:'Bearer '+oldToken})).status,401);
  assert.equal((await call(f.port,'GET','/api/state',undefined,{Authorization:'Bearer '+phone})).status,401);
  assert.deepEqual((await f.request('GET','/media/wallpaper')).buffer,png);
});

test('corrupted saved settings are surfaced and cannot be silently overwritten',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.dir,'config.json'),'not json');await f.restart();
  const state=await f.request('GET','/api/state');assert.match(state.json.warning,/Recovery/);
  assert.equal((await f.request('PATCH','/api/config',{revision:0,clock24:true})).status,500);
  assert.equal(await fs.readFile(path.join(f.dir,'config.json'),'utf8'),'not json');
});

test('structurally invalid saved settings are rejected before entering UI state',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.dir,'config.json'),JSON.stringify({...f.backend.getConfig(),appIds:{invalid:true},clock24:'yes',dim:9,temperatureUnit:'kelvin'}));await f.restart();
  const state=await f.request('GET','/api/state');assert.match(state.json.warning||'',/Recovery/);
  assert.equal((await f.request('PATCH','/api/config',{revision:0,clock24:true})).status,500);
});

test('startup reclaims only interrupted uploads and retains old media plus unrelated files',async t=>{
  const f=await fixture(t);await f.request('POST','/api/upload?name=active.png',png);
  const active=f.backend.getConfig().wallpaper;const mediaDir=path.join(f.dir,'media');
  const abandoned=['a'.repeat(32)+'.upload','b'.repeat(32)+'.mp4','c'.repeat(32)+'.png','d'.repeat(32)+'.jpg','e'.repeat(32)+'.webp'];
  const unrelated=['personal-photo.png','f'.repeat(31)+'.upload','A'.repeat(32)+'.jpg','a'.repeat(32)+'.txt'];
  for(const name of abandoned.concat(unrelated))await fs.writeFile(path.join(mediaDir,name),Buffer.from('preservation fixture'));
  await f.restart();
  assert.deepEqual((await fs.readdir(mediaDir)).sort(),abandoned.filter(name=>!name.endsWith('.upload')).concat(unrelated,active.id+'.png').sort());
  assert.deepEqual(f.backend.getConfig().wallpaper,active);
  assert.deepEqual((await f.request('GET','/media/wallpaper')).buffer,png);
});

test('startup preserves all media for recovery when saved configuration is corrupt',async t=>{
  const f=await fixture(t);await f.request('POST','/api/upload?name=active.png',png);
  const mediaDir=path.join(f.dir,'media');
  for(const name of ['a'.repeat(32)+'.upload','b'.repeat(32)+'.mp4','personal-photo.png'])await fs.writeFile(path.join(mediaDir,name),Buffer.from('recovery fixture'));
  const before=(await fs.readdir(mediaDir)).sort();
  const content=await Promise.all(before.map(name=>fs.readFile(path.join(mediaDir,name))));
  await fs.writeFile(path.join(f.dir,'config.json'),'interrupted config write');await f.restart();
  const state=await f.request('GET','/api/state');assert.match(state.json.warning,/Recovery/);
  assert.deepEqual((await fs.readdir(mediaDir)).sort(),before);
  for(let i=0;i<before.length;i++)assert.deepEqual(await fs.readFile(path.join(mediaDir,before[i])),content[i]);
});
