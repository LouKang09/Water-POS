let manualUsedProducts = [];

const MANUAL_POS_PRESETS = {
  Delivery: [
    { label: "Delivery ₱25", price: 25 },
    { label: "Delivery ₱35", price: 35 },
    { label: "Delivery ₱45", price: 45 }
  ],
  "Pick-Up": [
    { label: "Pick-Up ₱20", price: 20 },
    { label: "Pick-Up ₱30", price: 30 },
    { label: "Pick-Up ₱40", price: 40 }
  ],
  New: [
    { label: "New Gallon", price: 200 }
  ]
};

function ensureOtherCategoryOption(row) {
  const categorySelect = row?.querySelector(".manual-item-category");
  if (!categorySelect || categorySelect.querySelector('option[value="Other"]')) return;
  const option = document.createElement("option");
  option.value = "Other";
  option.textContent = "Other";
  categorySelect.appendChild(option);
}

function manualPresetOptions(category) {
  if (category === "Used") {
    return manualUsedProducts
      .filter(item => item.active)
      .map(item => ({ label: item.label, price: Number(item.price) }));
  }
  return MANUAL_POS_PRESETS[category] || [];
}

function manualOptionText(option) {
  if (!option) return "";
  if (/₱\d/.test(option.label)) return option.label;
  return option.label + " · ₱" + Number(option.price).toLocaleString("en-PH");
}

function setOtherManualControls(row, preferredLabel = "") {
  const existing = row.querySelector(".manual-item-label");
  let input = existing;
  if (!input || input.tagName !== "INPUT") {
    input = document.createElement("input");
    input.className = "manual-item-label";
    input.maxLength = 120;
    input.required = true;
    input.placeholder = "What is this Other item?";
    if (existing) existing.replaceWith(input);
  }
  if (preferredLabel) input.value = preferredLabel;
  input.disabled = false;

  const price = row.querySelector(".manual-item-price");
  if (price) {
    price.readOnly = false;
    price.tabIndex = 0;
    price.title = "Enter the unit price manually";
    if (!price.value || Number(price.value) <= 0) price.value = "";
    price.placeholder = "0.00";
  }
}

function updateManualPresetRow(row, preferredLabel = "") {
  if (!row) return;
  ensureOtherCategoryOption(row);
  const category = row.querySelector(".manual-item-category")?.value || "Delivery";

  if (category === "Other") {
    setOtherManualControls(row, preferredLabel);
    return;
  }

  const options = manualPresetOptions(category);
  const existing = row.querySelector(".manual-item-label");
  const currentLabel = preferredLabel || existing?.value || "";

  let select = existing;
  if (!select || select.tagName !== "SELECT") {
    select = document.createElement("select");
    select.className = "manual-item-label";
    select.required = true;
    if (existing) existing.replaceWith(select);
  }

  if (!options.length) {
    select.innerHTML = '<option value="">No active Used item available</option>';
    select.disabled = true;
    const price = row.querySelector(".manual-item-price");
    if (price) {
      price.value = "";
      price.readOnly = true;
    }
    return;
  }

  select.disabled = false;
  select.innerHTML = options.map(option =>
    '<option value="' + String(option.label).replaceAll('"', '&quot;') + '" data-price="' + Number(option.price) + '">' +
    manualOptionText(option) + '</option>'
  ).join("");

  const exact = options.find(option => option.label === currentLabel);
  select.value = exact ? exact.label : options[0].label;

  const selected = options.find(option => option.label === select.value) || options[0];
  const price = row.querySelector(".manual-item-price");
  if (price) {
    price.value = selected.price;
    price.readOnly = true;
    price.tabIndex = -1;
    price.title = "Price is set by the selected POS item";
  }
}

function refreshManualPresetRows() {
  document.querySelectorAll(".manual-item-row").forEach(row => {
    ensureOtherCategoryOption(row);
    updateManualPresetRow(row);
  });
  if (typeof updateManualTotal === "function") updateManualTotal();
}

async function loadManualUsedProducts() {
  if (typeof api !== "function" || typeof token === "undefined" || !token) return;
  try {
    manualUsedProducts = await api("/api/admin/used-products");
    refreshManualPresetRows();
  } catch (_) {}
}

function installManualPresetControls() {
  const list = document.querySelector("#manualItemList");
  if (!list || list.dataset.presetControls === "true") return;
  list.dataset.presetControls = "true";

  refreshManualPresetRows();

  const observer = new MutationObserver(() => refreshManualPresetRows());
  observer.observe(list, { childList: true });

  list.addEventListener("change", event => {
    const row = event.target.closest(".manual-item-row");
    if (!row) return;

    if (event.target.matches(".manual-item-category")) {
      updateManualPresetRow(row);
    } else if (event.target.matches(".manual-item-label") && event.target.tagName === "SELECT") {
      const option = event.target.selectedOptions[0];
      const price = row.querySelector(".manual-item-price");
      if (price && option) price.value = Number(option.dataset.price || 0);
    }

    if (typeof updateManualTotal === "function") updateManualTotal();
  });
}

function loadBankPettyAsset() {
  if (document.querySelector('script[data-admin-bank-petty="true"]')) return;
  const bank = document.createElement("script");
  bank.src = "/admin-bank-petty.js?v=20261006-1";
  bank.dataset.adminBankPetty = "true";
  document.body.appendChild(bank);
}

function loadLedgerAssets() {
  if (!document.querySelector('link[data-admin-ledger="true"]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/admin-ledger.css?v=20261006-2";
    link.dataset.adminLedger = "true";
    document.head.appendChild(link);
  }
  const existing = document.querySelector('script[data-admin-ledger="true"]');
  if (existing) {
    if (document.querySelector("#cashflowSection")) loadBankPettyAsset();
    else existing.addEventListener("load", loadBankPettyAsset, { once: true });
    return;
  }
  const script = document.createElement("script");
  script.src = "/admin-ledger.js?v=20261006-2";
  script.dataset.adminLedger = "true";
  script.addEventListener("load", loadBankPettyAsset, { once: true });
  document.body.appendChild(script);
}

function installAdminRefinements() {
  installManualPresetControls();
  document.querySelector(".side-nav")?.addEventListener("click", event => {
    if (event.target.closest('[data-section="manual"]')) {
      setTimeout(() => {
        installManualPresetControls();
        loadManualUsedProducts();
      }, 0);
    }
  });
  loadManualUsedProducts();
  loadLedgerAssets();
}

installAdminRefinements();
