const tokenKey="waterpos_admin_token";
let token=sessionStorage.getItem(tokenKey)||"";
const $=s=>document.querySelector(s);
const money=n=>"₱"+Number(n||0).toLocaleString("en-PH",{minimumFractionDigits:0,maximumFractionDigits:2});
const fmtDate=d=>new Date(d).toLocaleString("en-PH",{dateStyle:"medium",timeStyle:"short"});
const today=()=>new Date().toISOString().slice(0,10);

function toast(msg){const el=$("#toast");el.textContent=msg;el.classList.add("show");clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove("show"),2200);}
async function api(url,opts={}){
  opts.headers={...(opts.headers||{}),Authorization:"Bearer "+token};
  if(opts.body && !(opts.body instanceof FormData)){opts.headers["Content-Type"]="application/json";opts.body=JSON.stringify(opts.body);}
  const res=await fetch(url,opts);
  if(res.status===401){logout();throw new Error("Please sign in again.");}
  if(res.status===204)return null;
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(data.error||"Request failed.");
  return data;
}
function showApp(){ $("#loginScreen").classList.toggle("hidden",!!token); }
function logout(){token="";sessionStorage.removeItem(tokenKey);showApp();}
function queryDates(){return "from="+encodeURIComponent($("#fromDate").value||"2000-01-01")+"&to="+encodeURIComponent($("#toDate").value||"2999-12-31");}

async function loadSummary(){
  const d=await api("/api/admin/summary?"+queryDates());
  $("#statSales").textContent=money(d.sales);
  $("#statCash").textContent=money(d.cash);
  $("#statGcash").textContent=money(d.gcash);
  $("#statExpenses").textContent=money(d.expenses);
  $("#statNet").textContent=money(d.net);
  $("#txCount").textContent=d.transactions+" transaction"+(d.transactions===1?"":"s");
}
async function loadSales(){
  const rows=await api("/api/admin/sales");
  $("#salesBody").innerHTML=rows.length?rows.map(r=>`
    <tr>
      <td>${fmtDate(r.created_at)}</td>
      <td><strong>${r.transaction_ref}</strong></td>
      <td>${r.items.map(i=>`${i.qty}× ${i.label}`).join("<br>")}</td>
      <td><span class="badge">${r.payment_method}</span></td>
      <td>${r.gcash_reference||"—"}</td>
      <td><strong>${money(r.total)}</strong></td>
      <td>${r.has_receipt?`<button class="small-button view-receipt" data-id="${r.id}">View</button>`:"—"}</td>
    </tr>`).join(""):`<tr><td colspan="7">No sales yet.</td></tr>`;
  document.querySelectorAll(".view-receipt").forEach(b=>b.addEventListener("click",()=>viewReceipt(b.dataset.id)));
}
async function viewReceipt(id){
  const res=await fetch("/api/admin/receipts/"+id,{headers:{Authorization:"Bearer "+token}});
  if(!res.ok)return toast("Unable to load receipt.");
  const blob=await res.blob();
  $("#receiptImage").src=URL.createObjectURL(blob);
  $("#receiptModal").showModal();
}
async function loadExpenses(){
  const rows=await api("/api/admin/expenses");
  $("#expenseBody").innerHTML=rows.length?rows.map(r=>`
    <tr><td>${String(r.expense_date).slice(0,10)}</td><td><strong>${r.category}</strong></td><td>${r.note||"—"}</td><td>${money(r.amount)}</td><td><button class="danger-button delete-expense" data-id="${r.id}">Delete</button></td></tr>
  `).join(""):`<tr><td colspan="5">No expenses yet.</td></tr>`;
  document.querySelectorAll(".delete-expense").forEach(b=>b.addEventListener("click",async()=>{
    if(!confirm("Delete this expense?"))return;
    await api("/api/admin/expenses/"+b.dataset.id,{method:"DELETE"});
    await Promise.all([loadExpenses(),loadSummary()]);toast("Expense deleted.");
  }));
}
async function loadUsed(){
  const rows=await api("/api/admin/used-products");
  $("#usedList").innerHTML=rows.length?rows.map(r=>`
    <div class="list-row">
      <div><strong>${r.label} · ${money(r.price)}</strong><small>${r.active?"Visible on POS":"Hidden from POS"}</small></div>
      <div class="inline-actions"><button class="small-button toggle-used" data-id="${r.id}" data-active="${r.active}">${r.active?"Hide":"Show"}</button></div>
    </div>`).join(""):`<div class="empty-state">No Used pricing yet. Add the first option above.</div>`;
  document.querySelectorAll(".toggle-used").forEach(b=>b.addEventListener("click",async()=>{
    await api("/api/admin/used-products/"+b.dataset.id,{method:"PATCH",body:{active:b.dataset.active!=="true"}});
    await loadUsed();toast("Used pricing updated.");
  }));
}
async function refreshAll(){await Promise.all([loadSummary(),loadSales(),loadExpenses(),loadUsed()]);}

$("#loginForm").addEventListener("submit",async e=>{
  e.preventDefault();$("#loginError").textContent="";
  try{
    const res=await fetch("/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:$("#loginEmail").value,password:$("#loginPassword").value})});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||"Sign in failed.");
    token=data.token;sessionStorage.setItem(tokenKey,token);showApp();await refreshAll();
  }catch(err){$("#loginError").textContent=err.message;}
});
$("#logoutBtn").addEventListener("click",logout);
$("#applyFilter").addEventListener("click",()=>loadSummary().catch(e=>toast(e.message)));
$("#closeReceipt").addEventListener("click",()=>$("#receiptModal").close());

document.querySelectorAll(".side-nav button").forEach(btn=>btn.addEventListener("click",()=>{
  document.querySelectorAll(".side-nav button").forEach(b=>b.classList.toggle("active",b===btn));
  document.querySelectorAll(".admin-section").forEach(s=>s.classList.remove("active"));
  $("#"+btn.dataset.section+"Section").classList.add("active");
  const titles={sales:"Sales & Dashboard",expenses:"Expenses",used:"Used Pricing"};
  $("#adminTitle").textContent=titles[btn.dataset.section];
  $("#dateFilter").classList.toggle("hidden",btn.dataset.section!=="sales");
}));

$("#expenseForm").addEventListener("submit",async e=>{
  e.preventDefault();
  try{
    await api("/api/admin/expenses",{method:"POST",body:{
      expenseDate:$("#expenseDate").value,category:$("#expenseCategory").value,amount:$("#expenseAmount").value,note:$("#expenseNote").value
    }});
    e.target.reset();$("#expenseDate").value=today();await Promise.all([loadExpenses(),loadSummary()]);toast("Expense added.");
  }catch(err){toast(err.message);}
});
$("#usedForm").addEventListener("submit",async e=>{
  e.preventDefault();
  try{
    await api("/api/admin/used-products",{method:"POST",body:{label:$("#usedLabel").value,price:$("#usedPrice").value}});
    e.target.reset();await loadUsed();toast("Used price added.");
  }catch(err){toast(err.message);}
});

(function init(){
  $("#expenseDate").value=today();
  showApp();
  if(token)refreshAll().catch(()=>logout());
})();
