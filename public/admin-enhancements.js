const ADMIN_REFRESH_MS = 30000;
let adminActiveSection = document.querySelector(".side-nav button.active")?.dataset.section || "sales";
let adminRefreshTimer = null;
let adminRefreshBusy = false;

function addPasswordToggle(input, label = "Show") {
  if (!input || input.parentElement.querySelector(".password-toggle")) return;
  const wrap = document.createElement("div");
  wrap.className = "password-control";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "password-toggle";
  button.textContent = label;
  button.setAttribute("aria-label", "Show password");
  button.addEventListener("click", () => {
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    button.textContent = showing ? "Show" : "Hide";
    button.setAttribute("aria-label", showing ? "Show password" : "Hide password");
  });
  wrap.appendChild(button);
}

function localDateTimeValue(date = new Date()) {
  const pad = value => String(value).padStart(2, "0");
  return [
    date.getFullYear(), "-", pad(date.getMonth() + 1), "-", pad(date.getDate()),
    "T", pad(date.getHours()), ":", pad(date.getMinutes())
  ].join("");
}

function ensureCustomPrintRange() {
  const toolbar = document.querySelector(".report-toolbar");
  if (!toolbar || document.querySelector("#customPrintRange")) return;
  const row = document.createElement("div");
  row.id = "customPrintRange";
  row.className = "custom-print-range";
  row.innerHTML = `
    <div class="custom-print-copy">
      <strong>Custom date range</strong>
      <small>Print any specific start and end date.</small>
    </div>
    <label><span>From</span><input id="customPrintFrom" type="date"></label>
    <label><span>To</span><input id="customPrintTo" type="date"></label>
    <button id="printCustomRange" type="button" class="small-button">Print Custom Range</button>`;
  toolbar.insertAdjacentElement("afterend", row);

  const todayValue = today();
  document.querySelector("#customPrintFrom").value = document.querySelector("#fromDate")?.value || todayValue;
  document.querySelector("#customPrintTo").value = document.querySelector("#toDate")?.value || todayValue;

  if (typeof window.reportRange === "function" && !window.__waterPosCustomRangeInstalled) {
    const originalReportRange = window.reportRange;
    window.reportRange = function(period) {
      if (period === "custom") {
        return {
          from: document.querySelector("#customPrintFrom")?.value || today(),
          to: document.querySelector("#customPrintTo")?.value || today(),
          label: "Custom"
        };
      }
      return originalReportRange(period);
    };
    window.__waterPosCustomRangeInstalled = true;
  }

  document.querySelector("#printCustomRange").addEventListener("click", () => {
    const from = document.querySelector("#customPrintFrom").value;
    const to = document.querySelector("#customPrintTo").value;
    if (!from || !to) return toast("Choose both custom report dates.");
    if (from > to) return toast("Custom report From date cannot be after To date.");
    printSalesReport("custom");
  });
}

