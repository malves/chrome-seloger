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

  var ISSUE_SURFACE = {
    floor_worn: "floor",
    floor_redo: "floor",
    paint: "walls",
    walls_damaged: "walls",
    ceiling_paint: "ceiling",
    ceiling_damaged: "ceiling",
  };
  var EXCLUSIVE_ISSUES = [
    ["floor_worn", "floor_redo"],
    ["ceiling_paint", "ceiling_damaged"],
  ];
  var GROUP_META = {
    unassigned: { icon: "inbox", hint: "Photos qui ne sont rattachées à aucune pièce." },
    exterior: { icon: "building", hint: "Façade, jardin, parties communes : hors pièces du logement." },
    excluded: { icon: "eye-off", hint: "Plans, projections ou images non exploitables : exclues de l'état des pièces." },
  };
  var SAVE_DELAY = 700;
  var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var S = {
    loaded: false,
    plan: null,
    options: null,
    photos: [],
    stored: false,
    aiStatus: "pending",
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

  function findRoom(id) {
    for (var i = 0; i < S.plan.rooms.length; i++) if (S.plan.rooms[i].id === id) return S.plan.rooms[i];
    return null;
  }

  function isGroup(key) {
    return key === "unassigned" || key === "exterior" || key === "excluded";
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
    if (!S.view || (!isGroup(S.view) && !findRoom(S.view))) {
      S.view = S.plan.rooms.length ? S.plan.rooms[0].id : "unassigned";
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
  }

  function renderSide() {
    var html = '<div class="works-side__section">';
    html +=
      '<p class="works-side__caption">Pièces <span class="works-side__count">' +
      S.plan.rooms.length +
      "</span></p>";
    html += '<ul class="works-side__list" role="list" data-works-room-list>';
    S.plan.rooms.forEach(function (room) {
      html += renderSideItem("room:" + room.id, room.id, roomName(room), typeIcon(room.type), room.photos.length, roomTone(room), optionLabel(S.options.roomConditions, room.condition));
    });
    html += "</ul>";
    html +=
      '<button type="button" class="works-side__add" data-action="add-room">' +
      icon("plus") +
      "<span>Ajouter une pièce</span></button>";
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

    html += '<div class="works-room__overview">' + renderRoomCondition(room) + renderTraits(room) + "</div>";
    html += renderPhotos("room:" + room.id);
    html += renderIssues(room);
    html +=
      '<label class="works-summary">' +
      '<span class="works-label">' + icon("message") + " Notes</span>" +
      '<textarea class="works-textarea" rows="2" maxlength="400" data-field="summary" placeholder="Ex. parquet à poncer, papier peint à retirer, trace près de la fenêtre…">' + esc(room.summary) + "</textarea>" +
      "</label>";
    html += "</div>";
    return html;
  }

  function renderTraits(room) {
    var ambiance = room.ambiance || {};
    var html =
      '<div class="works-traits" data-works-traits>' +
      '<div class="works-condition__head"><span class="works-label">Caractéristiques</span></div>' +
      '<p class="works-traits__lead">Hors travaux — utile pour l\'analyse du bien</p>' +
      '<div class="works-traits__list" role="group" aria-label="Caractéristiques de la pièce">';
    S.options.traits.forEach(function (t) {
      var on = t.values.indexOf(ambiance[t.field]) !== -1;
      html +=
        '<button type="button" class="works-trait' + (on ? " is-on" : "") + '" aria-pressed="' + on + '"' +
        ' data-action="toggle-trait" data-value="' + esc(t.value) + '">' +
        (on ? icon("check") : "") + esc(t.label) +
        (on && ambiance.source === "ai" ? icon("sparkles", "works-issue__ai") : "") +
        "</button>";
    });
    html += "</div></div>";
    return html;
  }

  function toggleTrait(room, key) {
    var t = optionOf(S.options.traits, key);
    if (!t || !room.ambiance) return;
    var on = t.values.indexOf(room.ambiance[t.field]) !== -1;
    room.ambiance[t.field] = on ? t.reset : t.set;
    room.ambiance.source = "user";
    changed();
    replaceBlock("[data-works-traits]", renderTraits(room), '[data-action="toggle-trait"][data-value="' + cssEscape(key) + '"]', true);
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

  function issueHint(room, key) {
    var surface = ISSUE_SURFACE[key];
    var note = surface && room[surface] && room[surface].note;
    return note ? "IA : " + note : "";
  }

  function renderIssues(room) {
    var issues = room.issues || [];
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
        return o.category === c.value;
      });
      var count = items.filter(function (o) {
        return issues.indexOf(o.value) !== -1;
      }).length;
      var catTone = categoryIssueTone(items, issues);
      html +=
        '<section class="works-issues__group' + (count ? " has-issues" : "") + '" role="group" aria-label="' + esc(c.label) + '">' +
        '<h4 class="works-issues__cat works-issues__cat--' + catTone + '">' + icon(c.icon) + "<span>" + esc(c.label) + "</span>" +
        (count ? '<span class="works-issues__count">' + count + "</span>" : "") +
        "</h4>" +
        '<div class="works-issues__list">';
      items.forEach(function (o) {
        var on = issues.indexOf(o.value) !== -1;
        var ai = on && fromAi.indexOf(o.value) !== -1;
        var hint = issueHint(room, o.value);
        html +=
          '<button type="button" class="works-issue works-issue--' + o.tone + (on ? " is-on" : "") + '"' +
          ' aria-pressed="' + on + '" data-action="toggle-issue" data-value="' + esc(o.value) + '"' +
          (hint ? ' title="' + esc(hint) + '"' : "") + ">" +
          '<span class="works-issue__mark">' + icon(on ? "check" : "plus") + "</span>" +
          esc(o.label) +
          (ai ? icon("sparkles", "works-issue__ai") : "") +
          "</button>";
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
      if (issues.indexOf(k) === -1) {
        issues.push(k);
        added.push(k);
      }
    });
    EXCLUSIVE_ISSUES.forEach(function (pair) {
      if (issues.indexOf(pair[1]) !== -1) {
        var weak = issues.indexOf(pair[0]);
        if (weak !== -1) issues.splice(weak, 1);
      }
    });
    room.issues = orderIssues(issues);
    room.issues_heavy_auto = added;
  }

  function toggleIssue(room, key) {
    var issues = (room.issues || []).slice();
    var at = issues.indexOf(key);
    if (at !== -1) {
      issues.splice(at, 1);
    } else {
      issues.push(key);
      EXCLUSIVE_ISSUES.forEach(function (pair) {
        var other = pair[0] === key ? pair[1] : pair[1] === key ? pair[0] : null;
        if (other && issues.indexOf(other) !== -1) issues.splice(issues.indexOf(other), 1);
      });
    }
    room.issues = S.options.issues
      .map(function (o) {
        return o.value;
      })
      .filter(function (k) {
        return issues.indexOf(k) !== -1;
      });
    changed();
    replaceBlock("[data-works-issues]", renderIssues(room), '[data-action="toggle-issue"][data-value="' + cssEscape(key) + '"]', true);
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
      condition: "average",
      condition_source: "user",
      summary: "",
      source: "user",
      issues: [],
      issues_ai: [],
      issues_heavy_auto: [],
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
    var name = roomName(room);
    toast("Pièce « " + name + " » supprimée" + (room.photos.length ? " — ses photos sont dans « À classer »" : "") + ".", "Annuler", function () {
      S.plan = snapshot;
      S.view = room.id;
      changed();
      rerender({ animateView: true });
      announce("Pièce « " + name + " » restaurée.");
    });
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
    changed();
    rerender();
    bump(body.querySelector('.works-side__item[data-select="' + id + '"]'));
  }

  /* ----------------------------- Calques (picker) ---------------------------- */

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
    var first = layer.querySelector("[data-layer-focus]") || layer.querySelector("button, textarea, select");
    if (first) first.focus({ preventScroll: true });
  }

  function closeLayer() {
    var layer = body.querySelector("[data-works-layer]");
    if (!layer || layer.hidden) return false;
    layer.hidden = true;
    layer.innerHTML = "";
    layer.onclick = null;
    S.viewer = null;
    return true;
  }

  function openTypePicker(mode) {
    var room = mode === "change" ? findRoom(S.view) : null;
    var html =
      '<div class="works-picker" role="dialog" aria-modal="true" aria-label="' + (room ? "Changer le type de pièce" : "Ajouter une pièce") + '">' +
      '<header class="works-picker__head"><h3>' + (room ? "Type de pièce" : "Quelle pièce ajouter ?") + "</h3>" +
      '<button type="button" class="modal__close" data-layer-close aria-label="Fermer">' + icon("close") + "</button></header>" +
      '<div class="works-picker__grid">' +
      S.options.roomTypes
        .map(function (o, i) {
          var on = room && room.type === o.value;
          return (
            '<button type="button" class="works-type' + (on ? " is-on" : "") + '" data-type="' + esc(o.value) + '" style="--i:' + i + '"' + (i === 0 ? " data-layer-focus" : "") + ">" +
            '<span class="works-type__icon">' + icon(o.icon) + "</span>" +
            '<span class="works-type__label">' + esc(o.label) + "</span></button>"
          );
        })
        .join("") +
      "</div></div>";
    openLayer(html, function (event) {
      var btn = event.target.closest("[data-type]");
      if (!btn) return;
      var type = btn.getAttribute("data-type");
      closeLayer();
      if (room) {
        var oldDefault = optionLabel(S.options.roomTypes, room.type);
        room.type = type;
        if (!room.label || room.label.indexOf(oldDefault) === 0) room.label = nextLabelFor(type);
        changed();
        rerender();
      } else {
        addRoom(type);
      }
    });
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
      applyTarget(target);
      return;
    }
    setSaveState("idle", "Chargement…");
    fetch(planUrl, { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        S.plan = data.plan;
        S.options = data.options;
        S.photos = data.photos || [];
        S.stored = data.stored;
        S.aiStatus = data.aiStatus;
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
    if (target && (isGroup(target) || findRoom(target))) {
      S.view = target;
      S.selection.clear();
    }
    rerender({ animateView: true });
    var main = body.querySelector("[data-works-main]");
    if (main) main.focus({ preventScroll: true });
  }

  function close() {
    if (modal.hidden) return;
    closeLayer();
    hideToast();
    modal.classList.add("is-closing");
    flush().then(function () {
      if (S.changed) S.changed = false;
    });
    window.setTimeout(
      function () {
        modal.hidden = true;
        modal.classList.remove("is-closing");
        document.body.classList.remove("is-modal-open");
        if (S.lastFocus && S.lastFocus.isConnected) S.lastFocus.focus({ preventScroll: true });
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
            S.photos = data.photos || S.photos;
            S.stored = false;
            S.aiStatus = data.aiStatus;
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
    if (t.closest("[data-works-retry]")) {
      open();
      return;
    }
    if (t.closest("[data-works-save-status]") && saveStatus.getAttribute("data-state") === "error") {
      save();
      return;
    }
    if (!S.loaded || t.closest("[data-works-layer]")) return;

    if (suppressClick) {
      suppressClick = false;
      return;
    }

    var actionEl = t.closest("[data-action]");
    var room = findRoom(S.view);
    if (actionEl) {
      var action = actionEl.getAttribute("data-action");
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
      if (action === "toggle-issue" && room) return toggleIssue(room, actionEl.getAttribute("data-value"));
      if (action === "toggle-trait" && room) return toggleTrait(room, actionEl.getAttribute("data-value"));
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

  modal.addEventListener("keydown", function (event) {
    if (modal.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (dragState && dragState.active) return cancelDrag();
      if (closeLayer()) return;
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
