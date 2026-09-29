let ocrWorkerPromise = null;

const state = {
  category: "Delivery",
  payment: "Cash",
  cart: [],
  usedProducts: [],
  receiptFile: null,
  gcashVerified: false,
  gcashDetectedReference: "",
  ocrInProgress: false,
  ocrPhase: "read",
  receiptPreviewUrl: "",
};

const els = {
  productGrid: document.querySelector("#productGrid"),
  categoryTitle: document.querySelector("#categoryTitle"),
  categoryHint: document.querySelector("#categoryHint"),
  cartItems: document.querySelector("#cartItems"),
  cartEmpty: document.querySelector("#cartEmpty"),
  cartTotal: document.querySelector("#cartTotal"),
  paymentTotal: document.querySelector("#paymentTotal"),
  checkoutBtn: document.querySelector("#checkoutBtn"),
  clearCart: document.querySelector("#clearCart"),
  paymentDialog: document.querySelector("#paymentDialog"),
  closePayment: document.querySelector("#closePayment"),
  cashPanel: document.querySelector("#cashPanel"),
  gcashPanel: document.querySelector("#gcashPanel"),
  confirmPayment: document.querySelector("#confirmPayment"),
  receiptInput: document.querySelector("#receiptInput"),
  receiptPreview: document.querySelector("#receiptPreview"),
  gcashReference: document.querySelector("#gcashReference"),
  gcashRefHelp: document.querySelector("#gcashRefHelp"),
  receiptDrop: document.querySelector("#receiptDrop"),
  ocrStatus: document.querySelector("#ocrStatus"),
  successDialog: document.querySelector("#successDialog"),
  successRef: document.querySelector("#successRef"),
  successTotal: document.querySelector("#successTotal"),
  newOrderBtn: document.querySelector("#newOrderBtn"),
  toast: document.querySelector("#toast"),
};

const money = n => "₱" + Number(n).toLocaleString("en-PH", {maximumFractionDigits:2});
const cartTotal = () => state.cart.reduce((sum,i)=>sum+i.unitPrice*i.qty,0);

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(()=>els.toast.classList.remove("show"),2200);
}

function presets(category) {
  if (category === "Delivery") return [25,35,45].map(p=>({category,label:`Delivery ₱${p}`,unitPrice:p}));
  if (category === "Pick-Up") return [20,30,40].map(p=>({category,label:`Pick-Up ₱${p}`,unitPrice:p}));
  if (category === "New") return [{category,label:"New Gallon",unitPrice:200}];
  return state.usedProducts.map(p=>({category:"Used",productId:p.id,label:p.label,unitPrice:p.price}));
}

function renderProducts() {
  const items = presets(state.category);
  els.categoryHint.textContent = state.category.toUpperCase();
  els.categoryTitle.textContent = state.category === "New" ? "New gallon" : state.category === "Used" ? "Used items" : "Choose a price";
  els.productGrid.classList.toggle("one", items.length === 1);
  if (!items.length) {
    els.productGrid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">No Used prices have been configured yet. Add them from the desktop admin dashboard.</div>`;
    return;
  }
  els.productGrid.innerHTML = items.map((p,i)=>`
    <button class="product-button" data-index="${i}">
      <span class="price">${money(p.unitPrice)}</span>
      <span class="label">${p.label}</span>
    </button>`).join("");
  els.productGrid.querySelectorAll(".product-button").forEach(btn=>{
    btn.addEventListener("click",()=>addToCart(items[Number(btn.dataset.index)]));
  });
}

function keyOf(item) {
  return [item.category,item.productId||"",item.unitPrice].join("|");
}

function addToCart(item) {
  const key = keyOf(item);
  const found = state.cart.find(i=>keyOf(i)===key);
  if (found) found.qty += 1;
  else state.cart.push({...item,qty:1});
  renderCart();
  toast(item.label + " added");
}

function changeQty(index,delta) {
  state.cart[index].qty += delta;
  if (state.cart[index].qty <= 0) state.cart.splice(index,1);
  renderCart();
}

