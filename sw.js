'use strict';
const CACHE='dictation-v20',SHELL=['./','index.html','styles.css','core.js','sync.js','app.js','words.js','words.json','manifest.webmanifest','icon.svg','icon-192.png','icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
async function rangeResponse(hit,range){
 if(!range)return hit;const buf=await hit.arrayBuffer(),n=buf.byteLength,m=/^bytes=(\d*)-(\d*)$/.exec(range);
 if(!m||(!m[1]&&!m[2]))return new Response(null,{status:416,headers:{'Content-Range':`bytes */${n}`}});
 const start=m[1]?Number(m[1]):Math.max(0,n-Number(m[2])),end=m[1]?(m[2]?Math.min(n-1,Number(m[2])):n-1):n-1;
 if(start>=n||end<start)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${n}`}});
 return new Response(buf.slice(start,end+1),{status:206,headers:{'Content-Type':hit.headers.get('Content-Type')||'audio/mpeg','Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${n}`,'Content-Length':String(end-start+1)}});
}
self.addEventListener('fetch',e=>{if(e.request.method!=='GET'||new URL(e.request.url).origin!==self.location.origin)return;e.respondWith(caches.open(CACHE).then(async c=>{const hit=await c.match(e.request);if(hit)return rangeResponse(hit,e.request.headers.get('Range'));try{const r=await fetch(e.request);if(r.status===200)await c.put(e.request,r.clone());return r;}catch{return new Response('',{status:503,statusText:'Offline; use speech synthesis'});}}));});
let caching=false;
self.addEventListener('message',e=>{if(e.data?.type!=='cache-audio'||caching)return;e.waitUntil((async()=>{caching=true;try{const c=await caches.open(CACHE),files=[...new Set(e.data.files)].filter(f=>/^[a-f0-9]{16}(-uk|-us|-tts)?\.mp3$/.test(f));let index=0,count=0;await Promise.all(Array.from({length:6},async()=>{while(index<files.length){const path='audio/'+files[index++];try{if(await c.match(path)){count++;continue;}const response=await fetch(path);if(response.ok){await c.put(path,response);count++;}}catch{}}}));for(const client of await self.clients.matchAll())client.postMessage({type:'audio-cache',count});}finally{caching=false;}})());});
