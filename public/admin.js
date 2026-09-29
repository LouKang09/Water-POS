const tokenKey="waterpos_admin_token";
let token=sessionStorage.getItem(tokenKey)||"";
let setupMode=false;
let salesChart=null;
const $=s=>document.querySelector(s);
const money=n=>"₱"+Number(n||0).toLocaleString("en-PH",{minimumFractionDigits:0,maximumFractionDigits:2});
const fmtDate=d=>new Date(d).toLocaleString("en-PH",{dateStyle:"medium",timeStyle:"short",timeZone:"Asia/Manila"});
const toYmd=d=>[
  d.getFullYear(),
  String(d.getMonth()+1).padStart(2,"0"),
  String(d.getDate()).padStart(2,"0")
].join("-");
const today=()=>toYmd(new Date());
const parseYmd=value=>{
  const [y,m,d]=String(value).split("-").map(Number);
  return new Date(y,m-1,d);
};
const shortDate=value=>parseYmd(value).toLocaleDateString("en-PH",{month:"short",day:"numeric"});
const displayDate=value=>parseYmd(value).toLocaleDateString("en-PH",{year:"numeric",month:"short",day:"numeric"});
const escapeHtml=value=>String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[ch]));

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
  $("#statOther").textContent=money(d.other);
  $("#statExpenses").textContent=money(d.expenses);
  $("#statNet").textContent=money(d.net);
  $("#txCount").textContent=d.transactions+" transaction"+(d.transactions===1?"":"s");
}
async function loadTrend(){
  const rows=await api("/api/admin/sales-trend?"+queryDates());
  $("#chartRange").textContent=($("#fromDate").value||"")+" to "+($("#toDate").value||"");
  const canvas=$("#salesTrendChart");
  if(!window.Chart){
    canvas.parentElement.innerHTML='<div class="empty-state">Chart library could not load. Sales data is still available below.</div>';
    return;
  }
  if(salesChart)salesChart.destroy();
  salesChart=new Chart(canvas,{
    type:"line",
    data:{
      labels:rows.map(r=>shortDate(r.date)),
      datasets:[
        {label:"Total Sales",data:rows.map(r=>r.sales),borderWidth:3,pointRadius:4,pointHoverRadius:6,tension:.28},
        {label:"Cash",data:rows.map(r=>r.cash),borderWidth:2,pointRadius:3,pointHoverRadius:5,tension:.28},
        {label:"GCash",data:rows.map(r=>r.gcash),borderWidth:2,pointRadius:3,pointHoverRadius:5,tension:.28},
        {label:"Other Digital",data:rows.map(r=>r.other),borderWidth:2,pointRadius:3,pointHoverRadius:5,tension:.28}
      ]
    },
    options:{
      responsive:true,
      maintainAspectRatio:false,
      interaction:{mode:"index",intersect:false},
      plugins:{
        legend:{position:"top",align:"end"},
        tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+money(ctx.parsed.y)}}
      },
      scales:{
        x:{grid:{display:false},ticks:{maxRotation:0,autoSkip:true,maxTicksLimit:14}},
        y:{beginAtZero:true,ticks:{callback:value=>money(value)}}
      }
    }
  });
}

function serviceQuantityBreakdown(sales){
  const buckets={Delivery:{}, "Pick-Up":{}, Overall:{}};

  for(const sale of sales){
    for(const item of sale.items||[]){
      if(item.category!=="Delivery" && item.category!=="Pick-Up") continue;
      const price=Number(item.unitPrice);
      const qty=Number(item.qty)||0;
      const key=String(price);
      buckets[item.category][key]=(buckets[item.category][key]||0)+qty;
      buckets.Overall[key]=(buckets.Overall[key]||0)+qty;
    }
  }

  return buckets;
}

function breakdownEntries(bucket){
  return Object.entries(bucket)
    .map(([price,qty])=>({price:Number(price),qty:Number(qty)}))
    .sort((x,y)=>x.price-y.price);
}

function breakdownHtml(bucket){
  const rows=breakdownEntries(bucket);
  if(!rows.length) return '<div class="breakdown-empty">No items</div>';
  return rows.map(row=>`<div class="breakdown-line"><span>₱${row.price.toLocaleString("en-PH")}</span><strong>× ${row.qty}</strong></div>`).join("");
}

function renderServiceBreakdown(sales){
  const breakdown=serviceQuantityBreakdown(sales);
  $("#deliveryBreakdown").innerHTML=breakdownHtml(breakdown.Delivery);
  $("#pickupBreakdown").innerHTML=breakdownHtml(breakdown["Pick-Up"]);
  $("#overallBreakdown").innerHTML=breakdownHtml(breakdown.Overall);
}