function renderCart() {
  const total = cartTotal();
  els.cartEmpty.classList.toggle("hidden", state.cart.length>0);
  els.cartItems.innerHTML = state.cart.map((i,index)=>`
    <div class="cart-row">
      <div>
        <div class="cart-name">${i.label}</div>
        <div class="cart-meta">${money(i.unitPrice)} each · ${money(i.unitPrice*i.qty)}</div>
      </div>
      <div class="qty-control">
        <button type="button" data-action="minus" data-index="${index}">−</button>
        <strong>${i.qty}</strong>
        <button type="button" data-action="plus" data-index="${index}">＋</button>
      </div>
    </div>`).join("");
  els.cartItems.querySelectorAll("button").forEach(btn=>{
    btn.addEventListener("click",()=>changeQty(Number(btn.dataset.index),btn.dataset.action==="plus"?1:-1));
  });
  els.cartTotal.textContent = money(total);
  els.paymentTotal.textContent = money(total);
  els.checkoutBtn.disabled = !state.cart.length;
}

function digitsOnly(value) {
  return String(value || "").split("").filter(ch => ch >= "0" && ch <= "9").join("");
}

function isSingleDigitCorrection(detected, submitted) {
  if (!detected || !submitted) return false;
  if (detected === submitted) return true;
  if (Math.abs(detected.length - submitted.length) > 1) return false;

  if (detected.length === submitted.length) {
    let differences = 0;
    for (let i = 0; i < detected.length; i++) {
      if (detected[i] !== submitted[i]) differences += 1;
      if (differences > 1) return false;
    }
    return true;
  }

  const shorter = detected.length < submitted.length ? detected : submitted;
  const longer = detected.length < submitted.length ? submitted : detected;
  let i = 0;
  let j = 0;
  let skipped = 0;

  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i += 1;
      j += 1;
    } else {
      skipped += 1;
      j += 1;
      if (skipped > 1) return false;
    }
  }
  return true;
}

function updatePaymentButtonState() {
  if (state.payment === "Cash") {
    els.confirmPayment.disabled = false;
    return;
  }

  const submitted = digitsOnly(els.gcashReference.value);
  const correctionOk =
    submitted.length >= 10 &&
    submitted.length <= 18 &&
    isSingleDigitCorrection(state.gcashDetectedReference, submitted);
  els.confirmPayment.disabled =
    state.ocrInProgress ||
    !state.gcashVerified ||
    !state.receiptFile ||
    !state.gcashDetectedReference ||
    !correctionOk;
}

function setOcrStatus(message,type="") {
  els.ocrStatus.classList.remove("hidden","success","error");
  if (type) els.ocrStatus.classList.add(type);
  els.ocrStatus.textContent = message;
}

async function warmOcr() {
  if (ocrWorkerPromise) return ocrWorkerPromise;
  if (!window.Tesseract) throw new Error("OCR library unavailable");

  ocrWorkerPromise = Tesseract.createWorker("eng", 1, {
    logger:m=>{
      if (!state.ocrInProgress || m.status !== "recognizing text") return;
      const pct = Math.round((m.progress || 0) * 100);
      if (state.ocrPhase === "verify") {
        setOcrStatus(`Verifying the reference number… ${pct}%`);
      } else {
        setOcrStatus(`Reading GCash receipt… ${pct}%`);
      }
    }
  }).then(async worker=>{
    try {
      await worker.setParameters({ tessedit_pageseg_mode: "6" });
    } catch {}
    return worker;
  }).catch(err=>{
    ocrWorkerPromise = null;
    throw err;
  });

  return ocrWorkerPromise;
}

function setPayment(method) {
  state.payment = method;
  document.querySelectorAll(".payment-method").forEach(b=>b.classList.toggle("active",b.dataset.payment===method));
  els.cashPanel.classList.toggle("hidden",method!=="Cash");
  els.gcashPanel.classList.toggle("hidden",method!=="GCash");
  els.confirmPayment.textContent = method === "Cash" ? "Confirm Cash Payment" : "Confirm GCash Payment";
  if (method === "GCash") warmOcr().catch(()=>{});
  updatePaymentButtonState();
}

