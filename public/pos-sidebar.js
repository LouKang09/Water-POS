(function(){
"use strict";
const $=selector=>document.querySelector(selector);
const sidebar=$("#posSidebar"),backdrop=$("#posSidebarBackdrop"),toggle=$("#posSidebarToggle"),badge=$("#posSidebarQueueBadge");
if(!sidebar||!toggle)return;
let lastFocus=null;
function setOpen(open){
  if(open)lastFocus=document.activeElement;
  sidebar.classList.toggle("open",open);
  sidebar.toggleAttribute("inert",!open);
  sidebar.setAttribute("aria-hidden",String(!open));
  backdrop.hidden=!open;
  document.body.classList.toggle("pos-sidebar-open",open);
  toggle.setAttribute("aria-expanded",String(open));
  toggle.setAttribute("aria-label",open?"Close navigation menu":"Open navigation menu");
  if(open)$("#posSidebarClose")?.focus();
  else if(sidebar.contains(document.activeElement))toggle.focus();
}
toggle.addEventListener("click",()=>setOpen(!sidebar.classList.contains("open")));
$("#posSidebarClose").addEventListener("click",()=>setOpen(false));
backdrop.addEventListener("click",()=>setOpen(false));
document.addEventListener("keydown",event=>{
  if(event.key==="Escape"&&sidebar.classList.contains("open"))setOpen(false);
  if(event.key==="Tab"&&sidebar.classList.contains("open")){
    const controls=[...sidebar.querySelectorAll('button:not([disabled]),a[href]')].filter(x=>x.getClientRects().length);
    const first=controls[0],last=controls[controls.length-1];
    if(!first)return;
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
});
// Keep existing queue/theme/password/logout handlers: their original DOM IDs were
// moved into the sidebar, and the native Android Exit button stays in the header.
sidebar.addEventListener("click",event=>{
  if(event.target.closest("#posTodayTransactionsBtn")){
    setOpen(false);
    openTransactions();
    return;
  }
  if(event.target.closest("#onlineQueueBtn,#posThemeToggle,#posAccountBtn,.pos-sidebar-admin-link")){
    setOpen(false);
  }
});
window.addEventListener("waterpos:queue-update",event=>{
  const count=Math.max(0,Number(event.detail?.count||0));
  badge.textContent=count>99?"99+":String(count);
  badge.hidden=count===0;
  const show=$("#onlineQueueCount");
  if(show)show.classList.toggle("has-items",count>0);
  toggle.setAttribute("aria-label",(sidebar.classList.contains("open")?"Close":"Open")+" navigation menu"+(count?" · "+count+" online delivery request"+(count===1?"":"s"):""));
});
const observer=new MutationObserver(()=>{
  const count=Number($("#onlineQueueCount")?.textContent||0);
  window.dispatchEvent(new CustomEvent("waterpos:queue-update",{detail:{count}}));
});
const countEl=$("#onlineQueueCount");
if(countEl){observer.observe(countEl,{childList:true,characterData:true,subtree:true});}
function dayKey(input){
  const dt=new Date(input);
  if(!Number.isFinite(dt.getTime()))return "";
  const p=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Manila",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(dt).map(x=>[x.type,x.value]));
  return p.year+"-"+p.month+"-"+p.day;
}
function textSafe(value){return String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));}
function amount(value){return "₱"+Number(value||0).toLocaleString("en-PH",{minimumFractionDigits:2,maximumFractionDigits:2});}
function timestamp(value){
  const d=new Date(value);
  return Number.isFinite(d.getTime())?new Intl.DateTimeFormat("en-PH",{timeZone:"Asia/Manila",hour:"numeric",minute:"2-digit"}).format(d):"";
}
function listItems(items){
  let data=items;
  if(typeof data==="string"){try{data=JSON.parse(data);}catch{data=[];}}
  return Array.isArray(data)?data.map(i=>String(i.label||i.category||"Item")+" × "+Number(i.qty||1)).join(", "):"";
}
function initDialog(){
  if($("#posTransactionsDialog"))return;
  const dialog=document.createElement("dialog");
  dialog.id="posTransactionsDialog";dialog.className="pos-transactions-dialog";
  dialog.setAttribute("aria-labelledby","posTransactionsTitle");
  dialog.innerHTML='<section class="pos-transactions-sheet"><div class="pos-transactions-head"><div><p class="eyebrow">MY DAILY SALES</p><h2 id="posTransactionsTitle">Today’s Transactions</h2><p>Only your transactions dated today (Philippine time).</p></div><button type="button" class="icon-button" id="posTransactionsClose" aria-label="Close">×</button></div><div class="pos-transactions-tools"><span id="posTransactionsSummary">Loading…</span><button type="button" id="posTransactionsRefresh">Refresh</button></div><div id="posTransactionsList" class="pos-transactions-list" aria-live="polite"></div></section>';
  document.body.append(dialog);
  $("#posTransactionsClose").addEventListener("click",()=>dialog.close());
  $("#posTransactionsRefresh").addEventListener("click",loadTransactions);
}
async function openTransactions(){
  initDialog();
  const dialog=$("#posTransactionsDialog");
  if(!dialog.open)dialog.showModal();
  await loadTransactions();
}
async function loadTransactions(){
  const display=$("#posTransactionsList"),summary=$("#posTransactionsSummary");
  if(!display)return;
  const refresh=$("#posTransactionsRefresh");
  refresh.disabled=true;
  summary.textContent="Loading today’s transactions…";
  const today=dayKey(new Date());
  let remote=[],loadError="";
  try{
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),12000);
    let response;
    try{response=await fetch("/api/pos/transactions/today",{cache:"no-store",signal:controller.signal});}
    finally{clearTimeout(timeout);}
    if(!response.ok)throw new Error("Unable to load server history ("+response.status+").");
    const data=await response.json();
    if(!Array.isArray(data))throw new Error("Invalid server history response.");
    remote=data.filter(x=>dayKey(x.created_at)===today);
  }catch(error){loadError=error.name==="AbortError"?"Server request timed out.":error.message;}
  let local=[];
  try{
    const person=JSON.parse(localStorage.getItem("water_pos_cached_user")||"null");
    if(window.waterOffline?.all&&person?.id){
      const stored=await window.waterOffline.all();
      const confirmed=new Set(remote.map(x=>x.client_sale_key).filter(Boolean));
      local=stored.filter(x=>Number(x.owner)===Number(person.id)&&dayKey(x.createdAt)===today&&!confirmed.has(x.key))
        .map(x=>({
          transaction_ref:"LOCAL-"+String(x.key).slice(-8).toUpperCase(),
          created_at:x.createdAt,total:x.total,
          payment_method:x.method||x.fields?.paymentMethod||"Cash",
          items:x.fields?.items||"[]",
          localState:x.state==="review"?"review":"pending",
          client_sale_key:x.key
        }));
    }
  }catch(error){loadError=loadError||"Unable to read locally saved sales.";}
  const entries=[
    ...remote.map(x=>({...x,localState:"confirmed"})),
    ...local
  ].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
  const confirmedCount=remote.length,pendingCount=local.length;
  summary.textContent=confirmedCount+" confirmed · "+pendingCount+" saved locally"+(loadError?" · Server data unavailable":"");
  if(!entries.length){
    display.innerHTML='<div class="pos-transaction-empty">'+(loadError?textSafe(loadError)+" Your pending sales remain on this device.":"No transactions recorded today.")+'</div>';
  }else{
    display.innerHTML=(loadError?'<div class="pos-transaction-empty">'+textSafe(loadError)+" · Showing available local records.</div>":"")+
    entries.map(x=>{
      const status=x.localState==="confirmed"?(x.payment_status==="unpaid"?"Unpaid":"Confirmed"):x.localState==="review"?"Needs review":"Pending sync";
      const stateClass=x.localState==="confirmed"?"":x.localState==="review"?"review":"pending";
      const extra=listItems(x.items);
      return '<article class="pos-transaction-row"><div class="pos-transaction-main"><strong>'+textSafe(x.transaction_ref)+'</strong><small>'+textSafe(timestamp(x.created_at))+" · "+textSafe(x.payment_method||"Cash")+
        (x.payment_provider?" / "+textSafe(x.payment_provider):"")+'</small><small>'+textSafe(extra||"Sale")+'</small></div><div class="pos-transaction-trailing"><strong>'+textSafe(amount(x.total))+
        '</strong><span class="pos-transaction-state '+stateClass+'">'+textSafe(status)+'</span></div></article>';
    }).join("");
  }
  refresh.disabled=false;
}
window.addEventListener("waterpos:offline-change",()=>{if($("#posTransactionsDialog")?.open)void loadTransactions();});
})();
