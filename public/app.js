let ocrWorkerPromise = null;

const state = {
  category: "Delivery",
  payment: "Cash",
  paymentProvider: null,
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
  otherProviderPanel: document.querySelector("#otherProviderPanel"),
  receiptTitle: document.querySelector("#receiptTitle"),
  referenceLabel: document.querySelector("#referenceLabel"),
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

function selectedProvider() {
  if (state.payment === "GCash") return "GCash";
  if (state.payment === "Other") return state.paymentProvider || "";
  return "";
}

function updateDigitalCopy() {
  const provider=selectedProvider();
  const waitingForProvider=state.payment==="Other" && !provider;

  els.receiptInput.disabled=waitingForProvider;
  els.receiptDrop.classList.toggle("disabled",waitingForProvider);
  els.receiptTitle.textContent=waitingForProvider
    ? "Choose a payment app first"
    : (state.receiptFile ? "Replace "+provider+" receipt" : "Add "+provider+" receipt");
  els.referenceLabel.textContent=provider ? provider+" reference" : "Payment reference";

  if(waitingForProvider){
    els.gcashRefHelp.textContent="Choose Maya, MariBank, GoTyme, or VYBE / BPI before uploading the receipt.";
  } else if(!state.receiptFile){
    els.gcashRefHelp.textContent='The scanner finds "Reference" or "Reference Number", then reads only the number beside it.';
  }

  document.querySelectorAll(".provider-option").forEach(btn=>{
    btn.classList.toggle("active",btn.dataset.provider===state.paymentProvider);
  });
}

function updatePaymentButtonState() {
  if (state.payment === "Cash") {
    els.confirmPayment.disabled = false;
    return;
  }

  if(state.payment==="Other" && !state.paymentProvider){
    els.confirmPayment.disabled=true;
    return;
  }

  const submitted = digitsOnly(els.gcashReference.value);
  const correctionOk =
    submitted.length >= 6 &&
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
      if (state.ocrPhase === "fallback") {
        setOcrStatus(`Searching the full image for Reference… ${pct}%`);
      } else {
        setOcrStatus(`Reading the Reference section… ${pct}%`);
      }
    }
  }).then(async worker=>{
    try {
      await worker.setParameters({ tessedit_pageseg_mode: "11" });
    } catch {}
    return worker;
  }).catch(err=>{
    ocrWorkerPromise = null;
    throw err;
  });

  return ocrWorkerPromise;
}

function clearReceiptScan() {
  state.receiptFile=null;
  state.gcashVerified=false;
  state.gcashDetectedReference="";
  state.ocrInProgress=false;
  state.ocrPhase="reference";
  if(state.receiptPreviewUrl) URL.revokeObjectURL(state.receiptPreviewUrl);
  state.receiptPreviewUrl="";
  els.receiptInput.value="";
  els.receiptPreview.src="";
  els.receiptPreview.classList.add("hidden");
  els.ocrStatus.classList.add("hidden");
  els.ocrStatus.classList.remove("success","error");
  els.gcashReference.value="";
  els.gcashReference.readOnly=true;
  els.receiptDrop.classList.remove("has-file");
}