function paymentReferenceHtml(row){
  if(row.payment_reference_status==="unreadable"){
    return '<span class="badge badge-warning">Unreadable · review receipt</span>';
  }
  return escapeHtml(row.payment_reference||"—");
}

async function loadSales(){
  const rows=await api("/api/admin/sales?"+queryDates());
  renderServiceBreakdown(rows);
  $("#salesBody").innerHTML=rows.length?rows.map(r=>`
    <tr>
      <td>${fmtDate(r.created_at)}</td>
      <td><strong>${escapeHtml(r.transaction_ref)}</strong></td>
      <td>${escapeHtml(r.delivery_room_unit||"—")}</td>
      <td>${r.items.map(i=>`${Number(i.qty)}× ${escapeHtml(i.label)}`).join("<br>")}</td>
      <td><span class="badge">${escapeHtml(r.payment_method)}</span></td>
      <td>${escapeHtml(r.payment_provider||"—")}</td>
      <td>${paymentReferenceHtml(r)}</td>
      <td><strong>${money(r.total)}</strong></td>
      <td>${r.has_receipt?`<button class="small-button view-receipt" data-id="${r.id}">View</button>`:"—"}</td>
    </tr>`).join(""):`<tr><td colspan="9">No sales for this date range.</td></tr>`;
  document.querySelectorAll(".view-receipt").forEach(b=>b.addEventListener("click",()=>viewReceipt(b.dataset.id)));
}
async function viewReceipt(id){
  const res=await fetch("/api/admin/receipts/"+id,{headers:{Authorization:"Bearer "+token}});
  if(!res.ok)return toast("Unable to load receipt.");
  const blob=await res.blob();
  $("#receiptImage").src=URL.createObjectURL(blob);
  $("#receiptModal").showModal();
}

function reportRange(period){
  const anchor=parseYmd($("#toDate").value||$("#fromDate").value||today());
  let from=new Date(anchor);
  let to=new Date(anchor);
  let label="Daily";

  if(period==="week"){
    const mondayOffset=(anchor.getDay()+6)%7;
    from.setDate(anchor.getDate()-mondayOffset);
    to=new Date(from);
    to.setDate(from.getDate()+6);
    label="Weekly";
  } else if(period==="month"){
    from=new Date(anchor.getFullYear(),anchor.getMonth(),1);
    to=new Date(anchor.getFullYear(),anchor.getMonth()+1,0);
    label="Monthly";
  }

  return {from:toYmd(from),to:toYmd(to),label};
}

