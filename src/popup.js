/**
 * Logique du popup :
 *  - charge / enregistre la configuration (adresse de départ + clé API) ;
 *  - affiche le dernier résultat calculé (mis en cache par background.js) ;
 *  - permet de relancer le calcul sur l'onglet actif.
 */

const els = {
  resultSection: document.getElementById("result-section"),
  emptySection: document.getElementById("empty-section"),
  duration: document.getElementById("duration"),
  distance: document.getElementById("distance"),
  districtRow: document.getElementById("district-row"),
  districtLabel: document.getElementById("district-label"),
  startLabel: document.getElementById("start-label"),
  propertyLabel: document.getElementById("property-label"),
  timestamp: document.getElementById("timestamp"),
  recompute: document.getElementById("recompute"),
  config: document.getElementById("config"),
  startAddress: document.getElementById("start-address"),
  apiKey: document.getElementById("api-key"),
  save: document.getElementById("save"),
  saveStatus: document.getElementById("save-status"),
};

/* --------------------------- Chargement --------------------------- */

async function init() {
  const { orsApiKey, startAddress, lastResult } =
    await chrome.storage.local.get(["orsApiKey", "startAddress", "lastResult"]);

  if (startAddress) els.startAddress.value = startAddress;
  if (orsApiKey) els.apiKey.value = orsApiKey;

  // Si tout est configuré, on replie le bloc config.
  if (orsApiKey && startAddress) {
    els.config.open = false;
  }

  renderResult(lastResult);
}

function renderResult(result) {
  if (!result || !result.ok) {
    els.resultSection.classList.add("hidden");
    els.emptySection.classList.remove("hidden");
    return;
  }
  els.emptySection.classList.add("hidden");
  els.resultSection.classList.remove("hidden");

  els.duration.textContent = result.durationText;
  els.distance.textContent = result.distanceText;

  const district = result.district || result.city;
  if (district) {
    els.districtLabel.textContent = district;
    els.districtRow.classList.remove("hidden");
  } else {
    els.districtRow.classList.add("hidden");
  }

  els.startLabel.textContent = result.startAddress || "—";
  els.propertyLabel.textContent = result.propertyLabel || "—";
  els.timestamp.textContent = "Calculé " + timeAgo(result.timestamp);
}

function timeAgo(ts) {
  if (!ts) return "";
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return "à l'instant";
  const min = Math.round(sec / 60);
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  return `il y a ${h} h`;
}

/* --------------------------- Enregistrer -------------------------- */

els.save.addEventListener("click", async () => {
  const startAddress = els.startAddress.value.trim();
  const orsApiKey = els.apiKey.value.trim();

  if (!startAddress || !orsApiKey) {
    setStatus("Renseignez l'adresse et la clé API.", "error");
    return;
  }

  // Enregistre et invalide le cache des coordonnées de départ.
  await chrome.storage.local.set({
    startAddress,
    orsApiKey,
    startCoords: null,
  });

  setStatus("Configuration enregistrée ✓", "ok");
});

function setStatus(text, kind) {
  els.saveStatus.textContent = text;
  els.saveStatus.className = "status " + (kind || "");
}

/* --------------------------- Recalcul ----------------------------- */

els.recompute.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (!tab || !tab.url || !/:\/\/[^/]*seloger\.com/.test(tab.url)) {
    setStatus("Ouvrez d'abord une page SeLoger.", "error");
    els.config.open = true;
    return;
  }

  els.recompute.textContent = "Calcul…";
  chrome.tabs.sendMessage(tab.id, { type: "RECOMPUTE" }, () => {
    // On ignore une éventuelle erreur (content script pas encore prêt).
    void chrome.runtime.lastError;
    // Recharge le résultat après un court délai.
    setTimeout(async () => {
      const { lastResult } = await chrome.storage.local.get(["lastResult"]);
      renderResult(lastResult);
      els.recompute.textContent = "Recalculer sur l'onglet actif";
    }, 1500);
  });
});

/* ---------------- Mise à jour en direct du résultat --------------- */

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.lastResult) {
    renderResult(changes.lastResult.newValue);
  }
});

init();
