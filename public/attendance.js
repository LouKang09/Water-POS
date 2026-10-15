(function(){
"use strict";
const $=s=>document.querySelector(s);
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const pad=n=>String(n).padStart(2,"0");
let shift=null,clockOffset=0,lastReminder="",lunchReminder="",processing=false;
function localDay(now=new Date()){
  return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Manila",year:"numeric",month:"2-digit",day:"2-digit"}).format(now);
}
function minsNow(){const parts=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Manila",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date()).map(x=>[x.type,x.value]));return Number(parts.hour)*60+Number(parts.minute);}
function timeText(ms){let n=Math.max(0,Math.floor(ms/60000));return Math.floor(n/60)+"h "+pad(n%60)+"m";}
function now(){return Date.now()+clockOffset;}
function notification(text){if("Notification"in window&&Notification.permission==="granted"&&document.hidden){new Notification("Water POS Attendance",{body:text});}}
function inject(){
 if($("#attendanceWidget"))return;
 const host=$(".pos-shell")||$(".pos-header");
 const section=document.createElement("section");
 section.id="attendanceWidget";section.className="attendance-widget";
 section.innerHTML=`<div class="attendance-title">
   <div><span class="attendance-eyebrow">MY DAILY ATTENDANCE</span><h2>Time In / Time Out</h2><p id="attendanceStatus">Loading attendance…</p></div>
   <div class="attendance-clock"><small id="attendanceClockLabel">Active time</small><strong id="attendanceTimer">0h 00m</strong><small id="attendanceBreak">9-hour shift · 1-hour unpaid lunch</small></div>
 </div><div class="attendance-actions">
   <button id="attendanceIn" type="button" class="attendance-primary">Time In</button>
   <button id="attendanceLunch" type="button" class="attendance-secondary">Start Lunch</button>
   <button id="attendanceOut" type="button" class="attendance-danger">Time Out</button>
   <button id="attendanceContinue" type="button" class="attendance-primary">Continue Shift</button>
 </div><p id="attendanceNotice" role="status">Clock-in is separate from POS login. Logging out does not time you out.</p>`;
 if(host.classList.contains("pos-shell"))host.insertBefore(section,host.firstElementChild);else host.insertAdjacentElement("afterend",section);
 let dialog=document.createElement("dialog");dialog.id="attendanceWarning";dialog.className="attendance-warning";
 dialog.innerHTML=`<div class="attendance-warning-card"><p class="attendance-eyebrow">ATTENDANCE REMINDER</p><h2 id="attendanceWarningTitle">Check your attendance</h2><p id="attendanceWarningText"></p><div class="attendance-warning-buttons"><button id="attendanceWarningKeep" type="button" class="attendance-secondary">Continue Working</button><button id="attendanceWarningConfirm" type="button" class="attendance-danger">Time Out Anyway</button></div></div>`;
 document.body.appendChild(dialog);
 $("#attendanceWarningKeep").onclick=()=>dialog.close();
 $("#attendanceWarningConfirm").onclick=async()=>{dialog.close();await action("time-out",true);};
 $("#attendanceIn").onclick=()=>action("time-in");
 $("#attendanceLunch").onclick=()=>action(shift?.state==="lunch"?"lunch-end":"lunch-start");
 $("#attendanceOut").onclick=()=>action("time-out");
 $("#attendanceContinue").onclick=()=>action("continue");
 render();
}
function render(){
 if(!$("#attendanceWidget"))return;
 const state=shift?.state||"none";
 $("#attendanceIn").hidden=state!=="none";
 $("#attendanceLunch").hidden=!["working","lunch"].includes(state);
 $("#attendanceLunch").textContent=state==="lunch"?"End Lunch · Return to Work":"Start Lunch";
 $("#attendanceOut").hidden=!["working","lunch"].includes(state);
 $("#attendanceContinue").hidden=state!=="out";
 const started=shift?.clockIn?Date.parse(shift.clockIn):0;
 const ended=shift?.clockOut?Date.parse(shift.clockOut):now();
 const elapsed=shift?Math.max(0,ended-started):0;
 const liveLunch=shift?.state==="lunch"?Math.max(0,now()-Date.parse(shift.lunchStartedAt||shift.clockIn)):0;
 const activePaid=shift?Math.max(0,elapsed-(shift.lunchMinutes||0)*60000-(shift.pausedMinutes||0)*60000):0;
 $("#attendanceTimer").textContent=timeText(activePaid);
 $("#attendanceClockLabel").textContent=state==="lunch"?"Lunch break":state==="out"?"Today's total":"Recorded working time";
 $("#attendanceBreak").textContent=state==="lunch"?"Lunch elapsed: "+timeText(liveLunch):"Lunch taken: "+timeText((shift?.lunchMinutes||0)*60000)+" · Unpaid";
 $("#attendanceStatus").textContent=state==="none"?"Not timed in · 9:00 AM–6:00 PM shift":state==="working"?"Clocked in · Tracking work time":state==="lunch"?"On unpaid lunch break":state==="out"?"Timed out · Shift paused":"";
}
async function load(){
 if(!localStorage.getItem("water_pos_user_token"))return;
 try{
   const r=await fetch("/api/pos/attendance",{cache:"no-store"});
   const data=await r.json();if(!r.ok)throw new Error(data.error||"Unable to load attendance.");
   clockOffset=Date.parse(data.serverNow)-Date.now();
   shift=data.shift;$("#attendanceNotice").textContent="Time is saved securely. Logging out does not end your shift.";render();
 }catch(e){if($("#attendanceNotice"))$("#attendanceNotice").textContent=e.message;}
}
function warning(title,message,confirmAction){
 $("#attendanceWarningTitle").textContent=title;
 $("#attendanceWarningText").textContent=message;
 $("#attendanceWarningConfirm").hidden=!confirmAction;
 $("#attendanceWarningKeep").textContent=confirmAction?"Continue Working":"OK";
 $("#attendanceWarning").showModal();
}
async function action(type,confirmEarly=false){
 if(processing)return;
 if(type==="time-out"&&shift?.state==="lunch"){warning("End Lunch First","Finish your unpaid lunch before clocking out.",false);return;}
 processing=true;$("#attendanceNotice").textContent="Saving attendance…";
 try{
   const response=await fetch("/api/pos/attendance/"+type,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({confirmEarly})});
   const data=await response.json();
   if(response.status===409&&data.needsConfirmation){warning("Early Time Out Warning",data.error,true);return;}
   if(!response.ok)throw new Error(data.error||"Could not save attendance.");
   shift=data.shift;
   $("#attendanceNotice").textContent=type==="time-out"?"Time out saved. Use Continue Shift if you ended too early.":type==="continue"?"Shift resumed. Your earlier time-out gap is excluded.":"Attendance saved successfully.";
   render();
 }catch(e){$("#attendanceNotice").textContent=e.message;}
 finally{processing=false;}
}
function reminderCheck(){
 if(!shift||shift.state==="out")return;
 const day=localDay();
 const minute=minsNow();
 if(minute>=17*60+45&&minute<18*60){
   const key="water-pos-clockout-reminder-"+day+"-"+shift.id;
   if(lastReminder!==key&&!sessionStorage.getItem(key)){
     lastReminder=key;sessionStorage.setItem(key,"yes");
     const message="Make sure to time out before logging out to count your hours for the day.";
     warning("15-minute clock-out reminder",message,false);notification(message);
   }
 }
 if(shift.state==="lunch"&&shift.lunchStartedAt){
   const since=(now()-Date.parse(shift.lunchStartedAt))/60000;
   const key="water-pos-lunch-reminder-"+shift.id+"-"+shift.lunchStartedAt;
   if(since>=45&&lunchReminder!==key&&!sessionStorage.getItem(key)){
     lunchReminder=key;sessionStorage.setItem(key,"yes");
     const msg="Your 1-hour unpaid lunch ends in 15 minutes. Please return to work on time.";
     warning("Lunch break reminder",msg,false);notification(msg);
   }
 }
}
function start(){
 if(!localStorage.getItem("water_pos_user_token"))return;
 inject();load();
 setInterval(()=>{render();reminderCheck();},1000);
 setInterval(load,60000);
 document.addEventListener("visibilitychange",()=>{if(!document.hidden)load();});
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();
})();
