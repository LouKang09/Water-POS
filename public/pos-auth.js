const POS_TOKEN_KEY = "water_pos_user_token";
const posToken = localStorage.getItem(POS_TOKEN_KEY) || "";

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

(async function verifyPosSession(){
  if (!posToken || location.pathname === "/pos-login.html") return;
  try {
    const res = await window.fetch("/api/pos/me", { cache: "no-store" });
    if (!res.ok) throw new Error("session");
    const user = await res.json();
    const label = document.querySelector("#posUserLabel");
    if (label) label.textContent = user.name || user.email || "POS User";
    document.documentElement.classList.add("pos-auth-ready");
  } catch {
    localStorage.removeItem(POS_TOKEN_KEY);
    location.replace("/pos-login.html");
  }
})();

document.addEventListener("click", event => {
  const button = event.target.closest("#posLogoutBtn");
  if (!button) return;
  localStorage.removeItem(POS_TOKEN_KEY);
  location.replace("/pos-login.html");
});
