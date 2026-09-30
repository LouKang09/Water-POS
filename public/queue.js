const tokenKey="water_queue_tenant_token";
let tenantToken=localStorage.getItem(tokenKey)||"";
let ocrWorkerPromise=null;

const state={
  account:null,
  price:25,
  qty:1,
  payment:"Cash",
  provider:null,
  receiptFile:null,
  detectedReference:"",
  verified:false,
  unreadable:false,
  previewUrl:""
};

const $=s=>document.querySelector(s);
const money=n=>"₱"+Number(n||0).toLocaleString("en-PH",{maximumFractionDigits:2});

function toast(message){
  const el=$("#queueToast");
  el.textContent=message;
  el.classList.add("show");
  clearTimeout(toast.t);
  toast.t=setTimeout(()=>el.classList.remove("show"),2200);
}

async function api(url,opts={}){
  opts.headers={...(opts.headers||{})};
  if(tenantToken) opts.headers.Authorization="Bearer "+tenantToken;
  if(opts.body && !(opts.body instanceof FormData)){
    opts.headers["Content-Type"]="application/json";
    opts.body=JSON.stringify(opts.body);
  }
  const res=await fetch(url,opts);
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error||"Request failed.");
  return data;
}

async function authRequest(url,body){
  const res=await fetch(url,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify(body)
  });
  const data=await res.json().catch(()=>({}));
  if(!res.ok){
    const err=new Error(data.error||"Unable to continue.");
    err.code=data.code||"";
    throw err;
  }
  return data;
}

function saveSession(result){
  tenantToken=result.token;
  localStorage.setItem(tokenKey,tenantToken);
  state.account=result.account;
  renderAccount();
  updateSummary();
  loadHistory();
}

function clearSession(){
  tenantToken="";
  localStorage.removeItem(tokenKey);
  state.account=null;
  renderAccount();
  showAuthMode("login");
}

function showAuthMode(mode){
  const login=mode==="login";
  const signup=mode==="signup";
  const legacy=mode==="legacy";

  $("#loginForm").classList.toggle("hidden",!login);
  $("#accountForm").classList.toggle("hidden",!signup);
  $("#legacyForm").classList.toggle("hidden",!legacy);
  $("#loginTab").classList.toggle("active",login);
  $("#signupTab").classList.toggle("active",signup);
  $("#loginTab").disabled=legacy;
  $("#signupTab").disabled=legacy;

  if(login){
    $("#authTitle").textContent="Existing User Login";
    $("#authDescription").textContent="Sign in with the phone number and password registered to your tenant account.";
  }else if(signup){
    $("#authTitle").textContent="Create Tenant Account";
    $("#authDescription").textContent="Register your name, phone, unit number, and password to request delivery online.";
  }else{
    $("#authTitle").textContent="Set Password for Existing Preview Account";
    $("#authDescription").textContent="Use this only if your account was created before tenant login was added.";
  }
}

function normalizeReference(value,provider=selectedProvider()){
  const raw=String(value||"").toUpperCase();
  const cleaned=raw.split("").filter(ch=>
    (ch>="A"&&ch<="Z")||(ch>="0"&&ch<="9")||ch==="-"
  ).join("").replace(/-+/g,"-").replace(/^-|-$/g,"");
  return provider==="GCash" ? cleaned.replace(/\D/g,"") : cleaned;
}

function validReference(value,provider=selectedProvider()){
  const ref=normalizeReference(value,provider);
  if(provider==="GCash") return ref.length>=6 && ref.length<=18;
  const digits=(ref.match(/\d/g)||[]).length;
  return ref.length>=6 && ref.length<=40 && digits>=4;
}

function selectedProvider(){
  if(state.payment==="GCash") return "GCash";
  if(state.payment==="Other") return state.provider||"";
  return "";
}

