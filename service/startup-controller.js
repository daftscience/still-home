'use strict';
// Bounded startup takeover, never a permanent foreground-app redirect.
module.exports=function createStartupController(options){
  let power=null,asleep=false,pending=false,timer=null,closed=false,generation=0;
  let checks=0,attempts=0,lastEvent=null,lastLaunch=null,lastError=null;
  const later=options.setTimeout||setTimeout,cancel=options.clearTimeout||clearTimeout;
  function stop(){if(timer!==null)cancel(timer);timer=null;}
  function invalidate(){generation++;stop();checks=0;attempts=0;}
  async function launch(gen){
    if(gen!==generation||closed||power!=='Active'||!options.enabled())return;
    attempts++;
    try{await options.launch();lastLaunch=Date.now();lastError=null;}
    catch(e){lastError=e.message;if(options.log)options.log('Startup launch failed: '+e.message);}
  }
  function verify(gen){
    if(!options.foreground||gen!==generation||closed||checks>=8||!options.enabled())return;
    timer=later(async()=>{
      timer=null;if(gen!==generation||closed||power!=='Active'||!options.enabled())return;
      checks++;
      try{
        const id=await options.foreground();
        if(gen!==generation||closed||!options.enabled())return;
        if(id==='com.webos.app.home'&&attempts<3)await launch(gen);
        else if(id&&id!=='com.tomperry.stillhome'&&id!=='com.webos.app.home')return;
      }catch(e){lastError=e.message;}
      verify(gen);
    },2000);
  }
  function schedule(){
    if(closed||!pending||power!=='Active'||timer!==null)return;
    const gen=generation;
    timer=later(async()=>{timer=null;pending=false;if(gen!==generation||closed||power!=='Active'||!options.enabled())return;
      await launch(gen);verify(gen);
    },3000);
  }
  return {
    coldStart(){if(options.enabled()){invalidate();pending=true;lastEvent='boot';schedule();}},
    update(event){
      if(closed)return;
      const state=typeof event==='string'?event:event.state;
      const processing=typeof event==='string'?'':event.processing;
      if(['Request Power Off','Request Suspend','Prepare Suspend'].includes(processing)){
        asleep=true;pending=false;invalidate();power=state;lastEvent=processing;return;
      }
      if(['Suspend','Active Standby','Power Off'].includes(state)){asleep=true;pending=false;invalidate();lastEvent=state;}
      if(state==='Active'&&asleep){asleep=false;invalidate();pending=options.enabled();lastEvent='wake';}
      power=state;
      if(state!=='Active')stop();else schedule();
    },
    // Keep a known shutdown/boot intent when the power service itself restarts.
    disconnected(){power=null;invalidate();},
    close(){closed=true;invalidate();},
    status(){return {powerState:power,monitoring:power!==null,lastEvent,lastLaunch,lastError,attempts};}
  };
};
