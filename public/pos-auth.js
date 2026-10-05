const POS_TOKEN_KEY = "water_pos_user_token";
let posToken = localStorage.getItem(POS_TOKEN_KEY) || "";
let currentPosUser = null;

if (!posToken && location.pathname !== "/pos-login.html") {
  location.replace("/pos-login.html");
}

const nativeFetch = window.fetch.bind(window);
const protectedPrefixes = ["/api/sales", "/api/pos/"];

window.fetch = function(input, init = {}) {
  const url = typeof input === "string" ? input : input.url;
  const sameOriginProtected = protectedPrefixes.some(prefix => String(url).startsWith(prefix));
  if (sameOriginProtected && posToken) {
    init = { ...init, headers: { ...(init.headers || {}), Authorization: "Bearer " + posToken } };
  }
  return nativeFetch(input, init).then(response => {
    if (sameOriginProtected && response.status === 401 && location.pathname !== "/pos-login.html") {
      localStorage.removeItem(POS_TOKEN_KEY);
      location.replace("/pos-login.html");
    }
    return response;
  });
};

const nativeOpen = window.open.bind(window);
window.open = function(url, target, features) {
  const value = String(url || "");
  if (value.startsWith("/api/pos/queue/") && value.endsWith("/receipt") && posToken) {
    const popup = nativeOpen("", target || "_blank", features);
    window.fetch(value)
      .then(res => {
        if (!res.ok) throw new Error("Unable to load receipt.");
        return res.blob();
      })
      .then(blob => {
        const objectUrl = URL.createObjectURL(blob);
        if (popup) popup.location.href = objectUrl;
      })
      .catch(() => { if (popup) popup.close(); });
    return popup;
  }
  return nativeOpen(url, target, features);
};

function addPosPasswordToggle(input) {
  if (!input || input.parentElement.classList.contains("pos-account-password")) return;
  const wrap = document.createElement("div");
  wrap.className = "pos-account-password";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pos-account-toggle";
  button.textContent = "Show";
  button.setAttribute("aria-label", "Show password");
  button.addEventListener("click", () => {
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    button.textContent = showing ? "Show" : "Hide";
    button.setAttribute("aria-label", showing ? "Show password" : "Hide password");
  });
  wrap.appendChild(button);
}

