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

function ensureAdminUserControl() {
  const nav = document.querySelector(".side-nav");
  if (nav && !nav.querySelector('[data-section="account"]')) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.section = "account";
    button.textContent = "User Control";
    nav.appendChild(button);
  }

  if (!document.querySelector("#accountSection")) {
    const main = document.querySelector(".admin-main");
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
            <small>Optional. Use at least 10 characters if changing it.</small>
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

      <div class="panel account-control-panel" style="margin-top:16px">
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
}

function adminSectionTitle(section) {
  return {
    sales: "Sales & Dashboard",
    expenses: "Expenses",
    used: "Used Pricing",
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
            <strong>POS User #${user.id}</strong>
            <small>Last login: ${escapeHtml(lastLogin)}</small>
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
            <small>Optional. Use at least 8 characters if changing it.</small>
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

ensureAdminUserControl();
bindAdminEnhancements();
