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
  $("#forgotPasswordButton").classList.toggle("hidden", enabled);
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


function resetForgotUi(){
  $("#forgotRequestForm").classList.remove("hidden");
  $("#forgotResetForm").classList.add("hidden");
  $("#forgotRequestError").textContent="";
  $("#forgotResetError").textContent="";
  $("#forgotOtp").value="";
  $("#forgotNewPassword").value="";
  $("#forgotConfirmPassword").value="";
}

function openForgotPassword(){
  resetForgotUi();
  $("#forgotEmail").value=$("#posEmail").value.trim();
  $("#forgotPasswordDialog").showModal();
  setTimeout(()=>$("#forgotEmail").focus(),50);
}

async function sendForgotOtp(event){
  if(event) event.preventDefault();
  const email=$("#forgotEmail").value.trim();
  const button=$("#sendForgotOtp");
  $("#forgotRequestError").textContent="";
  button.disabled=true;
  button.textContent="Sending OTP…";
  try{
    const result=await api("/api/pos/forgot-password/request",{
      method:"POST",
      body:JSON.stringify({email})
    });
    $("#forgotRequestForm").classList.add("hidden");
    $("#forgotResetForm").classList.remove("hidden");
    $("#forgotSentTo").textContent=email;
    $("#forgotOtp").focus();
  }catch(error){
    $("#forgotRequestError").textContent=error.message;
  }finally{
    button.disabled=false;
    button.textContent="Send OTP";
  }
}

async function resetForgotPassword(event){
  event.preventDefault();
  const email=$("#forgotEmail").value.trim();
  const code=$("#forgotOtp").value.replace(/\D/g,"").slice(0,6);
  const newPassword=$("#forgotNewPassword").value;
  const confirmPassword=$("#forgotConfirmPassword").value;
  const errorEl=$("#forgotResetError");
  errorEl.textContent="";

  if(code.length!==6){
    errorEl.textContent="Enter the 6-digit OTP from your email.";
    return;
  }
  if(newPassword.length<8){
    errorEl.textContent="Use at least 8 characters for the new password.";
    return;
  }
  if(newPassword!==confirmPassword){
    errorEl.textContent="New passwords do not match.";
    return;
  }

  const button=$("#resetForgotPassword");
  button.disabled=true;
  button.textContent="Updating…";
  try{
    const result=await api("/api/pos/forgot-password/reset",{
      method:"POST",
      body:JSON.stringify({email,code,newPassword})
    });
    $("#forgotPasswordDialog").close();
    $("#posEmail").value=email;
    $("#posPassword").value="";
    $("#posLoginError").textContent="";
    $("#posLoginSuccess").textContent=result.message||"Password updated. Sign in with your new password.";
    setTimeout(()=>$("#posPassword").focus(),80);
  }catch(error){
    errorEl.textContent=error.message;
  }finally{
    button.disabled=false;
    button.textContent="Update Password";
  }
}

$("#posLoginForm").addEventListener("submit", async event => {
  event.preventDefault();
  $("#posLoginError").textContent = "";
  $("#posLoginSuccess").textContent = "";
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

$("#forgotPasswordButton").addEventListener("click",openForgotPassword);
$("#closeForgotPassword").addEventListener("click",()=>$("#forgotPasswordDialog").close());
$("#forgotRequestForm").addEventListener("submit",sendForgotOtp);
$("#forgotResetForm").addEventListener("submit",resetForgotPassword);
$("#resendForgotOtp").addEventListener("click",()=>{
  $("#forgotResetForm").classList.add("hidden");
  $("#forgotRequestForm").classList.remove("hidden");
  $("#forgotRequestError").textContent="";
  $("#forgotResetError").textContent="";
});
$("#forgotOtp").addEventListener("input",event=>{
  event.target.value=event.target.value.replace(/\D/g,"").slice(0,6);
});
$("#forgotPasswordDialog").addEventListener("cancel",event=>{
  event.preventDefault();
  $("#forgotPasswordDialog").close();
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
