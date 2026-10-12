/* Appearance preferences shared by the POS, login, and Android WebView. */
(function () {
  "use strict";
  const KEY = "water_pos_appearance";
  const MODES = ["system", "light", "dark"];
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const root = document.documentElement;

  function readMode() {
    let stored = "system";
    try { stored = localStorage.getItem(KEY) || "system"; } catch (error) {}
    return MODES.includes(stored) ? stored : "system";
  }
  let preferredMode = readMode();

  function effectiveMode() {
    return preferredMode === "system" ? (media.matches ? "dark" : "light") : preferredMode;
  }

  function syncTheme() {
    const effective = effectiveMode();
    root.dataset.posTheme = effective;
    root.dataset.posMode = preferredMode;
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute("content", effective === "dark" ? "#08141e" : "#0d6b69");

    document.querySelectorAll(".pos-theme-trigger").forEach(function (button) {
      const symbol = button.querySelector(".theme-glyph");
      const text = button.querySelector(".theme-word");
      if (symbol) symbol.textContent = effective === "dark" ? "☾" : "☀";
      if (text) text.textContent = "Appearance";
      button.setAttribute("aria-label", "Appearance: " + preferredMode + ". Change theme");
      button.setAttribute("title", "Appearance: " + preferredMode);
    });
    document.querySelectorAll(".theme-choice").forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.dataset.mode === preferredMode));
    });
  }

  function selectTheme(mode) {
    if (!MODES.includes(mode)) return;
    preferredMode = mode;
    try { localStorage.setItem(KEY, preferredMode); } catch (error) {}
    syncTheme();
    const dialog = document.getElementById("posAppearanceDialog");
    if (dialog && dialog.open) dialog.close();
  }

  function createAppearanceDialog() {
    if (document.getElementById("posAppearanceDialog")) return;
    const dialog = document.createElement("dialog");
    dialog.id = "posAppearanceDialog";
    dialog.className = "pos-appearance-dialog";
    dialog.setAttribute("aria-labelledby", "appearanceHeading");
    dialog.innerHTML =
      '<div class="pos-appearance-card">' +
      ' <div class="appearance-heading">' +
      '  <div><p class="eyebrow">MAKE IT YOURS</p><h2 id="appearanceHeading">Appearance</h2>' +
      '  <p>Choose a comfortable look for your Water POS.</p></div>' +
      '  <button type="button" id="closeAppearance" class="appearance-close" aria-label="Close appearance settings">×</button>' +
      ' </div>' +
      ' <div class="appearance-grid" role="group" aria-label="Color theme">' +
      '  <button type="button" class="theme-choice" data-mode="light" aria-pressed="false">' +
      '   <span class="theme-choice-preview" aria-hidden="true"></span>' +
      '   <span class="theme-choice-copy"><strong>Light</strong><small>Fresh, bright and clean.</small></span>' +
      '   <span class="theme-choice-check" aria-hidden="true">✓</span></button>' +
      '  <button type="button" class="theme-choice" data-mode="dark" aria-pressed="false">' +
      '   <span class="theme-choice-preview" aria-hidden="true"></span>' +
      '   <span class="theme-choice-copy"><strong>Dark</strong><small>Deep ocean colors, easy on the eyes.</small></span>' +
      '   <span class="theme-choice-check" aria-hidden="true">✓</span></button>' +
      '  <button type="button" class="theme-choice" data-mode="system" aria-pressed="false">' +
      '   <span class="theme-choice-preview" aria-hidden="true"></span>' +
      '   <span class="theme-choice-copy"><strong>System</strong><small>Match your phone or browser setting.</small></span>' +
      '   <span class="theme-choice-check" aria-hidden="true">✓</span></button>' +
      ' </div>' +
      ' <p class="appearance-footnote">Your choice is saved on this device and also applies to the sign-in screen.</p>' +
      '</div>';
    document.body.appendChild(dialog);
    dialog.querySelector("#closeAppearance").addEventListener("click", function () { dialog.close(); });
    dialog.querySelectorAll(".theme-choice").forEach(function (button) {
      button.addEventListener("click", function () { selectTheme(button.dataset.mode); });
    });
    syncTheme();
  }

  function showAppearance() {
    createAppearanceDialog();
    const dialog = document.getElementById("posAppearanceDialog");
    if (!dialog.open) dialog.showModal();
  }

  // Apply saved appearance before rendering the first page frame.
  syncTheme();

  function onSystemChange() {
    if (preferredMode === "system") syncTheme();
  }
  if (media.addEventListener) media.addEventListener("change", onSystemChange);
  else if (media.addListener) media.addListener(onSystemChange);

  document.addEventListener("click", function (event) {
    if (event.target.closest(".pos-theme-trigger")) showAppearance();
  });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { createAppearanceDialog(); syncTheme(); }, { once: true });
  } else {
    createAppearanceDialog();
    syncTheme();
  }

  window.WaterPosTheme = { choose: selectTheme, current: function () { return preferredMode; } };
})();