function setPayment(method) {
  const changed=state.payment!==method;
  if(changed) clearReceiptScan();

  state.payment = method;
  if(method==="Cash") state.paymentProvider=null;
  if(method==="GCash") state.paymentProvider="GCash";
  if(method==="Other" && state.paymentProvider==="GCash") state.paymentProvider=null;

  document.querySelectorAll(".payment-method").forEach(b=>b.classList.toggle("active",b.dataset.payment===method));
  els.cashPanel.classList.toggle("hidden",method!=="Cash");
  els.gcashPanel.classList.toggle("hidden",method==="Cash");
  els.otherProviderPanel.classList.toggle("hidden",method!=="Other");

  const provider=selectedProvider();
  els.confirmPayment.textContent=method==="Cash"
    ? "Confirm Cash Payment"
    : provider
      ? "Confirm "+provider+" Payment"
      : "Choose Payment App";

  updateDigitalCopy();
  if(method!=="Cash") warmOcr().catch(()=>{});
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

function makePreparedCanvas(
  source,
  maxWidth=1600,
  cropTopRatio=0,
  cropBottomRatio=1,
  cropLeftRatio=0,
  cropRightRatio=1,
  binary=false
) {
  const sourceWidth=source.width || source.naturalWidth;
  const sourceHeight=source.height || source.naturalHeight;
  const cropX=Math.max(0,Math.floor(sourceWidth*cropLeftRatio));
  const cropRight=Math.min(sourceWidth,Math.ceil(sourceWidth*cropRightRatio));
  const cropY=Math.max(0,Math.floor(sourceHeight*cropTopRatio));
  const cropBottom=Math.min(sourceHeight,Math.ceil(sourceHeight*cropBottomRatio));
  const cropWidth=Math.max(1,cropRight-cropX);
  const cropHeight=Math.max(1,cropBottom-cropY);
  const scale=Math.min(3,Math.max(1,maxWidth/cropWidth));
  const canvas=document.createElement("canvas");
  canvas.width=Math.max(1,Math.round(cropWidth*scale));
  canvas.height=Math.max(1,Math.round(cropHeight*scale));

  const ctx=canvas.getContext("2d",{alpha:false,willReadFrequently:binary});
  ctx.fillStyle="#fff";
  ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.imageSmoothingEnabled=true;
  ctx.imageSmoothingQuality="high";
  ctx.drawImage(source,cropX,cropY,cropWidth,cropHeight,0,0,canvas.width,canvas.height);

  if(binary){
    const image=ctx.getImageData(0,0,canvas.width,canvas.height);
    const data=image.data;
    for(let i=0;i<data.length;i+=4){
      const gray=Math.round(data[i]*0.299+data[i+1]*0.587+data[i+2]*0.114);
      const value=gray<225?0:255;
      data[i]=value;
      data[i+1]=value;
      data[i+2]=value;
      data[i+3]=255;
    }
    ctx.putImageData(image,0,0);
  }

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

  return digits.length>=6 && digits.length<=18 ? digits : "";
}

function editDistance(a,b) {
  const left=String(a||"");
  const right=String(b||"");
  const row=Array.from({length:right.length+1},(_,i)=>i);

  for(let i=1;i<=left.length;i++){
    let previous=row[0];
    row[0]=i;
    for(let j=1;j<=right.length;j++){
      const saved=row[j];
      const cost=left[i-1]===right[j-1]?0:1;
      row[j]=Math.min(row[j]+1,row[j-1]+1,previous+cost);
      previous=saved;
    }
  }
  return row[right.length];
}

function containsReferenceLabel(text) {
  const normalized=String(text||"")
    .toLowerCase()
    .replaceAll("0","o")
    .replaceAll("1","l")
    .replace(/[^a-z\s]/g," ");
  const tokens=normalized.split(/\s+/).filter(Boolean);

  if(normalized.includes("reference") || normalized.includes("ref no") || normalized.includes("ref number")) {
    return true;
  }

  return tokens.some(token=>{
    if(token.length<6 || token.length>11) return false;
    return editDistance(token,"reference")<=2;
  });
}

function extractDigitCandidates(text) {
  const candidates=[];
  for(const line of String(text||"").split(/\n|\r/)){
    const digits=digitsOnly(line);
    if(digits.length>=6 && digits.length<=18) candidates.push(digits);
  }
  return [...new Set(candidates)].sort((x,y)=>y.length-x.length);
}

async function setOcrMode(worker,{digitsOnlyMode=false,singleLine=false}={}) {
  const params={
    tessedit_pageseg_mode: singleLine ? "7" : "11",
    preserve_interword_spaces: "1"
  };
  params.tessedit_char_whitelist=digitsOnlyMode
    ? "0123456789"
    : "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .:#&/-";
  await worker.setParameters(params);
}

function extractLongNumberCandidates(text) {
  return String(text||"")
    .split(/\n|\r/)
    .map(line=>digitsOnly(line))
    .filter(value=>value.length>=6 && value.length<=18)
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
  state.ocrPhase = "reference";
  els.gcashReference.value = "";
  els.gcashReference.readOnly = true;
  els.gcashRefHelp.textContent = 'Looking for the word "Reference", then reading the number beside it.';
  updatePaymentButtonState();

  if (!file || !String(file.type || "").startsWith("image/")) {
    state.ocrInProgress = false;
    state.receiptFile = null;
    setOcrStatus("Error: please upload an image.","error");
    updatePaymentButtonState();
    return;
  }

  if (state.receiptPreviewUrl) URL.revokeObjectURL(state.receiptPreviewUrl);
  state.receiptPreviewUrl=URL.createObjectURL(file);
  els.receiptPreview.src=state.receiptPreviewUrl;
  els.receiptPreview.classList.remove("hidden");
  els.receiptDrop.classList.add("has-file");
  updateDigitalCopy();
  setOcrStatus('Finding "Reference"…');

  let source=null;
  try {
    const [worker,imageSource]=await Promise.all([warmOcr(),loadImageSource(file)]);
    source=imageSource;

    // The label can be very pale blue, so use a binary pass that preserves light text.
    await setOcrMode(worker,{digitsOnlyMode:false,singleLine:false});
    const labelArea=makePreparedCanvas(source,1900,0.38,0.70,0.05,0.95,true);
    const labelResult=await worker.recognize(labelArea);
    let labelFound=containsReferenceLabel(labelResult.data.text || "");

    // Only fall back to a broader binary scan if the focused lower area missed the label.
    if(!labelFound){
      state.ocrPhase="fallback";
      setOcrStatus('Searching the full image for "Reference"…');
      const widerArea=makePreparedCanvas(source,1700,0.18,0.82,0.03,0.97,true);
      const widerResult=await worker.recognize(widerArea);
      labelFound=containsReferenceLabel(widerResult.data.text || "");
    }

    if(!labelFound){
      setOcrStatus('Error: the word "Reference" or "Reference Number" could not be detected. Make sure that label is visible in the image.',"error");
      return;
    }

    // Once Reference is confirmed, ignore all other receipt text and OCR digits only.
    state.ocrPhase="reference";
    setOcrStatus("Reference found. Reading the number…");
    await setOcrMode(worker,{digitsOnlyMode:true,singleLine:false});

    const numberAreas=[
      makePreparedCanvas(source,1800,0.46,0.60,0.48,0.94,true),
      makePreparedCanvas(source,1800,0.52,0.67,0.48,0.94,true),
      makePreparedCanvas(source,1800,0.40,0.68,0.46,0.95,true)
    ];

    let candidates=[];
    for(const area of numberAreas){
      const result=await worker.recognize(area);
      candidates=candidates.concat(extractDigitCandidates(result.data.text || ""));
      const exactNine=candidates.find(value=>value.length===9);
      if(exactNine){
        candidates=[exactNine,...candidates.filter(v=>v!==exactNine)];
        break;
      }
    }

    candidates=[...new Set(candidates)].filter(value=>value.length>=6 && value.length<=18);

    if(!candidates.length){
      setOcrStatus("Reference label found, but the number could not be read. Keep the Reference Number visible and try a clearer screenshot.","error");
      return;
    }

    const preferred=candidates.find(value=>value.length===9) || candidates.sort((x,y)=>y.length-x.length)[0];

    state.gcashVerified=true;
    state.gcashDetectedReference=preferred;
    els.gcashReference.value=preferred;
    els.gcashReference.readOnly=false;
    els.gcashRefHelp.textContent="Reference was read from the image. If OCR misses or misreads one digit, you may correct that one digit.";
    setOcrStatus("Reference Number detected successfully.","success");
  } catch {
    setOcrStatus("Error: the image could not be read. Please try a clearer screenshot.","error");
  } finally {
    if(source && typeof source.close==="function") {
      try { source.close(); } catch {}
    }
    try {
      if(ocrWorkerPromise){
        const worker=await ocrWorkerPromise;
        await setOcrMode(worker,{digitsOnlyMode:false,singleLine:false});
      }
    } catch {}
    state.ocrInProgress=false;
    updatePaymentButtonState();
  }
}

async function submitSale() {
  if (!state.cart.length) return;

  const isDigital=state.payment!=="Cash";
  const provider=selectedProvider();

  if(state.payment==="Other" && !provider) return toast("Choose a payment app first.");
  if(isDigital && !state.receiptFile) return toast("Add the "+provider+" receipt image first.");
  if(isDigital && state.ocrInProgress) return toast("Wait for the receipt scan to finish.");
  if(isDigital && !state.gcashVerified) return toast("Reference not verified. Upload a receipt with a readable Reference Number.");
  if(isDigital && !isSingleDigitCorrection(state.gcashDetectedReference,digitsOnly(els.gcashReference.value))) {
    return toast("The edited reference differs too much from the scanned receipt. Re-scan a clearer image.");
  }

  els.confirmPayment.disabled = true;
  els.confirmPayment.textContent = "Saving…";
  const fd = new FormData();
  fd.append("paymentMethod",state.payment);
  fd.append("items",JSON.stringify(state.cart));

  if(isDigital) {
    fd.append("paymentProvider",provider);
    fd.append("paymentReference",digitsOnly(els.gcashReference.value));
    fd.append("detectedReference",state.gcashDetectedReference);
    fd.append("ocrVerified","true");
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
    const currentProvider=selectedProvider();
    els.confirmPayment.textContent=state.payment==="Cash"
      ? "Confirm Cash Payment"
      : currentProvider
        ? "Confirm "+currentProvider+" Payment"
        : "Choose Payment App";
    updatePaymentButtonState();
  }
}

function resetOrder() {
  state.cart = [];
  clearReceiptScan();
  state.paymentProvider=null;
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
document.querySelectorAll(".provider-option").forEach(btn=>btn.addEventListener("click",()=>{
  if(state.payment!=="Other") return;
  if(state.paymentProvider!==btn.dataset.provider) clearReceiptScan();
  state.paymentProvider=btn.dataset.provider;
  updateDigitalCopy();
  els.confirmPayment.textContent="Confirm "+state.paymentProvider+" Payment";
  warmOcr().catch(()=>{});
  updatePaymentButtonState();
}));
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
    ? "Reference verified from the receipt. One OCR digit may be corrected if needed."
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
