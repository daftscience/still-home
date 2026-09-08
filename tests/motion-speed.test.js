'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createBackend}=require('../service/backend');
test('motion speed defaults, validates, persists and migrates without losing settings',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'still-speed-'));const opts={stateDir:dir,port:0,bind:'127.0.0.1',demo:true};let b;
  try{
    b=await createBackend(opts);assert.equal(b.getConfig().kenBurnsSpeed,1);
    async function patch(speed){const a=b.bootstrap();return fetch(a.baseUrl+'/api/config',{method:'PATCH',headers:{Authorization:'Bearer '+a.token},body:JSON.stringify({revision:b.getConfig().revision,kenBurnsSpeed:speed})});}
    for(const speed of [0.25,1,3]){assert.equal((await patch(speed)).status,200);assert.equal(b.getConfig().kenBurnsSpeed,speed);}
    const revision=b.getConfig().revision;
    for(const speed of [0,0.24,3.01,100,null,'1',true])assert.equal((await patch(speed)).status,400);
    assert.equal(b.getConfig().revision,revision);await b.close();b=await createBackend(opts);assert.equal(b.getConfig().kenBurnsSpeed,3);
    await b.close();b=null;const file=path.join(dir,'config.json'),old=JSON.parse(await fs.readFile(file,'utf8'));delete old.kenBurnsSpeed;await fs.writeFile(file,JSON.stringify(old));
    b=await createBackend(opts);assert.equal(b.getConfig().kenBurnsSpeed,1);assert.equal(b.getConfig().revision,revision);
  }finally{if(b)await b.close();await fs.rm(dir,{recursive:true,force:true});}
});
