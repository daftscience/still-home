'use strict';
// Only this app's generated media and explicitly named preference leftovers
// are eligible. A journal is replayed before normal orphan-media recovery.
const fs=require('fs').promises;
const path=require('path');
const crypto=require('crypto');
const MEDIA=/^[a-f0-9]{32}\.(jpg|png|webp|mp4|upload)$/;
const LEFTOVER=/^(config\.pre-v0\.2\.json|config\.json\.[a-f0-9]{64}\.tmp|devices\.json\.[a-f0-9]{32}\.tmp)$/;
function problem(message){const e=Error(message);e.status=409;throw e;}
async function syncDir(dir){const fd=await fs.open(dir,'r');try{await fd.sync();}finally{await fd.close();}}
async function regular(file,missing=false){
  const stat=await fs.lstat(file).catch(e=>{if(missing&&e.code==='ENOENT')return null;throw e;});
  if(stat&&!stat.isFile())problem('Reset stopped: an unexpected file type needs recovery.');return stat;
}
async function directory(dir){const stat=await fs.lstat(dir);if(!stat.isDirectory())problem('Reset stopped: an unexpected directory needs recovery.');}
async function atomic(dir,name,value){
  await regular(path.join(dir,name),true);
  const temp=name+'.'+crypto.randomBytes(16).toString('hex')+'.reset-tmp';
  const fd=await fs.open(path.join(dir,temp),'wx',0o600);
  try{await fd.writeFile(JSON.stringify(value,null,2)+'\n');await fd.sync();}finally{await fd.close();}
  await fs.rename(path.join(dir,temp),path.join(dir,name));await syncDir(dir);
}
async function inventory(dir){
  await directory(dir);await directory(path.join(dir,'media'));
  await regular(path.join(dir,'config.json'),true);await regular(path.join(dir,'devices.json'),true);
  const files=[],fingerprint=[];let count=0,bytes=0;
  for(const name of (await fs.readdir(path.join(dir,'media'))).sort()){
    if(!MEDIA.test(name))problem('Reset stopped: an unrecognized media file needs recovery.');
    const stat=await regular(path.join(dir,'media',name));files.push('media/'+name);
    fingerprint.push([name,stat.size,stat.mtimeMs]);if(!name.endsWith('.upload')){count++;bytes+=stat.size;}
  }
  for(const name of (await fs.readdir(dir)).sort())if(LEFTOVER.test(name)){
    await regular(path.join(dir,name));files.push(name);
  }
  return {files,count,bytes,digest:crypto.createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex')};
}
async function resume(dir,hook=async()=>{}){
  await directory(dir);await directory(path.join(dir,'media'));
  const journalFile=path.join(dir,'reset-journal.json');
  if(!await regular(journalFile,true))return null;
  const j=JSON.parse(await fs.readFile(journalFile,'utf8'));
  if(!j||j.version!==1||!/^[a-f0-9]{32}$/.test(j.id)||!Array.isArray(j.files)||!j.config||!Number.isSafeInteger(j.config.revision)||j.config.revision<1||j.config.wallpaper!==null||!Array.isArray(j.config.wallpaperLibrary)||j.config.wallpaperLibrary.length)problem('Reset journal needs recovery.');
  for(const name of j.files)if(typeof name!=='string'||!(name.startsWith('media/')&&MEDIA.test(name.slice(6)))&&!LEFTOVER.test(name))problem('Reset journal contains an unsafe path.');
  const retired=path.join(dir,'reset-retired-'+j.id);
  await fs.mkdir(retired,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});await directory(retired);
  for(const name of j.files){
    const from=path.join(dir,name),to=path.join(retired,name.replace('/','--'));
    if(await regular(from,true)){
      if(await regular(to,true))problem('Reset found conflicting retired files.');
      await fs.rename(from,to);await syncDir(path.dirname(from));await syncDir(retired);
    }
  }
  await hook('retired');
  await atomic(dir,'config.json',j.config);
  await hook('config');
  await atomic(dir,'devices.json',{version:1,devices:[]});
  await hook('devices');
  const expected=new Set(j.files.map(name=>name.replace('/','--')));
  for(const name of await fs.readdir(retired)){
    if(!expected.has(name))problem('Reset retirement folder contains an unexpected file.');
    await regular(path.join(retired,name));await fs.unlink(path.join(retired,name));
  }
  await syncDir(retired);await fs.rmdir(retired);await syncDir(dir);
  await hook('deleted');
  const result={id:j.id,status:'complete',revision:j.config.revision};
  await atomic(dir,'reset-result.json',result);
  for(const name of await fs.readdir(dir))if(/^(config\.json|devices\.json|reset-journal\.json|reset-result\.json)\.[a-f0-9]{32}\.reset-tmp$/.test(name)){
    await regular(path.join(dir,name));await fs.unlink(path.join(dir,name));
  }
  await fs.unlink(journalFile);await syncDir(dir);
  return result;
}
async function begin(dir,id,config,snapshot,hook=async()=>{}){
  if(await regular(path.join(dir,'reset-journal.json'),true))problem('A reset is already in progress.');
  await atomic(dir,'reset-journal.json',{version:1,id,config,files:snapshot.files});
  await hook('journal');return resume(dir,hook);
}
async function result(dir){const file=path.join(dir,'reset-result.json');if(!await regular(file,true))return null;return JSON.parse(await fs.readFile(file,'utf8'));}
module.exports={inventory,resume,begin,result};
