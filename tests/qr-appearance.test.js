'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const vm=require('node:vm');
const jsQR=require('jsqr');
const qrcode=require('../app/qr-code');
const {createBackend}=require('../service/backend');

function raster(qr,scale=6){
  const count=qr.getModuleCount(),width=(count+8)*scale;
  const data=new Uint8ClampedArray(width*width*4);data.fill(255);
  for(let row=0;row<count;row++)for(let col=0;col<count;col++)if(qr.isDark(row,col)){
    for(let y=0;y<scale;y++)for(let x=0;x<scale;x++){
      const offset=(((row+4)*scale+y)*width+(col+4)*scale+x)*4;
      data[offset]=data[offset+1]=data[offset+2]=0;
    }
  }
  return {data,width};
}
function decode(text){const qr=qrcode(0,'M');qr.addData(text);qr.make();const {data,width}=raster(qr);return jsQR(data,width,width);}
function request(port,token,method,route,body){
  return new Promise((resolve,reject)=>{
    const data=body===undefined?null:Buffer.from(JSON.stringify(body));
    const req=http.request({host:'127.0.0.1',port,method,path:route,agent:false,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(data?{'Content-Type':'application/json','Content-Length':data.length}:{})}},res=>{
      let out='';res.setEncoding('utf8');res.on('data',c=>out+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(out)}));res.on('error',reject);
    });req.on('error',reject);req.end(data);
  });
}
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'still-home-appearance-'));
  const options={stateDir:dir,port:0,bind:'127.0.0.1',demo:true,platform:{apps:async()=>[],launch:async()=>{}}};
  let backend=await createBackend(options);
  const f={dir,get config(){return backend.getConfig();},get token(){return backend.bootstrap().token;},call:(method,route,body,token)=>request(backend.server.address().port,token===undefined?f.token:token,method,route,body),restart:async()=>{await backend.close();backend=await createBackend(options);}};
  t.after(async()=>{await backend.close();await fs.rm(dir,{recursive:true,force:true});});return f;
}