async function loadImageSource(file) {
  if ("createImageBitmap" in window) {
    return createImageBitmap(file);
  }

  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(file);
    const img=new Image();
    img.onload=()=>{
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror=()=>{
      URL.revokeObjectURL(url);
      reject(new Error("Image could not be opened"));
    };
    img.src=url;
  });
}

function makePreparedCanvas(source,maxWidth=1050,cropTopRatio=0) {
  const sourceWidth=source.width || source.naturalWidth;
  const sourceHeight=source.height || source.naturalHeight;
  const cropY=Math.max(0,Math.floor(sourceHeight*cropTopRatio));
  const cropHeight=Math.max(1,sourceHeight-cropY);
  const scale=Math.min(1,maxWidth/sourceWidth);
  const canvas=document.createElement("canvas");
  canvas.width=Math.max(1,Math.round(sourceWidth*scale));
  canvas.height=Math.max(1,Math.round(cropHeight*scale));

  const ctx=canvas.getContext("2d",{alpha:false});
  ctx.fillStyle="#fff";
  ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.imageSmoothingEnabled=true;
  ctx.imageSmoothingQuality="high";
  if ("filter" in ctx) ctx.filter="grayscale(1) contrast(1.28)";
  ctx.drawImage(source,0,cropY,sourceWidth,cropHeight,0,0,canvas.width,canvas.height);
  if ("filter" in ctx) ctx.filter="none";
  return canvas;
}

function readDigitsAfter(text,startIndex) {
  let digits="";
  let started=false;
  let quietGap=0;
  const end=Math.min(text.length,startIndex+120);

  for(let i=startIndex;i<end;i++){
    const ch=text[i];
    const isDigit=ch>="0" && ch<="9";

    if(isDigit){
      started=true;
      digits+=ch;
      quietGap=0;
      if(digits.length>18) return "";
      continue;
    }

    if(!started) {
      if (ch === "\n" || ch === "\r") continue;
      quietGap += 1;
      if(quietGap>34) break;
      continue;
    }

    if(ch===" " || ch==="-" || ch===":" || ch==="#" || ch==="." || ch==="\n" || ch==="\r"){
      quietGap+=1;
      if(quietGap>10) break;
      continue;
    }

    break;
  }

  return digits.length>=10 && digits.length<=18 ? digits : "";
}

function analyzeGcashReceipt(text) {
  const raw=String(text||"");
  const cleaned=raw.replaceAll("\t"," ");
  const lower=cleaned.toLowerCase();
  const looksLikeGcash=
    lower.includes("gcash") ||
    lower.includes("g cash") ||
    (lower.includes("amount sent") && (lower.includes("ref no") || lower.includes("reference")));

  const labels=["reference number","reference no.","reference no","reference #","ref no.","ref no","ref #","reference"];
  let hasReferenceLabel=false;
  let reference="";

  for(const label of labels){
    const index=lower.indexOf(label);
    if(index<0) continue;
    hasReferenceLabel=true;
    const candidate=readDigitsAfter(cleaned,index+label.length);
    if(candidate && candidate.length>reference.length) reference=candidate;
  }

  return {valid:looksLikeGcash && hasReferenceLabel,looksLikeGcash,hasReferenceLabel,reference};
}

function extractLongNumberCandidates(text) {
  return String(text||"")
    .split(/\n|\r/)
    .map(line=>digitsOnly(line))
    .filter(value=>value.length>=10 && value.length<=18)
    .sort((a,b)=>b.length-a.length);
}

function commonPrefixLength(a,b) {
  let count=0;
  const max=Math.min(a.length,b.length);
  while(count<max && a[count]===b[count]) count+=1;
  return count;
}

