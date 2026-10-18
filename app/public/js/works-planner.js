/*
 * Modale « Pièces et état » : l'IA propose les pièces, l'utilisateur corrige.
 *
 * Le plan est édité localement puis enregistré automatiquement (PUT JSON).
 * Les photos sont identifiées par leur URL ; le glisser-déposer repose sur
 * les Pointer Events (souris : seuil de déplacement, tactile : appui long)
 * pour fonctionner aussi sur mobile.
 */
(function () {
  "use strict";

  var modal = document.querySelector("[data-works-modal]");
  if (!modal) return;

  var dialog = modal.querySelector(".works-modal__dialog");
  var body = modal.querySelector("[data-works-body]");
  var saveStatus = modal.querySelector("[data-works-save-status]");
  var toastEl = modal.querySelector("[data-works-toast]");
  var announcer = modal.querySelector("[data-works-announcer]");
  var planUrl = modal.getAttribute("data-plan-url");
  var propertyType = modal.getAttribute("data-property-type") || "";

  /** Vues spéciales du menu (« @ » est exclu des identifiants de pièce). */
  var HOME_VIEW = "@home";
  var ENERGY_VIEW = "@energy";
  var GLOBAL_VIEW = "@global";

  var ISSUE_SURFACE = {
    floor_worn: "floor",
    floor_redo: "floor",
    paint: "walls",
    walls_damaged: "walls",
    ceiling_paint: "ceiling",
    ceiling_damaged: "ceiling",
  };
  var GROUP_META = {
    unassigned: { icon: "inbox", hint: "Photos qui ne sont rattachées à aucune pièce." },
    exterior: { icon: "building", hint: "Façade, jardin, parties communes : hors pièces du logement." },
    excluded: { icon: "eye-off", hint: "Plans, projections ou images non exploitables : exclues de l'état des pièces." },
  };
  var SAVE_DELAY = 700;
  var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** Calculs partagés avec la fiche (mêmes modules que le serveur). */
  var estimateWorksCostsFn = null;
  var computeHomeHealthFn = null;
  var coherence = null;
  var globalLib = null;
  var estimateModulePromise = null;

  function loadEstimateModule() {
    if (estimateWorksCostsFn && coherence && globalLib) return Promise.resolve();
    if (!estimateModulePromise) {
      estimateModulePromise = Promise.all([
        import("/public/js/works-estimate.js"),
        import("/public/js/works-coherence.js"),
        import("/public/js/works-global.js"),
      ]).then(function (mods) {
        estimateWorksCostsFn = mods[0].estimateWorksCosts;
        computeHomeHealthFn = mods[0].computeHomeHealth;
        coherence = mods[1];
        globalLib = mods[2];
      });
    }
    return estimateModulePromise;
  }

  var S = {
    loaded: false,
    plan: null,
    options: null,
    photos: [],
    stored: false,
    aiStatus: "pending",
    aiNewer: false,
    overview: null,
    dpeSource: null,
    view: null,
    selection: new Set(),
    saveTimer: null,
    saving: false,
    pendingSave: false,
    changed: false,
    viewer: null,
    lastFocus: null,
    toastTimer: null,
  };

  /* ------------------------------ Utilitaires ------------------------------ */

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function icon(name, cls) {
    return '<svg class="wi' + (cls ? " " + cls : "") + '" aria-hidden="true"><use href="#wi-' + name + '"></use></svg>';
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function uid() {
    return "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function csrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : "";
  }

  function optionLabel(list, value) {
    for (var i = 0; i < list.length; i++) if (list[i].value === value) return list[i].label;
    return value || "";
  }

  function optionOf(list, value) {
    for (var i = 0; i < list.length; i++) if (list[i].value === value) return list[i];
    return null;
  }

  function typeIcon(type) {
    var o = optionOf(S.options.roomTypes, type);
    return o ? o.icon : "home";
  }

  function roomName(room) {
    return room.label || optionLabel(S.options.roomTypes, room.type) || "Pièce";
  }

  function roomTone(room) {
    var o = optionOf(S.options.roomConditions, room.condition);
    return o ? o.tone : "unknown";
  }

  function photoNumber(url) {
    return S.photos.indexOf(url) + 1;
  }

  function plural(n, word) {
    return n + " " + word + (n > 1 ? "s" : "");
  }

  /** Regroupe les pièces par type (ordre de `roomTypes`), en conservant l'ordre manuel au sein d'un type. */
  function sortRooms() {
    if (!S.plan || !Array.isArray(S.plan.rooms)) return;
    var types = (S.options.roomTypes || []).map(function (o) {
      return o.value;
    });
    function rank(room) {
      var i = types.indexOf(room.type);
      return i === -1 ? types.length : i;
    }
    S.plan.rooms = S.plan.rooms
      .map(function (room, i) {
        return { room: room, rank: rank(room), i: i };
      })
      .sort(function (a, b) {
        return a.rank - b.rank || a.i - b.i;
      })
      .map(function (e) {
        return e.room;
      });
  }

  function findRoom(id) {
    for (var i = 0; i < S.plan.rooms.length; i++) if (S.plan.rooms[i].id === id) return S.plan.rooms[i];
    return null;
  }

  function isGroup(key) {
    return key === "unassigned" || key === "exterior" || key === "excluded";
  }

  function isHome(key) {
    return key === HOME_VIEW;
  }

  function isEnergy(key) {
    return key === ENERGY_VIEW;
  }

  function isGlobal(key) {
    return key === GLOBAL_VIEW;
  }

  function globalItems() {
    if (!S.plan.global || !Array.isArray(S.plan.global.items)) S.plan.global = { items: [] };
    return S.plan.global.items;
  }

  function homeLabel() {
    return "Estimation";
  }

  function homeIcon() {
    return propertyType === "apartment" ? "building" : "home";
  }

  /** Liste de photos d'un conteneur : `room:<id>` ou `group:<clé>`. */
  function listOf(container) {
    var parts = container.split(":");
    if (parts[0] === "group") return S.plan.groups[parts[1]];
    var room = findRoom(parts.slice(1).join(":"));
    return room ? room.photos : null;
  }

  function containerOfView(view) {
    return isGroup(view) ? "group:" + view : "room:" + view;
  }

  function containerLabel(container) {
    var parts = container.split(":");
    if (parts[0] === "group") return optionLabel(S.options.groups, parts[1]);
    var room = findRoom(parts.slice(1).join(":"));
    return room ? roomName(room) : "";
  }

  function announce(message) {
    if (!announcer) return;
    announcer.textContent = "";
    window.setTimeout(function () {
      announcer.textContent = message;
    }, 30);
  }

  function bump(el) {
    if (!el || reducedMotion) return;
    el.classList.remove("is-bumped");
    void el.offsetWidth;
    el.classList.add("is-bumped");
  }

  /* -------------------------------- Rendu -------------------------------- */

  function render() {
    if (!S.loaded) return;
    if (!S.view || (!isHome(S.view) && !isEnergy(S.view) && !isGlobal(S.view) && !isGroup(S.view) && !findRoom(S.view))) {
      S.view = HOME_VIEW;
    }
    body.innerHTML =
      '<div class="works-planner">' +
      '<aside class="works-side" aria-label="Pièces et groupes de photos" data-works-side>' +
      renderSide() +
      "</aside>" +
      '<section class="works-main" data-works-main tabindex="-1">' +
      renderMain() +
      "</section>" +
      "</div>" +
      '<div class="works-layer" data-works-layer hidden></div>';
    mountView(true);
  }

  function renderEnergySideItem() {
    var active = isEnergy(S.view);
    var dpe = S.overview && S.overview.dpe;
    var state = dpe && dpe.letter ? "DPE " + dpe.letter : "Diagnostic";
    return (
      '<button type="button" class="works-side__item works-side__item--energy' + (active ? " is-active" : "") + '"' +
      ' data-select="' + ENERGY_VIEW + '"' + (active ? ' aria-current="true"' : "") + ">" +
      '<span class="works-side__icon">' + icon("sun") + "</span>" +
      '<span class="works-side__text"><span class="works-side__name">Énergie</span>' +
      '<span class="works-side__state">' + esc(state) + "</span></span></button>"
    );
  }

  function renderHomeItem() {
    var active = isHome(S.view);
    var health = homeHealth();
    var tone = health.score == null ? "unknown" : health.tone;
    return (
      '<button type="button" class="works-side__item works-side__item--home works-side__item--' + tone + (active ? " is-active" : "") + '"' +
      ' data-select="' + HOME_VIEW + '"' + (active ? ' aria-current="true"' : "") + ">" +
      '<span class="works-side__icon">' + icon(homeIcon()) + "</span>" +
      '<span class="works-side__text"><span class="works-side__name">' + esc(homeLabel()) + "</span>" +
      '<span class="works-side__state">Vue d\'ensemble</span></span>' +
      (health.score == null ? "" : '<span class="works-side__score">' + health.score + "</span>") +
      "</button>"
    );
  }

  function renderGlobalSideItem() {
    var active = isGlobal(S.view);
    var lines = globalLines(estimateCosts());
    var cost = lines.reduce(
      function (acc, l) {
        return { min: acc.min + l.min, max: acc.max + l.max };
      },
      { min: 0, max: 0 }
    );
    var state = lines.length ? plural(lines.length, "chantier") + (cost.max > 0 ? " · " + costRange(cost.min, cost.max) : "") : "Électricité, fenêtres…";
    return (
      '<button type="button" class="works-side__item works-side__item--global' + (lines.length ? " works-side__item--average" : "") + (active ? " is-active" : "") + '"' +
      ' data-select="' + GLOBAL_VIEW + '"' + (active ? ' aria-current="true"' : "") + ">" +
      '<span class="works-side__icon">' + icon("hammer") + "</span>" +
      '<span class="works-side__text"><span class="works-side__name">Général</span>' +
      '<span class="works-side__state">' + esc(state) + "</span></span></button>"
    );
  }

  function renderSide() {
    var html = '<div class="works-side__section works-side__section--home">';
    html += renderHomeItem();
    html += '<ul class="works-side__list works-side__list--global" role="list"><li class="works-side__entry">' + renderGlobalSideItem() + "</li></ul>";
    html += '<p class="works-side__caption works-side__caption--sub">Pièces</p>';
    html += '<div class="works-side__rooms">';
    html += '<ul class="works-side__list works-side__list--rooms" role="list" data-works-room-list>';
    S.plan.rooms.forEach(function (room) {
      var state = optionLabel(S.options.roomConditions, room.condition) + (needsReview(room) ? " · à préciser" : "");
      html += renderSideItem("room:" + room.id, room.id, roomName(room), typeIcon(room.type), room.photos.length, roomTone(room), state);
    });
    html += "</ul>";
    html +=
      '<button type="button" class="works-side__add" data-action="add-room">' +
      icon("plus") +
      "<span>Ajouter une pièce</span></button>";
    html += "</div>";
    html += '<p class="works-side__caption works-side__caption--sub">Énergie</p>';
    html += '<ul class="works-side__list" role="list">';
    html += '<li class="works-side__entry">' + renderEnergySideItem() + "</li>";
    html += "</ul>";
    html += "</div>";

    html += '<div class="works-side__section">';
    html += '<p class="works-side__caption">Autres photos</p>';
    html += '<ul class="works-side__list" role="list">';
    S.options.groups.forEach(function (g) {
      html += renderSideItem("group:" + g.value, g.value, g.label, GROUP_META[g.value].icon, S.plan.groups[g.value].length, "group", null);
    });
    html += "</ul></div>";
    return html;
  }

  function renderSideItem(container, view, name, iconName, count, tone, stateLabel) {
    var active = S.view === view;
    var draggable = container.indexOf("room:") === 0;
    return (
      '<li class="works-side__entry">' +
      '<button type="button" class="works-side__item works-side__item--' + tone + (active ? " is-active" : "") + '"' +
      ' data-select="' + esc(view) + '" data-drop="' + esc(container) + '"' +
      (draggable ? ' data-drag-room="' + esc(view) + '"' : "") +
      (active ? ' aria-current="true"' : "") + ">" +
      '<span class="works-side__icon">' + icon(iconName) + "</span>" +
      '<span class="works-side__text"><span class="works-side__name">' + esc(name) + "</span>" +
      (stateLabel ? '<span class="works-side__state">' + esc(stateLabel) + "</span>" : "") +
      "</span>" +
      '<span class="works-side__badge" data-count-for="' + esc(container) + '">' + count + "</span>" +
      "</button></li>"
    );
  }

  function renderBanner() {
    if (S.aiStatus === "pending") {
      return (
        '<div class="works-banner works-banner--pending">' +
        '<span class="spinner" aria-hidden="true"></span>' +
        "<p>L'analyse des photos est en cours : les pièces proposées par l'IA apparaîtront à la fin. Vous pouvez déjà créer des pièces et classer les photos.</p>" +
        "</div>"
      );
    }
    return "";
  }

  function renderMain() {
    if (isHome(S.view)) return renderBanner() + renderOverview();
    if (isEnergy(S.view)) return renderBanner() + renderEnergyView();
    if (isGlobal(S.view)) return renderBanner() + renderGlobalView();
    if (isGroup(S.view)) return renderBanner() + renderGroupView(S.view);
    return renderBanner() + renderRoomView(findRoom(S.view));
  }

  function renderGroupView(key) {
    var meta = GROUP_META[key];
    return (
      '<div class="works-view works-view--group" data-view-anim>' +
      '<header class="works-room__head">' +
      '<span class="works-room__type-btn works-room__type-btn--static">' + icon(meta.icon) + "</span>" +
      '<div class="works-room__titles">' +
      '<h3 class="works-room__group-title">' + esc(optionLabel(S.options.groups, key)) + "</h3>" +
      '<p class="works-room__hint">' + esc(meta.hint) + "</p>" +
      "</div></header>" +
      renderPhotos("group:" + key) +
      "</div>"
    );
  }

  function renderRoomView(room) {
    var typeLabel = optionLabel(S.options.roomTypes, room.type);
    var html = '<div class="works-view works-view--room" data-view-anim data-room-view="' + esc(room.id) + '">';
    html +=
      '<header class="works-room__head">' +
      '<button type="button" class="works-room__type-btn works-room__type-btn--' + roomTone(room) + '" data-action="pick-type" title="Changer le type de pièce" aria-label="Type de pièce : ' + esc(typeLabel) + '. Changer.">' +
      icon(typeIcon(room.type)) +
      "</button>" +
      '<div class="works-room__titles">' +
      '<label class="visually-hidden" for="works-room-name">Nom de la pièce</label>' +
      '<input id="works-room-name" class="works-room__name" type="text" maxlength="60" value="' + esc(room.label) + '" placeholder="' + esc(typeLabel) + '" data-field="label" autocomplete="off" />' +
      '<button type="button" class="works-room__type" data-action="pick-type">' + esc(typeLabel) + icon("pencil") + "</button>" +
      "</div>" +
      '<div class="works-room__actions">' +
      '<button type="button" class="works-icon-btn" data-action="duplicate-room" title="Dupliquer la pièce" aria-label="Dupliquer la pièce">' + icon("copy") + "</button>" +
      '<button type="button" class="works-icon-btn works-icon-btn--danger" data-action="delete-room" title="Supprimer la pièce" aria-label="Supprimer la pièce">' + icon("trash") + "</button>" +
      "</div></header>";

    html += '<div class="works-room__overview">' + renderRoomCondition(room) + "</div>";
    html += renderRoomStatus(room);
    html += renderPhotos("room:" + room.id);
    html += renderIssues(room);
    html += renderAiSeen(room);
    html +=
      '<label class="works-summary">' +
      '<span class="works-label">' + icon("message") + " Vos notes</span>" +
      '<textarea class="works-textarea" rows="2" maxlength="400" data-field="summary" placeholder="Ex. parquet à poncer, papier peint à retirer, trace près de la fenêtre…">' + esc(room.summary) + "</textarea>" +
      "</label>";
    html += "</div>";
    return html;
  }

  /** Règle de works-coherence.js, chargé avant le premier rendu. */
  function needsReview(room) {
    return Boolean(coherence && coherence.roomNeedsReview(room));
  }

  function issueApplies(option, roomType) {
    return !option.roomTypes || option.roomTypes.indexOf(roomType) !== -1;
  }

  /** Budget de la pièce, ou pourquoi elle n'en a pas, et bandeau « à préciser ». */
  function renderRoomStatus(room) {
    var html = '<div class="works-room-status" data-works-room-status>';
    if (needsReview(room)) {
      var state = optionLabel(S.options.roomConditions, room.condition);
      html +=
        '<div class="works-review" role="status">' +
        '<span class="works-review__icon">' + icon("help") + "</span>" +
        '<div class="works-review__body">' +
        '<p class="works-review__title">Pièce à préciser</p>' +
        "<p>L'état « " + esc(state) + " » suppose des travaux, mais aucun point n'est coché : cette pièce ne compte pas dans le budget. " +
        "Cochez ci-dessous ce qu'il faut refaire, ou indiquez que la pièce est en bon état.</p>" +
        "</div>" +
        '<button type="button" class="btn btn--ghost btn--sm" data-action="set-condition" data-value="good">Rien à refaire</button>' +
        "</div>";
    }
    var est = estimateCosts();
    var cost = est.byRoom && est.byRoom[room.id];
    if (est.unavailableReason === "missing_surface") {
      html += '<p class="works-room-budget works-room-budget--muted">' + icon("coins") + "Budget non estimé : la surface du bien n'est pas renseignée.</p>";
    } else if (cost && cost.max > 0) {
      html +=
        '<p class="works-room-budget">' + icon("coins") +
        "<span>Budget de la pièce</span><strong>" + costRange(cost.min, cost.max) + "</strong></p>";
    } else if (!est.unavailableReason) {
      html += '<p class="works-room-budget works-room-budget--muted">' + icon("coins") + "Non comptée dans le budget : aucun point à refaire n'est coché.</p>";
    }
    html += "</div>";
    return html;
  }

  /** Ce que l'IA a relevé sur les photos de la pièce (résumé et raisons des points proposés). */
  function renderAiSeen(room) {
    var reasons = room.issue_reasons || {};
    var keys = (room.issues_ai || []).filter(function (k) {
      return reasons[k];
    });
    if (!room.ai_summary && !keys.length) return "";
    return (
      '<details class="works-ai-seen">' +
      "<summary>" + icon("sparkles") + "<span>Ce que l'IA a vu sur les photos</span>" + icon("chevron-right", "works-ai-seen__chevron") + "</summary>" +
      (room.ai_summary ? '<p class="works-ai-seen__summary">' + esc(room.ai_summary) + "</p>" : "") +
      (keys.length
        ? '<ul class="works-ai-seen__list" role="list">' +
          keys
            .map(function (k) {
              var on = (room.issues || []).indexOf(k) !== -1;
              return (
                '<li class="' + (on ? "" : "is-off") + '"><strong>' + esc(issueLabel(k)) + "</strong>" +
                (on ? "" : " <em>(décoché)</em>") +
                "<span>" + esc(reasons[k]) + "</span></li>"
              );
            })
            .join("") +
          "</ul>"
        : "") +
      "</details>"
    );
  }

  function refreshRoomStatus(room) {
    var block = body.querySelector("[data-works-room-status]");
    if (!block) return;
    var tmp = document.createElement("div");
    tmp.innerHTML = renderRoomStatus(room);
    block.replaceWith(tmp.firstChild);
    rerenderSideOnly();
  }

  function flashPop(el) {
    if (!el || reducedMotion) return;
    el.classList.add("is-pop");
    el.addEventListener(
      "animationend",
      function () {
        el.classList.remove("is-pop");
      },
      { once: true }
    );
  }

  function replaceBlock(selector, html, focusSelector, popFocus) {
    var block = body.querySelector(selector);
    if (!block) return;
    var tmp = document.createElement("div");
    tmp.innerHTML = html;
    block.replaceWith(tmp.firstChild);
    var again = body.querySelector(focusSelector);
    if (again) {
      again.focus({ preventScroll: true });
      if (popFocus) flashPop(again);
    }
  }

  function categoryIssueTone(items, issues) {
    var tone = "none";
    items.forEach(function (o) {
      if (issues.indexOf(o.value) === -1) return;
      if (o.tone === "poor") tone = "poor";
      else if (o.tone === "average" && tone !== "poor") tone = "average";
    });
    return tone;
  }

  /** Ce que l'IA a relevé pour ce point : son constat s'il l'a coché, sinon la note de la surface. */
  function issueAiNote(room, key) {
    var reason = room.issue_reasons && room.issue_reasons[key];
    if (reason && (room.issues_ai || []).indexOf(key) !== -1) return reason;
    var surface = ISSUE_SURFACE[key];
    return (surface && room[surface] && room[surface].note) || "";
  }

  /** Chaque point à signaler a un « ? » (définition catalogue, exclusion, note IA). */
  function issueShowsHelp() {
    return true;
  }

  function renderIssueTip(room, option) {
    var aiNote = issueAiNote(room, option.value);
    var exclusive = "";
    exclusiveIssues().forEach(function (pair) {
      var other = pair[0] === option.value ? pair[1] : pair[1] === option.value ? pair[0] : null;
      var o = other && optionOf(S.options.issues, other);
      if (o) exclusive = "Ne se cumule pas avec « " + o.label + " » : cocher l'un décoche l'autre.";
    });
    return (
      '<div class="works-issue-tip works-issue-tip--' + esc(option.tone) + '" role="dialog" aria-label="' + esc(option.label) + '" data-issue-tip>' +
      '<div class="works-issue-tip__head">' +
      '<span class="works-issue-tip__dot" aria-hidden="true"></span>' +
      '<strong class="works-issue-tip__title">' + esc(option.label) + "</strong>" +
      '<button type="button" class="works-issue-tip__close" data-issue-tip-close aria-label="Fermer">' + icon("close") + "</button>" +
      "</div>" +
      (option.hint ? '<p class="works-issue-tip__text">' + esc(option.hint) + "</p>" : "") +
      (exclusive ? '<p class="works-issue-tip__rule">' + esc(exclusive) + "</p>" : "") +
      (aiNote
        ? '<p class="works-issue-tip__ai">' + icon("sparkles") + "<span><strong>Vu par l'IA</strong>" + esc(aiNote) + "</span></p>"
        : "") +
      "</div>"
    );
  }

  var issueTip = null;

  function closeIssueTip(restoreFocus) {
    if (!issueTip) return false;
    var tip = issueTip;
    issueTip = null;
    if (tip.el.isConnected) tip.el.remove();
    if (tip.btn.isConnected) {
      tip.btn.setAttribute("aria-expanded", "false");
      tip.btn.classList.remove("is-open");
      if (restoreFocus) tip.btn.focus({ preventScroll: true });
    }
    return true;
  }

  function toggleIssueTip(btn, room) {
    var key = btn.getAttribute("data-value");
    var same = issueTip && issueTip.btn === btn;
    closeIssueTip(false);
    if (same) return;
    var option = optionOf(S.options.issues, key);
    if (!option) return;
    var holder = document.createElement("div");
    holder.innerHTML = renderIssueTip(room, option);
    var el = holder.firstChild;
    btn.parentNode.appendChild(el);
    btn.setAttribute("aria-expanded", "true");
    btn.classList.add("is-open");
    issueTip = { el: el, btn: btn };
    var bounds = (btn.closest(".works-issues") || body).getBoundingClientRect();
    if (el.getBoundingClientRect().right > bounds.right) el.classList.add("works-issue-tip--end");
    var b = btn.getBoundingClientRect();
    el.style.setProperty("--tip-arrow", Math.round(b.left + b.width / 2 - el.getBoundingClientRect().left - 6) + "px");
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  /** Forfait coché qui neutralise ce point (sol, murs, plafond d'une salle d'eau), ou null. */
  function coveringIssue(issues, key) {
    var covers = S.options.issueCovers || {};
    for (var i = 0; i < issues.length; i++) {
      var list = covers[issues[i]];
      if (list && list.indexOf(key) !== -1) return issues[i];
    }
    return null;
  }

  /** Point inclus → forfait qui l'inclut, sauf si une version plus forte est déjà cochée. */
  function includedIssues(issues) {
    var includes = S.options.issueIncludes || {};
    var out = {};
    issues.forEach(function (fixture) {
      (includes[fixture] || []).forEach(function (k) {
        var stronger = exclusiveIssues().some(function (pair) {
          return pair[0] === k && issues.indexOf(pair[1]) !== -1;
        });
        if (!stronger) out[k] = fixture;
      });
    });
    return out;
  }

  function renderIssues(room) {
    var stored = room.issues || [];
    var included = includedIssues(stored);
    var issues = stored.filter(function (k) {
      return !coveringIssue(stored, k);
    });
    Object.keys(included).forEach(function (k) {
      if (issues.indexOf(k) === -1) issues.push(k);
    });
    var fromAi = room.issues_ai || [];
    var html =
      '<div class="works-issues" data-works-issues>' +
      '<div class="works-condition__head"><span class="works-label">Points à signaler</span>' +
      '<span class="works-issues__hint">' +
      (issues.length ? plural(issues.length, "point") : "Rien à signaler") +
      "</span></div>" +
      '<div class="works-issues__groups">';
    S.options.issueCategories.forEach(function (c) {
      var items = S.options.issues.filter(function (o) {
        return o.category === c.value && issueApplies(o, room.type);
      });
      if (!items.length) return;
      var count = items.filter(function (o) {
        return issues.indexOf(o.value) !== -1;
      }).length;
      var catTone = categoryIssueTone(items, issues);
      var stackChoices =
        c.value === "floor" ||
        c.value === "walls" ||
        c.value === "ceiling" ||
        c.value === "humidity" ||
        c.value === "fixtures";
      html +=
        '<section class="works-issues__group' +
        (count ? " has-issues" : "") +
        (stackChoices ? " works-issues__group--stack" : "") +
        '" role="group" aria-label="' + esc(c.label) + '">' +
        '<h4 class="works-issues__cat works-issues__cat--' + catTone + '">' + icon(c.icon) + "<span>" + esc(c.label) + "</span>" +
        (count ? '<span class="works-issues__count">' + count + "</span>" : "") +
        "</h4>" +
        '<div class="works-issues__list">';
      items.forEach(function (o) {
        var on = issues.indexOf(o.value) !== -1;
        var inc = included[o.value];
        var ai = on && !inc && fromAi.indexOf(o.value) !== -1;
        var showHelp = issueShowsHelp(room, o);
        html +=
          '<span class="works-issue-wrap">' +
          (showHelp
            ? '<button type="button" class="works-issue-help" data-action="issue-help" data-value="' + esc(o.value) + '"' +
              ' aria-expanded="false" aria-label="' + esc("En savoir plus : " + o.label) + '"><span aria-hidden="true">?</span></button>'
            : "") +
          '<button type="button" class="works-issue works-issue--' + o.tone + (on ? " is-on" : "") + (inc ? " is-included" : "") + '"' +
          ' aria-pressed="' + on + '" data-action="toggle-issue" data-value="' + esc(o.value) + '"' +
          (inc ? ' aria-label="' + esc(o.label + ", inclus dans « " + issueLabel(inc) + " »") + '"' : "") +
          ">" +
          '<span class="works-issue__mark">' + icon(on ? "check" : "plus") + "</span>" +
          esc(o.label) +
          (inc ? '<span class="works-issue__included">Inclus</span>' : "") +
          (ai ? icon("sparkles", "works-issue__ai") : "") +
          "</button></span>";
      });
      html += "</div></section>";
    });
    html += "</div></div>";
    return html;
  }

  function orderIssues(keys) {
    var order = S.options.issues.map(function (o) {
      return o.value;
    });
    return order.filter(function (k) {
      return keys.indexOf(k) !== -1;
    });
  }

  function revertHeavyRenovationAutoIssues(room) {
    var auto = room.issues_heavy_auto || [];
    if (!auto.length) return;
    var drop = {};
    auto.forEach(function (k) {
      drop[k] = true;
    });
    room.issues = orderIssues((room.issues || []).filter(function (k) {
      return !drop[k];
    }));
    room.issues_heavy_auto = [];
  }

  function applyHeavyRenovationIssues(room) {
    var worst = S.options.heavyRenovationWorstIssues || [];
    var before = {};
    (room.issues || []).forEach(function (k) {
      before[k] = true;
    });
    var added = [];
    var issues = (room.issues || []).slice();
    worst.forEach(function (k) {
      var o = optionOf(S.options.issues, k);
      if (o && o.heavyRoomTypes && o.heavyRoomTypes.indexOf(room.type) === -1) return;
      if (issues.indexOf(k) === -1) {
        issues.push(k);
        added.push(k);
      }
    });
    exclusiveIssues().forEach(function (pair) {
      if (issues.indexOf(pair[1]) !== -1) {
        var weak = issues.indexOf(pair[0]);
        if (weak !== -1) issues.splice(weak, 1);
      }
    });
    room.issues = orderIssues(issues);
    room.issues_heavy_auto = added;
  }

  function toggleIssue(room, key) {
    var previous = (room.issues || []).slice();
    var issues = previous.slice();
    var fixture = coveringIssue(issues, key);
    var includedKeys = [];
    if (fixture) {
      // Modifier un point compris dans le forfait : le forfait saute, les autres
      // points inclus deviennent de vraies cases, chiffrées séparément.
      var covers = (S.options.issueCovers || {})[fixture] || [];
      var included = includedIssues(issues);
      includedKeys = Object.keys(included).filter(function (k) {
        return included[k] === fixture;
      });
      issues = issues
        .filter(function (k) {
          return k !== fixture && covers.indexOf(k) === -1;
        })
        .concat(
          includedKeys.filter(function (k) {
            return k !== key;
          })
        );
    }
    if (includedKeys.indexOf(key) === -1) {
      var at = issues.indexOf(key);
      if (at !== -1) {
        issues.splice(at, 1);
      } else {
        issues.push(key);
        exclusiveIssues().forEach(function (pair) {
          var other = pair[0] === key ? pair[1] : pair[1] === key ? pair[0] : null;
          if (other && issues.indexOf(other) !== -1) issues.splice(issues.indexOf(other), 1);
        });
      }
    }
    setRoomIssues(room, issues, key);
    if (fixture) {
      var released = orderIssues(issues)
        .filter(function (k) {
          return includedKeys.indexOf(k) !== -1;
        })
        .map(function (k) {
          return "« " + issueLabel(k) + " »";
        });
      toast(
        "« " + issueLabel(fixture) + " » retirée" +
          (released.length ? " : " + released.join(", ") + (released.length > 1 ? " sont chiffrés" : " est chiffré") + " séparément." : "."),
        "Annuler",
        function () {
          setRoomIssues(room, previous, fixture);
          announce("« " + issueLabel(fixture) + " » rétablie.");
        }
      );
    }
  }

  function setRoomIssues(room, issues, focusKey) {
    room.issues = orderIssues(issues);
    changed();
    if (S.view !== room.id) {
      rerenderSideOnly();
      return;
    }
    replaceBlock("[data-works-issues]", renderIssues(room), '[data-action="toggle-issue"][data-value="' + cssEscape(focusKey) + '"]', true);
    refreshRoomStatus(room);
    var ai = body.querySelector(".works-ai-seen");
    if (ai) {
      var tmp = document.createElement("div");
      tmp.innerHTML = renderAiSeen(room);
      if (tmp.firstChild) {
        tmp.firstChild.open = ai.open;
        ai.replaceWith(tmp.firstChild);
      }
    }
  }

  function exclusiveIssues() {
    return S.options.exclusiveIssues || [];
  }

  /** Au changement de type, retire les points qui ne concernent pas la nouvelle pièce. */
  function dropInapplicableIssues(room) {
    var removed = [];
    room.issues = (room.issues || []).filter(function (k) {
      var o = optionOf(S.options.issues, k);
      if (!o || issueApplies(o, room.type)) return true;
      removed.push(o.label);
      return false;
    });
    return removed;
  }

  function renderRoomCondition(room) {
    return (
      '<div class="works-condition">' +
      '<div class="works-condition__head"><span class="works-label">État général</span>' + sourceBadge(room.condition_source) + "</div>" +
      '<div class="works-chips" role="radiogroup" aria-label="État général de la pièce">' +
      S.options.roomConditions
        .map(function (o) {
          var on = room.condition === o.value;
          return (
            '<button type="button" role="radio" aria-checked="' + on + '" class="works-chip works-chip--' + o.tone + (on ? " is-on" : "") + '"' +
            ' data-action="set-condition" data-value="' + esc(o.value) + '">' + esc(o.label) + "</button>"
          );
        })
        .join("") +
      "</div></div>"
    );
  }

  function sourceBadge(source) {
    return source === "ai"
      ? '<span class="works-source works-source--ai" title="Valeur proposée par l\'IA">' + icon("sparkles") + "IA</span>"
      : '<span class="works-source works-source--user" title="Valeur modifiée par vous">' + icon("check") + "Modifié</span>";
  }

  function renderPhotos(container, options) {
    options = options || {};
    var roomLayout = options.layout === "room";
    var list = listOf(container) || [];
    var selCount = 0;
    list.forEach(function (u) {
      if (S.selection.has(u)) selCount++;
    });
    var html =
      '<div class="works-photos' + (roomLayout ? " works-photos--room" : "") + '" data-drop="' + esc(container) + '" data-photo-grid>';
    html += '<div class="works-photos__head">';
    html += '<span class="works-label">' + icon("image") + " " + plural(list.length, "photo") + "</span>";
    html += '<div class="works-photos__tools">';
    if (selCount) {
      html +=
        '<span class="works-photos__sel">' + plural(selCount, "sélectionnée") + "</span>" +
        '<button type="button" class="btn btn--green btn--sm" data-action="move-selection">' + icon("move") + " Déplacer vers…</button>" +
        '<button type="button" class="works-link" data-action="clear-selection">Annuler</button>';
    } else if (list.length > 1) {
      html += '<button type="button" class="works-link" data-action="select-all">Tout sélectionner</button>';
    }
    html += "</div></div>";
    if (!list.length) {
      html +=
        '<div class="works-photos__empty">' + icon("image") +
        "<p>Glissez des photos ici depuis « À classer » ou une autre pièce.</p></div>";
    } else {
      html += '<div class="works-photos__grid">';
      list.forEach(function (u) {
        html += renderPhotoCard(u, false, roomLayout);
      });
      html += "</div>";
    }
    html += "</div>";
    return html;
  }

  function renderPhotoCard(u, compact, roomThumb) {
    var caption = S.plan.captions[u];
    var selected = S.selection.has(u);
    return (
      '<div class="works-photo' +
      (compact ? " works-photo--compact" : "") +
      (roomThumb ? " works-photo--thumb" : "") +
      (selected ? " is-selected" : "") +
      '"' +
      ' data-photo="' + esc(u) + '" data-drag-photo tabindex="0" role="button"' +
      ' aria-label="Photo ' + photoNumber(u) + (caption && caption.text ? " : " + esc(caption.text) : "") + '. Entrée pour agrandir, espace pour sélectionner."' +
      ' aria-pressed="' + selected + '">' +
      '<span class="works-photo__media"><img src="' + esc(u) + '" alt="" loading="lazy" draggable="false" referrerpolicy="no-referrer" /></span>' +
      '<span class="works-photo__num">' + photoNumber(u) + "</span>" +
      '<button type="button" class="works-photo__check" data-action="toggle-select" tabindex="-1" aria-label="Sélectionner la photo">' + icon("check") + "</button>" +
      (compact || roomThumb
        ? ""
        : '<span class="works-photo__caption' + (caption && caption.text ? "" : " is-empty") + '">' +
          (caption && caption.source === "ai" ? icon("sparkles", "works-photo__ai") : "") +
          esc(caption && caption.text ? caption.text : "Ajouter un commentaire…") +
          "</span>") +
      "</div>"
    );
  }

  /* --------------------- Vue récapitulative Estimation --------------------- */

  var PRIORITY_STYLES = {
    necessary: { icon: "alert", tone: "poor" },
    comfort: { icon: "zap", tone: "average" },
    cosmetic: { icon: "sparkles", tone: "good" },
  };

  var ALERT_SOURCES = {
    description: "Annonce",
    data: "Annonce",
    dpe: "DPE",
    photos: "Photos",
    plan: "Pièces × DPE",
    room: "Pièces",
    unplaced: "Hors des pièces",
  };

  var ALERT_ICONS = {
    description: "message",
    data: "message",
    dpe: "zap",
    photos: "camera",
    plan: "grid",
    room: "help",
    unplaced: "inbox",
  };

  var GAUGE_LENGTH = 326.73;

  var euroFormat = window.Intl ? new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }) : null;

  function formatNumber(n) {
    return euroFormat ? euroFormat.format(n) : String(n);
  }

  function roundCost(n) {
    var step = n >= 20000 ? 1000 : n >= 5000 ? 500 : n >= 1000 ? 100 : 50;
    return Math.round(n / step) * step;
  }

  function costRange(min, max) {
    return formatNumber(roundCost(min)) + " – " + formatNumber(roundCost(max)) + " €";
  }

  function costs() {
    return (
      (S.options && S.options.costs) || {
        posts: [],
        issueIntensity: {},
        roomTypeFactors: {},
        energy: {},
        energySurfaceRefM2: 70,
      }
    );
  }

  function issueLabel(key) {
    var o = optionOf(S.options.issues, key);
    return o ? o.label : key;
  }

  function dpeZones() {
    var map = {};
    var dpe = S.overview && S.overview.dpe;
    ((dpe && dpe.zones) || []).forEach(function (z) {
      map[z.id] = z;
    });
    return map;
  }

  /** État global d'après les pièces (le score IA sert de repli). */
  /** Même calcul que l'état général affiché sur la fiche (works-estimate.js). */
  function homeHealth() {
    var ai = S.overview && S.overview.condition && S.overview.condition.score;
    if (!computeHomeHealthFn) {
      return { score: typeof ai === "number" ? ai : null, tone: "unknown", verdict: "État général à préciser", assessed: 0, fromPlan: false };
    }
    var tones = {};
    S.options.issues.forEach(function (o) {
      tones[o.value] = o.tone;
    });
    return computeHomeHealthFn({
      rooms: S.plan.rooms,
      globalItems: globalItems(),
      roomTypeFactors: costs().roomTypeFactors,
      issueTones: tones,
      fallbackScore: typeof ai === "number" ? ai : null,
    });
  }

  function issueIcon(key) {
    var issue = optionOf(S.options.issues, key);
    var cat = optionOf(S.options.issueCategories, issue && issue.category);
    return cat ? cat.icon : "hammer";
  }

  /** Chiffrage à partir de la surface du bien et des cases cochées (works-estimate.js). */
  function estimateCosts() {
    if (!estimateWorksCostsFn) {
      return {
        min: null,
        max: null,
        posts: [],
        items: [],
        copro: [],
        unavailableReason: "loading",
      };
    }
    var o = S.overview || {};
    return estimateWorksCostsFn({
      surface: o.surface,
      propertyType: propertyType,
      rooms: S.plan.rooms,
      globalItems: globalItems(),
      dpeZones: dpeZones(),
      costs: costs(),
      issueLabel: issueLabel,
      issueIcon: issueIcon,
      roomName: roomName,
    });
  }

  /** Pièces dont l'état suppose des travaux sans aucun point coché : absentes du budget. */
  function roomReviewAlerts() {
    return S.plan.rooms.filter(needsReview).map(function (room) {
      return {
        source: "room",
        tone: "average",
        roomId: room.id,
        title: roomName(room) + " : à préciser",
        text:
          "État « " + optionLabel(S.options.roomConditions, room.condition) +
          " » mais aucun point à refaire coché : la pièce ne compte pas dans le budget.",
      };
    });
  }

  /** Croisement pièces × DPE (works-coherence.js, identique sur la fiche) : seuls les écarts sont signalés. */
  function planDpeChecks(health) {
    var o = S.overview || {};
    if (!coherence || !o.dpe || (!S.plan.rooms.length && !globalItems().length)) return [];
    return coherence
      .dpeCoherence({ rooms: S.plan.rooms, globalItems: globalItems(), health: health, dpe: o.dpe, photoSignals: o.photoSignals || {} })
      .filter(function (c) {
        return c.status !== "consistent";
      })
      .map(function (c) {
        return { source: "plan", tone: c.tone, title: c.title, text: c.text };
      });
  }

  /** Travaux repérés par l'analyse hors des pièces du plan (works-coherence.js, identique sur la fiche). */
  function unplacedAlerts() {
    var sources = (S.overview && S.overview.unplacedWorks) || [];
    if (!coherence || !sources.length) return [];
    return coherence.placeUnplacedWorks(sources, S.plan.rooms, roomName).map(function (w) {
      var missing = (w.missingIssues || []).map(function (k) {
        return issueLabel(k).toLowerCase();
      });
      var text;
      if (w.status === "exterior") text = "Extérieur : non chiffré dans le budget, à faire estimer à part.";
      else if (w.status === "to_check")
        text =
          "Sa photo est dans " + w.rooms.map(function (r) { return r.name; }).join(", ") + ", mais " + missing.join(", ") +
          (missing.length > 1 ? " n'y sont pas cochés." : " n'y est pas coché.");
      else if (w.status === "unassigned") text = "Sa photo n'est rattachée à aucune pièce : placez-la pour que ce travail soit chiffré.";
      else text = "Repéré sur les photos sans point à refaire correspondant : non chiffré.";
      return {
        source: "unplaced",
        tone: w.status === "exterior" || w.status === "note" ? "info" : "average",
        roomId: w.status === "to_check" && w.rooms[0] ? w.rooms[0].id : null,
        title: w.label,
        text: text,
      };
    });
  }

  /** Le plan enregistré part d'une analyse plus ancienne que la dernière. */
  function staleAlerts() {
    if (!S.aiNewer) return [];
    return [
      {
        source: "photos",
        tone: "average",
        title: "Nouvelle analyse des photos disponible",
        text: "Vos réglages partent d'une analyse plus ancienne. « Repartir du diagnostic » les remplace par la nouvelle proposition (vos corrections seront perdues).",
      },
    ];
  }

  function overviewCard(cls, i, inner) {
    return '<section class="works-overview__card ' + cls + '" style="--i:' + i + '">' + inner + "</section>";
  }

  function overviewHead(iconName, title, extra) {
    return (
      '<header class="works-overview__head"><h4 class="works-overview__heading">' +
      '<span class="works-overview__head-icon">' + icon(iconName) + "</span>" + esc(title) + "</h4>" +
      (extra || "") +
      "</header>"
    );
  }

  function renderOverviewHero(health) {
    var o = S.overview || {};
    var facts = [];
    if (o.roomsAnnounced) facts.push(plural(o.roomsAnnounced, "pièce"));
    if (o.surface) facts.push(formatNumber(o.surface) + " m²");
    if (o.bedrooms) facts.push(plural(o.bedrooms, "chambre"));
    var chips = [];
    if (S.plan.rooms.length) {
      chips.push('<span class="works-overview__chip">' + icon("grid") + plural(health.assessed, "pièce") + " évaluée" + (health.assessed > 1 ? "s" : "") + "</span>");
    }
    if (o.renovation && o.renovation.text) {
      chips.push('<span class="works-overview__chip works-overview__chip--ai" title="Lecture initiale des photos, avant vos corrections">' + icon("sparkles") + "IA : " + esc(o.renovation.text.charAt(0).toLowerCase() + o.renovation.text.slice(1)) + "</span>");
    }
    if (o.renovation && o.renovation.cosmeticOnly) {
      chips.push('<span class="works-overview__chip works-overview__chip--average">' + icon("alert") + "Rénovation énergétique nécessaire</span>");
    }
    if (o.condition && typeof o.condition.score === "number" && health.fromPlan) {
      chips.push('<span class="works-overview__chip works-overview__chip--ai" title="Score de l\'analyse des photos, avant vos corrections">' + icon("sparkles") + "IA : " + o.condition.score + "/100</span>");
    }
    var offset = health.score == null ? GAUGE_LENGTH : GAUGE_LENGTH * (1 - health.score / 100);
    return (
      '<header class="works-overview__hero works-overview__hero--' + health.tone + '" style="--i:0">' +
      '<div class="works-overview__gauge" role="img" aria-label="État général : ' + (health.score == null ? "non évalué" : health.score + " sur 100") + '">' +
      '<svg viewBox="0 0 120 120" aria-hidden="true">' +
      '<circle class="works-overview__gauge-track" cx="60" cy="60" r="52" />' +
      '<circle class="works-overview__gauge-value" cx="60" cy="60" r="52" style="--gauge-len:' + GAUGE_LENGTH + ";--gauge-offset:" + offset.toFixed(2) + '" />' +
      "</svg>" +
      '<span class="works-overview__gauge-text">' +
      (health.score == null
        ? "<strong>?</strong>"
        : '<strong data-count-to="' + health.score + '">' + health.score + "</strong><small>/100</small>") +
      "</span></div>" +
      '<div class="works-overview__hero-text">' +
      '<p class="works-overview__eyebrow">' + icon(homeIcon()) + esc(homeLabel()) + "</p>" +
      '<h3 class="works-overview__title">' + esc(health.verdict) + "</h3>" +
      (facts.length ? '<p class="works-overview__facts">' + esc(facts.join(" · ")) + "</p>" : "") +
      (chips.length ? '<div class="works-overview__chips">' + chips.join("") + "</div>" : "") +
      (o.summary
        ? '<p class="works-overview__summary" title="' + esc(o.summary) + '">' + icon("sparkles", "works-overview__summary-icon") + esc(o.summary) + "</p>"
        : "") +
      "</div></header>"
    );
  }

  function renderOverviewBudget(est) {
    var inner = overviewHead("coins", "Budget travaux estimé", '<span class="works-overview__badge">Provisoire</span>');
    if (est.unavailableReason === "missing_surface") {
      inner +=
        '<div class="works-overview__empty">' + icon("alert") +
        "<p>Impossible d'estimer les travaux : la <strong>surface du bien</strong> n'est pas renseignée sur l'annonce.</p></div>";
    } else if (est.unavailableReason === "loading") {
      inner +=
        '<div class="works-overview__empty">' + icon("hammer") +
        "<p>Préparation du chiffrage…</p></div>";
    } else if (!est.posts.length) {
      inner +=
        '<div class="works-overview__empty works-overview__empty--good">' + icon("shield") +
        "<p>Aucun travaux signalé pour l'instant. Cochez des points dans les pièces ou des chantiers dans « Général » pour alimenter le chiffrage.</p></div>";
    } else {
      inner +=
        '<p class="works-overview__amount">' +
        '<span data-count-to="' + est.min + '" data-count-format="euro">' + formatNumber(est.min) + "</span>" +
        '<span class="works-overview__amount-sep">–</span>' +
        '<span data-count-to="' + est.max + '" data-count-format="euro">' + formatNumber(est.max) + "</span>" +
        '<span class="works-overview__amount-unit">€</span></p>' +
        '<p class="works-overview__amount-sub">Fourchette indicative · ' + plural(est.items.length - est.copro.length, "poste") + " de travaux</p>";
      inner += '<div class="works-overview__bar" role="img" aria-label="Répartition du budget par poste">';
      est.posts.forEach(function (p, i) {
        var share = est.max ? (p.max / est.max) * 100 : 0;
        inner +=
          '<span class="works-overview__seg works-overview__seg--' + esc(p.key) + '" style="--w:' + Math.max(share, 2).toFixed(1) + "%;--i:" + i + '" title="' + esc(p.label + " : " + costRange(p.min, p.max)) + '"></span>';
      });
      inner += "</div>";
      inner += '<ul class="works-overview__posts" role="list">';
      est.posts.forEach(function (p) {
        inner +=
          '<li><details class="works-overview__post">' +
          '<summary><span class="works-overview__dot works-overview__seg--' + esc(p.key) + '"></span>' +
          '<span class="works-overview__post-label">' + esc(p.label) + "</span>" +
          '<span class="works-overview__post-cost">' + costRange(p.min, p.max) + "</span>" +
          icon("chevron-right", "works-overview__post-chevron") + "</summary>" +
          '<ul class="works-overview__post-items" role="list">' +
          p.items
            .map(function (it) {
              return (
                "<li><span>" + esc(it.label) +
                (it.rooms.length ? ' <em>· ' + esc(it.rooms.join(", ")) + "</em>" : it.detail ? ' <em>· ' + esc(it.detail) + "</em>" : "") +
                "</span><span>" + costRange(it.min, it.max) + "</span></li>"
              );
            })
            .join("") +
          "</ul></details></li>";
      });
      inner += "</ul>";
    }
    if (est.copro.length) {
      inner +=
        '<div class="works-overview__copro">' + icon("building") +
        "<p><strong>À voir avec la copropriété</strong> (hors total) : " +
        est.copro
          .map(function (i) {
            return esc(i.label) + " (" + costRange(i.min, i.max) + ")";
          })
          .join(", ") +
        ".</p></div>";
    }
    if (!est.unavailableReason) {
      inner +=
        "<p class=\"works-overview__footnote\">Estimation indicative d'après la surface du bien, la répartition estimée entre les pièces du plan et les prix moyens constatés des chantiers généraux. À affiner avec des devis.</p>";
    }
    return overviewCard("works-overview__budget", 1, inner);
  }

  function renderOverviewAlerts(alerts) {
    var poor = alerts.filter(function (a) {
      return a.tone === "poor";
    }).length;
    var inner = overviewHead(
      "alert",
      "Incohérences et vigilance",
      alerts.length ? '<span class="works-overview__count works-overview__count--' + (poor ? "poor" : "average") + '">' + alerts.length + "</span>" : ""
    );
    if (!alerts.length) {
      inner +=
        '<div class="works-overview__empty works-overview__empty--good">' + icon("check") +
        "<p>Rien d'incohérent relevé entre l'annonce, le DPE, les photos et vos constats.</p></div>";
    } else {
      inner += '<ul class="works-overview__alerts" role="list">';
      alerts.forEach(function (a, i) {
        inner +=
          '<li class="works-overview__alert works-overview__alert--' + esc(a.tone) + '" style="--i:' + i + '">' +
          '<span class="works-overview__alert-icon">' + icon(ALERT_ICONS[a.source] || "alert") + "</span>" +
          '<div class="works-overview__alert-body">' +
          '<p class="works-overview__alert-title">' + esc(a.title) +
          '<span class="works-overview__source">' + esc(ALERT_SOURCES[a.source] || "") + "</span></p>" +
          (a.text ? '<p class="works-overview__alert-text">' + esc(a.text) + "</p>" : "") +
          (a.roomId ? '<button type="button" class="works-link works-overview__alert-action" data-select="' + esc(a.roomId) + '">Ouvrir la pièce' + icon("chevron-right") + "</button>" : "") +
          "</div></li>";
      });
      inner += "</ul>";
    }
    return overviewCard("works-overview__vigilance", 2, inner);
  }

  function renderOverviewGlobalTile(est) {
    var lines = globalLines(est);
    var cost = lines.reduce(
      function (acc, l) {
        return { min: acc.min + l.min, max: acc.max + l.max };
      },
      { min: 0, max: 0 }
    );
    return (
      '<button type="button" class="works-overview__tile works-overview__tile--global works-overview__tile--' + (lines.length ? "average" : "unknown") + '" data-select="' + GLOBAL_VIEW + '" style="--i:0" aria-label="' + esc("Général : " + plural(lines.length, "chantier") + ". Ouvrir.") + '">' +
      '<span class="works-overview__tile-media">' + icon("hammer") + "</span>" +
      '<span class="works-overview__tile-body">' +
      '<span class="works-overview__tile-name">Général</span>' +
      '<span class="works-overview__tile-state">' + (cost.max > 0 ? esc(costRange(cost.min, cost.max)) : "Électricité, fenêtres, chauffage…") + "</span>" +
      "</span>" +
      '<span class="works-overview__tile-issues' + (lines.length ? " is-average" : " is-clear") + '">' + (lines.length ? lines.length : icon("plus")) + "</span>" +
      "</button>"
    );
  }

  function renderOverviewRooms(est) {
    var rooms = S.plan.rooms;
    var inner = overviewHead("grid", "Pièce par pièce", '<span class="works-overview__count">' + rooms.length + "</span>");
    if (!rooms.length) {
      inner +=
        '<div class="works-overview__tiles">' + renderOverviewGlobalTile(est) + "</div>" +
        '<div class="works-overview__empty">' + icon("home") +
        '<p>Aucune pièce pour l\'instant.</p><button type="button" class="btn btn--ghost btn--sm" data-action="add-room">' + icon("plus") + " Ajouter une pièce</button></div>";
      return overviewCard("works-overview__rooms", 3, inner);
    }
    inner += '<div class="works-overview__tiles">' + renderOverviewGlobalTile(est);
    rooms.forEach(function (room, i) {
      var tone = roomTone(room);
      var issues = room.issues || [];
      var poorCount = issues.filter(function (k) {
        var o = optionOf(S.options.issues, k);
        return o && o.tone === "poor";
      }).length;
      var thumb = room.photos[0];
      inner +=
        '<button type="button" class="works-overview__tile works-overview__tile--' + tone + '" data-select="' + esc(room.id) + '" style="--i:' + i + '" aria-label="' + esc(roomName(room) + " : " + optionLabel(S.options.roomConditions, room.condition) + ", " + plural(issues.length, "point") + " à signaler. Ouvrir la pièce.") + '">' +
        '<span class="works-overview__tile-media">' +
        (thumb ? '<img src="' + esc(thumb) + '" alt="" loading="lazy" draggable="false" referrerpolicy="no-referrer" />' : icon(typeIcon(room.type))) +
        "</span>" +
        '<span class="works-overview__tile-body">' +
        '<span class="works-overview__tile-name" title="' + esc(roomName(room)) + '">' + esc(roomName(room)) + "</span>" +
        '<span class="works-overview__tile-state">' + esc(optionLabel(S.options.roomConditions, room.condition)) +
        (needsReview(room) ? ' <em class="works-overview__tile-review">· à préciser</em>' : "") + "</span>" +
        "</span>" +
        '<span class="works-overview__tile-issues' + (poorCount ? " is-poor" : issues.length ? " is-average" : needsReview(room) ? " is-review" : " is-clear") + '">' +
        (issues.length ? issues.length : needsReview(room) ? "?" : icon("check")) +
        "</span></button>";
    });
    inner += "</div>";
    return overviewCard("works-overview__rooms", 3, inner);
  }

  function renderOverviewWorks(est) {
    var inner = overviewHead("hammer", "Travaux à prévoir");
    var any = false;
    var cols = (S.options.priorities || []).map(function (prio) {
      var p = { key: prio.key, label: prio.label, hint: prio.hint, icon: PRIORITY_STYLES[prio.key].icon, tone: PRIORITY_STYLES[prio.key].tone };
      var items = est.items.filter(function (it) {
        return it.priority === p.key;
      });
      if (!items.length) return "";
      any = true;
      return (
        '<div class="works-overview__prio works-overview__prio--' + p.tone + '">' +
        '<p class="works-overview__prio-head">' + icon(p.icon) + "<strong>" + esc(p.label) + "</strong><span>" + esc(p.hint) + "</span></p>" +
        '<ul class="works-overview__prio-list" role="list">' +
        items
          .map(function (it) {
            return (
              '<li><span class="works-overview__prio-icon">' + icon(it.icon || "hammer") + "</span>" +
              '<span class="works-overview__prio-text"><span>' + esc(it.label) + (it.copro ? " <em>(copropriété)</em>" : "") + "</span>" +
              (it.rooms.length
                ? "<small>" + esc(it.rooms.join(", ")) + "</small>"
                : it.global
                  ? "<small>Général" + (it.detail && it.detail !== "forfait" ? " · " + esc(it.detail) : "") + "</small>"
                  : it.post === "energy"
                    ? "<small>Suggéré par le DPE</small>"
                    : "") +
              "</span>" +
              '<span class="works-overview__prio-cost">' + costRange(it.min, it.max) + "</span></li>"
            );
          })
          .join("") +
        "</ul></div>"
      );
    }).join("");
    if (!any) {
      inner +=
        '<div class="works-overview__empty works-overview__empty--good">' + icon("shield") +
        "<p>Aucun travaux identifié. Les points cochés dans les pièces et les chantiers généraux apparaîtront ici, classés par priorité.</p></div>";
    } else {
      inner += '<div class="works-overview__prios">' + cols + "</div>";
    }
    return overviewCard("works-overview__works", 4, inner);
  }

  function renderEnergyPanel() {
    var dpe = S.overview && S.overview.dpe;
    var extra = dpe && dpe.letter ? '<span class="works-overview__dpe-letter works-overview__dpe-letter--' + esc(dpe.letter) + '">DPE ' + esc(dpe.letter) + "</span>" : "";
    var inner = overviewHead("sun", "Énergie", extra);
    if (!dpe) {
      inner +=
        '<div class="works-overview__empty">' + icon("zap") +
        "<div class=\"works-overview__empty-body\"><p>Aucun DPE n'est lié à cette annonce. Déterminez l'adresse du bien pour retrouver son diagnostic et voir l'état de chaque partie du logement.</p>" +
        renderAddressLinks() + "</div></div>";
    } else {
      inner += '<div class="works-overview__dpe" data-overview-dpe></div>';
    }
    return overviewCard("works-overview__energy", 0, inner);
  }

  function addressTrigger(kind) {
    var selector = kind === "ai" ? "[data-listing-address-ai-open]" : "[data-listing-address-open]";
    return document.querySelector("#listing-location " + selector);
  }

  function renderAddressLinks() {
    var links = [];
    if (addressTrigger("manual")) {
      var hasAddress = !document.querySelector("#listing-location .listing-location__card--empty");
      links.push(
        '<button type="button" class="works-link" data-works-address="manual">' +
          (hasAddress ? "Modifier l'adresse" : "Saisir une adresse") +
          "</button>"
      );
    }
    if (addressTrigger("ai")) {
      links.push('<button type="button" class="works-link" data-works-address="ai">Déterminer l\'adresse via IA</button>');
    }
    return links.length ? '<div class="works-overview__empty-links">' + links.join("") + "</div>" : "";
  }

  function openAddressModal(kind) {
    close(function () {
      var trigger = addressTrigger(kind);
      if (trigger) trigger.click();
    });
  }

  function renderEnergyView() {
    return '<div class="works-view works-view--energy works-overview" data-view-anim>' + renderEnergyPanel() + "</div>";
  }

  /* ------------------------ Logement entier (chantiers) ------------------------ */

  function globalCatalog() {
    return (S.options && S.options.globalWorks) || { categories: [], works: [], maxQuantity: 99 };
  }

  function globalItem(key) {
    var items = globalItems();
    for (var i = 0; i < items.length; i++) if (items[i].key === key) return items[i];
    return null;
  }

  function globalWorkDef(key) {
    var works = globalCatalog().works;
    for (var i = 0; i < works.length; i++) if (works[i].key === key) return works[i];
    return null;
  }

  function appliesToProperty(entry) {
    return !entry.propertyTypes || entry.propertyTypes.indexOf(propertyType) !== -1;
  }

  function variantsOf(work) {
    return work.variants.filter(appliesToProperty);
  }

  function currentVariant(work, item) {
    var list = variantsOf(work);
    var key = item && item.variant;
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    for (var j = 0; j < list.length; j++) if (list[j].key === work.defaultVariant) return list[j];
    return list[0];
  }

  /** Lignes chiffrées des chantiers globaux (y compris frais de chantier). */
  function globalLines(est) {
    return (est.items || []).filter(function (it) {
      return it.global;
    });
  }

  function globalLineOf(est, key) {
    var lines = globalLines(est);
    for (var i = 0; i < lines.length; i++) if (lines[i].key === key) return lines[i];
    return null;
  }

  function estimatedQuantities() {
    if (!globalLib) return {};
    return globalLib.estimateQuantities({ rooms: S.plan.rooms, surface: (S.overview || {}).surface });
  }

  function unitsLabel(variant, n) {
    return n + " " + (n > 1 ? variant.units || variant.unit : variant.unit);
  }

  function renderGlobalStepper(work, variant, n, label) {
    return (
      '<div class="works-global__stepper">' +
      '<button type="button" class="works-icon-btn" data-action="global-qty-step" data-key="' + esc(work.key) + '" data-delta="-1" aria-label="Retirer une unité"' + (n <= 1 ? " disabled" : "") + ">" + icon("minus") + "</button>" +
      '<label class="visually-hidden" for="works-global-qty-' + esc(work.key) + '">' + esc(label) + "</label>" +
      '<input id="works-global-qty-' + esc(work.key) + '" class="works-global__qty-input" type="number" inputmode="numeric" min="1" max="' + globalCatalog().maxQuantity + '" value="' + n + '" data-global-qty="' + esc(work.key) + '" />' +
      '<button type="button" class="works-icon-btn" data-action="global-qty-step" data-key="' + esc(work.key) + '" data-delta="1" aria-label="Ajouter une unité"' + (n >= globalCatalog().maxQuantity ? " disabled" : "") + ">" + icon("plus") + "</button>" +
      '<span class="works-global__qty-unit">' + esc(n > 1 ? variant.units || variant.unit : variant.unit) + "</span>" +
      "</div>"
    );
  }

  function renderGlobalQuantity(work, item, variant, quantities) {
    if (variant.manualQuantity) {
      var count = item.quantity != null ? item.quantity : 1;
      return (
        '<div class="works-global__qty">' +
        renderGlobalStepper(work, variant, count, "Nombre de " + (variant.units || variant.unit) + " à créer") +
        "</div>"
      );
    }
    var est = quantities[variant.quantity] || { count: 1, basis: 0 };
    var custom = item.quantity != null;
    var n = custom ? item.quantity : est.count;
    var basis = est.basis
      ? "Estimé d'après " + plural(est.basis, "pièce") + " du plan"
      : "Estimé d'après la surface du bien";
    var html =
      '<div class="works-global__qty">' +
      '<div class="works-chips works-global__qty-mode" role="radiogroup" aria-label="Quantité">' +
      '<button type="button" role="radio" aria-checked="' + !custom + '" class="works-chip' + (custom ? "" : " is-on") + '" data-action="global-qty-all" data-key="' + esc(work.key) + '">' +
      "Toutes (" + esc(unitsLabel(variant, est.count)) + " estimé" + (variant.feminine ? "e" : "") + (est.count > 1 ? "s" : "") + ")</button>" +
      '<button type="button" role="radio" aria-checked="' + custom + '" class="works-chip' + (custom ? " is-on" : "") + '" data-action="global-qty-custom" data-key="' + esc(work.key) + '">Nombre précis</button>' +
      "</div>";
    if (custom) html += renderGlobalStepper(work, variant, n, "Nombre de " + (variant.units || variant.unit));
    html += '<p class="works-global__basis">' + esc(basis) + (custom ? " : " + esc(unitsLabel(variant, est.count)) + "." : ".") + "</p>";
    html += "</div>";
    return html;
  }

  function renderGlobalCard(work, est, quantities, i) {
    var item = globalItem(work.key);
    var on = Boolean(item && item.enabled);
    var declined = Boolean(item && !item.enabled);
    var variant = currentVariant(work, item);
    var line = on ? globalLineOf(est, work.key) : null;
    var variants = variantsOf(work);
    var html =
      '<article class="works-global__card' + (on ? " is-on" : "") + '" style="--i:' + i + '" data-global-card="' + esc(work.key) + '">' +
      '<header class="works-global__head">' +
      '<span class="works-global__icon">' + icon(work.icon || "hammer") + "</span>" +
      '<div class="works-global__titles">' +
      '<h4 class="works-global__title">' + esc(work.label) +
      (on && item.source === "ai" ? '<span class="works-source works-source--ai" title="Proposé par l\'IA">' + icon("sparkles") + "IA</span>" : "") +
      "</h4>" +
      '<p class="works-global__hint">' + esc(work.hint || "") + "</p>" +
      "</div>" +
      (line ? '<span class="works-global__cost">' + costRange(line.min, line.max) + "</span>" : "") +
      '<button type="button" role="switch" aria-checked="' + on + '" class="works-switch' + (on ? " is-on" : "") + '" data-action="global-toggle" data-key="' + esc(work.key) + '" aria-label="' + esc((on ? "Retirer : " : "Prévoir : ") + work.label) + '">' +
      '<span class="works-switch__thumb"></span></button>' +
      "</header>";
    if (on) {
      html += '<div class="works-global__body">';
      if (item.reason) {
        html += '<p class="works-global__reason">' + icon(item.source === "ai" ? "sparkles" : "message") + "<span>" + esc(item.reason) + "</span></p>";
      }
      if (variants.length > 1) {
        html +=
          '<div class="works-chips works-global__variants" role="radiogroup" aria-label="' + esc("Type de travaux : " + work.label) + '">' +
          variants
            .map(function (v) {
              var sel = v.key === variant.key;
              return (
                '<button type="button" role="radio" aria-checked="' + sel + '" class="works-chip' + (sel ? " is-on" : "") + '"' +
                ' data-action="global-variant" data-key="' + esc(work.key) + '" data-value="' + esc(v.key) + '">' + esc(v.label) + "</button>"
              );
            })
            .join("") +
          "</div>";
      }
      if (variant.hint) html += '<p class="works-global__variant-hint">' + esc(variant.hint) + "</p>";
      if (variant.mode === "unit") html += renderGlobalQuantity(work, item, variant, quantities);
      if (line && line.detail && variant.mode !== "unit") {
        var basis =
          variant.mode === "surface"
            ? "Calculé sur " + line.detail + " de surface."
            : variant.mode === "percent"
              ? "Soit " + line.detail + "."
              : variant.scaled && line.detail !== "forfait"
                ? "Prix forfaitaire adapté à la taille du logement (" + line.detail.replace("forfait pour ", "") + ")."
                : "Prix forfaitaire.";
        html += '<p class="works-global__basis">' + esc(basis) + "</p>";
      }
      if (variant.mode === "surface" && !line) {
        html += '<p class="works-global__basis">Surface du bien inconnue : non chiffré.</p>';
      }
      if (work.note) html += '<p class="works-global__note">' + icon("help") + "<span>" + esc(work.note) + "</span></p>";
      html += "</div>";
    } else if (declined) {
      html += '<p class="works-global__declined">Écarté' + (item.source === "ai" ? " (proposé par l'IA)" : "") + "</p>";
    }
    html += "</article>";
    return html;
  }

  function renderGlobalView() {
    var est = estimateCosts();
    var quantities = estimatedQuantities();
    var lines = globalLines(est);
    var total = lines.reduce(
      function (acc, l) {
        return { min: acc.min + l.min, max: acc.max + l.max };
      },
      { min: 0, max: 0 }
    );
    var html =
      '<div class="works-view works-view--global" data-view-anim>' +
      '<header class="works-room__head">' +
      '<span class="works-room__type-btn works-room__type-btn--static">' + icon("hammer") + "</span>" +
      '<div class="works-room__titles">' +
      '<h3 class="works-room__group-title">Général</h3>' +
      '<p class="works-room__hint">Chantiers qui portent sur tout le logement plutôt que sur une pièce : une électricité hors normes se refait partout, placards et couloirs compris.</p>' +
      "</div></header>";
    if (est.unavailableReason === "missing_surface") {
      html += '<p class="works-room-budget works-room-budget--muted">' + icon("coins") + "Budget non estimé : la surface du bien n'est pas renseignée.</p>";
    } else if (total.max > 0) {
      html +=
        '<p class="works-room-budget">' + icon("coins") +
        "<span>" + plural(lines.length, "chantier") + " prévu" + (lines.length > 1 ? "s" : "") + "</span><strong>" + costRange(total.min, total.max) + "</strong></p>";
    }
    var i = 0;
    globalCatalog().categories.forEach(function (cat) {
      var works = globalCatalog().works.filter(function (w) {
        return w.category === cat.key && appliesToProperty(w);
      });
      if (!works.length) return;
      html +=
        '<section class="works-global__group" aria-label="' + esc(cat.label) + '">' +
        '<h4 class="works-global__cat">' + icon(cat.icon) + "<span>" + esc(cat.label) + "</span></h4>" +
        '<div class="works-global__list">';
      works.forEach(function (w) {
        html += renderGlobalCard(w, est, quantities, i++);
      });
      html += "</div></section>";
    });
    html +=
      "<p class=\"works-overview__footnote\">Prix moyens constatés, TTC et pose comprise, à affiner avec des devis. Les frais de chantier s'appliquent en pourcentage des autres travaux.</p>";
    html += "</div>";
    return html;
  }

  /** Re-rendu en gardant le focus sur le même contrôle. */
  function rerenderFocus(selector) {
    rerender();
    var el = selector && body.querySelector(selector);
    if (el && !el.disabled) el.focus({ preventScroll: true });
  }

  function ensureGlobalItem(key) {
    var item = globalItem(key);
    if (item) return item;
    var work = globalWorkDef(key);
    item = { key: key, enabled: false, variant: work ? work.defaultVariant : "", quantity: null, source: "user", reason: "" };
    var order = globalCatalog().works.map(function (w) {
      return w.key;
    });
    var items = globalItems();
    items.push(item);
    items.sort(function (a, b) {
      return order.indexOf(a.key) - order.indexOf(b.key);
    });
    return item;
  }

  function globalAction(action, el) {
    var key = el.getAttribute("data-key");
    var work = globalWorkDef(key);
    if (!work) return;
    var item = ensureGlobalItem(key);
    var focus = '[data-action="' + action + '"][data-key="' + cssEscape(key) + '"]';
    if (action === "global-toggle") {
      item.enabled = !item.enabled;
      announce(work.label + (item.enabled ? " prévu." : " retiré."));
    } else if (action === "global-variant") {
      item.variant = el.getAttribute("data-value");
      item.enabled = true;
      focus += '[data-value="' + cssEscape(item.variant) + '"]';
    } else if (action === "global-qty-all") {
      item.quantity = null;
    } else if (action === "global-qty-custom") {
      if (item.quantity == null) {
        var variant = currentVariant(work, item);
        var est = estimatedQuantities()[variant.quantity];
        item.quantity = est ? est.count : 1;
      }
      focus = "#works-global-qty-" + cssEscape(key);
    } else if (action === "global-qty-step") {
      var delta = Number(el.getAttribute("data-delta")) || 0;
      item.quantity = Math.max(1, Math.min(globalCatalog().maxQuantity, (item.quantity || 1) + delta));
      focus += '[data-delta="' + el.getAttribute("data-delta") + '"]';
    }
    changed();
    rerenderFocus(focus);
  }

  function setGlobalQuantity(input) {
    var key = input.getAttribute("data-global-qty");
    var item = globalItem(key);
    if (!item) return;
    var n = Math.round(Number(input.value));
    if (!Number.isFinite(n) || n < 1) n = 1;
    item.quantity = Math.min(globalCatalog().maxQuantity, n);
    changed();
    rerenderFocus("#works-global-qty-" + cssEscape(key));
  }

  function renderOverview() {
    var health = homeHealth();
    var est = estimateCosts();
    var alerts = staleAlerts().concat(
      roomReviewAlerts(),
      unplacedAlerts(),
      planDpeChecks(health),
      (S.overview && S.overview.alerts) || []
    );
    var rank = { poor: 0, average: 1, info: 2 };
    alerts.sort(function (a, b) {
      return (rank[a.tone] == null ? 1 : rank[a.tone]) - (rank[b.tone] == null ? 1 : rank[b.tone]);
    });
    return (
      '<div class="works-view works-view--home works-overview" data-view-anim>' +
      renderOverviewHero(health) +
      '<div class="works-overview__grid">' +
      renderOverviewBudget(est) +
      renderOverviewAlerts(alerts) +
      "</div>" +
      renderOverviewRooms(est) +
      renderOverviewWorks(est) +
      "</div>"
    );
  }

  function dpeSourceEl() {
    return document.getElementById("works-dpe-house-source");
  }

  function countUp(el, animate) {
    var to = Number(el.getAttribute("data-count-to")) || 0;
    if (!animate || reducedMotion || !to) return;
    var duration = 900;
    var start = null;
    el.textContent = "0";
    function step(ts) {
      if (!el.isConnected) return;
      if (start == null) start = ts;
      var t = Math.min(1, (ts - start) / duration);
      var eased = 1 - Math.pow(1 - t, 3);
      var value = Math.round(to * eased);
      el.textContent = formatNumber(el.getAttribute("data-count-format") === "euro" && t < 1 ? roundCost(value) : value);
      if (t < 1) requestAnimationFrame(step);
      else el.textContent = formatNumber(to);
    }
    requestAnimationFrame(step);
  }

  /** Branche le contenu qui n'est pas rendu en chaîne (maison DPE, compteurs). */
  function mountView(animate) {
    if (!isHome(S.view) && !isEnergy(S.view)) return;
    var slot = body.querySelector("[data-overview-dpe]");
    if (slot) {
      var source = dpeSourceEl();
      var tpl = source && source.querySelector("template");
      if (tpl && tpl.content && tpl.content.querySelector("[data-dpe-house]")) {
        slot.appendChild(tpl.content.cloneNode(true));
      } else {
        slot.innerHTML = '<p class="works-overview__footnote">Le détail du diagnostic sera disponible après rechargement de la page.</p>';
      }
    }
    body.querySelectorAll("[data-count-to]").forEach(function (el) {
      countUp(el, animate);
    });
  }

  function refreshOverview() {
    S.dpeSource = dpeSourceEl();
    fetch(planUrl, { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        S.overview = data.overview || null;
        if ((isHome(S.view) || isEnergy(S.view) || isGlobal(S.view)) && !modal.hidden) rerender();
      })
      .catch(function () {});
  }

  /* ------------------------ Rendu ciblé + animations ------------------------ */

  function capturePositions() {
    var map = new Map();
    body.querySelectorAll("[data-photo]").forEach(function (el) {
      var key = el.getAttribute("data-photo");
      if (!map.has(key)) map.set(key, el.getBoundingClientRect());
    });
    return map;
  }

  function playFlip(before) {
    if (reducedMotion || !before) return;
    body.querySelectorAll("[data-photo]").forEach(function (el) {
      var prev = before.get(el.getAttribute("data-photo"));
      if (!prev) {
        el.classList.add("is-entering");
        return;
      }
      var now = el.getBoundingClientRect();
      var dx = prev.left - now.left;
      var dy = prev.top - now.top;
      if (!dx && !dy) return;
      el.style.transition = "none";
      el.style.transform = "translate(" + dx + "px," + dy + "px)";
      requestAnimationFrame(function () {
        el.style.transition = "";
        el.style.transform = "";
      });
    });
  }

  /** Re-rendu complet en conservant le défilement et (si possible) le focus. */
  function rerender(opts) {
    opts = opts || {};
    var main = body.querySelector("[data-works-main]");
    var side = body.querySelector("[data-works-side]");
    var scrollMain = main ? main.scrollTop : 0;
    var scrollSide = side ? side.scrollTop : 0;
    var before = opts.flip ? capturePositions() : null;
    if (!main) return render();
    side.innerHTML = renderSide();
    main.innerHTML = renderMain();
    if (!opts.animateView) {
      var v = main.querySelector("[data-view-anim]");
      if (v) v.removeAttribute("data-view-anim");
      main.scrollTop = scrollMain;
    } else {
      main.scrollTop = 0;
    }
    side.scrollTop = scrollSide;
    playFlip(before);
    mountView(Boolean(opts.animateView));
  }

  /* -------------------------------- Actions -------------------------------- */

  function select(view) {
    if (S.view === view) return;
    S.view = view;
    S.selection.clear();
    rerender({ animateView: true });
    var main = body.querySelector("[data-works-main]");
    if (main) main.focus({ preventScroll: true });
  }

  function movePhotos(urls, target, index) {
    var dest = listOf(target);
    if (!dest || !urls.length) return;
    var moving = urls.filter(function (u) {
      return S.photos.indexOf(u) !== -1;
    });
    var sameContainerIndexShift = 0;
    S.plan.rooms.forEach(function (r) {
      removeFrom(r.photos);
    });
    Object.keys(S.plan.groups).forEach(function (k) {
      removeFrom(S.plan.groups[k]);
    });
    function removeFrom(list) {
      for (var i = list.length - 1; i >= 0; i--) {
        if (moving.indexOf(list[i]) !== -1) {
          if (list === dest && typeof index === "number" && i < index) sameContainerIndexShift++;
          list.splice(i, 1);
        }
      }
    }
    var at = typeof index === "number" ? Math.max(0, Math.min(dest.length, index - sameContainerIndexShift)) : dest.length;
    Array.prototype.splice.apply(dest, [at, 0].concat(moving));
    S.selection.clear();
    changed();
    rerender({ flip: true });
    var badge = body.querySelector('[data-count-for="' + target + '"]');
    bump(badge);
    var item = body.querySelector('.works-side__item[data-drop="' + target + '"]');
    bump(item);
    announce(plural(moving.length, "photo") + " déplacée" + (moving.length > 1 ? "s" : "") + " vers « " + containerLabel(target) + " ».");
  }

  function nextLabelFor(type) {
    var base = optionLabel(S.options.roomTypes, type);
    var count = 0;
    S.plan.rooms.forEach(function (r) {
      if (r.type === type) count++;
    });
    return count ? base + " " + (count + 1) : base;
  }

  function newRoom(type) {
    return {
      id: uid(),
      type: type,
      label: nextLabelFor(type),
      condition: "not_assessable",
      condition_source: "user",
      summary: "",
      ai_summary: "",
      source: "user",
      issues: [],
      issues_ai: [],
      issues_heavy_auto: [],
      issue_reasons: {},
      needs_review: false,
      floor: { material: "unknown", condition: "unknown", note: "", source: "user" },
      walls: { condition: "unknown", note: "", source: "user" },
      ceiling: { condition: "unknown", note: "", source: "user" },
      ambiance: { brightness: "not_assessable", ceiling_height: "unknown", storage: "unknown", note: "", source: "user" },
      photos: [],
    };
  }

  function addRoom(type) {
    var room = newRoom(type);
    S.plan.rooms.push(room);
    sortRooms();
    S.view = room.id;
    S.selection.clear();
    changed();
    rerender({ animateView: true });
    var item = body.querySelector('.works-side__item[data-select="' + room.id + '"]');
    if (item) {
      item.classList.add("is-new");
      item.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
    }
    announce("Pièce « " + roomName(room) + " » ajoutée.");
  }

  function deleteRoom(room) {
    var name = roomName(room);
    var photoHint = room.photos.length ? " Ses photos seront déplacées dans « À classer »." : "";
    confirmInline(
      "Supprimer la pièce ?",
      "La pièce « " + name + " » sera retirée du plan de travaux." + photoHint,
      "Supprimer",
      function () {
        var snapshot = clone(S.plan);
        var index = S.plan.rooms.indexOf(room);
        Array.prototype.push.apply(S.plan.groups.unassigned, room.photos);
        S.plan.rooms.splice(index, 1);
        var next = S.plan.rooms[index] || S.plan.rooms[index - 1];
        S.view = next ? next.id : "unassigned";
        S.selection.clear();
        changed();
        rerender({ animateView: true });
        bump(body.querySelector('[data-count-for="group:unassigned"]'));
        toast(
          "Pièce « " + name + " » supprimée" + (room.photos.length ? " — ses photos sont dans « À classer »" : "") + ".",
          "Annuler",
          function () {
            S.plan = snapshot;
            S.view = room.id;
            changed();
            rerender({ animateView: true });
            announce("Pièce « " + name + " » restaurée.");
          }
        );
      }
    );
  }

  function duplicateRoom(room) {
    var copy = clone(room);
    copy.id = uid();
    copy.label = roomName(room) + " (copie)";
    copy.photos = [];
    copy.source = "user";
    S.plan.rooms.splice(S.plan.rooms.indexOf(room) + 1, 0, copy);
    S.view = copy.id;
    changed();
    rerender({ animateView: true });
    announce("Pièce dupliquée.");
  }

  function moveRoom(id, beforeId) {
    var rooms = S.plan.rooms;
    var room = findRoom(id);
    if (!room || id === beforeId) return;
    rooms.splice(rooms.indexOf(room), 1);
    var target = beforeId ? findRoom(beforeId) : null;
    var at = target ? rooms.indexOf(target) : rooms.length;
    rooms.splice(at, 0, room);
    sortRooms();
    changed();
    rerender();
    bump(body.querySelector('.works-side__item[data-select="' + id + '"]'));
  }

  /* ----------------------------- Calques (picker) ---------------------------- */

  function syncTypePickerFilter(layer) {
    var filter = layer.querySelector("[data-type-filter]");
    var grid = layer.querySelector("[data-type-grid]");
    var empty = layer.querySelector("[data-type-empty]");
    if (!filter || !grid) return;
    var q = filter.value.trim().toLowerCase();
    var visible = 0;
    grid.querySelectorAll("[data-type]").forEach(function (btn) {
      var label = (btn.querySelector(".works-type__label") || btn).textContent.trim().toLowerCase();
      var type = (btn.getAttribute("data-type") || "").toLowerCase();
      var show = !q || label.indexOf(q) !== -1 || type.indexOf(q) !== -1;
      btn.classList.toggle("is-filtered-out", !show);
      if (show) visible += 1;
    });
    if (empty) empty.hidden = visible > 0;
  }

  function lockTypePickerLayout(layer) {
    var picker = layer.querySelector(".works-picker--types");
    var bodyEl = layer.querySelector("[data-type-body]");
    var grid = layer.querySelector("[data-type-grid]");
    if (!picker || !bodyEl || !grid) return;
    bodyEl.style.minHeight = Math.ceil(grid.getBoundingClientRect().height) + "px";
    picker.style.minHeight = Math.ceil(picker.getBoundingClientRect().height) + "px";
  }

  function openLayer(html, onClick) {
    var layer = body.querySelector("[data-works-layer]");
    if (!layer) return;
    layer.innerHTML = '<div class="works-layer__backdrop" data-layer-close></div>' + html;
    layer.hidden = false;
    layer.onclick = function (event) {
      if (event.target.closest("[data-layer-close]")) {
        closeLayer();
        return;
      }
      onClick(event);
    };
    layer.oninput = function (event) {
      if (!event.target.matches("[data-type-filter]")) return;
      syncTypePickerFilter(layer);
    };
    var first = layer.querySelector("[data-layer-focus]") || layer.querySelector("button, textarea, select");
    if (first) first.focus({ preventScroll: true });
  }

  function closeLayer() {
    var layer = body.querySelector("[data-works-layer]");
    if (!layer || layer.hidden) return false;
    layer.hidden = true;
    layer.innerHTML = "";
    layer.onclick = null;
    layer.oninput = null;
    S.viewer = null;
    return true;
  }

  function openTypePicker(mode) {
    var room = mode === "change" ? findRoom(S.view) : null;
    var html =
      '<div class="works-picker works-picker--types" role="dialog" aria-modal="true" aria-label="' + (room ? "Changer le type de pièce" : "Ajouter une pièce") + '">' +
      '<header class="works-picker__head"><h3>' + (room ? "Type de pièce" : "Quelle pièce ajouter ?") + "</h3>" +
      '<button type="button" class="modal__close" data-layer-close aria-label="Fermer">' + icon("close") + "</button></header>" +
      '<label class="works-picker__search">' +
      '<span class="visually-hidden">Rechercher un type de pièce</span>' +
      '<span class="admin-users-search__wrap">' +
      '<svg class="admin-users-search__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>' +
      '<input type="search" class="input input--sm admin-users-search__input" data-type-filter placeholder="Rechercher une pièce…" data-layer-focus autocomplete="off" />' +
      "</span></label>" +
      '<div class="works-picker__types-body" data-type-body>' +
      '<p class="works-picker__empty" data-type-empty hidden>Aucune pièce ne correspond à votre recherche.</p>' +
      '<div class="works-picker__grid" data-type-grid="">' +
      S.options.roomTypes
        .map(function (o, i) {
          var on = room && room.type === o.value;
          return (
            '<button type="button" class="works-type' + (on ? " is-on" : "") + '" data-type="' + esc(o.value) + '" style="--i:' + i + '">' +
            '<span class="works-type__icon">' + icon(o.icon) + "</span>" +
            '<span class="works-type__label">' + esc(o.label) + "</span></button>"
          );
        })
        .join("") +
      "</div></div></div>";
    openLayer(html, function (event) {
      var btn = event.target.closest("[data-type]");
      if (!btn || btn.classList.contains("is-filtered-out")) return;
      var type = btn.getAttribute("data-type");
      closeLayer();
      if (room) {
        var oldDefault = optionLabel(S.options.roomTypes, room.type);
        room.type = type;
        if (!room.label || room.label.indexOf(oldDefault) === 0) room.label = nextLabelFor(type);
        var removed = dropInapplicableIssues(room);
        sortRooms();
        changed();
        rerender();
        if (removed.length) toast("Retiré car sans objet dans cette pièce : " + removed.join(", ") + ".");
      } else {
        addRoom(type);
      }
    });
    var typeLayer = body.querySelector("[data-works-layer]");
    if (typeLayer) {
      requestAnimationFrame(function () {
        lockTypePickerLayout(typeLayer);
      });
    }
  }

  function openMovePicker(urls) {
    if (!urls.length) return;
    var current = containerOfView(S.view);
    var targets = S.plan.rooms
      .map(function (r) {
        return { container: "room:" + r.id, label: roomName(r), icon: typeIcon(r.type), count: r.photos.length };
      })
      .concat(
        S.options.groups.map(function (g) {
          return { container: "group:" + g.value, label: g.label, icon: GROUP_META[g.value].icon, count: S.plan.groups[g.value].length };
        })
      );
    var html =
      '<div class="works-picker works-picker--narrow" role="dialog" aria-modal="true" aria-label="Déplacer les photos">' +
      '<header class="works-picker__head"><h3>Déplacer ' + plural(urls.length, "photo") + " vers…</h3>" +
      '<button type="button" class="modal__close" data-layer-close aria-label="Fermer">' + icon("close") + "</button></header>" +
      '<div class="works-picker__list">' +
      targets
        .map(function (t, i) {
          var here = t.container === current;
          return (
            '<button type="button" class="works-dest' + (here ? " is-current" : "") + '" data-dest="' + esc(t.container) + '"' + (here ? " disabled" : "") + (i === 0 ? " data-layer-focus" : "") + ">" +
            '<span class="works-dest__icon">' + icon(t.icon) + "</span>" +
            '<span class="works-dest__label">' + esc(t.label) + "</span>" +
            '<span class="works-dest__count">' + (here ? "ici" : t.count) + "</span></button>"
          );
        })
        .join("") +
      '<button type="button" class="works-dest works-dest--new" data-dest="new">' +
      '<span class="works-dest__icon">' + icon("plus") + "</span>" +
      '<span class="works-dest__label">Nouvelle pièce…</span></button>' +
      "</div></div>";
    openLayer(html, function (event) {
      var btn = event.target.closest("[data-dest]");
      if (!btn || btn.disabled) return;
      var dest = btn.getAttribute("data-dest");
      closeLayer();
      if (dest === "new") {
        openNewRoomForPhotos(urls);
        return;
      }
      movePhotos(urls, dest);
    });
  }

  function openNewRoomForPhotos(urls) {
    openTypePicker("add");
    var layer = body.querySelector("[data-works-layer]");
    var previous = layer.onclick;
    layer.onclick = function (event) {
      var btn = event.target.closest("[data-type]");
      if (!btn) return previous(event);
      closeLayer();
      addRoom(btn.getAttribute("data-type"));
      movePhotos(urls, "room:" + S.view);
    };
  }

  /* ----------------------------- Visionneuse photo ---------------------------- */

  function viewerList() {
    var list = listOf(containerOfView(S.view)) || [];
    return list.length ? list : S.plan.groups.unassigned;
  }

  function openViewer(url, list) {
    S.viewer = { url: url, list: list || viewerList() };
    renderViewer();
  }

  function renderViewer() {
    var v = S.viewer;
    if (!v) return;
    var i = v.list.indexOf(v.url);
    var caption = S.plan.captions[v.url] || { text: "", source: "user" };
    var where = locate(v.url);
    var html =
      '<div class="works-viewer" role="dialog" aria-modal="true" aria-label="Photo ' + photoNumber(v.url) + '">' +
      '<div class="works-viewer__stage">' +
      '<img src="' + esc(v.url) + '" alt="Photo ' + photoNumber(v.url) + ' de l\'annonce" referrerpolicy="no-referrer" />' +
      (v.list.length > 1
        ? '<button type="button" class="works-viewer__nav works-viewer__nav--prev" data-viewer="prev" aria-label="Photo précédente">' + icon("chevron-left") + "</button>" +
          '<button type="button" class="works-viewer__nav works-viewer__nav--next" data-viewer="next" aria-label="Photo suivante">' + icon("chevron-right") + "</button>"
        : "") +
      '<span class="works-viewer__pos">' + (i + 1) + " / " + v.list.length + "</span>" +
      "</div>" +
      '<aside class="works-viewer__side">' +
      '<header class="works-picker__head"><h3>Photo ' + photoNumber(v.url) + "</h3>" +
      '<button type="button" class="modal__close" data-layer-close aria-label="Fermer">' + icon("close") + "</button></header>" +
      '<p class="works-viewer__where">' + icon(where.icon) + " " + esc(where.label) + "</p>" +
      '<label class="works-field"><span class="works-label">' + icon("message") + " Commentaire " + (caption.text ? sourceBadge(caption.source) : "") + "</span>" +
      '<textarea class="works-textarea" rows="5" maxlength="400" data-caption data-layer-focus placeholder="Ce que l\'on voit sur cette photo…">' + esc(caption.text) + "</textarea></label>" +
      '<button type="button" class="btn btn--ghost btn--sm works-viewer__move" data-viewer="move">' + icon("move") + " Déplacer vers…</button>" +
      "</aside></div>";
    openLayer(html, function (event) {
      var btn = event.target.closest("[data-viewer]");
      if (!btn) return;
      var action = btn.getAttribute("data-viewer");
      if (action === "prev" || action === "next") stepViewer(action === "next" ? 1 : -1);
      if (action === "move") {
        var url = S.viewer.url;
        closeLayer();
        openMovePicker([url]);
      }
    });
    S.viewer = v;
    var textarea = body.querySelector("[data-caption]");
    if (textarea) {
      textarea.addEventListener("input", function () {
        var text = textarea.value;
        if (text.trim()) S.plan.captions[v.url] = { text: text.slice(0, 400), source: "user" };
        else delete S.plan.captions[v.url];
        changed();
        var card = body.querySelector('.works-photos [data-photo="' + cssEscape(v.url) + '"] .works-photo__caption');
        if (card) {
          card.textContent = text.trim() || "Ajouter un commentaire…";
          card.classList.toggle("is-empty", !text.trim());
        }
      });
    }
  }

  function stepViewer(delta) {
    var v = S.viewer;
    if (!v || v.list.length < 2) return;
    var i = v.list.indexOf(v.url);
    v.url = v.list[(i + delta + v.list.length) % v.list.length];
    renderViewer();
  }

  function locate(url) {
    for (var i = 0; i < S.plan.rooms.length; i++) {
      var r = S.plan.rooms[i];
      if (r.photos.indexOf(url) !== -1) return { label: roomName(r), icon: typeIcon(r.type) };
    }
    for (var k in S.plan.groups) {
      if (S.plan.groups[k].indexOf(url) !== -1) return { label: optionLabel(S.options.groups, k), icon: GROUP_META[k].icon };
    }
    return { label: "", icon: "image" };
  }

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
  }

  /* ----------------------------- Toast + confirm ----------------------------- */

  function toast(message, actionLabel, onAction) {
    if (!toastEl) return;
    window.clearTimeout(S.toastTimer);
    toastEl.innerHTML =
      '<span class="works-toast__text">' + esc(message) + "</span>" +
      (actionLabel ? '<button type="button" class="works-toast__action" data-toast-action>' + icon("undo") + esc(actionLabel) + "</button>" : "");
    toastEl.hidden = false;
    toastEl.classList.remove("is-leaving");
    var btn = toastEl.querySelector("[data-toast-action]");
    if (btn) {
      btn.onclick = function () {
        hideToast();
        onAction();
      };
    }
    S.toastTimer = window.setTimeout(hideToast, 6500);
  }

  function hideToast() {
    if (!toastEl || toastEl.hidden) return;
    toastEl.classList.add("is-leaving");
    window.setTimeout(function () {
      toastEl.hidden = true;
      toastEl.classList.remove("is-leaving");
    }, reducedMotion ? 0 : 200);
  }

  function confirmInline(title, message, confirmLabel, onConfirm) {
    var html =
      '<div class="works-picker works-picker--narrow works-confirm" role="alertdialog" aria-modal="true" aria-label="' + esc(title) + '">' +
      '<span class="works-confirm__icon">' + icon("reset") + "</span>" +
      "<h3>" + esc(title) + "</h3><p>" + esc(message) + "</p>" +
      '<div class="works-confirm__actions">' +
      '<button type="button" class="btn btn--ghost" data-layer-close data-layer-focus>Annuler</button>' +
      '<button type="button" class="btn btn--danger-solid" data-confirm-ok>' + esc(confirmLabel) + "</button>" +
      "</div></div>";
    openLayer(html, function (event) {
      if (!event.target.closest("[data-confirm-ok]")) return;
      closeLayer();
      onConfirm();
    });
  }

  /* -------------------------------- Sauvegarde ------------------------------- */

  function setSaveState(state, label) {
    if (!saveStatus) return;
    saveStatus.setAttribute("data-state", state);
    var l = saveStatus.querySelector(".works-save__label");
    if (l) l.textContent = label;
  }

  function changed() {
    S.changed = true;
    setSaveState("dirty", "Modifications…");
    window.clearTimeout(S.saveTimer);
    S.saveTimer = window.setTimeout(save, SAVE_DELAY);
  }

  function save() {
    window.clearTimeout(S.saveTimer);
    S.saveTimer = null;
    if (S.saving) {
      S.pendingSave = true;
      return S.savingPromise;
    }
    S.saving = true;
    setSaveState("saving", "Enregistrement…");
    S.savingPromise = fetch(planUrl, {
      method: "PUT",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-CSRF-Token": csrfToken(),
      },
      body: JSON.stringify({ plan: S.plan }),
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return { ok: false, error: { message: res.status === 403 ? "Session expirée : rechargez la page." : "Erreur serveur." } };
          })
          .then(function (data) {
            if (!res.ok || !data.ok) throw new Error((data.error && data.error.message) || "Erreur d'enregistrement.");
            return data;
          });
      })
      .then(function (data) {
        S.stored = true;
        S.saving = false;
        if (S.pendingSave) {
          S.pendingSave = false;
          return save();
        }
        setSaveState("saved", "Enregistré");
        return data;
      })
      .catch(function (err) {
        S.saving = false;
        S.pendingSave = false;
        setSaveState("error", "Échec — réessayer");
        toast(err.message || "Enregistrement impossible.", "Réessayer", save);
      });
    return S.savingPromise;
  }

  function flush() {
    if (S.saveTimer || S.saving) return Promise.resolve(save());
    return Promise.resolve();
  }

  /* ------------------------------ Ouverture ------------------------------ */

  function open(target) {
    S.lastFocus = document.activeElement;
    modal.hidden = false;
    document.body.classList.add("is-modal-open");
    if (S.loaded) {
      if (dpeSourceEl() !== S.dpeSource) refreshOverview();
      applyTarget(target);
      return;
    }
    setSaveState("idle", "Chargement…");
    Promise.all([
      fetch(planUrl, { credentials: "same-origin", headers: { Accept: "application/json" } }).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      }),
      loadEstimateModule(),
    ])
      .then(function (results) {
        var data = results[0];
        S.plan = data.plan;
        S.options = data.options;
        sortRooms();
        S.photos = data.photos || [];
        S.stored = data.stored;
        S.aiStatus = data.aiStatus;
        S.aiNewer = Boolean(data.aiNewer);
        S.overview = data.overview || null;
        S.dpeSource = dpeSourceEl();
        S.loaded = true;
        setSaveState(S.stored ? "saved" : "idle", S.stored ? "Enregistré" : "Proposition IA");
        S.view = null;
        render();
        applyTarget(target);
      })
      .catch(function () {
        body.innerHTML =
          '<div class="works-modal__loading"><p>Impossible de charger les pièces. Vérifiez votre connexion puis réessayez.</p>' +
          '<button type="button" class="btn btn--ghost btn--sm" data-works-retry>Réessayer</button></div>';
        setSaveState("error", "Hors ligne");
      });
  }

  function applyTarget(target) {
    if (target === "new-room") {
      openTypePicker("add");
      return;
    }
    if (target === "energy" || target === ENERGY_VIEW) {
      S.view = ENERGY_VIEW;
      S.selection.clear();
    } else if (target === "global" || target === GLOBAL_VIEW) {
      S.view = GLOBAL_VIEW;
      S.selection.clear();
    } else if (target && (isGroup(target) || findRoom(target))) {
      S.view = target;
      S.selection.clear();
    } else if (!target || isHome(target)) {
      S.view = HOME_VIEW;
      S.selection.clear();
    }
    rerender({ animateView: true });
    var main = body.querySelector("[data-works-main]");
    if (main) main.focus({ preventScroll: true });
  }

  function close(afterClose) {
    if (modal.hidden) return;
    closeLayer();
    hideToast();
    modal.classList.add("is-closing");
    flush().then(function () {
      if (!S.changed) return;
      S.changed = false;
      document.body.dispatchEvent(new CustomEvent("works-plan-saved", { bubbles: true }));
    });
    window.setTimeout(
      function () {
        modal.hidden = true;
        modal.classList.remove("is-closing");
        document.body.classList.remove("is-modal-open");
        if (S.lastFocus && S.lastFocus.isConnected) S.lastFocus.focus({ preventScroll: true });
        if (typeof afterClose === "function") afterClose();
      },
      reducedMotion ? 0 : 160
    );
  }

  function reset() {
    confirmInline(
      "Repartir du diagnostic initial ?",
      "Toutes vos corrections (pièces, photos, commentaires) seront remplacées par le diagnostic initial.",
      "Réinitialiser",
      function () {
        window.clearTimeout(S.saveTimer);
        S.saveTimer = null;
        setSaveState("saving", "Réinitialisation…");
        fetch(planUrl, {
          method: "DELETE",
          credentials: "same-origin",
          headers: { Accept: "application/json", "X-CSRF-Token": csrfToken() },
        })
          .then(function (res) {
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.json();
          })
          .then(function (data) {
            S.plan = data.plan;
            sortRooms();
            S.photos = data.photos || S.photos;
            S.stored = false;
            S.aiStatus = data.aiStatus;
            S.aiNewer = false;
            S.changed = true;
            S.view = null;
            S.selection.clear();
            setSaveState("idle", "Proposition IA");
            render();
            toast("Diagnostic initial restauré.");
          })
          .catch(function () {
            setSaveState("error", "Échec");
            toast("Réinitialisation impossible. Réessayez.");
          });
      }
    );
  }

  /* ------------------------------ Événements ------------------------------ */

  document.addEventListener("click", function (event) {
    var trigger = event.target.closest ? event.target.closest("[data-works-open]") : null;
    if (!trigger || modal.contains(trigger)) return;
    event.preventDefault();
    open(trigger.getAttribute("data-works-target"));
  });

  modal.addEventListener("click", function (event) {
    if (dragState && dragState.active) return;
    var t = event.target;
    if (t.closest("[data-works-dismiss]") || t.closest("[data-works-done]")) {
      close();
      return;
    }
    if (t.closest("[data-works-reset]")) {
      reset();
      return;
    }
    var addressLink = t.closest("[data-works-address]");
    if (addressLink) {
      openAddressModal(addressLink.getAttribute("data-works-address"));
      return;
    }
    if (t.closest("[data-works-retry]")) {
      open();
      return;
    }
    if (t.closest("[data-works-save-status]") && saveStatus.getAttribute("data-state") === "error") {
      save();
      return;
    }
    if (!S.loaded || t.closest("[data-works-layer]")) return;

    if (t.closest("[data-issue-tip-close]")) {
      closeIssueTip(true);
      return;
    }
    if (issueTip && !t.closest("[data-issue-tip]") && !t.closest('[data-action="issue-help"]')) closeIssueTip(false);
    if (t.closest("[data-issue-tip]")) return;

    if (suppressClick) {
      suppressClick = false;
      return;
    }

    var actionEl = t.closest("[data-action]");
    var room = findRoom(S.view);
    if (actionEl) {
      var action = actionEl.getAttribute("data-action");
      if (action.indexOf("global-") === 0) return globalAction(action, actionEl);
      if (action === "add-room") return openTypePicker("add");
      if (action === "pick-type" && room) return openTypePicker("change");
      if (action === "delete-room" && room) return deleteRoom(room);
      if (action === "duplicate-room" && room) return duplicateRoom(room);
      if (action === "set-condition" && room) {
        var prevCondition = room.condition;
        var nextCondition = actionEl.getAttribute("data-value");
        if (prevCondition === "heavy_renovation_likely" && nextCondition !== "heavy_renovation_likely") {
          revertHeavyRenovationAutoIssues(room);
        }
        room.condition = nextCondition;
        room.condition_source = "user";
        if (nextCondition === "heavy_renovation_likely") {
          applyHeavyRenovationIssues(room);
        } else if (nextCondition !== "heavy_renovation_likely") {
          room.issues_heavy_auto = [];
        }
        changed();
        return rerender();
      }
      if (action === "issue-help" && room) return toggleIssueTip(actionEl, room);
      if (action === "toggle-issue" && room) return toggleIssue(room, actionEl.getAttribute("data-value"));
      if (action === "toggle-select") {
        var photo = actionEl.closest("[data-photo]");
        if (photo) toggleSelect(photo.getAttribute("data-photo"));
        return;
      }
      if (action === "select-all") {
        (listOf(containerOfView(S.view)) || []).forEach(function (u) {
          S.selection.add(u);
        });
        return rerender();
      }
      if (action === "clear-selection") {
        S.selection.clear();
        return rerender();
      }
      if (action === "move-selection") {
        return openMovePicker(Array.from(S.selection));
      }
    }

    var photoEl = t.closest("[data-photo]");
    if (photoEl) {
      var url = photoEl.getAttribute("data-photo");
      if (event.shiftKey || event.metaKey || event.ctrlKey || S.selection.size) {
        toggleSelect(url);
        return;
      }
      openViewer(url);
      return;
    }

    var selectEl = t.closest("[data-select]");
    if (selectEl) select(selectEl.getAttribute("data-select"));
  });

  function rerenderSideOnly() {
    var side = body.querySelector("[data-works-side]");
    if (!side) return;
    var top = side.scrollTop;
    side.innerHTML = renderSide();
    side.scrollTop = top;
  }

  function toggleSelect(url) {
    if (S.selection.has(url)) S.selection.delete(url);
    else S.selection.add(url);
    rerender();
    announce(plural(S.selection.size, "photo") + " sélectionnée" + (S.selection.size > 1 ? "s" : "") + ".");
  }

  modal.addEventListener("input", function (event) {
    if (event.target.matches && event.target.matches("[data-type-filter]")) {
      var pickerLayer = event.target.closest("[data-works-layer]");
      if (pickerLayer) syncTypePickerFilter(pickerLayer);
      return;
    }
    if (!S.loaded) return;
    var field = event.target.getAttribute("data-field");
    var room = findRoom(S.view);
    if (!field || !room || event.target.closest("[data-works-layer]")) return;
    if (field === "label") {
      room.label = event.target.value;
      var nameEl = body.querySelector('.works-side__item[data-select="' + cssEscape(room.id) + '"] .works-side__name');
      if (nameEl) nameEl.textContent = roomName(room);
    } else if (field === "summary") {
      room.summary = event.target.value;
    }
    changed();
  });

  modal.addEventListener("change", function (event) {
    if (!S.loaded || !event.target.matches || !event.target.matches("[data-global-qty]")) return;
    setGlobalQuantity(event.target);
  });

  modal.addEventListener("keydown", function (event) {
    if (modal.hidden) return;
    if (event.key === "Enter" && event.target.matches && event.target.matches("[data-global-qty]")) {
      event.preventDefault();
      return setGlobalQuantity(event.target);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (dragState && dragState.active) return cancelDrag();
      if (closeIssueTip(true)) return;
      if (closeLayer()) return;
      // La maison DPE (app.js) referme elle-même sa zone active sur Échap.
      if (body.querySelector("[data-dpe-house-stage][data-active-zone]")) return;
      if (S.selection.size) {
        S.selection.clear();
        return rerender();
      }
      return close();
    }
    if (event.key === "Tab") return trapFocus(event);

    var layerOpen = S.viewer && !body.querySelector("[data-works-layer]").hidden;
    if (layerOpen && event.target.tagName !== "TEXTAREA") {
      if (event.key === "ArrowLeft") return stepViewer(-1);
      if (event.key === "ArrowRight") return stepViewer(1);
    }

    var photo = event.target.closest && event.target.closest("[data-photo]");
    if (photo && event.target === photo) {
      if (event.key === "Enter") {
        event.preventDefault();
        openViewer(photo.getAttribute("data-photo"));
      } else if (event.key === " ") {
        event.preventDefault();
        var url = photo.getAttribute("data-photo");
        toggleSelect(url);
        var again = body.querySelector('[data-photo="' + cssEscape(url) + '"]');
        if (again) again.focus({ preventScroll: true });
      }
      return;
    }

    var sideItem = event.target.closest && event.target.closest(".works-side__item");
    if (sideItem && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      var items = Array.prototype.slice.call(body.querySelectorAll(".works-side__item"));
      var next = items[items.indexOf(sideItem) + (event.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        var view = next.getAttribute("data-select");
        select(view);
        var focusEl = body.querySelector('.works-side__item[data-select="' + cssEscape(view) + '"]');
        if (focusEl) focusEl.focus();
      }
    }
  });

  function trapFocus(event) {
    var scope = body.querySelector("[data-works-layer]:not([hidden])") || dialog;
    var focusables = Array.prototype.filter.call(
      scope.querySelectorAll('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      function (el) {
        return el.offsetParent !== null;
      }
    );
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (!scope.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    }
  }

  window.addEventListener("beforeunload", function (event) {
    if (S.saveTimer || S.saving) {
      save();
      event.preventDefault();
      event.returnValue = "";
    }
  });

  /* ----------------------------- Glisser-déposer ----------------------------- */

  var dragState = null;
  var suppressClick = false;
  var DRAG_THRESHOLD = 6;
  var LONG_PRESS = 260;

  modal.addEventListener("pointerdown", function (event) {
    if (!S.loaded || event.button > 0) return;
    if (event.target.closest("[data-action], input, textarea, select, [data-works-layer]")) return;
    var photo = event.target.closest("[data-drag-photo]");
    var roomItem = !photo && event.target.closest("[data-drag-room]");
    if (!photo && !roomItem) return;
    dragState = {
      kind: photo ? "photo" : "room",
      source: photo || roomItem,
      id: photo ? photo.getAttribute("data-photo") : roomItem.getAttribute("data-drag-room"),
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      touch: event.pointerType === "touch",
      active: false,
      timer: null,
    };
    if (dragState.touch) {
      dragState.timer = window.setTimeout(function () {
        if (dragState && !dragState.active) startDrag();
      }, LONG_PRESS);
    }
  });

  document.addEventListener(
    "pointermove",
    function (event) {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      dragState.x = event.clientX;
      dragState.y = event.clientY;
      var dist = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
      if (!dragState.active) {
        if (dragState.touch) {
          if (dist > 10) {
            window.clearTimeout(dragState.timer);
            dragState = null;
          }
          return;
        }
        if (dist < DRAG_THRESHOLD) return;
        startDrag();
      }
      event.preventDefault();
      moveGhost();
      updateDropTarget();
      autoScroll();
    },
    { passive: false }
  );

  document.addEventListener("pointerup", function (event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    window.clearTimeout(dragState.timer);
    if (!dragState.active) {
      dragState = null;
      return;
    }
    finishDrag();
  });

  document.addEventListener("pointercancel", function () {
    if (!dragState) return;
    if (dragState.active) return cancelDrag();
    window.clearTimeout(dragState.timer);
    dragState = null;
  });

  modal.addEventListener("contextmenu", function (event) {
    if (dragState && event.target.closest("[data-drag-photo]")) event.preventDefault();
  });

  document.addEventListener(
    "touchmove",
    function (event) {
      if (dragState && dragState.active) event.preventDefault();
    },
    { passive: false }
  );

  function startDrag() {
    var d = dragState;
    d.active = true;
    if (d.kind === "photo") {
      if (!S.selection.has(d.id)) {
        S.selection.forEach(function (u) {
          if (u !== d.id) S.selection.delete(u);
        });
      }
      d.urls = S.selection.has(d.id) && S.selection.size > 1 ? Array.from(S.selection) : [d.id];
      body.querySelectorAll("[data-photo]").forEach(function (el) {
        if (d.urls.indexOf(el.getAttribute("data-photo")) !== -1) el.classList.add("is-dragging-source");
      });
    } else {
      d.source.classList.add("is-dragging-source");
    }
    var ghost = document.createElement("div");
    ghost.className = "works-ghost works-ghost--" + d.kind;
    if (d.kind === "photo") {
      ghost.innerHTML =
        d.urls
          .slice(0, 3)
          .map(function (u, i) {
            return '<img src="' + esc(u) + '" alt="" referrerpolicy="no-referrer" style="--i:' + i + '" />';
          })
          .join("") + (d.urls.length > 1 ? '<span class="works-ghost__count">' + d.urls.length + "</span>" : "");
    } else {
      var room = findRoom(d.id);
      ghost.innerHTML = icon(typeIcon(room.type)) + "<span>" + esc(roomName(room)) + "</span>";
    }
    document.body.appendChild(ghost);
    d.ghost = ghost;
    modal.classList.add("is-dragging", "is-dragging-" + d.kind);
    if (navigator.vibrate && d.touch) navigator.vibrate(12);
    moveGhost();
    announce(d.kind === "photo" ? "Déplacement de " + plural(d.urls.length, "photo") + ". Relâchez sur une pièce." : "Réorganisation de la pièce.");
  }

  function moveGhost() {
    var d = dragState;
    if (!d || !d.ghost) return;
    d.ghost.style.transform = "translate(" + (d.x + 12) + "px," + (d.y + 12) + "px)";
  }

  function clearDropMarks() {
    modal.querySelectorAll(".is-drop-over, .is-insert-before, .is-insert-after").forEach(function (el) {
      el.classList.remove("is-drop-over", "is-insert-before", "is-insert-after");
    });
  }

  function updateDropTarget() {
    var d = dragState;
    d.ghost.style.visibility = "hidden";
    var under = document.elementFromPoint(d.x, d.y);
    d.ghost.style.visibility = "";
    clearDropMarks();
    d.target = null;
    d.insertIndex = undefined;
    d.beforeRoom = undefined;
    if (!under || !modal.contains(under)) return;

    if (d.kind === "room") {
      var item = under.closest("[data-drag-room]");
      if (!item) return;
      var rect = item.getBoundingClientRect();
      var after = d.y > rect.top + rect.height / 2;
      item.classList.add(after ? "is-insert-after" : "is-insert-before");
      var id = item.getAttribute("data-drag-room");
      var idx = S.plan.rooms.indexOf(findRoom(id)) + (after ? 1 : 0);
      d.beforeRoom = S.plan.rooms[idx] ? S.plan.rooms[idx].id : null;
      d.target = "rooms";
      return;
    }

    var zone = under.closest("[data-drop]");
    if (!zone) return;
    d.target = zone.getAttribute("data-drop");
    zone.classList.add("is-drop-over");
    var card = under.closest("[data-photo]");
    if (card && zone.contains(card)) {
      var r = card.getBoundingClientRect();
      var afterCard = d.x > r.left + r.width / 2;
      card.classList.add(afterCard ? "is-insert-after" : "is-insert-before");
      var list = listOf(d.target) || [];
      d.insertIndex = list.indexOf(card.getAttribute("data-photo")) + (afterCard ? 1 : 0);
    }
  }

  function autoScroll() {
    var d = dragState;
    [body.querySelector("[data-works-main]"), body.querySelector("[data-works-side]")].forEach(function (el) {
      if (!el) return;
      var r = el.getBoundingClientRect();
      if (d.x < r.left || d.x > r.right || d.y < r.top || d.y > r.bottom) return;
      var edge = 48;
      if (d.y < r.top + edge) el.scrollTop -= 14;
      else if (d.y > r.bottom - edge) el.scrollTop += 14;
    });
  }

  function endDragVisuals() {
    var d = dragState;
    clearDropMarks();
    modal.classList.remove("is-dragging", "is-dragging-photo", "is-dragging-room");
    modal.querySelectorAll(".is-dragging-source").forEach(function (el) {
      el.classList.remove("is-dragging-source");
    });
    if (d && d.ghost) d.ghost.remove();
  }

  function finishDrag() {
    var d = dragState;
    endDragVisuals();
    dragState = null;
    suppressClick = true;
    window.setTimeout(function () {
      suppressClick = false;
    }, 0);
    if (d.kind === "room") {
      if (d.target === "rooms") moveRoom(d.id, d.beforeRoom);
      return;
    }
    if (!d.target) return;
    movePhotos(d.urls, d.target, d.insertIndex);
  }

  function cancelDrag() {
    if (dragState) window.clearTimeout(dragState.timer);
    endDragVisuals();
    dragState = null;
    announce("Déplacement annulé.");
  }
})();
