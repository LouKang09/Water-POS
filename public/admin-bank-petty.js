let bankPettyFlow = new Map();

function bankPettyMoney(value) {
  return typeof ledgerMoney === "function"
    ? ledgerMoney(value)
    : "₱" + Number(value || 0).toLocaleString("en-PH", { maximumFractionDigits: 2 });
}

function ensureBankPettyUi() {
  const controls = document.querySelector(".cash-flow-controls");
  const cashSettings = document.querySelector(".cash-flow-settings");
  const entryForm = document.querySelector("#cashFlowEntryForm");
  const tableHead = document.querySelector(".cash-flow-table thead tr");
  const tableBody = document.querySelector("#cashFlowBody");
  if (!controls || !cashSettings || !entryForm || !tableHead || !tableBody) return false;

  const cashTitle = cashSettings.querySelector("h3");
  const cashCopy = cashSettings.querySelector("p");
  if (cashTitle && cashTitle.textContent === "Default Petty Cash") cashTitle.textContent = "Cash Petty";
  if (cashCopy) cashCopy.textContent = "Default cash petty used for each day unless a one-day Cash Petty Override is entered.";
  const cashLabel = document.querySelector("#defaultPettyCash")?.closest("label")?.querySelector("span");
  if (cashLabel) cashLabel.textContent = "Default cash petty";

  if (!document.querySelector("#bankPettySettingsPanel")) {
    const panel = document.createElement("div");
    panel.id = "bankPettySettingsPanel";
    panel.className = "panel cash-flow-settings bank-petty-settings";
    panel.innerHTML = `
      <h3>Bank Petty / Opening Balance</h3>
      <p>Starting bank balance. It carries forward through bank credits/debits unless you set a one-day Bank Petty Override.</p>
      <form id="bankPettySettingsForm" class="cash-flow-settings-form">
        <label class="field"><span>Default bank petty</span><input id="defaultBankPetty" type="number" min="0" step="0.01" value="0"></label>
        <button class="primary-button" type="submit">Save Bank Petty</button>
      </form>`;
    controls.insertBefore(panel, document.querySelector(".cash-flow-entry-panel"));
  }

  if (!document.querySelector("#cashFlowBankPettyOverride")) {
    const label = document.createElement("label");
    label.className = "field bank-petty-override-field";
    label.innerHTML = `
      <span>Bank Petty Override</span>
      <input id="cashFlowBankPettyOverride" type="number" min="0" step="0.01" placeholder="Carry forward bank balance">
      <small>Optional. When set, this becomes the bank opening balance for that date before Credit/Debit.</small>`;
    const creditField = document.querySelector("#cashFlowCredit")?.closest("label");
    entryForm.insertBefore(label, creditField || entryForm.lastElementChild);
  }

  if (!tableHead.querySelector('[data-bank-petty-column="true"]')) {
    const creditHeader = [...tableHead.children].find(th => th.textContent.trim() === "Credit to Bank");
    const th = document.createElement("th");
    th.dataset.bankPettyColumn = "true";
    th.textContent = "Bank Petty";
    tableHead.insertBefore(th, creditHeader || null);
  }

  const style = document.createElement("style");
  style.id = "bankPettyStyles";
  style.textContent = `
    .bank-petty-settings{min-width:260px}
    .bank-petty-settings h3{margin-bottom:4px}
    .bank-petty-settings p{max-width:390px}
    .bank-petty-override-field small{display:block;margin-top:4px;color:var(--muted);font-size:.66rem;line-height:1.35}
    .bank-petty-cell strong{white-space:nowrap}
    .bank-petty-reset{display:block;margin-top:2px;font-size:.58rem;color:var(--brand);font-weight:800}
    @media(min-width:1024px){.cash-flow-controls{grid-template-columns:minmax(240px,.72fr) minmax(260px,.8fr) minmax(500px,1.7fr)!important}}
    @media print{.bank-petty-reset{display:none}}
  `;
  if (!document.querySelector("#bankPettyStyles")) document.head.appendChild(style);

  return true;
}

function bankPettyDateRange() {
  return {
    from: document.querySelector("#cashFlowFrom")?.value || (typeof monthStartYmd === "function" ? monthStartYmd() : "2000-01-01"),
    to: document.querySelector("#cashFlowTo")?.value || (typeof manilaYmd === "function" ? manilaYmd() : "2999-12-31"),
  };
}

function enrichBankPettyTable() {
  const tbody = document.querySelector("#cashFlowBody");
  if (!tbody) return;

  const rows = [...tbody.querySelectorAll("tr")];
  if (!rows.length) return;

  rows.forEach(tr => {
    const cells = [...tr.children];
    if (!cells.length) return;

    if (cells.length === 1) {
      cells[0].colSpan = 18;
      return;
    }

    const date = cells[0].textContent.trim();
    const bank = bankPettyFlow.get(date);
    if (!bank) return;

    let bankCell = tr.querySelector(".bank-petty-cell");
    if (!bankCell) {
      bankCell = document.createElement("td");
      bankCell.className = "bank-petty-cell";
      const creditCell = cells[13];
      tr.insertBefore(bankCell, creditCell || null);
    }

    bankCell.innerHTML = `<strong>${bankPettyMoney(bank.bankPetty)}</strong>${bank.bankPettyOverride == null ? "" : '<span class="bank-petty-reset">Override</span>'}`;

    // After inserting Bank Petty: Credit=14, Debit=15, Running Bank Total=16, Note=17.
    const currentCells = [...tr.children];
    if (currentCells[16]) currentCells[16].innerHTML = `<strong>${bankPettyMoney(bank.runningBankTotal)}</strong>`;
  });
}

