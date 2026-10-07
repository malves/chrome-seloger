/**
 * Interactions qui ne passent pas par htmx.
 *  - jeton CSRF ajouté automatiquement aux requêtes htmx ;
 *  - confirmation avant suppression ;
 *  - image de remplacement quand une photo distante ne charge plus.
 */

(function () {
  "use strict";

  document.addEventListener("htmx:configRequest", function (event) {
    var meta = document.querySelector('meta[name="csrf-token"]');
    if (meta) event.detail.headers["X-CSRF-Token"] = meta.content;
  });

  /**
   * Recharge le bloc d'analyse de marché (Immo Data).
   * Appelé après chaque changement d'adresse : le serveur a déjà résolu la
   * commune (INSEE) de façon synchrone.
   */
  /**
   * Recharge les blocs enrichissement (analyse de marché + territoire).
   * Utilisé après changement d'adresse, sans bouton manuel côté utilisateur.
   */
  function refreshListingEnrichmentLive() {
    var root = document.getElementById("listing-enrichment-live");
    if (!root || !window.htmx) return;
    var url = root.getAttribute("data-enrichment-url");
    if (!url) return;
    window.htmx.ajax("GET", url, {
      target: "#listing-enrichment-live",
      swap: "outerHTML",
    });
  }

  function refreshListingMarketBlocks() {
    refreshListingEnrichmentLive();
  }
  function refreshListingPrixM2Block() {
    refreshListingMarketBlocks();
  }
  window.refreshListingPrixM2Block = refreshListingPrixM2Block;

  // Onglets maison / appartement du graphique d'évolution (survivent au swap HTMX).
  document.addEventListener("click", function (event) {
    var tab = event.target.closest
      ? event.target.closest("[data-pricem2-type]")
      : null;
    if (!tab) return;
    var root = tab.closest("[data-pricem2-evolution]");
    if (!root) return;
    var type = tab.getAttribute("data-pricem2-type");
    root.querySelectorAll("[data-pricem2-type]").forEach(function (btn) {
      var active = btn.getAttribute("data-pricem2-type") === type;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    root.querySelectorAll("[data-pricem2-panel]").forEach(function (panel) {
      var active = panel.getAttribute("data-pricem2-panel") === type;
      panel.classList.toggle("is-active", active);
      if (active) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
    });
    if (!pricem2EvolutionDetailsOpen(root)) return;
    refreshPricem2PanelChart(root, type);
    syncPricem2EvolutionChartHeights(root);
  });

  var CHART_JS = "/public/vendor/chart.js/chart.umd.js";
  var pricem2ChartLoad = null;

  function loadChartJs() {
    if (window.Chart) return Promise.resolve(window.Chart);
    if (pricem2ChartLoad) return pricem2ChartLoad;
    pricem2ChartLoad = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = CHART_JS;
      script.async = true;
      script.onload = function () {
        resolve(window.Chart);
      };
      script.onerror = function () {
        pricem2ChartLoad = null;
        reject(new Error("chart_load_failed"));
      };
      document.head.appendChild(script);
    });
    return pricem2ChartLoad;
  }

  function pricem2ChartColors(wrap) {
    var styles = wrap
      ? getComputedStyle(wrap)
      : getComputedStyle(document.documentElement);
    return {
      city: (styles.getPropertyValue("--city") || "#2563eb").trim(),
      dept: (styles.getPropertyValue("--dept") || "#e08a2c").trim(),
      grid: (styles.getPropertyValue("--border") || "#e2ded1").trim(),
      muted: (styles.getPropertyValue("--ink-muted") || "#6b7280").trim(),
      surface: (styles.getPropertyValue("--surface") || "#ffffff").trim(),
    };
  }

  function formatEuroPrice(v) {
    if (v == null || !isFinite(v)) return "—";
    return new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: "EUR",
      maximumFractionDigits: 0,
    }).format(v);
  }

  var MONTHS_FR_SHORT = [
    "janv.",
    "févr.",
    "mars",
    "avr.",
    "mai",
    "juin",
    "juil.",
    "août",
    "sept.",
    "oct.",
    "nov.",
    "déc.",
  ];

  function formatMonthLabel(period) {
    var match = /^(\d{4})-(\d{2})$/.exec(String(period || ""));
    if (!match) return String(period || "");
    var month = MONTHS_FR_SHORT[Number(match[2]) - 1];
    return month ? month + " " + match[1] : String(period);
  }

  function readPricem2ChartConfig(canvas) {
    var wrap = canvas.parentElement;
    var node = wrap ? wrap.querySelector(".pricem2__chart-config") : null;
    if (!node || !node.textContent) return null;
    try {
      return JSON.parse(node.textContent);
    } catch (e) {
      return null;
    }
  }

  function destroyPricem2Chart(canvas) {
    if (!window.Chart) return;
    var existing = window.Chart.getChart(canvas);
    if (existing) existing.destroy();
  }

  function createPricem2Chart(canvas, config) {
    return loadChartJs().then(function (Chart) {
      destroyPricem2Chart(canvas);
      var wrap =
        canvas.closest(".pricem2__evolution") ||
        canvas.closest("[data-pricem2-evolution]") ||
        canvas.parentElement;
      var colors = pricem2ChartColors(wrap);
      var fontFamily = getComputedStyle(document.documentElement)
        .getPropertyValue("--font")
        .trim();
      var datasets = [
        {
          label: config.cityLabel,
          data: config.cityIndex,
          medianPrices: config.cityPrices,
          borderColor: colors.city,
          backgroundColor: colors.city + "1a",
          pointBackgroundColor: colors.surface,
          pointBorderColor: colors.city,
          pointBorderWidth: 2,
          pointHoverBackgroundColor: colors.city,
          pointHoverBorderColor: colors.surface,
          borderWidth: 2.5,
          tension: 0.35,
          fill: true,
        },
      ];
      if (
        config.deptLabel &&
        config.deptIndex.some(function (v) {
          return v != null;
        })
      ) {
        datasets.push({
          label: config.deptLabel,
          data: config.deptIndex,
          medianPrices: config.deptPrices,
          borderColor: colors.dept,
          backgroundColor: "transparent",
          pointBackgroundColor: colors.surface,
          pointBorderColor: colors.dept,
          pointBorderWidth: 2,
          pointHoverBackgroundColor: colors.dept,
          pointHoverBorderColor: colors.surface,
          borderWidth: 2.5,
          tension: 0.35,
          fill: false,
        });
      }
      return new Chart(canvas, {
        type: "line",
        data: {
          labels: config.labels.map(String),
          datasets: datasets,
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 650, easing: "easeOutQuart" },
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: "rgba(17, 21, 15, 0.94)",
              titleColor: "#f6f8f3",
              bodyColor: "#f6f8f3",
              padding: 12,
              cornerRadius: 10,
              titleFont: { size: 13, weight: "600", family: fontFamily },
              bodyFont: { size: 12, family: fontFamily },
              displayColors: true,
              boxPadding: 4,
              callbacks: {
                title: function (items) {
                  if (!items.length) return "";
                  var label = String(items[0].label);
                  if (/^\d{4}-\d{2}$/.test(label)) return formatMonthLabel(label);
                  return "Année " + label;
                },
                label: function (ctx) {
                  var idx = ctx.parsed.y;
                  if (idx == null || !isFinite(idx)) return null;
                  var price = ctx.dataset.medianPrices[ctx.dataIndex];
                  return (
                    ctx.dataset.label +
                    " · indice " +
                    idx.toLocaleString("fr-FR") +
                    " · " +
                    formatEuroPrice(price) +
                    "/m²"
                  );
                },
              },
            },
          },
          scales: {
            x: {
              grid: { display: false },
              border: { display: false },
              ticks: {
                color: colors.muted,
                font: { size: 11, family: fontFamily },
                maxTicksLimit: config.interval === "monthly" ? 8 : 12,
                callback: function (value) {
                  var label = this.getLabelForValue
                    ? this.getLabelForValue(value)
                    : value;
                  if (/^\d{4}-\d{2}$/.test(String(label))) {
                    return formatMonthLabel(label);
                  }
                  return label;
                },
              },
            },
            y: {
              grid: { color: colors.grid + "99" },
              border: { display: false },
              ticks: {
                color: colors.muted,
                font: { size: 11, family: fontFamily },
                callback: function (v) {
                  return v.toLocaleString("fr-FR");
                },
              },
            },
          },
          elements: {
            point: {
              radius: config.interval === "monthly" ? 0 : 3,
              hoverRadius: 6,
              hitRadius: 22,
            },
            line: { borderCapStyle: "round" },
          },
          onHover: function (event, elements) {
            canvas.style.cursor = elements.length ? "pointer" : "default";
          },
        },
      });
    });
  }

  function pricem2EvolutionDetailsOpen(root) {
    if (!root) return true;
    var details =
      root.matches && root.matches("details[data-pricem2-evolution]")
        ? root
        : root.querySelector && root.querySelector("details[data-pricem2-evolution]");
    if (!details) return true;
    return details.open;
  }

  function initPricem2Charts(root) {
    if (!root) return Promise.resolve();
    if (!pricem2EvolutionDetailsOpen(root)) return Promise.resolve();
    var canvases = root.querySelectorAll("canvas[data-pricem2-chart]");
    if (!canvases.length) return Promise.resolve();
    var jobs = [];
    canvases.forEach(function (canvas) {
      var evolutionDetails = canvas.closest("details[data-pricem2-evolution]");
      if (evolutionDetails && !evolutionDetails.open) return;
      var panel = canvas.closest("[data-pricem2-panel]");
      if (panel && panel.hasAttribute("hidden")) return;
      var config = readPricem2ChartConfig(canvas);
      if (!config) return;
      jobs.push(createPricem2Chart(canvas, config));
    });
    return Promise.all(jobs);
  }

  function refreshPricem2PanelChart(root, panelKey) {
    if (!root) return;
    if (!pricem2EvolutionDetailsOpen(root)) return;
    var panel = root.querySelector('[data-pricem2-panel="' + panelKey + '"]');
    if (!panel) return;
    var canvas = panel.querySelector("canvas[data-pricem2-chart]");
    if (!canvas) return;
    requestAnimationFrame(function () {
      loadChartJs()
        .then(function () {
          var chart = window.Chart.getChart(canvas);
          if (chart) {
            chart.resize();
            return null;
          }
          var config = readPricem2ChartConfig(canvas);
          if (config) return createPricem2Chart(canvas, config);
          return null;
        })
        .catch(function () {});
    });
  }

  function applyPricem2DefaultTab(root) {
    if (!root) return;
    var preferred = root.getAttribute("data-pricem2-default");
    if (preferred !== "house" && preferred !== "apartment") return;
    var tab = root.querySelector('[data-pricem2-type="' + preferred + '"]');
    if (!tab || tab.classList.contains("is-active")) return;
    tab.click();
  }

  function mountVisiblePricem2Charts(root) {
    if (!root) return Promise.resolve();
    return initPricem2Charts(root).then(function () {
      return loadChartJs();
    }).then(function (Chart) {
      if (!Chart) return;
      root.querySelectorAll("canvas[data-pricem2-chart]").forEach(function (canvas) {
        var evolutionDetails = canvas.closest("details[data-pricem2-evolution]");
        if (evolutionDetails && !evolutionDetails.open) return;
        var panel = canvas.closest("[data-pricem2-panel]");
        if (panel && panel.hasAttribute("hidden")) return;
        var chart = Chart.getChart(canvas);
        if (chart) {
          chart.resize();
          return;
        }
        var config = readPricem2ChartConfig(canvas);
        if (config) return createPricem2Chart(canvas, config);
        return null;
      });
    }).catch(function () {});
  }

  function pricem2EvolutionChartHeightSyncEnabled(layout) {
    if (!layout || !layout.querySelector(".pricem2__evolution-aside")) return false;
    return window.matchMedia("(min-width: 821px)").matches;
  }

  function syncPricem2EvolutionChartHeight(layout) {
    if (!layout) return;
    if (!pricem2EvolutionChartHeightSyncEnabled(layout)) {
      layout.style.removeProperty("--pricem2-evolution-chart-h");
      return;
    }
    var aside = layout.querySelector(".pricem2__evolution-aside");
    if (!aside) {
      layout.style.removeProperty("--pricem2-evolution-chart-h");
      return;
    }
    var h = Math.round(aside.getBoundingClientRect().height);
    if (h < 1) return;
    layout.style.setProperty("--pricem2-evolution-chart-h", h + "px");
  }

  function resizePricem2ChartsInLayout(layout) {
    if (!layout || !window.Chart) return;
    layout.querySelectorAll("canvas[data-pricem2-chart]").forEach(function (canvas) {
      var panel = canvas.closest("[data-pricem2-panel]");
      if (panel && panel.hasAttribute("hidden")) return;
      var chart = window.Chart.getChart(canvas);
      if (chart) chart.resize();
    });
  }

  function syncPricem2EvolutionLayout(layout) {
    syncPricem2EvolutionChartHeight(layout);
    requestAnimationFrame(function () {
      resizePricem2ChartsInLayout(layout);
    });
  }

  function syncPricem2EvolutionChartHeights(root) {
    var layouts = [];
    if (!root) {
      layouts = Array.from(document.querySelectorAll(".pricem2__evolution-layout"));
    } else if (root.matches && root.matches(".pricem2__evolution-layout")) {
      layouts = [root];
    } else if (root.querySelectorAll) {
      layouts = Array.from(root.querySelectorAll(".pricem2__evolution-layout"));
    }
    layouts.forEach(syncPricem2EvolutionLayout);
  }

  var pricem2EvolutionHeightObservers =
    typeof WeakMap !== "undefined" ? new WeakMap() : null;

  function observePricem2EvolutionAside(layout) {
    if (!layout || !pricem2EvolutionHeightObservers) return;
    if (pricem2EvolutionHeightObservers.has(layout)) return;
    var aside = layout.querySelector(".pricem2__evolution-aside");
    if (!aside) return;
    var ro = new ResizeObserver(function () {
      syncPricem2EvolutionLayout(layout);
    });
    ro.observe(aside);
    pricem2EvolutionHeightObservers.set(layout, ro);
  }

  function bindPricem2EvolutionLayoutHeights(root) {
    var layouts = [];
    if (!root) {
      layouts = Array.from(document.querySelectorAll(".pricem2__evolution-layout"));
    } else if (root.matches && root.matches(".pricem2__evolution-layout")) {
      layouts = [root];
    } else if (root.querySelectorAll) {
      layouts = Array.from(root.querySelectorAll(".pricem2__evolution-layout"));
    }
    layouts.forEach(function (layout) {
      observePricem2EvolutionAside(layout);
      syncPricem2EvolutionLayout(layout);
    });
  }

  function schedulePricem2EvolutionCharts(details) {
    if (!details || !details.open) return;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        applyPricem2DefaultTab(details);
        bindPricem2EvolutionLayoutHeights(details);
        mountVisiblePricem2Charts(details).then(function () {
          syncPricem2EvolutionChartHeights(details);
        });
      });
    });
  }

  function bindPricem2EvolutionDetails(details) {
    if (!details || details.dataset.pricem2EvolutionBound === "1") return;
    details.dataset.pricem2EvolutionBound = "1";
    details.addEventListener("toggle", function () {
      if (!details.open) return;
      schedulePricem2EvolutionCharts(details);
    });
  }

  function bootPricem2Charts() {
    document.querySelectorAll("details[data-pricem2-evolution]").forEach(function (el) {
      bindPricem2EvolutionDetails(el);
      if (el.open) {
        schedulePricem2EvolutionCharts(el);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootPricem2Charts);
  } else {
    bootPricem2Charts();
  }

  var pricem2EvolutionHeightMq = window.matchMedia("(min-width: 821px)");
  if (pricem2EvolutionHeightMq.addEventListener) {
    pricem2EvolutionHeightMq.addEventListener("change", function () {
      syncPricem2EvolutionChartHeights(document);
    });
  } else if (pricem2EvolutionHeightMq.addListener) {
    pricem2EvolutionHeightMq.addListener(function () {
      syncPricem2EvolutionChartHeights(document);
    });
  }

  // Toute mise à jour du bloc localisation (saisie, effacement, adresse IA)
  // passe par un swap de #listing-location-block : on en profite pour relancer
  // l'analyse de marché une fois le swap stabilisé.
  document.body.addEventListener("htmx:afterSettle", function (event) {
    var target = event.detail && event.detail.target;
    if (!target) return;
    if (target.id === "listing-location-block") {
      refreshListingPrixM2Block();
      return;
    }
    if (target.id === "listing-enrichment-live") {
      bootPricem2Charts();
      return;
    }
    var block =
      target.id === "provider-immo-data"
        ? target
        : target.closest && target.closest("#provider-immo-data");
    if (block) {
      var evolution = block.querySelector("details[data-pricem2-evolution]");
      if (evolution) {
        bindPricem2EvolutionDetails(evolution);
        if (evolution.open) schedulePricem2EvolutionCharts(evolution);
      }
    }
  });

  // Bouton « Copier » générique : copie le code du bloc .dpe-cmd voisin.
  // En écouteur délégué pour survivre aux remplacements htmx du panneau.
  document.addEventListener("click", function (event) {
    var button = event.target.closest ? event.target.closest("[data-copy]") : null;
    if (!button) return;
    event.preventDefault();
    var wrapper = button.closest(".dpe-cmd");
    var code = wrapper ? wrapper.querySelector(".dpe-cmd__code") : null;
    var text = code ? code.textContent.trim() : "";
    if (!text) return;

    var done = function () {
      var original = button.getAttribute("data-copy-label") || button.textContent;
      button.setAttribute("data-copy-label", original);
      button.textContent = "Copié !";
      button.classList.add("is-copied");
      window.setTimeout(function () {
        button.textContent = original;
        button.classList.remove("is-copied");
      }, 1500);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        fallbackCopy(text);
        done();
      });
    } else {
      fallbackCopy(text);
      done();
    }
  });

  function fallbackCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "absolute";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand("copy");
    } catch (err) {
      /* ignoré : la sélection reste copiable manuellement */
    }
    document.body.removeChild(area);
  }

  // Carnet d'adresses : le retour inline (succès / erreur) s'efface tout seul
  // après quelques secondes, pour ne pas encombrer le panneau.
  document.body.addEventListener("htmx:afterSwap", function (event) {
    var target = event.target;
    if (!target || !target.querySelector) return;
    var flash = target.querySelector("[data-address-flash]");
    if (!flash) return;
    window.setTimeout(function () {
      flash.classList.add("address-book__flash--out");
      window.setTimeout(function () {
        if (flash.parentNode) flash.parentNode.removeChild(flash);
      }, 400);
    }, 3500);
  });

  // Formulaires de filtres : soumission dès qu'un contrôle change.
  // En écouteur délégué plutôt qu'en attribut `onchange`, interdit par la CSP.
  document.addEventListener("change", function (event) {
    var form = event.target.closest("form[data-autosubmit]");
    if (form && event.target.tagName === "SELECT") form.requestSubmit();
  });

  // Confirmation avant une action destructrice, via une modale maison.
  // Les formulaires concernés portent un attribut `data-confirm` (message),
  // et, en option, `data-confirm-title` et `data-confirm-label`.
  var modal = document.getElementById("confirm-modal");
  var modalTitle = modal && modal.querySelector("[data-modal-title]");
  var modalMessage = modal && modal.querySelector("[data-modal-message]");
  var modalConfirm = modal && modal.querySelector("[data-modal-confirm]");
  var pendingForm = null;
  var pendingIssue = null; // callback htmx (issueRequest) quand c'est une requête htmx
  var pendingHtmxReplay = null; // copie de la requête si le formulaire est retiré du DOM (ex. polling)
  var lastFocused = null;

  function openModal(form, message) {
    pendingForm = form;
    lastFocused = document.activeElement;
    if (modalMessage) modalMessage.textContent = message;
    if (modalTitle) {
      modalTitle.textContent =
        form.getAttribute("data-confirm-title") || "Confirmer la suppression";
    }
    if (modalConfirm) {
      modalConfirm.textContent =
        form.getAttribute("data-confirm-label") || "Supprimer";
    }
    modal.hidden = false;
    document.body.classList.add("is-modal-open");
    if (modalConfirm) modalConfirm.focus();
  }

  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove("is-modal-open");
    pendingForm = null;
    pendingIssue = null;
    pendingHtmxReplay = null;
    if (lastFocused && typeof lastFocused.focus === "function") {
      lastFocused.focus();
    }
    lastFocused = null;
  }

  function confirmPending() {
    var form = pendingForm;
    var issue = pendingIssue;
    var replay = pendingHtmxReplay;
    closeModal();
    // Requête htmx : on relance celle que htmx:confirm avait mise en pause.
    // Si le formulaire a été remplacé entre-temps (polling, swap htmx), on rejoue
    // la requête avec les valeurs figées à l'ouverture de la modale.
    if (replay && typeof htmx !== "undefined") {
      var source = replay.form;
      if (typeof replay.issue === "function" && source && source.isConnected) {
        replay.issue(true);
        return;
      }
      if (replay.path) {
        htmx.ajax(replay.verb || "post", replay.path, {
          target: replay.hxTarget,
          swap: replay.hxSwap,
          values: replay.values,
        });
        return;
      }
    }
    if (typeof issue === "function") {
      issue(true);
      return;
    }
    if (!form) return;
    // Marqueur pour laisser passer la soumission au second tour.
    form.dataset.confirmed = "1";
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
  }

  document.addEventListener("submit", function (event) {
    var form = event.target;
    var message = form.getAttribute("data-confirm");
    if (!message) return;

    // Formulaires htmx : la confirmation passe par l'évènement `htmx:confirm`
    // (voir plus bas), pas par ce gestionnaire, pour éviter une double modale.
    if (
      form.hasAttribute("hx-post") ||
      form.hasAttribute("hx-get") ||
      form.hasAttribute("hx-put") ||
      form.hasAttribute("hx-delete")
    ) {
      return;
    }

    // Soumission déjà confirmée : on laisse faire.
    if (form.dataset.confirmed === "1") {
      delete form.dataset.confirmed;
      return;
    }

    event.preventDefault();

    if (modal) {
      openModal(form, message);
    } else if (window.confirm(message)) {
      // Repli si la modale est absente du DOM.
      form.dataset.confirmed = "1";
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
    }
  });

  // Confirmation des requêtes htmx : htmx déclenche `htmx:confirm` avant chaque
  // requête. Pour les éléments portant `data-confirm`, on met la requête en
  // pause et on ouvre la modale maison ; on la relance seulement si l'utilisateur
  // confirme. Sans `data-confirm`, htmx poursuit normalement.
  document.body.addEventListener("htmx:confirm", function (event) {
    var elt = event.detail && event.detail.elt;
    if (!elt || !modal) return;
    var confirmRoot =
      (elt.getAttribute && elt.getAttribute("data-confirm") && elt) ||
      (elt.closest && elt.closest("[data-confirm]"));
    var message =
      confirmRoot && confirmRoot.getAttribute && confirmRoot.getAttribute("data-confirm");
    if (!message) return;
    event.preventDefault();
    var detail = event.detail;
    var form =
      confirmRoot.tagName === "FORM"
        ? confirmRoot
        : confirmRoot.closest && confirmRoot.closest("form");
    var requestRoot = form || confirmRoot;
    pendingIssue = detail.issueRequest;
    pendingHtmxReplay = {
      issue: detail.issueRequest,
      form: requestRoot,
      verb: detail.verb,
      path: detail.path,
      hxTarget: requestRoot.getAttribute("hx-target"),
      hxSwap: requestRoot.getAttribute("hx-swap"),
      values:
        form && typeof htmx !== "undefined"
          ? htmx.values(form, detail.verb || "post")
          : null,
    };
    openModal(confirmRoot, message);
  });

  if (modal) {
    modal.addEventListener("click", function (event) {
      if (event.target.closest("[data-modal-confirm]")) confirmPending();
      else if (event.target.closest("[data-modal-dismiss]")) closeModal();
    });

    document.addEventListener("keydown", function (event) {
      if (modal.hidden || event.key !== "Escape") return;
      closeModal();
    });
  }

  // Renommage (projets, carnet d'adresses) : le crayon ou un double-clic
  // sur le libellé ou l'adresse ouvre un champ. Quitter le champ enregistre
  // (Entrée aussi), Échap annule.
  function renameRoot(node) {
    return node && node.closest ? node.closest("[data-rename]") : null;
  }

  function renameLabel(root) {
    return root.querySelector("[data-rename-label], [data-project-label]");
  }

  function renameValue(label) {
    if (!label) return "";
    if (label.hasAttribute("data-rename-value")) {
      return label.getAttribute("data-rename-value");
    }
    return label.textContent.trim();
  }

  function closeRename(root) {
    var label = renameLabel(root);
    var button = root.querySelector("[data-rename-open]");
    var form = root.querySelector("[data-rename-form]");
    if (label) label.hidden = false;
    if (button) button.hidden = false;
    if (form) form.hidden = true;
  }

  function commitRename(input) {
    if (input.dataset.skipCommit === "1") {
      delete input.dataset.skipCommit;
      return;
    }
    if (input.dataset.committing === "1") return;

    var root = renameRoot(input);
    if (!root) return;
    var label = renameLabel(root);
    var current = renameValue(label);
    var next = input.value.trim();
    var allowEmpty = input.dataset.renameAllowEmpty === "1";

    if ((!next && !allowEmpty) || next === current) {
      input.value = current;
      closeRename(root);
      return;
    }

    input.value = next;
    input.dataset.committing = "1";
    var form = input.form;
    if (form && typeof form.requestSubmit === "function") form.requestSubmit();
    else if (form) form.submit();
  }

  function openRename(root) {
    if (!root) return;
    var label = renameLabel(root);
    var button = root.querySelector("[data-rename-open]");
    var form = root.querySelector("[data-rename-form]");
    var input = form && form.querySelector("[data-rename-input]");
    if (!label || !form || !input) return;

    input.value = renameValue(label);
    label.hidden = true;
    if (button) button.hidden = true;
    form.hidden = false;
    input.focus();
    input.select();
  }

  document.addEventListener("click", function (event) {
    var button = event.target.closest("[data-rename-open]");
    if (!button) return;
    openRename(renameRoot(button));
  });

  document.addEventListener("dblclick", function (event) {
    var label = event.target.closest
      ? event.target.closest("[data-rename-label]")
      : null;
    if (!label) return;
    event.preventDefault();
    openRename(renameRoot(label));
  });

  document.addEventListener("focusout", function (event) {
    var input = event.target.closest
      ? event.target.closest("[data-rename-input]")
      : null;
    if (!input) return;
    commitRename(input);
  });

  document.addEventListener("keydown", function (event) {
    var input = event.target.closest
      ? event.target.closest("[data-rename-input]")
      : null;
    if (!input) return;

    if (event.key === "Escape") {
      event.preventDefault();
      var root = renameRoot(input);
      var label = root && renameLabel(root);
      var button = root && root.querySelector("[data-rename-open]");
      input.dataset.skipCommit = "1";
      if (label) input.value = renameValue(label);
      if (root) closeRename(root);
      if (button) button.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    }
  });

  // Réorganisation des projets par glisser-déposer, via la poignée (burger).
  // L'ordre choisi est enregistré côté serveur et réutilisé pour l'affichage.
  (function initProjectReorder() {
    var list = document.querySelector("[data-project-reorder]");
    if (!list) return;

    var dragging = null;

    function items() {
      return Array.prototype.slice.call(
        list.querySelectorAll(".project-list__item")
      );
    }

    function clearDraggable() {
      items().forEach(function (item) {
        item.setAttribute("draggable", "false");
      });
    }

    // On n'active le glisser que depuis la poignée : les liens, le crayon et la
    // sélection de texte dans le reste de l'item restent utilisables.
    list.addEventListener("pointerdown", function (event) {
      var handle = event.target.closest("[data-drag-handle]");
      var item = handle && handle.closest(".project-list__item");
      if (item) item.setAttribute("draggable", "true");
    });
    list.addEventListener("pointerup", clearDraggable);
    list.addEventListener("pointercancel", clearDraggable);

    list.addEventListener("dragstart", function (event) {
      var item = event.target.closest(".project-list__item");
      if (!item || item.getAttribute("draggable") !== "true") {
        event.preventDefault();
        return;
      }
      dragging = item;
      item.classList.add("is-dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(
          "text/plain",
          item.getAttribute("data-project-id") || ""
        );
      }
    });

    function itemAfter(y) {
      var closest = null;
      var closestOffset = Number.NEGATIVE_INFINITY;
      items().forEach(function (item) {
        if (item === dragging) return;
        var box = item.getBoundingClientRect();
        var offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closestOffset) {
          closestOffset = offset;
          closest = item;
        }
      });
      return closest;
    }

    list.addEventListener("dragover", function (event) {
      if (!dragging) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      var after = itemAfter(event.clientY);
      if (after == null) list.appendChild(dragging);
      else if (after !== dragging) list.insertBefore(dragging, after);
    });

    list.addEventListener("drop", function (event) {
      if (dragging) event.preventDefault();
    });

    list.addEventListener("dragend", function () {
      if (!dragging) return;
      dragging.classList.remove("is-dragging");
      dragging = null;
      clearDraggable();
      persist();
    });

    function persist() {
      var order = items()
        .map(function (item) {
          return item.getAttribute("data-project-id");
        })
        .filter(Boolean);
      if (!order.length) return;

      var meta = document.querySelector('meta[name="csrf-token"]');
      var token = meta ? meta.content : "";
      var body =
        "order=" +
        encodeURIComponent(order.join(",")) +
        "&_csrf=" +
        encodeURIComponent(token);

      fetch("/projects/reorder", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-CSRF-Token": token,
          "X-Requested-With": "XMLHttpRequest"
        },
        body: body
      }).catch(function () {
        // En cas d'échec réseau, l'ordre affiché reste celui qu'on vient de
        // poser ; il sera resynchronisé au prochain chargement de la page.
      });
    }
  })();

  // Autocomplétion des adresses de référence : libellé ou adresse, menu partagé.
  // La sélection remplit toujours les deux champs.
  (function initAddressSuggest() {
    var root = document.querySelector("[data-address-suggest]");
    if (!root) return;

    var addressInput = root.querySelector("[data-address-input]");
    var labelInput = root.querySelector("[data-label-input]");
    var menu = root.querySelector("[data-address-menu]");
    if (!addressInput || !labelInput || !menu) return;

    var comboboxInputs = [labelInput, addressInput];
    var activeInput = null;
    var options = Array.prototype.slice.call(
      menu.querySelectorAll("[data-address-option]")
    );
    var activeIndex = -1;

    function normalize(value) {
      return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
    }

    function visibleOptions() {
      return options.filter(function (opt) {
        return !opt.parentElement.hidden;
      });
    }

    function setExpanded(expanded) {
      comboboxInputs.forEach(function (el) {
        el.setAttribute("aria-expanded", expanded ? "true" : "false");
      });
    }

    function positionMenu() {
      // Ancre le menu juste sous le champ actif (libellé ou adresse), plutôt
      // qu'en bas du bloc qui contient les deux champs.
      var anchor = activeInput || addressInput;
      menu.style.top = anchor.offsetTop + anchor.offsetHeight + 4 + "px";
    }

    function openMenu() {
      if (!visibleOptions().length) return;
      positionMenu();
      menu.hidden = false;
      setExpanded(true);
    }

    function closeMenu() {
      menu.hidden = true;
      setExpanded(false);
      setActive(-1);
    }

    function setActive(index) {
      var shown = visibleOptions();
      activeIndex = index;
      options.forEach(function (opt) {
        opt.classList.remove("is-active");
        opt.setAttribute("aria-selected", "false");
      });
      if (index >= 0 && index < shown.length) {
        var opt = shown[index];
        opt.classList.add("is-active");
        opt.setAttribute("aria-selected", "true");
        if (typeof opt.scrollIntoView === "function") {
          opt.scrollIntoView({ block: "nearest" });
        }
      }
    }

    function filterOptions(fromInput) {
      var source = fromInput || activeInput || addressInput;
      var needle = normalize(source.value);
      options.forEach(function (opt) {
        var hay = normalize(
          (opt.getAttribute("data-label") || "") +
            " " +
            (opt.getAttribute("data-address") || "")
        );
        opt.parentElement.hidden = needle !== "" && hay.indexOf(needle) === -1;
      });
      setActive(-1);
      if (visibleOptions().length) openMenu();
      else closeMenu();
    }

    function choose(opt) {
      if (!opt) return;
      var address = opt.getAttribute("data-address") || "";
      var label = opt.getAttribute("data-label") || "";
      addressInput.value = address;
      labelInput.value = label;
      closeMenu();
      var focusTarget = activeInput || addressInput;
      focusTarget.focus();
    }

    function onComboboxFocus(event) {
      activeInput = event.target;
      filterOptions(activeInput);
    }

    function onComboboxInput(event) {
      activeInput = event.target;
      filterOptions(activeInput);
    }

    function onComboboxKeydown(event) {
      activeInput = event.target;
      var shown = visibleOptions();
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (menu.hidden) openMenu();
        if (shown.length) setActive((activeIndex + 1) % shown.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        if (shown.length) {
          setActive(activeIndex <= 0 ? shown.length - 1 : activeIndex - 1);
        }
      } else if (event.key === "Enter") {
        if (!menu.hidden && activeIndex >= 0 && shown[activeIndex]) {
          event.preventDefault();
          choose(shown[activeIndex]);
        }
      } else if (event.key === "Escape") {
        if (!menu.hidden) {
          event.preventDefault();
          closeMenu();
        }
      }
    }

    comboboxInputs.forEach(function (el) {
      el.addEventListener("focus", onComboboxFocus);
      el.addEventListener("input", onComboboxInput);
      el.addEventListener("keydown", onComboboxKeydown);
    });

    menu.addEventListener("mousedown", function (event) {
      // mousedown plutôt que click : évite le blur de l'input avant la sélection.
      var opt = event.target.closest("[data-address-option]");
      if (!opt) return;
      event.preventDefault();
      choose(opt);
    });

    document.addEventListener("click", function (event) {
      if (!root.contains(event.target)) closeMenu();
    });
  })();

  // Paramètres : menu à gauche, contenu à droite. Un clic sur un item du menu
  // affiche le panneau correspondant et masque les autres.
  (function initSettingsTabs() {
    var menu = document.querySelector(".settings-menu__nav");
    var content = document.querySelector(".settings-content");
    if (!menu || !content) return;

    var items = Array.prototype.slice.call(
      menu.querySelectorAll("[data-settings-tab]")
    );
    var panels = Array.prototype.slice.call(
      content.querySelectorAll("[data-settings-panel]")
    );

    function activate(name) {
      items.forEach(function (item) {
        var active = item.getAttribute("data-settings-tab") === name;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-selected", active ? "true" : "false");
      });
      panels.forEach(function (panel) {
        panel.hidden = panel.getAttribute("data-settings-panel") !== name;
      });
    }

    menu.addEventListener("click", function (event) {
      var item = event.target.closest("[data-settings-tab]");
      if (!item) return;
      activate(item.getAttribute("data-settings-tab"));
    });
  })();

  // Admin HexaSmal : onglets Import / Explorer la base.
  (function initHexasmalSectionTabs() {
    var root = document.querySelector("[data-hexasmal-section-tabs]");
    if (!root) return;
    var tabs = Array.prototype.slice.call(
      root.querySelectorAll("[data-hexasmal-section]")
    );
    var panels = Array.prototype.slice.call(
      document.querySelectorAll("[data-hexasmal-section-panel]")
    );

    function activate(name) {
      tabs.forEach(function (tab) {
        var active = tab.getAttribute("data-hexasmal-section") === name;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-selected", active ? "true" : "false");
      });
      panels.forEach(function (panel) {
        var active = panel.getAttribute("data-hexasmal-section-panel") === name;
        panel.classList.toggle("is-active", active);
        panel.hidden = !active;
      });
    }

    root.addEventListener("click", function (event) {
      var tab = event.target.closest("[data-hexasmal-section]");
      if (!tab) return;
      activate(tab.getAttribute("data-hexasmal-section"));
    });
  })();

  // Admin : inspecteur JSON du cache enrichissement.
  (function initAdminCacheModal() {
    var modal = document.getElementById("admin-cache-modal");
    var content = modal && modal.querySelector("[data-admin-cache-content]");
    if (!modal || !content) return;

    var activeController = null;

    function closeModal() {
      if (activeController) {
        activeController.abort();
        activeController = null;
      }
      modal.hidden = true;
      document.body.classList.remove("is-modal-open");
    }

    function openModal() {
      modal.hidden = false;
      document.body.classList.add("is-modal-open");
    }

    function showLoading() {
      content.innerHTML =
        '<p class="admin-cache-dialog__loading">Chargement…</p>';
    }

    function showError(message) {
      content.innerHTML =
        '<p class="admin-cache-dialog__loading">' +
        (message || "Impossible de charger cette entrée.") +
        "</p>";
    }

    function setOpenState(entry, open) {
      if (!entry) return;
      var toggle = entry.querySelector(":scope > .jv-line .jv-toggle[data-jv-toggle]");
      var children = entry.querySelector(":scope > .jv-children");
      if (toggle) {
        toggle.classList.toggle("is-open", open);
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
      }
      if (children) children.classList.toggle("is-open", open);
    }

    function bindJsonView(panel) {
      if (!panel) return;
      var tree = panel.querySelector("[data-jv-tree]");
      var pathbar = panel.querySelector("[data-jv-pathbar]");
      var filterInput = panel.querySelector("[data-jv-filter]");
      var copyBtn = panel.querySelector("[data-jv-copy]");
      var jsonField = panel.querySelector("[data-jv-json]");

      function selectPath(path) {
        if (!tree) return;
        tree.querySelectorAll(".jv-entry.is-selected").forEach(function (el) {
          el.classList.remove("is-selected");
        });
        var target = null;
        tree.querySelectorAll(".jv-entry").forEach(function (el) {
          if (el.getAttribute("data-jv-path") === path) target = el;
        });
        if (target) {
          target.classList.add("is-selected");
          target.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
        if (pathbar) {
          pathbar.innerHTML =
            '<button type="button" class="jv-path__seg' +
            (path === "root" ? " is-active" : "") +
            '" data-jv-focus="root">racine</button>';
          if (path !== "root") {
            var current = document.createElement("span");
            current.className = "jv-path__current";
            current.textContent = path.replace(/^root\.?/, "");
            pathbar.appendChild(current);
          }
        }
      }

      if (tree) {
        tree.addEventListener("click", function (event) {
          var toggle = event.target.closest("[data-jv-toggle]");
          if (toggle) {
            event.preventDefault();
            event.stopPropagation();
            var branch = toggle.closest(".jv-entry--branch, .jv-root");
            if (!branch) return;
            var children = branch.querySelector(":scope > .jv-children");
            var open = !(children && children.classList.contains("is-open"));
            setOpenState(branch, open);
            return;
          }
          var line = event.target.closest(".jv-line");
          var entry = line && line.closest(".jv-entry");
          if (entry) {
            var path = entry.getAttribute("data-jv-path");
            if (path) selectPath(path);
          }
        });
      }

      if (pathbar) {
        pathbar.addEventListener("click", function (event) {
          var btn = event.target.closest("[data-jv-focus]");
          if (btn) selectPath(btn.getAttribute("data-jv-focus") || "root");
        });
      }

      panel.querySelectorAll("[data-jv-expand-all]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          panel.querySelectorAll(".jv-entry--branch, .jv-root").forEach(function (entry) {
            setOpenState(entry, true);
          });
        });
      });

      panel.querySelectorAll("[data-jv-collapse-all]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          panel.querySelectorAll(".jv-entry--branch, .jv-root").forEach(function (entry) {
            setOpenState(entry, false);
          });
        });
      });

      if (filterInput && tree) {
        filterInput.addEventListener("input", function () {
          var q = filterInput.value.trim().toLowerCase();
          tree.querySelectorAll(".jv-entry").forEach(function (entry) {
            if (!q) {
              entry.hidden = false;
              return;
            }
            var text = (entry.getAttribute("data-jv-path") || "") + " " + entry.textContent;
            entry.hidden = !text.toLowerCase().includes(q);
          });
        });
      }

      if (copyBtn && jsonField) {
        copyBtn.addEventListener("click", function () {
          var text = jsonField.value;
          if (!text) return;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
              copyBtn.textContent = "Copié !";
              setTimeout(function () {
                copyBtn.textContent = "Copier le JSON";
              }, 1600);
            });
          } else {
            jsonField.classList.remove("visually-hidden");
            jsonField.select();
            document.execCommand("copy");
            jsonField.classList.add("visually-hidden");
          }
        });
      }

      selectPath("root");
    }

    function loadEntry(params) {
      if (activeController) activeController.abort();
      activeController = new AbortController();
      showLoading();
      openModal();

      var url =
        "/admin/enrichment-cache/detail?" +
        new URLSearchParams(params).toString();
      fetch(url, {
        signal: activeController.signal,
        headers: { Accept: "text/html" },
      })
        .then(function (res) {
          if (!res.ok) throw new Error("not found");
          return res.text();
        })
        .then(function (html) {
          content.innerHTML = html;
          activeController = null;
          var panel = content.querySelector("[data-admin-cache-panel]");
          bindJsonView(panel);
          var closeBtn = modal.querySelector(".admin-cache-dialog__close");
          if (closeBtn) closeBtn.focus();
        })
        .catch(function (err) {
          if (err && err.name === "AbortError") return;
          showError();
          activeController = null;
        });
    }

    document.addEventListener("click", function (event) {
      if (event.target.closest("[data-admin-cache-dismiss]")) {
        if (!modal.hidden) closeModal();
        return;
      }
      var btn = event.target.closest("[data-admin-cache-view]");
      if (!btn) return;
      event.preventDefault();
      var scope = btn.getAttribute("data-cache-scope");
      var provider = btn.getAttribute("data-cache-provider");
      if (!scope || !provider) return;
      var params = { scope: scope, provider: provider };
      if (scope === "commune") {
        var insee = btn.getAttribute("data-cache-insee");
        if (!insee) return;
        params.insee_code = insee;
      } else if (scope === "department") {
        var dept = btn.getAttribute("data-cache-dept");
        if (!dept) return;
        params.dept_code = dept;
      } else {
        var listingId = btn.getAttribute("data-cache-listing-id");
        if (!listingId) return;
        params.listing_id = listingId;
      }
      loadEntry(params);
    });

    document.addEventListener("keydown", function (event) {
      if (modal.hidden || event.key !== "Escape") return;
      event.preventDefault();
      closeModal();
    });
  })();

  // Listes à options-liens (projet, tri). Tout fonctionne sans JS ; ici on
  // ajoute l'ouverture, la fermeture et la navigation au clavier.
  function bindLinkMenu(root, triggerName, menuName) {
    var trigger = root.querySelector(triggerName);
    var menu = root.querySelector(menuName);
    if (!trigger || !menu) return;

    var options = Array.prototype.slice.call(
      menu.querySelectorAll(".project-select__option")
    );
    var focusIndex = -1;

    function setFocus(index) {
      focusIndex = index;
      options.forEach(function (opt, i) {
        opt.classList.toggle("is-focused", i === index);
      });
      if (index >= 0 && options[index]) options[index].focus();
    }

    function isOpen() {
      return !menu.hidden;
    }

    function openMenu() {
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      // On démarre sur l'option active, sinon la première.
      var active = options.findIndex(function (opt) {
        return opt.classList.contains("is-active");
      });
      setFocus(active >= 0 ? active : 0);
    }

    function closeMenu(refocusTrigger) {
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      options.forEach(function (opt) {
        opt.classList.remove("is-focused");
      });
      focusIndex = -1;
      if (refocusTrigger) trigger.focus();
    }

    trigger.addEventListener("click", function () {
      if (isOpen()) closeMenu(false);
      else openMenu();
    });

    trigger.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (!isOpen()) openMenu();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        if (!isOpen()) openMenu();
      }
    });

    menu.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setFocus((focusIndex + 1) % options.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setFocus(focusIndex <= 0 ? options.length - 1 : focusIndex - 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        setFocus(0);
      } else if (event.key === "End") {
        event.preventDefault();
        setFocus(options.length - 1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeMenu(true);
      } else if (event.key === "Tab") {
        closeMenu(false);
      }
    });

    document.addEventListener("click", function (event) {
      if (isOpen() && !root.contains(event.target)) closeMenu(false);
    });
  }

  (function initProjectSelect() {
    var root = document.querySelector("[data-project-select]");
    if (root) bindLinkMenu(root, "[data-project-trigger]", "[data-project-menu]");
  })();

  (function initSortSelect() {
    var root = document.querySelector("[data-sort-select]");
    if (root) bindLinkMenu(root, "[data-sort-trigger]", "[data-sort-menu]");
  })();

  function dpeRangeInputs(picker) {
    var minName = picker.getAttribute("data-range-min");
    var maxName = picker.getAttribute("data-range-max");
    return {
      minInput: minName ? picker.querySelector('[name="' + minName + '"]') : null,
      maxInput: maxName ? picker.querySelector('[name="' + maxName + '"]') : null,
    };
  }

  function formatDpeRangeLabel(picker, minInput, maxInput) {
    var defaultLabel = picker.getAttribute("data-range-default") || "Plage";
    var suffix = picker.getAttribute("data-range-suffix") || "";
    var min = minInput && String(minInput.value || "").trim();
    var max = maxInput && String(maxInput.value || "").trim();
    if (!min && !max) return defaultLabel;
    if (min && max) return min + " – " + max + suffix;
    if (min) return "≥ " + min + suffix;
    return "≤ " + max + suffix;
  }

  function syncDpeRangeTriggerLabel(picker) {
    if (!picker) return;
    var label = picker.querySelector("[data-dpe-range-trigger-label]");
    var inputs = dpeRangeInputs(picker);
    if (label) {
      label.textContent = formatDpeRangeLabel(
        picker,
        inputs.minInput,
        inputs.maxInput
      );
    }
  }

  function resetDpeRangePicker(picker) {
    if (!picker) return;
    var inputs = dpeRangeInputs(picker);
    if (inputs.minInput) inputs.minInput.value = "";
    if (inputs.maxInput) inputs.maxInput.value = "";
    syncDpeRangeTriggerLabel(picker);
    var popover = picker.querySelector("[data-dpe-range-popover]");
    if (popover) popover.hidden = true;
    var trigger = picker.querySelector("[data-dpe-range-trigger]");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
  }

  // Admin DPE : plages min / max (surface, construction) dans un popover.
  (function initDpeRangePickers() {
    document.querySelectorAll("[data-dpe-range-picker]").forEach(function (picker) {
      var trigger = picker.querySelector("[data-dpe-range-trigger]");
      var popover = picker.querySelector("[data-dpe-range-popover]");
      var inputs = dpeRangeInputs(picker);
      if (!trigger || !popover) return;

      var open = false;

      function setOpen(next) {
        open = next;
        popover.hidden = !open;
        trigger.setAttribute("aria-expanded", open ? "true" : "false");
        if (open && inputs.minInput) inputs.minInput.focus();
      }

      trigger.addEventListener("click", function () {
        setOpen(!open);
      });

      picker.querySelectorAll("[data-dpe-range-dismiss]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          setOpen(false);
          trigger.focus();
        });
      });

      document.addEventListener("click", function (event) {
        if (open && !picker.contains(event.target)) setOpen(false);
      });

      document.addEventListener("keydown", function (event) {
        if (open && event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
          trigger.focus();
        }
      });

      function onRangeInput() {
        syncDpeRangeTriggerLabel(picker);
      }

      if (inputs.minInput) inputs.minInput.addEventListener("input", onRangeInput);
      if (inputs.maxInput) inputs.maxInput.addEventListener("input", onRangeInput);
    });
  })();

  function resetDpeFilterSelect(root) {
    if (!root) return;
    var defaultLabel = root.getAttribute("data-default-label") || "Tous";
    var hidden = root.querySelector('input[type="hidden"]');
    var label = root.querySelector(".project-select__label");
    if (hidden) hidden.value = "";
    if (label) label.textContent = defaultLabel;
    root.querySelectorAll("[data-dpe-filter-option]").forEach(function (opt) {
      var match = (opt.getAttribute("data-value") || "") === "";
      opt.classList.toggle("is-active", match);
      opt.setAttribute("aria-selected", match ? "true" : "false");
    });
  }

  function syncDpeEtiquetteTriggerLabel(picker) {
    if (!picker) return;
    var label = picker.querySelector("[data-dpe-etiquette-trigger-label]");
    var dpe = picker.querySelector('[name="etiquette"]');
    var ges = picker.querySelector('[name="etiquette_ges"]');
    var dpeVal = dpe && String(dpe.value || "").trim();
    var gesVal = ges && String(ges.value || "").trim();
    if (!label) return;
    if (!dpeVal && !gesVal) {
      label.textContent = "Étiquettes";
      return;
    }
    if (dpeVal && gesVal) {
      label.textContent = "DPE " + dpeVal + " · GES " + gesVal;
      return;
    }
    if (dpeVal) label.textContent = "DPE " + dpeVal;
    else label.textContent = "GES " + gesVal;
  }

  function resetDpeEtiquettePicker(picker) {
    if (!picker) return;
    var dpe = picker.querySelector('[name="etiquette"]');
    var ges = picker.querySelector('[name="etiquette_ges"]');
    if (dpe) dpe.value = "";
    if (ges) ges.value = "";
    picker.querySelectorAll("[data-dpe-etiquette-option]").forEach(function (opt) {
      var match = (opt.getAttribute("data-value") || "") === "";
      opt.classList.toggle("is-active", match);
      opt.setAttribute("aria-pressed", match ? "true" : "false");
    });
    syncDpeEtiquetteTriggerLabel(picker);
    var popover = picker.querySelector("[data-dpe-etiquette-popover]");
    if (popover) popover.hidden = true;
    var trigger = picker.querySelector("[data-dpe-etiquette-trigger]");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
  }

  function syncDpePostalTriggerLabel(picker) {
    if (!picker) return;
    var label = picker.querySelector("[data-dpe-postal-trigger-label]");
    var input = picker.querySelector('[name="code_postal"]');
    if (!label || !input) return;
    var value = String(input.value || "").trim();
    label.textContent = value || "Code postal";
  }

  function resetDpePostalPicker(picker) {
    if (!picker) return;
    var input = picker.querySelector('[name="code_postal"]');
    if (input) input.value = "";
    syncDpePostalTriggerLabel(picker);
    var popover = picker.querySelector("[data-dpe-postal-popover]");
    if (popover) popover.hidden = true;
    var trigger = picker.querySelector("[data-dpe-postal-trigger]");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
  }

  function dpeDateModFields(picker) {
    return {
      hidden: picker.querySelector("[data-dpe-date-mod-hidden]"),
      input: picker.querySelector("[data-dpe-date-mod-input]"),
    };
  }

  function syncDpeDateModHidden(picker, options) {
    if (!picker) return;
    var fields = dpeDateModFields(picker);
    if (!fields.hidden || !fields.input) return;
    fields.hidden.value = String(fields.input.value || "").trim();
    syncDpeDateModTriggerLabel(picker);
    if (options && options.submit) {
      var form = picker.closest(".dpe-search-form");
      if (form && typeof htmx !== "undefined") {
        htmx.trigger(form, "submit");
      }
    }
  }

  function syncDpeDateModTriggerLabel(picker) {
    if (!picker) return;
    var label = picker.querySelector("[data-dpe-date-mod-trigger-label]");
    var fields = dpeDateModFields(picker);
    var value =
      fields.hidden && String(fields.hidden.value || "").trim()
        ? String(fields.hidden.value || "").trim()
        : fields.input
          ? String(fields.input.value || "").trim()
          : "";
    if (!label) return;
    label.textContent = value || "Dernière modification";
  }

  function resetDpeDateModPicker(picker) {
    if (!picker) return;
    var fields = dpeDateModFields(picker);
    if (fields.input) fields.input.value = "";
    if (fields.hidden) fields.hidden.value = "";
    syncDpeDateModTriggerLabel(picker);
    var popover = picker.querySelector("[data-dpe-date-mod-popover]");
    if (popover) popover.hidden = true;
    var trigger = picker.querySelector("[data-dpe-date-mod-trigger]");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
  }

  // Admin DPE : code postal dans un popover (même principe que surface).
  (function initDpePostalPicker() {
    var picker = document.querySelector("[data-dpe-postal-picker]");
    if (!picker) return;

    var trigger = picker.querySelector("[data-dpe-postal-trigger]");
    var popover = picker.querySelector("[data-dpe-postal-popover]");
    var input = picker.querySelector('[name="code_postal"]');
    if (!trigger || !popover) return;

    var open = false;

    function setOpen(next) {
      open = next;
      popover.hidden = !open;
      trigger.setAttribute("aria-expanded", open ? "true" : "false");
      if (open && input) {
        input.focus();
        input.select();
      }
    }

    trigger.addEventListener("click", function () {
      setOpen(!open);
    });

    picker.querySelectorAll("[data-dpe-postal-dismiss]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setOpen(false);
        trigger.focus();
      });
    });

    document.addEventListener("click", function (event) {
      if (open && !picker.contains(event.target)) setOpen(false);
    });

    document.addEventListener("keydown", function (event) {
      if (open && event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.focus();
      }
    });

    if (input) {
      input.addEventListener("input", function () {
        syncDpePostalTriggerLabel(picker);
      });
    }
  })();

  // Admin DPE : date de dernière modification (jour exact).
  (function initDpeDateModPicker() {
    var picker = document.querySelector("[data-dpe-date-mod-picker]");
    if (!picker) return;

    var trigger = picker.querySelector("[data-dpe-date-mod-trigger]");
    var popover = picker.querySelector("[data-dpe-date-mod-popover]");
    var fields = dpeDateModFields(picker);
    if (!trigger || !popover || !fields.input) return;

    var open = false;

    function setOpen(next) {
      open = next;
      popover.hidden = !open;
      trigger.setAttribute("aria-expanded", open ? "true" : "false");
      if (open && fields.input) fields.input.focus();
    }

    trigger.addEventListener("click", function () {
      setOpen(!open);
    });

    picker.querySelectorAll("[data-dpe-date-mod-dismiss]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setOpen(false);
        trigger.focus();
      });
    });

    document.addEventListener("click", function (event) {
      if (open && !picker.contains(event.target)) setOpen(false);
    });

    document.addEventListener("keydown", function (event) {
      if (open && event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.focus();
      }
    });

    fields.input.addEventListener("input", function () {
      syncDpeDateModHidden(picker, { submit: false });
    });
    fields.input.addEventListener("change", function () {
      syncDpeDateModHidden(picker, { submit: true });
    });
  })();

  // Admin DPE : DPE & GES dans un popover (même principe que surface).
  (function initDpeEtiquettePicker() {
    var picker = document.querySelector("[data-dpe-etiquette-picker]");
    if (!picker) return;

    var trigger = picker.querySelector("[data-dpe-etiquette-trigger]");
    var popover = picker.querySelector("[data-dpe-etiquette-popover]");
    if (!trigger || !popover) return;

    var open = false;

    function setOpen(next) {
      open = next;
      popover.hidden = !open;
      trigger.setAttribute("aria-expanded", open ? "true" : "false");
    }

    trigger.addEventListener("click", function () {
      setOpen(!open);
    });

    picker.querySelectorAll("[data-dpe-etiquette-dismiss]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setOpen(false);
        trigger.focus();
      });
    });

    document.addEventListener("click", function (event) {
      if (open && !picker.contains(event.target)) setOpen(false);
    });

    document.addEventListener("keydown", function (event) {
      if (open && event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.focus();
      }
    });

    popover.addEventListener("click", function (event) {
      var opt = event.target.closest("[data-dpe-etiquette-option]");
      if (!opt) return;
      event.preventDefault();

      var field = opt.getAttribute("data-field");
      var value = opt.getAttribute("data-value") || "";
      var hidden = field ? picker.querySelector('[name="' + field + '"]') : null;
      if (!hidden) return;

      hidden.value = value;
      var group = opt.closest("[data-dpe-etiquette-group]");
      if (group) {
        group.querySelectorAll("[data-dpe-etiquette-option]").forEach(function (item) {
          var match =
            item.getAttribute("data-field") === field &&
            (item.getAttribute("data-value") || "") === value;
          item.classList.toggle("is-active", match);
          item.setAttribute("aria-pressed", match ? "true" : "false");
        });
      }

      syncDpeEtiquetteTriggerLabel(picker);
      hidden.dispatchEvent(new Event("change", { bubbles: true }));
    });
  })();

  // Admin DPE : filtres pilule + menu (type de bâtiment).
  (function initDpeFilterSelects() {
    document.querySelectorAll("[data-dpe-filter-select]").forEach(function (root) {
      bindLinkMenu(root, "[data-dpe-filter-trigger]", "[data-dpe-filter-menu]");

      var hidden = root.querySelector('input[type="hidden"]');
      var label = root.querySelector(".project-select__label");
      var trigger = root.querySelector("[data-dpe-filter-trigger]");
      var menu = root.querySelector("[data-dpe-filter-menu]");
      var defaultLabel = root.getAttribute("data-default-label") || "Tous";
      if (!hidden || !label || !menu) return;

      function closeMenu() {
        menu.hidden = true;
        if (trigger) trigger.setAttribute("aria-expanded", "false");
      }

      function setActive(value) {
        menu.querySelectorAll("[data-dpe-filter-option]").forEach(function (opt) {
          var match = (opt.getAttribute("data-value") || "") === value;
          opt.classList.toggle("is-active", match);
          opt.setAttribute("aria-selected", match ? "true" : "false");
        });
      }

      menu.addEventListener("click", function (event) {
        var opt = event.target.closest("[data-dpe-filter-option]");
        if (!opt) return;
        event.preventDefault();

        var value = opt.getAttribute("data-value") || "";
        hidden.value = value;
        var nameEl = opt.querySelector(".project-select__option-name");
        label.textContent = nameEl ? nameEl.textContent : defaultLabel;
        setActive(value);
        closeMenu();
        if (trigger) trigger.focus();

        hidden.dispatchEvent(new Event("change", { bubbles: true }));
      });
    });
  })();

  // Menus de l'en-tête de fiche (projets, statut). L'enregistrement passe par
  // htmx ; ici on ne gère que l'ouverture et la fermeture. La délégation sur
  // `document` survit aux swaps htmx.
  (function initHeaderDropdowns() {
    var menus = [
      {
        root: "[data-project-dropdown]",
        trigger: "[data-project-dropdown-trigger]",
        menu: "[data-project-dropdown-menu]",
      },
      {
        root: "[data-status-dropdown]",
        trigger: "[data-status-dropdown-trigger]",
        menu: "[data-status-dropdown-menu]",
      },
    ];

    function parts(config) {
      var root = document.querySelector(config.root);
      if (!root) return null;
      var trigger = root.querySelector(config.trigger);
      var menu = root.querySelector(config.menu);
      if (!trigger || !menu) return null;
      return { root: root, trigger: trigger, menu: menu, config: config };
    }

    function open(p) {
      p.menu.hidden = false;
      p.trigger.setAttribute("aria-expanded", "true");
    }

    function close(p) {
      p.menu.hidden = true;
      p.trigger.setAttribute("aria-expanded", "false");
    }

    document.addEventListener("click", function (event) {
      menus.forEach(function (config) {
        var p = parts(config);
        if (!p) return;

        if (event.target.closest(config.trigger)) {
          if (p.menu.hidden) open(p);
          else close(p);
          return;
        }

        if (!p.menu.hidden && !p.root.contains(event.target)) close(p);
      });
    });

    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      menus.forEach(function (config) {
        var p = parts(config);
        if (!p || p.menu.hidden) return;
        close(p);
        p.trigger.focus();
      });
    });
  })();

  // Statut de suivi dans les cartes de la liste : dropdown maison, même allure
  // que « Tous les projets ». Plusieurs cartes coexistent et sont remplacées par
  // htmx à chaque changement, donc on gère l'ouverture/fermeture par délégation
  // sur le document plutôt que par instance.
  (function initCardStatusDropdowns() {
    function closeAll(except) {
      var roots = document.querySelectorAll("[data-card-status]");
      Array.prototype.forEach.call(roots, function (root) {
        if (root === except) return;
        var trigger = root.querySelector("[data-card-status-trigger]");
        var menu = root.querySelector("[data-card-status-menu]");
        if (menu) menu.hidden = true;
        if (trigger) trigger.setAttribute("aria-expanded", "false");
      });
    }

    document.addEventListener("click", function (event) {
      var trigger = event.target.closest("[data-card-status-trigger]");
      if (trigger) {
        var root = trigger.closest("[data-card-status]");
        var menu = root && root.querySelector("[data-card-status-menu]");
        if (!menu) return;
        var willOpen = menu.hidden;
        closeAll(root);
        menu.hidden = !willOpen;
        trigger.setAttribute("aria-expanded", willOpen ? "true" : "false");
        return;
      }
      // Clic en dehors de toute dropdown de carte : on ferme tout.
      if (!event.target.closest("[data-card-status]")) closeAll(null);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeAll(null);
    });
  })();

  // Carrousel photos : flèches, miniatures, compteur, clavier et glissement.
  (function initCarousels() {
    var carousels = Array.prototype.slice.call(
      document.querySelectorAll("[data-carousel]")
    );

    carousels.forEach(function (root) {
      var track = root.querySelector("[data-carousel-track]");
      if (!track) return;

      var slides = Array.prototype.slice.call(
        track.querySelectorAll(".carousel__slide")
      );
      if (slides.length <= 1) return;

      var prev = root.querySelector("[data-carousel-prev]");
      var next = root.querySelector("[data-carousel-next]");
      var counter = root.querySelector("[data-carousel-counter]");
      var viewport = root.querySelector(".carousel__viewport");
      var thumbs = Array.prototype.slice.call(
        root.querySelectorAll("[data-carousel-thumb]")
      );
      var total = slides.length;
      var index = 0;

      function render(scrollActiveThumb) {
        track.style.transform = "translateX(" + -index * 100 + "%)";
        if (counter) counter.textContent = index + 1 + " / " + total;
        thumbs.forEach(function (thumb, i) {
          var active = i === index;
          thumb.classList.toggle("is-active", active);
          // Ne pas scroller la page au chargement : scrollIntoView sur la
          // miniature active remontait l'utilisateur au-dessus de l'en-tête.
          if (
            scrollActiveThumb &&
            active &&
            typeof thumb.scrollIntoView === "function"
          ) {
            thumb.scrollIntoView({ block: "nearest", inline: "nearest" });
          }
        });
      }

      // Navigation circulaire : les flèches restent toujours actives.
      function go(target) {
        index = (target % total + total) % total;
        render(true);
      }

      if (prev) {
        prev.addEventListener("click", function () {
          go(index - 1);
        });
      }
      if (next) {
        next.addEventListener("click", function () {
          go(index + 1);
        });
      }

      thumbs.forEach(function (thumb) {
        thumb.addEventListener("click", function () {
          var i = parseInt(thumb.getAttribute("data-carousel-thumb"), 10);
          if (!isNaN(i)) go(i);
        });
      });

      if (viewport) {
        viewport.addEventListener("keydown", function (event) {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            go(index - 1);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            go(index + 1);
          }
        });

        // Glissement tactile / souris : on suit l'axe horizontal dominant.
        var startX = null;
        var startY = null;
        viewport.addEventListener(
          "pointerdown",
          function (event) {
            startX = event.clientX;
            startY = event.clientY;
          },
          { passive: true }
        );
        viewport.addEventListener("pointerup", function (event) {
          if (startX === null) return;
          var dx = event.clientX - startX;
          var dy = event.clientY - startY;
          startX = null;
          startY = null;
          if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
            go(index + (dx < 0 ? 1 : -1));
          }
        });
      }

      render(false);
    });
  })();

  // Montants du financement : espace des milliers pendant la saisie.
  // Les champs sont en texte pour pouvoir afficher « 20 000 » ; le serveur
  // ignore les séparateurs.
  (function initAmountFields() {
    var grouped = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });

    function formatAmount(value) {
      var digits = String(value).replace(/\D/g, "").replace(/^0+(?=\d)/, "");
      if (!digits) return "";
      return grouped.format(Number(digits));
    }

    function formatField(input) {
      var caret = input.selectionStart;
      var digitsBefore =
        caret == null
          ? null
          : input.value.slice(0, caret).replace(/\D/g, "").length;
      var formatted = formatAmount(input.value);
      if (input.value === formatted) return;
      input.value = formatted;
      if (digitsBefore == null) return;
      var seen = 0;
      var pos = digitsBefore === 0 ? 0 : formatted.length;
      for (var i = 0; i < formatted.length && digitsBefore > 0; i += 1) {
        if (/\d/.test(formatted.charAt(i))) seen += 1;
        if (seen === digitsBefore) {
          pos = i + 1;
          break;
        }
      }
      input.setSelectionRange(pos, pos);
    }

    document.addEventListener("input", function (event) {
      var input = event.target.closest
        ? event.target.closest("[data-amount]")
        : null;
      if (input) formatField(input);
    });

    var commits = new WeakMap();
    var repeat = null;
    var pendingInput = null;
    var steppedByPointer = false;

    function amountInputFrom(target) {
      var stepper = target.closest ? target.closest(".amount-stepper") : null;
      return stepper ? stepper.querySelector("input") : null;
    }

    function parseDecimal(value) {
      var normalized = String(value).replace(/\s/g, "").replace(",", ".");
      if (!normalized) return 0;
      var n = Number(normalized);
      return Number.isFinite(n) ? n : 0;
    }

    function roundTo(value, decimals) {
      var factor = Math.pow(10, decimals);
      return Math.round(value * factor) / factor;
    }

    function scheduleCommit(input) {
      var prev = commits.get(input);
      if (prev) clearTimeout(prev);
      commits.set(
        input,
        setTimeout(function () {
          commits.delete(input);
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }, 400)
      );
    }

    function stepAmount(input, direction, deferCommit) {
      var step = Number(input.getAttribute("data-step"));
      if (!Number.isFinite(step) || step <= 0 || !direction) {
        step = input.hasAttribute("data-amount") ? 1000 : 0;
      }
      if (!step || !direction) return;

      var decimals = input.hasAttribute("data-decimals")
        ? Number(input.getAttribute("data-decimals"))
        : 0;
      if (!Number.isFinite(decimals) || decimals < 0) decimals = 0;
      var min = input.hasAttribute("data-min")
        ? Number(input.getAttribute("data-min"))
        : 0;
      var max = input.hasAttribute("data-max")
        ? Number(input.getAttribute("data-max"))
        : Infinity;
      if (!Number.isFinite(min)) min = 0;
      if (!Number.isFinite(max)) max = Infinity;

      var current = input.hasAttribute("data-amount")
        ? Number(String(input.value).replace(/\D/g, "")) || 0
        : parseDecimal(input.value);
      var next = roundTo(current + direction * step, decimals);
      if (next < min) next = min;
      if (next > max) next = max;
      next = roundTo(next, decimals);
      if (next === current) return;

      if (input.hasAttribute("data-amount")) input.value = formatAmount(next);
      else if (decimals === 0) input.value = String(Math.round(next));
      else {
        input.value = next.toLocaleString("fr-FR", {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        });
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      if (deferCommit) pendingInput = input;
      else scheduleCommit(input);
    }

    function stopRepeat() {
      if (repeat) {
        clearTimeout(repeat);
        repeat = null;
      }
      if (!pendingInput) return;
      var input = pendingInput;
      pendingInput = null;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function startRepeat(input, direction) {
      if (repeat) {
        clearTimeout(repeat);
        repeat = null;
      }
      stepAmount(input, direction, true);
      var wait = 380;
      function tick() {
        stepAmount(input, direction, true);
        wait = Math.max(60, Math.floor(wait * 0.72));
        repeat = setTimeout(tick, wait);
      }
      repeat = setTimeout(tick, wait);
    }

    document.addEventListener("pointerdown", function (event) {
      var btn = event.target.closest
        ? event.target.closest("[data-amount-step]")
        : null;
      if (!btn || event.button !== 0) return;
      var input = amountInputFrom(btn);
      if (!input) return;
      event.preventDefault();
      steppedByPointer = true;
      startRepeat(input, Number(btn.getAttribute("data-amount-step")) || 0);
    });

    document.addEventListener("pointerup", function () {
      stopRepeat();
      setTimeout(function () {
        steppedByPointer = false;
      }, 0);
    });
    document.addEventListener("pointercancel", stopRepeat);

    document.addEventListener("click", function (event) {
      var btn = event.target.closest
        ? event.target.closest("[data-amount-step]")
        : null;
      if (!btn) return;
      if (steppedByPointer) {
        steppedByPointer = false;
        return;
      }
      var input = amountInputFrom(btn);
      if (input) stepAmount(input, Number(btn.getAttribute("data-amount-step")) || 0);
    });

    document.addEventListener("keydown", function (event) {
      var input = event.target.closest
        ? event.target.closest("input[data-step]")
        : null;
      if (!input) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      stepAmount(input, event.key === "ArrowUp" ? 1 : -1);
    });
  })();

  // Financement : écart en % entre le prix négocié et le prix officiel, mis à
  // jour en direct pendant la saisie (avant même de recalculer). Délégué sur le
  // document pour survivre aux échanges htmx du bloc de financement.
  (function initPriceGap() {
    var nf = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
    var euro = new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: "EUR",
      maximumFractionDigits: 0,
    });

    function parseAmount(value) {
      var digits = String(value).replace(/\D/g, "");
      if (!digits) return NaN;
      return Number(digits);
    }

    function renderGap(input) {
      var official = Number(input.getAttribute("data-official-price"));
      var field = input.closest(".field");
      var gap = field && field.querySelector("[data-price-gap]");
      if (!gap || !(official > 0)) return;

      var negotiated = parseAmount(input.value);
      if (!Number.isFinite(negotiated)) {
        gap.textContent = "";
        return;
      }

      var pct = Math.round(((negotiated - official) / official) * 1000) / 10;
      var suffix = " le prix officiel (" + euro.format(official) + ")";

      if (pct < 0) {
        gap.innerHTML =
          '<span class="price-gap__value price-gap__value--down">\u2212' +
          nf.format(Math.abs(pct)) +
          " %</span> sous" +
          suffix;
      } else if (pct > 0) {
        gap.innerHTML =
          '<span class="price-gap__value price-gap__value--up">+' +
          nf.format(pct) +
          " %</span> au-dessus" +
          suffix;
      } else {
        gap.textContent = "Au prix officiel (" + euro.format(official) + ")";
      }
    }

    document.addEventListener("input", function (event) {
      var input = event.target.closest
        ? event.target.closest("[data-negotiated-price]")
        : null;
      if (input) renderGap(input);
    });
  })();

  // Les photos sont servies par les sites d'origine : une URL peut expirer.
  document.addEventListener(
    "error",
    function (event) {
      var img = event.target;
      if (!(img instanceof HTMLImageElement)) return;
      if (img.dataset.fallbackApplied) return;
      img.dataset.fallbackApplied = "1";
      img.removeAttribute("src");
      var holder = img.parentElement;
      if (holder) holder.classList.add("is-image-missing");
    },
    true
  );

  // Admin : sélecteur de plage (popover) pour l'import DPE. Deux clics = début
  // puis fin ; même jour deux fois = une journée. Une fois la plage fixée, la
  // liste des jours à importer et le bouton « Lancer l'import » apparaissent.
  (function initImportCalendar() {
    var picker = document.querySelector("[data-date-range-picker]");
    if (!picker) return;

    var root = picker.querySelector("[data-calendar]");
    if (!root) return;

    var grid = root.querySelector("[data-cal-grid]");
    var title = root.querySelector("[data-cal-title]");
    var prev = root.querySelector("[data-cal-prev]");
    var next = root.querySelector("[data-cal-next]");
    var form = picker.closest("form");
    var fromInput = form && form.querySelector("[data-cal-from]");
    var toInput = form && form.querySelector("[data-cal-to]");
    var trigger = picker.querySelector("[data-cal-trigger]");
    var triggerLabel = picker.querySelector("[data-cal-trigger-label]");
    var popover = picker.querySelector("[data-cal-popover]");
    var hint = picker.querySelector("[data-cal-hint]");
    var plan = form && form.querySelector("[data-cal-plan]");
    var planTitle = form && form.querySelector("[data-cal-plan-title]");
    var datesList = form && form.querySelector("[data-cal-dates]");
    var modifyBtn = form && form.querySelector("[data-cal-modify]");
    var submitBtn = form && form.querySelector("[data-cal-submit]");

    var MONTHS = [
      "janvier", "février", "mars", "avril", "mai", "juin",
      "juillet", "août", "septembre", "octobre", "novembre", "décembre"
    ];
    var LONG = new Intl.DateTimeFormat("fr-FR", {
      day: "numeric", month: "long", year: "numeric"
    });
    var SHORT = new Intl.DateTimeFormat("fr-FR", {
      day: "numeric", month: "short", year: "numeric"
    });

    var today = new Date();
    today.setHours(0, 0, 0, 0);

    var view = new Date(today.getFullYear(), today.getMonth(), 1);
    var start = null;
    var end = null;
    var popoverOpen = false;
    var importedDays = new Set();

    function parseImportedDays() {
      var raw = root.getAttribute("data-cal-imported-days");
      if (!raw) return;
      try {
        var list = JSON.parse(decodeURIComponent(raw));
        if (Array.isArray(list)) {
          importedDays = new Set(list);
        }
      } catch (_err) {
        importedDays = new Set();
      }
    }

    function refreshImportedDays() {
      return fetch("/admin/dpe/imported-days", {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      })
        .then(function (res) {
          if (!res.ok) return null;
          return res.json();
        })
        .then(function (list) {
          if (Array.isArray(list)) {
            importedDays = new Set(list);
            root.setAttribute(
              "data-cal-imported-days",
              encodeURIComponent(JSON.stringify(list))
            );
            render();
          }
        })
        .catch(function () {});
    }

    parseImportedDays();

    function iso(d) {
      var m = String(d.getMonth() + 1).padStart(2, "0");
      var day = String(d.getDate()).padStart(2, "0");
      return d.getFullYear() + "-" + m + "-" + day;
    }
    function sameDay(a, b) {
      return a && b && a.getTime() === b.getTime();
    }
    function sortedRange() {
      if (!start) return { lo: null, hi: null };
      var lo = start;
      var hi = end || start;
      if (hi.getTime() < lo.getTime()) {
        var t = lo; lo = hi; hi = t;
      }
      return { lo: lo, hi: hi };
    }
    function rangeComplete() {
      return Boolean(start && end);
    }
    function expandDays(lo, hi) {
      var out = [];
      var cur = new Date(lo.getFullYear(), lo.getMonth(), lo.getDate());
      var last = new Date(hi.getFullYear(), hi.getMonth(), hi.getDate());
      while (cur.getTime() <= last.getTime()) {
        out.push(iso(cur));
        cur.setDate(cur.getDate() + 1);
      }
      return out;
    }

    function setPopoverOpen(open) {
      popoverOpen = open;
      if (!popover || !trigger) return;
      popover.hidden = !open;
      trigger.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) refreshImportedDays();
    }

    function renderDatesList(days) {
      if (!datesList) return;
      datesList.textContent = "";
      days.forEach(function (dayIso, index) {
        var li = document.createElement("li");
        li.className = "dpe-import-plan__day";
        var num = document.createElement("span");
        num.className = "dpe-import-plan__index";
        num.textContent = String(index + 1);
        var label = document.createElement("span");
        label.textContent = LONG.format(new Date(dayIso + "T12:00:00"));
        label.title = dayIso;
        li.appendChild(num);
        li.appendChild(label);
        datesList.appendChild(li);
      });
    }

    function updateForm() {
      var range = sortedRange();
      var lo = range.lo;
      var hi = range.hi;
      var complete = rangeComplete();

      if (fromInput) fromInput.value = complete && lo ? iso(lo) : "";
      if (toInput) toInput.value = complete && hi ? iso(hi) : "";

      if (triggerLabel) {
        if (!start) {
          triggerLabel.textContent = "Choisir une plage de dates";
        } else if (!complete) {
          if (hoverDate && !sameDay(hoverDate, start)) {
            var pa = start.getTime() <= hoverDate.getTime() ? start : hoverDate;
            var pb = start.getTime() <= hoverDate.getTime() ? hoverDate : start;
            triggerLabel.textContent =
              SHORT.format(pa) +
              " → " +
              SHORT.format(pb) +
              " · " +
              expandDays(pa, pb).length +
              " jours";
          } else {
            triggerLabel.textContent =
              "À partir du " + SHORT.format(start) + " — choisir la fin";
          }
        } else if (sameDay(lo, hi)) {
          triggerLabel.textContent = SHORT.format(lo);
        } else {
          var n = expandDays(lo, hi).length;
          triggerLabel.textContent =
            SHORT.format(lo) + " → " + SHORT.format(hi) + " · " + n + " jours";
        }
      }

      if (hint) {
        if (!start) {
          hint.textContent =
            "Glissez du jour de début au jour de fin (ou cliquez les deux).";
        } else if (!complete) {
          hint.textContent =
            "Relâchez ou cliquez sur le jour de fin (même jour = une journée).";
        } else {
          hint.textContent = "Plage enregistrée. Vous pouvez fermer ou modifier.";
        }
      }

      if (submitBtn) {
        var importBlocked =
          form && form.getAttribute("data-import-blocked") === "true";
        submitBtn.disabled = !complete || importBlocked;
      }

      if (plan) {
        if (complete && lo && hi) {
          var days = expandDays(lo, hi);
          plan.hidden = false;
          if (planTitle) {
            planTitle.textContent =
              days.length === 1
                ? "1 jour sera importé"
                : days.length + " jours seront importés (un téléchargement par jour)";
          }
          renderDatesList(days);
        } else {
          plan.hidden = true;
          if (datesList) datesList.textContent = "";
        }
      }
    }

    var hoverDate = null;
    var cells = [];
    var dragging = false;
    var dragStartDay = null;
    var dragMoved = false;

    function finalizeSelection() {
      updateForm();
      render();
      setPopoverOpen(false);
    }

    // Plage à peindre : si seul le début est choisi, on prévisualise jusqu'au
    // jour survolé pour que l'utilisateur voie la plage « s'allumer » sans
    // rouvrir le calendrier.
    function paintableRange() {
      if (start && !end && hoverDate) {
        var a = start;
        var b = hoverDate;
        if (b.getTime() < a.getTime()) {
          var t = a;
          a = b;
          b = t;
        }
        return { lo: a, hi: b, preview: true };
      }
      var r = sortedRange();
      return { lo: r.lo, hi: r.hi, preview: false };
    }

    function paintRange() {
      var range = paintableRange();
      var lo = range.lo;
      var hi = range.hi || range.lo;
      cells.forEach(function (cell) {
        var btn = cell.btn;
        var date = cell.date;
        btn.classList.remove(
          "is-in-range",
          "is-start",
          "is-end",
          "is-preview"
        );
        if (!lo) return;
        var ts = date.getTime();
        if (ts >= lo.getTime() && ts <= hi.getTime()) {
          btn.classList.add("is-in-range");
          if (range.preview) btn.classList.add("is-preview");
        }
        if (sameDay(date, lo)) btn.classList.add("is-start");
        if (sameDay(date, hi)) btn.classList.add("is-end");
      });
    }

    function pick(d) {
      if (!start || (start && end)) {
        start = d;
        end = null;
      } else {
        end = d;
      }
      hoverDate = null;
      updateForm();
      render();
      if (rangeComplete()) {
        setPopoverOpen(false);
      }
    }

    function render() {
      title.textContent = MONTHS[view.getMonth()] + " " + view.getFullYear();
      grid.textContent = "";
      cells = [];

      var year = view.getFullYear();
      var month = view.getMonth();
      var first = new Date(year, month, 1);
      var lead = (first.getDay() + 6) % 7;
      var daysInMonth = new Date(year, month + 1, 0).getDate();

      for (var i = 0; i < lead; i++) {
        var blank = document.createElement("span");
        blank.className = "calendar__cell is-empty";
        grid.appendChild(blank);
      }

      for (var day = 1; day <= daysInMonth; day++) {
        var date = new Date(year, month, day);
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "calendar__cell";
        btn.textContent = String(day);

        var disabled = date.getTime() > today.getTime();
        if (disabled) {
          btn.disabled = true;
          btn.classList.add("is-disabled");
        }
        if (sameDay(date, today)) btn.classList.add("is-today");
        if (importedDays.has(iso(date))) btn.classList.add("is-imported");

        (function (d, isDisabled) {
          // Clic simple ou clavier (Entrée/Espace) : sélection en deux temps.
          btn.addEventListener("click", function (event) {
            event.stopPropagation();
            if (isDisabled) return;
            pick(d);
          });
          if (isDisabled) return;

          // Début d'un éventuel glisser-déposer (presser sur le jour de début).
          btn.addEventListener("pointerdown", function (event) {
            if (event.button != null && event.button !== 0) return;
            dragging = true;
            dragStartDay = d;
            dragMoved = false;
          });

          // Survol d'un jour : met la plage en surbrillance au fur et à mesure,
          // que le bouton soit enfoncé (glisser) ou relâché (après un 1er clic).
          btn.addEventListener("pointerenter", function () {
            if (dragging && dragStartDay) {
              // Au premier déplacement, on valide le jour de début.
              if (!dragMoved && !sameDay(d, dragStartDay)) {
                start = dragStartDay;
                end = null;
                dragMoved = true;
              }
              if (dragMoved) {
                hoverDate = d;
                paintRange();
                updateForm();
              }
            } else if (start && !end) {
              hoverDate = d;
              paintRange();
              updateForm();
            }
          });
        })(date, disabled);

        cells.push({ btn: btn, date: date });
        grid.appendChild(btn);
      }

      paintRange();
    }

    grid.addEventListener("pointerleave", function () {
      // En mode deux clics, on efface la prévisualisation en quittant la grille.
      // Pendant un glisser, on la conserve (le relâchement peut avoir lieu
      // ailleurs).
      if (!dragging && start && !end && hoverDate) {
        hoverDate = null;
        paintRange();
        updateForm();
      }
    });

    // Fin du glisser : le jour sous le curseur devient le jour de fin.
    document.addEventListener("pointerup", function () {
      if (!dragging) return;
      dragging = false;
      if (
        dragMoved &&
        dragStartDay &&
        hoverDate &&
        !sameDay(hoverDate, dragStartDay)
      ) {
        start = dragStartDay;
        end = hoverDate;
        dragStartDay = null;
        dragMoved = false;
        finalizeSelection();
      } else {
        // Simple pression sans déplacement : on laisse le clic faire la
        // sélection en deux temps.
        dragStartDay = null;
        dragMoved = false;
      }
    });

    trigger.addEventListener("click", function () {
      setPopoverOpen(!popoverOpen);
    });

    if (modifyBtn) {
      modifyBtn.addEventListener("click", function () {
        start = null;
        end = null;
        updateForm();
        render();
        setPopoverOpen(true);
      });
    }

    document.addEventListener("click", function (event) {
      if (!popoverOpen) return;
      if (picker.contains(event.target)) return;
      // Plage en cours : ne pas fermer sur un clic « dehors » tant que la fin
      // n'est pas choisie (évite les fermetures intempestives).
      if (start && !end) return;
      setPopoverOpen(false);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && popoverOpen) {
        setPopoverOpen(false);
      }
    });

    prev.addEventListener("click", function (event) {
      event.stopPropagation();
      view = new Date(view.getFullYear(), view.getMonth() - 1, 1);
      render();
    });
    next.addEventListener("click", function (event) {
      event.stopPropagation();
      view = new Date(view.getFullYear(), view.getMonth() + 1, 1);
      render();
    });

    function syncImportFormLock() {
      var status = document.getElementById("dpe-import-status");
      if (!form || !status) return;
      var block = status.getAttribute("data-block-import") === "true";
      if (block) form.setAttribute("data-import-blocked", "true");
      else form.removeAttribute("data-import-blocked");
      updateForm();
    }

    document.body.addEventListener("htmx:afterSwap", function (event) {
      var target = event.detail && event.detail.target;
      if (!target) return;
      if (target.id === "dpe-import-status" || target.querySelector("#dpe-import-status")) {
        syncImportFormLock();
        refreshImportedDays();
      }
    });

    updateForm();
    render();
    syncImportFormLock();
  })();

  // Admin : remise à zéro des filtres de recherche DPE puis rafraîchissement htmx.
  (function initDpeSearchReset() {
    document.addEventListener("click", function (event) {
      var btn = event.target.closest("[data-dpe-search-reset]");
      if (!btn) return;
      var panel = btn.closest('[data-settings-panel="search"]');
      var form = panel && panel.querySelector(".dpe-search-form");
      if (!form) return;
      event.preventDefault();

      form.querySelectorAll("[data-dpe-filter-select]").forEach(resetDpeFilterSelect);
      var etiquettePicker = form.querySelector("[data-dpe-etiquette-picker]");
      if (etiquettePicker) resetDpeEtiquettePicker(etiquettePicker);
      var postalPicker = form.querySelector("[data-dpe-postal-picker]");
      if (postalPicker) resetDpePostalPicker(postalPicker);
      var dateModPicker = form.querySelector("[data-dpe-date-mod-picker]");
      if (dateModPicker) resetDpeDateModPicker(dateModPicker);
      form.querySelectorAll("[data-dpe-range-picker]").forEach(resetDpeRangePicker);

      if (typeof htmx !== "undefined") {
        htmx.trigger(form, "submit");
      }
    });
  })();

  // Admin : clic sur une ligne DPE → modale de détail (contenu chargé à la demande).
  (function initDpeDetailModal() {
    var modal = document.getElementById("dpe-detail-modal");
    var content = modal && modal.querySelector("[data-dpe-detail-content]");
    if (!modal || !content) return;

    var activeController = null;

    function closeModal() {
      if (activeController) {
        activeController.abort();
        activeController = null;
      }
      modal.hidden = true;
      document.body.classList.remove("is-modal-open");
    }

    function openModal() {
      modal.hidden = false;
      document.body.classList.add("is-modal-open");
    }

    function showLoading() {
      content.innerHTML =
        '<p class="dpe-detail-dialog__loading">Chargement…</p>';
    }

    function showError(message) {
      content.innerHTML =
        '<p class="dpe-detail-dialog__loading">' +
        (message || "Impossible de charger ce DPE.") +
        "</p>";
    }

    function loadDetail(numero) {
      if (!numero) return;
      if (activeController) activeController.abort();
      activeController = new AbortController();
      showLoading();
      openModal();

      var url =
        "/admin/dpe/record/" + encodeURIComponent(numero);
      fetch(url, {
        signal: activeController.signal,
        headers: { Accept: "text/html" },
      })
        .then(function (res) {
          if (!res.ok) throw new Error("not found");
          return res.text();
        })
        .then(function (html) {
          content.innerHTML = html;
          activeController = null;
          var closeBtn = modal.querySelector(".dpe-detail-dialog__close");
          if (closeBtn) closeBtn.focus();
        })
        .catch(function (err) {
          if (err && err.name === "AbortError") return;
          showError();
          activeController = null;
        });
    }

    function openFromRow(row) {
      if (!row || !row.getAttribute) return;
      var numero = row.getAttribute("data-dpe-numero");
      if (numero) loadDetail(numero);
    }

    document.addEventListener("click", function (event) {
      if (event.target.closest("[data-dpe-detail-dismiss]")) {
        closeModal();
        return;
      }
      var row = event.target.closest(".dpe-table__row");
      if (row) {
        event.preventDefault();
        openFromRow(row);
      }
    });

    document.addEventListener("keydown", function (event) {
      if (!modal.hidden && event.key === "Escape") {
        event.preventDefault();
        closeModal();
        return;
      }
      var row = event.target.closest(".dpe-table__row");
      if (!row) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openFromRow(row);
      }
    });

    modal.addEventListener("click", function (event) {
      if (event.target === modal.querySelector(".modal__overlay")) {
        closeModal();
      }
    });
  })();

  // Admin : fiche utilisateur (mot de passe, suppression).
  (function initAdminUserModal() {
    var modal = document.getElementById("admin-user-modal");
    var content = modal && modal.querySelector("[data-admin-user-content]");
    if (!modal || !content) return;

    var activeController = null;

    function closeModal() {
      if (activeController) {
        activeController.abort();
        activeController = null;
      }
      modal.hidden = true;
      document.body.classList.remove("is-modal-open");
    }

    function openModal() {
      modal.hidden = false;
      document.body.classList.add("is-modal-open");
    }

    function showLoading() {
      content.innerHTML =
        '<p class="admin-user-dialog__loading">Chargement…</p>';
    }

    function showError(message) {
      content.innerHTML =
        '<p class="admin-user-dialog__loading">' +
        (message || "Impossible de charger ce compte.") +
        "</p>";
    }

    function loadUser(userId) {
      if (!userId) return;
      if (activeController) activeController.abort();
      activeController = new AbortController();
      showLoading();
      openModal();

      var url = "/admin/users/" + encodeURIComponent(userId);
      fetch(url, {
        signal: activeController.signal,
        headers: { Accept: "text/html" },
      })
        .then(function (res) {
          if (!res.ok) throw new Error("not found");
          return res.text();
        })
        .then(function (html) {
          content.innerHTML = html;
          activeController = null;
          var closeBtn = modal.querySelector(".admin-user-dialog__close");
          if (closeBtn) closeBtn.focus();
        })
        .catch(function (err) {
          if (err && err.name === "AbortError") return;
          showError();
          activeController = null;
        });
    }

    function openFromUserId(userId) {
      if (userId) loadUser(userId);
    }

    document.addEventListener("click", function (event) {
      if (event.target.closest("[data-admin-user-dismiss]")) {
        closeModal();
        return;
      }
      var manageBtn = event.target.closest(".admin-users-table__manage");
      if (manageBtn) {
        event.preventDefault();
        event.stopPropagation();
        openFromUserId(manageBtn.getAttribute("data-user-id"));
        return;
      }
      var row = event.target.closest(".admin-users-table__row");
      if (row) {
        event.preventDefault();
        openFromUserId(row.getAttribute("data-user-id"));
      }
    });

    document.addEventListener("keydown", function (event) {
      if (!modal.hidden && event.key === "Escape") {
        event.preventDefault();
        closeModal();
        return;
      }
      var row = event.target.closest(".admin-users-table__row");
      if (!row) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openFromUserId(row.getAttribute("data-user-id"));
      }
    });

    modal.addEventListener("click", function (event) {
      if (event.target === modal.querySelector(".modal__overlay")) {
        closeModal();
      }
    });

    document.body.addEventListener("htmx:afterSwap", function (event) {
      var target = event.detail && event.detail.target;
      if (
        target &&
        target.getAttribute &&
        target.getAttribute("data-close-user-modal") === "true"
      ) {
        closeModal();
      }
    });
  })();

  // Ajout d'une annonce par URL : popup en deux temps (vérification puis
  // validation). Tout passe par fetch same-origin avec le jeton CSRF ; aucune
  // donnée d'annonce ne transite par le client, seul un jeton de brouillon.
  (function initAddListing() {
    var modal = document.querySelector("[data-add-listing]");
    if (!modal) return;

    var form = modal.querySelector("[data-add-listing-form]");
    var urlInput = modal.querySelector("[data-add-listing-url]");
    var errorBox = modal.querySelector("[data-add-listing-error]");
    var submitBtn = modal.querySelector("[data-add-listing-submit]");
    var preview = modal.querySelector("[data-add-listing-preview]");
    var confirmBtn = modal.querySelector("[data-add-listing-confirm]");
    var backBtn = modal.querySelector("[data-add-listing-back]");
    if (!form || !urlInput || !preview) return;

    var lastFocused = null;
    var currentToken = null;

    var euro = new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: "EUR",
      maximumFractionDigits: 0,
    });
    var SOURCE_LABELS = {
      seloger: "SeLoger",
      bellesdemeures: "Belles Demeures",
      leboncoin: "Leboncoin",
    };

    function csrfToken() {
      var meta = document.querySelector('meta[name="csrf-token"]');
      return meta ? meta.content : "";
    }

    function showError(message) {
      if (!errorBox) return;
      errorBox.textContent = message || "Une erreur est survenue.";
      errorBox.hidden = false;
    }

    function clearError() {
      if (!errorBox) return;
      errorBox.hidden = true;
      errorBox.textContent = "";
    }

    function setLoading(button, loading) {
      if (!button) return;
      button.classList.toggle("is-loading", loading);
      button.disabled = loading;
    }

    function showForm() {
      preview.hidden = true;
      form.hidden = false;
      currentToken = null;
    }

    function openModal() {
      lastFocused = document.activeElement;
      clearError();
      showForm();
      modal.hidden = false;
      document.body.classList.add("is-modal-open");
      window.setTimeout(function () {
        urlInput.focus();
      }, 0);
    }

    function closeModal() {
      modal.hidden = true;
      document.body.classList.remove("is-modal-open");
      setLoading(submitBtn, false);
      setLoading(confirmBtn, false);
      if (lastFocused && typeof lastFocused.focus === "function") {
        lastFocused.focus();
      }
      lastFocused = null;
    }

    function selectedProjectIds() {
      return Array.prototype.slice
        .call(form.querySelectorAll('input[name="project_ids"]:checked'))
        .map(function (input) {
          return input.value;
        });
    }

    function text(node, value) {
      var el = preview.querySelector(node);
      if (el) el.textContent = value || "";
    }

    function fillPreview(data, alreadySaved) {
      var photoEl = preview.querySelector("[data-preview-photo]");
      var placeholder = preview.querySelector("[data-preview-placeholder]");
      if (photoEl) {
        if (data.photo) {
          photoEl.src = data.photo;
          photoEl.hidden = false;
          if (placeholder) placeholder.hidden = true;
        } else {
          photoEl.removeAttribute("src");
          photoEl.hidden = true;
          if (placeholder) placeholder.hidden = false;
        }
      }

      text("[data-preview-source]", SOURCE_LABELS[data.source] || data.source || "");
      text("[data-preview-title]", data.title || "Annonce sans titre");
      text(
        "[data-preview-price]",
        typeof data.price === "number" ? euro.format(data.price) : "Prix non précisé"
      );

      var metaParts = [];
      if (data.surface) metaParts.push(Math.round(data.surface) + " m²");
      if (data.rooms) metaParts.push(data.rooms + " pièce" + (data.rooms > 1 ? "s" : ""));
      if (data.bedrooms)
        metaParts.push(data.bedrooms + " chambre" + (data.bedrooms > 1 ? "s" : ""));
      text("[data-preview-meta]", metaParts.join(" · "));

      var cityParts = [];
      if (data.city) cityParts.push(data.city);
      if (data.postal_code) cityParts.push("(" + data.postal_code + ")");
      text("[data-preview-city]", cityParts.join(" "));

      var note = preview.querySelector("[data-preview-note]");
      if (note) {
        if (alreadySaved) {
          note.textContent =
            "Cette annonce est déjà dans votre carnet : la valider la mettra à jour.";
          note.hidden = false;
        } else {
          note.textContent = "";
          note.hidden = true;
        }
      }
    }

    function showPreview(result) {
      currentToken = result.token;
      fillPreview(result.preview || {}, result.already_saved);
      form.hidden = true;
      preview.hidden = false;
      if (confirmBtn) {
        window.setTimeout(function () {
          confirmBtn.focus();
        }, 0);
      }
    }

    function requestPreview() {
      clearError();
      var url = (urlInput.value || "").trim();
      if (!url) {
        showError("Collez l'URL d'une annonce.");
        urlInput.focus();
        return;
      }

      setLoading(submitBtn, true);
      fetch("/listings/preview", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken(),
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({ url: url }),
      })
        .then(function (res) {
          return res.json().catch(function () {
            return { ok: false };
          });
        })
        .then(function (result) {
          setLoading(submitBtn, false);
          if (result && result.ok) {
            showPreview(result);
          } else {
            showError(
              (result && result.message) ||
                "Impossible de lire cette annonce. Vérifiez l'URL et réessayez."
            );
          }
        })
        .catch(function () {
          setLoading(submitBtn, false);
          showError("Erreur réseau. Vérifiez votre connexion et réessayez.");
        });
    }

    function confirmImport() {
      if (!currentToken) {
        showForm();
        showError("Cet aperçu a expiré. Relancez la vérification.");
        return;
      }

      setLoading(confirmBtn, true);
      fetch("/listings/import", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken(),
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({
          token: currentToken,
          project_ids: selectedProjectIds(),
        }),
      })
        .then(function (res) {
          return res.json().catch(function () {
            return { ok: false };
          });
        })
        .then(function (result) {
          if (result && result.ok && result.web_url) {
            window.location.assign(result.web_url);
          } else {
            setLoading(confirmBtn, false);
            showForm();
            showError(
              (result && result.message) ||
                "L'enregistrement a échoué. Relancez la vérification."
            );
          }
        })
        .catch(function () {
          setLoading(confirmBtn, false);
          showForm();
          showError("Erreur réseau. Réessayez.");
        });
    }

    // Ouverture depuis n'importe quel bouton d'appel de la page.
    document.addEventListener("click", function (event) {
      if (event.target.closest("[data-add-listing-open]")) {
        event.preventDefault();
        openModal();
      }
    });

    modal.addEventListener("click", function (event) {
      if (event.target.closest("[data-add-listing-dismiss]")) {
        event.preventDefault();
        closeModal();
      }
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      requestPreview();
    });

    if (confirmBtn) {
      confirmBtn.addEventListener("click", function () {
        confirmImport();
      });
    }

    if (backBtn) {
      backBtn.addEventListener("click", function () {
        clearError();
        showForm();
        urlInput.focus();
      });
    }

    // Les cases projet reflètent l'état coché visuellement (comme les pilules).
    form.addEventListener("change", function (event) {
      var input = event.target.closest('input[name="project_ids"]');
      if (!input) return;
      var label = input.closest(".add-listing__project");
      if (label) label.classList.toggle("is-active", input.checked);
    });

    document.addEventListener("keydown", function (event) {
      if (!modal.hidden && event.key === "Escape") {
        event.preventDefault();
        closeModal();
      }
    });
  })();

  // Fiche annonce : modale de saisie de l'adresse réelle (champs structurés).
  (function initListingAddressModal() {
    var lastFocused = null;

    function modal() {
      return document.querySelector("[data-listing-address-modal]");
    }

    function fields(m) {
      if (!m) return null;
      return {
        street: m.querySelector("[data-listing-address-street]"),
        complement: m.querySelector("[data-listing-address-complement]"),
        postal: m.querySelector("[data-listing-address-postal]"),
        city: m.querySelector("[data-listing-address-city]"),
      };
    }

    function openFromButton(button) {
      var m = modal();
      if (!m || !button) return;
      var f = fields(m);
      if (!f || !f.street) return;

      f.street.value = button.getAttribute("data-street") || "";
      if (f.complement) {
        f.complement.value = button.getAttribute("data-complement") || "";
      }
      if (f.postal) {
        f.postal.value = button.getAttribute("data-postal-code") || "";
      }
      if (f.city) f.city.value = button.getAttribute("data-city") || "";

      lastFocused = document.activeElement;
      m.hidden = false;
      document.body.classList.add("is-modal-open");
      window.setTimeout(function () {
        f.street.focus();
      }, 0);
    }

    function closeModal() {
      var m = modal();
      // Après un enregistrement htmx, le bloc est re-rendu : la modale
      // fraîche est déjà `hidden`, mais le body garde `is-modal-open`.
      var wasVisible = m && !m.hidden;
      if (m) m.hidden = true;
      document.body.classList.remove("is-modal-open");
      if (wasVisible && lastFocused && typeof lastFocused.focus === "function") {
        lastFocused.focus();
      }
      lastFocused = null;
    }

    document.addEventListener("click", function (event) {
      if (event.target.closest(".listing-location__maps-link")) {
        return;
      }
      var openBtn = event.target.closest("[data-listing-address-open]");
      if (openBtn) {
        event.preventDefault();
        openFromButton(openBtn);
        return;
      }
      if (event.target.closest("[data-listing-address-dismiss]")) {
        closeModal();
      }
    });

    document.addEventListener("keydown", function (event) {
      var m = modal();
      if (!m || m.hidden) {
        if (event.key === "Enter" || event.key === " ") {
          var trigger = event.target.closest("[data-listing-address-open]");
          if (
            trigger &&
            trigger.classList.contains("listing-location__card--editable")
          ) {
            event.preventDefault();
            openFromButton(trigger);
          }
        }
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeModal();
    });

    document.body.addEventListener("htmx:afterSwap", function (event) {
      var target = event.detail && event.detail.target;
      if (!target || target.id !== "listing-location-block") return;
      closeModal();
    });
  })();

  // Fiche annonce : modale « Déterminer l'adresse » (lancement + état analyse).
  (function initListingAddressAiModal() {
    var lastFocused = null;
    var statusTimer = null;
    var analysisFinishTimer = null;
    var statusIndex = 0;
    var MIN_ANALYSIS_MS = 1000;
    var ANALYSIS_STATUS_LINES = [
      "Lecture de l'annonce et de ses détails…",
      "Examen des visuels et du quartier…",
      "Recoupement avec des données publiques…",
      "Repérage des adresses les plus probables…",
    ];

    function csrfTokenFromMeta() {
      var meta = document.querySelector('meta[name="csrf-token"]');
      return meta ? meta.content : "";
    }

    /** Lance la recherche réelle d'adresses candidates (mode précis). */
    function fetchAddressCandidates(m) {
      var listingId = m && m.getAttribute("data-listing-id");
      if (!listingId) return Promise.reject(new Error("missing_listing_id"));
      return fetch("/listings/" + listingId + "/address-ai/search", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfTokenFromMeta(),
        },
        credentials: "same-origin",
        body: "{}",
      }).then(function (res) {
        if (!res.ok) throw new Error("search_http_" + res.status);
        return res.json();
      });
    }

    function mapsHref(query) {
      return (
        "https://www.google.com/maps/search/?api=1&query=" +
        encodeURIComponent(query || "")
      );
    }

    /** Construit un <li> de résultat à partir d'un candidat du serveur. */
    function buildResultRow(candidate, index) {
      var li = document.createElement("li");
      li.className =
        "listing-address-ai-result" +
        (index === 0 ? " listing-address-ai-result--best" : "");
      li.setAttribute("data-listing-address-ai-result", "");
      li.setAttribute("data-result-index", String(index));
      li.setAttribute("data-result-street", candidate.street || "");
      li.setAttribute("data-result-locality", candidate.locality || "");
      li.setAttribute("data-result-postal-code", candidate.postalCode || "");
      li.setAttribute("data-result-city", candidate.city || "");
      li.setAttribute("data-result-confidence", String(candidate.confidence || 0));
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
      li.tabIndex = -1;

      var rank = document.createElement("span");
      rank.className = "listing-address-ai-result__rank";
      rank.setAttribute("aria-hidden", "true");
      rank.textContent = String(index + 1);
      li.appendChild(rank);

      var body = document.createElement("div");
      body.className = "listing-address-ai-result__body";

      var line = document.createElement("p");
      line.className = "listing-address-ai-result__line";

      var street = document.createElement("span");
      street.className = "listing-address-ai-result__street";
      street.textContent = candidate.street || "Adresse inconnue";
      line.appendChild(street);

      if (candidate.locality) {
        var locality = document.createElement("span");
        locality.className = "listing-address-ai-result__locality";
        locality.textContent = candidate.locality;
        line.appendChild(locality);
      }
      body.appendChild(line);

      if (index === 0) {
        var badge = document.createElement("span");
        badge.className = "badge badge--accent listing-address-ai-result__badge";
        badge.textContent = "Meilleure piste";
        body.appendChild(badge);
      }
      li.appendChild(body);

      var confidence = document.createElement("span");
      confidence.className = "listing-address-ai-result__confidence";
      confidence.title = "Score de confiance";
      confidence.textContent = (candidate.confidence || 0) + "%";
      li.appendChild(confidence);

      var maps = document.createElement("a");
      maps.className = "address-book__map listing-address-ai-result__maps";
      maps.href = mapsHref(candidate.mapsQuery || candidate.street);
      maps.target = "_blank";
      maps.rel = "noopener noreferrer";
      maps.setAttribute(
        "aria-label",
        "Ouvrir " + (candidate.street || "cette adresse") + " dans Google Maps (nouvel onglet)"
      );
      maps.textContent = "Google Maps ↗";
      li.appendChild(maps);

      return li;
    }

    function matchGlyph(value) {
      if (value === true) return "✓ match";
      if (value === false) return "✗ non";
      return "— (absent de l'annonce)";
    }

    /**
     * Un seul bloc console par analyse (1 appel POST /address-ai/search).
     * Variable globale : __lastAddressAiSearch
     */
    function logMatchingDebug(payload) {
      if (!payload) return;
      window.__lastAddressAiSearch = payload;

      var crit = payload.criteria || {};
      var candidates = payload.candidates || [];
      var mode = payload.mode || "?";
      var missing = payload.champsRequisManquants || [];
      var fallbackNote = payload.fallbackFrom
        ? " (repli depuis " + payload.fallbackFrom + ")"
        : "";
      var rootLabel =
        "[Déterminer l'adresse] mode " +
        mode +
        fallbackNote +
        " — " +
        candidates.length +
        " candidat(s)";

      function criteriaRows() {
        return [
          { critere: "Code postal", valeur: crit.codePostal ?? "(vide)" },
          { critere: "Département", valeur: crit.departement ?? "(vide)" },
          { critere: "Type (annonce)", valeur: crit.typeBien ?? "(vide)" },
          { critere: "Type DPE", valeur: crit.typeBatiment ?? "(vide)" },
          { critere: "DPE", valeur: crit.dpe ?? "(vide)" },
          { critere: "GES", valeur: crit.ges ?? "(vide)" },
          { critere: "Surface (m²)", valeur: crit.surfaceM2 ?? "(vide)" },
          { critere: "Étage", valeur: crit.etage ?? "(vide)" },
          { critere: "Année", valeur: crit.anneeConstruction ?? "(vide)" },
        ];
      }

      if (!candidates.length) {
        console.warn(rootLabel + " — aucun résultat.");
        if (missing.length) {
          console.warn("[Déterminer l'adresse] Champs requis manquants:", missing);
        }
        console.table(criteriaRows());
        return;
      }

      if (console.groupCollapsed) console.groupCollapsed(rootLabel);
      else console.log(rootLabel);

      if (console.groupCollapsed) console.groupCollapsed("Critères annonce");
      console.table(criteriaRows());
      if (missing.length) {
        console.info("[Déterminer l'adresse] Champs optionnels absents:", missing);
      }
      if (console.groupEnd) console.groupEnd();

      candidates.forEach(function (c, i) {
        var s = c.source || {};
        var m2 = c.matched || {};
        var rows = [
          { critere: "Code postal", annonce: crit.codePostal, base: c.postalCode, resultat: "— (filtre strict)" },
          { critere: "Type bâtiment", annonce: crit.typeBatiment, base: s.typeBatiment, resultat: "— (filtre strict)" },
          { critere: "Surface (m²)", annonce: crit.surfaceM2, base: s.surface, resultat: matchGlyph(m2.surface) },
          { critere: "DPE", annonce: crit.dpe, base: s.dpe, resultat: matchGlyph(m2.dpe) },
          { critere: "GES", annonce: crit.ges, base: s.ges, resultat: matchGlyph(m2.ges) },
          {
            critere: "Étage",
            annonce: crit.etage,
            base:
              s.etage != null
                ? s.etage +
                  (s.etageComplement
                    ? " ← " + s.etageComplement
                    : s.etageStructure != null
                      ? " (struct. " + s.etageStructure + ")"
                      : "")
                : s.etageComplement || s.etageTexte,
            resultat: matchGlyph(m2.floor),
          },
          {
            critere: "Année",
            annonce: crit.anneeConstruction,
            base: s.annee != null ? s.annee : s.periode ? "période " + s.periode : null,
            resultat: matchGlyph(m2.year),
          },
        ];
        var label =
          "#" +
          (i + 1) +
          " " +
          (c.street || "?") +
          " — " +
          c.confidence +
          "% · DPE " +
          (s.numeroDpe || "?");
        if (console.groupCollapsed) console.groupCollapsed(label);
        else console.log(label);
        console.table(rows);
        if (console.groupEnd) console.groupEnd();
      });

      if (console.groupEnd) console.groupEnd();
    }

    function setApplyButtonVisible(m, visible) {
      var applyBtn = m && m.querySelector("[data-listing-address-ai-apply]");
      if (!applyBtn) return;
      applyBtn.hidden = !visible;
      applyBtn.disabled = !visible;
    }

    /** Remplit (ou vide) la liste des résultats dans la modale. */
    function renderCandidates(m, candidates) {
      var list = m.querySelector("[data-listing-address-ai-results-list]");
      var empty = m.querySelector("[data-listing-address-ai-empty]");
      if (!list) return;
      list.innerHTML = "";

      if (!candidates || !candidates.length) {
        list.hidden = true;
        if (empty) empty.hidden = false;
        setApplyButtonVisible(m, false);
        return;
      }

      list.hidden = false;
      if (empty) empty.hidden = true;
      setApplyButtonVisible(m, true);
      candidates.forEach(function (candidate, index) {
        list.appendChild(buildResultRow(candidate, index));
      });
    }

    function selectedAddressPayload() {
      var sel = window.__selectedAddressAiResult;
      if (!sel || !sel.street) return null;
      var postalCode = sel.postalCode || "";
      var city = sel.city || "";
      if (!postalCode && sel.locality) {
        var locMatch = String(sel.locality).match(/^(\d{5})\s+(.+)$/);
        if (locMatch) {
          postalCode = locMatch[1];
          city = locMatch[2];
        }
      }
      if (!postalCode || !city) return null;
      return {
        street: sel.street,
        postal_code: postalCode,
        city: city,
        complement: "",
      };
    }

    function applySelectedAddress(m) {
      var listingId = m && m.getAttribute("data-listing-id");
      var fields = selectedAddressPayload();
      if (!listingId || !fields) {
        console.warn("[Déterminer l'adresse] Aucune adresse sélectionnée à appliquer.");
        return Promise.resolve();
      }

      var applyBtn = m.querySelector("[data-listing-address-ai-apply]");
      if (applyBtn) {
        applyBtn.disabled = true;
        applyBtn.classList.add("is-loading");
      }

      if (!window.htmx || typeof window.htmx.ajax !== "function") {
        console.error("[Déterminer l'adresse] HTMX indisponible pour enregistrer l'adresse.");
        if (applyBtn) {
          applyBtn.disabled = false;
          applyBtn.classList.remove("is-loading");
        }
        return Promise.resolve();
      }

      return window.htmx
        .ajax("POST", "/listings/" + listingId + "/address", {
          target: "#listing-location-block",
          swap: "outerHTML",
          values: {
            _csrf: csrfTokenFromMeta(),
            street: fields.street,
            postal_code: fields.postal_code,
            city: fields.city,
            complement: fields.complement,
            address_source: "detected",
          },
        })
        .then(function () {
          var fresh = document.getElementById("listing-location-block");
          if (fresh && typeof window.__initListingMaps === "function") {
            window.__initListingMaps(fresh);
          }
          var aiModal = document.querySelector("[data-listing-address-ai-modal]");
          if (aiModal) aiModal.hidden = true;
          document.body.classList.remove("is-modal-open");
          window.__selectedAddressAiResult = null;
        })
        .catch(function (err) {
          console.error("[Déterminer l'adresse] Impossible d'enregistrer l'adresse", err);
          if (applyBtn) {
            applyBtn.disabled = false;
            applyBtn.classList.remove("is-loading");
          }
        });
    }

    function modal() {
      return document.querySelector("[data-listing-address-ai-modal]");
    }

    function introPanel(m) {
      return m && m.querySelector("[data-listing-address-ai-intro]");
    }

    function runningPanel(m) {
      return m && m.querySelector("[data-listing-address-ai-running]");
    }

    function resultsPanel(m) {
      return m && m.querySelector("[data-listing-address-ai-results]");
    }

    function clearAnalysisFinishTimer() {
      if (analysisFinishTimer) {
        clearTimeout(analysisFinishTimer);
        analysisFinishTimer = null;
      }
    }

    function stopStatusCycle() {
      if (statusTimer) {
        clearInterval(statusTimer);
        statusTimer = null;
      }
      statusIndex = 0;
    }

    function setStatusLine(m, line) {
      var el = m.querySelector("[data-listing-address-ai-status]");
      if (!el) return;
      el.classList.add("is-fading");
      window.setTimeout(function () {
        el.textContent = line;
        el.classList.remove("is-fading");
      }, 180);
    }

    function resultRows(m) {
      return m ? m.querySelectorAll("[data-listing-address-ai-result]") : [];
    }

    function selectResultRow(row) {
      var m = modal();
      if (!m || !row) return;
      resultRows(m).forEach(function (el) {
        var selected = el === row;
        el.classList.toggle("is-selected", selected);
        el.setAttribute("aria-selected", selected ? "true" : "false");
        el.tabIndex = selected ? 0 : -1;
      });
      window.__selectedAddressAiResult = {
        index: Number(row.getAttribute("data-result-index")),
        street: row.getAttribute("data-result-street") || "",
        locality: row.getAttribute("data-result-locality") || "",
        postalCode: row.getAttribute("data-result-postal-code") || "",
        city: row.getAttribute("data-result-city") || "",
        confidence: Number(row.getAttribute("data-result-confidence")),
      };
      var applyBtn = m.querySelector("[data-listing-address-ai-apply]");
      if (applyBtn) applyBtn.disabled = false;
      if (typeof row.focus === "function") {
        row.focus();
      }
    }

    function defaultResultSelection(m) {
      var selected = m.querySelector("[data-listing-address-ai-result].is-selected");
      if (selected) {
        selectResultRow(selected);
        return;
      }
      var first = m.querySelector("[data-listing-address-ai-result]");
      if (first) selectResultRow(first);
    }

    function showIntro(m) {
      stopStatusCycle();
      clearAnalysisFinishTimer();
      var intro = introPanel(m);
      var running = runningPanel(m);
      var results = resultsPanel(m);
      var title = m.querySelector("[data-listing-address-ai-title]");
      if (intro) intro.hidden = false;
      if (running) running.hidden = true;
      if (results) results.hidden = true;
      if (title) title.textContent = "Déterminer l'adresse via IA";
      setStatusLine(m, "Mise en route de l'analyse…");
      var startBtn = m.querySelector("[data-listing-address-ai-start]");
      if (startBtn) startBtn.disabled = false;
      var runningBlock = m.querySelector(".listing-address-ai-dialog__running");
      if (runningBlock) runningBlock.setAttribute("aria-busy", "false");
      window.__selectedAddressAiResult = null;
      setApplyButtonVisible(m, false);
    }

    function showResults(m) {
      stopStatusCycle();
      clearAnalysisFinishTimer();
      var intro = introPanel(m);
      var running = runningPanel(m);
      var results = resultsPanel(m);
      var title = m.querySelector("[data-listing-address-ai-title]");
      if (intro) intro.hidden = true;
      if (running) running.hidden = true;
      if (results) results.hidden = false;
      if (title) title.textContent = "Adresses possibles";
      var runningBlock = m.querySelector(".listing-address-ai-dialog__running");
      if (runningBlock) runningBlock.setAttribute("aria-busy", "false");
      defaultResultSelection(m);
    }

    function moveResultSelection(m, delta) {
      var rows = Array.prototype.slice.call(resultRows(m));
      if (!rows.length) return;
      var currentIndex = rows.findIndex(function (row) {
        return row.classList.contains("is-selected");
      });
      if (currentIndex < 0) currentIndex = 0;
      var nextIndex = currentIndex + delta;
      if (nextIndex < 0) nextIndex = rows.length - 1;
      if (nextIndex >= rows.length) nextIndex = 0;
      selectResultRow(rows[nextIndex]);
    }

    function startAnalysis(m) {
      var intro = introPanel(m);
      var running = runningPanel(m);
      var results = resultsPanel(m);
      var title = m.querySelector("[data-listing-address-ai-title]");
      if (intro) intro.hidden = true;
      if (running) running.hidden = false;
      if (results) results.hidden = true;
      if (title) title.textContent = "Analyse du bien";
      stopStatusCycle();
      clearAnalysisFinishTimer();
      setStatusLine(m, ANALYSIS_STATUS_LINES[0]);
      statusIndex = 1;
      statusTimer = window.setInterval(function () {
        if (!m || m.hidden) {
          stopStatusCycle();
          return;
        }
        setStatusLine(m, ANALYSIS_STATUS_LINES[statusIndex % ANALYSIS_STATUS_LINES.length]);
        statusIndex += 1;
      }, 650);
      var runningBlock = m.querySelector(".listing-address-ai-dialog__running");
      if (runningBlock) {
        runningBlock.setAttribute("aria-busy", "true");
        runningBlock.setAttribute("tabindex", "-1");
        runningBlock.focus();
      }
      var startBtn = m.querySelector("[data-listing-address-ai-start]");
      if (startBtn) startBtn.disabled = true;

      // On attend à la fois la réponse du serveur et un délai minimal (confort
      // visuel de l'analyse).
      var minDelay = new Promise(function (resolve) {
        analysisFinishTimer = window.setTimeout(function () {
          analysisFinishTimer = null;
          resolve();
        }, MIN_ANALYSIS_MS);
      });
      var searchResult = fetchAddressCandidates(m).catch(function (err) {
          console.error("[Déterminer l'adresse] Echec de la recherche", err);
          return { error: true, candidates: [] };
        });

      Promise.all([searchResult, minDelay]).then(function (values) {
        var payload = values[0] || {};
        if (!m || m.hidden) return;
        if (startBtn) startBtn.disabled = false;
        renderCandidates(m, payload.candidates || []);
        logMatchingDebug(payload);
        showResults(m);
      });
    }

    function openModal() {
      var m = modal();
      if (!m) return;
      showIntro(m);
      lastFocused = document.activeElement;
      m.hidden = false;
      document.body.classList.add("is-modal-open");
      var startBtn = m.querySelector("[data-listing-address-ai-start]");
      if (startBtn) startBtn.focus();
    }

    function closeModal() {
      var m = modal();
      if (m) {
        showIntro(m);
        m.hidden = true;
      }
      stopStatusCycle();
      clearAnalysisFinishTimer();
      document.body.classList.remove("is-modal-open");
      if (lastFocused && typeof lastFocused.focus === "function") {
        lastFocused.focus();
      }
      lastFocused = null;
    }

    document.addEventListener("click", function (event) {
      if (event.target.closest("[data-listing-address-ai-open]")) {
        event.preventDefault();
        openModal();
        return;
      }
      if (event.target.closest("[data-listing-address-ai-start]")) {
        event.preventDefault();
        var m = modal();
        if (m && !m.hidden) startAnalysis(m);
        return;
      }
      if (event.target.closest("[data-listing-address-ai-retry]")) {
        event.preventDefault();
        var modalEl = modal();
        if (modalEl && !modalEl.hidden) showIntro(modalEl);
        return;
      }
      if (event.target.closest("[data-listing-address-ai-apply]")) {
        event.preventDefault();
        var modalApply = modal();
        if (modalApply && !modalApply.hidden) {
          applySelectedAddress(modalApply);
        }
        return;
      }
      if (event.target.closest("a[href*='google.com/maps']")) {
        return;
      }
      var resultRow = event.target.closest("[data-listing-address-ai-result]");
      if (resultRow) {
        var modalForResult = modal();
        var results = resultsPanel(modalForResult);
        if (modalForResult && !modalForResult.hidden && results && !results.hidden) {
          selectResultRow(resultRow);
        }
        return;
      }
      if (event.target.closest("[data-listing-address-ai-dismiss]")) {
        closeModal();
      }
    });

    document.addEventListener("keydown", function (event) {
      var m = modal();
      if (!m || m.hidden) return;
      var results = resultsPanel(m);
      var resultsOpen = results && !results.hidden;

      if (resultsOpen && event.target.closest("[data-listing-address-ai-results-list]")) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          moveResultSelection(m, 1);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          moveResultSelection(m, -1);
          return;
        }
        if (event.key === " " || event.key === "Enter") {
          var focused = document.activeElement;
          if (focused && focused.matches("[data-listing-address-ai-result]")) {
            event.preventDefault();
            selectResultRow(focused);
          }
          return;
        }
      }

      if (event.key !== "Escape") return;
      event.preventDefault();
      closeModal();
    });
  })();

  // Fiche annonce : carte OpenStreetMap (Leaflet) quand l'adresse est géocodée.
  (function initListingLocationMaps() {
    var LEAFLET_CSS = "/public/vendor/leaflet/leaflet.css";
    var LEAFLET_JS = "/public/vendor/leaflet/leaflet.js";
    var leafletLoadPromise = null;

    function loadLeaflet() {
      if (window.L) return Promise.resolve(window.L);
      if (leafletLoadPromise) return leafletLoadPromise;
      leafletLoadPromise = new Promise(function (resolve, reject) {
        if (!document.getElementById("leaflet-css")) {
          var link = document.createElement("link");
          link.id = "leaflet-css";
          link.rel = "stylesheet";
          link.href = LEAFLET_CSS;
          document.head.appendChild(link);
        }
        var script = document.createElement("script");
        script.src = LEAFLET_JS;
        script.async = true;
        script.onload = function () {
          resolve(window.L);
        };
        script.onerror = function () {
          reject(new Error("leaflet_load_failed"));
        };
        document.head.appendChild(script);
      });
      return leafletLoadPromise;
    }

    function parseCoord(value) {
      var n = Number(value);
      return Number.isFinite(n) ? n : null;
    }

    function destroyMap(viewEl) {
      if (viewEl && viewEl._leafletMap) {
        viewEl._leafletMap.remove();
        viewEl._leafletMap = null;
        delete viewEl.dataset.mapReady;
      }
    }

    function initMapInView(viewEl, lat, lng) {
      if (!viewEl || viewEl.dataset.mapReady === "1") return;
      var host = viewEl.closest("[data-listing-map]");
      loadLeaflet()
        .then(function (L) {
          if (!viewEl.isConnected) return;
          destroyMap(viewEl);
          var basemapConfig = null;
          try {
            var rawBasemap = host && host.getAttribute("data-basemap-config");
            if (rawBasemap) basemapConfig = JSON.parse(decodeURIComponent(rawBasemap));
          } catch (_err) {
            basemapConfig = null;
          }
          var tileUrl = basemapConfig && basemapConfig.url;
          var tileAttribution =
            (basemapConfig && basemapConfig.attribution) || "";
          var tileSubdomains =
            (basemapConfig && basemapConfig.subdomains) || "";
          if (!tileUrl) {
            console.warn("[Carte] Configuration de tuiles absente.");
            return;
          }
          var map = L.map(viewEl, {
            scrollWheelZoom: false,
            attributionControl: true,
          }).setView([lat, lng], 17);
          var tileOptions = {
            maxZoom: 19,
            attribution: tileAttribution,
          };
          if (tileSubdomains) tileOptions.subdomains = tileSubdomains;
          L.tileLayer(tileUrl, tileOptions).addTo(map);
          L.marker([lat, lng]).addTo(map);
          viewEl._leafletMap = map;
          viewEl.dataset.mapReady = "1";
          window.setTimeout(function () {
            map.invalidateSize();
          }, 0);
        })
        .catch(function (err) {
          console.warn("[Carte] Impossible de charger la carte OpenStreetMap.", err);
        });
    }

    function scan(root) {
      var scope = root || document;
      scope.querySelectorAll("[data-listing-map-view]").forEach(function (viewEl) {
        var host = viewEl.closest("[data-listing-map]");
        if (!host) return;
        var lat = parseCoord(host.getAttribute("data-lat"));
        var lng = parseCoord(host.getAttribute("data-lng"));
        if (lat == null || lng == null) return;
        initMapInView(viewEl, lat, lng);
      });
    }

    function onReady() {
      scan(document);
    }

    // Permet aux swaps non-HTMX (ex. application de l'adresse détectée) de
    // (ré)initialiser la carte sur un fragment fraîchement injecté.
    window.__initListingMaps = scan;

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", onReady);
    } else {
      onReady();
    }

    document.body.addEventListener("htmx:afterSwap", function (event) {
      var target = event.detail && event.detail.target;
      if (!target) return;
      if (
        target.id === "listing-location-block" ||
        target.querySelector("[data-listing-map-view]")
      ) {
        scan(target);
      }
    });
  })();

  (function initDvfSalesPopovers() {
    document.addEventListener("click", function (event) {
      if (event.target.closest(".pricem2__dvf-method")) return;
      document.querySelectorAll(".pricem2__dvf-method[open]").forEach(function (el) {
        el.removeAttribute("open");
      });
    });

    var lastFocused = null;
    var openPopoverEl = null;
    var openAnchor = null;

    function setAnchorExpanded(anchor, expanded) {
      if (!anchor) return;
      anchor.setAttribute("aria-expanded", expanded ? "true" : "false");
    }

    function positionDvfSalesPopover(panel, anchor) {
      var margin = 8;
      var vw = window.innerWidth;
      var vh = window.innerHeight;
      var anchorRect = anchor.getBoundingClientRect();
      var panelRect = panel.getBoundingClientRect();
      var top = anchorRect.bottom + margin;
      var left = anchorRect.left;

      if (left + panelRect.width > vw - margin) {
        left = Math.max(margin, vw - margin - panelRect.width);
      }
      if (left < margin) left = margin;

      if (top + panelRect.height > vh - margin) {
        var above = anchorRect.top - margin - panelRect.height;
        if (above >= margin) top = above;
      }

      panel.style.top = Math.round(top) + "px";
      panel.style.left = Math.round(left) + "px";
    }

    function openPopover(id, anchor) {
      var popover = document.getElementById(id);
      if (!popover || !anchor) return;
      var panel = popover.querySelector("[data-dvf-sales-panel]");
      if (!panel) return;

      closeAnyOpen();
      lastFocused = anchor;
      openPopoverEl = popover;
      openAnchor = anchor;

      popover.hidden = false;
      popover.classList.add("is-open");
      setAnchorExpanded(anchor, true);

      requestAnimationFrame(function () {
        positionDvfSalesPopover(panel, anchor);
        var closeBtn = panel.querySelector("[data-dvf-sales-dismiss]");
        if (closeBtn) closeBtn.focus();
      });
    }

    function closePopover(popover) {
      if (!popover) return;
      var wasVisible = !popover.hidden;
      var panel = popover.querySelector("[data-dvf-sales-panel]");
      popover.hidden = true;
      popover.classList.remove("is-open");
      if (panel) {
        panel.style.top = "";
        panel.style.left = "";
      }
      if (openAnchor) setAnchorExpanded(openAnchor, false);
      openPopoverEl = null;
      openAnchor = null;
      if (wasVisible && lastFocused && typeof lastFocused.focus === "function") {
        lastFocused.focus();
      }
      lastFocused = null;
    }

    function closeAnyOpen() {
      if (openPopoverEl) {
        closePopover(openPopoverEl);
        return;
      }
      document.querySelectorAll("[data-dvf-sales-popover]:not([hidden])").forEach(function (el) {
        closePopover(el);
      });
    }

    function sortValueFromCell(cell) {
      if (!cell) return null;
      var raw = cell.getAttribute("data-sort-value");
      if (raw === "" || raw == null) return null;
      var n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }

    function compareSortValues(a, b, direction) {
      var aNull = a == null;
      var bNull = b == null;
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;
      var cmp;
      if (typeof a === "number" && typeof b === "number") {
        cmp = a - b;
      } else {
        cmp = String(a).localeCompare(String(b), "fr", { numeric: true });
      }
      return direction === "ascending" ? cmp : -cmp;
    }

    function sortDvfSalesTable(table, sortKey, direction) {
      var headRow = table.tHead && table.tHead.rows[0];
      var tbody = table.tBodies[0];
      if (!headRow || !tbody) return;
      var colIndex = -1;
      for (var i = 0; i < headRow.cells.length; i++) {
        if (headRow.cells[i].getAttribute("data-dvf-sort") === sortKey) {
          colIndex = i;
          break;
        }
      }
      if (colIndex < 0) return;

      var rows = Array.prototype.slice.call(tbody.rows);
      rows.sort(function (rowA, rowB) {
        return compareSortValues(
          sortValueFromCell(rowA.cells[colIndex]),
          sortValueFromCell(rowB.cells[colIndex]),
          direction
        );
      });
      rows.forEach(function (row) {
        tbody.appendChild(row);
      });

      Array.prototype.forEach.call(headRow.cells, function (th) {
        if (th.getAttribute("data-dvf-sort") === sortKey) {
          th.setAttribute("aria-sort", direction);
        } else if (th.hasAttribute("data-dvf-sort")) {
          th.setAttribute("aria-sort", "none");
        }
      });
    }

    document.addEventListener("click", function (event) {
      var sortBtn = event.target.closest(".dvf-sales-table__sort-btn");
      if (sortBtn) {
        var th = sortBtn.closest("[data-dvf-sort]");
        var table = sortBtn.closest(".dvf-sales-table");
        if (th && table) {
          event.preventDefault();
          var sortKey = th.getAttribute("data-dvf-sort");
          var current = th.getAttribute("aria-sort");
          var direction;
          if (current === "ascending") {
            direction = "descending";
          } else if (current === "descending") {
            direction = "ascending";
          } else {
            direction = "descending";
          }
          sortDvfSalesTable(table, sortKey, direction);
        }
        return;
      }

      var openBtn = event.target.closest("[data-dvf-sales-open]");
      if (openBtn) {
        event.preventDefault();
        event.stopPropagation();
        var popoverId = openBtn.getAttribute("data-dvf-sales-open");
        if (openPopoverEl && openAnchor === openBtn && !openPopoverEl.hidden) {
          closeAnyOpen();
        } else {
          openPopover(popoverId, openBtn);
        }
        return;
      }
      if (event.target.closest("[data-dvf-sales-dismiss]")) {
        var popover = event.target.closest("[data-dvf-sales-popover]");
        closePopover(popover);
        return;
      }
      if (
        openPopoverEl &&
        !openPopoverEl.hidden &&
        !event.target.closest("[data-dvf-sales-popover]") &&
        !event.target.closest("[data-dvf-sales-open]")
      ) {
        closeAnyOpen();
      }
    });

    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      closeAnyOpen();
    });

    window.addEventListener(
      "resize",
      function () {
        if (!openPopoverEl || openPopoverEl.hidden || !openAnchor) return;
        var panel = openPopoverEl.querySelector("[data-dvf-sales-panel]");
        if (panel) positionDvfSalesPopover(panel, openAnchor);
      },
      { passive: true }
    );
  })();

  (function initMobileNav() {
    var topbar = document.querySelector(".topbar");
    var toggle = document.querySelector("[data-mobile-nav-toggle]");
    var scrim = document.querySelector("[data-mobile-nav-dismiss]");
    var nav = document.getElementById("main-topnav");
    if (!topbar || !toggle || !nav) return;

    var mq = window.matchMedia("(max-width: 720px)");

    function setOpen(open) {
      if (!mq.matches && open) return;
      topbar.classList.toggle("topbar--nav-open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      var label = toggle.querySelector(".visually-hidden");
      if (label) {
        label.textContent = open ? "Fermer le menu" : "Ouvrir le menu";
      }
      if (scrim) {
        scrim.setAttribute("aria-hidden", open ? "false" : "true");
      }
      document.body.classList.toggle("is-mobile-nav-open", open);
    }

    function close() {
      setOpen(false);
    }

    toggle.addEventListener("click", function () {
      setOpen(!topbar.classList.contains("topbar--nav-open"));
    });

    if (scrim) {
      scrim.addEventListener("click", close);
    }

    nav.addEventListener("click", function (event) {
      if (!mq.matches) return;
      if (event.target.closest(".topnav__link")) close();
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") close();
    });

    if (mq.addEventListener) {
      mq.addEventListener("change", function () {
        if (!mq.matches) close();
      });
    } else if (mq.addListener) {
      mq.addListener(function () {
        if (!mq.matches) close();
      });
    }
  })();

})();
