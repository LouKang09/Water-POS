const state = {
  category: "Delivery",
  payment: "Cash",
  cart: [],
  usedProducts: [],
  receiptFile: null,
  gcashVerified: false,
  gcashDetectedReference: "",
  ocrInProgress: false,
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

function updatePaymentButtonState() {
  if (state.payment === "Cash") {
    els.confirmPayment.disabled = false;
    return;
  }
  els.confirmPayment.disabled = state.ocrInProgress || !state.gcashVerified || !state.receiptFile || !state.gcashDetectedReference;
}

function setOcrStatus(message,type="") {
  els.ocrStatus.classList.remove("hidden","success","error");
  if (type) els.ocrStatus.classList.add(type);
  els.ocrStatus.textContent = message;
}

function setPayment(method) {
  state.payment = method;
  document.querySelectorAll(".payment-method").forEach(b=>b.classList.toggle("active",b.dataset.payment===method));
  els.cashPanel.classList.toggle("hidden",method!=="Cash");
  els.gcashPanel.classList.toggle("hidden",method!=="GCash");
  els.confirmPayment.textContent = method === "Cash" ? "Confirm Cash Payment" : "Confirm GCash Payment";
  updatePaymentButtonState();
}

function readDigitsAfter(text,startIndex) {
  let digits="";
  let started=false;
  let beforeDigits=0;
  let separatorCount=0;
  const end=Math.min(text.length,startIndex+90);

  for(let i=startIndex;i<end;i++){
    const ch=text[i];
    const isDigit=ch>="0" && ch<="9";

    if(isDigit){
      started=true;
      digits+=ch;
      separatorCount=0;
      if(digits.length>18) return "";
      continue;
    }

    if(!started){
      beforeDigits+=1;
      if(beforeDigits>28) break;
      continue;
    }

    if(ch===" " || ch==="-" || ch===":" || ch==="#" || ch==="."){
      separatorCount+=1;
      if(separatorCount>6) break;
      continue;
    }

    break;
  }

  return digits.length>=10 && digits.length<=18 ? digits : "";
}

function analyzeGcashReceipt(text) {
  const cleaned=String(text||"").replaceAll("\n"," ").replaceAll("\r"," ").replaceAll("\t"," ");
  const lower=cleaned.toLowerCase();
  const looksLikeGcash=
    lower.includes("gcash") ||
    lower.includes("g cash") ||
    (lower.includes("amount sent") && lower.includes("sent to") && lower.includes("reference"));

  if(!looksLikeGcash) return {valid:false,reference:""};

  const labels=["reference number","reference no.","reference no","reference #","ref no.","ref no","ref #","reference"];
  for(const label of labels){
    const index=lower.indexOf(label);
    if(index<0) continue;
    const reference=readDigitsAfter(cleaned,index+label.length);
    if(reference) return {valid:true,reference};
  }

  return {valid:false,reference:""};
}

async function scanReceipt(file) {
  state.receiptFile = file || null;
  state.gcashVerified = false;
  state.gcashDetectedReference = "";
  state.ocrInProgress = true;
  els.gcashReference.value = "";
  updatePaymentButtonState();

  if (!file || !String(file.type || "").startsWith("image/")) {
    state.ocrInProgress = false;
    state.receiptFile = null;
    setOcrStatus("Error: please upload an image of the actual GCash receipt.","error");
    updatePaymentButtonState();
    return;
  }

  els.receiptPreview.src = URL.createObjectURL(file);
  els.receiptPreview.classList.remove("hidden");
  setOcrStatus("Reading GCash receipt image…");

  try {
    if (!window.Tesseract) throw new Error("OCR library unavailable");
    const result = await Tesseract.recognize(file,"eng",{
      logger:m=>{
        if(m.status==="recognizing text") {
          setOcrStatus(`Reading GCash receipt… ${Math.round((m.progress||0)*100)}%`);
        }
      }
    });

    const analysis=analyzeGcashReceipt(result.data.text || "");
    if (!analysis.valid) {
      setOcrStatus("Error: no valid GCash reference number could be read from this image. Upload a clear GCash receipt or screenshot. This transaction cannot continue with this image.","error");
      return;
    }

    state.gcashVerified = true;
    state.gcashDetectedReference = analysis.reference;
    els.gcashReference.value = analysis.reference;
    setOcrStatus("GCash receipt verified. Reference number was read directly from the image.","success");
  } catch {
    setOcrStatus("Error: the receipt could not be read. Upload a clearer GCash receipt or screenshot. Manual reference entry is not accepted.","error");
  } finally {
    state.ocrInProgress = false;
    updatePaymentButtonState();
  }
}

async function submitSale() {
  if (!state.cart.length) return;
  if (state.payment==="GCash" && !state.receiptFile) return toast("Add the GCash receipt image first.");
  if (state.payment==="GCash" && state.ocrInProgress) return toast("Wait for the GCash receipt scan to finish.");
  if (state.payment==="GCash" && !state.gcashVerified) return toast("GCash receipt not verified. Upload a clear receipt with a readable reference number.");

  els.confirmPayment.disabled = true;
  els.confirmPayment.textContent = "Saving…";
  const fd = new FormData();
  fd.append("paymentMethod",state.payment);
  fd.append("items",JSON.stringify(state.cart));
  if (state.payment==="GCash") {
    fd.append("gcashReference",state.gcashDetectedReference);
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
  els.receiptInput.value = "";
  els.receiptPreview.src = "";
  els.receiptPreview.classList.add("hidden");
  els.ocrStatus.classList.add("hidden");
  els.ocrStatus.classList.remove("success","error");
  els.gcashReference.value = "";
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
els.checkoutBtn.addEventListener("click",()=>els.paymentDialog.showModal());
els.closePayment.addEventListener("click",()=>els.paymentDialog.close());
els.receiptInput.addEventListener("change",()=>{if(els.receiptInput.files[0])scanReceipt(els.receiptInput.files[0]);});
els.confirmPayment.addEventListener("click",submitSale);
els.newOrderBtn.addEventListener("click",()=>{els.successDialog.close();resetOrder();});

(async function init(){
  try {
    const res=await fetch("/api/used-products");
    if(res.ok) state.usedProducts=await res.json();
  } catch {}
  renderProducts();
  renderCart();
})();
