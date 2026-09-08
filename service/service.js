'use strict';
const {createBackend,VERSION}=require('./backend');
const DEMO=process.env.STILL_HOME_DEMO==='1';
if(!DEMO&&process.argv.indexOf('--disable-timeouts')===-1)process.argv.push('--disable-timeouts');
const service=DEMO?null:new (require('webos-service'))('com.tomperry.stillhome.service');
function luna(uri,params){return new Promise((resolve,reject)=>{
  let done=false,request;const timer=setTimeout(()=>{if(!done){done=true;if(request&&request.cancel)request.cancel();reject(Error('TV service timed out'));}},8000);
  request=service.call(uri,params,m=>{if(done)return;done=true;clearTimeout(timer);const r=m.payload;if(r.returnValue===false)reject(Error(r.errorText||'TV request failed'));else resolve(r);});
});}
const platform=DEMO?{
  apps:async()=>[{id:'youtube.leanback.v4',title:'YouTube'},{id:'netflix',title:'Netflix'},{id:'com.apple.appletv',title:'Apple TV'},{id:'amazon',title:'Prime Video'},{id:'org.webosbrew.hbchannel',title:'Homebrew'},{id:'com.webos.app.hdmi1',title:'HDMI 1'}],
  launch:async(id)=>console.log('Preview launch:',id)
}:{
  apps:async()=>{const r=await luna('luna://com.webos.applicationManager/listLaunchPoints',{});return(r.launchPoints||[]).map(a=>({id:a.id,title:a.title,icon:a.largeIcon||a.icon,hidden:a.hidden,params:a.params}));},
  launch:(id,params)=>luna('luna://com.webos.applicationManager/launch',{id,params})
};
const ready=createBackend({demo:DEMO,platform,stateDir:process.env.STILL_HOME_STATE,port:process.env.STILL_HOME_PORT?Number(process.env.STILL_HOME_PORT):1877,log:console.error});
let startup=null, powerSubscription=null, retryPower=null;
if(service){
  service.register('startup',m=>ready.then(async b=>{
    // Claim once per boot; repeated hook calls cannot steal focus later.
    const fs=require('fs').promises;
    try{const claim=await fs.open('/tmp/still-home-startup-claimed','wx',0o600);await claim.close();if(startup)startup.coldStart();}
    catch(e){if(e.code!=='EEXIST')throw e;}
    m.respond({returnValue:true});
  }).catch(e=>m.respond({returnValue:false,errorText:e.message})));
  service.register('bootstrap',m=>{
    const sender=String(m.sender||'');
    if(sender!=='com.tomperry.stillhome'&&!sender.startsWith('com.tomperry.stillhome-')){
      m.respond({returnValue:false,errorText:'Open Still Home on the TV to connect.'});return;
    }
    ready.then(b=>m.respond(Object.assign({returnValue:true},b.bootstrap()))).catch(e=>m.respond({returnValue:false,errorText:e.message}));
  });
  service.register('status',m=>ready.then(b=>m.respond({returnValue:true,running:true,version:VERSION,revision:b.getConfig().revision,startup:startup?startup.status():null})).catch(e=>m.respond({returnValue:false,errorText:e.message})));
}
ready.then(b=>{
  if(service){
    startup=require('./startup-controller')({enabled:()=>b.startupEnabled(),launch:()=>platform.launch('com.tomperry.stillhome',{}),foreground:async()=>{const r=await luna('luna://com.webos.applicationManager/getForegroundAppInfo',{});return r.appId;},log:console.error});
    function connectPower(){
      function retry(){if(retryPower)return;retryPower=setTimeout(()=>{retryPower=null;connectPower();},30000);startup.disconnected();if(powerSubscription){const old=powerSubscription;powerSubscription=null;old.cancel();}}
      try{powerSubscription=service.subscribe('luna://com.webos.service.tvpower/power/getPowerState',{subscribe:true});
        powerSubscription.on('response',m=>{if(m.payload.returnValue===false){retry();return;}if(typeof m.payload.state==='string')startup.update(m.payload);});
        powerSubscription.on('cancel',retry);
      }catch(e){retry();}
    }
    connectPower();
  }
  console.log('Still Home ready on port',b.server.address().port);}).catch(e=>{console.error(e);process.exitCode=1;});
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{if(startup)startup.close();clearTimeout(retryPower);return ready.then(b=>b.close()).finally(()=>process.exit(0));});
