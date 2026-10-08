const ledgerMoney = value => "₱" + Number(value || 0).toLocaleString("en-PH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const ledgerEscape = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[ch]));
let ledgerSeriesMap = new Map();
let activeLedgerSaleId = null;

function manilaYmd(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function manilaDateTimeLocal(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(value));
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}`;
}

function monthStartYmd() {
  const todayValue = manilaYmd();
  return todayValue.slice(0, 8) + "01";
}

function ensureLedgerAdminUi() {
  const nav = document.querySelector(".side-nav");
  if (nav && !nav.querySelector('[data-section="cashflow"]')) {
    const accountButton = nav.querySelector('[data-section="account"]');
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.section = "cashflow";
    button.textContent = "Cash Flow";
    if (accountButton) nav.insertBefore(button, accountButton);
    else nav.appendChild(button);
  }

  const main = document.querySelector(".admin-main");
  if (main && !document.querySelector("#cashflowSection")) {
    const section = document.createElement("section");
    section.id = "cashflowSection";
    section.className = "admin-section";
    section.innerHTML = `
      <div class="cash-flow-controls">
        <div class="panel cash-flow-settings">
          <h3>Default Petty Cash</h3>
          <p>Used as the starting petty cash for each day unless you enter a one-day override.</p>
          <form id="cashFlowSettingsForm" class="cash-flow-settings-form">
            <label class="field"><span>Default amount</span><input id="defaultPettyCash" type="number" min="0" step="0.01" value="0"></label>
            <button class="primary-button" type="submit">Save</button>
          </form>
        </div>
        <div class="panel cash-flow-entry-panel">
          <h3>Daily Cash Entry</h3>
          <p>Enter the actual cash count and any bank movements for a specific day. Petty cash override is optional.</p>
          <form id="cashFlowEntryForm" class="cash-flow-entry-grid">
            <label class="field"><span>Date</span><input id="cashFlowEntryDate" type="date" required></label>
            <label class="field"><span>Petty Cash Override</span><input id="cashFlowPettyOverride" type="number" min="0" step="0.01" placeholder="Use default"></label>
            <label class="field"><span>Actual</span><input id="cashFlowActual" type="number" min="0" step="0.01" placeholder="Actual cash count"></label>
            <label class="field"><span>Credit to Bank</span><input id="cashFlowCredit" type="number" min="0" step="0.01" value="0"></label>
            <label class="field"><span>Debit from Bank</span><input id="cashFlowDebit" type="number" min="0" step="0.01" value="0"></label>
            <label class="field"><span>Note</span><input id="cashFlowNote" maxlength="500" placeholder="Optional"></label>
            <div class="cash-flow-entry-actions"><button class="primary-button" type="submit">Save Daily Entry</button></div>
          </form>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <div class="panel-header-copy">
            <h2>Cash Flow</h2>
            <p>Daily operating cash flow modeled after your Water Cash Flow tracker.</p>
          </div>
          <div class="cash-flow-range">
            <label><span>From</span><input id="cashFlowFrom" type="date"></label>
            <label><span>To</span><input id="cashFlowTo" type="date"></label>
            <button id="cashFlowView" type="button" class="small-button">View</button>
            <button id="cashFlowPrint" type="button" class="small-button">Print</button>
          </div>
        </div>
        <div class="table-wrap">
          <table class="cash-flow-table">
            <thead><tr>
              <th>Date</th><th>Petty Cash</th><th>Daily Income</th><th>Expenses</th><th>Total</th><th>Actual</th><th>Variance</th>
              <th>Cash</th><th>GCash</th><th>GCash Txns</th><th>Other</th><th>Cash + GCash</th><th>No. Transactions</th>
              <th>Credit to Bank</th><th>Debit from Bank</th><th>Running Bank Total</th><th>Note</th>
            </tr></thead>
            <tbody id="cashFlowBody"><tr><td colspan="17">Loading cash flow…</td></tr></tbody>
          </table>
        </div>
      </div>`;
    main.appendChild(section);
  }

  if (!document.querySelector("#saleEditDialog")) {
    const dialog = document.createElement("dialog");
    dialog.id = "saleEditDialog";
    dialog.className = "sale-edit-dialog";
    dialog.innerHTML = `
      <form id="saleEditForm" class="sale-edit-shell">
        <div class="sale-edit-head">
          <div><p class="eyebrow">ADMIN TRANSACTION EDIT</p><h2>Edit Sale Transaction</h2><div id="saleEditSeries" class="sale-edit-series"></div></div>
          <button id="closeSaleEdit" type="button" class="icon-button">×</button>
        </div>
        <div class="sale-edit-meta">
          <label class="field"><span>Date & Time</span><input id="saleEditDateTime" type="datetime-local" required></label>
          <label class="field"><span>Payment</span><select id="saleEditPayment"><option>Cash</option><option>GCash</option><option value="Other">Other Digital</option></select></label>
          <label id="saleEditProviderWrap" class="field hidden"><span>Provider</span><select id="saleEditProvider"><option>Maya</option><option>MariBank</option><option>GoTyme</option><option>VYBE by BPI</option></select></label>
          <label id="saleEditReferenceWrap" class="field hidden"><span>Payment Reference</span><input id="saleEditReference" maxlength="60"></label>
          <label class="field"><span>Room / Unit</span><input id="saleEditRoom" maxlength="100" placeholder="Optional"></label>
        </div>
        <div class="sale-edit-items">
          <div class="sale-edit-items-head"><strong>Items</strong><button id="addSaleEditItem" type="button" class="small-button">+ Add Item</button></div>
          <div id="saleEditItems"></div>
        </div>
        <div id="saleEditError" class="error-text"></div>
        <div class="sale-edit-footer">
          <div class="sale-edit-total"><span>Total</span><strong id="saleEditTotal">₱0</strong></div>
          <div class="sale-edit-actions"><button id="cancelSaleEdit" type="button" class="small-button">Cancel</button><button id="saveSaleEdit" type="submit" class="primary-button">Save Changes</button></div>
        </div>
      </form>`;
    document.body.appendChild(dialog);
  }

  const salesHead = document.querySelector("#salesSection table thead tr");
  if (salesHead && !salesHead.querySelector('[data-ledger-series="true"]')) {
    const series = document.createElement("th");
    series.dataset.ledgerSeries = "true";
    series.textContent = "Series";
    salesHead.insertBefore(series, salesHead.firstElementChild);
    const edit = document.createElement("th");
    edit.dataset.ledgerEdit = "true";
    edit.textContent = "Edit";
    salesHead.appendChild(edit);
  }

  const manualDefaultsBase = typeof manualDefaults === "function" ? manualDefaults : null;
  if (manualDefaultsBase && !window.__ledgerManualDefaultsPatched) {
    window.__ledgerManualDefaultsPatched = true;
    window.manualDefaults = function(category) {
      if (category === "Other") return { label: "", price: "" };
      return manualDefaultsBase(category);
    };
  }

  document.querySelector("#cashFlowFrom").value ||= monthStartYmd();
  document.querySelector("#cashFlowTo").value ||= manilaYmd();
  document.querySelector("#cashFlowEntryDate").value ||= manilaYmd();
}

function paymentQuantitySummary(sales) {
  const out = {
    Cash: { transactions: 0, qty: 0, amount: 0 },
    GCash: { transactions: 0, qty: 0, amount: 0 },
    Other: { transactions: 0, qty: 0, amount: 0 },
    "Pay Later": { transactions: 0, qty: 0, amount: 0 },
  };
  for (const sale of sales || []) {
    const key = sale.payment_method === "GCash" ? "GCash" : sale.payment_method === "Other" ? "Other" : sale.payment_method === "Pay Later" ? "Pay Later" : "Cash";
    out[key].transactions += 1;
    out[key].amount += Number(sale.total || 0);
    out[key].qty += (sale.items || []).reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
  }
  return out;
}

function paymentAwareServiceBreakdown(sales) {
  const buckets = { Delivery: {}, "Pick-Up": {}, Overall: {} };
  for (const sale of sales || []) {
    const payment = sale.payment_method === "GCash" ? "GCash" : sale.payment_method === "Other" ? "Other" : sale.payment_method === "Pay Later" ? "PayLater" : "Cash";
    for (const item of sale.items || []) {
      if (item.category !== "Delivery" && item.category !== "Pick-Up") continue;
      const price = Number(item.unitPrice);
      const qty = Number(item.qty) || 0;
      const key = String(price);
      for (const bucketName of [item.category, "Overall"]) {
        if (!buckets[bucketName][key]) buckets[bucketName][key] = { total: 0, Cash: 0, GCash: 0, Other: 0, PayLater: 0 };
        buckets[bucketName][key].total += qty;
        buckets[bucketName][key][payment] += qty;
      }
    }
  }
  return buckets;
}

function paymentAwareBreakdownHtml(bucket) {
  const rows = Object.entries(bucket || {}).map(([price, data]) => ({ price: Number(price), ...data })).sort((a,b) => a.price-b.price);
  if (!rows.length) return '<div class="breakdown-empty">No items</div>';
  return rows.map(row => `
    <div class="breakdown-payment-row">
      <strong>₱${row.price.toLocaleString("en-PH")} × ${row.total}</strong>
      <small>Cash ${row.Cash} · GCash ${row.GCash} · Other ${row.Other} · Pay Later ${row.PayLater || 0}</small>
    </div>`).join("");
}

function renderServiceBreakdown(sales) {
  const breakdown = paymentAwareServiceBreakdown(sales);
  document.querySelector("#deliveryBreakdown").innerHTML = paymentAwareBreakdownHtml(breakdown.Delivery);
  document.querySelector("#pickupBreakdown").innerHTML = paymentAwareBreakdownHtml(breakdown["Pick-Up"]);
  document.querySelector("#overallBreakdown").innerHTML = paymentAwareBreakdownHtml(breakdown.Overall);
}

async function refreshSeriesAndEditButtons() {
  if (!token) return;
  try {
    const seriesRows = await api("/api/admin/ledger/series?" + queryDates());
    ledgerSeriesMap = new Map(seriesRows.map(row => [String(row.id), row.series]));
    const trs = [...document.querySelectorAll("#salesBody tr")];
    if (!currentSales.length) {
      const td = trs[0]?.querySelector("td");
      if (td) td.colSpan = 11;
      return;
    }
    currentSales.forEach((sale, index) => {
      const tr = trs[index];
      if (!tr || tr.dataset.ledgerEnhanced === "true") return;
      tr.dataset.ledgerEnhanced = "true";
      const seriesCell = document.createElement("td");
      seriesCell.className = "ledger-series";
      seriesCell.textContent = ledgerSeriesMap.get(String(sale.id)) || "—";
      tr.insertBefore(seriesCell, tr.firstElementChild);
      const editCell = document.createElement("td");
      editCell.innerHTML = `<button type="button" class="small-button ledger-edit-button" data-id="${sale.id}">Edit</button>`;
      tr.appendChild(editCell);
    });
    document.querySelectorAll(".ledger-edit-button").forEach(button => button.addEventListener("click", () => openSaleEdit(button.dataset.id)));
  } catch (error) {
    console.warn("Unable to load sales series", error);
  }
}

const ledgerBaseLoadSales = typeof loadSales === "function" ? loadSales : null;
if (ledgerBaseLoadSales) {
  window.loadSales = async function() {
    await ledgerBaseLoadSales();
    await refreshSeriesAndEditButtons();
  };
}

function saleEditPaymentFields() {
  const method = document.querySelector("#saleEditPayment").value;
  document.querySelector("#saleEditProviderWrap").classList.toggle("hidden", method !== "Other");
  document.querySelector("#saleEditReferenceWrap").classList.toggle("hidden", method === "Cash");
  if (method === "Cash") document.querySelector("#saleEditReference").value = "";
}

function saleEditItemRow(item = {}) {
  const row = document.createElement("div");
  row.className = "sale-edit-item";
  row.innerHTML = `
    <label><span>Category</span><select class="sale-edit-category"><option>Delivery</option><option>Pick-Up</option><option>New</option><option>Used</option><option>Other</option></select></label>
    <label><span>Label</span><input class="sale-edit-label" maxlength="120" required value="${ledgerEscape(item.label || "")}"></label>
    <label><span>Unit Price</span><input class="sale-edit-price" type="number" min="0.01" step="0.01" required value="${Number(item.unitPrice ?? item.unit_price ?? 0) || ""}"></label>
    <label><span>Qty</span><input class="sale-edit-qty" type="number" min="1" max="1000" step="1" required value="${Number(item.qty || 1)}"></label>
    <button type="button" class="sale-edit-remove">×</button>`;
  row.querySelector(".sale-edit-category").value = item.category || "Other";
  row.querySelector(".sale-edit-remove").addEventListener("click", () => {
    if (document.querySelectorAll(".sale-edit-item").length <= 1) return toast("A transaction needs at least one item.");
    row.remove();
    updateSaleEditTotal();
  });
  row.addEventListener("input", updateSaleEditTotal);
  return row;
}

function updateSaleEditTotal() {
  const total = [...document.querySelectorAll(".sale-edit-item")].reduce((sum, row) => {
    return sum + (Number(row.querySelector(".sale-edit-price").value) || 0) * (Number(row.querySelector(".sale-edit-qty").value) || 0);
  }, 0);
  document.querySelector("#saleEditTotal").textContent = ledgerMoney(total);
}

async function openSaleEdit(id) {
  try {
    const sale = await api("/api/admin/ledger/sales/" + id);
    activeLedgerSaleId = Number(id);
    document.querySelector("#saleEditSeries").textContent = `Series ${sale.series} · ${sale.transaction_ref}`;
    document.querySelector("#saleEditDateTime").value = manilaDateTimeLocal(sale.created_at);
    document.querySelector("#saleEditPayment").value = sale.payment_method;
    document.querySelector("#saleEditProvider").value = sale.payment_provider || "Maya";
    document.querySelector("#saleEditReference").value = sale.payment_reference || "";
    document.querySelector("#saleEditRoom").value = sale.delivery_room_unit || "";
    const list = document.querySelector("#saleEditItems");
    list.innerHTML = "";
    (sale.items || []).forEach(item => list.appendChild(saleEditItemRow(item)));
    if (!sale.items?.length) list.appendChild(saleEditItemRow());
    document.querySelector("#saleEditError").textContent = "";
    saleEditPaymentFields();
    updateSaleEditTotal();
    document.querySelector("#saleEditDialog").showModal();
  } catch (error) { toast(error.message); }
}

function collectSaleEditItems() {
  return [...document.querySelectorAll(".sale-edit-item")].map(row => ({
    category: row.querySelector(".sale-edit-category").value,
    label: row.querySelector(".sale-edit-label").value.trim(),
    unitPrice: row.querySelector(".sale-edit-price").value,
    qty: row.querySelector(".sale-edit-qty").value,
  }));
}

async function saveSaleEdit(event) {
  event.preventDefault();
  if (!activeLedgerSaleId) return;
  const button = document.querySelector("#saveSaleEdit");
  const error = document.querySelector("#saleEditError");
  error.textContent = "";
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const method = document.querySelector("#saleEditPayment").value;
    const result = await api("/api/admin/ledger/sales/" + activeLedgerSaleId, {
      method: "PATCH",
      body: {
        dateTime: document.querySelector("#saleEditDateTime").value,
        paymentMethod: method,
        paymentProvider: method === "Other" ? document.querySelector("#saleEditProvider").value : null,
        paymentReference: document.querySelector("#saleEditReference").value.trim(),
        roomUnit: document.querySelector("#saleEditRoom").value.trim(),
        items: collectSaleEditItems(),
      }
    });
    document.querySelector("#saleEditDialog").close();
    activeLedgerSaleId = null;
    toast("Series " + result.series + " updated.");
    await Promise.all([loadSummary(), loadTrend(), loadSales()]);
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
    button.textContent = "Save Changes";
  }
}

async function printSalesReport(period) {
  const range = reportRange(period);
  const qs = "from=" + encodeURIComponent(range.from) + "&to=" + encodeURIComponent(range.to);
  try {
    const [summary, sales, seriesRows] = await Promise.all([
      api("/api/admin/summary?" + qs),
      api("/api/admin/sales?" + qs),
      api("/api/admin/ledger/series?" + qs),
    ]);
    const seriesMap = new Map(seriesRows.map(row => [String(row.id), row.series]));
    const payments = paymentQuantitySummary(sales);
    const breakdown = paymentAwareServiceBreakdown(sales);

    const serviceBox = (title, bucket) => {
      const rows = Object.entries(bucket || {}).map(([price, data]) => ({ price: Number(price), ...data })).sort((a,b) => a.price-b.price);
      return `<div class="print-service-box"><h3>${title}</h3>${rows.length ? rows.map(row => `<div><span>₱${row.price.toLocaleString("en-PH")} × ${row.total}</span><strong>Cash ${row.Cash} · GCash ${row.GCash} · Other ${row.Other} · Pay Later ${row.PayLater || 0}</strong></div>`).join("") : '<div class="print-no-data">No items</div>'}</div>`;
    };

    const paymentRows = ["Cash", "GCash", "Other", "Pay Later"].map(name => {
      const row = payments[name];
      return `<tr><td>${name === "Other" ? "Other Digital" : name}</td><td class="num">${row.transactions}</td><td class="num">${row.qty}</td><td class="num">${ledgerMoney(row.amount)}</td></tr>`;
    }).join("");

    const saleRows = sales.map(sale => `<tr>
      <td>${ledgerEscape(seriesMap.get(String(sale.id)) || "—")}</td>
      <td>${ledgerEscape(fmtDate(sale.created_at))}</td>
      <td>${ledgerEscape(sale.transaction_ref)}</td>
      <td>${ledgerEscape(sale.delivery_room_unit || "—")}</td>
      <td>${(sale.items || []).map(item => `${Number(item.qty)}× ${ledgerEscape(item.label)}`).join("<br>")}</td>
      <td>${ledgerEscape(sale.payment_provider || sale.payment_method)}</td>
      <td class="num">${ledgerMoney(sale.total)}</td>
    </tr>`).join("");

    document.querySelector("#printReport").innerHTML = `<div class="print-report-inner">
      <div class="print-report-head"><div><div class="print-kicker">WATER POS</div><h1>${ledgerEscape(range.label)} Sales Report</h1><p>${displayDate(range.from)}${range.from === range.to ? "" : " – " + displayDate(range.to)}</p></div><div class="print-generated">Printed ${new Date().toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Manila" })}</div></div>
      <div class="print-summary-grid">
        <div><span>Total Sales</span><strong>${ledgerMoney(summary.sales)}</strong></div><div><span>Cash</span><strong>${ledgerMoney(summary.cash)}</strong></div><div><span>GCash</span><strong>${ledgerMoney(summary.gcash)}</strong></div><div><span>Other Digital</span><strong>${ledgerMoney(summary.other)}</strong></div><div><span>Expenses</span><strong>${ledgerMoney(summary.expenses)}</strong></div><div><span>Net</span><strong>${ledgerMoney(summary.net)}</strong></div>
      </div>
      <h2>Payment Mode Quantity</h2>
      <div class="print-payment-breakdown"><table><thead><tr><th>Payment</th><th>Transactions</th><th>Item Qty</th><th>Sales</th></tr></thead><tbody>${paymentRows}</tbody></table></div>
      <h2>Service Quantity Breakdown</h2>
      <div class="print-service-grid">${serviceBox("Delivery", breakdown.Delivery)}${serviceBox("Pick-Up", breakdown["Pick-Up"])}${serviceBox("Overall", breakdown.Overall)}</div>
      <h2>Transactions</h2>
      <table class="print-table"><thead><tr><th>Series</th><th>Date</th><th>Transaction</th><th>Room / Unit</th><th>Items</th><th>Payment</th><th class="num">Total</th></tr></thead><tbody>${saleRows || '<tr><td colspan="7">No sales for this period.</td></tr>'}</tbody></table>
    </div>`;
    document.body.classList.add("printing-report");
    const cleanup = () => document.body.classList.remove("printing-report");
    window.addEventListener("afterprint", cleanup, { once: true });
    setTimeout(() => window.print(), 80);
  } catch (error) { toast(error.message); }
}

function cashFlowVarianceClass(value) {
  if (value == null || Number(value) === 0) return "";
  return Number(value) > 0 ? "variance-positive" : "variance-negative";
}

async function loadCashFlow() {
  if (!token) return;
  const from = document.querySelector("#cashFlowFrom").value || monthStartYmd();
  const to = document.querySelector("#cashFlowTo").value || manilaYmd();
  if (from > to) return toast("Cash Flow From date cannot be after To date.");
  try {
    const data = await api("/api/admin/cash-flow?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to));
    document.querySelector("#defaultPettyCash").value = data.defaultPettyCash;
    const body = document.querySelector("#cashFlowBody");
    body.innerHTML = data.rows.length ? data.rows.map(row => `<tr>
      <td>${ledgerEscape(row.date)}</td><td>${ledgerMoney(row.pettyCash)}</td><td>${ledgerMoney(row.dailyIncome)}</td><td>${ledgerMoney(row.expenses)}</td><td><strong>${ledgerMoney(row.expectedTotal)}</strong></td>
      <td>${row.actual == null ? '<span class="muted-value">—</span>' : ledgerMoney(row.actual)}</td><td class="${cashFlowVarianceClass(row.variance)}">${row.variance == null ? "—" : ledgerMoney(row.variance)}</td>
      <td>${ledgerMoney(row.cash)}</td><td>${ledgerMoney(row.gcash)}</td><td>${row.gcashTxns}</td><td>${ledgerMoney(row.other)}</td><td>${ledgerMoney(row.cashPlusGcash)}</td><td>${row.transactionCount}</td>
      <td>${ledgerMoney(row.creditToBank)}</td><td>${ledgerMoney(row.debitFromBank)}</td><td><strong>${ledgerMoney(row.runningBankTotal)}</strong></td><td class="cash-flow-note" title="${ledgerEscape(row.note)}">${ledgerEscape(row.note || "—")}</td>
    </tr>`).join("") : '<tr><td colspan="17">No cash-flow dates in this range.</td></tr>';
    if (typeof markAdminRefreshed === "function") markAdminRefreshed();
  } catch (error) { toast(error.message); }
}

async function saveCashFlowSettings(event) {
  event.preventDefault();
  try {
    const result = await api("/api/admin/cash-flow/settings", { method: "PATCH", body: { defaultPettyCash: document.querySelector("#defaultPettyCash").value } });
    document.querySelector("#defaultPettyCash").value = result.defaultPettyCash;
    toast("Default petty cash saved.");
    await loadCashFlow();
  } catch (error) { toast(error.message); }
}

async function saveCashFlowEntry(event) {
  event.preventDefault();
  const date = document.querySelector("#cashFlowEntryDate").value;
  try {
    await api("/api/admin/cash-flow/" + encodeURIComponent(date), { method: "PUT", body: {
      pettyCashOverride: document.querySelector("#cashFlowPettyOverride").value,
      actual: document.querySelector("#cashFlowActual").value,
      creditToBank: document.querySelector("#cashFlowCredit").value,
      debitFromBank: document.querySelector("#cashFlowDebit").value,
      note: document.querySelector("#cashFlowNote").value,
    }});
    toast("Cash flow entry saved.");
    await loadCashFlow();
  } catch (error) { toast(error.message); }
}

function printCashFlow() {
  const table = document.querySelector(".cash-flow-table");
  if (!table) return;
  const from = document.querySelector("#cashFlowFrom").value;
  const to = document.querySelector("#cashFlowTo").value;
  document.querySelector("#printReport").innerHTML = `<div class="print-report-inner"><div class="print-report-head"><div><div class="print-kicker">WATER POS</div><h1>Cash Flow</h1><p>${ledgerEscape(from)} – ${ledgerEscape(to)}</p></div></div>${table.outerHTML}</div>`;
  document.body.classList.add("printing-report");
  window.addEventListener("afterprint", () => document.body.classList.remove("printing-report"), { once: true });
  setTimeout(() => window.print(), 80);
}

function bindLedgerUi() {
  ensureLedgerAdminUi();

  const baseTitle = typeof adminSectionTitle === "function" ? adminSectionTitle : null;
  if (baseTitle && !window.__ledgerTitlePatched) {
    window.__ledgerTitlePatched = true;
    window.adminSectionTitle = section => section === "cashflow" ? "Cash Flow" : baseTitle(section);
  }
  const baseRefreshSection = typeof refreshAdminSection === "function" ? refreshAdminSection : null;
  if (baseRefreshSection && !window.__ledgerRefreshPatched) {
    window.__ledgerRefreshPatched = true;
    window.refreshAdminSection = async function(section = adminActiveSection, silent = false) {
      if (section === "cashflow") {
        try { await loadCashFlow(); } catch (error) { if (!silent) toast(error.message); }
        return;
      }
      return baseRefreshSection(section, silent);
    };
  }

  document.querySelector("#cashFlowSettingsForm")?.addEventListener("submit", saveCashFlowSettings);
  document.querySelector("#cashFlowEntryForm")?.addEventListener("submit", saveCashFlowEntry);
  document.querySelector("#cashFlowView")?.addEventListener("click", loadCashFlow);
  document.querySelector("#cashFlowPrint")?.addEventListener("click", printCashFlow);
  document.querySelector('[data-section="cashflow"]')?.addEventListener("click", () => setTimeout(loadCashFlow, 0));

  document.querySelector("#saleEditPayment")?.addEventListener("change", saleEditPaymentFields);
  document.querySelector("#closeSaleEdit")?.addEventListener("click", () => document.querySelector("#saleEditDialog").close());
  document.querySelector("#cancelSaleEdit")?.addEventListener("click", () => document.querySelector("#saleEditDialog").close());
  document.querySelector("#addSaleEditItem")?.addEventListener("click", () => {
    document.querySelector("#saleEditItems").appendChild(saleEditItemRow({ category: "Other", qty: 1 }));
    updateSaleEditTotal();
  });
  document.querySelector("#saleEditForm")?.addEventListener("submit", saveSaleEdit);

  setTimeout(() => {
    if (typeof token !== "undefined" && token && typeof loadSales === "function") loadSales().catch(() => {});
  }, 250);
}

bindLedgerUi();
