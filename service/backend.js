'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
const {execFile} = require('child_process');
const imageInfo = require('./public/image-info');
const resetState = require('./reset-state');
const {createDeviceStore,deviceName,YEAR}=require('./remembered-devices');
const APP_ID = 'com.tomperry.stillhome';
const MAX_UPLOAD = 150 * 1024 * 1024;
const randomToken = () => crypto.randomBytes(32).toString('hex');
const VERSION = '0.5.7';
const SCALE_FIELDS = ['clockScale','dateScale','weatherScale'];
const DEFAULT_WALLPAPER=require('./default-wallpaper.json');
const defaultWallpaper=()=>({id:DEFAULT_WALLPAPER.id,name:DEFAULT_WALLPAPER.name,width:DEFAULT_WALLPAPER.width,height:DEFAULT_WALLPAPER.height});
const defaults = () => ({revision:0,appIds:null,clock24:false,temperatureUnit:'fahrenheit',location:null,dim:0.32,wallpaper:null,clockScale:1,dateScale:1,weatherScale:1,textShade:0,launchAtStart:false,kenBurns:false,kenBurnsSpeed:1,wallpaperLibrary:[],defaultWallpaper:defaultWallpaper(),defaultFocalPoint:Object.assign({},DEFAULT_WALLPAPER.focalPoint),deletedWallpaperIds:[]});
class HttpError extends Error { constructor(status, message) { super(message); this.status=status; } }
function fail(status,message) { throw new HttpError(status,message); }
function equal(a,b) { if(typeof a!=='string'||typeof b!=='string') return false; const aa=Buffer.from(a),bb=Buffer.from(b);if(aa.length!==bb.length)return false;return crypto.timingSafeEqual(aa,bb); }
function privateIPv4(ip) {return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);}
function validateFocalPoint(point) {
  if(point===null)return null;
  if(!point||typeof point!=='object'||Array.isArray(point)||Object.keys(point).length!==2||!Number.isFinite(point.x)||!Number.isFinite(point.y)||point.x<0||point.x>1||point.y<0||point.y>1)fail(400,'Choose a focal point within the photo.');
  return {x:point.x,y:point.y};
}
function normalizeWallpaper(w) {
  if(!w||typeof w!=='object'||Array.isArray(w)||!/^[a-f0-9]{32}$/.test(w.id)||!['image/jpeg','image/png','image/webp','video/mp4'].includes(w.mime)||w.kind!==(w.mime==='video/mp4'?'video':'image')||typeof w.name!=='string'||!w.name||w.name.length>200||!Number.isSafeInteger(w.size)||w.size<1||w.size>MAX_UPLOAD)fail(400,'Invalid saved wallpaper.');
  const result={id:w.id,name:w.name,kind:w.kind,mime:w.mime,size:w.size,focalPoint:validateFocalPoint(w.focalPoint===undefined?null:w.focalPoint)};
  if(w.kind==='video'&&result.focalPoint!==null)fail(400,'Video wallpapers do not have a photo focal point.');
  for(const key of ['width','height'])if(w[key]!==undefined){if(!Number.isSafeInteger(w[key])||w[key]<1)fail(400,'Invalid saved image dimensions.');result[key]=w[key];}
  if(w.createdAt!==undefined){if(!Number.isFinite(w.createdAt)||w.createdAt<0)fail(400,'Invalid saved wallpaper date.');result.createdAt=w.createdAt;}
  return result;
}
function localIPs() { return Object.values(os.networkInterfaces()).flat().filter(x=>x && (x.family==='IPv4'||x.family===4) && privateIPv4(x.address)).map(x=>x.address); }
function validateLocation(v) {
  if(v===null) return null;
  if(!v||typeof v!=='object'||Array.isArray(v)||typeof v.name!=='string'||!v.name.trim()||v.name.length>150||!Number.isFinite(v.latitude)||!Number.isFinite(v.longitude)||Math.abs(v.latitude)>90||Math.abs(v.longitude)>180) fail(400,'Choose a valid weather location.');
  return {name:v.name.trim(),latitude:v.latitude,longitude:v.longitude};
}
function parseRange(header,size) {
  if(!header) return null;
  const m=/^bytes=(\d*)-(\d*)$/.exec(header);
  if(!m||(!m[1]&&!m[2])||size===0) fail(416,'Invalid byte range.');
  let start,end;
  if(!m[1]) { const n=Number(m[2]); if(!Number.isSafeInteger(n)||n<=0) fail(416,'Invalid byte range.'); start=Math.max(0,size-n); end=size-1; }
  else { start=Number(m[1]); end=m[2]?Number(m[2]):size-1; }
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||start<0||end<start) fail(416,'Invalid byte range.');
  return {start,end:Math.min(end,size-1)};
}
function mediaType(buffer,name) {
  const ext=path.extname(name).toLowerCase();
  if(['.jpg','.jpeg'].includes(ext)&&buffer[0]===255&&buffer[1]===216&&buffer[2]===255) return {kind:'image',mime:'image/jpeg',ext:'.jpg'};
  if(ext==='.png'&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return {kind:'image',mime:'image/png',ext};
  if(ext==='.webp'&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP') return {kind:'image',mime:'image/webp',ext};
  if(ext==='.mp4'&&buffer.toString('ascii',4,8)==='ftyp'&&buffer.length>=16) return {kind:'video',mime:'video/mp4',ext};
  fail(415,'This file is not a supported JPG, PNG, WebP or MP4.');
}
function safeImage(header, size, mime) {
  let info;
  try { info=imageInfo.inspect(header,size); } catch(e) { fail(415,e.message); }
  if(info.mime!==mime)fail(415,'The photo format does not match its filename.');
  if(info.animated)fail(415,'Animated image files are not supported. Use a looping MP4 instead.');
  if(info.width>imageInfo.MAX_SIDE||info.height>imageInfo.MAX_SIDE||info.width*info.height>imageInfo.MAX_PIXELS)fail(413,'This photo is too large for smooth TV playback. Refresh the phone page and upload it again to resize a copy automatically.');
  return info.orientation>=5?{width:info.height,height:info.width}:{width:info.width,height:info.height};
}
async function readImageHeader(file) {
  const fd=await fsp.open(file,'r');
  try {const stat=await fd.stat(),header=Buffer.alloc(Math.min(stat.size,imageInfo.HEADER_BYTES));let offset=0;
    while(offset<header.length){const result=await fd.read(header,offset,header.length-offset,offset);if(!result.bytesRead)break;offset+=result.bytesRead;}
    return {header:header.subarray(0,offset),size:stat.size};
  } finally {await fd.close();}
}
function getJSON(url) {
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers:{'User-Agent':'StillHome/'+VERSION,'Accept':'application/json'}},res=>{
      if(res.statusCode!==200) {res.resume(); reject(new Error('Weather provider returned '+res.statusCode)); return;}
      let parts=[],size=0;
      res.on('data',c=>{size+=c.length; if(size>1024*1024) req.destroy(new Error('Weather response too large')); else parts.push(c);});
      res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(parts).toString()));}catch(e){reject(e);}});
      res.on('error',reject);
    });
    req.setTimeout(12000,()=>req.destroy(new Error('Weather request timed out'))); req.on('error',reject);
  });
}
async function jsonBody(req) {
  let chunks=[],size=0;
  for await (const c of req) {size+=c.length; if(size>16384) fail(413,'Request is too large.'); chunks.push(c);}
  try {const obj=JSON.parse(Buffer.concat(chunks).toString()); if(!obj||typeof obj!=='object'||Array.isArray(obj)) throw Error(); return obj;}
  catch(e) {fail(400,'Invalid JSON request.');}
}
function diskFree(dir) {return new Promise((resolve,reject)=>execFile('/bin/df',['-Pk',dir],{timeout:5000},(e,out)=>{if(e)return reject(e);const fields=out.trim().split('\n').pop().trim().split(/\s+/); const n=Number(fields[3])*1024; Number.isFinite(n)?resolve(n):reject(Error('Could not check available storage'));}));}
async function createBackend(options={}) {
  const stateDir=options.stateDir||'/var/lib/webosbrew/still-home';
  await fsp.mkdir(path.join(stateDir,'media'),{recursive:true,mode:0o700});
  await resetState.resume(stateDir);
  const configPath=path.join(stateDir,'config.json');
  let config=defaults(), configError=null;
  try {
    const saved=JSON.parse(await fsp.readFile(configPath,'utf8'));
    if(!saved||!Number.isSafeInteger(saved.revision)||saved.revision<0)throw Error('Invalid revision');
    const loaded=Object.assign(defaults(),saved);
    // Framing belongs to an asset. Do not apply the old bundled photo's crop to a new one.
    if(!saved.defaultWallpaper||saved.defaultWallpaper.id!==DEFAULT_WALLPAPER.id)loaded.defaultFocalPoint=Object.assign({},DEFAULT_WALLPAPER.focalPoint);
    loaded.defaultWallpaper=defaultWallpaper();
    loaded.location=validateLocation(loaded.location);
    if(typeof loaded.clock24!=='boolean'||!['fahrenheit','celsius'].includes(loaded.temperatureUnit)||!Number.isFinite(loaded.dim)||loaded.dim<0||loaded.dim>0.75)throw Error('Invalid saved settings');
    if(SCALE_FIELDS.some(key=>!Number.isFinite(loaded[key])||loaded[key]<0.7||loaded[key]>1.5)||!Number.isFinite(loaded.textShade)||loaded.textShade<0||loaded.textShade>0.8)throw Error('Invalid saved text appearance');
    if(!Number.isFinite(loaded.kenBurnsSpeed)||loaded.kenBurnsSpeed<0.25||loaded.kenBurnsSpeed>3)throw Error('Invalid saved motion speed');
    if(typeof loaded.launchAtStart!=='boolean')throw Error('Invalid saved startup preference');
    if(typeof loaded.kenBurns!=='boolean')throw Error('Invalid saved motion preference');
    if(loaded.appIds!==null&&(!Array.isArray(loaded.appIds)||loaded.appIds.length>100||loaded.appIds.some(id=>typeof id!=='string')||new Set(loaded.appIds).size!==loaded.appIds.length))throw Error('Invalid saved app list');
    loaded.defaultFocalPoint=validateFocalPoint(loaded.defaultFocalPoint);
    if(!Array.isArray(loaded.wallpaperLibrary))throw Error('Invalid wallpaper library');
    loaded.wallpaperLibrary=loaded.wallpaperLibrary.map(normalizeWallpaper);
    if(!Array.isArray(loaded.deletedWallpaperIds)||loaded.deletedWallpaperIds.some(id=>typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id))||new Set(loaded.deletedWallpaperIds).size!==loaded.deletedWallpaperIds.length)throw Error('Invalid deleted wallpaper list');
    if(loaded.wallpaperLibrary.some(w=>loaded.deletedWallpaperIds.includes(w.id))||(loaded.wallpaper&&loaded.deletedWallpaperIds.includes(loaded.wallpaper.id)))throw Error('Conflicting deleted wallpaper');
    if(new Set(loaded.wallpaperLibrary.map(w=>w.id)).size!==loaded.wallpaperLibrary.length)throw Error('Duplicate wallpaper ID');
    if(loaded.wallpaper!==null){
      const current=normalizeWallpaper(loaded.wallpaper);
      let entry=loaded.wallpaperLibrary.find(w=>w.id===current.id);
      if(!entry){entry=current;loaded.wallpaperLibrary.push(entry);}
      loaded.wallpaper=entry;
    }
    config=loaded;
  } catch(e) {if(e.code!=='ENOENT')configError='Saved settings could not be read. Recovery is required before saving.';}
  const tvToken=randomToken(), phoneTokens=new Map(), pairAttempts=new Map();
  const authNow=options.now||(()=>Date.now());
  let deviceStore=await createDeviceStore(stateDir,authNow);
  let resetGeneration=0,resetBusy=false,resetPreview=null,resetOperation=null;
  function checkRequest(req){if(resetBusy)fail(503,'Still Home reset is in progress. Check again shortly.');if(req.stillHomeGeneration!==resetGeneration)fail(409,'Still Home was reset. Reload before making another change.');}
  let authQueue=Promise.resolve();
  function changeAuth(fn){const p=authQueue.then(fn);authQueue=p.catch(()=>{});return p;}
  function forgetTokens(ids){for(const [token,session]of phoneTokens)if(ids.includes(session.deviceId))phoneTokens.delete(token);}
  function cleanPhoneTokens(){for(const [token,session]of phoneTokens)if(session.expiresAt<=authNow()||(session.deviceId&&!deviceStore.active(session.deviceId)))phoneTokens.delete(token);}
  function issuePhoneToken(deviceId){
    cleanPhoneTokens();
    const peers=Array.from(phoneTokens).filter(([,session])=>session.deviceId===(deviceId||undefined));
    if(peers.length>=20){
      if(!deviceId)fail(429,'Too many paired sessions. Try again later.');
      // A repeatedly reopened phone cannot fill memory or block other phones.
      phoneTokens.delete(peers[0][0]);
    }
    const token=randomToken(),expiresAt=authNow()+1800000;
    phoneTokens.set(token,{expiresAt,...(deviceId?{deviceId}:{})});
    return {token,expiresAt,remembered:!!deviceId,deviceId:deviceId||null};
  }
  function deviceCookie(req){
    const matches=(req.headers.cookie||'').split(';').map(part=>part.trim()).filter(part=>part.startsWith('stillhome_device='));
    if(matches.length!==1)return null;
    const credential=matches[0].slice('stillhome_device='.length);
    return /^[a-f0-9]{64}$/.test(credential)?credential:null;
  }
  function setDeviceCookie(res,credential){res.setHeader('Set-Cookie','stillhome_device='+(credential||'')+'; HttpOnly; SameSite=Strict; Path=/; Max-Age='+(credential?YEAR/1000:0));}
  function phoneBearer(req){const match=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization||'');return match?match[1]:null;}
  let pairing=null, uploadBusy=false, appsCache=null, appsExpires=0, weatherCache=null, weatherPromise=null;
  const requestJSON=options.getJSON||getJSON;
  const platform=options.platform||{apps:async()=>[],launch:async()=>fail(503,'TV bridge unavailable.')};
  const mediaPath=w=>path.join(stateDir,'media',w.id+(w.mime==='video/mp4'?'.mp4':w.mime==='image/jpeg'?'.jpg':w.mime==='image/png'?'.png':'.webp'));
  const checkedImageIds=new Set();
  const localPhoto=path.join(__dirname,'..','app','wallpaper.jpg');
  const bundledPhoto=options.bundledPhoto||(fs.existsSync(localPhoto)?localPhoto:'/media/developer/apps/usr/palm/applications/'+APP_ID+'/wallpaper.jpg');
  let checkedDefaultPhoto=false;
  async function purgeDeleted(id) {
    const dir=path.join(stateDir,'media'),stat=await fsp.lstat(dir);
    if(!stat.isDirectory())fail(409,'Wallpaper storage needs recovery.');
    for(const ext of ['.jpg','.png','.webp','.mp4']){
      const file=path.join(dir,id+ext),entry=await fsp.lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
      if(!entry)continue;
      if(!entry.isFile())fail(409,'This wallpaper file needs recovery before deletion.');
      await fsp.unlink(file);
    }
    const fd=await fsp.open(dir,'r');try{await fd.sync();}finally{await fd.close();}
    checkedImageIds.delete(id);
  }
  async function regularMedia(file) {
    const stat=await fsp.lstat(file).catch(()=>fail(404,'The saved wallpaper file is not available.'));
    if(!stat.isFile())fail(404,'The saved wallpaper file is not available.');
  }
  async function checkSavedImage(w) {
    await regularMedia(mediaPath(w));
    if(w.kind!=='image'||checkedImageIds.has(w.id))return;
    const data=await readImageHeader(mediaPath(w)).catch(()=>fail(404,'The saved photo is not available.'));
    safeImage(data.header,data.size,w.mime);checkedImageIds.add(w.id);
  }
  // Retain completed media, including files from older versions. Recover safe
  // unindexed uploads without rewriting preferences merely because we started.
  // Corrupt configuration preserves every file for deliberate recovery.
  if(!configError){
    // Persisted deletion markers are authoritative before orphan recovery.
    // An interrupted unlink must never resurrect a deleted photograph.
    for(const id of config.deletedWallpaperIds)await purgeDeleted(id);
    const indexed=new Set(config.wallpaperLibrary.map(w=>w.id));
    for(const file of await fsp.readdir(path.join(stateDir,'media'))){
      if(/^[a-f0-9]{32}\.upload$/.test(file)){await fsp.unlink(path.join(stateDir,'media',file)).catch(()=>{});continue;}
      const match=/^([a-f0-9]{32})\.(jpg|png|webp|mp4)$/.exec(file);
      if(!match||indexed.has(match[1]))continue;
      try{
        const filePath=path.join(stateDir,'media',file),stat=await fsp.lstat(filePath);
        if(!stat.isFile()||stat.size<1||stat.size>MAX_UPLOAD)continue;
        const data=await readImageHeader(filePath),type=mediaType(data.header,file);
        const dimensions=type.kind==='image'?safeImage(data.header,data.size,type.mime):{};
        const entry=normalizeWallpaper(Object.assign({id:match[1],name:'Recovered '+(type.kind==='image'?'photo':'video')+' '+match[1].slice(0,6)+type.ext,kind:type.kind,mime:type.mime,size:data.size,createdAt:Math.max(0,stat.mtimeMs),focalPoint:null},dimensions));
        config.wallpaperLibrary.push(entry);indexed.add(entry.id);
        if(type.kind==='image')checkedImageIds.add(entry.id);
      }catch(_error){/* Preserve unsafe/unsupported files without loading pixels. */}
    }
  }
  async function save(next) {
    if(configError)fail(500,configError);
    next=Object.assign({},next,{revision:config.revision+1});
    const tmp=configPath+'.'+randomToken()+'.tmp';
    const fd=await fsp.open(tmp,'wx',0o600);
    try {await fd.writeFile(JSON.stringify(next,null,2)+'\n');await fd.sync();} finally {await fd.close();}
    try{await fsp.rename(tmp,configPath);}catch(e){await fsp.unlink(tmp).catch(()=>{});throw e;}
    config=next;
    const directory=await fsp.open(stateDir,'r');try{await directory.sync();}finally{await directory.close();}
    return config;
  }
  // Serialize configuration commits, including upload completion.
  let writeQueue=Promise.resolve();
  function mutate(fn){const p=writeQueue.then(fn);writeQueue=p.catch(()=>{});return p;}
  // Lock order is configuration, then authentication. Revocation shares the
  // short commit lock so it cannot finish while a phone's save is still pending.
  // Request bodies and uploads are received before entering either lock.
  function mutateAuthorized(req,url,fn){return mutate(()=>changeAuth(()=>{checkRequest(req);authenticate(req,url);return fn();}));}
  async function apps(force=false) {
    if(!force&&appsCache&&Date.now()<appsExpires)return appsCache;
    const list=await platform.apps();const ids=new Set();
    appsCache=list.filter(a=>a&&typeof a.id==='string'&&a.id!==APP_ID&&typeof a.title==='string'&&!a.hidden&&!a.noDisplay&&!ids.has(a.id)&&ids.add(a.id));
    appsExpires=Date.now()+30000;return appsCache;
  }
  const clientApps=list=>list.map(a=>({id:a.id,title:a.title,icon:a.icon?'/api/icon?id='+encodeURIComponent(a.id):null}));
  async function weather() {
    if(!config.location)return {configured:false};
    const location=config.location,unit=config.temperatureUnit,key=JSON.stringify([location,unit]);
    if(weatherCache&&weatherCache.key===key&&Date.now()-weatherCache.time<900000)return weatherCache.data;
    if(weatherPromise&&weatherPromise.key===key)return weatherPromise.promise;
    const promise=(async()=>{
      try {
        const query=new URLSearchParams({latitude:String(location.latitude),longitude:String(location.longitude),current:'temperature_2m,weather_code,is_day',temperature_unit:unit,timezone:'auto'});
        const r=await requestJSON('https://api.open-meteo.com/v1/forecast?'+query);
        if(!r.current||!Number.isFinite(r.current.temperature_2m))throw Error('Missing current weather');
        const data={configured:true,temperature:r.current.temperature_2m,code:r.current.weather_code,isDay:r.current.is_day===1,updatedAt:new Date().toISOString(),stale:false,location:location.name};
        weatherCache={key,time:Date.now(),data};return data;
      } catch(e) {if(weatherCache&&weatherCache.key===key)return Object.assign({},weatherCache.data,{stale:true});fail(503,'Weather is temporarily unavailable. Check the TV internet connection.');}
      finally {if(weatherPromise&&weatherPromise.key===key)weatherPromise=null;}
    })();weatherPromise={key,promise};return promise;
  }
  function authenticate(req,url) {
    const bearer=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization||'');
    const queryToken=['GET','HEAD'].includes(req.method)&&['/media/wallpaper','/media/library','/api/icon'].includes(url.pathname)?url.searchParams.get('token'):null;
    const token=bearer?bearer[1]:queryToken;
    if(equal(token,tvToken))return 'tv';
    const session=phoneTokens.get(token);
    if(session&&session.expiresAt>authNow()&&(!session.deviceId||deviceStore.active(session.deviceId)))return 'phone';
    if(session)phoneTokens.delete(token);fail(401,'Pair with the TV to continue.');
  }
  async function sendFile(req,res,file,mime,privateCache=false) {
    const stat=await fsp.stat(file).catch(()=>fail(404,'File is not available.'));
    let range;try{range=parseRange(req.headers.range,stat.size);}catch(e){res.setHeader('Content-Range','bytes */'+stat.size);throw e;}
    res.setHeader('Content-Type',mime);res.setHeader('Accept-Ranges','bytes');
    res.setHeader('Cache-Control',privateCache?'private, max-age=300':'no-store');
    if(range){res.statusCode=206;res.setHeader('Content-Range',`bytes ${range.start}-${range.end}/${stat.size}`);res.setHeader('Content-Length',range.end-range.start+1);}
    else res.setHeader('Content-Length',stat.size);
    if(req.method==='HEAD'){res.end();return;}
    const stream=fs.createReadStream(file,range||{});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
  }
  function json(res,status,obj){res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');if(!res.hasHeader('Cache-Control'))res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(obj));}
  const server=http.createServer(async(req,res)=>{
    req.stillHomeGeneration=resetGeneration;
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    try {
      const hosts=['localhost','127.0.0.1',...localIPs(),...(options.allowedHosts||[])];
      const expectedPort=String(server.address()?server.address().port:(options.port||1877));
      const host=new URL('http://'+(req.headers.host||''));
      if(!hosts.includes(host.hostname)||host.port!==expectedPort)fail(403,'Unrecognized TV address.');
      const url=new URL(req.url,'http://'+req.headers.host);
      const origin=req.headers.origin;
      const cookieEndpoint=['/api/pair','/api/session','/api/session/remember','/api/session/forget'].includes(url.pathname);
      if(cookieEndpoint||url.pathname.startsWith('/api/devices'))res.setHeader('Cache-Control','private, no-store');
      if(origin&&origin!=='null'&&origin!=='http://'+req.headers.host)fail(403,'This request must come from the paired phone page.');
      if(cookieEndpoint&&origin==='null')fail(403,'Open the phone page to manage this phone.');
      if(origin==='null'){res.setHeader('Access-Control-Allow-Origin','null');res.setHeader('Vary','Origin');}
      if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');res.setHeader('Access-Control-Allow-Methods','GET, HEAD, POST, PATCH');res.statusCode=204;res.end();return;}
      const publicFiles={'/':'index.html','/phone.js':'phone.js','/companion-layout.js':'companion-layout.js','/media-actions.js':'media-actions.js','/image-info.js':'image-info.js','/image-prepare.js':'image-prepare.js','/focal-math.js':'focal-math.js','/style.css':'style.css','/manifest.webmanifest':'manifest.webmanifest','/icon.svg':'icon.svg','/icon-192.png':'icon-192.png','/icon-512.png':'icon-512.png','/apple-touch-icon.png':'apple-touch-icon.png'};
      if(['GET','HEAD'].includes(req.method)&&publicFiles[url.pathname]){
        res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        const mime={'.js':'text/javascript','.css':'text/css','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png'}[path.extname(publicFiles[url.pathname])]||'text/html';
        return await sendFile(req,res,path.join(__dirname,'public',publicFiles[url.pathname]),mime);
      }
      if(resetBusy&&!['/api/reset/status','/api/reset/confirm'].includes(url.pathname))fail(503,'Still Home reset needs to finish. Open General settings to retry.');
      if(options.demo&&url.pathname==='/demo/bootstrap'&&req.method==='GET')return json(res,200,{baseUrl:'http://'+req.headers.host,token:tvToken});
      if(options.demo&&['GET','HEAD'].includes(req.method)&&url.pathname.startsWith('/tv/')){
        const file=url.pathname.slice(4);if(!['index.html','app.js','focus-navigation.js','media-actions.js','qr-code.js','focal-math.js','style.css','wallpaper.jpg','icon.png','largeIcon.png'].includes(file))fail(404,'Not found');
        return await sendFile(req,res,path.join(__dirname,'..','app',file),file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.jpg')?'image/jpeg':file.endsWith('.png')?'image/png':'text/html');
      }
      if(url.pathname==='/api/pair'&&req.method==='POST'){
        const ip=req.socket.remoteAddress; let attempts=pairAttempts.get(ip);
        if(!attempts||Date.now()>attempts.until){attempts={count:0,until:Date.now()+900000};pairAttempts.set(ip,attempts);}
        if(attempts.count>=8)fail(429,'Too many attempts. Wait 15 minutes and generate a new code.');
        attempts.count++;const body=await jsonBody(req);
        if(body.remember!==undefined&&typeof body.remember!=='boolean')fail(400,'Choose whether to remember this phone.');
        if(body.remember)deviceName(body.name);
        return await changeAuth(async()=>{checkRequest(req);
          if(!pairing||Date.now()>pairing.expiresAt||!equal(body.code,pairing.code))fail(401,'Incorrect or expired code. Generate a new code on the TV.');
          const credential=deviceCookie(req),previous=!deviceStore.error&&credential?deviceStore.find(credential):null;
          let result;
          if(body.remember){
            const remembered=await deviceStore.replace(previous?[previous.id]:[],body.name);
            if(previous)forgetTokens([previous.id]);
            result=issuePhoneToken(remembered.device.id);setDeviceCookie(res,remembered.credential);
          }else{
            cleanPhoneTokens();
            if(Array.from(phoneTokens.values()).filter(session=>!session.deviceId).length>=20)fail(429,'Too many paired sessions. Try again later.');
            if(previous){await deviceStore.revoke([previous.id]);forgetTokens([previous.id]);}
            result=issuePhoneToken();
            if((req.headers.cookie||'').includes('stillhome_device='))setDeviceCookie(res,null);
          }
          pairing=null;pairAttempts.delete(ip);return json(res,200,result);
        });
      }
      if(url.pathname==='/api/session'&&req.method==='POST')return await changeAuth(async()=>{checkRequest(req);
        const credential=deviceCookie(req),device=await deviceStore.touch(credential);
        if(!device){setDeviceCookie(res,null);fail(401,'Pair with the TV to remember this phone.');}
        setDeviceCookie(res,credential);return json(res,200,issuePhoneToken(device.id));
      });
      if(url.pathname==='/api/session/forget'&&req.method==='POST')return await changeAuth(async()=>{checkRequest(req);
        const credential=deviceCookie(req),device=!deviceStore.error?deviceStore.find(credential):null,token=phoneBearer(req);
        let session=null;
        if(token){try{if(authenticate(req,url)==='phone')session=phoneTokens.get(token);}catch(e){if(e.status!==401)throw e;}}
        if(!device&&!session){setDeviceCookie(res,null);return json(res,200,{ok:true,remembered:false,deviceId:null});}
        const ids=Array.from(new Set([device&&device.id,session&&session.deviceId].filter(Boolean)));
        if(ids.length)await deviceStore.revoke(ids);forgetTokens(ids);if(token)phoneTokens.delete(token);
        setDeviceCookie(res,null);return json(res,200,{ok:true,remembered:false,deviceId:null});
      });
      const role=authenticate(req,url);
      if(url.pathname==='/api/session/remember'&&req.method==='POST'){
        if(role!=='phone')fail(403,'Remember a phone from its paired phone page.');
        const body=await jsonBody(req);deviceName(body.name);
        return await changeAuth(async()=>{checkRequest(req);
          authenticate(req,url);
          const token=phoneBearer(req),session=phoneTokens.get(token),credential=deviceCookie(req),previous=deviceStore.find(credential);
          const ids=Array.from(new Set([previous&&previous.id,session.deviceId].filter(Boolean)));
          const remembered=await deviceStore.replace(ids,body.name);
          forgetTokens(ids);phoneTokens.delete(token);setDeviceCookie(res,remembered.credential);
          return json(res,200,issuePhoneToken(remembered.device.id));
        });
      }
      if(url.pathname==='/api/devices'&&req.method==='GET'){
        if(role!=='tv')fail(403,'Manage remembered phones in TV Settings.');
        return json(res,200,{devices:deviceStore.list()});
      }
      if(url.pathname==='/api/devices/revoke'&&req.method==='POST'){
        if(role!=='tv')fail(403,'Manage remembered phones in TV Settings.');
        const body=await jsonBody(req);
        if(typeof body.id!=='string'||!/^[a-f0-9]{32}$/.test(body.id))fail(400,'Choose a remembered phone.');
        return await changeAuth(async()=>{checkRequest(req);
          if(!deviceStore.list().some(d=>d.id===body.id))fail(404,'This phone is no longer remembered.');
          await deviceStore.revoke([body.id]);forgetTokens([body.id]);return json(res,200,{ok:true});
        });
      }
      if(req.method==='GET'&&url.pathname==='/api/pairing/status'){
        if(role!=='tv')fail(403,'Check pairing on the TV.');
        return json(res,200,{valid:!!(pairing&&pairing.id===url.searchParams.get('id')&&Date.now()<pairing.expiresAt)});
      }
      if(req.method==='GET'&&url.pathname==='/api/default-home'){
        if(role!=='tv')fail(403,'Configure Home on the TV.');
        const mapper=(await apps(true)).find(a=>a.id==='com.github.afonsojramos.magicmapper');
        return json(res,200,{mode:'guided',mapperId:mapper?mapper.id:null,managed:false,
          message:mapper?'Set Home → Launch app → Still Home in Magic Mapper. Existing mappings are managed there; automatic editing is unavailable.':'Magic Mapper was not found. Install or open your chosen mapper to configure Home → Still Home. Automatic editing is unavailable.'});
      }
      if(url.pathname==='/api/reset/status'&&req.method==='GET'){
        if(role!=='tv')fail(403,'Reset Still Home on the TV.');
        const result=resetOperation||await resetState.result(stateDir);
        return json(res,200,{operation:result?{id:result.id,status:result.status,message:result.message}:null,config:resetBusy?undefined:config});
      }
      if(url.pathname==='/api/reset/preview'&&req.method==='POST'){
        if(role!=='tv')fail(403,'Reset Still Home on the TV.');
        return await mutate(()=>changeAuth(async()=>{
          checkRequest(req);if(configError||deviceStore.error)fail(409,'Saved state needs recovery before reset.');
          if(uploadBusy)fail(409,'Wait for the wallpaper upload to finish before resetting.');
          const snapshot=await resetState.inventory(stateDir);
          resetPreview={id:crypto.randomBytes(16).toString('hex'),token:randomToken(),revision:config.revision,expiresAt:Date.now()+120000,snapshot};
          return json(res,200,{id:resetPreview.id,token:resetPreview.token,revision:config.revision,expiresAt:resetPreview.expiresAt,count:snapshot.count,bytes:snapshot.bytes});
        }));
      }
      if(url.pathname==='/api/reset/confirm'&&req.method==='POST'){
        if(role!=='tv')fail(403,'Reset Still Home on the TV.');
        const body=await jsonBody(req);
        return await mutate(()=>changeAuth(async()=>{
          if(!resetBusy){const previous=await resetState.result(stateDir);if(previous&&body.id===previous.id)return json(res,200,{operation:previous,config});}
          if(resetOperation&&body.id===resetOperation.id&&resetOperation.status==='complete')return json(res,200,{operation:resetOperation,config});
          const retry=resetBusy&&resetOperation&&body.id===resetOperation.id;
          if(!retry){
            checkRequest(req);
            if(!resetPreview||body.id!==resetPreview.id||!equal(body.token,resetPreview.token)||Date.now()>=resetPreview.expiresAt)fail(409,'Reset confirmation expired. Review it again.');
            if(config.revision!==resetPreview.revision||uploadBusy)fail(409,'Settings or uploads changed. Review reset again.');
            const snapshot=await resetState.inventory(stateDir);
            if(snapshot.digest!==resetPreview.snapshot.digest)fail(409,'Wallpapers changed. Review reset again.');
          }
          const id=body.id,preview=resetPreview;
          if(retry&&!equal(body.token,resetOperation.token))fail(403,'Use the original reset confirmation.');
          resetBusy=true;resetGeneration++;pairing=null;phoneTokens.clear();pairAttempts.clear();
          resetOperation={id,status:'running',token:retry?resetOperation.token:body.token};
          try{
            let completed=retry?await resetState.resume(stateDir,options.resetHook):null;
            if(!completed){const previous=await resetState.result(stateDir);if(previous&&previous.id===id)completed=previous;}
            if(!completed)completed=await resetState.begin(stateDir,id,Object.assign(defaults(),{revision:config.revision+1}),preview.snapshot,options.resetHook);
            config=JSON.parse(await fsp.readFile(configPath,'utf8'));configError=null;
            deviceStore=await createDeviceStore(stateDir,authNow);
            weatherCache=null;weatherPromise=null;checkedImageIds.clear();checkedDefaultPhoto=false;
            resetPreview=null;resetBusy=false;resetOperation=completed||await resetState.result(stateDir);
            return json(res,200,{operation:resetOperation,config});
          }catch(error){
            resetOperation.status='failed';resetOperation.message='Reset was interrupted. Retry this reset or restart the service to finish recovery.';
            fail(503,resetOperation.message);
          }
        }));
      }
      if(req.method==='GET'&&url.pathname==='/api/state')return json(res,200,{config,apps:clientApps(await apps()),version:VERSION,warning:configError});
      if(req.method==='GET'&&url.pathname==='/api/apps')return json(res,200,{apps:clientApps(await apps(true))});
      if(req.method==='GET'&&url.pathname==='/api/weather')return json(res,200,await weather());
      if(req.method==='GET'&&url.pathname==='/api/location'){
        const q=(url.searchParams.get('q')||'').trim();if(q.length<2||q.length>100)fail(400,'Enter a city or postal code (2–100 characters).');
        let r;try{r=await requestJSON('https://geocoding-api.open-meteo.com/v1/search?'+new URLSearchParams({name:q,count:'8',language:'en',format:'json'}));}catch(e){fail(503,'Location search is unavailable. Check your internet connection.');}
        return json(res,200,{results:(r.results||[]).map(x=>({name:[x.name,x.admin1,x.country].filter(Boolean).filter((x,i,a)=>a.indexOf(x)===i).join(', '),latitude:x.latitude,longitude:x.longitude}))});
      }
      if(req.method==='PATCH'&&url.pathname==='/api/config'){
        const body=await jsonBody(req);const allowed=['revision','appIds','clock24','temperatureUnit','location','dim','wallpaper',...SCALE_FIELDS,'textShade','kenBurns','kenBurnsSpeed','launchAtStart'];
        if(Object.keys(body).some(k=>!allowed.includes(k)))fail(400,'Unknown setting.');
        if('launchAtStart'in body&&typeof body.launchAtStart!=='boolean')fail(400,'Invalid startup preference.');
        if('clock24'in body&&typeof body.clock24!=='boolean')fail(400,'Invalid clock preference.');
        if('kenBurnsSpeed'in body&&(!Number.isFinite(body.kenBurnsSpeed)||body.kenBurnsSpeed<0.25||body.kenBurnsSpeed>3))fail(400,'Photo motion speed must be between 0.25 and 3.');
        if('kenBurns'in body&&typeof body.kenBurns!=='boolean')fail(400,'Invalid photo motion preference.');
        if('temperatureUnit'in body&&!['fahrenheit','celsius'].includes(body.temperatureUnit))fail(400,'Invalid temperature unit.');
        if('dim'in body&&(!Number.isFinite(body.dim)||body.dim<0||body.dim>0.75))fail(400,'Wallpaper dim must be between 0 and 0.75.');
        for(const key of SCALE_FIELDS)if(key in body&&(!Number.isFinite(body[key])||body[key]<0.7||body[key]>1.5))fail(400,'Text size must be between 70% and 150%.');
        if('textShade'in body&&(!Number.isFinite(body.textShade)||body.textShade<0||body.textShade>0.8))fail(400,'Local text shading must be between 0% and 80%.');
        if('location'in body)body.location=validateLocation(body.location);
        if('wallpaper'in body&&body.wallpaper!==null)fail(400,'Upload a file to choose a wallpaper.');
        if('appIds'in body&&body.appIds!==null){
          const valid=new Set((await apps(true)).map(a=>a.id));
          if(!Array.isArray(body.appIds)||body.appIds.length>100||new Set(body.appIds).size!==body.appIds.length||body.appIds.some(id=>typeof id!=='string'||!valid.has(id)))fail(400,'Choose from the installed apps.');
        }
        return await mutateAuthorized(req,url,async()=>{
          if(body.revision!==config.revision)return json(res,409,{error:'Settings changed; reload and try again',config});
          return json(res,200,{config:await save(Object.assign({},config,body))});
        });
      }
      if(req.method==='POST'&&['/api/wallpapers/rename','/api/wallpapers/delete'].includes(url.pathname)){
        const body=await jsonBody(req),rename=url.pathname.endsWith('/rename');
        if(Object.keys(body).some(k=>!(rename?['id','revision','name']:['id','revision']).includes(k)))fail(400,'Unknown wallpaper setting.');
        if(typeof body.id!=='string'||!/^[a-f0-9]{32}$/.test(body.id))fail(400,'Choose an uploaded wallpaper. The included photo cannot be renamed or deleted.');
        if(rename&&(typeof body.name!=='string'||!body.name.trim()||body.name.trim().length>120||/[\x00-\x1f\x7f]/.test(body.name)))fail(400,'Use a name between 1 and 120 characters, without control characters.');
        return await mutateAuthorized(req,url,async()=>{
          if(configError)fail(500,configError);
          if(!rename&&config.deletedWallpaperIds.includes(body.id)){
            const directory=await fsp.open(stateDir,'r');try{await directory.sync();}finally{await directory.close();}
            await purgeDeleted(body.id);return json(res,200,{config});
          }
          if(body.revision!==config.revision)return json(res,409,{error:'Settings changed; review this wallpaper and try again.',config});
          const entry=config.wallpaperLibrary.find(w=>w.id===body.id);if(!entry)fail(404,'This wallpaper is no longer in the library.');
          if(rename){
            const updated=Object.assign({},entry,{name:body.name.trim()});
            return json(res,200,{config:await save(Object.assign({},config,{wallpaperLibrary:config.wallpaperLibrary.map(w=>w.id===entry.id?updated:w),wallpaper:config.wallpaper&&config.wallpaper.id===entry.id?updated:config.wallpaper}))});
          }
          const file=mediaPath(entry),stat=await fsp.lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
          if(stat&&!stat.isFile())fail(409,'This wallpaper file needs recovery before deletion.');
          await save(Object.assign({},config,{wallpaperLibrary:config.wallpaperLibrary.filter(w=>w.id!==entry.id),wallpaper:config.wallpaper&&config.wallpaper.id===entry.id?null:config.wallpaper,deletedWallpaperIds:config.deletedWallpaperIds.concat(entry.id)}));
          if(options.deleteHook)await options.deleteHook('marked');
          await purgeDeleted(entry.id);return json(res,200,{config});
        });
      }
      if(req.method==='POST'&&['/api/wallpapers/select','/api/wallpapers/focal'].includes(url.pathname)){
        const body=await jsonBody(req),isFocal=url.pathname.endsWith('/focal');
        const allowed=isFocal?['revision','id','focalPoint']:['revision','id'];
        if(Object.keys(body).some(k=>!allowed.includes(k)))fail(400,'Unknown wallpaper setting.');
        if(typeof body.id!=='string'||(body.id!=='default'&&!/^[a-f0-9]{32}$/.test(body.id)))fail(400,'Choose a wallpaper from the library.');
        const point=isFocal?validateFocalPoint(body.focalPoint):null;
        return await mutateAuthorized(req,url,async()=>{
          if(configError)fail(500,configError);
          if(body.revision!==config.revision)return json(res,409,{error:'Settings changed; reload and try again',config});
          const entry=body.id==='default'?null:config.wallpaperLibrary.find(w=>w.id===body.id);
          if(body.id!=='default'&&!entry)fail(404,'This wallpaper is not in your library.');
          if(isFocal){
            if(entry&&entry.kind!=='image')fail(415,'Focal points are available for photos, not videos.');
            if(!entry)return json(res,200,{config:await save(Object.assign({},config,{defaultFocalPoint:point}))});
            const updated=Object.assign({},entry,{focalPoint:point});
            const library=config.wallpaperLibrary.map(w=>w.id===entry.id?updated:w);
            return json(res,200,{config:await save(Object.assign({},config,{wallpaperLibrary:library,wallpaper:config.wallpaper&&config.wallpaper.id===entry.id?updated:config.wallpaper}))});
          }
          if(entry)await checkSavedImage(entry);
          authenticate(req,url);
          return json(res,200,{config:await save(Object.assign({},config,{wallpaper:entry}))});
        });
      }
      if(req.method==='POST'&&url.pathname==='/api/launch'){
        if(role!=='tv')fail(403,'Apps can only be launched from the TV.');const body=await jsonBody(req);
        const app=(await apps()).find(a=>a.id===body.id);if(!app)fail(400,'This app is not installed.');
        await platform.launch(app.id,app.params||{});return json(res,200,{ok:true});
      }
      if(req.method==='POST'&&url.pathname==='/api/pairing'){
        if(role!=='tv')fail(403,'Generate pairing codes on the TV.');
        return await changeAuth(()=>{
          checkRequest(req);
          const ip=localIPs().find(x=>!x.startsWith('127.'));
          if(!ip&&!options.demo)fail(503,'The TV is not connected to your local network.');
          pairing={id:crypto.randomBytes(16).toString('hex'),code:String(crypto.randomInt(100000,1000000)),expiresAt:Date.now()+600000};
          // In preview mode, use the address the browser can actually reach,
          // including the Mac's forwarded localhost port when running in a VM.
          const pairUrl=options.demo?'http://'+req.headers.host:'http://'+ip+':'+expectedPort;
          return json(res,200,Object.assign({url:pairUrl,qrUrl:pairUrl+'/#pair='+pairing.code},pairing));
        });
      }
      if(['GET','HEAD'].includes(req.method)&&url.pathname==='/api/icon'){
        const app=(await apps()).find(a=>a.id===url.searchParams.get('id'));if(!app||!app.icon)fail(404,'No app icon.');
        const real=await fsp.realpath(app.icon).catch(()=>fail(404,'No app icon.'));
        const roots=['/usr/palm/applications/','/media/developer/apps/usr/palm/applications/','/media/cryptofs/apps/usr/palm/applications/','/mnt/'];
        if(!roots.some(root=>real.startsWith(root))||!real.includes('/usr/palm/applications/'))fail(403,'Invalid app icon path.');
        const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}[path.extname(real).toLowerCase()];
        if(!mime||(await fsp.stat(real)).size>5*1024*1024)fail(404,'Unsupported app icon.');
        return await sendFile(req,res,real,mime,true);
      }
      if(['GET','HEAD'].includes(req.method)&&url.pathname==='/media/library'){
        const id=url.searchParams.get('id');
        if(id==='default'){
          await regularMedia(bundledPhoto);
          if(!checkedDefaultPhoto){const data=await readImageHeader(bundledPhoto);safeImage(data.header,data.size,'image/jpeg');checkedDefaultPhoto=true;}
          return await sendFile(req,res,bundledPhoto,'image/jpeg');
        }
        if(!id||!/^[a-f0-9]{32}$/.test(id))fail(400,'Choose a wallpaper from the library.');
        const entry=config.wallpaperLibrary.find(w=>w.id===id);if(!entry)fail(404,'This wallpaper is not in your library.');
        await checkSavedImage(entry);return await sendFile(req,res,mediaPath(entry),entry.mime);
      }
      if(['GET','HEAD'].includes(req.method)&&url.pathname==='/media/wallpaper'){
        if(!config.wallpaper)fail(404,'No custom wallpaper.');
        const wallpaper=config.wallpaper;await checkSavedImage(wallpaper);
        return await sendFile(req,res,mediaPath(wallpaper),wallpaper.mime);
      }
      if(req.method==='POST'&&url.pathname==='/api/upload'){
        if(uploadBusy)fail(409,'Another wallpaper is uploading. Please wait.');
        const name=url.searchParams.get('name')||'';
        if(!name||name.length>200||/[\x00-\x1f/\\]/.test(name))fail(400,'Invalid filename.');
        const length=Number(req.headers['content-length']);if(!Number.isSafeInteger(length)||length<=0)fail(411,'The upload must have a file size.');
        if(length>MAX_UPLOAD)fail(413,'Choose a file smaller than 150 MB.');
        if(!/\.(jpe?g|png|webp|mp4)$/i.test(name))fail(415,'Choose JPG, PNG, WebP or MP4.');
        uploadBusy=true;let temp=null,fd=null;
        try {
          const available=await (options.diskFree||diskFree)(stateDir);if(available<length+32*1024*1024)fail(507,'Not enough free storage on the TV for this wallpaper.');
          const id=crypto.randomBytes(16).toString('hex');temp=path.join(stateDir,'media',id+'.upload');fd=await fsp.open(temp,'wx',0o600);
          let received=0,headerLength=0;const headerBuffer=Buffer.alloc(Math.min(length,imageInfo.HEADER_BYTES));
          for await(const chunk of req){received+=chunk.length;if(received>MAX_UPLOAD||received>length)fail(413,'Upload exceeded its declared size.');if(headerLength<headerBuffer.length)headerLength+=chunk.copy(headerBuffer,headerLength,0,Math.min(chunk.length,headerBuffer.length-headerLength));let off=0;while(off<chunk.length){const w=await fd.write(chunk,off,chunk.length-off,null);off+=w.bytesWritten;}}
          if(received!==length)fail(400,'Upload was interrupted. Try again.');
          const header=headerBuffer.subarray(0,headerLength),type=mediaType(header,name);
          const dimensions=type.kind==='image'?safeImage(header,received,type.mime):{};
          await fd.sync();await fd.close();fd=null;
          const wallpaper=Object.assign({id,name,kind:type.kind,size:received,mime:type.mime,focalPoint:null,createdAt:Date.now()},dimensions);const finalPath=mediaPath(wallpaper);
          await fsp.rename(temp,finalPath);temp=finalPath;
          const result=await mutateAuthorized(req,url,()=>save(Object.assign({},config,{wallpaper,wallpaperLibrary:config.wallpaperLibrary.concat([wallpaper])})));
          if(type.kind==='image')checkedImageIds.add(id);
          temp=null;
          return json(res,200,{config:result});
        } finally {if(fd)await fd.close().catch(()=>{});if(temp)await fsp.unlink(temp).catch(()=>{});uploadBusy=false;}
      }
      fail(404,'Not found.');
    } catch(e) {if(!res.headersSent&&!res.destroyed)json(res,e.status||500,{error:e.status?e.message:'The TV could not complete this request. Please try again.'});else if(!res.destroyed)res.destroy();if(!e.status&&options.log)options.log(e.message);}
  });
  server.requestTimeout=180000;server.headersTimeout=15000;server.timeout=180000;
  server.on('clientError',(_e,socket)=>socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  // Offline tests can exercise the same request handler without opening sockets.
  if(options.listen!==false)await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(options.port===undefined?1877:options.port,options.bind||'0.0.0.0',resolve);});
  const cleanup=setInterval(()=>{for(const [ip,a]of pairAttempts)if(a.until<Date.now())pairAttempts.delete(ip);cleanPhoneTokens();},60000);cleanup.unref();
  return {server,bootstrap:()=>({baseUrl:'http://127.0.0.1:'+(server.address()?server.address().port:(options.port||1877)),token:tvToken}),close:()=>new Promise(resolve=>{clearInterval(cleanup);if(server.listening)server.close(resolve);else resolve();}),getConfig:()=>config,startupEnabled:()=>!configError&&config.launchAtStart===true};
}
module.exports={createBackend,parseRange,mediaType,validateLocation,defaults,MAX_UPLOAD,VERSION};
