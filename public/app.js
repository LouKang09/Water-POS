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
  referenceUnreadable: false,
  ocrInProgress: false,
  ocrPhase: "read",
  receiptPreviewUrl: "",
  captureSource: "upload",
  deliveryRoomUnit: "",
  onlineQueue: [],
  unpaidSales: [],
  settlingUnpaidId: null,
  pendingItem: null,
  pendingPickupType: "",
};

const els = {
  productGrid: document.querySelector("#productGrid"),
  roomUnitField: document.querySelector("#roomUnitField"),
  roomUnit: document.querySelector("#roomUnit"),
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
  cameraInput: document.querySelector("#cameraInput"),
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
  onlineQueueBtn: document.querySelector("#onlineQueueBtn"),
  onlineQueueCount: document.querySelector("#onlineQueueCount"),
  onlineQueueDialog: document.querySelector("#onlineQueueDialog"),
  closeOnlineQueue: document.querySelector("#closeOnlineQueue"),
  refreshOnlineQueue: document.querySelector("#refreshOnlineQueue"),
  onlineQueueList: document.querySelector("#onlineQueueList"),
  queueUpdatedText: document.querySelector("#queueUpdatedText"),
  payLaterPanel: document.querySelector("#payLaterPanel"),
  paymentTitle: document.querySelector("#paymentTitle"),
  tapTip: document.querySelector("#tapTip"),
  unpaidCount: document.querySelector("#unpaidCount"),
  successEyebrow: document.querySelector("#successEyebrow"),
  successTitle: document.querySelector("#successTitle"),
  quantityDialog: document.querySelector("#quantityDialog"),
  quantityForm: document.querySelector("#quantityForm"),
  quantityCategory: document.querySelector("#quantityCategory"),
  quantityTitle: document.querySelector("#quantityTitle"),
  quantityInput: document.querySelector("#quantityInput"),
  quantityHelp: document.querySelector("#quantityHelp"),
  pickupTypePanel: document.querySelector("#pickupTypePanel"),
  closeQuantity: document.querySelector("#closeQuantity"),
  addQuantityBtn: document.querySelector("#addQuantityBtn"),
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
  if (category === "Pick-Up") return [5,10,20,30,40].map(p=>({category,label:`Pick-Up ₱${p}`,unitPrice:p}));
  if (category === "New") return [{category,label:"New Gallon",unitPrice:200}];
  return state.usedProducts.map(p=>({category:"Used",productId:p.id,label:p.label,unitPrice:p.price}));
}

function renderDeliveryRoomField() {
  const cartHasDelivery=state.cart.some(item=>item.category==="Delivery");
  const showField=state.category!=="Unpaid" && (state.category==="Delivery" || cartHasDelivery);
  els.roomUnitField.classList.toggle("hidden",!showField);
  els.roomUnit.required=cartHasDelivery && state.category!=="Unpaid";
  els.roomUnitField.classList.toggle("required-field",cartHasDelivery && state.category!=="Unpaid");
}

function renderProducts() {
  const unpaidMode=state.category==="Unpaid";
  document.querySelector(".cart-card")?.classList.toggle("hidden",unpaidMode);
  document.querySelector(".checkout-bar")?.classList.toggle("hidden",unpaidMode);
  els.productGrid.classList.toggle("unpaid-grid",unpaidMode);

  if(unpaidMode){
    renderUnpaidSales();
    renderDeliveryRoomField();
    return;
  }

  const items = presets(state.category);
  els.categoryHint.textContent = state.category.toUpperCase();
  els.categoryTitle.textContent = state.category === "New" ? "New gallon" : state.category === "Used" ? "Used items" : "Choose a price";
  if(els.tapTip) els.tapTip.textContent="Tap to add";
  renderDeliveryRoomField();
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
    btn.addEventListener("click",()=>{
      const item=items[Number(btn.dataset.index)];
      if(item.category==="Delivery" || item.category==="Pick-Up") openQuantityDialog(item);
      else addToCart(item,1);
    });
  });
}

function keyOf(item) {
  return [item.category,item.productId||"",item.variant||"",item.unitPrice].join("|");
}

function addToCart(item,qty=1) {
  const amount=Math.max(1,Math.min(999,parseInt(qty,10)||1));
  const key = keyOf(item);
  const found = state.cart.find(i=>keyOf(i)===key);
  if (found) found.qty += amount;
  else state.cart.push({...item,qty:amount});
  renderCart();
  toast(amount+" × "+item.label+" added");
}

function openQuantityDialog(item) {
  state.pendingItem={...item};
  state.pendingPickupType="";
  const needsType=item.category==="Pick-Up" && (Number(item.unitPrice)===5 || Number(item.unitPrice)===10);

  els.quantityCategory.textContent=item.category.toUpperCase();
  els.quantityTitle.textContent=item.label;
  els.pickupTypePanel.classList.toggle("hidden",!needsType);
  document.querySelectorAll(".pickup-type-option").forEach(button=>button.classList.remove("active"));
  els.quantityInput.value="1";
  els.quantityInput.disabled=needsType;
  els.addQuantityBtn.disabled=needsType;
  els.quantityHelp.textContent=needsType
    ? "Choose Tumbler or Bottled Water first, then enter the quantity."
    : "Enter how many to add to this order.";

  els.quantityDialog.showModal();

  if(!needsType){
    setTimeout(()=>{
      els.quantityInput.focus();
      els.quantityInput.select();
    },80);
  }
}