function chooseRefinedReference(initial,candidates) {
  if(!candidates.length) return initial || "";
  if(!initial) return candidates[0];

  const related=candidates
    .filter(c=>commonPrefixLength(initial,c)>=Math.min(8,Math.max(4,initial.length-2)))
    .sort((a,b)=>b.length-a.length);

  if(!related.length) return initial;
  const best=related[0];
  return best.length>=initial.length ? best : initial;
}

async function scanReceipt(file) {
  state.receiptFile = file || null;
  state.gcashVerified = false;
  state.gcashDetectedReference = "";
  state.ocrInProgress = true;
  state.ocrPhase = "read";
  els.gcashReference.value = "";
  els.gcashReference.readOnly = true;
  els.gcashRefHelp.textContent = "Scanning the receipt. The reference will unlock only after GCash is verified.";
  updatePaymentButtonState();

  if (!file || !String(file.type || "").startsWith("image/")) {
    state.ocrInProgress = false;
    state.receiptFile = null;
    setOcrStatus("Error: please upload an image of an actual GCash receipt.","error");
    updatePaymentButtonState();
    return;
  }

  if (state.receiptPreviewUrl) URL.revokeObjectURL(state.receiptPreviewUrl);
  state.receiptPreviewUrl=URL.createObjectURL(file);
  els.receiptPreview.src=state.receiptPreviewUrl;
  els.receiptPreview.classList.remove("hidden");
  els.receiptDrop.classList.add("has-file");
  const dropTitle=els.receiptDrop.querySelector("strong");
  if(dropTitle) dropTitle.textContent="Replace GCash receipt";
  setOcrStatus("Preparing receipt scanner…");

  let source=null;
  try {
    const [worker,imageSource]=await Promise.all([warmOcr(),loadImageSource(file)]);
    source=imageSource;

    const fullCanvas=makePreparedCanvas(source,1050,0);
    state.ocrPhase="read";
    const first=await worker.recognize(fullCanvas);
    const analysis=analyzeGcashReceipt(first.data.text || "");

    if(!analysis.valid){
      setOcrStatus("Error: this does not appear to be a readable GCash receipt with a reference number. Upload a clearer GCash receipt or screenshot.","error");
      return;
    }

    let finalReference=analysis.reference;

    state.ocrPhase="verify";
    const lowerCanvas=makePreparedCanvas(source,1300,0.38);
    const second=await worker.recognize(lowerCanvas);
    const candidates=extractLongNumberCandidates(second.data.text || "");
    finalReference=chooseRefinedReference(finalReference,candidates);

    if(!finalReference || finalReference.length<10 || finalReference.length>18){
      setOcrStatus("Error: GCash was detected, but the complete reference number could not be read. Upload a clearer image and try again.","error");
      return;
    }

    state.gcashVerified=true;
    state.gcashDetectedReference=finalReference;
    els.gcashReference.value=finalReference;
    els.gcashReference.readOnly=false;
    els.gcashRefHelp.textContent="Verified from the receipt. If OCR missed or misread one digit, you may correct that one digit before saving.";
    setOcrStatus("GCash receipt verified. Reference checked with a second focused scan.","success");
  } catch {
    setOcrStatus("Error: the receipt could not be read. Please use a clearer GCash receipt or screenshot.","error");
  } finally {
    if(source && typeof source.close==="function") {
      try { source.close(); } catch {}
    }
    state.ocrInProgress=false;
    updatePaymentButtonState();
  }
}

