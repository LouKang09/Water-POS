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
  // Some Android WebViews do not preserve cross-interface instanceof checks.
  // Validate the image by its file metadata and persist a Blob copy instead.
  receipt:file&&typeof file.size==="number"&&file.size>0&&String(file.type||"").startsWith("image/")
    ?file.slice(0,file.size,file.type):null,
  total,method:fields.paymentMethod||"Cash",
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
 if(entry.receipt){
  const type=String(entry.receipt.type||"image/jpeg").startsWith("image/")?String(entry.receipt.type||"image/jpeg"):"image/jpeg";
  const extension=type==="image/png"?"png":type==="image/webp"?"webp":"jpg";
  fd.append("receipt",entry.receipt.slice(0,entry.receipt.size,type),"offline-receipt."+extension);
 }
 return fd;
}
async function sync(){
 if(syncing)return {online:false,synced:0,pending:(await all()).length,busy:true};
 const owner=userId();
 if(!owner)return {online:false,synced:0,pending:0,error:"No employee account."};
 syncing=true;let synced=0,online=true;const confirmed={};lastError="";
 try{
  // Never send a queued sale to a server version without deduplication.
  const capabilityController=new AbortController();
  const capabilityTimeout=setTimeout(()=>capabilityController.abort(),9000);
  let capability;
  try{
    const res=await fetch("/api/pos/offline-capabilities",{cache:"no-store",signal:capabilityController.signal});
    if(res.ok)capability=await res.json();
  }finally{clearTimeout(capabilityTimeout);}
  if(!capability?.idempotentSales){
    lastError="Waiting for offline-compatible server. Your local sales remain safe.";
    return {online:false,synced:0,pending:(await all()).filter(x=>x.owner===owner).length,error:lastError};
  }
  const list=(await all()).filter(x=>x.owner===owner).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  for(const entry of list){
   if(entry.state==="review")continue;
   if(entry.fields?.offlineManualReference==="true"&&!capability.manualReferenceWithoutReceipt){
    online=false;
    lastError="Waiting for server support for manual-reference recovery. Your sale is still saved on this device.";
    break;
   }
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
   lastError=entry.error||"This sale needs review before syncing.";
  }
 }catch(error){
  online=false;lastError="Offline sync server not reachable. Transactions remain saved locally.";
 }finally{syncing=false;void updateBanner();}
 return {online,synced,confirmed,pending:(await all()).filter(x=>x.owner===owner).length,error:lastError};
}
let reviewEditingKey=null;
let reviewSelectedReceipt=null;
let reviewPreviewUrl="";

