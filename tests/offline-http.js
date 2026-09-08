'use strict';
// In-process transport for backend unit tests. No sockets or server.listen calls.
const {PassThrough}=require('node:stream');
function request(server,options,onResponse){
  if(!server)throw new Error('No offline backend registered for the requested test port');
  const incoming=new PassThrough();
  incoming.method=options.method||'GET';incoming.url=options.path||'/';
  incoming.headers={host:'127.0.0.1:'+options.port};
  for(const [key,value]of Object.entries(options.headers||{}))incoming.headers[key.toLowerCase()]=value;
  incoming.socket={remoteAddress:'127.0.0.1'};
  let timer;
  incoming.setTimeout=(milliseconds,callback)=>{clearTimeout(timer);timer=setTimeout(()=>{if(callback)callback();else incoming.emit('timeout');},milliseconds);return incoming;};
  const response=new PassThrough();response.statusCode=200;response.headers={};
  response.setHeader=(key,value)=>{response.headers[key.toLowerCase()]=value;return response;};
  response.getHeader=key=>response.headers[key.toLowerCase()];
  response.hasHeader=key=>Object.prototype.hasOwnProperty.call(response.headers,key.toLowerCase());
  let started=false;Object.defineProperty(response,'headersSent',{get:()=>started});
  const originalWrite=response.write,originalEnd=response.end;
  response.write=function(){started=true;return originalWrite.apply(this,arguments);};
  response.end=function(){started=true;return originalEnd.apply(this,arguments);};
  response.on('finish',()=>clearTimeout(timer));response.on('close',()=>clearTimeout(timer));incoming.on('close',()=>clearTimeout(timer));
  queueMicrotask(()=>{onResponse(response);server.emit('request',incoming,response);});
  return incoming;
}
module.exports={request};