function choosePickupType(type) {
  if(!state.pendingItem) return;
  state.pendingPickupType=type;
  document.querySelectorAll(".pickup-type-option").forEach(button=>{
    button.classList.toggle("active",button.dataset.pickupType===type);
  });
  els.quantityInput.disabled=false;
  els.addQuantityBtn.disabled=false;
  els.quantityHelp.textContent=type+" selected. Enter the quantity.";
  setTimeout(()=>{
    els.quantityInput.focus();
    els.quantityInput.select();
  },60);
}

function closeQuantityDialog() {
  state.pendingItem=null;
  state.pendingPickupType="";
  els.quantityDialog.close();
}

function submitQuantity(event) {
  event.preventDefault();
  if(!state.pendingItem) return;
  const qty=Math.max(1,Math.min(999,parseInt(els.quantityInput.value,10)||0));
  if(!(qty>0)){
    toast("Enter a valid quantity.");
    els.quantityInput.focus();
    return;
  }

  let item={...state.pendingItem};
  const needsType=item.category==="Pick-Up" && (Number(item.unitPrice)===5 || Number(item.unitPrice)===10);
  if(needsType){
    if(!state.pendingPickupType){
      toast("Choose Tumbler or Bottled Water.");
      return;
    }
    item.variant=state.pendingPickupType;
    item.label=state.pendingPickupType+" · Pick-Up ₱"+item.unitPrice;
  }

  addToCart(item,qty);
  closeQuantityDialog();
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
  renderDeliveryRoomField();
}

function unpaidItemsText(items){
  return (items||[]).map(item=>Number(item.qty)+"× "+item.label).join(" · ");
}

function renderUnpaidSales(){
  els.categoryHint.textContent="UNPAID";
  els.categoryTitle.textContent="Outstanding payments";
  if(els.tapTip) els.tapTip.textContent=state.unpaidSales.length ? state.unpaidSales.length+" unpaid" : "All clear";
  els.productGrid.classList.add("one");

  if(!state.unpaidSales.length){
    els.productGrid.innerHTML='<div class="empty-state unpaid-empty" style="grid-column:1/-1">No unpaid transactions. Pay Later sales will appear here until collected.</div>';
    return;
  }

  els.productGrid.innerHTML=state.unpaidSales.map(sale=>`
    <article class="unpaid-card">
      <div class="unpaid-card-head">
        <div>
          <span class="unpaid-series">${escapeHtml(sale.series || sale.transaction_ref)}</span>
          <strong>${money(sale.total)}</strong>
        </div>
        <span class="unpaid-badge">PAY LATER</span>
      </div>
      <div class="unpaid-items">${escapeHtml(unpaidItemsText(sale.items))}</div>
      <div class="unpaid-meta">
        <span>${sale.delivery_room_unit ? "Room / Unit "+escapeHtml(sale.delivery_room_unit) : "No room / unit"}</span>
        <span>${new Date(sale.created_at).toLocaleString("en-PH",{dateStyle:"medium",timeStyle:"short"})}</span>
      </div>
      <div class="unpaid-card-actions">
        <button type="button" class="primary-button settle-unpaid" data-id="${sale.id}">Settle Payment</button>
        <button type="button" class="unpaid-cancel-button" data-id="${sale.id}">Cancel</button>
      </div>
    </article>
  `).join("");

  els.productGrid.querySelectorAll(".settle-unpaid").forEach(button=>{
    button.addEventListener("click",()=>beginUnpaidSettlement(button.dataset.id));
  });
  els.productGrid.querySelectorAll(".unpaid-cancel-button").forEach(button=>{
    button.addEventListener("click",()=>openCancelUnpaid(button.dataset.id));
  });
}

async function loadUnpaidSales({quiet=false}={}){
  try{
    const res=await fetch("/api/pos/unpaid",{cache:"no-store"});
    const data=await res.json().catch(()=>[]);
    if(!res.ok) throw new Error(data.error||"Unable to load unpaid transactions.");
    state.unpaidSales=Array.isArray(data)?data:[];
    if(els.unpaidCount){
      els.unpaidCount.textContent=String(state.unpaidSales.length);
      els.unpaidCount.classList.toggle("has-items",state.unpaidSales.length>0);
    }
    if(state.category==="Unpaid") renderUnpaidSales();
  }catch(error){
    if(!quiet) toast(error.message);
  }
}

let pendingCancelUnpaidId=null;
function openCancelUnpaid(id){
  const sale=state.unpaidSales.find(row=>String(row.id)===String(id));
  if(!sale) return toast("That unpaid transaction is no longer available.");
  pendingCancelUnpaidId=sale.id;
  document.querySelector("#cancelUnpaidSummary").textContent=
    (sale.series || sale.transaction_ref) + " · " + money(sale.total);
  document.querySelector("#cancelUnpaidReason").value="";
  document.querySelector("#cancelUnpaidError").textContent="";
  document.querySelector("#cancelUnpaidDialog").showModal();
}

function closeCancelUnpaid(){
  pendingCancelUnpaidId=null;
  document.querySelector("#cancelUnpaidDialog").close();
}

async function confirmCancelUnpaid(){
  if(!pendingCancelUnpaidId) return;
  const id=pendingCancelUnpaidId;
  const button=document.querySelector("#confirmCancelUnpaid");
  const errorEl=document.querySelector("#cancelUnpaidError");
  button.disabled=true;
  document.querySelector("#keepUnpaid").disabled=true;
  button.textContent="Cancelling…";
  errorEl.textContent="";
  try{
    const response=await fetch("/api/pos/unpaid/"+id+"/cancel",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({reason:document.querySelector("#cancelUnpaidReason").value.trim()})
    });
    const result=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(result.error||"Unable to cancel this transaction.");
    closeCancelUnpaid();
    await loadUnpaidSales();
    toast("Unpaid transaction cancelled.");
  }catch(error){
    errorEl.textContent=error.message;
    if(/already settled|no longer unpaid|already cancelled/i.test(error.message)) await loadUnpaidSales({quiet:true});
  }finally{
    button.disabled=false;
    document.querySelector("#keepUnpaid").disabled=false;
    button.textContent="Cancel Transaction";
  }
}

