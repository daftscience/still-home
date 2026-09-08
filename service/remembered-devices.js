'use strict';
const fs=require('fs').promises;
const path=require('path');
const crypto=require('crypto');
const DAY=24*60*60*1000;
const YEAR=365*DAY;
const MAX_DEVICES=20;
const hex=(value,length)=>typeof value==='string'&&new RegExp('^[a-f0-9]{'+length+'}$').test(value);
const hash=credential=>crypto.createHash('sha256').update(credential).digest('hex');
const publicDevice=device=>({id:device.id,name:device.name,createdAt:device.createdAt,expiresAt:device.expiresAt,lastUsed:device.lastUsed});
function error(status,message){const e=new Error(message);e.status=status;throw e;}
function deviceName(name){
  if(name===undefined)return 'Phone';
  if(typeof name!=='string'||!name.trim()||name.trim().length>64||/[\x00-\x1f\x7f]/.test(name))error(400,'Use a phone name between 1 and 64 characters.');
  return name.trim();
}
async function createDeviceStore(stateDir,now=()=>Date.now()){
  const file=path.join(stateDir,'devices.json');
  let devices=[],storeError=null;
  const persistedUse=new Map();
  try{
    const stat=await fs.lstat(file);
    if(!stat.isFile()||stat.size>64*1024)throw Error('Invalid device store');
    const saved=JSON.parse(await fs.readFile(file,'utf8'));
    if(!saved||saved.version!==1||Object.keys(saved).sort().join(',')!=='devices,version'||!Array.isArray(saved.devices)||saved.devices.length>MAX_DEVICES)throw Error('Invalid device store');
    const keys=['id','credentialHash','name','createdAt','expiresAt','lastUsed'].sort().join(',');
    for(const d of saved.devices){
      if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).sort().join(',')!==keys||!hex(d.id,32)||!hex(d.credentialHash,64)||deviceName(d.name)!==d.name||['createdAt','expiresAt','lastUsed'].some(key=>!Number.isSafeInteger(d[key])||d[key]<0)||d.lastUsed<d.createdAt||d.expiresAt<=d.lastUsed)throw Error('Invalid remembered phone');
    }
    if(new Set(saved.devices.map(d=>d.id)).size!==saved.devices.length||new Set(saved.devices.map(d=>d.credentialHash)).size!==saved.devices.length)throw Error('Duplicate remembered phone');
    devices=saved.devices;
    devices.forEach(d=>persistedUse.set(d.id,d.lastUsed));
  }catch(e){if(e.code!=='ENOENT')storeError='Remembered phones could not be read. Recovery is required before remembering phones again.';}
  function available(){if(storeError)error(503,storeError);}
  function active(id){return !storeError&&devices.some(d=>d.id===id&&d.expiresAt>now());}
  function find(credential){
    available();
    if(!hex(credential,64))return null;
    const digest=Buffer.from(hash(credential),'hex');
    return devices.find(d=>d.expiresAt>now()&&crypto.timingSafeEqual(Buffer.from(d.credentialHash,'hex'),digest))||null;
  }
  // Callers serialize auth changes. The previous state remains authoritative
  // until the complete replacement has reached disk and been renamed.
  async function save(next){
    available();
    const temp=file+'.'+crypto.randomBytes(16).toString('hex')+'.tmp';
    let handle,directory,renamed=false;
    try{
      directory=await fs.open(stateDir,'r');
      handle=await fs.open(temp,'wx',0o600);
      await handle.writeFile(JSON.stringify({version:1,devices:next},null,2)+'\n');
      await handle.sync();await handle.close();handle=null;
      await fs.rename(temp,file);renamed=true;
      // Persist the directory entry as well as the file contents before a
      // revocation is acknowledged, including across sudden TV power loss.
      await directory.sync();await directory.close();directory=null;
    }catch(e){
      if(handle)await handle.close().catch(()=>{});if(directory)await directory.close().catch(()=>{});
      await fs.unlink(temp).catch(()=>{});
      if(renamed)storeError='Remembered phone storage could not be saved safely. Restart the TV app before remembering phones again.';
      throw e;
    }
    devices=next;persistedUse.clear();devices.forEach(d=>persistedUse.set(d.id,d.lastUsed));
  }
  return {
    get error(){return storeError;},active,find,
    list(){available();return devices.filter(d=>d.expiresAt>now()).map(publicDevice);},
    async replace(ids,name){
      available();name=deviceName(name);
      const time=now(),next=devices.filter(d=>d.expiresAt>time&&!ids.includes(d.id));
      if(next.length>=MAX_DEVICES)error(429,'The TV remembers 20 phones. Forget one in TV Settings before adding another.');
      const credential=crypto.randomBytes(32).toString('hex');
      const device={id:crypto.randomBytes(16).toString('hex'),credentialHash:hash(credential),name,createdAt:time,expiresAt:time+YEAR,lastUsed:time};
      await save(next.concat([device]));return {credential,device:publicDevice(device)};
    },
    async touch(credential){
      const previous=find(credential);if(!previous)return null;
      const time=Math.max(now(),previous.lastUsed),device=Object.assign({},previous,{lastUsed:time,expiresAt:Math.max(previous.expiresAt,time+YEAR)});
      const next=devices.map(d=>d.id===device.id?device:d);
      // Frequent opens renew in memory; activity alone writes at most daily.
      if(time-(persistedUse.get(device.id)||0)>=DAY)await save(next);else devices=next;
      return publicDevice(device);
    },
    async revoke(ids){
      available();const next=devices.filter(d=>!ids.includes(d.id));
      if(next.length!==devices.length)await save(next);
    }
  };
}
module.exports={createDeviceStore,deviceName,DAY,YEAR,MAX_DEVICES};
