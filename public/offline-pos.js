(function(){
"use strict";
const DB="water-pos-offline-v1",VERSION=1,STORE="pending-sales";
const CACHED_USER="water_pos_cached_user";
let syncing=false;
let lastError="";
const $=s=>document.querySelector(s);
function person(){
  try{return JSON.parse(localStorage.getItem(CACHED_USER)||"null");}catch{return null;}
}
function userId(){return Number(person()?.id||0);}
function randomKey(){
  if(window.crypto?.randomUUID)return "sale_"+crypto.randomUUID().replaceAll("-","");
  const bytes=new Uint8Array(20);crypto.getRandomValues(bytes);
  return "sale_"+Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
}
function openDb(){
 return new Promise((resolve,reject)=>{
  const request=indexedDB.open(DB,VERSION);
  request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE,{keyPath:"key"});};
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error||new Error("Offline storage unavailable."));
 });
}
async function transact(mode,executor){
 const db=await openDb();
 return new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,mode);
  const request=executor(tx.objectStore(STORE));
  tx.oncomplete=()=>{db.close();resolve(request?.result)};
  tx.onerror=()=>{db.close();reject(tx.error||new Error("Device storage error."))};
  tx.onabort=()=>{db.close();reject(tx.error||new Error("Device storage aborted."))};
 });
}
const all=()=>transact("readonly",s=>s.getAll());
const del=key=>transact("readwrite",s=>s.delete(key));
const put=entry=>transact("readwrite",s=>s.put(entry));
function escape(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function money(n){return "₱"+Number(n||0).toLocaleString("en-PH",{minimumFractionDigits:2,maximumFractionDigits:2});}
function identityLabel(entry){return entry.key.slice(-8).toUpperCase();}
function listen(){window.dispatchEvent(new CustomEvent("waterpos:offline-change"));}
async function queueSale(formData){
 const owner=userId();
 if(!owner)throw new Error("Employee identity must be verified online once before using offline sales.");
 const existing=(await all()).filter(x=>x.owner===owner);
 if(existing.length>=300)throw new Error("300 sales are pending on this device. Reconnect and sync before recording more.");
 const file=formData.get("receipt");
 if(file&&file.size>8*1024*1024)throw new Error("Receipt photo exceeds 8 MB. Please capture a smaller photo.");
 const key=randomKey();
 const fields={offlineCapturedAt:new Date().toISOString()};
 for(const [name,value] of formData.entries()){
  if(name!=="receipt"&&name!=="clientSaleKey")fields[name]=String(value);
 }
 const items=JSON.parse(fields.items||"[]");
 const total=items.reduce((sum,x)=>sum+Number(x.qty||0)*Number(x.unitPrice||0),0);
 const entry={key,owner,ownerName:person()?.name||"",createdAt:new Date().toISOString(),fields,
  receipt:file instanceof Blob&&file.size?file:null,total,method:fields.paymentMethod||"Cash",
  state:"pending",error:""};
 // Do not acknowledge checkout before IndexedDB commits this transaction.
 await put(entry);
 listen();void updateBanner();
 return entry;
}
function encode(entry){
 const fd=new FormData();
 for(const [key,value] of Object.entries(entry.fields))fd.append(key,value);
 fd.append("clientSaleKey",entry.key);
 if(entry.receipt)fd.append("receipt",entry.receipt,"offline-receipt.jpg");
 return fd;
}
async function sync(){
 if(syncing)return {online:false,synced:0,pending:(await all()).length,busy:true};
 const owner=userId();
 if(!owner)return {online:false,synced:0,pending:0,error:"No employee account."};
 syncing=true;let synced=0,online=true;const confirmed={};lastError="";
 try{
  const list=(await all()).filter(x=>x.owner===owner).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  for(const entry of list){
   if(entry.state==="review")continue;
   let response;
   try{
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),14000);
    try{response=await fetch("/api/sales",{method:"POST",body:encode(entry),signal:controller.signal});}
    finally{clearTimeout(timeout);}
   }catch(error){online=false;lastError="No connection to Water POS server. Sales are safe on this device.";break;}
   if(response.ok){
    try{confirmed[entry.key]=await response.json()}catch{confirmed[entry.key]={transactionRef:"Confirmed on server"}}
    await del(entry.key);synced++;listen();continue;
   }
   let details={};try{details=await response.json()}catch{}
   if(response.status===401){
    online=false;lastError="Please sign in online as the same employee to sync pending sales.";break;
   }
   if(response.status>=500||response.status===429){
    online=false;lastError="Server is unavailable. Will retry automatically.";break;
   }
   entry.state="review";
   entry.error=details.error||"Could not accept this transaction; review before retrying.";
   await put(entry);
   lastError="Some sales require review before syncing.";
  }
 }finally{syncing=false;void updateBanner();}
 return {online,synced,confirmed,pending:(await all()).filter(x=>x.owner===owner).length,error:lastError};
}
async function retry(key){
 const entry=(await all()).find(e=>e.key===key&&e.owner===userId());if(!entry)return;
 entry.state="pending";entry.error="";await put(entry);void sync();
}
async function discard(key){
 const entry=(await all()).find(e=>e.key===key&&e.owner===userId());
 if(!entry)return;
 if(!window.confirm("Permanently delete this UNSYNCED transaction from this device? This cannot be undone. Confirm it has not been collected or recorded elsewhere first."))return;
 await del(key);listen();await updateBanner();
}
function ui(){
 if($("#offlinePosStatus"))return;
 const el=document.createElement("section");el.id="offlinePosStatus";el.className="offline-pos-status";
 el.innerHTML=`<div class="offline-pos-summary"><span id="offlinePosDot" class="offline-pos-dot"></span><div><strong id="offlinePosHeadline">Checking connection…</strong><small id="offlinePosDescription">Unsynced transactions remain on this device.</small></div></div><div class="offline-pos-actions"><button id="offlinePosPending" type="button">Pending <span id="offlinePosCount">0</span></button><button type="button" id="offlinePosSync">Sync now</button></div><div id="offlinePosDetails" class="offline-pos-details" hidden></div>`;
 const shell=$(".pos-shell");if(shell)shell.insertBefore(el,shell.firstChild);else document.body.prepend(el);
 $("#offlinePosSync").onclick=async()=>{const btn=$("#offlinePosSync");btn.disabled=true;btn.textContent="Syncing…";try{await sync();}finally{btn.disabled=false;btn.textContent="Sync now";}};
 $("#offlinePosPending").onclick=()=>{$("#offlinePosDetails").hidden=!$("#offlinePosDetails").hidden;void updateBanner();};
 $("#offlinePosDetails").addEventListener("click",e=>{
  const btn=e.target.closest("button[data-pending]");if(!btn)return;
  if(btn.dataset.action==="retry")void retry(btn.dataset.pending);
  if(btn.dataset.action==="discard")void discard(btn.dataset.pending);
 });
}
async function updateBanner(){
 if(!$("#offlinePosStatus"))return;
 const owner=userId();
 const list=(await all()).filter(x=>x.owner===owner).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
 const count=list.length;
 const isOnline=navigator.onLine;
 $("#offlinePosCount").textContent=count;
 $("#offlinePosHeadline").textContent=!isOnline?"Offline · local sales enabled":lastError?"Sync needs attention":count?"Online · "+count+" pending sync":"Online · ready";
 $("#offlinePosDescription").textContent=lastError||(!isOnline?"Sales will upload when your internet returns.":"Confirmed sales sync to the central database.");
 $("#offlinePosDot").className="offline-pos-dot "+(!isOnline?"offline":lastError?"warning":"online");
 const details=$("#offlinePosDetails");
 details.innerHTML=list.length?list.map(x=>`<div class="offline-pending-row">
 <div><strong>LOCAL-${escape(identityLabel(x))}</strong> · ${money(x.total)} · ${escape(x.method)}
 <small>${escape(new Date(x.createdAt).toLocaleString("en-PH"))} · ${x.state==="review"?"Needs review":"Awaiting server"} ${x.error?("· "+escape(x.error)):""}</small></div>
 <div class="offline-pending-controls">${x.state==="review"?'<button data-action="retry" data-pending="'+escape(x.key)+'">Retry</button>':""}
 <button data-action="discard" data-pending="${escape(x.key)}">Discard</button></div></div>`).join(""):"<p>No unsynced sales on this device.</p>";
}
async function enable(){
 if("serviceWorker"in navigator){
  try{await navigator.serviceWorker.register("/sw.js",{scope:"/"});}catch(e){console.warn("Offline POS cache unavailable",e);}
 }
 if(navigator.storage?.persist)navigator.storage.persist().catch(()=>{});
 ui();await updateBanner();
 window.addEventListener("online",()=>{lastError="";void updateBanner();void sync();});
 window.addEventListener("offline",()=>{lastError="";void updateBanner();});
 window.addEventListener("waterpos:offline-change",()=>void updateBanner());
 document.addEventListener("visibilitychange",()=>{if(!document.hidden)void sync();});
 setInterval(()=>{if(navigator.onLine)void sync();else void updateBanner();},20000);
 if(navigator.onLine)setTimeout(()=>void sync(),800);
}
window.waterOffline={queueSale,sync,updateBanner,all,person,enable};
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",enable);else void enable();
})();