document.querySelector("#keepUnpaid").addEventListener("click",closeCancelUnpaid);
document.querySelector("#confirmCancelUnpaid").addEventListener("click",confirmCancelUnpaid);
document.querySelector("#cancelUnpaidDialog").addEventListener("cancel",event=>{
  event.preventDefault();
  if(!document.querySelector("#confirmCancelUnpaid").disabled) closeCancelUnpaid();
});

function beginUnpaidSettlement(id){
  const sale=state.unpaidSales.find(row=>String(row.id)===String(id));
  if(!sale) return toast("That unpaid transaction is no longer available.");

  state.settlingUnpaidId=sale.id;
  clearReceiptScan();
  setPayment("Cash");
  const payLaterButton=document.querySelector('.payment-method[data-payment="Pay Later"]');
  if(payLaterButton) payLaterButton.classList.add("hidden");
  if(els.paymentTitle) els.paymentTitle.textContent="Settle unpaid transaction";
  els.paymentTotal.textContent=money(sale.total);
  els.paymentDialog.showModal();
}

function digitsOnly(value) {
  return String(value || "").split("").filter(ch => ch >= "0" && ch <= "9").join("");
}

function normalizeReference(value,provider=selectedProvider()) {
  const raw=String(value||"").toUpperCase();
  const cleaned=raw
    .split("")
    .filter(ch=>(ch>="A"&&ch<="Z")||(ch>="0"&&ch<="9")||ch==="-")
    .join("")
    .replace(/-+/g,"-")
    .replace(/^-|-$/g,"");
  return provider==="GCash" ? digitsOnly(cleaned) : cleaned;
}

function validReferenceLength(value,provider=selectedProvider()) {
  const ref=normalizeReference(value,provider);
  if(provider==="GCash") return ref.length>=6 && ref.length<=18;
  return ref.length>=6 && ref.length<=40 && /\d{4}/.test(ref);
}

function providerReferenceLabels(provider=selectedProvider()) {
  const shared=["reference number","reference no.","reference no","reference #","ref no.","ref no","ref #","reference"];
  if(provider==="Maya") {
    return ["reference id","ref id","reference id no.","receipt no.","receipt number",...shared];
  }
  if(provider==="MariBank") {
    return ["transaction reference number","transaction reference no.","transaction ref no.","transaction id",...shared];
  }
  if(provider==="GoTyme") {
    return ["transfer reference number","transfer reference no.","transaction reference number","transaction reference no.",...shared];
  }
  if(provider==="VYBE by BPI") {
    return ["trace id","trace id/reference number","transaction reference","confirmation number","acknowledgment number","acknowledgement number",...shared];
  }
  return shared;
}

function providerReferenceHint(provider=selectedProvider()) {
  if(provider==="Maya") return "Reference ID";
  if(provider==="MariBank") return "Transaction Reference Number";
  if(provider==="GoTyme") return "Transfer Reference Number";
  if(provider==="VYBE by BPI") return "Reference Number / Trace ID";
  return "Reference Number";
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
  els.cameraInput.disabled=waitingForProvider;
  els.receiptDrop.classList.toggle("disabled",waitingForProvider);
  els.receiptTitle.textContent=waitingForProvider
    ? "Choose a payment app first"
    : (state.receiptFile ? "Replace "+provider+" receipt" : "Add "+provider+" receipt");
  els.referenceLabel.textContent=provider ? provider+" · "+providerReferenceHint(provider) : "Payment reference";

  if(waitingForProvider){
    els.gcashRefHelp.textContent="Choose Maya, MariBank, GoTyme, or VYBE / BPI before uploading the receipt.";
  } else if(!state.receiptFile){
    els.gcashRefHelp.textContent=provider
      ? 'The scanner looks for '+providerReferenceHint(provider)+' on the receipt.'
      : 'Choose a payment provider first.';
  }

  document.querySelectorAll(".provider-option").forEach(btn=>{
    btn.classList.toggle("active",btn.dataset.provider===state.paymentProvider);
  });
}

function updatePaymentButtonState() {
  if(state.settlingUnpaidId && state.payment==="Pay Later"){
    els.confirmPayment.disabled=true;
    return;
  }
  if (state.payment === "Cash" || state.payment === "Pay Later") {
    els.confirmPayment.disabled = false;
    return;
  }

  if(state.payment==="Other" && !state.paymentProvider){
    els.confirmPayment.disabled=true;
    return;
  }

  if(!state.receiptFile || state.ocrInProgress){
    els.confirmPayment.disabled=true;
    return;
  }

  if(state.referenceUnreadable){
    els.confirmPayment.disabled=false;
    return;
  }

  const submitted = normalizeReference(els.gcashReference.value);
  const correctionOk =
    state.gcashVerified &&
    validReferenceLength(submitted) &&
    isSingleDigitCorrection(state.gcashDetectedReference, submitted);

  els.confirmPayment.disabled=!correctionOk;
}

function setOcrStatus(message,type="") {
  els.ocrStatus.classList.remove("hidden","success","error","warning");
  if (type) els.ocrStatus.classList.add(type);
  els.ocrStatus.textContent = message;
}