function ensurePosAccountUi() {
  if (!document.querySelector('link[data-pos-account-style]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/pos-account.css?v=20261006-1";
    link.dataset.posAccountStyle = "true";
    document.head.appendChild(link);
  }

  const actions = document.querySelector(".pos-header-actions");
  if (actions && !document.querySelector("#posAccountBtn")) {
    const button = document.createElement("button");
    button.id = "posAccountBtn";
    button.type = "button";
    button.className = "admin-link pos-account-button";
    button.textContent = "Account";
    const logout = document.querySelector("#posLogoutBtn");
    actions.insertBefore(button, logout || null);
  }

  if (!document.querySelector("#posAccountDialog")) {
    const dialog = document.createElement("dialog");
    dialog.id = "posAccountDialog";
    dialog.className = "pos-account-dialog";
    dialog.innerHTML = `
      <div class="pos-account-card">
        <div class="pos-account-head">
          <div>
            <p class="eyebrow">POS ACCOUNT</p>
            <h2>Update Login</h2>
            <p>Change the email or password used to sign in to Water POS.</p>
          </div>
          <button id="closePosAccount" class="icon-button" type="button" aria-label="Close">×</button>
        </div>
        <form id="posAccountForm" class="pos-account-form">
          <label class="field">
            <span>Email</span>
            <input id="posAccountEmail" type="email" required autocomplete="username">
          </label>
          <label class="field">
            <span>Current Password</span>
            <input id="posAccountCurrentPassword" type="password" required autocomplete="current-password" placeholder="Required to save changes">
          </label>
          <label class="field">
            <span>New Password</span>
            <input id="posAccountNewPassword" type="password" minlength="8" autocomplete="new-password" placeholder="Leave blank to keep current password">
            <small>Optional · use at least 8 characters if changing it.</small>
          </label>
          <label class="field">
            <span>Confirm New Password</span>
            <input id="posAccountConfirmPassword" type="password" minlength="8" autocomplete="new-password" placeholder="Repeat new password">
          </label>
          <div id="posAccountError" class="pos-account-error"></div>
          <div class="pos-account-actions">
            <button id="cancelPosAccount" class="small-button" type="button">Cancel</button>
            <button id="savePosAccount" class="primary-button" type="submit">Save Login</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(dialog);

    addPosPasswordToggle(document.querySelector("#posAccountCurrentPassword"));
    addPosPasswordToggle(document.querySelector("#posAccountNewPassword"));
    addPosPasswordToggle(document.querySelector("#posAccountConfirmPassword"));
  }
}

function openPosAccount() {
  ensurePosAccountUi();
  const dialog = document.querySelector("#posAccountDialog");
  document.querySelector("#posAccountEmail").value = currentPosUser?.email || "";
  document.querySelector("#posAccountCurrentPassword").value = "";
  document.querySelector("#posAccountNewPassword").value = "";
  document.querySelector("#posAccountConfirmPassword").value = "";
  document.querySelector("#posAccountError").textContent = "";
  dialog.showModal();
}

async function savePosAccount(event) {
  event.preventDefault();
  const errorEl = document.querySelector("#posAccountError");
  const newPassword = document.querySelector("#posAccountNewPassword").value;
  const confirmPassword = document.querySelector("#posAccountConfirmPassword").value;
  errorEl.textContent = "";
  if (newPassword !== confirmPassword) {
    errorEl.textContent = "New passwords do not match.";
    return;
  }

  const button = document.querySelector("#savePosAccount");
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const res = await window.fetch("/api/pos/account", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: document.querySelector("#posAccountEmail").value.trim(),
        currentPassword: document.querySelector("#posAccountCurrentPassword").value,
        newPassword
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Unable to update POS login.");

    posToken = data.token;
    localStorage.setItem(POS_TOKEN_KEY, posToken);
    currentPosUser = data.user;
    const label = document.querySelector("#posUserLabel");
    if (label) label.textContent = currentPosUser.name || currentPosUser.email || "POS User";
    document.querySelector("#posAccountDialog").close();
    if (typeof toast === "function") {
      toast(data.passwordChanged ? "Email and password updated." : "Email updated.");
    }
  } catch (error) {
    errorEl.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "Save Login";
  }
}

ensurePosAccountUi();
document.querySelector("#posAccountForm")?.addEventListener("submit", savePosAccount);
document.querySelector("#closePosAccount")?.addEventListener("click", () => document.querySelector("#posAccountDialog")?.close());
document.querySelector("#cancelPosAccount")?.addEventListener("click", () => document.querySelector("#posAccountDialog")?.close());

document.addEventListener("click", event => {
  const accountButton = event.target.closest("#posAccountBtn");
  if (accountButton) {
    openPosAccount();
    return;
  }
  const logoutButton = event.target.closest("#posLogoutBtn");
  if (!logoutButton) return;
  localStorage.removeItem(POS_TOKEN_KEY);
  location.replace("/pos-login.html");
});

(async function verifyPosSession(){
  if (!posToken || location.pathname === "/pos-login.html") return;
  try {
    const res = await window.fetch("/api/pos/me", { cache: "no-store" });
    if (!res.ok) throw new Error("session");
    currentPosUser = await res.json();
    const label = document.querySelector("#posUserLabel");
    if (label) label.textContent = currentPosUser.name || currentPosUser.email || "POS User";
    document.documentElement.classList.add("pos-auth-ready");
  } catch {
    localStorage.removeItem(POS_TOKEN_KEY);
    location.replace("/pos-login.html");
  }
})();
