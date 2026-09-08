'use strict';
const fs=require('fs');
const SERVICE='/media/developer/apps/usr/palm/services/com.tomperry.stillhome.service';
const HOOK='/var/lib/webosbrew/init.d/60-still-home';
const CODE='STILL_HOME_SETUP_REQUIRED';

function check(options={}) {
  const uid=options.uid===undefined?(typeof process.getuid==='function'?process.getuid():-1):options.uid;
  // The jailed service must not attempt to create or inspect root-owned storage.
  if(uid!==0)return {required:true,reason:'permissions'};
  const io=options.fs||fs,hook=options.hook||HOOK,target=options.target||SERVICE+'/autostart.sh';
  try {
    if(!io.lstatSync(hook).isSymbolicLink()||io.readlinkSync(hook)!==target)return {required:true,reason:'startup-hook-conflict'};
    io.accessSync(target,fs.constants.X_OK);
  } catch(error) {
    return {required:true,reason:error.code==='ENOENT'?'startup-hook':'startup-hook-unavailable'};
  }
  return {required:false};
}
function assertReady(options) {
  const status=check(options);
  if(status.required){const error=new Error('Finish Still Home setup on your TV to enable its background service.');error.code=CODE;error.setupReason=status.reason;throw error;}
}
function response(error) {
  return {returnValue:false,errorText:error.message,errorCode:error.code||'STILL_HOME_SERVICE_ERROR',setupRequired:error.code===CODE,setupReason:error.setupReason};
}
module.exports={check,assertReady,response,CODE,SERVICE,HOOK};