async function printSalesReport(period){
  const range=reportRange(period);
  const qs="from="+encodeURIComponent(range.from)+"&to="+encodeURIComponent(range.to);

  try{
    const [summary,sales]=await Promise.all([
      api("/api/admin/summary?"+qs),
      api("/api/admin/sales?"+qs)
    ]);

    const serviceBreakdown=serviceQuantityBreakdown(sales);
    const serviceBreakdownTable=(title,bucket)=>{
      const rows=breakdownEntries(bucket);
      return `
        <div class="print-service-box">
          <h3>${title}</h3>
          ${rows.length
            ? rows.map(row=>`<div><span>₱${row.price.toLocaleString("en-PH")}</span><strong>× ${row.qty}</strong></div>`).join("")
            : '<div class="print-no-data">No items</div>'}
        </div>`;
    };

    const providerTotals={};
    for(const sale of sales){
      const provider=sale.payment_provider||sale.payment_method||"Unknown";
      providerTotals[provider]=(providerTotals[provider]||0)+Number(sale.total||0);
    }

    const providerRows=Object.entries(providerTotals)
      .sort((x,y)=>y[1]-x[1])
      .map(([name,total])=>`<tr><td>${escapeHtml(name)}</td><td class="num">${money(total)}</td></tr>`)
      .join("");

    const saleRows=sales.map(r=>`
      <tr>
        <td>${escapeHtml(fmtDate(r.created_at))}</td>
        <td>${escapeHtml(r.transaction_ref)}</td>
        <td>${escapeHtml(r.delivery_room_unit||"—")}</td>
        <td>${r.items.map(i=>`${Number(i.qty)}× ${escapeHtml(i.label)}`).join("<br>")}</td>
        <td>${escapeHtml(r.payment_provider||r.payment_method)}</td>
        <td>${r.payment_reference_status==="unreadable" ? "Unreadable · review receipt" : escapeHtml(r.payment_reference||"—")}</td>
        <td class="num">${money(r.total)}</td>
      </tr>`).join("");

    $("#printReport").innerHTML=`
      <div class="print-report-inner">
        <div class="print-report-head">
          <div>
            <div class="print-kicker">WATER POS</div>
            <h1>${range.label} Sales Report</h1>
            <p>${displayDate(range.from)}${range.from===range.to?"":" – "+displayDate(range.to)}</p>
          </div>
          <div class="print-generated">Printed ${new Date().toLocaleString("en-PH",{dateStyle:"medium",timeStyle:"short",timeZone:"Asia/Manila"})}</div>
        </div>

        <div class="print-summary-grid">
          <div><span>Total Sales</span><strong>${money(summary.sales)}</strong></div>
          <div><span>Cash</span><strong>${money(summary.cash)}</strong></div>
          <div><span>GCash</span><strong>${money(summary.gcash)}</strong></div>
          <div><span>Other Digital</span><strong>${money(summary.other)}</strong></div>
          <div><span>Expenses</span><strong>${money(summary.expenses)}</strong></div>
          <div><span>Net</span><strong>${money(summary.net)}</strong></div>
        </div>

        <h2>Service Quantity Breakdown</h2>
        <div class="print-service-grid">
          ${serviceBreakdownTable("Delivery",serviceBreakdown.Delivery)}
          ${serviceBreakdownTable("Pick-Up",serviceBreakdown["Pick-Up"])}
          ${serviceBreakdownTable("Overall",serviceBreakdown.Overall)}
        </div>

        <h2>Payment Breakdown</h2>
        <table class="print-table compact">
          <thead><tr><th>Payment Provider</th><th class="num">Sales</th></tr></thead>
          <tbody>${providerRows||'<tr><td colspan="2">No sales.</td></tr>'}</tbody>
        </table>

        <h2>Transactions</h2>
        <table class="print-table">
          <thead><tr><th>Date</th><th>Transaction</th><th>Room / Unit</th><th>Items</th><th>Payment</th><th>Reference</th><th class="num">Total</th></tr></thead>
          <tbody>${saleRows||'<tr><td colspan="7">No sales for this period.</td></tr>'}</tbody>
        </table>
      </div>`;

    document.body.classList.add("printing-report");
    const cleanup=()=>document.body.classList.remove("printing-report");
    window.addEventListener("afterprint",cleanup,{once:true});
    setTimeout(()=>window.print(),80);
  }catch(err){
    toast(err.message);
  }
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
async function refreshAll(){await Promise.all([loadSummary(),loadTrend(),loadSales(),loadExpenses(),loadUsed()]);}

$("#loginForm").addEventListener("submit",async e=>{
  e.preventDefault();$("#loginError").textContent="";
  try{
    const endpoint=setupMode?"/api/admin/setup":"/api/admin/login";
    const res=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:$("#loginEmail").value,password:$("#loginPassword").value})});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||(setupMode?"Setup failed.":"Sign in failed."));
    token=data.token;sessionStorage.setItem(tokenKey,token);setupMode=false;showApp();await refreshAll();
  }catch(err){$("#loginError").textContent=err.message;}
});
$("#logoutBtn").addEventListener("click",logout);
$("#todayFilter").addEventListener("click",async()=>{
  const d=today();
  $("#fromDate").value=d;
  $("#toDate").value=d;
  try{await Promise.all([loadSummary(),loadTrend(),loadSales()]);}catch(e){toast(e.message);}
});
$("#applyFilter").addEventListener("click",async()=>{
  try{
    if($("#fromDate").value && $("#toDate").value && $("#fromDate").value>$("#toDate").value){
      return toast("From date cannot be after To date.");
    }
    await Promise.all([loadSummary(),loadTrend(),loadSales()]);
  }catch(e){toast(e.message);}
});
$("#closeReceipt").addEventListener("click",()=>$("#receiptModal").close());
document.querySelectorAll(".print-report-btn").forEach(btn=>{
  btn.addEventListener("click",()=>printSalesReport(btn.dataset.period));
});

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

(async function init(){
  $("#expenseDate").value=today();
  $("#fromDate").value=today();
  $("#toDate").value=today();
  showApp();
  if(token){refreshAll().catch(()=>logout());return;}
  try{
    const res=await fetch("/api/admin/setup-status");
    const data=await res.json();
    setupMode=Boolean(data.needsSetup);
    if(setupMode){
      document.querySelector("#loginScreen h1").textContent="Create Admin Account";
      document.querySelector("#loginForm .primary-button").textContent="Create Admin Account";
      $("#loginPassword").setAttribute("autocomplete","new-password");
    }
  }catch{}
})();