function ensureAdminSections() {
  const nav = document.querySelector(".side-nav");
  if (nav && !nav.querySelector('[data-section="manual"]')) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.section = "manual";
    button.textContent = "Manual Transaction";
    nav.appendChild(button);
  }
  if (nav && !nav.querySelector('[data-section="account"]')) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.section = "account";
    button.textContent = "User Control";
    nav.appendChild(button);
  }

  const main = document.querySelector(".admin-main");
  if (main && !document.querySelector("#manualSection")) {
    const section = document.createElement("section");
    section.id = "manualSection";
    section.className = "admin-section";
    section.innerHTML = `
      <div class="panel manual-transaction-panel">
        <div class="panel-header">
          <div class="panel-header-copy">
            <h2>Add Historical Transaction</h2>
            <p>Backfill an older sale into the main Water POS sales log. The chosen transaction date is used in reports and dashboard totals.</p>
          </div>
          <span class="badge">Admin entry</span>
        </div>
        <form id="manualTransactionForm" class="manual-transaction-form">
          <div class="manual-meta-grid">
            <label class="field">
              <span>Transaction Date & Time</span>
              <input id="manualDateTime" type="datetime-local" required>
            </label>
            <label class="field">
              <span>Payment</span>
              <select id="manualPaymentMethod">
                <option value="Cash">Cash</option>
                <option value="GCash">GCash</option>
                <option value="Other">Other Digital</option>
              </select>
            </label>
            <label id="manualProviderField" class="field hidden">
              <span>Payment Provider</span>
              <select id="manualPaymentProvider">
                <option value="Maya">Maya</option>
                <option value="MariBank">MariBank</option>
                <option value="GoTyme">GoTyme</option>
                <option value="VYBE by BPI">VYBE / BPI</option>
              </select>
            </label>
            <label id="manualReferenceField" class="field hidden">
              <span>Payment Reference</span>
              <input id="manualPaymentReference" autocomplete="off" placeholder="Optional for historical entry">
            </label>
            <label class="field">
              <span>Room / Unit</span>
              <input id="manualRoomUnit" maxlength="100" autocomplete="off" placeholder="Optional">
            </label>
          </div>

          <div class="manual-items-head">
            <div>
              <strong>Transaction items</strong>
              <small>Add every line item from the old transaction.</small>
            </div>
            <button id="addManualItem" type="button" class="small-button">+ Add Item</button>
          </div>
          <div id="manualItemList" class="manual-item-list"></div>
          <div class="manual-form-footer">
            <div class="manual-total"><span>Total</span><strong id="manualTransactionTotal">₱0</strong></div>
            <div id="manualTransactionError" class="error-text"></div>
            <button id="saveManualTransaction" type="submit" class="primary-button">Save Historical Transaction</button>
          </div>
        </form>
      </div>`;
    main.appendChild(section);
  }

  if (main && !document.querySelector("#accountSection")) {
    const section = document.createElement("section");
    section.id = "accountSection";
    section.className = "admin-section";
    section.innerHTML = `
      <div class="panel account-control-panel">
        <div class="panel-header">
          <div class="panel-header-copy">
            <h2>Admin Login</h2>
            <p>Update the email or password used to sign in to this Admin dashboard.</p>
          </div>
          <span class="badge">Admin account</span>
        </div>
        <form id="adminAccountForm" class="account-control-form">
          <label class="field">
            <span>Admin Email</span>
            <input id="adminAccountEmail" type="email" required autocomplete="username" placeholder="admin@example.com">
          </label>
          <label class="field">
            <span>Current Password <b>*</b></span>
            <input id="adminCurrentPassword" type="password" required autocomplete="current-password" placeholder="Required to save changes">
          </label>
          <label class="field">
            <span>New Password</span>
            <input id="adminNewPassword" type="password" minlength="10" autocomplete="new-password" placeholder="Leave blank to keep current password">
            <small>Optional · at least 10 characters if changing.</small>
          </label>
          <label class="field">
            <span>Confirm New Password</span>
            <input id="adminConfirmPassword" type="password" minlength="10" autocomplete="new-password" placeholder="Repeat new password">
          </label>
          <div id="adminAccountError" class="error-text span-2"></div>
          <div class="account-control-actions span-2">
            <button id="saveAdminAccount" type="submit" class="primary-button">Save Admin Login</button>
          </div>
        </form>
      </div>

      <div class="panel account-control-panel pos-users-panel">
        <div class="panel-header">
          <div class="panel-header-copy">
            <h2>POS User Accounts</h2>
            <p>Edit the name, login email, or password used by POS/cashier users on the website and Android app.</p>
          </div>
          <span id="posUserCount" class="badge">0 users</span>
        </div>
        <div id="posUserList" class="pos-user-control-list">
          <div class="empty-state">Loading POS users…</div>
        </div>
      </div>`;
    main.appendChild(section);
  }

  addPasswordToggle(document.querySelector("#loginPassword"));
  addPasswordToggle(document.querySelector("#adminCurrentPassword"));
  addPasswordToggle(document.querySelector("#adminNewPassword"));
  addPasswordToggle(document.querySelector("#adminConfirmPassword"));

  if (!document.querySelector("#adminRefreshState")) {
    const top = document.querySelector(".admin-top > div:first-child");
    const state = document.createElement("div");
    state.id = "adminRefreshState";
    state.className = "admin-refresh-state";
    state.innerHTML = '<span class="live-dot"></span><span>Sales auto refresh every 30s</span><small id="adminLastRefresh">Waiting for sign in</small>';
    top.appendChild(state);
  }

  const dateTime = document.querySelector("#manualDateTime");
  if (dateTime && !dateTime.value) dateTime.value = localDateTimeValue();
  if (!document.querySelector("#manualItemList")?.children.length) addManualItemRow();
  updateManualPaymentFields();
}

