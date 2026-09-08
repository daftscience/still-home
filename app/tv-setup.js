(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.StillHomeTVSetup=factory();}(typeof window!=='undefined'?window:this,function(){
  'use strict';
  var COMMAND='/bin/sh /media/developer/apps/usr/palm/services/com.tomperry.stillhome.service/setup-tv.sh';
  function required(error){return !!error&&(error.setupRequired===true||error.code==='STILL_HOME_SETUP_REQUIRED'||/EACCES.*mkdir ['"]\/var\/lib/.test(error.message||''));}
  function create(options){
    options=options||{};
    var Bridge=options.Bridge,active=[],pendingSetup=null;
    var schedule=options.setTimeout||setTimeout,cancelTimer=options.clearTimeout||clearTimeout;
    function call(uri,params,timeout){
      return new Promise(function(resolve,reject){
        if(typeof Bridge!=='function'){reject(new Error('Open Still Home on your TV to connect.'));return;}
        var bridge,finished=false,timer;
        function finish(error,data){
          if(finished)return;finished=true;cancelTimer(timer);
          active=active.filter(function(item){return item!==bridge;});
          if(bridge&&typeof bridge.cancel==='function'){try{bridge.cancel();}catch(_error){}}
          if(error)reject(error);else resolve(data);
        }
        timer=schedule(function(){finish(new Error('The TV service did not respond. Check Homebrew Channel, then try again.'));},timeout||12000);
        try{
          bridge=new Bridge();active.push(bridge);
          bridge.onservicecallback=function(raw){
            try{
              var data=JSON.parse(raw);
              if(!data||data.returnValue!==true){var e=new Error(data&&data.errorText||'The TV service is unavailable.');e.code=data&&data.errorCode;e.setupRequired=data&&data.setupRequired;throw e;}
              finish(null,data);
            }catch(error){finish(error);}
          };
          bridge.call(uri,JSON.stringify(params));
        }catch(error){finish(error);}
      });
    }
    function run(){
      if(pendingSetup)return pendingSetup;
      pendingSetup=call('luna://org.webosbrew.hbchannel.service/exec',{command:COMMAND},45000).then(function(data){
        if(data.error||String(data.stdoutString||'').split(/\r?\n/).indexOf('STILL_HOME_SETUP_OK')<0)throw new Error(String(data.stderrString||'Homebrew could not finish setup. Check that Homebrew Channel shows Root status: ok, then retry.').trim());
        return true;
      });
      pendingSetup=pendingSetup.then(function(result){pendingSetup=null;return result;},function(error){pendingSetup=null;throw error;});
      return pendingSetup;
    }
    return {call:call,run:run};
  }
  return {create:create,required:required};
}));
