const POS_TOKEN_KEY = "water_pos_user_token";
let setupMode = false;

const $ = selector => document.querySelector(selector);

async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function setSetupMode(enabled) {
  setupMode = enabled;
  $("#setupNotice").classList.toggle("hidden", !enabled);
  $("#nameField").classList.toggle("hidden", !enabled);
  $("#confirmField").classList.toggle("hidden", !enabled);
  $("#posName").required = enabled;
  $("#posConfirmPassword").required = enabled;
  $("#posPassword").autocomplete = enabled ? "new-password" : "current-password";
  $("#loginSubtitle").textContent = enabled ? "Create the first POS user" : "POS user sign in";
  $("#posLoginButton").textContent = enabled ? "Create POS User" : "Log in to POS";
}

function bindPasswordVisibility(){
  document.querySelectorAll(".pos-password-toggle").forEach(button=>{
    button.addEventListener("click",()=>{
      const input=document.getElementById(button.dataset.target);
      if(!input) return;
      const showing=input.type==="text";
      input.type=showing?"password":"text";
      button.textContent=showing?"Show":"Hide";
      button.setAttribute("aria-label",showing?"Show password":"Hide password");
    });
  });
}

$("#posLoginForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("#posLoginError").textContent = "";
  const email = $("#posEmail").value.trim();
  const password = $("#posPassword").value;

  if (setupMode && password !== $("#posConfirmPassword").value) {
    $("#posLoginError").textContent = "Passwords do not match.";
    return;
  }

  const button = $("#posLoginButton");
  button.disabled = true;
  button.textContent = setupMode ? "Creating…" : "Logging in…";

  try {
    const result = setupMode
      ? await api("/api/pos/setup", {
          method: "POST",
          body: JSON.stringify({ name: $("#posName").value.trim(), email, password })
        })
      : await api("/api/pos/login", {
          method: "POST",
          body: JSON.stringify({ email, password })
        });

    localStorage.setItem(POS_TOKEN_KEY, result.token);
    location.replace("/");
  } catch (error) {
    $("#posLoginError").textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = setupMode ? "Create POS User" : "Log in to POS";
  }
});

bindPasswordVisibility();

(async function init(){
  const existing = localStorage.getItem(POS_TOKEN_KEY);
  if (existing) {
    try {
      const res = await fetch("/api/pos/me", { headers: { Authorization: "Bearer " + existing }, cache: "no-store" });
      if (res.ok) return location.replace("/");
    } catch {}
    localStorage.removeItem(POS_TOKEN_KEY);
  }

  try {
    const status = await api("/api/pos/setup-status");
    setSetupMode(Boolean(status.needsSetup));
  } catch (error) {
    $("#posLoginError").textContent = "Unable to load POS login. Please try again.";
  }
})();
