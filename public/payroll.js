(function(){
"use strict";
const q=s=>document.querySelector(s);
const e=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const peso=n=>"₱ "+Number(n||0).toLocaleString("en-PH",{minimumFractionDigits:2,maximumFractionDigits:2});
const currency=n=>Number(n||0).toFixed(2);
const pad=n=>String(n).padStart(2,"0");
let employees=[],lastPreview=null,nextNo=46,loading=false;
function phToday(){
 const p=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Manila",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date()).map(x=>[x.type,x.value]));
 return p.year+"-"+p.month+"-"+p.day;
}
function currentPeriod(){
 const [year,month,date]=phToday().split("-").map(Number);
 return {year,month,half:date<=15?"first":"second"};
}
function create(){
 const nav=q(".side-nav");if(!nav||q("#payrollSection"))return;
 const button=document.createElement("button");button.type="button";button.dataset.section="payroll";button.textContent="Payroll & Attendance";
 const account=nav.querySelector('[data-section="account"]');if(account)nav.insertBefore(button,account);else nav.appendChild(button);
 const section=document.createElement("section");section.id="payrollSection";section.className="admin-section";
 section.innerHTML=`<div class="payroll-main">
  <div class="payroll-intro"><div><p class="eyebrow">EMPLOYEE TIMEKEEPING</p><h2>Payroll & Payslips</h2><p>Payroll comes from completed daily attendance. Review every figure before saving and printing.</p></div><button type="button" id="payrollReload" class="small-button">Refresh Attendance</button></div>
  <div class="panel payroll-controls"><div class="payroll-form-grid">
   <label><span>Employee Name</span><select id="payrollEmployee"></select></label>
   <label><span>Year</span><input id="payrollYear" type="number" min="2020" max="2100"></label>
   <label><span>Month</span><select id="payrollMonth">${Array.from({length:12},(_,i)=>'<option value="'+(i+1)+'">'+new Intl.DateTimeFormat("en-US",{month:"long"}).format(new Date(Date.UTC(2026,i,1)))+"</option>").join("")}</select></label>
   <label><span>Payroll Cutoff</span><select id="payrollHalf"><option value="first">1st–15th</option><option value="second">16th–Last Day</option></select></label>
  </div><div class="payroll-employment-grid">
    <label><span>Employee Payroll Name</span><input id="payrollProfileName" maxlength="120"></label>
    <label><span>Daily Wage (₱)</span><input id="payrollDailyRate" type="number" min="0" step="0.01" value="582"></label>
    <button type="button" id="payrollSaveRate" class="small-button">Save Employee Rate</button>
   </div><p class="payroll-help">Default rate: ₱582 per 8 paid hours. Late deduction starts at 30 minutes after 9 AM. One hour of lunch is unpaid; lunch over 60 minutes may be deducted.</p>
  </div>
  <details class="panel payroll-enroll"><summary><strong>+ Add Employee</strong><span>Give a new staff member an account for Time In / Time Out</span></summary><form id="payrollCreateEmployee" class="payroll-form-grid">
    <label><span>Employee Full Name</span><input id="payrollNewName" required maxlength="120" placeholder="Employee name"></label>
    <label><span>Login Email</span><input id="payrollNewEmail" type="email" required placeholder="employee@example.com"></label>
    <label><span>Initial Password</span><input id="payrollNewPassword" type="password" required minlength="8" placeholder="At least 8 characters"></label>
    <label><span>Daily Wage (₱)</span><input id="payrollNewRate" type="number" min="0" step="0.01" required value="582"></label>
    <button type="submit" class="primary-button">Create Employee Account</button>
   </form><p class="payroll-help">The employee signs into the existing Water POS app using this email and password. The employee can change the password inside the app.</p></details>
  <div class="payroll-stats" id="payrollStats"></div>
  <div class="panel payroll-attendance"><div class="payroll-section-head"><div><h3>Daily Time Records (DTR)</h3><p>Live attendance history, including breaks and pending time-outs.</p></div></div><div class="payroll-table-scroll"><table><thead><tr><th>Date</th><th>Status</th><th>Worked</th><th>Late</th><th>Lunch</th><th>Early Out</th></tr></thead><tbody id="payrollDays"></tbody></table></div><p id="payrollAttendanceInfo"></p><div id="payrollAdminClose" class="payroll-admin-close"></div></div>
  <div class="panel payroll-editor"><div class="payroll-section-head"><div><h3>Editable Payslip</h3><p>Every label, amount, name, and date can be adjusted before printing.</p></div><span class="payroll-no-label">Payslip no. <strong id="payrollNo">46</strong></span></div>
   <div class="payroll-form-grid"><label><span>Employee Name on Slip</span><input id="slipEmployee" maxlength="120"></label><label><span>Pay Period Label</span><input id="slipPeriod" maxlength="120"></label><label><span>Pay Date</span><input id="slipDate" type="date"></label><label><span>Notes (internal)</span><input id="slipNotes" maxlength="500" placeholder="Optional"></label></div>
   <div class="payroll-tables"><div class="payroll-column"><div class="payroll-column-head"><h4>Earnings</h4><button type="button" id="addEarning">+ Add</button></div><div id="earningRows" class="payroll-rows"></div><div class="payroll-subtotal">Total Earnings <strong id="earningTotal">₱ 0.00</strong></div></div>
   <div class="payroll-column"><div class="payroll-column-head"><h4>Deductions</h4><button type="button" id="addDeduction">+ Add</button></div><div id="deductionRows" class="payroll-rows"></div><div class="payroll-subtotal">Total Deductions <strong id="deductionTotal">₱ 0.00</strong></div></div></div>
   <div class="payroll-bottom"><div class="payroll-net">Net Pay <strong id="netPay">₱ 0.00</strong></div><div class="payroll-buttons"><button id="savePayslip" type="button" class="small-button">Save Payslip</button><button id="printPayslip" type="button" class="primary-button">Save & Print Payslip</button></div></div><p id="payrollMessage" aria-live="polite"></p>
  </div>
  <div class="panel"><div class="payroll-section-head"><h3>Saved Payslips</h3><span>Numbers assigned only when saved</span></div><div id="payrollSaved" class="payroll-saved"></div></div>
  <div class="panel payroll-settings"><h3>Payroll Numbering</h3><div class="payroll-settings-inline"><label><span>Next Payslip Number</span><input type="number" min="1" step="1" id="payrollNextNumber" value="46"></label><button type="button" class="small-button" id="savePayrollNext">Update Next Number</button></div><p>Starting at 46, saved payslips increase consecutively. Editing an existing payslip keeps its number.</p></div>
 </div>`;
 q(".admin-main").appendChild(section);
 const now=currentPeriod();
 q("#payrollYear").value=now.year;q("#payrollMonth").value=now.month;q("#payrollHalf").value=now.half;
 q("#slipDate").value=phToday();
 for(const key of ["payrollEmployee","payrollYear","payrollMonth","payrollHalf"])q("#"+key).addEventListener("change",loadPreview);
 q("#payrollReload").onclick=loadPreview;
 q("#payrollSaveRate").onclick=saveRate;
 q("#payrollCreateEmployee").onsubmit=createEmployee;
 q("#addEarning").onclick=()=>addRow("earningRows",{label:"Additional Earning",amount:0});
 q("#addDeduction").onclick=()=>addRow("deductionRows",{label:"Other Deduction",amount:0});
 q("#savePayslip").onclick=()=>savePayslip(false);
 q("#printPayslip").onclick=()=>savePayslip(true);
 q("#savePayrollNext").onclick=saveStartNo;
 nav.addEventListener("click",event=>{if(event.target.closest('[data-section="payroll"]'))loadAll();});
}
function getParams(){
 return {employeeId:Number(q("#payrollEmployee").value),year:Number(q("#payrollYear").value),month:Number(q("#payrollMonth").value),half:q("#payrollHalf").value};
}
function params(){return new URLSearchParams(getParams()).toString();}
function addRow(holder,item){
 const row=document.createElement("div");row.className="payroll-item";
 row.innerHTML='<input class="payroll-item-label" maxlength="100" placeholder="Particulars" aria-label="Particulars"><input class="payroll-item-amount" type="number" min="0" step="0.01" aria-label="Amount"><button type="button" aria-label="Remove line" title="Remove row">×</button>';
 row.querySelector(".payroll-item-label").value=item.label||"";
 row.querySelector(".payroll-item-amount").value=currency(item.amount);
 row.querySelector("button").onclick=()=>{row.remove();totals();};
 row.querySelectorAll("input").forEach(i=>i.addEventListener("input",totals));
 q("#"+holder).appendChild(row);totals();
}
function rows(holder){
 return [...q("#"+holder).querySelectorAll(".payroll-item")].map(r=>({label:r.querySelector(".payroll-item-label").value.trim(),amount:Number(r.querySelector(".payroll-item-amount").value)})).filter(x=>x.label||x.amount);
}
function totals(){
 const earning=rows("earningRows").reduce((n,x)=>n+(Number.isFinite(x.amount)?x.amount:0),0);
 const deduction=rows("deductionRows").reduce((n,x)=>n+(Number.isFinite(x.amount)?x.amount:0),0);
 q("#earningTotal").textContent=peso(earning);q("#deductionTotal").textContent=peso(deduction);q("#netPay").textContent=peso(earning-deduction);
}
function mins(n){return Math.floor(Number(n||0)/60)+"h "+pad(Math.round(Number(n||0)%60))+"m";}
async function loadEmployees(){
 employees=await api("/api/admin/payroll/employees");
 const current=q("#payrollEmployee").value;
 q("#payrollEmployee").innerHTML=employees.map(x=>'<option value="'+x.id+'">'+e(x.payroll_name||x.name)+(x.active?"":" (inactive)")+"</option>").join("");
 if(employees.some(x=>String(x.id)===current))q("#payrollEmployee").value=current;
}
async function loadAll(){
 if(!token||loading)return;
 loading=true;
 try{
  const [settings]=await Promise.all([api("/api/admin/payroll/settings"),loadEmployees()]);
  nextNo=settings.nextPayslipNo;q("#payrollNextNumber").value=nextNo;
  await Promise.all([loadPreview(),loadSaved()]);
 }catch(error){q("#payrollMessage").textContent=error.message||"Unable to load payroll.";}
 finally{loading=false;}
}
async function loadPreview(){
 if(!token||!Number(getParams().employeeId))return;
 try{
  const data=await api("/api/admin/payroll/preview?"+params());
  lastPreview=data;
  const employee=data.employee;
  q("#payrollProfileName").value=employee.payroll_name;
  q("#payrollDailyRate").value=currency(employee.daily_wage);
  q("#payrollNo").textContent=data.saved?.payslip_no||data.estimatedPayslipNo;
  q("#slipEmployee").value=data.saved?.employee_name||employee.payroll_name;
  q("#slipPeriod").value=data.saved?.period_label||data.period.label;
  q("#slipDate").value=data.saved?.pay_date||phToday();
  q("#slipNotes").value=data.saved?.payroll_notes||"";
  q("#earningRows").innerHTML="";q("#deductionRows").innerHTML="";
  (data.saved?.earnings||data.earnings).forEach(r=>addRow("earningRows",r));
  (data.saved?.deductions||data.deductions).forEach(r=>addRow("deductionRows",r));
  q("#payrollStats").innerHTML='<div><span>Completed Workdays</span><strong>'+data.completedDays+'</strong></div><div><span>Pending Time-outs</span><strong>'+data.openDays+'</strong></div><div><span>Late Minutes Charged</span><strong>'+data.lateMinutes+'</strong></div><div><span>Daily Rate</span><strong>'+peso(employee.daily_wage)+'</strong></div>';
  q("#payrollDays").innerHTML=data.days.length?data.days.map(row=>'<tr><td>'+e(row.date)+'</td><td>'+e(row.completed?"Completed":"Needs time-out")+'</td><td>'+e(mins(row.paidWorkMinutes))+'</td><td>'+row.lateMinutes+' min'+(row.lateDeductedMinutes?" (deductible)":"")+'</td><td>'+row.lunchMinutes+' min</td><td>'+row.earlyMinutes+' min</td></tr>').join(""):'<tr><td colspan="6">No attendance recorded during this period.</td></tr>';
  q("#payrollAttendanceInfo").textContent=data.openDays?"Warning: "+data.openDays+" day(s) have no final time-out, so they are excluded from automatic earnings. Review them below.":"Only completed days are included in payroll.";
  await loadOpenShifts(data.period.from,data.period.to);
  q("#payrollMessage").textContent=data.saved?"Loaded saved payslip #"+data.saved.payslip_no+". All details remain editable.":"Preview calculated. Review and save to assign a payslip number.";
  totals();
 }catch(error){q("#payrollMessage").textContent=error.message;}
}
async function loadOpenShifts(from,to){
 const att=await api("/api/admin/payroll/attendance?"+new URLSearchParams({from,to,employeeId:getParams().employeeId}));
 const open=att.filter(x=>x.state!=="out");
 q("#payrollAdminClose").innerHTML=open.length?'<h4>Admin Time-Out Override</h4>'+open.map(x=>'<div class="payroll-open-day"><span>'+e(x.day)+' · '+e(x.name)+' · '+e(x.state)+'</span><button type="button" class="small-button" data-shift="'+x.id+'">Time Out Employee</button></div>').join(""):"";
 q("#payrollAdminClose").querySelectorAll("[data-shift]").forEach(btn=>btn.onclick=()=>closeShift(btn.dataset.shift));
}
async function closeShift(id){
 const reason=window.prompt("Why are you clocking this employee out? A reason will be saved in the audit trail.","Forgot to time out");
 if(!reason?.trim())return;
 const time=window.prompt("Time-out time (Philippine time). Leave blank to use now, or 6 PM for a past day.\nOptional format: YYYY-MM-DDTHH:MM","");
 if(time===null)return;
 try{
  await api("/api/admin/payroll/attendance/"+id+"/close",{method:"POST",body:{reason,clockOutAt:time||undefined}});
  toast("Admin time-out recorded.");await loadPreview();
 }catch(ex){toast(ex.message);}
}
async function createEmployee(event){
 event.preventDefault();
 const button=q("#payrollCreateEmployee button[type=submit]");button.disabled=true;
 try{
  const data=await api("/api/admin/payroll/employees",{method:"POST",body:{
    name:q("#payrollNewName").value,email:q("#payrollNewEmail").value,
    password:q("#payrollNewPassword").value,dailyWage:q("#payrollNewRate").value
  }});
  await loadEmployees();
  q("#payrollEmployee").value=data.id;
  q("#payrollCreateEmployee").reset();
  q(".payroll-enroll").open=false;
  toast("Employee account created. Staff may now sign in and record attendance.");
  await loadPreview();
 }catch(err){toast(err.message);}
 finally{button.disabled=false;}
}
async function saveRate(){
 const id=getParams().employeeId;
 if(!id)return;
 try{
  await api("/api/admin/payroll/employees/"+id,{method:"PATCH",body:{payrollName:q("#payrollProfileName").value,dailyWage:q("#payrollDailyRate").value}});
  toast("Employee payroll rate saved.");await loadEmployees();await loadPreview();
 }catch(ex){toast(ex.message);}
}
async function saveStartNo(){
 try{
   const v=await api("/api/admin/payroll/settings",{method:"PATCH",body:{nextPayslipNo:Number(q("#payrollNextNumber").value)}});
   nextNo=v.nextPayslipNo;toast("Next payslip number updated.");await loadPreview();
 }catch(ex){toast(ex.message);}
}
async function savePayslip(print){
 const values={...getParams(),employeeName:q("#slipEmployee").value,periodLabel:q("#slipPeriod").value,payDate:q("#slipDate").value,notes:q("#slipNotes").value,earnings:rows("earningRows"),deductions:rows("deductionRows")};
 if(!values.employeeName.trim()||!values.earnings.length||values.earnings.some(x=>!x.label||!Number.isFinite(x.amount)||x.amount<0)||values.deductions.some(x=>!x.label||!Number.isFinite(x.amount)||x.amount<0))return toast("Complete all earning and deduction descriptions and amounts.");
 if(lastPreview?.openDays&& !window.confirm("Some days have no time-out and are excluded from calculated wages. Save this payslip anyway?"))return;
 const button=q(print?"#printPayslip":"#savePayslip");
 button.disabled=true;
 try{
  const saved=await api("/api/admin/payroll/payslips",{method:"POST",body:values});
  q("#payrollNo").textContent=saved.payslip_no;
  q("#payrollMessage").textContent="Payslip #"+saved.payslip_no+" saved. Net Pay: "+peso(saved.netPay);
  await loadSaved();
  if(print)renderPrint(saved);
 }catch(ex){toast(ex.message);}
 finally{button.disabled=false;}
}
async function loadSaved(){
 const saved=await api("/api/admin/payroll/payslips");
 q("#payrollSaved").innerHTML=saved.length?saved.map(x=>'<button class="payroll-saved-row" type="button" data-user="'+x.user_id+'" data-date="'+e(x.period_from)+'"><strong>#'+x.payslip_no+'</strong><span>'+e(x.employee_name)+'</span><small>'+e(x.period_from)+' – '+e(x.period_to)+'</small></button>').join(""):"No payslips have been saved yet.";
 q("#payrollSaved").querySelectorAll("button").forEach(b=>b.onclick=async()=>{
   const [y,m,d]=b.dataset.date.split("-").map(Number);
   q("#payrollEmployee").value=b.dataset.user;q("#payrollYear").value=y;q("#payrollMonth").value=m;q("#payrollHalf").value=d===1?"first":"second";
   await loadPreview();
   q(".payroll-editor")?.scrollIntoView({behavior:"smooth",block:"start"});
 });
}
function renderPrint(saved){
 const lineItems=(arr)=>{const visible=arr.filter(x=>Number(x.amount)!==0);return (visible.length?visible:[{label:"—",amount:0}]).map(x=>'<tr><td>'+e(x.label)+'</td><td class="ps-amount">'+peso(x.amount)+'</td></tr>').join("")};
 const earnings=rows("earningRows"),deductions=rows("deductionRows");
 const sum=arr=>arr.reduce((s,x)=>s+Number(x.amount),0);
 const displayDate=date=>{
  const dt=new Date(date+"T00:00:00+08:00");
  return dt.toLocaleDateString("en-US",{month:"2-digit",day:"2-digit",year:"numeric",timeZone:"Asia/Manila"});
 };
 q("#printReport").innerHTML=`<div class="payroll-paper">
  <div class="ps-info"><div><span>Payslip no.</span><strong>${saved.payslip_no}</strong></div><div><span>Employee Name:</span><strong>${e(q("#slipEmployee").value)}</strong></div><div><span>Pay period:</span><strong>${e(q("#slipPeriod").value)}</strong></div><div><span>Pay Date:</span><strong>${e(displayDate(q("#slipDate").value))}</strong></div></div>
  <div class="ps-tables">
  <table><thead><tr><th colspan="2" class="ps-group">Earnings</th></tr><tr><th>Particulars</th><th>Amount</th></tr></thead><tbody>${lineItems(earnings)}</tbody><tfoot><tr><td>Total</td><td class="ps-amount">${peso(sum(earnings))}</td></tr></tfoot></table>
  <table><thead><tr><th colspan="2" class="ps-group">Deductions</th></tr><tr><th>Particulars</th><th>Amount</th></tr></thead><tbody>${lineItems(deductions)}</tbody><tfoot><tr><td>Total</td><td class="ps-amount">${peso(sum(deductions))}</td></tr></tfoot></table></div>
  <div class="ps-net"><span>Net Pay:</span><strong>${peso(sum(earnings)-sum(deductions))}</strong></div>
  <div class="ps-signatures"><div>Employee's Signature</div><div>Employer's Signature</div></div>
  </div>`;
 document.body.classList.add("printing-report","printing-payroll");
 const done=()=>{document.body.classList.remove("printing-report","printing-payroll");window.removeEventListener("afterprint",done);};
 window.addEventListener("afterprint",done);
 setTimeout(()=>window.print(),120);
}
function init(){
 create();
 if(typeof window.adminSectionTitle==="function" && !window.__payrollTitlePatched){
   const originalTitle=window.adminSectionTitle;
   window.adminSectionTitle=section=>section==="payroll"?"Payroll & Attendance":originalTitle(section);
   window.__payrollTitlePatched=true;
 }
 document.addEventListener("click",event=>{
  const payroll=event.target.closest('.side-nav [data-section="payroll"]');
  if(payroll&&token)setTimeout(loadAll,50);
 });
 if(token&&q("#payrollEmployee"))loadAll();
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();
})();
