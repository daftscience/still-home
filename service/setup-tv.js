'use strict';
// Fixed, packaged setup only. No commands, paths or IDs come from UI/network input.
const fs=require('fs'),path=require('path'),cp=require('child_process');
const {SERVICE,HOOK}=require('./setup-status');
const ELEVATE='/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service';
const MARKER='STILL_HOME_SETUP_OK';
function error(message){throw new Error(message);}
function matchingProcesses(io=fs) {
  const targets=[SERVICE,SERVICE.replace('/media/developer/','/media/cryptofs/'),SERVICE+'/service.js',SERVICE.replace('/media/developer/','/media/cryptofs/')+'/service.js'];
  return io.readdirSync('/proc').filter(name=>/^\d+$/.test(name)).filter(pid=>{
    try {
      const args=io.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0');
      // webOS's JS runner replaces argv with the service name after startup.
      const titledService=args[0]==='com.tomperry.stillhome.service'&&args.slice(1).every(arg=>arg==='');
      return titledService||args.some(arg=>targets.indexOf(arg)>=0);
    }
    catch(_error){return false;}
  }).map(Number).filter(pid=>pid!==process.pid);
}
async function restartService() {
  const pids=matchingProcesses();
  for(const pid of pids){try{process.kill(pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}}
  for(let attempt=0;attempt<25;attempt++){
    if(!matchingProcesses().some(pid=>pids.indexOf(pid)>=0))return;
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  error('Still Home is still stopping. Close Still Home, reopen it, and retry setup.');
}
async function setup(options={}) {
  const io=options.fs||fs,uid=options.uid===undefined?(typeof process.getuid==='function'?process.getuid():-1):options.uid;
  const service=options.service||SERVICE,hook=options.hook||HOOK,elevate=options.elevate||ELEVATE;
  if(uid!==0)error('Homebrew root access is unavailable. Open Homebrew Channel and check that Root status is ok.');
  try{io.accessSync(elevate,fs.constants.X_OK);io.accessSync(service+'/autostart.sh',fs.constants.X_OK);}
  catch(_error){error('Homebrew Channel or the Still Home setup files are missing. Reinstall the latest versions and try again.');}
  function hookExists(){try{const stat=io.lstatSync(hook);if(!stat.isSymbolicLink()||io.readlinkSync(hook)!==service+'/autostart.sh')error('A different startup hook already uses Still Home’s name. It was not changed.');return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
  hookExists(); // Refuse foreign hooks before changing any permissions.
  const run=options.run||((file,args)=>new Promise((resolve,reject)=>cp.execFile(file,args,{timeout:20000,maxBuffer:256*1024},(e)=>e?reject(new Error('Homebrew could not finish granting Still Home permissions. Check Root status and retry.')):resolve())));
  await run(elevate,['com.tomperry.stillhome.service']);
  io.mkdirSync(path.dirname(hook),{recursive:true,mode:0o755});
  if(!hookExists()){
    try{io.symlinkSync(service+'/autostart.sh',hook);}
    catch(e){if(e.code!=='EEXIST'||!hookExists())throw e;}
  }
  // Never touch settings, wallpapers, remembered devices or remote mappings.
  await (options.restart||restartService)();
  return MARKER;
}
module.exports={setup,matchingProcesses,MARKER};
if(require.main===module)setup().then(result=>console.log(result)).catch(e=>{console.error(e.message);process.exitCode=1;});