function allowUnreadableReceipt(message) {
  state.gcashVerified=false;
  state.gcashDetectedReference="";
  state.referenceUnreadable=true;
  els.gcashReference.value="";
  els.gcashReference.readOnly=true;
  els.gcashRefHelp.textContent="Receipt photo is attached. The reference could not be read, but this payment can still be saved for admin cross-checking.";
  setOcrStatus(message+" Receipt attached — you may continue and it will be marked for review.","warning");
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
  state.referenceUnreadable=false;
  state.ocrInProgress=false;
  state.ocrPhase="reference";
  if(state.receiptPreviewUrl) URL.revokeObjectURL(state.receiptPreviewUrl);
  state.receiptPreviewUrl="";
  els.receiptInput.value="";
  els.cameraInput.value="";
  els.receiptPreview.src="";
  els.receiptPreview.classList.add("hidden");
  els.ocrStatus.classList.add("hidden");
  els.ocrStatus.classList.remove("success","error","warning");
  els.gcashReference.value="";
  els.gcashReference.readOnly=true;
  els.receiptDrop.classList.remove("has-file");
}

function setPayment(method) {
  const changed=state.payment!==method;
  if(changed) clearReceiptScan();

  state.payment = method;
  if(method==="Cash" || method==="Pay Later") state.paymentProvider=null;
  if(method==="GCash") state.paymentProvider="GCash";
  if(method==="Other" && state.paymentProvider==="GCash") state.paymentProvider=null;

  document.querySelectorAll(".payment-method").forEach(b=>b.classList.toggle("active",b.dataset.payment===method));
  els.cashPanel.classList.toggle("hidden",method!=="Cash");
  els.payLaterPanel?.classList.toggle("hidden",method!=="Pay Later");
  els.gcashPanel.classList.toggle("hidden",method==="Cash" || method==="Pay Later");
  els.otherProviderPanel.classList.toggle("hidden",method!=="Other");

  const provider=selectedProvider();
  els.confirmPayment.textContent=method==="Cash"
    ? "Confirm Cash Payment"
    : method==="Pay Later"
      ? "Save as Pay Later"
      : provider
        ? "Confirm "+provider+" Payment"
        : "Choose Payment App";

  updateDigitalCopy();
  if(method==="GCash" || method==="Other") warmOcr().catch(()=>{});
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
  maxWidth=1400,
  cropTopRatio=0,
  cropBottomRatio=1,
  cropLeftRatio=0,
  cropRightRatio=1,
  binary=false,
  enhance=true
) {
  const sourceWidth=source.width || source.naturalWidth;
  const sourceHeight=source.height || source.naturalHeight;
  const cropX=Math.max(0,Math.floor(sourceWidth*cropLeftRatio));
  const cropRight=Math.min(sourceWidth,Math.ceil(sourceWidth*cropRightRatio));
  const cropY=Math.max(0,Math.floor(sourceHeight*cropTopRatio));
  const cropBottom=Math.min(sourceHeight,Math.ceil(sourceHeight*cropBottomRatio));
  const cropWidth=Math.max(1,cropRight-cropX);
  const cropHeight=Math.max(1,cropBottom-cropY);

  // Camera photos are often 3000–5000 px wide. Downscale them before OCR for
  // substantially faster recognition while still upscaling small screenshots.
  const rawScale=maxWidth/cropWidth;
  const scale=Math.max(0.28,Math.min(2.1,rawScale));
  const canvas=document.createElement("canvas");
  canvas.width=Math.max(1,Math.round(cropWidth*scale));
  canvas.height=Math.max(1,Math.round(cropHeight*scale));

  const ctx=canvas.getContext("2d",{alpha:false,willReadFrequently:binary});
  ctx.fillStyle="#fff";
  ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.imageSmoothingEnabled=true;
  ctx.imageSmoothingQuality="high";

  if(enhance && "filter" in ctx){
    ctx.filter=binary
      ? "grayscale(1) contrast(1.25)"
      : "grayscale(1) contrast(1.38) brightness(1.06)";
  }
  ctx.drawImage(source,cropX,cropY,cropWidth,cropHeight,0,0,canvas.width,canvas.height);
  if("filter" in ctx) ctx.filter="none";

  if(binary){
    const image=ctx.getImageData(0,0,canvas.width,canvas.height);
    const data=image.data;
    let sum=0;
    let count=0;
    for(let i=0;i<data.length;i+=16){
      sum+=Math.round(data[i]*0.299+data[i+1]*0.587+data[i+2]*0.114);
      count+=1;
    }
    const average=count?sum/count:210;
    const threshold=Math.max(155,Math.min(222,Math.round(average*0.98)));

    for(let i=0;i<data.length;i+=4){
      const gray=Math.round(data[i]*0.299+data[i+1]*0.587+data[i+2]*0.114);
      const value=gray<threshold?0:255;
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

function normalizeOcrText(value) {
  return String(value||"")
    .toLowerCase()
    .replaceAll("0","o")
    .replaceAll("1","l")
    .replace(/[^a-z0-9#&/\-.\s]/g," ");
}

function labelMatchesText(text,provider=selectedProvider()) {
  const normalized=normalizeOcrText(text);
  const labels=providerReferenceLabels(provider);

  for(const label of labels){
    const target=normalizeOcrText(label).trim();
    if(normalized.includes(target)) return true;
  }

  const tokens=normalized.split(/\s+/).filter(Boolean);
  return tokens.some(token=>{
    if(token.length<6 || token.length>12) return false;
    return editDistance(token,"reference")<=2;
  });
}

function fieldLabelLike(value) {
  const lower=String(value||"").toLowerCase();
  return [
    "recipient","product name","payment id","amount","date & time","date and time",
    "transaction details","completed","purchased on","reference id","reference number"
  ].some(label=>lower.includes(label));
}

function candidatePiecesFromContext(context,provider=selectedProvider()) {
  const upper=String(context||"").toUpperCase();
  const pieces=[];

  // Handles grouped IDs such as Maya: 888D EB7E 6992.
  const grouped=upper.match(/(?:[A-Z0-9]{2,8}[ -]+){1,5}[A-Z0-9]{2,8}/g)||[];
  for(const value of grouped){
    const candidate=normalizeReference(value,provider);
    if(validReferenceLength(candidate,provider)) pieces.push(candidate);
  }

  // Also support compact and hyphenated reference formats.
  const compact=upper.match(/[A-Z0-9][A-Z0-9-]{5,39}/g)||[];
  for(const value of compact){
    const candidate=normalizeReference(value,provider);
    if(validReferenceLength(candidate,provider)) pieces.push(candidate);
  }

  return [...new Set(pieces)];
}

function scoreReferenceCandidate(candidate,provider=selectedProvider()) {
  const value=normalizeReference(candidate,provider);
  let score=0;
  const letters=(value.match(/[A-Z]/g)||[]).length;
  const digits=(value.match(/\d/g)||[]).length;

  if(provider==="Maya"){
    if(value.length===12) score+=100;
    if(letters>0 && digits>0) score+=60;
    if(letters>=2) score+=20;
    if(digits>=6) score+=15;
    if(/^09\d{9}$/.test(value)) score-=200; // recipient/mobile number, never prefer this as Maya Reference ID
  } else {
    score+=Math.min(value.length,30);
    if(letters>0 && digits>0) score+=20;
  }

  return score;
}

function referenceCandidateFromContext(text,provider=selectedProvider()) {
  const lines=String(text||"").split(/\n|\r/).map(line=>line.trim()).filter(Boolean);
  const labels=providerReferenceLabels(provider);

  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    const lower=line.toLowerCase();

    for(const label of labels){
      const pos=lower.indexOf(label.toLowerCase());
      if(pos<0) continue;

      const contexts=[];
      const sameLine=line.slice(pos+label.length).trim();
      if(sameLine) contexts.push(sameLine);

      // OCR sometimes outputs the label column first and the values afterward.
      for(let offset=1;offset<=4;offset++){
        const next=lines[i+offset]||"";
        if(!next) continue;
        if(fieldLabelLike(next) && !/[A-Z0-9]{6,}/i.test(next.replace(/\s/g,""))) continue;
        contexts.push(next);
      }

      const candidates=[];
      for(const context of contexts){
        for(const candidate of candidatePiecesFromContext(context,provider)){
          candidates.push(candidate);
        }
      }

      if(candidates.length){
        candidates.sort((x,y)=>scoreReferenceCandidate(y,provider)-scoreReferenceCandidate(x,provider));
        return candidates[0];
      }
    }
  }

  return "";
}

function containsReferenceLabel(text,provider=selectedProvider()) {
  return labelMatchesText(text,provider);
}

function extractDigitCandidates(text) {
  const candidates=[];
  for(const line of String(text||"").split(/\n|\r/)){
    const digits=digitsOnly(line);
    if(digits.length>=6 && digits.length<=18) candidates.push(digits);
  }
  return [...new Set(candidates)].sort((x,y)=>y.length-x.length);
}

function extractReferenceCandidates(text,provider=selectedProvider()) {
  if(provider==="GCash") return extractDigitCandidates(text);

  const found=candidatePiecesFromContext(text,provider);
  return [...new Set(found)].sort((x,y)=>
    scoreReferenceCandidate(y,provider)-scoreReferenceCandidate(x,provider)
  );
}

function chooseMayaReference(candidates) {
  const clean=[...new Set(candidates.map(value=>normalizeReference(value,"Maya")))]
    .filter(value=>validReferenceLength(value,"Maya"))
    .filter(value=>!/^09\d{9}$/.test(value));

  const alphanumeric=clean.filter(value=>/[A-Z]/.test(value) && /\d/.test(value));
  if(alphanumeric.length){
    alphanumeric.sort((x,y)=>scoreReferenceCandidate(y,"Maya")-scoreReferenceCandidate(x,"Maya"));
    return alphanumeric[0];
  }

  clean.sort((x,y)=>scoreReferenceCandidate(y,"Maya")-scoreReferenceCandidate(x,"Maya"));
  return clean[0]||"";
}

async function setOcrMode(worker,{digitsOnlyMode=false,singleLine=false}={}) {
  const params={
    tessedit_pageseg_mode: singleLine ? "7" : "11",
    preserve_interword_spaces: "1"
  };
  params.tessedit_char_whitelist=digitsOnlyMode
    ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"
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

async function scanReceipt(file,{sourceType="upload"}={}) {
  state.receiptFile=file||null;
  state.gcashVerified=false;
  state.gcashDetectedReference="";
  state.referenceUnreadable=false;
  state.ocrInProgress=true;
  state.ocrPhase="reference";
  state.captureSource=sourceType;
  els.gcashReference.value="";
  els.gcashReference.readOnly=true;

  const provider=selectedProvider();
  els.gcashRefHelp.textContent="Looking for "+providerReferenceHint(provider)+" on the receipt photo.";
  updatePaymentButtonState();

  if(!file || !String(file.type||"").startsWith("image/")){
    state.ocrInProgress=false;
    state.receiptFile=null;
    setOcrStatus("Please capture or upload an image.","error");
    updatePaymentButtonState();
    return;
  }

  if(state.receiptPreviewUrl) URL.revokeObjectURL(state.receiptPreviewUrl);
  state.receiptPreviewUrl=URL.createObjectURL(file);
  els.receiptPreview.src=state.receiptPreviewUrl;
  els.receiptPreview.classList.remove("hidden");
  els.receiptDrop.classList.add("has-file");
  updateDigitalCopy();
  setOcrStatus(sourceType==="camera" ? "Optimizing camera photo…" : "Reading receipt…");

  let imageSource=null;
  try{
    const [worker,loadedImage]=await Promise.all([warmOcr(),loadImageSource(file)]);
    imageSource=loadedImage;

    // Pass 1: one fast, enhanced scan. This is intentionally smaller than the old
    // 1800–2100 px passes so photographed phone screens finish much faster.
    await setOcrMode(worker,{digitsOnlyMode:false,singleLine:false});
    state.ocrPhase="reference";

    const top=provider==="GCash" ? 0.18 : provider==="Maya" ? 0.14 : 0.08;
    const bottom=provider==="GCash" ? 0.82 : provider==="Maya" ? 0.72 : 0.92;
    const quickCanvas=makePreparedCanvas(imageSource,1250,top,bottom,0.02,0.98,false,true);
    const quickResult=await worker.recognize(quickCanvas);
    let text=quickResult.data.text||"";
    let labelFound=containsReferenceLabel(text,provider);
    let preferred=referenceCandidateFromContext(text,provider);

    // Pass 2 only when necessary: high-contrast fallback for glare, moiré, pale labels,
    // or camera photos taken from another phone.
    if(!labelFound || !preferred){
      state.ocrPhase="fallback";
      setOcrStatus("Quick scan incomplete. Enhancing the reference area…");
      const fallbackCanvas=makePreparedCanvas(imageSource,1350,0.06,0.94,0.02,0.98,true,true);
      const fallbackResult=await worker.recognize(fallbackCanvas);
      const fallbackText=fallbackResult.data.text||"";
      labelFound=labelFound || containsReferenceLabel(fallbackText,provider);
      preferred=preferred || referenceCandidateFromContext(fallbackText,provider);
      text+="\n"+fallbackText;
    }

    // If the label is visible but OCR separated the value, do one compact provider-specific
    // value pass instead of rescanning the whole photo several more times.
    if(labelFound && !preferred){
      state.ocrPhase="reference";
      setOcrStatus(providerReferenceHint(provider)+" found. Reading its value…");
      await setOcrMode(worker,{digitsOnlyMode:true,singleLine:false});

      const bands=provider==="Maya"
        ? [
            makePreparedCanvas(imageSource,1450,0.34,0.62,0.28,0.99,true,true),
            makePreparedCanvas(imageSource,1450,0.30,0.68,0.04,0.99,true,true)
          ]
        : provider==="GCash"
          ? [
              makePreparedCanvas(imageSource,1400,0.36,0.72,0.36,0.98,true,true)
            ]
          : [
              makePreparedCanvas(imageSource,1400,0.18,0.88,0.25,0.99,true,true)
            ];

      let candidates=[];
      for(const band of bands){
        const result=await worker.recognize(band);
        const bandText=result.data.text||"";
        const anchored=referenceCandidateFromContext(bandText,provider);
        if(anchored){
          preferred=anchored;
          break;
        }
        candidates=candidates.concat(extractReferenceCandidates(bandText,provider));
      }

      if(!preferred){
        candidates=[...new Set(candidates)].filter(value=>validReferenceLength(value,provider));
        if(provider==="Maya") preferred=chooseMayaReference(candidates);
        else if(provider==="GCash") preferred=candidates.find(value=>value.length===9) || candidates[0] || "";
        else preferred=candidates[0] || "";
      }
    }

    if(preferred && validReferenceLength(preferred,provider)){
      state.gcashVerified=true;
      state.gcashDetectedReference=normalizeReference(preferred,provider);
      state.referenceUnreadable=false;
      els.gcashReference.value=state.gcashDetectedReference;
      els.gcashReference.readOnly=false;
      els.gcashRefHelp.textContent=providerReferenceHint(provider)+" was read from the receipt. You may correct one OCR character if needed.";
      setOcrStatus(providerReferenceHint(provider)+" detected successfully.","success");
    } else if(!labelFound){
      allowUnreadableReceipt(providerReferenceHint(provider)+" could not be detected clearly.");
    } else {
      allowUnreadableReceipt(providerReferenceHint(provider)+" was visible, but its value could not be read reliably.");
    }
  } catch {
    allowUnreadableReceipt("Automatic reading failed.");
  } finally {
    if(imageSource && typeof imageSource.close==="function"){
      try{imageSource.close();}catch{}
    }
    try{
      if(ocrWorkerPromise){
        const worker=await ocrWorkerPromise;
        await setOcrMode(worker,{digitsOnlyMode:false,singleLine:false});
      }
    }catch{}
    state.ocrInProgress=false;
    updatePaymentButtonState();
  }
}

async function submitSale() {
  const settling=Boolean(state.settlingUnpaidId);
  if(!settling && !state.cart.length) return;
  if(settling && state.payment==="Pay Later") return toast("Choose Cash, GCash, or Other to settle this unpaid transaction.");

  const hasDelivery=!settling && state.cart.some(item=>item.category==="Delivery");
  if(hasDelivery && !state.deliveryRoomUnit.trim()){
    els.paymentDialog.close();
    els.roomUnit.focus();
    toast("Room / Unit is required for Delivery.");
    return;
  }

  const isDigital=state.payment==="GCash" || state.payment==="Other";
  const provider=selectedProvider();

  if(state.payment==="Other" && !provider) return toast("Choose a payment app first.");
  if(isDigital && !state.receiptFile) return toast("Attach the "+provider+" receipt photo first.");
  if(isDigital && state.ocrInProgress) return toast("Wait for the receipt scan to finish.");

  if(isDigital && state.gcashVerified){
    if(!isSingleDigitCorrection(state.gcashDetectedReference,normalizeReference(els.gcashReference.value))){
      return toast("The edited reference differs too much from the scanned receipt. Re-scan it or attach the unreadable receipt for review.");
    }
  } else if(isDigital && !state.referenceUnreadable){
    return toast("Attach a receipt image before continuing.");
  }

  els.confirmPayment.disabled=true;
  els.confirmPayment.textContent="Saving…";
  const fd=new FormData();
  fd.append("paymentMethod",state.payment);
  if(!settling){
    fd.append("items",JSON.stringify(state.cart));
    fd.append("roomUnit",state.deliveryRoomUnit.trim());
  }

  if(isDigital){
    fd.append("paymentProvider",provider);
    fd.append("ocrVerified",state.gcashVerified ? "true" : "false");
    if(state.gcashVerified){
      fd.append("paymentReference",normalizeReference(els.gcashReference.value));
      fd.append("detectedReference",state.gcashDetectedReference);
    }
    fd.append("receipt",state.receiptFile);
  }

  try{
    const endpoint=settling ? "/api/pos/unpaid/"+state.settlingUnpaidId+"/settle" : "/api/sales";
    const res=await fetch(endpoint,{method:"POST",body:fd});
    const data=await res.json();
    if(!res.ok) throw new Error(data.error||"Unable to save transaction.");
    els.paymentDialog.close();

    if(settling){
      els.successEyebrow.textContent="UNPAID TRANSACTION SETTLED";
      els.successTitle.textContent="Payment complete";
      state.settlingUnpaidId=null;
      document.querySelector('.payment-method[data-payment="Pay Later"]')?.classList.remove("hidden");
      await loadUnpaidSales({quiet:true});
    }else if(state.payment==="Pay Later"){
      els.successEyebrow.textContent="UNPAID TRANSACTION SAVED";
      els.successTitle.textContent="Payment due later";
      await loadUnpaidSales({quiet:true});
    }else{
      els.successEyebrow.textContent="TRANSACTION SAVED";
      els.successTitle.textContent="Payment complete";
    }

    els.successRef.textContent=data.transactionRef;
    els.successTotal.textContent=money(data.total);
    els.successDialog.showModal();
  }catch(e){
    toast(e.message);
  }finally{
    const currentProvider=selectedProvider();
    els.confirmPayment.textContent=state.payment==="Cash"
      ? "Confirm Cash Payment"
      : state.payment==="Pay Later"
        ? "Save as Pay Later"
        : currentProvider
          ? "Confirm "+currentProvider+" Payment"
          : "Choose Payment App";
    updatePaymentButtonState();
  }
}

function resetOrder() {
  state.settlingUnpaidId=null;
  document.querySelector('.payment-method[data-payment="Pay Later"]')?.classList.remove("hidden");
  if(els.paymentTitle) els.paymentTitle.textContent="Complete transaction";
  state.cart = [];
  clearReceiptScan();
  state.paymentProvider=null;
  state.deliveryRoomUnit="";
  els.roomUnit.value="";
  setPayment("Cash");
  renderCart();
}

function queuePaymentLabel(row){
  if(row.payment_method==="Cash") return "Pending · Cash";
  return "Paid · "+(row.payment_provider||row.payment_method);
}

function queueReferenceLabel(row){
  if(row.payment_method==="Cash") return "Cash upon delivery";
  if(row.payment_reference_status==="unreadable") return "Reference unreadable · receipt attached";
  if(row.payment_reference) return "Ref: "+row.payment_reference;
  return "Receipt attached";
}

function renderOnlineQueue(){
  const rows=state.onlineQueue;
  els.onlineQueueCount.textContent=String(rows.length);
  els.onlineQueueCount.classList.toggle("has-items",rows.length>0);

  if(!rows.length){
    els.onlineQueueList.innerHTML='<div class="empty-state">No online delivery requests.</div>';
    return;
  }

  els.onlineQueueList.innerHTML=rows.map(row=>`
    <article class="online-queue-card">
      <div class="queue-card-top">
        <div>
          <span class="queue-unit">Unit ${escapeHtml(String(row.unit_no))}</span>
          <h3>${escapeHtml(row.tenant_name)}</h3>
          <a href="tel:${escapeHtml(row.tenant_phone)}">${escapeHtml(row.tenant_phone)}</a>
        </div>
        <span class="queue-payment-status ${row.payment_method==="Cash"?"pending":"paid"}">${escapeHtml(queuePaymentLabel(row))}</span>
      </div>
      <div class="queue-order-line">
        <strong>₱${Number(row.unit_price).toLocaleString("en-PH")} × ${Number(row.qty)}</strong>
        <span>${money(row.total)}</span>
      </div>
      <div class="queue-meta-line">
        <span>${escapeHtml(queueReferenceLabel(row))}</span>
        <small>${new Date(row.created_at).toLocaleString("en-PH",{dateStyle:"medium",timeStyle:"short"})}</small>
      </div>
      <div class="queue-card-actions">
        ${row.has_receipt?`<button type="button" class="small-button queue-view-receipt" data-id="${row.id}">View Receipt</button>`:""}
        <button type="button" class="primary-button queue-complete" data-id="${row.id}">
          ${row.payment_method==="Cash"?"Paid Cash & Complete":"Complete Delivery"}
        </button>
      </div>
    </article>
  `).join("");

  document.querySelectorAll(".queue-view-receipt").forEach(btn=>btn.addEventListener("click",()=>{
    window.open("/api/pos/queue/"+btn.dataset.id+"/receipt","_blank","noopener");
  }));

  document.querySelectorAll(".queue-complete").forEach(btn=>btn.addEventListener("click",()=>completeOnlineQueue(btn.dataset.id)));
}

function escapeHtml(value){
  return String(value??"").replace(/[&<>"']/g,ch=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[ch]));
}

async function loadOnlineQueue({quiet=false}={}){
  try{
    const res=await fetch("/api/pos/queue",{cache:"no-store"});
    if(!res.ok) throw new Error("Unable to load queue.");
    state.onlineQueue=await res.json();
    renderOnlineQueue();
    if(els.queueUpdatedText){
      els.queueUpdatedText.textContent="Updated "+new Date().toLocaleTimeString("en-PH",{hour:"numeric",minute:"2-digit"});
    }
  }catch(err){
    if(!quiet) toast(err.message);
  }
}

async function completeOnlineQueue(id){
  const row=state.onlineQueue.find(item=>String(item.id)===String(id));
  if(!row) return;

  const prompt=row.payment_method==="Cash"
    ? "Confirm cash was collected and complete delivery for Unit "+row.unit_no+"?"
    : "Complete delivery for Unit "+row.unit_no+" and record it in Sales?";
  if(!confirm(prompt)) return;

  const button=document.querySelector('.queue-complete[data-id="'+id+'"]');
  if(button){button.disabled=true;button.textContent="Completing…";}

  try{
    const res=await fetch("/api/pos/queue/"+id+"/complete",{method:"POST"});
    const data=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error||"Unable to complete request.");
    toast("Queue completed · "+data.transactionRef);
    await loadOnlineQueue({quiet:true});
  }catch(err){
    toast(err.message);
    if(button){
      button.disabled=false;
      button.textContent=row.payment_method==="Cash"?"Paid Cash & Complete":"Complete Delivery";
    }
  }
}

document.querySelectorAll(".pickup-type-option").forEach(button=>{
  button.addEventListener("click",()=>choosePickupType(button.dataset.pickupType));
});
els.quantityForm.addEventListener("submit",submitQuantity);
els.closeQuantity.addEventListener("click",closeQuantityDialog);
els.quantityDialog.addEventListener("cancel",event=>{
  event.preventDefault();
  closeQuantityDialog();
});
els.quantityInput.addEventListener("input",()=>{
  const value=parseInt(els.quantityInput.value,10);
  els.addQuantityBtn.disabled=!(value>=1 && value<=999) ||
    (state.pendingItem?.category==="Pick-Up" &&
     [5,10].includes(Number(state.pendingItem?.unitPrice)) &&
     !state.pendingPickupType);
});

document.querySelectorAll(".category-tab").forEach(btn=>{
  btn.addEventListener("click",async()=>{
    state.category=btn.dataset.category;
    document.querySelectorAll(".category-tab").forEach(b=>b.classList.toggle("active",b===btn));
    if(state.category==="Unpaid") await loadUnpaidSales({quiet:true});
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
  state.settlingUnpaidId=null;
  document.querySelector('.payment-method[data-payment="Pay Later"]')?.classList.remove("hidden");
  if(els.paymentTitle) els.paymentTitle.textContent="Complete transaction";
  const hasDelivery=state.cart.some(item=>item.category==="Delivery");
  if(hasDelivery && !state.deliveryRoomUnit.trim()){
    els.roomUnit.focus();
    toast("Room / Unit is required for Delivery.");
    return;
  }
  warmOcr().catch(()=>{});
  els.paymentDialog.showModal();
});
els.closePayment.addEventListener("click",()=>{
  els.paymentDialog.close();
  if(state.settlingUnpaidId){
    state.settlingUnpaidId=null;
    document.querySelector('.payment-method[data-payment="Pay Later"]')?.classList.remove("hidden");
    if(els.paymentTitle) els.paymentTitle.textContent="Complete transaction";
    setPayment("Cash");
  }
});
els.cameraInput.addEventListener("change",()=>{if(els.cameraInput.files[0])scanReceipt(els.cameraInput.files[0],{sourceType:"camera"});});
els.receiptInput.addEventListener("change",()=>{if(els.receiptInput.files[0])scanReceipt(els.receiptInput.files[0],{sourceType:"upload"});});
els.roomUnit.addEventListener("input",()=>{state.deliveryRoomUnit=els.roomUnit.value;});
els.gcashReference.addEventListener("input",()=>{
  const cleaned=normalizeReference(els.gcashReference.value);
  if(els.gcashReference.value!==cleaned) els.gcashReference.value=cleaned;
  const ok=validReferenceLength(cleaned) && isSingleDigitCorrection(state.gcashDetectedReference,cleaned);
  els.gcashRefHelp.textContent=ok
    ? providerReferenceHint()+" verified from the receipt. One OCR character may be corrected if needed."
    : "Only one missed or misread OCR character can be corrected. For larger differences, upload a clearer receipt.";
  updatePaymentButtonState();
});
els.confirmPayment.addEventListener("click",submitSale);
els.newOrderBtn.addEventListener("click",()=>{els.successDialog.close();resetOrder();});
els.onlineQueueBtn.addEventListener("click",async()=>{
  els.onlineQueueDialog.showModal();
  await loadOnlineQueue({quiet:true});
});
els.closeOnlineQueue.addEventListener("click",()=>els.onlineQueueDialog.close());
els.refreshOnlineQueue.addEventListener("click",()=>loadOnlineQueue());

(async function init(){
  try {
    const res=await fetch("/api/used-products");
    if(res.ok) state.usedProducts=await res.json();
  } catch {}
  renderProducts();
  renderCart();
  loadOnlineQueue({quiet:true});
  loadUnpaidSales({quiet:true});
  setInterval(()=>{
    loadOnlineQueue({quiet:true});
    loadUnpaidSales({quiet:true});
  },15000);
  const warm=()=>warmOcr().catch(()=>{});
  if("requestIdleCallback" in window) requestIdleCallback(warm,{timeout:2500});
  else setTimeout(warm,1800);
})();