function adminSectionTitle(section) {
  return {
    sales: "Sales & Dashboard",
    expenses: "Expenses",
    used: "Used Pricing",
    manual: "Manual Transaction",
    account: "User Control"
  }[section] || "Water POS Admin";
}

function activateAdminSection(section) {
  adminActiveSection = section;
  document.querySelectorAll(".side-nav button").forEach(button => {
    button.classList.toggle("active", button.dataset.section === section);
  });
  document.querySelectorAll(".admin-section").forEach(item => item.classList.remove("active"));
  document.querySelector("#" + section + "Section")?.classList.add("active");
  const title = document.querySelector("#adminTitle");
  if (title) title.textContent = adminSectionTitle(section);
  document.querySelector("#dateFilter")?.classList.toggle("hidden", section !== "sales");
}

function markAdminRefreshed() {
  const el = document.querySelector("#adminLastRefresh");
  if (!el) return;
  el.textContent = "Updated " + new Date().toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function renderPosUsers(rows) {
  const list = document.querySelector("#posUserList");
  const count = document.querySelector("#posUserCount");
  if (count) count.textContent = rows.length + " user" + (rows.length === 1 ? "" : "s");
  if (!list) return;
  if (!rows.length) {
    list.innerHTML = '<div class="empty-state">No POS user exists yet. The first POS login screen will create one.</div>';
    return;
  }

  list.innerHTML = rows.map(user => {
    const lastLogin = user.last_login_at
      ? new Date(user.last_login_at).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Manila" })
      : "Never";
    return `
      <form class="pos-user-editor" data-id="${user.id}">
        <div class="pos-user-editor-head">
          <div>
            <strong>${escapeHtml(user.name || "POS User")}</strong>
            <small>POS User #${user.id} · Last login ${escapeHtml(lastLogin)}</small>
          </div>
          <span class="badge">${user.active ? "Active" : "Inactive"}</span>
        </div>
        <div class="account-control-form">
          <label class="field">
            <span>Name</span>
            <input class="pos-user-name" value="${escapeHtml(user.name || "")}" maxlength="120" required>
          </label>
          <label class="field">
            <span>Login Email</span>
            <input class="pos-user-email" type="email" value="${escapeHtml(user.email || "")}" required autocomplete="off">
          </label>
          <label class="field">
            <span>New Password</span>
            <input class="pos-user-password" type="password" minlength="8" autocomplete="new-password" placeholder="Leave blank to keep current password">
            <small>Optional · at least 8 characters if changing.</small>
          </label>
          <label class="field">
            <span>Confirm New Password</span>
            <input class="pos-user-confirm" type="password" minlength="8" autocomplete="new-password" placeholder="Repeat new password">
          </label>
          <div class="pos-user-error error-text span-2"></div>
          <div class="account-control-actions span-2">
            <button type="submit" class="primary-button save-pos-user">Save POS User</button>
          </div>
        </div>
      </form>`;
  }).join("");

  list.querySelectorAll(".pos-user-password,.pos-user-confirm").forEach(input => addPasswordToggle(input));
}

function manualDefaults(category) {
  if (category === "Delivery") return { label: "Delivery ₱25", price: 25 };
  if (category === "Pick-Up") return { label: "Pick-Up ₱20", price: 20 };
  if (category === "New") return { label: "New Gallon", price: 200 };
  return { label: "Used Gallon", price: "" };
}

function addManualItemRow(values = {}) {
  const list = document.querySelector("#manualItemList");
  if (!list) return;
  const category = values.category || "Delivery";
  const defaults = manualDefaults(category);
  const row = document.createElement("div");
  row.className = "manual-item-row";
  row.innerHTML = `
    <label><span>Category</span><select class="manual-item-category">
      <option value="Delivery">Delivery</option>
      <option value="Pick-Up">Pick-Up</option>
      <option value="New">New</option>
      <option value="Used">Used</option>
    </select></label>
    <label class="manual-item-label-wrap"><span>Label</span><input class="manual-item-label" maxlength="120" value="${escapeHtml(values.label || defaults.label)}"></label>
    <label><span>Unit Price</span><input class="manual-item-price" type="number" min="0.01" step="0.01" value="${values.unitPrice ?? defaults.price}" required></label>
    <label><span>Qty</span><input class="manual-item-qty" type="number" min="1" max="500" step="1" value="${values.qty || 1}" required></label>
    <button type="button" class="manual-item-remove" aria-label="Remove item">×</button>`;
  row.querySelector(".manual-item-category").value = category;
  list.appendChild(row);
  updateManualTotal();
}

function updateManualTotal() {
  let total = 0;
  document.querySelectorAll(".manual-item-row").forEach(row => {
    total += (Number(row.querySelector(".manual-item-price").value) || 0) * (Number(row.querySelector(".manual-item-qty").value) || 0);
  });
  const totalEl = document.querySelector("#manualTransactionTotal");
  if (totalEl) totalEl.textContent = money(total);
}

function updateManualPaymentFields() {
  const method = document.querySelector("#manualPaymentMethod")?.value || "Cash";
  document.querySelector("#manualProviderField")?.classList.toggle("hidden", method !== "Other");
  document.querySelector("#manualReferenceField")?.classList.toggle("hidden", method === "Cash");
  const ref = document.querySelector("#manualPaymentReference");
  if (ref && method === "Cash") ref.value = "";
}

function collectManualItems() {
  return [...document.querySelectorAll(".manual-item-row")].map(row => ({
    category: row.querySelector(".manual-item-category").value,
    label: row.querySelector(".manual-item-label").value.trim(),
    unitPrice: row.querySelector(".manual-item-price").value,
    qty: row.querySelector(".manual-item-qty").value
  }));
}

async function loadUserControl() {
  if (!token) return;
  const [account, posUsers] = await Promise.all([
    api("/api/admin/account"),
    api("/api/admin/pos-users")
  ]);
  const input = document.querySelector("#adminAccountEmail");
  if (input && document.activeElement !== input) input.value = account.email || "";
  renderPosUsers(posUsers);
}

async function refreshAdminSection(section = adminActiveSection, silent = false) {
  if (!token || adminRefreshBusy) return;
  adminRefreshBusy = true;
  try {
    if (section === "sales") {
      await Promise.all([loadSummary(), loadTrend(), loadSales()]);
    } else if (section === "expenses") {
      await loadExpenses();
    } else if (section === "used") {
      await loadUsed();
    } else if (section === "account") {
      await loadUserControl();
    }
    markAdminRefreshed();
  } catch (error) {
    if (!silent) toast(error.message || "Unable to refresh this section.");
  } finally {
    adminRefreshBusy = false;
  }
}

function startAdminAutoRefresh() {
  clearInterval(adminRefreshTimer);
  adminRefreshTimer = setInterval(() => {
    if (document.visibilityState === "visible" && adminActiveSection === "sales") {
      refreshAdminSection("sales", true);
    }
  }, ADMIN_REFRESH_MS);
}

function bindAdminEnhancements() {
  const nav = document.querySelector(".side-nav");
  nav?.addEventListener("click", event => {
    const button = event.target.closest("button[data-section]");
    if (!button) return;
    const section = button.dataset.section;
    activateAdminSection(section);
    refreshAdminSection(section);
  });

  document.querySelector("#adminAccountForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const errorEl = document.querySelector("#adminAccountError");
    errorEl.textContent = "";
    const newPassword = document.querySelector("#adminNewPassword").value;
    const confirmPassword = document.querySelector("#adminConfirmPassword").value;
    if (newPassword !== confirmPassword) {
      errorEl.textContent = "New passwords do not match.";
      return;
    }

    const button = document.querySelector("#saveAdminAccount");
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      const result = await api("/api/admin/account", {
        method: "PATCH",
        body: {
          email: document.querySelector("#adminAccountEmail").value.trim(),
          currentPassword: document.querySelector("#adminCurrentPassword").value,
          newPassword
        }
      });
      token = result.token;
      sessionStorage.setItem(tokenKey, token);
      document.querySelector("#adminCurrentPassword").value = "";
      document.querySelector("#adminNewPassword").value = "";
      document.querySelector("#adminConfirmPassword").value = "";
      toast(result.passwordChanged ? "Admin email/password updated." : "Admin email updated.");
      await loadUserControl();
      markAdminRefreshed();
    } catch (error) {
      errorEl.textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = "Save Admin Login";
    }
  });

  document.querySelector("#accountSection")?.addEventListener("submit", async event => {
    const form = event.target.closest(".pos-user-editor");
    if (!form) return;
    event.preventDefault();
    const errorEl = form.querySelector(".pos-user-error");
    errorEl.textContent = "";
    const newPassword = form.querySelector(".pos-user-password").value;
    const confirmPassword = form.querySelector(".pos-user-confirm").value;
    if (newPassword !== confirmPassword) {
      errorEl.textContent = "New POS passwords do not match.";
      return;
    }

    const button = form.querySelector(".save-pos-user");
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      const result = await api("/api/admin/pos-users/" + form.dataset.id, {
        method: "PATCH",
        body: {
          name: form.querySelector(".pos-user-name").value.trim(),
          email: form.querySelector(".pos-user-email").value.trim(),
          newPassword
        }
      });
      toast(result.passwordChanged ? "POS user email/password updated." : "POS user updated.");
      await loadUserControl();
      markAdminRefreshed();
    } catch (error) {
      errorEl.textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = "Save POS User";
    }
  });

  document.querySelector("#addManualItem")?.addEventListener("click", () => addManualItemRow({ category: "Delivery" }));
  document.querySelector("#manualPaymentMethod")?.addEventListener("change", updateManualPaymentFields);
  document.querySelector("#manualItemList")?.addEventListener("input", updateManualTotal);
  document.querySelector("#manualItemList")?.addEventListener("change", event => {
    const category = event.target.closest(".manual-item-category");
    if (category) {
      const row = category.closest(".manual-item-row");
      const defaults = manualDefaults(category.value);
      row.querySelector(".manual-item-label").value = defaults.label;
      row.querySelector(".manual-item-price").value = defaults.price;
    }
    updateManualTotal();
  });
  document.querySelector("#manualItemList")?.addEventListener("click", event => {
    const remove = event.target.closest(".manual-item-remove");
    if (!remove) return;
    const rows = document.querySelectorAll(".manual-item-row");
    if (rows.length === 1) return toast("A transaction needs at least one item.");
    remove.closest(".manual-item-row").remove();
    updateManualTotal();
  });

  document.querySelector("#manualTransactionForm")?.addEventListener("submit", async event => {
    event.preventDefault();
    const errorEl = document.querySelector("#manualTransactionError");
    errorEl.textContent = "";
    const button = document.querySelector("#saveManualTransaction");
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      const method = document.querySelector("#manualPaymentMethod").value;
      const result = await api("/api/admin/manual-sales", {
        method: "POST",
        body: {
          dateTime: document.querySelector("#manualDateTime").value,
          paymentMethod: method,
          paymentProvider: method === "Other" ? document.querySelector("#manualPaymentProvider").value : null,
          paymentReference: document.querySelector("#manualPaymentReference").value.trim(),
          roomUnit: document.querySelector("#manualRoomUnit").value.trim(),
          items: collectManualItems()
        }
      });
      toast("Historical transaction saved · " + result.transaction_ref);
      document.querySelector("#manualPaymentReference").value = "";
      document.querySelector("#manualRoomUnit").value = "";
      document.querySelector("#manualItemList").innerHTML = "";
      addManualItemRow();
      await Promise.all([loadSummary(), loadTrend(), loadSales()]);
      markAdminRefreshed();
    } catch (error) {
      errorEl.textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = "Save Historical Transaction";
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && token && adminActiveSection !== "account") {
      refreshAdminSection(adminActiveSection, true);
    }
  });
  window.addEventListener("focus", () => {
    if (token && adminActiveSection === "sales") refreshAdminSection("sales", true);
  });

  startAdminAutoRefresh();
  if (token) markAdminRefreshed();
}

ensureCustomPrintRange();
ensureAdminSections();
bindAdminEnhancements();
