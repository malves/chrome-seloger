/**
 * Page admin « Infos adresse » : autocomplétion BAN, puis analyse d'une adresse
 * (prix au m² DVF, évolution, ventes récentes, DPE). Tout le calcul est fait
 * côté serveur ; cette page gère la saisie et le rendu.
 */
(function () {
  "use strict";

  var root = document.querySelector("[data-adrins]");
  if (!root) return;

  var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || "";
  var form = root.querySelector("[data-adrins-form]");
  var input = root.querySelector("#adrins-input");
  var suggestEl = root.querySelector("[data-adrins-suggest]");
  var statusEl = root.querySelector("[data-adrins-status]");
  var resultsEl = root.querySelector("[data-adrins-results]");
  var placeEl = root.querySelector("[data-adrins-place]");
  var metaEl = root.querySelector("[data-adrins-meta]");
  var pricesEl = root.querySelector("[data-adrins-prices]");
  var evolutionWrap = root.querySelector("[data-adrins-evolution-wrap]");
  var evolutionEl = root.querySelector("[data-adrins-evolution]");
  var salesWrap = root.querySelector("[data-adrins-sales-wrap]");
  var salesSeg = root.querySelector("[data-adrins-sales-seg]");
  var salesRows = root.querySelector("[data-adrins-sales-rows]");
  var dpeWrap = root.querySelector("[data-adrins-dpe-wrap]");
  var dpeEl = root.querySelector("[data-adrins-dpe]");

  var euro = new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  });
  var dateFmt = new Intl.DateTimeFormat("fr-FR", { month: "short", year: "numeric" });

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function m2(value) {
    if (value == null || !Number.isFinite(Number(value))) return "—";
    return euro.format(Number(value)) + "/m²";
  }

  function formatMonth(iso) {
    if (!iso) return "—";
    var t = Date.parse(iso.length <= 10 ? iso + "T12:00:00Z" : iso);
    if (Number.isNaN(t)) return "—";
    return dateFmt.format(new Date(t));
  }

  /* ------------------------- Autocomplétion BAN ------------------------ */

  var acTimer = null;
  var acController = null;
  var activeIndex = -1;
  var suggestions = [];

  function closeSuggest() {
    suggestEl.hidden = true;
    suggestEl.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
    activeIndex = -1;
    suggestions = [];
  }

  function renderSuggest() {
    if (!suggestions.length) {
      closeSuggest();
      return;
    }
    var html = "";
    for (var i = 0; i < suggestions.length; i += 1) {
      var s = suggestions[i];
      html +=
        '<li class="adrins__suggest-item" role="option" id="adrins-opt-' + i + '"' +
        (i === activeIndex ? ' aria-selected="true"' : "") +
        ' data-index="' + i + '">' +
        '<span class="adrins__suggest-label">' + esc(s.label) + "</span>" +
        (s.context ? '<span class="adrins__suggest-ctx">' + esc(s.context) + "</span>" : "") +
        "</li>";
    }
    suggestEl.innerHTML = html;
    suggestEl.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function fetchSuggestions(q) {
    if (acController) acController.abort();
    acController = new AbortController();
    fetch("/admin/adresse/autocomplete?q=" + encodeURIComponent(q), {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: acController.signal,
    })
      .then(function (res) {
        return res.ok ? res.json() : { suggestions: [] };
      })
      .then(function (data) {
        suggestions = (data && data.suggestions) || [];
        activeIndex = -1;
        if (document.activeElement === input) renderSuggest();
      })
      .catch(function () {});
  }

  input.addEventListener("input", function () {
    var q = input.value.trim();
    if (acTimer) clearTimeout(acTimer);
    if (q.length < 3) {
      closeSuggest();
      return;
    }
    acTimer = setTimeout(function () {
      fetchSuggestions(q);
    }, 180);
  });

  input.addEventListener("keydown", function (e) {
    if (suggestEl.hidden || !suggestions.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % suggestions.length;
      renderSuggest();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + suggestions.length) % suggestions.length;
      renderSuggest();
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      choose(activeIndex);
    } else if (e.key === "Escape") {
      closeSuggest();
    }
  });

  suggestEl.addEventListener("mousedown", function (e) {
    var item = e.target.closest("[data-index]");
    if (!item) return;
    e.preventDefault();
    choose(Number(item.getAttribute("data-index")));
  });

  function choose(index) {
    var s = suggestions[index];
    if (!s) return;
    input.value = s.label;
    closeSuggest();
    analyze();
  }

  document.addEventListener("click", function (e) {
    if (!root.contains(e.target)) closeSuggest();
  });

  /* ----------------------------- Analyse ------------------------------- */

  function setStatus(message, tone) {
    if (!message) {
      statusEl.hidden = true;
      return;
    }
    statusEl.hidden = false;
    statusEl.textContent = message;
    statusEl.setAttribute("data-tone", tone || "info");
  }

  function priceCard(type, label, price) {
    if (!price) {
      return (
        '<div class="adrins__price adrins__price--empty">' +
        '<p class="adrins__price-type">' + esc(label) + "</p>" +
        '<p class="adrins__price-none">Pas assez de ventes</p>' +
        "</div>"
      );
    }
    var sample =
      price.count_reference +
      " vente" + (price.count_reference > 1 ? "s" : "") +
      " · rayon " + price.meters + " m" +
      (price.widened ? " (élargi)" : "");
    return (
      '<div class="adrins__price">' +
      '<p class="adrins__price-type">' + esc(label) + "</p>" +
      '<p class="adrins__price-value">' + m2(price.median_price_m2) + "</p>" +
      '<p class="adrins__price-sample">' + esc(sample) + "</p>" +
      "</div>"
    );
  }

  function renderPrices(data) {
    var html = "";
    for (var i = 0; i < data.types.length; i += 1) {
      var t = data.types[i];
      html += priceCard(t.key, t.label, data.prices[t.key]);
    }
    pricesEl.innerHTML = html;
  }

  function evolutionBlock(label, evo) {
    if (!evo) return "";
    var scopeLabel = evo.scope === "department" ? "département" : "commune";
    var trend =
      evo.trend_pct == null
        ? "—"
        : (evo.trend_pct > 0 ? "+" : "") + evo.trend_pct.toLocaleString("fr-FR") + " %";
    var toneClass =
      evo.tone === "ok" ? "is-up" : evo.tone === "high" ? "is-down" : "is-flat";
    var bars = "";
    var max = 0;
    for (var j = 0; j < evo.points.length; j += 1) {
      max = Math.max(max, evo.points[j].median_price_m2);
    }
    for (var k = 0; k < evo.points.length; k += 1) {
      var p = evo.points[k];
      var h = max > 0 ? Math.round((p.median_price_m2 / max) * 100) : 0;
      var yearLabel = esc(p.label || p.year);
      bars +=
        '<div class="adrins__bar" style="--h:' + h + '%" ' +
        'title="' + yearLabel + " : " + esc(m2(p.median_price_m2)) + '">' +
        '<span class="adrins__bar-year">' + yearLabel + "</span>" +
        "</div>";
    }
    return (
      '<div class="adrins__evo">' +
      '<div class="adrins__evo-head">' +
      '<p class="adrins__evo-type">' + esc(label) + "</p>" +
      '<p class="adrins__evo-trend ' + toneClass + '">' + esc(trend) +
      ' <span class="adrins__evo-scope">' + evo.trend_from_year + "–" + esc(evo.trend_to_label || evo.trend_to_year) +
      " · " + scopeLabel + "</span></p>" +
      "</div>" +
      '<div class="adrins__bars">' + bars + "</div>" +
      '<p class="adrins__evo-label">' + esc(evo.label) + "</p>" +
      "</div>"
    );
  }

  function renderEvolution(data) {
    var html = "";
    for (var i = 0; i < data.types.length; i += 1) {
      var t = data.types[i];
      html += evolutionBlock(t.label, data.evolution[t.key]);
    }
    if (html) {
      evolutionEl.innerHTML = html;
      evolutionWrap.hidden = false;
    } else {
      evolutionWrap.hidden = true;
    }
  }

  var currentSales = {};
  var salesTypes = [];
  function renderSalesTable(typeKey) {
    var list = currentSales[typeKey] || [];
    var html = "";
    for (var i = 0; i < list.length; i += 1) {
      var s = list[i];
      html +=
        "<tr>" +
        "<td>" + esc(formatMonth(s.mutation_date || (s.year ? s.year + "-07-01" : null))) + "</td>" +
        '<td class="adrins__num">' + (s.price ? euro.format(s.price) : "—") + "</td>" +
        '<td class="adrins__num">' + (s.surface ? s.surface + " m²" : "—") + "</td>" +
        '<td class="adrins__num">' + m2(s.price_per_m2) + "</td>" +
        '<td class="adrins__num">' + (s.distance_m != null ? s.distance_m + " m" : "—") + "</td>" +
        "</tr>";
    }
    salesRows.innerHTML = html || '<tr><td colspan="5" class="adrins__empty">Aucune vente à proximité.</td></tr>';

    var tabs = salesSeg.querySelectorAll("[data-sales-type]");
    for (var k = 0; k < tabs.length; k += 1) {
      var active = tabs[k].getAttribute("data-sales-type") === typeKey;
      tabs[k].classList.toggle("is-active", active);
      tabs[k].setAttribute("aria-selected", active ? "true" : "false");
    }
  }

  function renderSales(data) {
    currentSales = data.sales || {};
    salesTypes = [];
    var segHtml = "";
    for (var i = 0; i < data.types.length; i += 1) {
      var t = data.types[i];
      var list = currentSales[t.key] || [];
      if (!list.length) continue;
      salesTypes.push(t.key);
      segHtml +=
        '<button type="button" class="adrins__seg-btn" role="tab" ' +
        'data-sales-type="' + t.key + '">' + esc(t.label) +
        ' <span class="adrins__seg-count">' + list.length + "</span></button>";
    }
    if (!salesTypes.length) {
      salesWrap.hidden = true;
      return;
    }
    salesSeg.innerHTML = segHtml;
    salesWrap.hidden = false;
    renderSalesTable(salesTypes[0]);
  }

  salesSeg.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-sales-type]");
    if (btn) renderSalesTable(btn.getAttribute("data-sales-type"));
  });

  var DPE_COLORS = { A: "#319834", B: "#5bb033", C: "#c3d117", D: "#fff12c", E: "#f7b31a", F: "#eb7f26", G: "#e30613" };
  function dpeBadge(label) {
    var key = String(label || "").toUpperCase();
    if (!DPE_COLORS[key]) return '<span class="adrins__dpe-badge">—</span>';
    return '<span class="adrins__dpe-badge" style="--c:' + DPE_COLORS[key] + '">' + key + "</span>";
  }

  function renderDpe(data) {
    var list = data.dpe || [];
    if (!list.length) {
      dpeWrap.hidden = true;
      return;
    }
    var html = "";
    for (var i = 0; i < list.length; i += 1) {
      var d = list[i];
      html +=
        '<li class="adrins__dpe-item">' +
        dpeBadge(d.etiquette_dpe) +
        '<div class="adrins__dpe-info">' +
        '<p class="adrins__dpe-addr">' + esc(d.adresse || "Adresse inconnue") + "</p>" +
        '<p class="adrins__dpe-meta">' +
        esc([
          d.type_batiment,
          d.surface ? d.surface + " m²" : null,
          d.annee_construction ? "constr. " + d.annee_construction : null,
          d.date ? formatMonth(d.date) : null,
        ].filter(Boolean).join(" · ")) +
        "</p>" +
        "</div>" +
        "</li>";
    }
    dpeEl.innerHTML = html;
    dpeWrap.hidden = false;
  }

  function renderResult(data) {
    placeEl.textContent = data.place.label || input.value;
    metaEl.textContent = [
      data.place.postal_code,
      data.place.city,
      data.place.insee_code ? "INSEE " + data.place.insee_code : null,
    ].filter(Boolean).join(" · ");

    renderPrices(data);
    renderEvolution(data);
    renderSales(data);
    renderDpe(data);
    resultsEl.hidden = false;
  }

  var controller = null;
  function analyze() {
    var address = input.value.trim();
    if (address.length < 3) {
      setStatus("Saisissez une adresse plus précise.", "warn");
      return;
    }
    closeSuggest();
    setStatus("Analyse en cours…", "info");
    resultsEl.hidden = true;
    if (controller) controller.abort();
    controller = new AbortController();
    fetch("/admin/adresse", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
        Accept: "application/json",
      },
      body: JSON.stringify({ address: address }),
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        if (!data) {
          setStatus("Erreur lors de l'analyse.", "warn");
          return;
        }
        if (data.status === "not_found") {
          setStatus("Adresse introuvable (Base Adresse Nationale).", "warn");
          return;
        }
        setStatus(null);
        renderResult(data);
      })
      .catch(function (err) {
        if (err && err.name !== "AbortError") {
          setStatus("Service indisponible, réessayez.", "warn");
        }
      });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    analyze();
  });
})();