function providerLabels(provider){
  const shared=["reference number","reference no","ref no","reference"];
  if(provider==="Maya") return ["reference id","ref id","receipt no",...shared];
  if(provider==="MariBank") return ["transaction reference number","transaction reference no","transaction id",...shared];
  if(provider==="GoTyme") return ["transfer reference number","transfer reference no","transaction reference number",...shared];
  if(provider==="VYBE by BPI") return ["trace id","transaction reference","confirmation number","acknowledgment number",...shared];
  return shared;
}

function providerHint(provider){
  if(provider==="Maya") return "Reference ID";
  if(provider==="MariBank") return "Transaction Reference Number";
  if(provider==="GoTyme") return "Transfer Reference Number";
  if(provider==="VYBE by BPI") return "Reference Number / Trace ID";
  return "Reference Number";
}

function setStatus(text,type=""){
  const el=$("#queueOcrStatus");
  el.classList.remove("hidden","success","warning","error");
  if(type) el.classList.add(type);
  el.textContent=text;
}

async function warmOcr(){
  if(ocrWorkerPromise) return ocrWorkerPromise;
  if(!window.Tesseract) throw new Error("OCR unavailable");
  ocrWorkerPromise=Tesseract.createWorker("eng",1).then(async worker=>{
    try{await worker.setParameters({tessedit_pageseg_mode:"11",preserve_interword_spaces:"1"});}catch{}
    return worker;
  }).catch(err=>{ocrWorkerPromise=null;throw err;});
  return ocrWorkerPromise;
}

async function imageSource(file){
  if("createImageBitmap" in window) return createImageBitmap(file);
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(file);
    const img=new Image();
    img.onload=()=>{URL.revokeObjectURL(url);resolve(img)};
    img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error("Image error"))};
    img.src=url;
  });
}

function preparedCanvas(source,maxWidth=1250,binary=false){
  const sw=source.width||source.naturalWidth;
  const sh=source.height||source.naturalHeight;
  const scale=Math.max(.25,Math.min(1.8,maxWidth/sw));
  const canvas=document.createElement("canvas");
  canvas.width=Math.max(1,Math.round(sw*scale));
  canvas.height=Math.max(1,Math.round(sh*scale));
  const ctx=canvas.getContext("2d",{alpha:false,willReadFrequently:binary});
  ctx.fillStyle="#fff";ctx.fillRect(0,0,canvas.width,canvas.height);
  if("filter" in ctx) ctx.filter=binary?"grayscale(1) contrast(1.3)":"grayscale(1) contrast(1.35) brightness(1.05)";
  ctx.drawImage(source,0,0,canvas.width,canvas.height);
  if("filter" in ctx) ctx.filter="none";
  if(binary){
    const image=ctx.getImageData(0,0,canvas.width,canvas.height);
    const d=image.data;
    for(let i=0;i<d.length;i+=4){
      const g=d[i]*.299+d[i+1]*.587+d[i+2]*.114;
      const v=g<210?0:255;
      d[i]=d[i+1]=d[i+2]=v;d[i+3]=255;
    }
    ctx.putImageData(image,0,0);
  }
  return canvas;
}

function candidateFromText(text,provider){
  const raw=String(text||"");
  const lower=raw.toLowerCase();
  const labels=providerLabels(provider);
  for(const label of labels){
    let pos=lower.indexOf(label);
    while(pos>=0){
      const after=raw.slice(pos+label.length,pos+label.length+120);
      const groups=after.toUpperCase().match(/(?:[A-Z0-9]{2,8}[ -]+){1,5}[A-Z0-9]{2,8}|[A-Z0-9][A-Z0-9-]{5,39}/g)||[];
      for(const group of groups){
        const ref=normalizeReference(group,provider);
        if(validReference(ref,provider)){
          if(provider==="Maya" && /^09\d{9}$/.test(ref)) continue;
          return ref;
        }
      }
      pos=lower.indexOf(label,pos+label.length);
    }
  }
  return "";
}