function referenceValue(value,provider){
 let cleaned=String(value||"").toUpperCase().split("").filter(ch=>/[A-Z0-9-]/.test(ch)).join("").replace(/-+/g,"-").replace(/^-|-$/g,"");
 if(provider==="GCash")cleaned=cleaned.replace(/\D/g,"");
 return cleaned;
}
function validReference(value,provider){
 const ref=referenceValue(value,provider);
 if(provider==="GCash")return ref.length>=3&&ref.length<=18;
 return ref.length>=3&&ref.length<=40;
}
function clearReviewPreview(){
 if(reviewPreviewUrl)URL.revokeObjectURL(reviewPreviewUrl);
 reviewPreviewUrl="";
 const preview=$("#offlineReviewPreview");
 if(preview){preview.removeAttribute("src");preview.hidden=true;}
}
function showReviewPreview(file){
 clearReviewPreview();
 if(!file||!file.size)return;
 reviewPreviewUrl=URL.createObjectURL(file);
 const preview=$("#offlineReviewPreview");
 preview.src=reviewPreviewUrl;preview.hidden=false;
}
function ensureReviewDialog(){
 let dialog=$("#offlineReviewDialog");
 if(dialog)return dialog;
 dialog=document.createElement("dialog");
 dialog.id="offlineReviewDialog";
 dialog.className="offline-review-dialog";
 dialog.innerHTML='<form method="dialog" class="offline-review-sheet"><div class="offline-review-heading"><div><p class="offline-review-eyebrow">LOCAL TRANSACTION REVIEW</p><h2 id="offlineReviewTitle">Fix pending sale</h2></div><button type="button" id="offlineReviewClose" class="offline-review-close" aria-label="Close">×</button></div><p id="offlineReviewPayment" class="offline-review-payment"></p><p id="offlineReviewProblem" class="offline-review-problem" role="status"></p><div id="offlineReviewReceiptState" class="offline-review-receipt-state"></div><div class="offline-review-photo-actions"><label class="offline-review-photo-button"><input id="offlineReviewCamera" type="file" accept="image/*" capture="environment"><span>Take / replace photo</span></label><label class="offline-review-photo-button"><input id="offlineReviewGallery" type="file" accept="image/*"><span>Choose from gallery</span></label></div><img id="offlineReviewPreview" class="offline-review-preview" alt="Receipt preview" hidden><label class="offline-review-field"><span>Payment reference</span><input id="offlineReviewReference" type="text" inputmode="text" autocomplete="off" autocapitalize="characters" placeholder="Enter reference number"><small>GCash: 3–18 digits. Other e-wallets: 3–40 characters.</small></label><label class="offline-review-manual"><input id="offlineReviewManual" type="checkbox"><span><strong>Use manual reference if no photo is available</strong><small>Use only when receipt capture is not possible. The reference will be marked as manually entered for admin cross-checking.</small></span></label><div class="offline-review-actions"><button type="button" id="offlineReviewCancel" class="offline-review-secondary">Cancel</button><button type="button" id="offlineReviewSave" class="offline-review-primary">Save &amp; Retry Sync</button></div></form>';
 document.body.append(dialog);
 dialog.querySelector("form").addEventListener("submit",event=>event.preventDefault());
 const close=()=>{if(dialog.open)dialog.close();};
 dialog.querySelector("#offlineReviewClose").addEventListener("click",close);
 dialog.querySelector("#offlineReviewCancel").addEventListener("click",close);
 dialog.querySelector("#offlineReviewSave").addEventListener("click",saveReviewAndRetry);
 for(const id of ["#offlineReviewCamera","#offlineReviewGallery"]){
  dialog.querySelector(id).addEventListener("change",event=>{
   const file=event.target.files?.[0];if(!file)return;
   const problem=dialog.querySelector("#offlineReviewProblem");
   if(!String(file.type||"").startsWith("image/")){problem.textContent="Choose an image file.";event.target.value="";return;}
   if(file.size>8*1024*1024){problem.textContent="Receipt photos must be 8 MB or smaller. Try a smaller photo.";event.target.value="";return;}
   reviewSelectedReceipt=file;
   dialog.querySelector("#offlineReviewReceiptState").textContent="New receipt selected: "+file.name+" · "+(file.size/1024/1024).toFixed(2)+" MB";
   problem.textContent="";showReviewPreview(file);
  });
 }
 dialog.addEventListener("close",()=>{
  clearReviewPreview();reviewEditingKey=null;reviewSelectedReceipt=null;
  dialog.querySelector("#offlineReviewCamera").value="";
  dialog.querySelector("#offlineReviewGallery").value="";
 });
 return dialog;
}
async function openReviewEditor(key){
 const entry=(await all()).find(e=>e.key===key&&e.owner===userId());if(!entry)return;
 const dialog=ensureReviewDialog();reviewEditingKey=key;reviewSelectedReceipt=null;
 const fields=entry.fields||{};
 const method=fields.paymentMethod||entry.method||"Cash";
 const provider=method==="GCash"?"GCash":fields.paymentProvider||"";
 dialog.querySelector("#offlineReviewTitle").textContent="LOCAL-"+identityLabel(entry);
 dialog.querySelector("#offlineReviewPayment").textContent=method+(provider&&provider!==method?" · "+provider:"")+" · "+money(entry.total);
 dialog.querySelector("#offlineReviewProblem").textContent=entry.error||"Add a receipt photo or provide a valid manual reference to recover this sale.";
 dialog.querySelector("#offlineReviewReference").value=fields.paymentReference||fields.gcashReference||"";
 dialog.querySelector("#offlineReviewManual").checked=fields.offlineManualReference==="true";
 dialog.querySelector("#offlineReviewManual").disabled=!["GCash","Other"].includes(method);
 dialog.querySelector("#offlineReviewManual").closest(".offline-review-manual").classList.toggle("offline-review-disabled",!["GCash","Other"].includes(method));
 const hasReceipt=Boolean(entry.receipt&&entry.receipt.size);
 dialog.querySelector("#offlineReviewReceiptState").textContent=hasReceipt?"A receipt image is saved on this device. You can keep it or replace it.":"No receipt image is saved on this device.";
 showReviewPreview(hasReceipt?entry.receipt:null);
 if(!dialog.open)dialog.showModal();
}
async function saveReviewAndRetry(){
 const dialog=ensureReviewDialog(),button=dialog.querySelector("#offlineReviewSave");
 const key=reviewEditingKey;if(!key)return;
 const entry=(await all()).find(e=>e.key===key&&e.owner===userId());if(!entry)return;
 const fields=entry.fields||{};
 const method=fields.paymentMethod||entry.method||"Cash";
 const provider=method==="GCash"?"GCash":fields.paymentProvider||"";
 const digital=["GCash","Other"].includes(method);
 const manual=digital&&dialog.querySelector("#offlineReviewManual").checked;
 const typed=dialog.querySelector("#offlineReviewReference").value.trim();
 const normalized=referenceValue(typed,provider);
 const availableReceipt=reviewSelectedReceipt||entry.receipt||null;
 const problem=dialog.querySelector("#offlineReviewProblem");
 if(digital&&manual){
  if(!validReference(normalized,provider)){
   problem.textContent=provider==="GCash"?"Enter a valid GCash reference of 3–18 digits.":"Enter a valid reference of 3–40 characters.";
   return;
  }
  fields.paymentReference=normalized;
  fields.detectedReference="";
  fields.gcashDetectedReference="";
  fields.ocrVerified="false";
  fields.gcashOcrVerified="false";
  fields.offlineManualReference="true";
 }else if(digital){
  const oldReference=referenceValue(fields.paymentReference||fields.gcashReference||"",provider);
  if(typed&&normalized!==oldReference){
   problem.textContent="To use a manually typed reference, check the manual-reference option below.";
   return;
  }
  if(!availableReceipt){
   problem.textContent="Receipt image is missing. Take a photo or choose an image, or enter a valid reference and check the manual-reference option.";
   return;
  }
  fields.offlineManualReference="false";
  if(reviewSelectedReceipt){
   fields.paymentReference="";
   fields.detectedReference="";
   fields.gcashDetectedReference="";
   fields.ocrVerified="false";
   fields.gcashOcrVerified="false";
  }
 }
 if(reviewSelectedReceipt){
  entry.receipt=reviewSelectedReceipt.slice(0,reviewSelectedReceipt.size,reviewSelectedReceipt.type);
 }
 entry.fields=fields;entry.state="pending";entry.error="";
 button.disabled=true;button.textContent="Saving…";
 try{
  await put(entry);listen();lastError="";
  if(dialog.open)dialog.close();
  await sync();await updateBanner();
 }catch(error){
  problem.textContent=error.message||"Could not save the correction on this device.";
 }finally{
  button.disabled=false;button.textContent="Save & Retry Sync";
 }
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
  if(btn.dataset.action==="edit")void openReviewEditor(btn.dataset.pending);
  if(btn.dataset.action==="discard")void discard(btn.dataset.pending);
 });
 ensureReviewDialog();
}
async function updateBanner(){
 if(!$("#offlinePosStatus"))return;
 const owner=userId();
 const list=(await all()).filter(x=>x.owner===owner).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
 const count=list.length,reviewCount=list.filter(x=>x.state==="review").length;
 const isOnline=navigator.onLine;
 $("#offlinePosCount").textContent=count;
 $("#offlinePosHeadline").textContent=!isOnline?"Offline · local sales enabled":reviewCount||lastError?"Sync needs attention":count?"Online · "+count+" pending sync":"Online · ready";
 $("#offlinePosDescription").textContent=reviewCount
  ?reviewCount+" sale"+(reviewCount===1?" needs":"s need")+" a receipt or valid reference. Open Pending and choose Edit / Fix."
  :lastError||(!isOnline?"Sales will upload when your internet returns.":"Confirmed sales sync to the central database.");
 $("#offlinePosDot").className="offline-pos-dot "+(!isOnline?"offline":reviewCount||lastError?"warning":"online");
 const details=$("#offlinePosDetails");
 details.innerHTML=list.length?list.map(x=>{
  const method=x.fields?.paymentMethod||x.method||"Cash";
  const needsFix=x.state==="review"||(["GCash","Other"].includes(method)&&!x.receipt&&x.fields?.offlineManualReference!=="true");
  return '<div class="offline-pending-row"><div><strong>LOCAL-'+escape(identityLabel(x))+'</strong> · '+money(x.total)+' · '+escape(method)+
   '<small>'+escape(new Date(x.createdAt).toLocaleString("en-PH"))+' · '+(x.state==="review"?"Needs review":x.receipt?"Receipt saved · awaiting server":"Awaiting server")+
   (x.error?(" · "+escape(x.error)):"")+'</small></div><div class="offline-pending-controls">'+
   (needsFix?'<button data-action="edit" data-pending="'+escape(x.key)+'">Edit / Fix</button>':"")+
   '<button data-action="discard" data-pending="'+escape(x.key)+'">Discard</button></div></div>';
 }).join(""):"<p>No unsynced sales on this device.</p>";
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