test('vendored QR creates a genuinely decodable LAN pairing URL',()=>{
  for(const url of ['http://192.168.1.50:1877/#pair=123456','http://10.0.2.15:19429/#pair=987654','http://172.31.255.254:1877/#pair=100001']){
    const result=decode(url);assert(result,'QR must decode using independent jsQR implementation');assert.equal(result.data,url);
    assert.equal(new URL(result.data).search,'');assert.match(new URL(result.data).hash,/^#pair=\d{6}$/);
  }
});

test('browser QR bundle exposes matrix interface without network or module dependencies',async()=>{
  const source=await fs.readFile(path.join(__dirname,'../app/qr-code.js'),'utf8');
  const context=vm.createContext({});vm.runInContext(source,context);
  assert.equal(typeof context.qrcode,'function');
  const qr=context.qrcode(0,'M');for(const method of ['addData','make','getModuleCount','isDark'])assert.equal(typeof qr[method],'function');
  qr.addData('http://192.168.1.50:1877/#pair=123456');qr.make();
  const image=raster(qr);assert.equal(jsQR(image.data,image.width,image.width).data,'http://192.168.1.50:1877/#pair=123456');
});

test('QR pairing URL contains correct one-time code and replay remains unauthorized',async t=>{
  const f=await fixture(t);const pair=await f.call('POST','/api/pairing',{});assert.equal(pair.status,200);
  assert.equal(pair.body.qrUrl,pair.body.url+'/#pair='+pair.body.code);
  const decoded=decode(pair.body.qrUrl);assert(decoded);const code=new URLSearchParams(new URL(decoded.data).hash.slice(1)).get('pair');
  const accepted=await f.call('POST','/api/pair',{code},null);assert.equal(accepted.status,200);
  assert.equal((await f.call('POST','/api/pair',{code},null)).status,401);
  assert.equal((await f.call('POST','/api/pairing',{},accepted.body.token)).status,403);
});

test('new QR invalidates prior code and expiration remains enforced',async t=>{
  const f=await fixture(t);const old=(await f.call('POST','/api/pairing',{})).body;
  const current=(await f.call('POST','/api/pairing',{})).body;
  if(old.code!==current.code)assert.equal((await f.call('POST','/api/pair',{code:old.code},null)).status,401);
  const realNow=Date.now;
  try{Date.now=()=>realNow()+11*60*1000;assert.equal((await f.call('POST','/api/pair',{code:current.code},null)).status,401);}finally{Date.now=realNow;}
});

test('appearance defaults migrate older saved config without losing existing settings',async t=>{
  const f=await fixture(t);assert.equal(f.config.clockScale,1);assert.equal(f.config.dateScale,1);assert.equal(f.config.weatherScale,1);assert.equal(f.config.textShade,0);
  await fs.writeFile(path.join(f.dir,'config.json'),JSON.stringify({revision:8,appIds:[],clock24:true,temperatureUnit:'celsius',location:null,dim:0.44,wallpaper:null}));await f.restart();
  assert.equal(f.config.revision,8);assert.equal(f.config.clock24,true);assert.equal(f.config.dim,0.44);assert.deepEqual(f.config.appIds,[]);
  assert.equal(f.config.clockScale,1);assert.equal(f.config.dateScale,1);assert.equal(f.config.weatherScale,1);assert.equal(f.config.textShade,0);
  assert.equal((await f.call('GET','/api/state')).body.warning,null);
});

test('appearance validates types and boundaries and preserves settings on rejected changes',async t=>{
  const f=await fixture(t);
  for(const field of ['clockScale','dateScale','weatherScale'])for(const value of [0.69,1.51,'1',null,false])assert.equal((await f.call('PATCH','/api/config',{revision:0,[field]:value})).status,400,field+'='+JSON.stringify(value));
  for(const value of [-0.01,0.81,'0.4',null,false])assert.equal((await f.call('PATCH','/api/config',{revision:0,textShade:value})).status,400);
  assert.equal(f.config.revision,0);
  assert.equal((await f.call('PATCH','/api/config',{revision:0,clockScale:0.7,dateScale:1.5,weatherScale:0.7,textShade:0.8})).status,200);
  assert.equal((await f.call('PATCH','/api/config',{revision:1,clockScale:1.5,dateScale:0.7,weatherScale:1.5,textShade:0})).status,200);
  assert.equal(f.config.clockScale,1.5);assert.equal(f.config.dateScale,0.7);assert.equal(f.config.weatherScale,1.5);assert.equal(f.config.textShade,0);
});

test('paired phone can save appearance and values persist across service restart',async t=>{
  const f=await fixture(t);const p=(await f.call('POST','/api/pairing',{})).body;const phone=(await f.call('POST','/api/pair',{code:p.code},null)).body.token;
  const values={clockScale:1.2,dateScale:0.9,weatherScale:1.3,textShade:0.55};
  assert.equal((await f.call('PATCH','/api/config',{revision:0,...values},phone)).status,200);await f.restart();
  for(const key of Object.keys(values))assert.equal(f.config[key],values[key]);
  assert.equal((await f.call('GET','/api/state',undefined,phone)).status,401);
});

test('concurrent appearance edits conflict instead of silently overwriting each other',async t=>{
  const f=await fixture(t);const results=await Promise.all([f.call('PATCH','/api/config',{revision:0,clockScale:1.2}),f.call('PATCH','/api/config',{revision:0,textShade:0.4})]);
  assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);assert.equal(f.config.revision,1);
  const retry=await f.call('PATCH','/api/config',{revision:1,clockScale:1.2,textShade:0.4});assert.equal(retry.status,200);assert.equal(f.config.clockScale,1.2);assert.equal(f.config.textShade,0.4);
});