async function submitSale() {
  if (!state.cart.length) return;
  if (state.payment==="GCash" && !state.receiptFile) return toast("Add the GCash receipt image first.");
  if (state.payment==="GCash" && state.ocrInProgress) return toast("Wait for the GCash receipt scan to finish.");
  if (state.payment==="GCash" && !state.gcashVerified) return toast("GCash receipt not verified. Upload a clear receipt with a readable reference number.");
  if (state.payment==="GCash" && !isSingleDigitCorrection(state.gcashDetectedReference,digitsOnly(els.gcashReference.value))) {
    return toast("The edited GCash reference differs too much from the scanned receipt. Re-scan a clearer image.");
  }

  els.confirmPayment.disabled = true;
  els.confirmPayment.textContent = "Saving…";
  const fd = new FormData();
  fd.append("paymentMethod",state.payment);
  fd.append("items",JSON.stringify(state.cart));
  if (state.payment==="GCash") {
    fd.append("gcashReference",digitsOnly(els.gcashReference.value));
    fd.append("gcashDetectedReference",state.gcashDetectedReference);
    fd.append("gcashOcrVerified","true");
    fd.append("receipt",state.receiptFile);
  }
  try {
    const res = await fetch("/api/sales",{method:"POST",body:fd});
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Unable to save transaction.");
    els.paymentDialog.close();
    els.successRef.textContent = data.transactionRef;
    els.successTotal.textContent = money(data.total);
    els.successDialog.showModal();
  } catch(e) {
    toast(e.message);
  } finally {
    els.confirmPayment.textContent = state.payment === "Cash" ? "Confirm Cash Payment" : "Confirm GCash Payment";
    updatePaymentButtonState();
  }
}

function resetOrder() {
  state.cart = [];
  state.receiptFile = null;
  state.gcashVerified = false;
  state.gcashDetectedReference = "";
  state.ocrInProgress = false;
  state.ocrPhase = "read";
  if (state.receiptPreviewUrl) URL.revokeObjectURL(state.receiptPreviewUrl);
  state.receiptPreviewUrl = "";
  els.receiptInput.value = "";
  els.receiptPreview.src = "";
  els.receiptPreview.classList.add("hidden");
  els.ocrStatus.classList.add("hidden");
  els.ocrStatus.classList.remove("success","error");
  els.gcashReference.value = "";
  els.gcashReference.readOnly = true;
  els.gcashRefHelp.textContent = "The field unlocks only after an actual GCash receipt is verified. You may correct one OCR digit if needed.";
  els.receiptDrop.classList.remove("has-file");
  const dropTitle=els.receiptDrop.querySelector("strong");
  if(dropTitle) dropTitle.textContent="Add GCash receipt";
  setPayment("Cash");
  renderCart();
}

document.querySelectorAll(".category-tab").forEach(btn=>{
  btn.addEventListener("click",()=>{
    state.category=btn.dataset.category;
    document.querySelectorAll(".category-tab").forEach(b=>b.classList.toggle("active",b===btn));
    renderProducts();
  });
});
document.querySelectorAll(".payment-method").forEach(btn=>btn.addEventListener("click",()=>setPayment(btn.dataset.payment)));
els.clearCart.addEventListener("click",()=>{state.cart=[];renderCart();});
els.checkoutBtn.addEventListener("click",()=>{
  warmOcr().catch(()=>{});
  els.paymentDialog.showModal();
});
els.closePayment.addEventListener("click",()=>els.paymentDialog.close());
els.receiptInput.addEventListener("change",()=>{if(els.receiptInput.files[0])scanReceipt(els.receiptInput.files[0]);});
els.gcashReference.addEventListener("input",()=>{
  const cleaned=digitsOnly(els.gcashReference.value);
  if(els.gcashReference.value!==cleaned) els.gcashReference.value=cleaned;
  const ok=isSingleDigitCorrection(state.gcashDetectedReference,cleaned);
  els.gcashRefHelp.textContent=ok
    ? "Verified from the receipt. One OCR digit may be corrected if needed."
    : "Only one missed or misread OCR digit can be corrected. For larger differences, upload a clearer receipt.";
  updatePaymentButtonState();
});
els.confirmPayment.addEventListener("click",submitSale);
els.newOrderBtn.addEventListener("click",()=>{els.successDialog.close();resetOrder();});

(async function init(){
  try {
    const res=await fetch("/api/used-products");
    if(res.ok) state.usedProducts=await res.json();
  } catch {}
  renderProducts();
  renderCart();
  const warm=()=>warmOcr().catch(()=>{});
  if("requestIdleCallback" in window) requestIdleCallback(warm,{timeout:2500});
  else setTimeout(warm,1800);
})();
