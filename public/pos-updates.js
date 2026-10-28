/* Water POS safe in-app updates. Never clear IndexedDB or app login data. */
(function(){
"use strict";
const $=q=>document.querySelector(q);
const KEY="water_pos_seen_web_release";
const LATER="water_pos_deferred_update";
let feed=null,version=null,checking=false,nativeBusy=false;

function getNativeVersion(){
  try{
    if(!window.AndroidPos || typeof window.AndroidPos.getAppVersion!=="function") return null;
    const result=String(window.AndroidPos.getAppVersion()).split("|");
    const code=Number(result[1]);
    return Number.isInteger(code)&&code>0?{name:result[0],code}:null;
  }catch{return null;}
}
function getUpdates(){
  const webStored=localStorage.getItem(KEY);
  return {
    web:!!feed&&!!webStored&&webStored!==feed.webVersion,
    native:!!feed?.native&&!!version&&feed.native.versionCode>version.code
  };
}
function createDialog(){
  if($("#posUpdatesDialog"))return;
  const dialog=document.createElement("dialog");
  dialog.className="pos-updates-dialog";dialog.id="posUpdatesDialog";
  dialog.innerHTML='<section class="pos-updates-sheet"><div class="pos-updates-head"><div><p class="eyebrow">WATER POS · UPDATES</p><h2>App Updates</h2><p>Keep your point of sale current without losing local transactions.</p></div><button id="posUpdatesClose" class="icon-button" type="button" aria-label="Close">×</button></div><div class="pos-updates-body"><div class="pos-update-tile"><span>Web features</span><strong id="posUpdateWebStatus">Checking…</strong><small id="posUpdateWebDetail">Updates use your existing Railway deployment.</small></div><div class="pos-update-tile"><span>Android app</span><strong id="posUpdateNativeStatus">Checking…</strong><small id="posUpdateNativeDetail">Native updates require Android installation approval.</small></div><p id="posUpdateMessage" class="pos-update-message" role="status"></p><div id="posUpdateProgress" class="pos-update-progress" hidden><div id="posUpdateProgressBar"></div></div><p class="pos-update-safety">Your saved login and offline transactions remain on this device. Updates are blocked when sales are pending or an order is unfinished. Android APK updates also verify the file hash and app signing certificate before installation.</p><div class="pos-update-actions"><button id="posUpdateCheck" class="small-button" type="button">Check Again</button><button id="posUpdateLater" class="small-button" type="button">Later</button><button id="posUpdateApply" class="primary-button" type="button" hidden>Update Now</button></div></div></section>';
  document.body.append(dialog);
  $("#posUpdatesClose").onclick=()=>dialog.close();
  $("#posUpdateLater").onclick=()=>{
    if(feed)localStorage.setItem(LATER,feed.webVersion+"|"+(feed.native?.versionCode||0));
    dialog.close();
  };
  $("#posUpdateCheck").onclick=()=>void check(true);
  $("#posUpdateApply").onclick=()=>void applyUpdate();
}
function show(){createDialog();const dialog=$("#posUpdatesDialog");if(!dialog.open)dialog.showModal();}
function setMessage(msg){const el=$("#posUpdateMessage");if(el)el.textContent=msg;}
function paint(){
  if(!feed)return;
  const available=getUpdates();
  const web=$("#posUpdateWebStatus"),native=$("#posUpdateNativeStatus");
  web.textContent=available.web?"Web patch available":"Web features current";
  $("#posUpdateWebDetail").textContent="Release "+feed.webVersion.slice(0,8)+" · Update files without reinstalling APK.";
  native.textContent=version?"Installed v"+version.name:"Android updater not installed";
  const release=feed.native;
  $("#posUpdateNativeDetail").textContent=release
    ?(available.native?"Verified v"+release.versionName+" is available.":"Latest published v"+release.versionName+".")
    :"No compatible signed Android APK has been published yet.";
  const button=$("#posUpdateApply");
  button.hidden=!(available.web||available.native);
  button.textContent=available.native?"Download Android Update":"Apply Web Patch";
  button.disabled=nativeBusy;
  $("#posUpdatesBtn")?.classList.toggle("pos-update-available",available.web||available.native);
}
async function check(showDialog){
  createDialog();
  if(showDialog)show();
  if(checking)return;
  checking=true;
  const btn=$("#posUpdateCheck");btn.disabled=true;
  setMessage("Checking for new patches…");
  try{
    version=getNativeVersion();
    const response=await fetch("/api/pos/app-update",{cache:"no-store"});
    if(!response.ok)throw new Error("Update server unavailable ("+response.status+").");
    const data=await response.json();
    if(!data||typeof data.webVersion!=="string")throw new Error("Invalid update information.");
    feed=data;
    if(!localStorage.getItem(KEY))localStorage.setItem(KEY,data.webVersion);
    paint();
    const updates=getUpdates();
    setMessage(updates.native?"Android update ready. Check pending sales before downloading."
      :updates.web?"A new web patch is ready to apply safely."
      :"Your web features are current. Native updates will appear here when a compatible signed release is available.");
    const id=data.webVersion+"|"+(data.native?.versionCode||0);
    if(!showDialog&&(updates.native||updates.web)&&localStorage.getItem(LATER)!==id){
      $("#posUpdatesBtn")?.classList.add("pos-update-available");
      // Never interrupt an active POS sale with an automatic modal.
    }
  }catch(error){setMessage("Unable to check updates: "+error.message);}
  finally{checking=false;btn.disabled=false;}
}
async function safeToUpdate(){
  const openOrder=!!document.querySelector("#cartItems .cart-row");
  const activePayment=["paymentDialog","quantityDialog","posAccountDialog","onlineQueueDialog","posTransactionsDialog"].some(id=>document.getElementById(id)?.open);
  if(openOrder||activePayment){
    setMessage("Finish or clear the current order and close transaction dialogs before updating.");
    return false;
  }
  if(!window.waterOffline || typeof window.waterOffline.all!=="function"){
    setMessage("Offline transaction storage has not initialized. Reopen Water POS before updating.");
    return false;
  }
  try{
    const sales=await window.waterOffline.all();
    if(sales.length){
      setMessage(sales.length+" unsynced sale(s) remain on this device. Sync them first. No local data was changed.");
      return false;
    }
    return true;
  }catch{
    setMessage("Unable to verify the offline queue. Update blocked to protect sales.");
    return false;
  }
}
async function applyUpdate(){
  if(!feed)return;
  if(!await safeToUpdate())return;
  const available=getUpdates();
  if(available.native){
    if(!window.AndroidPos || typeof window.AndroidPos.downloadAppUpdate!=="function"){
      setMessage("This APK does not yet contain the Android updater. Install the first updater-capable APK using your existing trusted distribution process.");
      return;
    }
    nativeBusy=true;paint();
    $("#posUpdateProgress").hidden=false;
    setMessage("Starting verified APK download…");
    try{
      window.AndroidPos.downloadAppUpdate(feed.native.apkUrl,feed.native.sha256,feed.native.versionCode);
    }catch(error){nativeBusy=false;paint();setMessage("Unable to start download: "+error.message);}
    return;
  }
  if(available.web){
    const button=$("#posUpdateApply");button.disabled=true;
    setMessage("Refreshing application files. Your login and saved sales are retained…");
    try{
      if("serviceWorker" in navigator){
        const registration=await navigator.serviceWorker.getRegistration("/");
        if(registration)await registration.update();
      }
      localStorage.setItem(KEY,feed.webVersion);
      location.reload();
    }catch(error){
      setMessage("Could not apply web patch: "+error.message);
      button.disabled=false;
    }
  }
}
window.WaterPosUpdater={
  onNativeProgress(data){
    if(!data||typeof data!=="object")return;
    show();
    setMessage(data.message||"Checking update…");
    const p=Math.max(0,Math.min(100,Number(data.progress)||0));
    $("#posUpdateProgress").hidden=false;
    $("#posUpdateProgressBar").style.width=p+"%";
    if(data.status==="error"||data.status==="installing"){
      nativeBusy=false;paint();
    }
  },
  check:()=>check(true)
};
document.addEventListener("click",event=>{
  if(event.target.closest("#posUpdatesBtn")){void check(true);}
});
if(document.readyState==="loading"){
  document.addEventListener("DOMContentLoaded",()=>{createDialog();setTimeout(()=>void check(false),3000);},{once:true});
}else{createDialog();setTimeout(()=>void check(false),3000);}
})();
