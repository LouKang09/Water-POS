const ledgerMoney = value => "₱" + Number(value || 0).toLocaleString("en-PH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const ledgerEscape = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[ch]));
let ledgerSeriesMap = new Map();
let ledgerEditCountMap = new Map();
let ledgerSalesFilter = "all";
let ledgerSalesDateMode = "main";
let ledgerSelectedSaleIds = new Set();
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
          <label class="field"><span>Payment</span><select id="saleEditPayment"><option>Cash</option><option>GCash</option><option value="Other">Other Digital</option><option value="Pay Later">Pay Later</option></select></label>
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

  if (!document.querySelector("#saleHistoryDialog")) {
    const dialog = document.createElement("dialog");
    dialog.id = "saleHistoryDialog";
    dialog.className = "sale-edit-dialog sale-history-dialog";
    dialog.innerHTML = `
      <div class="sale-edit-shell">
        <div class="sale-edit-head">
          <div>
            <p class="eyebrow">TRANSACTION FOOTPRINT</p>
            <h2>Sale Edit History</h2>
            <div id="saleHistorySeries" class="sale-edit-series"></div>
          </div>
          <button id="closeSaleHistory" type="button" class="icon-button">×</button>
        </div>
        <div id="saleHistoryBody" class="sale-history-body">
          <div class="empty-state">Loading history…</div>
        </div>
      </div>`;
    document.body.appendChild(dialog);
  }

  const salesBody = document.querySelector("#salesBody");
  const salesTableWrap = salesBody?.closest(".table-wrap");
  if (salesTableWrap && !document.querySelector("#salesTransactionFilters")) {
    const filters = document.createElement("div");
    filters.id = "salesTransactionFilters";
    filters.className = "sales-transaction-filters";
    filters.innerHTML = `
      <div class="sales-mini-date-filter">
        <div class="sales-mini-date-copy">
          <strong>Transactions date</strong>
          <small>Independent from the main dashboard date filter.</small>
        </div>
        <div class="sales-mini-date-modes" role="group" aria-label="Sales transaction date mode">
          <button type="button" class="sales-date-mode active" data-sales-date-mode="main">Main Range</button>
          <button type="button" class="sales-date-mode" data-sales-date-mode="day">One Day</button>
          <button type="button" class="sales-date-mode" data-sales-date-mode="custom">Custom Range</button>
        </div>
        <div id="salesMiniDayWrap" class="sales-mini-date-input hidden">
          <label><span>Date</span><input id="salesMiniDay" type="date"></label>
        </div>
        <div id="salesMiniCustomWrap" class="sales-mini-date-custom hidden">
          <label><span>From</span><input id="salesMiniFrom" type="date"></label>
          <label><span>To</span><input id="salesMiniTo" type="date"></label>
        </div>
        <button id="applySalesMiniDate" type="button" class="small-button">Use Main Range</button>
      </div>
      <div class="sales-filter-row">
        <div class="sales-filter-buttons" role="group" aria-label="Filter sales transactions">
          <button type="button" class="sales-filter-button active" data-sales-filter="all">All</button>
          <button type="button" class="sales-filter-button" data-sales-filter="Cash">Cash</button>
          <button type="button" class="sales-filter-button" data-sales-filter="GCash">GCash</button>
          <button type="button" class="sales-filter-button" data-sales-filter="Other">Other Digital</button>
          <button type="button" class="sales-filter-button" data-sales-filter="Pay Later">Pay Later</button>
          <button type="button" class="sales-filter-button sales-filter-edited" data-sales-filter="edited">Edited</button>
        </div>
        <span id="salesFilterResult" class="sales-filter-result">Showing all transactions</span>
      </div>
      <div id="salesBulkActions" class="sales-bulk-actions hidden">
        <strong id="salesSelectedCount">0 selected</strong>
        <button id="clearSalesSelection" type="button" class="small-button">Clear</button>
        <button id="deleteSelectedSales" type="button" class="small-button sales-bulk-delete">Delete Selected</button>
      </div>`;
    salesTableWrap.parentElement.insertBefore(filters, salesTableWrap);
    const todayValue = manilaYmd();
    const mainFrom = document.querySelector("#fromDate")?.value || todayValue;
    const mainTo = document.querySelector("#toDate")?.value || todayValue;
    document.querySelector("#salesMiniDay").value = mainTo;
    document.querySelector("#salesMiniFrom").value = mainFrom;
    document.querySelector("#salesMiniTo").value = mainTo;
  }

  const salesHead = document.querySelector("#salesSection table thead tr");
  if (salesHead && !salesHead.querySelector('[data-ledger-series="true"]')) {
    const series = document.createElement("th");
    series.dataset.ledgerSeries = "true";
    series.textContent = "Series";
    salesHead.insertBefore(series, salesHead.firstElementChild);
    const select = document.createElement("th");
    select.dataset.ledgerSelect = "true";
    select.className = "ledger-select-cell";
    select.innerHTML = '<input id="selectAllSales" type="checkbox" aria-label="Select all visible transactions">';
    salesHead.insertBefore(select, salesHead.firstElementChild);
    const edit = document.createElement("th");
    edit.dataset.ledgerEdit = "true";
    edit.textContent = "Actions";
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

function ledgerSalesQueryDates() {
  if (ledgerSalesDateMode === "day") {
    const day = document.querySelector("#salesMiniDay")?.value || manilaYmd();
    return "from=" + encodeURIComponent(day) + "&to=" + encodeURIComponent(day);
  }
  if (ledgerSalesDateMode === "custom") {
    const from = document.querySelector("#salesMiniFrom")?.value || manilaYmd();
    const to = document.querySelector("#salesMiniTo")?.value || from;
    return "from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to);
  }
  return queryDates();
}

function updateSalesDateModeUi() {
  document.querySelectorAll(".sales-date-mode").forEach(button => {
    const active = button.dataset.salesDateMode === ledgerSalesDateMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.querySelector("#salesMiniDayWrap")?.classList.toggle("hidden", ledgerSalesDateMode !== "day");
  document.querySelector("#salesMiniCustomWrap")?.classList.toggle("hidden", ledgerSalesDateMode !== "custom");
  const apply = document.querySelector("#applySalesMiniDate");
  if (apply) apply.textContent = ledgerSalesDateMode === "main" ? "Use Main Range" : "Apply";
}

function clearSalesSelection() {
  ledgerSelectedSaleIds.clear();
  document.querySelectorAll(".ledger-sale-select").forEach(box => { box.checked = false; });
  updateSalesSelectionUi();
}

function visibleSalesRows() {
  return [...document.querySelectorAll("#salesBody tr[data-sale-id]")].filter(row => !row.hidden);
}

function updateSalesSelectionUi() {
  const count = ledgerSelectedSaleIds.size;
  document.querySelector("#salesBulkActions")?.classList.toggle("hidden", count === 0);
  const label = document.querySelector("#salesSelectedCount");
  if (label) label.textContent = count + " selected";
  const visible = visibleSalesRows();
  const visibleSelected = visible.filter(row => ledgerSelectedSaleIds.has(Number(row.dataset.saleId)));
  const selectAll = document.querySelector("#selectAllSales");
  if (selectAll) {
    selectAll.checked = visible.length > 0 && visibleSelected.length === visible.length;
    selectAll.indeterminate = visibleSelected.length > 0 && visibleSelected.length < visible.length;
  }
}

async function deleteSelectedSales() {
  const ids = [...ledgerSelectedSaleIds];
  if (!ids.length) return;
  if (!window.confirm("Delete " + ids.length + " selected transaction" + (ids.length === 1 ? "" : "s") + "?\n\nThey will be removed from Sales, reports, and Cash Flow. Audit footprints will be retained.")) return;
  const button = document.querySelector("#deleteSelectedSales");
  if (button) { button.disabled = true; button.textContent = "Deleting…"; }
  try {
    const result = await api("/api/admin/ledger/sales/bulk-delete", { method: "POST", body: { ids } });
    ledgerSelectedSaleIds.clear();
    toast(result.deletedCount + " transaction" + (result.deletedCount === 1 ? "" : "s") + " deleted.");
    await Promise.all([loadSummary(), loadTrend(), loadSales()]);
  } catch (error) {
    toast(error.message);
  } finally {
    if (button) { button.disabled = false; button.textContent = "Delete Selected"; }
  }
}

function applySalesTransactionFilter() {
  const rows = [...document.querySelectorAll("#salesBody tr[data-sale-id]")];
  let visible = 0;

  rows.forEach(row => {
    const method = row.dataset.paymentMethod || "";
    const editCount = Number(row.dataset.editCount || 0);
    const show =
      ledgerSalesFilter === "all" ||
      ledgerSalesFilter === method ||
      (ledgerSalesFilter === "edited" && editCount > 0);

    row.hidden = !show;
    if (show) visible += 1;
  });

  document.querySelectorAll(".sales-filter-button").forEach(button => {
    const active = button.dataset.salesFilter === ledgerSalesFilter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  const result = document.querySelector("#salesFilterResult");
  if (result) {
    const total = rows.length;
    const label =
      ledgerSalesFilter === "all" ? "all transactions" :
      ledgerSalesFilter === "edited" ? "edited records" :
      ledgerSalesFilter === "Other" ? "Other Digital transactions" :
      ledgerSalesFilter + " transactions";
    result.textContent = "Showing " + visible + " of " + total + " · " + label;
  }
  updateSalesSelectionUi();
}

async function refreshSeriesAndEditButtons(qs = ledgerSalesQueryDates()) {
  if (!token) return;
  try {
    const seriesRows = await api("/api/admin/ledger/series?" + qs);
    ledgerSeriesMap = new Map(seriesRows.map(row => [String(row.id), row.series]));
    ledgerEditCountMap = new Map(seriesRows.map(row => [String(row.id), Number(row.editCount || 0)]));
    const trs = [...document.querySelectorAll("#salesBody tr")];
    if (!currentSales.length) {
      const td = trs[0]?.querySelector("td");
      if (td) td.colSpan = 12;
      return;
    }
    currentSales.forEach((sale, index) => {
      const tr = trs[index];
      if (!tr) return;
      const editCount = ledgerEditCountMap.get(String(sale.id)) || 0;
      tr.dataset.saleId = String(sale.id);
      tr.dataset.paymentMethod = sale.payment_method || "";
      tr.dataset.editCount = String(editCount);
      const historyBadge = editCount > 0
        ? `<span class="ledger-history-count" aria-label="${editCount} edits">${editCount > 99 ? "99+" : editCount}</span>`
        : "";

      if (tr.dataset.ledgerEnhanced === "true") {
        tr.dataset.editCount = String(editCount);
        tr.dataset.paymentMethod = sale.payment_method || "";
        const historyButton = tr.querySelector(".ledger-history-button");
        if (historyButton) {
          historyButton.querySelector(".ledger-history-count")?.remove();
          if (editCount > 0) historyButton.insertAdjacentHTML("beforeend", historyBadge);
          historyButton.title = editCount > 0 ? editCount + " edit" + (editCount === 1 ? "" : "s") : "No edits yet";
        }
        return;
      }

      tr.dataset.ledgerEnhanced = "true";
      const seriesCell = document.createElement("td");
      seriesCell.className = "ledger-series";
      seriesCell.textContent = ledgerSeriesMap.get(String(sale.id)) || "—";
      tr.insertBefore(seriesCell, tr.firstElementChild);
      const selectCell = document.createElement("td");
      selectCell.className = "ledger-select-cell";
      selectCell.innerHTML = '<input class="ledger-sale-select" type="checkbox" data-id="' + sale.id + '" aria-label="Select transaction">';
      tr.insertBefore(selectCell, tr.firstElementChild);
      const editCell = document.createElement("td");
      editCell.innerHTML = `
        <div class="ledger-action-group">
          <button type="button" class="small-button ledger-edit-button" data-id="${sale.id}">Edit</button>
          <button type="button" class="small-button ledger-history-button" data-id="${sale.id}" title="${editCount > 0 ? editCount + " edit" + (editCount === 1 ? "" : "s") : "No edits yet"}">History${historyBadge}</button>
          <button type="button" class="small-button ledger-delete-button" data-id="${sale.id}">Delete</button>
        </div>`;
      tr.appendChild(editCell);
    });
    document.querySelectorAll(".ledger-sale-select").forEach(box => {
      box.addEventListener("change", () => {
        const id = Number(box.dataset.id);
        if (box.checked) ledgerSelectedSaleIds.add(id);
        else ledgerSelectedSaleIds.delete(id);
        updateSalesSelectionUi();
      });
    });
    document.querySelectorAll(".ledger-edit-button").forEach(button => button.addEventListener("click", () => openSaleEdit(button.dataset.id)));
    document.querySelectorAll(".ledger-history-button").forEach(button => button.addEventListener("click", () => openSaleHistory(button.dataset.id)));
    document.querySelectorAll(".ledger-delete-button").forEach(button => button.addEventListener("click", () => deleteSaleTransaction(button.dataset.id)));
    applySalesTransactionFilter();
  } catch (error) {
    console.warn("Unable to load sales series", error);
  }
}

const ledgerBaseLoadSales = typeof loadSales === "function" ? loadSales : null;
if (ledgerBaseLoadSales) {
  window.loadSales = async function() {
    const qs = ledgerSalesQueryDates();
    ledgerSelectedSaleIds.clear();

    if (ledgerSalesDateMode === "main") {
      await ledgerBaseLoadSales(qs);
    } else {
      const mainRows = await api("/api/admin/sales?" + queryDates());
      renderServiceBreakdown(mainRows);
      await ledgerBaseLoadSales(qs, { skipBreakdown: true });
    }

    await refreshSeriesAndEditButtons(qs);
  };
}

function historyDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Manila"
  });
}

function snapshotItemText(snapshot) {
  const items = snapshot?.items || [];
  return items.length
    ? items.map(item => `${Number(item.qty)}× ${ledgerEscape(item.label)} @ ${ledgerMoney(item.unitPrice)}`).join("<br>")
    : "—";
}

function snapshotCard(snapshot, title, meta = "") {
  if (!snapshot) return "";
  const payment = snapshot.payment_provider || snapshot.payment_method || "—";
  const status = snapshot.payment_status || "paid";
  return `
    <article class="sale-history-card">
      <div class="sale-history-card-head">
        <div><strong>${ledgerEscape(title)}</strong>${meta ? `<small>${ledgerEscape(meta)}</small>` : ""}</div>
        <span class="badge">${ledgerEscape(status)}</span>
      </div>
      <div class="sale-history-grid">
        <div><span>Transaction Date</span><strong>${ledgerEscape(historyDate(snapshot.created_at))}</strong></div>
        <div><span>Cash Flow / Paid Date</span><strong>${ledgerEscape(snapshot.paid_at ? historyDate(snapshot.paid_at) : "Unpaid")}</strong></div>
        <div><span>Payment</span><strong>${ledgerEscape(payment)}</strong></div>
        <div><span>Total</span><strong>${ledgerMoney(snapshot.total)}</strong></div>
        <div><span>Room / Unit</span><strong>${ledgerEscape(snapshot.delivery_room_unit || "—")}</strong></div>
        <div><span>Reference</span><strong>${ledgerEscape(snapshot.payment_reference || "—")}</strong></div>
      </div>
      <div class="sale-history-items"><span>Items</span><div>${snapshotItemText(snapshot)}</div></div>
    </article>`;
}

function snapshotChanges(before, after) {
  if (!before || !after) return [];
  const changes = [];
  const add = (label, a, b) => {
    const av = String(a ?? "");
    const bv = String(b ?? "");
    if (av !== bv) changes.push(label);
  };
  add("Transaction date", before.created_at, after.created_at);
  add("Paid date", before.paid_at, after.paid_at);
  add("Payment", before.payment_method, after.payment_method);
  add("Provider", before.payment_provider, after.payment_provider);
  add("Reference", before.payment_reference, after.payment_reference);
  add("Room / Unit", before.delivery_room_unit, after.delivery_room_unit);
  add("Total", before.total, after.total);
  add("Items", JSON.stringify(before.items || []), JSON.stringify(after.items || []));
  return changes;
}

async function openSaleHistory(id) {
  const dialog = document.querySelector("#saleHistoryDialog");
  const body = document.querySelector("#saleHistoryBody");
  body.innerHTML = '<div class="empty-state">Loading history…</div>';
  dialog.showModal();
  try {
    const data = await api("/api/admin/ledger/sales/" + id + "/history");
    document.querySelector("#saleHistorySeries").textContent =
      (data.series ? "Series " + data.series : "Transaction") +
      (data.transactionRef ? " · " + data.transactionRef : "");

    const history = data.history || [];
    if (!history.length) {
      if (Number(data.editCount || 0) > 0) {
        body.innerHTML = `
          <div class="sale-history-empty legacy-edit-notice">
            <strong>${Number(data.editCount)} earlier edit${Number(data.editCount) === 1 ? "" : "s"} detected</strong>
            <p>This record was changed before detailed audit snapshots were enabled. The current record is shown below; the older pre-edit values cannot be fully reconstructed.</p>
            ${snapshotCard(data.current, "Current Record")}
          </div>`;
      } else {
        body.innerHTML = `
          <div class="sale-history-empty">
            <strong>No edits yet</strong>
            <p>This transaction is still in its original recorded state.</p>
            ${snapshotCard(data.current, "Current / Original Record")}
          </div>`;
      }
      return;
    }

    const cards = [];
    if (Number(data.legacyEditCount || 0) > 0) {
      cards.push(`
        <div class="legacy-edit-banner">
          <strong>${Number(data.legacyEditCount)} earlier edit${Number(data.legacyEditCount) === 1 ? "" : "s"} detected before detailed history tracking</strong>
          <span>Later edits below include complete before/after snapshots.</span>
        </div>`);
    }
    const original = history[0]?.before_snapshot;
    if (original) cards.push(snapshotCard(original, "Original Record", "Before the first Admin edit"));

    let editNo = 0;
    for (const entry of history) {
      if (entry.action === "edit" && entry.after_snapshot) {
        editNo += 1;
        const changed = snapshotChanges(entry.before_snapshot, entry.after_snapshot);
        cards.push(snapshotCard(
          entry.after_snapshot,
          "Edit " + editNo,
          historyDate(entry.changed_at) + (changed.length ? " · Changed: " + changed.join(", ") : "")
        ));
      } else if (entry.action === "delete") {
        cards.push(snapshotCard(entry.before_snapshot, "Deleted Record", historyDate(entry.changed_at)));
      }
    }
    body.innerHTML = cards.join("");
  } catch (error) {
    body.innerHTML = '<div class="error-text">' + ledgerEscape(error.message) + '</div>';
  }
}

async function deleteSaleTransaction(id) {
  const sale = currentSales.find(row => String(row.id) === String(id));
  const series = ledgerSeriesMap.get(String(id)) || "";
  const description = [
    series ? "Series " + series : "",
    sale?.transaction_ref || ""
  ].filter(Boolean).join(" · ");

  const confirmed = window.confirm(
    "Delete this sale transaction" + (description ? "\n\n" + description : "") +
    "?\n\nThis removes it from Sales, reports, and Cash Flow. An audit footprint will be retained."
  );
  if (!confirmed) return;

  try {
    const result = await api("/api/admin/ledger/sales/" + id, { method: "DELETE" });
    toast("Deleted " + (result.series ? "Series " + result.series : "sale transaction") + ".");
    await Promise.all([loadSummary(), loadTrend(), loadSales()]);
  } catch (error) {
    toast(error.message);
  }
}

function saleEditPaymentFields() {
  const method = document.querySelector("#saleEditPayment").value;
  const noReference = method === "Cash" || method === "Pay Later";
  document.querySelector("#saleEditProviderWrap").classList.toggle("hidden", method !== "Other");
  document.querySelector("#saleEditReferenceWrap").classList.toggle("hidden", noReference);
  if (noReference) document.querySelector("#saleEditReference").value = "";
}

function saleEditItemRow(item = {}) {
  const row = document.createElement("div");
  row.className = "sale-edit-item";
  row.innerHTML = `
    <label><span>Category</span><select class="sale-edit-category"><option>Delivery</option><option>Pick-Up</option><option>New</option><option>Used</option><option>Retail</option><option>Other</option></select></label>
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
    toast(
      "Series " + result.series + " updated." +
      (result.settlementDatePreserved ? " Pay Later settlement date was preserved." : "")
    );
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

  document.querySelectorAll(".sales-filter-button").forEach(button => {
    button.addEventListener("click", () => {
      ledgerSalesFilter = button.dataset.salesFilter || "all";
      clearSalesSelection();
      applySalesTransactionFilter();
    });
  });
  document.querySelectorAll(".sales-date-mode").forEach(button => {
    button.addEventListener("click", () => {
      ledgerSalesDateMode = button.dataset.salesDateMode || "main";
      updateSalesDateModeUi();
    });
  });
  updateSalesDateModeUi();

  document.querySelector("#applySalesMiniDate")?.addEventListener("click", async () => {
    if (ledgerSalesDateMode === "custom") {
      const from = document.querySelector("#salesMiniFrom")?.value;
      const to = document.querySelector("#salesMiniTo")?.value;
      if (!from || !to) return toast("Choose both Sales transaction dates.");
      if (from > to) return toast("Sales transaction From date cannot be after To date.");
    }
    if (ledgerSalesDateMode === "day" && !document.querySelector("#salesMiniDay")?.value) return toast("Choose a Sales transaction date.");
    clearSalesSelection();
    try {
      await loadSales();
      if (typeof markAdminRefreshed === "function") markAdminRefreshed();
    } catch (error) { toast(error.message); }
  });

  document.querySelector("#selectAllSales")?.addEventListener("change", event => {
    const checked = event.target.checked;
    visibleSalesRows().forEach(row => {
      const id = Number(row.dataset.saleId);
      const box = row.querySelector(".ledger-sale-select");
      if (box) box.checked = checked;
      if (checked) ledgerSelectedSaleIds.add(id);
      else ledgerSelectedSaleIds.delete(id);
    });
    updateSalesSelectionUi();
  });
  document.querySelector("#clearSalesSelection")?.addEventListener("click", clearSalesSelection);
  document.querySelector("#deleteSelectedSales")?.addEventListener("click", deleteSelectedSales);

  document.querySelector("#closeSaleHistory")?.addEventListener("click", () => document.querySelector("#saleHistoryDialog").close());
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
