/**
 * Logique du popup.
 *
 * Trois responsabilités, dans cet ordre d'importance :
 *  1. authentifier l'extension (« S'authentifier » puis page de consentement) ;
 *  2. enregistrer l'annonce de l'onglet actif dans un projet du carnet ;
 *  3. afficher le dernier temps de trajet calculé et ses réglages.
 *
 * Aucun appel réseau ici : tout passe par le service worker, qui garde la clé
 * de session et termine le travail même si cette fenêtre se referme.
 */

const els = {};
for (const id of [
  "account",
  "account-email",
  "disconnect",
  "page-banner",
  "auth-card",
  "auth-status",
  "connect",
  "signup-link",
  "carnet-link",
  "save-card",
  "save-unavailable",
  "saved-badge",
  "listing",
  "listing-photo",
  "listing-title",
  "listing-meta",
  "listing-partial",
  "listing-link",
  "project-field",
  "project",
  "project-new",
  "project-create",
  "project-name",
  "project-add",
  "save",
  "save-status",
  "result-section",
  "empty-section",
  "trips",
  "trips-project",
  "district-row",
  "district-label",
  "city-row",
  "city-tag",
  "city-link",
  "start-label",
  "property-label",
  "commune-section",
  "prices-row",
  "price-maison-box",
  "price-maison",
  "price-appt-box",
  "price-appt",
  "politics-row",
  "politics-label",
  "bar-gauche",
  "bar-centre",
  "bar-droite",
  "pct-gauche",
  "pct-centre",
  "pct-droite",
  "taxe-row",
  "taxe-dots",
  "taxe-index",
  "timestamp",
  "recompute",
  "footer-hint",
]) {
  els[id] = document.getElementById(id);
}

let activeTab = null;
let page = { supported: false };
/** Dernier calcul de trajet mis en cache par le service worker. */
let cachedLastResult = null;

/* ---------------------- Pont vers le service worker --------------------- */

/** Renvoie les données du handler, ou lève une erreur portant son code. */
function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error("Extension indisponible. Rouvrez cette fenêtre."));
        return;
      }
      if (!response) {
        reject(new Error("Aucune réponse de l'extension."));
        return;
      }
      if (!response.ok) {
        const error = new Error(response.error);
        error.code = response.code;
        reject(error);
        return;
      }
      resolve(response.data);
    });
  });
}

function show(element, visible) {
  element.classList.toggle("hidden", !visible);
}

/** Affiche un petit loader et un libellé dans un bouton le temps d'un traitement. */
function setButtonLoading(button, text) {
  button.replaceChildren();
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  spinner.setAttribute("aria-hidden", "true");
  button.appendChild(spinner);
  button.append(text);
}

function setStatus(element, text, kind = "") {
  element.textContent = text || "";
  element.classList.remove("is-ok", "is-error");
  if (kind) element.classList.add(kind);
}

/* ------------------------------- Formats -------------------------------- */

function formatNumber(value) {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
}

function formatEuro(value) {
  return `${formatNumber(value)} €`;
}

function timeAgo(timestamp) {
  if (!timestamp) return "";
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "à l'instant";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `il y a ${hours} h`;
}

/* --------------------------- Compte et session -------------------------- */

async function refreshAccount() {
  let state;
  try {
    state = await send("CARNET_STATE");
  } catch (err) {
    setStatus(els["auth-status"], err.message, "is-error");
    await refreshPage();
    return;
  }

  els["carnet-link"].href = `${state.baseUrl}/listings`;
  els["signup-link"].href = `${state.baseUrl}/signup`;
  els["account-email"].textContent = state.email || "";
  els["account-email"].title = state.email || "";

  show(els.account, state.connected);
  show(els["auth-card"], !state.connected);
  show(els["save-card"], state.connected);

  await refreshPage();
}

els.connect.addEventListener("click", async () => {
  els.connect.disabled = true;
  els.connect.textContent = "Autorisation en cours…";
  setStatus(els["auth-status"], "Validez l'autorisation dans la fenêtre qui s'ouvre.");

  try {
    await send("CARNET_CONNECT");
    await refreshAccount();
  } catch (err) {
    // La popup se referme souvent pendant l'autorisation : dans ce cas ce code
    // ne s'exécute pas, et l'état connecté s'affiche à la prochaine ouverture.
    setStatus(els["auth-status"], err.message, "is-error");
  } finally {
    els.connect.disabled = false;
    els.connect.textContent = "S'authentifier";
  }
});

els.disconnect.addEventListener("click", async () => {
  els.disconnect.disabled = true;
  try {
    await send("CARNET_DISCONNECT");
    await refreshAccount();
  } finally {
    els.disconnect.disabled = false;
  }
});

/* ---------------------------- Annonce de l'onglet ----------------------- */