async function scanReceipt(file){
  state.receiptFile=file||null;
  state.detectedReference="";
  state.verified=false;
  state.unreadable=false;
  $("#queueReference").value="";
  $("#queueReference").readOnly=true;

  if(!file || !String(file.type||"").startsWith("image/")){
    state.receiptFile=null;
    setStatus("Please attach an image.","error");
    updateSummary();
    return;
  }

  if(state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl=URL.createObjectURL(file);
  $("#queueReceiptPreview").src=state.previewUrl;
  $("#queueReceiptPreview").classList.remove("hidden");
  setStatus("Reading "+providerHint(selectedProvider())+"…");

  let src=null;
  try{
    const [worker,image]=await Promise.all([warmOcr(),imageSource(file)]);
    src=image;
    let result=await worker.recognize(preparedCanvas(src,1200,false));
    let ref=candidateFromText(result.data.text||"",selectedProvider());
    if(!ref){
      setStatus("Enhancing receipt…");
      result=await worker.recognize(preparedCanvas(src,1300,true));
      ref=candidateFromText(result.data.text||"",selectedProvider());
    }
    if(ref){
      state.detectedReference=ref;
      state.verified=true;
      $("#queueReference").value=ref;
      $("#queueReference").readOnly=false;
      setStatus(providerHint(selectedProvider())+" detected.","success");
    }else{
      state.unreadable=true;
      setStatus("Reference could not be read. The attached receipt will still be sent for staff review.","warning");
    }
  }catch{
    state.unreadable=true;
    setStatus("Automatic reading failed. The attached receipt will still be sent for staff review.","warning");
  }finally{
    if(src&&typeof src.close==="function"){try{src.close()}catch{}}
    updateSummary();
  }
}

function clearReceipt(){
  state.receiptFile=null;
  state.detectedReference="";
  state.verified=false;
  state.unreadable=false;
  $("#queueCameraInput").value="";
  $("#queueReceiptInput").value="";
  $("#queueReference").value="";
  $("#queueReference").readOnly=true;
  $("#queueOcrStatus").classList.add("hidden");
  $("#queueReceiptPreview").classList.add("hidden");
  if(state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl="";
}

function renderAccount(){
  const logged=Boolean(state.account);
  $("#accountScreen").classList.toggle("hidden",logged);
  $("#queueApp").classList.toggle("hidden",!logged);
  if(!logged) return;
  $("#tenantDisplayName").textContent=state.account.name;
  $("#tenantDisplayPhone").textContent=state.account.phone;
  $("#tenantUnitBadge").textContent="Unit "+state.account.unit_no;
  $("#deliveryUnitChip").textContent="Unit "+state.account.unit_no;
  $("#summaryUnit").textContent="Unit "+state.account.unit_no;
}

function updateSummary(){
  $("#qtyValue").textContent=state.qty;
  $("#summaryOrder").textContent=money(state.price)+" × "+state.qty;
  $("#summaryTotal").textContent=money(state.price*state.qty);

  let paymentText="Cash · Pending";
  if(state.payment!=="Cash"){
    const provider=selectedProvider();
    if(!provider) paymentText="Choose payment app";
    else if(state.receiptFile) paymentText=provider+" · Paid";
    else paymentText=provider+" · Receipt required";
  }
  $("#summaryPayment").textContent=paymentText;

  const digitalReady=state.payment==="Cash" || (selectedProvider() && state.receiptFile);
  $("#submitRequest").disabled=!digitalReady;
}

function setPayment(method){
  if(state.payment!==method) clearReceipt();
  state.payment=method;
  if(method==="GCash") state.provider="GCash";
  if(method==="Cash") state.provider=null;
  if(method==="Other" && state.provider==="GCash") state.provider=null;

  document.querySelectorAll(".payment-choice").forEach(b=>b.classList.toggle("active",b.dataset.payment===method));
  $("#providerPanel").classList.toggle("hidden",method!=="Other");
  $("#digitalPanel").classList.toggle("hidden",method==="Cash");

  const provider=selectedProvider();
  $("#queueReferenceLabel").textContent=provider ? provider+" · "+providerHint(provider) : "Payment reference";
  $("#queueReferenceHelp").textContent=provider
    ? "The scanner looks for "+providerHint(provider)+". If unreadable, the attached receipt is still accepted."
    : "Choose a payment app first.";
  updateSummary();
}

function historyStatus(row){
  if(row.status==="completed") return "Completed";
  if(row.payment_method==="Cash") return "Pending · Cash";
  return "Paid · "+(row.payment_provider||row.payment_method);
}

function renderHistory(rows){
  const el=$("#requestHistory");
  if(!rows.length){
    el.innerHTML='<div class="empty">No requests yet.</div>';
    return;
  }
  el.innerHTML=rows.map(r=>`
    <article class="history-item">
      <div class="history-top">
        <div>
          <strong>${money(r.unit_price)} × ${r.qty} · Unit ${String(r.unit_no)}</strong>
          <small>${new Date(r.created_at).toLocaleString("en-PH",{dateStyle:"medium",timeStyle:"short"})} · ${money(r.total)}</small>
        </div>
        <span class="status ${r.status==="completed"?"completed":"pending"}">${historyStatus(r)}</span>
      </div>
    </article>`).join("");
}

async function loadHistory(){
  if(!tenantToken) return;
  try{renderHistory(await api("/api/queue/requests"))}catch{}
}

async function submitRequest(){
  if(state.payment==="Other" && !state.provider) return toast("Choose a payment app.");
  if(state.payment!=="Cash" && !state.receiptFile) return toast("Attach the payment receipt.");

  const fd=new FormData();
  fd.append("unitPrice",String(state.price));
  fd.append("qty",String(state.qty));
  fd.append("paymentMethod",state.payment);
  if(state.payment!=="Cash"){
    fd.append("paymentProvider",selectedProvider());
    fd.append("receipt",state.receiptFile);
    fd.append("ocrVerified",state.verified?"true":"false");
    if(state.verified){
      fd.append("detectedReference",state.detectedReference);
      fd.append("paymentReference",normalizeReference($("#queueReference").value));
    }
  }

  const button=$("#submitRequest");
  button.disabled=true;
  button.textContent="Sending request…";
  try{
    await api("/api/queue/requests",{method:"POST",body:fd});
    toast("Delivery request added to the queue.");
    state.qty=1;
    state.price=25;
    document.querySelectorAll(".price-option").forEach(b=>b.classList.toggle("active",b.dataset.price==="25"));
    clearReceipt();
    setPayment("Cash");
    updateSummary();
    await loadHistory();
  }catch(err){
    toast(err.message);
  }finally{
    button.textContent="Request Delivery";
    updateSummary();
  }
}

$("#loginTab").addEventListener("click",()=>showAuthMode("login"));
$("#signupTab").addEventListener("click",()=>showAuthMode("signup"));
$("#showLegacySetup").addEventListener("click",()=>{
  $("#legacyPhone").value=$("#loginPhone").value;
  showAuthMode("legacy");
});
$("#backToLogin").addEventListener("click",()=>showAuthMode("login"));

$("#loginForm").addEventListener("submit",async e=>{
  e.preventDefault();
  $("#loginError").textContent="";
  const button=e.submitter;
  button.disabled=true;
  button.textContent="Logging in…";
  try{
    const result=await authRequest("/api/queue/login",{
      phone:$("#loginPhone").value,
      password:$("#loginPassword").value
    });
    saveSession(result);
    e.target.reset();
  }catch(err){
    if(err.code==="LEGACY_SETUP"){
      $("#legacyPhone").value=$("#loginPhone").value;
      showAuthMode("legacy");
      $("#legacyError").textContent=err.message;
    }else{
      $("#loginError").textContent=err.message;
    }
  }finally{
    button.disabled=false;
    button.textContent="Log In";
  }
});

$("#accountForm").addEventListener("submit",async e=>{
  e.preventDefault();
  $("#accountError").textContent="";
  const password=$("#tenantPassword").value;
  if(password!==$("#tenantPasswordConfirm").value){
    $("#accountError").textContent="Passwords do not match.";
    return;
  }
  const button=e.submitter;
  button.disabled=true;
  button.textContent="Creating account…";
  try{
    const result=await authRequest("/api/queue/account",{
      name:$("#tenantName").value,
      phone:$("#tenantPhone").value,
      unitNo:$("#tenantUnit").value,
      password
    });
    saveSession(result);
    e.target.reset();
  }catch(err){
    $("#accountError").textContent=err.message;
    if(err.code==="LEGACY_ACCOUNT"){
      $("#legacyPhone").value=$("#tenantPhone").value;
      $("#legacyUnit").value=$("#tenantUnit").value;
      showAuthMode("legacy");
      $("#legacyError").textContent=err.message;
    }
  }finally{
    button.disabled=false;
    button.textContent="Create Account";
  }
});

$("#legacyForm").addEventListener("submit",async e=>{
  e.preventDefault();
  $("#legacyError").textContent="";
  const password=$("#legacyPassword").value;
  if(password!==$("#legacyPasswordConfirm").value){
    $("#legacyError").textContent="Passwords do not match.";
    return;
  }
  const button=e.submitter;
  button.disabled=true;
  button.textContent="Setting password…";
  try{
    const result=await authRequest("/api/queue/claim",{
      phone:$("#legacyPhone").value,
      unitNo:$("#legacyUnit").value,
      password
    });
    saveSession(result);
    e.target.reset();
    toast("Password created. You are logged in.");
  }catch(err){
    $("#legacyError").textContent=err.message;
  }finally{
    button.disabled=false;
    button.textContent="Set Password & Log In";
  }
});

$("#changeAccount").addEventListener("click",()=>{
  if(!confirm("Log out of this tenant account?")) return;
  clearSession();
});

document.querySelectorAll(".price-option").forEach(btn=>btn.addEventListener("click",()=>{
  state.price=Number(btn.dataset.price);
  document.querySelectorAll(".price-option").forEach(b=>b.classList.toggle("active",b===btn));
  updateSummary();
}));
$("#qtyMinus").addEventListener("click",()=>{state.qty=Math.max(1,state.qty-1);updateSummary()});
$("#qtyPlus").addEventListener("click",()=>{state.qty=Math.min(100,state.qty+1);updateSummary()});
document.querySelectorAll(".payment-choice").forEach(btn=>btn.addEventListener("click",()=>setPayment(btn.dataset.payment)));
document.querySelectorAll(".provider-option").forEach(btn=>btn.addEventListener("click",()=>{
  if(state.provider!==btn.dataset.provider) clearReceipt();
  state.provider=btn.dataset.provider;
  document.querySelectorAll(".provider-option").forEach(b=>b.classList.toggle("active",b===btn));
  setPayment("Other");
  warmOcr().catch(()=>{});
}));
$("#queueCameraInput").addEventListener("change",()=>{if($("#queueCameraInput").files[0])scanReceipt($("#queueCameraInput").files[0])});
$("#queueReceiptInput").addEventListener("change",()=>{if($("#queueReceiptInput").files[0])scanReceipt($("#queueReceiptInput").files[0])});
$("#queueReference").addEventListener("input",()=>{
  const value=normalizeReference($("#queueReference").value);
  $("#queueReference").value=value;
});
$("#submitRequest").addEventListener("click",submitRequest);
$("#refreshHistory").addEventListener("click",loadHistory);

(async function init(){
  showAuthMode("login");
  renderAccount();
  updateSummary();
  if(!tenantToken) return;
  try{
    state.account=await api("/api/queue/me");
    renderAccount();
    await loadHistory();
  }catch{
    clearSession();
  }
})();