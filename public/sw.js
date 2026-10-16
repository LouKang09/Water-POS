/* Offline Water POS application shell. API data is never cached. */
const CACHE="water-pos-offline-v135";
const SHELL=[
"/","/index.html","/pos-start.html","/pos-login.html",
"/styles.css?v=20261016-room-keyboard1","/pos-theme.css?v=20261012-1",
"/attendance.css?v=20261015-1","/app.js?v=20261016-reference3char1",
"/pos-auth.js?v=20261015-offline130","/offline-pos.js?v=20261016-reference3char1",
"/attendance.js?v=20261015-1","/pos-theme.js?v=20261012-1",
"/pos-login.js?v=20261015-offline130","/pos-login.css?v=20261011-2",
"/pos-account.css?v=20261011-3","/offline-pos.css?v=20261016-reviewfix2","/brand/inyou-official-hd.png"
];
self.addEventListener("install",event=>{
 event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  await Promise.all(SHELL.map(async url=>{
   try{const response=await fetch(url,{cache:"reload"});if(response.ok)await cache.put(url,response);}catch{}
  }));
  await self.skipWaiting();
 })());
});
self.addEventListener("activate",event=>{
 event.waitUntil((async()=>{
  const keys=await caches.keys();
  await Promise.all(keys.filter(k=>k.startsWith("water-pos-offline-")&&k!==CACHE).map(k=>caches.delete(k)));
  await self.clients.claim();
 })());
});
self.addEventListener("fetch",event=>{
 const req=event.request;
 if(req.method!=="GET")return;
 const url=new URL(req.url);
 if(url.origin!==self.location.origin||url.pathname.startsWith("/api/"))return;
 if(req.mode==="navigate"){
  event.respondWith((async()=>{
   try{
    const live=await fetch(req);
    if(live.ok)(await caches.open(CACHE)).put(req,live.clone()).catch(()=>{});
    return live;
   }catch{
    const cache=await caches.open(CACHE);
    return await cache.match(req)||await cache.match(url.pathname)||await cache.match("/index.html")||Response.error();
   }
  })());
  return;
 }
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE);
  const cached=await cache.match(req);
  if(cached)return cached;
  try{const live=await fetch(req);if(live.ok)cache.put(req,live.clone()).catch(()=>{});return live;}
  catch{return Response.error();}
 })());
});