async function refreshPage() {
  setStatus(els["save-status"], "");
  show(els["listing-link"], false);

  try {
    page = await send("CARNET_PAGE", { tabId: activeTab ? activeTab.id : null });
  } catch (err) {
    page = { supported: false, error: err.message };
  }

  renderPage();

  if (page.supported && page.listing) await loadProjects();
}

function isSupportedListingHost(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      CARNET_SUPPORTED_HOSTS.test(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function isListingDetailTab(url = activeTab?.url) {
  return Boolean(
    url && typeof CarnetListingPage !== "undefined" &&
      CarnetListingPage.isListingDetailUrl(url)
  );
}

function isReadableListingPage(state = page) {
  if (!isListingDetailTab()) return false;
  return Boolean(state.supported && state.listing);
}

/** Message affiché quand l'onglet actif n'est pas une annonce exploitable. */
function pageContextMessage(state = page) {
  if (state.error) return state.error;
  if (!activeTab?.url) {
    return "Aucun onglet actif à analyser.";
  }
  if (!isSupportedListingHost(activeTab.url)) {
    return "Cette page n'est pas une annonce SeLoger, Belles Demeures ou Leboncoin.";
  }
  if (!isListingDetailTab(activeTab.url)) {
    return "Cette page n'est pas une fiche annonce (accueil, résultats de recherche…). Ouvrez le détail d'un bien.";
  }
  if (state.supported && !state.listing) {
    return "Annonce illisible sur cette page. Rechargez la fiche du bien, puis rouvrez l'extension.";
  }
  return "Ouvrez une annonce SeLoger, Belles Demeures ou Leboncoin pour utiliser l'extension.";
}

function renderPageBanner() {
  if (isReadableListingPage()) {
    show(els["page-banner"], false);
    els["page-banner"].textContent = "";
    return;
  }

  els["page-banner"].textContent = pageContextMessage();
  show(els["page-banner"], true);
}

function renderPage() {
  const listing = page.listing;
  const readable = isReadableListingPage();

  renderPageBanner();

  show(els.listing, readable);
  show(els["project-field"], readable);
  show(els.save, readable);
  show(els["saved-badge"], readable && page.saved);
  show(els["listing-link"], Boolean(page.webUrl));
  if (page.webUrl) els["listing-link"].href = page.webUrl;

  if (!readable) {
    show(els["project-create"], false);
    show(els["save-unavailable"], false);
    updateTravelSection();
    return;
  }

  show(els["save-unavailable"], false);

  els["listing-title"].textContent = listing.title || "Annonce sans titre";

  const parts = [];
  if (listing.price) parts.push(formatEuro(listing.price));
  if (listing.surface) parts.push(`${formatNumber(listing.surface)} m²`);
  if (listing.rooms) parts.push(`${listing.rooms} pièces`);
  const place = [listing.city, listing.postalCode].filter(Boolean).join(" ");
  if (place) parts.push(place);
  els["listing-meta"].textContent = parts.join(" · ") || listing.source;

  if (listing.photo) {
    els["listing-photo"].src = listing.photo;
    els["listing-photo"].hidden = false;
  } else {
    els["listing-photo"].hidden = true;
  }

  show(els["listing-partial"], listing.partial);
  els.save.textContent = page.saved
    ? "Mettre à jour l'annonce"
    : "Sauvegarder l'annonce";

  updateTravelSection();
}

/* -------------------------------- Projets ------------------------------- */

async function loadProjects() {
  try {
    const { projects, selectedId } = await send("CARNET_PROJECTS");
    els.project.replaceChildren(
      ...projects.map((project) => {
        const option = document.createElement("option");
        option.value = String(project.id);
        option.textContent = project.name;
        option.selected = project.id === selectedId;
        return option;
      })
    );
  } catch (err) {
    setStatus(els["save-status"], err.message, "is-error");
  }
}

function selectedProjectId() {
  const value = Number(els.project.value);
  return Number.isInteger(value) && value > 0 ? value : null;
}

// Choisir un projet le mémorise, et recalcule le trajet vers ses adresses.
els.project.addEventListener("change", async () => {
  try {
    await send("CARNET_REMEMBER_PROJECT", { projectId: selectedProjectId() });
  } catch (e) {
    return;
  }
  recomputeActiveTab();
});

els["project-new"].addEventListener("click", () => {
  const opening = els["project-create"].classList.contains("hidden");
  show(els["project-create"], opening);
  if (opening) els["project-name"].focus();
});

async function createProject() {
  const name = els["project-name"].value.trim();
  if (!name) {
    els["project-name"].focus();
    return;
  }

  els["project-add"].disabled = true;
  try {
    const project = await send("CARNET_CREATE_PROJECT", { name });
    await send("CARNET_REMEMBER_PROJECT", { projectId: project.id });
    els["project-name"].value = "";
    show(els["project-create"], false);
    await loadProjects();
    setStatus(els["save-status"], `Projet « ${project.name} » créé.`, "is-ok");
  } catch (err) {
    setStatus(els["save-status"], err.message, "is-error");
  } finally {
    els["project-add"].disabled = false;
  }
}

els["project-add"].addEventListener("click", createProject);
els["project-name"].addEventListener("keydown", (event) => {
  if (event.key === "Enter") createProject();
});

/* ------------------------------ Sauvegarde ------------------------------ */

els.save.addEventListener("click", async () => {
  els.save.disabled = true;
  setButtonLoading(els.save, "Enregistrement…");
  setStatus(els["save-status"], "");

  try {
    const result = await send("CARNET_SAVE", {
      tabId: activeTab.id,
      projectId: selectedProjectId(),
    });

    page.saved = true;
    page.webUrl = result.webUrl;

    const project = (result.projects || [])[0];
    const destination = project ? ` dans « ${project.name} »` : "";
    const changed = result.priceChanged
      ? " Le prix a changé depuis la dernière capture."
      : "";
    setStatus(
      els["save-status"],
      `${result.created ? "Annonce enregistrée" : "Annonce mise à jour"}${destination}.${changed}`,
      "is-ok"
    );
  } catch (err) {
    setStatus(els["save-status"], err.message, "is-error");
    // Session révoquée depuis le site : on revient à l'écran d'authentification.
    if (err.code === "not_connected") await refreshAccount();
  } finally {
    els.save.disabled = false;
    // `renderPage` repose le libellé du bouton selon l'état de l'annonce.
    renderPage();
  }
});

/* ---------------------------- Temps de trajet --------------------------- */

/** Message court pour une destination dont le trajet n'a pas pu être calculé. */
function tripErrorText(code) {
  switch (code) {
    case "destination_unresolved":
      return "Adresse introuvable";
    case "no_route":
      return "Pas d'itinéraire routier";
    case "travel_upstream":
      return "Temporairement indisponible";
    default:
      return "Calcul impossible";
  }
}

/** Une ligne de trajet par adresse de référence du projet. */
function renderTrips(result) {
  const trips = result.trips || [];
  els.trips.replaceChildren();

  // Projet sans adresse de référence : message compact plutôt qu'une liste
  // vide, qui laisserait un gros blanc avant les labels de commune.
  if (!trips.length) {
    const empty = document.createElement("li");
    empty.className = "trips__empty";
    empty.append("Aucune adresse de référence pour ce projet. ");

    const project = result.project;
    const base = result.baseUrl || "";
    const link = document.createElement("a");
    link.href = project ? `${base}/projects/${project.id}` : `${base}/projects`;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Ajouter une adresse ↗";
    empty.appendChild(link);

    els.trips.appendChild(empty);
    return;
  }

  for (const trip of trips) {
    const row = document.createElement("li");
    row.className = "trip";

    const head = document.createElement("div");
    head.className = "trip__head";
    const label = document.createElement("span");
    label.className = "trip__label";
    label.textContent = trip.label || "Destination";
    head.appendChild(label);

    if (trip.error) {
      const err = document.createElement("span");
      err.className = "trip__error";
      err.textContent = tripErrorText(trip.error);
      head.appendChild(err);
      row.appendChild(head);
    } else {
      const value = document.createElement("span");
      value.className = "trip__value";
      value.textContent = trip.durationText;
      head.appendChild(value);
      row.appendChild(head);

      const meta = document.createElement("div");
      meta.className = "trip__meta";
      const dist = document.createElement("span");
      dist.textContent = trip.distanceText;
      meta.appendChild(dist);
      if (trip.mapsUrl) {
        const link = document.createElement("a");
        link.href = trip.mapsUrl;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "Voir le trajet ↗";
        meta.appendChild(link);
      }
      row.appendChild(meta);
    }

    els.trips.appendChild(row);
  }
}

function renderResult(result) {
  cachedLastResult = result ?? null;
  updateTravelSection();
}

function updateTravelSection() {
  const showTravel = isReadableListingPage();
  show(els.recompute, showTravel);
  show(els["footer-hint"], showTravel);

  if (!showTravel) {
    show(els["result-section"], false);
    show(els["empty-section"], false);
    return;
  }

  const result = cachedLastResult;
  if (!result || !result.ok) {
    show(els["result-section"], false);
    show(els["empty-section"], true);
    const hint = els["empty-section"].querySelector("p");
    if (hint) {
      hint.textContent =
        "Le temps de trajet s'affichera ici une fois calculé sur la page de l'annonce.";
    }
    return;
  }

  show(els["empty-section"], false);
  show(els["result-section"], true);
  renderTravelResultContent(result);
}

function renderTravelResultContent(result) {
  els["trips-project"].textContent = result.project
    ? `Projet « ${result.project.name} »`
    : "";
  renderTrips(result);

  const city = result.city || null;
  const district = result.district || null;
  if (district && city && district !== city) {
    els["district-label"].textContent = district;
    show(els["district-row"], true);
  } else {
    show(els["district-row"], false);
  }

  const placeName = city || district;
  const mapsUrl = mapsUrlFor(result);
  if (placeName && mapsUrl) {
    els["city-tag"].textContent = city ? "Ville" : "Quartier";
    els["city-link"].textContent = placeName;
    els["city-link"].href = mapsUrl;
    els["city-link"].title = `Ouvrir ${placeName} dans Google Maps`;
    show(els["city-row"], true);
  } else {
    show(els["city-row"], false);
  }

  els["property-label"].textContent = result.propertyLabel || "—";

  renderCommune(result);
  els.timestamp.textContent = `Calculé ${timeAgo(result.timestamp)}`;
}

/** Prix médians, orientation politique et indice de taxe foncière. */
function renderCommune(result) {
  const prices = result.prices;
  const hasPrices = Boolean(prices && (prices.maison || prices.appt));
  if (hasPrices) {
    if (prices.maison) {
      els["price-maison"].textContent = `${formatEuro(prices.maison)}/m²`;
    }
    show(els["price-maison-box"], Boolean(prices.maison));
    if (prices.appt) {
      els["price-appt"].textContent = `${formatEuro(prices.appt)}/m²`;
    }
    show(els["price-appt-box"], Boolean(prices.appt));
  }
  show(els["prices-row"], hasPrices);

  const politics = result.politics;
  if (politics) {
    els["politics-label"].textContent = politics.label;
    els["bar-gauche"].style.width = `${politics.gauche}%`;
    els["bar-centre"].style.width = `${politics.centre}%`;
    els["bar-droite"].style.width = `${politics.droite}%`;
    els["pct-gauche"].textContent = `Gauche ${politics.gauche}%`;
    els["pct-centre"].textContent = `Centre ${politics.centre}%`;
    els["pct-droite"].textContent = `Droite ${politics.droite}%`;
  }
  show(els["politics-row"], Boolean(politics));

  const taxe = result.taxeIndex;
  if (taxe) {
    els["taxe-dots"].textContent = "●".repeat(taxe) + "○".repeat(5 - taxe);
    els["taxe-index"].textContent = `${taxe}/5`;
    els["taxe-row"].title =
      "Indice du taux communal de taxe foncière (quintile national). " +
      "1 = parmi les plus bas de France, 5 = parmi les plus élevés.";
  }
  show(els["taxe-row"], Boolean(taxe));

  show(els["commune-section"], hasPrices || Boolean(politics) || Boolean(taxe));
}

/** Même cible que le badge de la page : repère sur la commune, zoom large. */
function mapsUrlFor(result) {
  if (result.mapsUrl) return result.mapsUrl;

  const lat = Number(result.lat);
  const lon = Number(result.lon);
  const name =
    [result.city, result.zipCode].filter(Boolean).join(" ") ||
    result.district ||
    null;

  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    if (name) {
      return `https://www.google.com/maps/place/${encodeURIComponent(
        name
      )}/@${lat},${lon},11z`;
    }
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      `${lat},${lon}`
    )}`;
  }

  if (!name) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    name
  )}`;
}

/** Relance le calcul sur l'onglet actif, puis relit le résultat mis en cache. */
function recomputeActiveTab() {
  if (
    !activeTab ||
    !activeTab.url ||
    !CARNET_SUPPORTED_HOSTS.test(hostOf(activeTab.url))
  ) {
    return;
  }

  els.recompute.disabled = true;
  els.recompute.textContent = "Calcul…";
  chrome.tabs.sendMessage(activeTab.id, { type: "RECOMPUTE" }, () => {
    // Content script pas encore prêt : l'erreur n'a rien à nous apprendre.
    void chrome.runtime.lastError;
    setTimeout(async () => {
      const { lastResult } = await chrome.storage.local.get("lastResult");
      renderResult(lastResult);
      els.recompute.disabled = false;
      els.recompute.textContent = "Recalculer sur l'onglet actif";
    }, 1500);
  });
}

els.recompute.addEventListener("click", recomputeActiveTab);

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return "";
  }
}

/* ----------------------------- Initialisation --------------------------- */

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;

  const { lastResult } = await chrome.storage.local.get("lastResult");
  cachedLastResult = lastResult ?? null;
  await refreshAccount();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.lastResult) {
    renderResult(changes.lastResult.newValue);
  }
});

init();