async function loadBankPettyFlow() {
  if (typeof api !== "function" || typeof token === "undefined" || !token) return;
  if (!ensureBankPettyUi()) return;
  const { from, to } = bankPettyDateRange();
  if (from > to) return;

  try {
    const data = await api(`/api/admin/cash-flow-bank?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    const defaultInput = document.querySelector("#defaultBankPetty");
    if (defaultInput && document.activeElement !== defaultInput) defaultInput.value = Number(data.defaultBankPetty || 0);
    bankPettyFlow = new Map((data.rows || []).map(row => [String(row.date).slice(0, 10), row]));
    enrichBankPettyTable();
    await loadSelectedBankOverride();
  } catch (error) {
    console.warn("Unable to load bank petty", error);
  }
}

async function loadSelectedBankOverride() {
  const date = document.querySelector("#cashFlowEntryDate")?.value;
  const input = document.querySelector("#cashFlowBankPettyOverride");
  if (!date || !input || document.activeElement === input) return;

  let row = bankPettyFlow.get(date);
  if (!row && typeof api === "function" && typeof token !== "undefined" && token) {
    try {
      const data = await api(`/api/admin/cash-flow-bank?from=${encodeURIComponent(date)}&to=${encodeURIComponent(date)}`);
      row = data.rows?.[0] || null;
    } catch (_) {}
  }
  input.value = row?.bankPettyOverride == null ? "" : Number(row.bankPettyOverride);
}

async function saveDefaultBankPetty(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  if (button) { button.disabled = true; button.textContent = "Saving…"; }
  try {
    const result = await api("/api/admin/cash-flow-bank/settings", {
      method: "PATCH",
      body: { defaultBankPetty: document.querySelector("#defaultBankPetty").value },
    });
    document.querySelector("#defaultBankPetty").value = result.defaultBankPetty;
    toast("Default bank petty saved.");
    await loadBankPettyFlow();
  } catch (error) {
    toast(error.message || "Unable to save bank petty.");
  } finally {
    if (button) { button.disabled = false; button.textContent = "Save Bank Petty"; }
  }
}

async function saveDailyBankPettyOverride() {
  const date = document.querySelector("#cashFlowEntryDate")?.value;
  const input = document.querySelector("#cashFlowBankPettyOverride");
  if (!date || !input || typeof api !== "function") return;
  try {
    await api("/api/admin/cash-flow-bank/" + encodeURIComponent(date), {
      method: "PUT",
      body: { bankPettyOverride: input.value },
    });
    // The normal Cash Flow submit listener saves Actual/Credit/Debit/Note.
    // Refresh shortly after both requests finish so the bank balance reflects all values.
    setTimeout(loadBankPettyFlow, 150);
  } catch (error) {
    toast(error.message || "Cash flow saved, but Bank Petty Override could not be saved.");
  }
}

function bindBankPettyUi() {
  if (!ensureBankPettyUi()) return;
  const settings = document.querySelector("#bankPettySettingsForm");
  if (settings && settings.dataset.bound !== "true") {
    settings.dataset.bound = "true";
    settings.addEventListener("submit", saveDefaultBankPetty);
  }

  const entryForm = document.querySelector("#cashFlowEntryForm");
  if (entryForm && entryForm.dataset.bankPettyBound !== "true") {
    entryForm.dataset.bankPettyBound = "true";
    entryForm.addEventListener("submit", saveDailyBankPettyOverride);
  }

  const entryDate = document.querySelector("#cashFlowEntryDate");
  if (entryDate && entryDate.dataset.bankPettyBound !== "true") {
    entryDate.dataset.bankPettyBound = "true";
    entryDate.addEventListener("change", loadSelectedBankOverride);
  }

  document.querySelector("#cashFlowView")?.addEventListener("click", () => setTimeout(loadBankPettyFlow, 200));
  document.querySelector('[data-section="cashflow"]')?.addEventListener("click", () => setTimeout(loadBankPettyFlow, 200));
  document.querySelector("#cashFlowFrom")?.addEventListener("change", loadBankPettyFlow);
  document.querySelector("#cashFlowTo")?.addEventListener("change", loadBankPettyFlow);

  const body = document.querySelector("#cashFlowBody");
  if (body && body.dataset.bankPettyObserver !== "true") {
    body.dataset.bankPettyObserver = "true";
    new MutationObserver(() => enrichBankPettyTable()).observe(body, { childList: true, subtree: false });
  }
}

function startBankPettyUi() {
  if (!ensureBankPettyUi()) {
    setTimeout(startBankPettyUi, 100);
    return;
  }
  bindBankPettyUi();
  if (typeof token !== "undefined" && token) loadBankPettyFlow();
}

startBankPettyUi();
