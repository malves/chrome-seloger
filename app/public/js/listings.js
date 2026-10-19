/**
 * Liste des annonces : filtre de statut et tri sans rechargement.
 *
 * Les pastilles et les options de tri restent des liens servis par le serveur
 * (tout fonctionne sans JavaScript). Ici, on récupère la page cible, puis on
 * remplace la grille dans une View Transition : les cartes conservées glissent
 * vers leur nouvelle place, les autres sortent ou entrent (voir listings.css).
 */

(function () {
  "use strict";

  var results = document.querySelector("[data-listings-results]");
  var filters = document.querySelector("[data-listings-filters]");
  var head = document.querySelector("[data-listings-head]");
  if (!results || !filters || !window.fetch || !window.DOMParser) return;

  var LINKS = ".filters__group a, [data-sort-menu] a";
  // Éléments de la barre synchronisés un à un : ils gardent leurs écouteurs
  // (menus de projet et de tri liés au chargement dans app.js).
  var SYNCED = "a, [data-project-trigger], [data-sort-trigger]";
  var BUSY_DELAY = 150;

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var controller = null;
  var busyTimer = null;
  var currentUrl = withoutHash(location.href);

  function withoutHash(href) {
    var url = new URL(href, location.href);
    url.hash = "";
    return url.href;
  }

  function isPlainClick(event, link) {
    if (event.defaultPrevented || event.button !== 0) return false;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
    if (link.target && link.target !== "_self") return false;
    var url = new URL(link.href, location.href);
    return url.origin === location.origin && url.pathname === location.pathname;
  }

  function setBusy(busy) {
    clearTimeout(busyTimer);
    if (busy) {
      busyTimer = setTimeout(function () {
        results.setAttribute("aria-busy", "true");
      }, BUSY_DELAY);
    } else {
      results.removeAttribute("aria-busy");
    }
  }

  function syncElement(target, source) {
    Array.prototype.slice.call(target.attributes).forEach(function (attr) {
      if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name);
    });
    Array.prototype.forEach.call(source.attributes, function (attr) {
      if (target.getAttribute(attr.name) !== attr.value) {
        target.setAttribute(attr.name, attr.value);
      }
    });
    if (target.innerHTML !== source.innerHTML) target.innerHTML = source.innerHTML;
  }

  /**
   * Prépare le remplacement à partir de la page reçue. Renvoie `null` si sa
   * structure diffère de la page affichée : on retombe alors sur une
   * navigation classique.
   */
  function prepareUpdate(doc) {
    var nextResults = doc.querySelector("[data-listings-results]");
    var nextFilters = doc.querySelector("[data-listings-filters]");
    var nextHead = doc.querySelector("[data-listings-head]");
    if (!nextResults || !nextFilters) return null;

    var current = filters.querySelectorAll(SYNCED);
    var next = nextFilters.querySelectorAll(SYNCED);
    if (current.length !== next.length) return null;
    for (var i = 0; i < current.length; i++) {
      if (current[i].tagName !== next[i].tagName) return null;
    }

    return function update() {
      setBusy(false);
      for (var j = 0; j < current.length; j++) syncElement(current[j], next[j]);
      if (head && nextHead) head.innerHTML = nextHead.innerHTML;
      results.innerHTML = nextResults.innerHTML;
      if (window.htmx) window.htmx.process(results);
      document.title = doc.title;
    };
  }

  function swap(update) {
    if (reducedMotion.matches || typeof document.startViewTransition !== "function") {
      update();
      return;
    }
    document.startViewTransition(update);
  }

  function load(url, push) {
    if (controller) controller.abort();
    controller = new AbortController();
    setBusy(true);

    fetch(url, {
      headers: { Accept: "text/html" },
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(function (response) {
        var landed = new URL(response.url, location.href);
        if (!response.ok || landed.pathname !== location.pathname) {
          throw new Error("Réponse inattendue");
        }
        return response.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        var update = prepareUpdate(doc);
        if (!update) throw new Error("Structure inattendue");
        if (push) history.pushState({ listings: true }, "", url);
        currentUrl = withoutHash(url);
        swap(update);
      })
      .catch(function (error) {
        if (error && error.name === "AbortError") return;
        setBusy(false);
        location.assign(url);
      });
  }

  function closeSortMenu(link) {
    var menu = link.closest("[data-sort-menu]");
    if (!menu) return;
    var root = menu.closest("[data-sort-select]");
    var trigger = root && root.querySelector("[data-sort-trigger]");
    menu.hidden = true;
    if (trigger) {
      trigger.setAttribute("aria-expanded", "false");
      trigger.focus();
    }
  }

  filters.addEventListener("click", function (event) {
    var link = event.target.closest(LINKS);
    if (!link || !isPlainClick(event, link)) return;
    event.preventDefault();
    closeSortMenu(link);
    if (withoutHash(link.href) === currentUrl) return;
    load(link.href, true);
  });

  window.addEventListener("popstate", function () {
    var url = withoutHash(location.href);
    if (url === currentUrl) return;
    load(url, false);
  });
})();
