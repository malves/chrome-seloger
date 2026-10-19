/**
 * Page « Mon endettement » : saisie libre des revenus, crédits et charges,
 * calcul en direct (voir `debt-ratio.js`, partagé avec le serveur) et
 * enregistrement automatique.
 *
 * Les animations servent la lecture : la jauge et les montants glissent vers
 * leur nouvelle valeur pour montrer l'effet d'une saisie, une pastille
 * « +1,2 pt » isole cet effet, les lignes s'ouvrent et se referment à leur
 * place pour garder le regard au bon endroit.
 */

(function () {
  "use strict";

  var root = document.querySelector("[data-debt]");
  if (!root) return;

  import("/public/js/debt-ratio.js")
    .then(init)
    .catch(function () {
      var verdict = root.querySelector("[data-verdict]");
      if (verdict) verdict.textContent = "Le calcul n'a pas pu se charger. Rechargez la page.";
    });

  function init(lib) {
    var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var initial = JSON.parse(document.getElementById("debt-initial").textContent);
    var defaults = initial.defaults || {};
    var state = lib.sanitizeDebtState(initial.state, defaults);
    var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || "";

    var lists = {
      incomes: root.querySelector('[data-list="incomes"]'),
      charges: root.querySelector('[data-list="charges"]'),
    };
    var templates = {
      incomes: document.getElementById("debt-tpl-income"),
      charges: document.getElementById("debt-tpl-charge"),
    };
    var types = { incomes: lib.INCOME_TYPES, charges: lib.CHARGE_TYPES };
    var rows = new Map();
    var lastResult = null;
    var lastShownRatio = null;

    /* ----------------------------- Formats ----------------------------- */

    var nf0 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
    var monthFmt = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" });

    function euro(value) {
      return nf0.format(Math.round(value)) + " €";
    }
    function perMonth(value) {
      return euro(value) + " / mois";
    }
    function pct(value, digits) {
      var d = digits == null ? 1 : digits;
      return (
        (value * 100).toLocaleString("fr-FR", {
          minimumFractionDigits: d,
          maximumFractionDigits: d,
        }) + " %"
      );
    }
    function points(value) {
      var n = Math.abs(value * 100);
      var s = n.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
      return (value > 0 ? "+" : "−") + s + (n >= 2 ? " pts" : " pt");
    }
    function monthLabel(value) {
      if (!value) return "";
      var parts = value.split("-");
      return monthFmt.format(new Date(Number(parts[0]), Number(parts[1]) - 1, 1));
    }
    function syncDebtDayPickerUI(picker) {
      if (picker._debtDayApi) picker._debtDayApi.syncFromHidden();
    }

    function initDebtDayPicker(picker) {
      if (!picker || picker.dataset.debtDayReady) return;
      if (!window.CalendarPicker || !window.CalendarPicker.mountSingleDay) return;
      picker.dataset.debtDayReady = "1";
      picker._debtDayApi = window.CalendarPicker.mountSingleDay(picker, {
        storeAsMonth: true,
        disableFuture: false,
      });
    }

    function initDebtDayPickers(scope) {
      (scope || root).querySelectorAll("[data-debt-day-picker]").forEach(initDebtDayPicker);
    }

    function clearDebtDayPicker(picker) {
      if (!picker || !picker._debtDayApi) return;
      picker._debtDayApi.clear();
    }
    function durationLabel(months) {
      if (months < 12) return months + " mois";
      var y = Math.floor(months / 12);
      var m = months % 12;
      var ys = y + (y > 1 ? " ans" : " an");
      return m ? ys + " et " + m + " mois" : ys;
    }
    function parseAmount(value) {
      var s = String(value).replace(/[\s\u202f\u00a0€]/g, "").replace(",", ".");
      if (!s) return null;
      var n = Number(s);
      return Number.isFinite(n) && n >= 0 ? n : null;
    }
    function rateInput(value) {
      return value == null
        ? ""
        : (value * 100).toLocaleString("fr-FR", { maximumFractionDigits: 2 });
    }
    function amountInput(value) {
      return value == null ? "" : nf0.format(Math.round(value));
    }
    function nameOf(list, item) {
      return item.label || types[list][item.type].label;
    }
    function newId() {
      return (
        "r" +
        Date.now().toString(36) +
        Math.floor(Math.random() * 1296).toString(36)
      ).slice(0, 24);
    }

    /* --------------------------- Animations ---------------------------- */

    function animateNumber(el, to, format) {
      var from = typeof el._value === "number" ? el._value : null;
      el._value = to;
      if (el._raf) cancelAnimationFrame(el._raf);
      if (reduceMotion || from === null || Math.abs(from - to) < 0.5) {
        el.textContent = format(to);
        return;
      }
      var start = performance.now();
      var duration = 450;
      function frame(now) {
        var t = Math.min(1, (now - start) / duration);
        var eased = 1 - Math.pow(1 - t, 3);
        el.textContent = format(from + (to - from) * eased);
        if (t < 1) el._raf = requestAnimationFrame(frame);
      }
      el._raf = requestAnimationFrame(frame);
    }

    function restartAnimation(el, className) {
      el.classList.remove(className);
      void el.offsetWidth;
      el.classList.add(className);
    }

    function pulse(el) {
      if (!el) return;
      el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
      restartAnimation(el, "is-pulsing");
    }

    /* ----------------------------- Lignes ------------------------------ */

    function setupRow(list, item) {
      var el = templates[list].content.firstElementChild.cloneNode(true);
      var meta = types[list][item.type];
      el.dataset.id = item.id;
      el.dataset.list = list;
      el.dataset.type = item.type;
      if (meta.kind) el.dataset.kind = meta.kind;

      el.querySelector("[data-type-label]").textContent = meta.label;
      var name = el.querySelector('[data-field="label"]');
      name.placeholder = "Nommer (facultatif)";
      name.setAttribute("aria-label", "Nom de la ligne " + meta.label);
      el.querySelector("[data-remove]").setAttribute("aria-label", "Retirer " + meta.label);
      el.querySelector("[data-hint]").textContent = meta.hint;

      el.querySelectorAll("[data-field]").forEach(function (input, index) {
        var field = input.getAttribute("data-field");
        if (input.type === "radio") input.name = item.id + "-" + field;
        else input.id = item.id + "-" + field + "-" + index;
      });
      el.querySelectorAll("[data-label-for]").forEach(function (label) {
        var fieldName = label.getAttribute("data-label-for");
        var fieldWrap = label.closest(".debt-field");
        var trigger = fieldWrap && fieldWrap.querySelector("[data-cal-trigger]");
        if (trigger) {
          if (!trigger.id) trigger.id = item.id + "-" + fieldName + "-trigger";
          label.htmlFor = trigger.id;
          return;
        }
        var input = fieldWrap && fieldWrap.querySelector("[data-field]");
        if (input) label.htmlFor = input.id;
      });

      el.querySelectorAll("[data-only]").forEach(function (node) {
        node.hidden = node.getAttribute("data-only") !== item.type;
      });
      el.querySelectorAll("[data-only-kind]").forEach(function (node) {
        node.hidden = node.getAttribute("data-only-kind").split(" ").indexOf(meta.kind) === -1;
      });

      if (list === "charges") {
        var isCharge = meta.kind === "charge";
        el.querySelector("[data-monthly-label]").textContent =
          meta.kind === "lease" ? "Loyer" : isCharge ? "Montant" : "Mensualité";
        el.querySelector("[data-monthly-unit]").textContent = isCharge ? "€" : "€ / mois";
        var ratePlaceholder = el.querySelector("[data-rate-placeholder]");
        if (ratePlaceholder && meta.rate) {
          ratePlaceholder.placeholder = rateInput(meta.rate) + " par défaut";
        }
      }

      fillRow(el, item);
      el.querySelectorAll("[data-debt-day-picker]").forEach(syncDebtDayPickerUI);
      initDebtDayPickers(el);
      refreshReveals(el, item, false);
      return el;
    }

    function fillRow(el, item) {
      el.querySelectorAll("[data-field]").forEach(function (input) {
        var field = input.getAttribute("data-field");
        var value = item[field];
        if (input.type === "radio") input.checked = value != null && String(value) === input.value;
        else if (input.type === "checkbox") input.checked = Boolean(value);
        else if (field === "rate") input.value = rateInput(value);
        else if (field === "years") input.value = value == null ? "" : String(value).replace(".", ",");
        else if (input.hasAttribute("data-amount")) input.value = amountInput(value);
        else input.value = value == null ? "" : value;
      });
      el.querySelectorAll("[data-debt-day-picker]").forEach(syncDebtDayPickerUI);
    }

    function setReveal(node, open, animate) {
      if (!node) return;
      var wasOpen = node.classList.contains("is-open");
      if (node._ready && wasOpen === open) return;
      node._ready = true;
      node.classList.toggle("no-anim", !animate || reduceMotion);
      node.classList.toggle("is-open", open);
      node.inert = !open;
    }

    function refreshReveals(el, item, animate) {
      if (el.dataset.list !== "charges") return;
      var kind = el.dataset.kind;
      var canEstimate = kind === "loan" || kind === "revolving";
      var estimate = canEstimate && item.mode === "estimate";
      setReveal(el.querySelector('[data-reveal="known"]'), !estimate, animate);
      setReveal(
        el.querySelector('[data-reveal="insurance"]'),
        kind === "loan" && !estimate && !item.insuranceIncluded,
        animate
      );
      setReveal(el.querySelector('[data-reveal="estimate-loan"]'), estimate && kind === "loan", animate);
      setReveal(
        el.querySelector('[data-reveal="estimate-revolving"]'),
        estimate && kind === "revolving",
        animate
      );
      setReveal(
        el.querySelector('[data-reveal="end"]'),
        (kind === "loan" || kind === "lease") && !item.settled,
        animate
      );
      el.classList.toggle("is-excluded", Boolean(item.settled));
    }

    function enter(el) {
      if (reduceMotion) return;
      el.classList.add("is-entering");
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          el.classList.remove("is-entering");
        });
      });
    }

    function leave(el, done) {
      if (reduceMotion) {
        done();
        return;
      }
      el.classList.add("is-leaving");
      var finished = false;
      function finish() {
        if (finished) return;
        finished = true;
        done();
      }
      el.addEventListener("transitionend", function (event) {
        if (event.target === el) finish();
      });
      setTimeout(finish, 400);
    }

    function insertRow(list, item, index, options) {
      var el = setupRow(list, item);
      var ul = lists[list];
      ul.insertBefore(el, ul.children[index] || null);
      rows.set(item.id, el);
      if (options && options.animate) enter(el);
      if (options && options.focus) {
        var target =
          el.querySelector('.debt-reveal.is-open [data-amount], .debt-row__body:not([hidden]) > .debt-field [data-amount]') ||
          el.querySelector("[data-amount]");
        if (target) setTimeout(function () { target.focus({ preventScroll: true }); }, reduceMotion ? 0 : 120);
        setTimeout(function () {
          el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
        }, 60);
      }
      return el;
    }

    function addItem(list, type) {
      var meta = types[list][type];
      var item =
        list === "incomes"
          ? { id: newId(), type: type, label: "", amount: null, frequency: meta.frequency, counted: meta.countedByDefault !== false }
          : {
              id: newId(),
              type: type,
              label: "",
              mode: "known",
              monthly: null,
              frequency: "month",
              insuranceIncluded: true,
              insurance: null,
              principal: null,
              years: null,
              rate: null,
              start: "",
              end: "",
              settled: false,
            };
      if (list === "incomes" && meta.adjustable) item.retained = meta.retained;
      state[list].push(item);
      insertRow(list, item, state[list].length - 1, { animate: true, focus: true });
      update({ save: true });
    }

    function removeItem(id) {
      var el = rows.get(id);
      if (!el) return;
      var list = el.dataset.list;
      var index = state[list].findIndex(function (it) { return it.id === id; });
      if (index === -1) return;
      var item = state[list][index];
      state[list].splice(index, 1);
      rows.delete(id);
      el.querySelectorAll("input, button").forEach(function (n) { n.disabled = true; });
      leave(el, function () { el.remove(); });
      update({ save: true });
      showToast("« " + nameOf(list, item) + " » retiré", function () {
        state[list].splice(Math.min(index, state[list].length), 0, item);
        insertRow(list, item, index, { animate: true });
        update({ save: true });
        pulse(rows.get(item.id));
      });
    }

    function findItem(el) {
      var list = el.dataset.list;
      return state[list].find(function (it) { return it.id === el.dataset.id; });
    }

    function readField(input) {
      var field = input.getAttribute("data-field");
      if (input.type === "checkbox") return input.checked;
      if (field === "retained") return Number(input.value);
      if (input.type === "radio") return input.value;
      if (field === "rate") {
        var r = parseAmount(input.value);
        return r == null ? null : Math.min(r, 30) / 100;
      }
      if (field === "years") {
        var y = parseAmount(input.value);
        return y == null ? null : Math.min(y, 40);
      }
      if (input.hasAttribute("data-amount")) return parseAmount(input.value);
      return input.value;
    }

    function onRowInput(input) {
      var el = input.closest("[data-row]");
      var item = el && findItem(el);
      if (!item) return;
      var field = input.getAttribute("data-field");
      if (input.type === "radio" && !input.checked) return;
      item[field] = readField(input);
      if (field === "principal") {
        el.querySelectorAll('[data-field="principal"]').forEach(function (other) {
          if (other !== input) other.value = amountInput(item.principal);
        });
      }
      if (field === "mode" || field === "insuranceIncluded" || field === "settled") {
        refreshReveals(el, item, true);
      }
      if (field === "mode" && item.mode === "estimate") {
        var first = el.querySelector('.debt-reveal.is-open [data-field="principal"]');
        if (first && !first.value) setTimeout(function () { first.focus({ preventScroll: true }); }, 180);
      }
      update({ save: true });
    }

    /* --------------------------- Messages ------------------------------ */

    function rowNotes(list, item, ev) {
      var notes = [];
      if (list === "incomes") {
        var meta = lib.INCOME_TYPES[item.type];
        if (ev.missing) return notes;
        if (!item.counted) {
          notes.push({ tone: "muted", text: "Non compté dans le calcul, comme le font la plupart des banques." });
        } else if (ev.retainedRate < 1) {
          notes.push({
            tone: "info",
            text: "Compté " + perMonth(ev.monthly) + " : " + Math.round(ev.retainedRate * 100) + " % de " + perMonth(ev.gross) + ".",
          });
        } else if (item.frequency === "year") {
          notes.push({ tone: "info", text: "Soit " + perMonth(ev.gross) + "." });
        }
        if (item.type === "salary" && item.frequency === "month" && item.amount > 0 && item.amount < 600) {
          notes.push({ tone: "warn", text: "Montant faible pour un salaire mensuel : s'agit-il bien d'un montant par mois ?" });
        }
        if (item.frequency === "month" && item.amount >= 15000 && meta.frequency === "month") {
          notes.push({ tone: "warn", text: "Ce montant ressemble à un revenu annuel : choisissez « par an » si c'est le cas." });
        }
        return notes;
      }

      var cmeta = lib.CHARGE_TYPES[item.type];
      if (ev.excluded === "settled") {
        notes.push({ tone: "muted", text: "Non compté : il disparaîtra avec l'achat. La banque vous demandera un justificatif (offre de rachat, compromis de vente…)." });
        return notes;
      }
      if (ev.excluded === "ended") {
        notes.push({ tone: "ok", text: "Terminé en " + monthLabel(ev.end) + " : il n'est plus compté. Vous pouvez retirer cette ligne." });
        return notes;
      }

      if (ev.missing) {
        if (item.mode === "estimate" && cmeta.kind === "loan") {
          notes.push({ tone: "info", text: "Indiquez au moins le montant emprunté et la durée, même approximatifs." });
        } else if (item.mode !== "estimate" && (cmeta.kind === "loan" || cmeta.kind === "revolving")) {
          notes.push({
            tone: "info",
            text: "Vous ne trouvez pas la mensualité ?",
            action: { label: "Estimer à partir du montant emprunté", mode: "estimate" },
          });
        }
        return notes;
      }

      if (ev.estimated && cmeta.kind === "loan") {
        var defaultRate = item.rate == null;
        notes.push({
          tone: "info",
          text:
            "Mensualité estimée ≈ " + perMonth(ev.monthly) + " (taux " + pct(ev.rateUsed, 2) +
            (defaultRate ? " par défaut" : "") + ", assurance comprise). Remplacez-la par le vrai montant dès que vous l'avez.",
        });
      } else if (ev.estimated) {
        notes.push({ tone: "info", text: "Estimé à 3 % du plafond : " + perMonth(ev.monthly) + "." });
      } else if (cmeta.kind === "charge" && item.frequency === "year") {
        notes.push({ tone: "info", text: "Soit " + perMonth(ev.monthly) + "." });
      }

      if (ev.insuranceMissing) {
        notes.push({ tone: "warn", text: "Assurance non renseignée : elle n'est pas comptée alors que la banque l'inclura. Elle figure sur votre relevé ou votre contrat d'assurance emprunteur." });
      }

      if (ev.endingSoon) {
        notes.push({
          tone: "ok",
          text: "Se termine dans " + durationLabel(ev.monthsLeft) + " (" + monthLabel(ev.end) + "). Certaines banques ne le comptent plus s'il reste moins de 6 mois.",
        });
      } else if (ev.endEstimated) {
        notes.push({ tone: "info", text: "Fin estimée en " + monthLabel(ev.end) + ", d'après le début et la durée." });
      } else if (ev.monthsLeft != null) {
        notes.push({ tone: "muted", text: "Encore " + durationLabel(ev.monthsLeft) + ", jusqu'en " + monthLabel(ev.end) + "." });
      } else if (ev.endUnknown) {
        notes.push({ tone: "muted", text: "Fin inconnue : pas de souci, on le compte en entier, comme le fera la banque. La date figure sur votre offre de prêt ou dans votre espace bancaire." });
      }
      return notes;
    }

    function renderNotes(container, notes) {
      var key = JSON.stringify(notes);
      if (container._key === key) return;
      container._key = key;
      container.textContent = "";
      notes.forEach(function (note) {
        var li = document.createElement("li");
        li.className = "debt-note debt-note--" + note.tone;
        li.appendChild(document.createTextNode(note.text));
        if (note.action) {
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "debt-link";
          btn.setAttribute("data-set-mode", note.action.mode);
          btn.textContent = note.action.label;
          li.appendChild(document.createTextNode(" "));
          li.appendChild(btn);
        }
        if (!reduceMotion) li.classList.add("is-new");
        container.appendChild(li);
      });
    }

    function renderRowValue(el, text, tone) {
      var out = el.querySelector("[data-row-value]");
      if (out.textContent !== text) {
        out.textContent = text;
        if (!reduceMotion && text) restartAnimation(out, "is-bumped");
      }
      out.dataset.tone = tone;
    }

    function globalTips(result) {
      var tips = [];
      var income = result.income;

      if (!state.incomes.length || income <= 0) {
        tips.push({
          id: "start",
          tone: "info",
          text: state.incomes.length
            ? "Renseignez le montant de votre revenu pour lancer le calcul."
            : "Commencez par votre salaire net mensuel avant impôt : c'est la base du calcul.",
          action: state.incomes.length ? { label: "Compléter", target: state.incomes[0].id } : { label: "Ajouter un salaire", add: "salary" },
        });
        return tips;
      }

      var ratio = result.ratioWithProject != null ? result.ratioWithProject : result.ratioCurrent;
      if (ratio > result.limit) {
        if (result.currentCharges > result.maxCharges) {
          tips.push({
            id: "over-current",
            tone: "danger",
            text: "Vos crédits actuels dépassent déjà " + pct(result.limit, 0) + ". Solder ou regrouper un petit crédit est souvent la première piste avant un achat.",
          });
        } else if (result.projectMonthly) {
          tips.push({
            id: "over-project",
            tone: "danger",
            text:
              "Pour repasser sous " + pct(result.limit, 0) + ", la mensualité du projet devrait descendre à " +
              perMonth(result.room) + " : plus d'apport, une durée plus longue ou un prix négocié.",
          });
        }
      }

      state.charges.forEach(function (item, i) {
        var ev = result.charges[i];
        if (ev.endingSoon && result.ratioWithoutEnding != null) {
          tips.push({
            id: "ending-" + item.id,
            tone: "ok",
            text:
              "« " + nameOf("charges", item) + " » se termine dans " + durationLabel(ev.monthsLeft) +
              ". Sans lui, votre taux serait de " + pct(result.ratioWithoutEnding) + ".",
            action: { label: "Voir", target: item.id },
          });
        }
      });

      var revolving = state.charges.filter(function (item, i) {
        return item.type === "revolving" && result.charges[i].monthly > 0;
      });
      if (revolving.length) {
        var weight = revolving.reduce(function (sum, item) {
          return sum + result.charges[state.charges.indexOf(item)].monthly;
        }, 0);
        tips.push({
          id: "revolving",
          tone: "info",
          text: "Un crédit renouvelable compte même inutilisé. Le clôturer avant le rendez-vous ferait gagner " + points(weight / income).slice(1) + ".",
        });
      }

      var estimated = result.charges.filter(function (ev) { return ev.estimated || ev.insuranceMissing; }).length;
      if (estimated) {
        tips.push({
          id: "estimated",
          tone: "info",
          text: estimated > 1
            ? estimated + " montants sont estimés : le résultat est approché. Affinez-les quand vous aurez vos relevés, rien ne presse."
            : "Un montant est estimé : le résultat est approché. Affinez-le quand vous aurez vos relevés, rien ne presse.",
        });
      }

      var unknownEnds = result.charges.filter(function (ev) { return ev.endUnknown && !ev.excluded && !ev.missing; }).length;
      if (unknownEnds) {
        tips.push({
          id: "unknown-end",
          tone: "muted",
          text: (unknownEnds > 1 ? unknownEnds + " crédits n'ont pas de date de fin : ils sont comptés" : "Un crédit n'a pas de date de fin : il est compté") +
            " en entier. Ça ne change rien au taux d'aujourd'hui, mais un crédit qui se termine bientôt pourrait vous avantager.",
        });
      }

      var incomplete = result.charges.filter(function (ev) { return ev.missing; }).length +
        result.incomes.filter(function (ev) { return ev.missing; }).length;
      if (incomplete) {
        var firstMissing =
          state.incomes.find(function (it, i) { return result.incomes[i].missing; }) ||
          state.charges.find(function (it, i) { return result.charges[i].missing; });
        tips.push({
          id: "incomplete",
          tone: "warn",
          text: incomplete > 1
            ? incomplete + " lignes sans montant ne sont pas comptées."
            : "Une ligne sans montant n'est pas comptée.",
          action: { label: "La compléter", target: firstMissing.id },
        });
      }

      if (!state.charges.length) {
        tips.push({
          id: "no-charge",
          tone: "ok",
          text: "Aucun crédit en cours : toute votre marge est disponible pour le projet.",
        });
      }
      return tips;
    }

    function renderTips(tips) {
      var ul = root.querySelector("[data-tips]");
      var existing = new Map();
      Array.prototype.forEach.call(ul.children, function (li) {
        if (!li.classList.contains("is-leaving")) existing.set(li.dataset.tipId, li);
      });
      var keep = new Set();
      tips.forEach(function (tip, index) {
        keep.add(tip.id);
        var li = existing.get(tip.id);
        var isNew = !li;
        if (isNew) {
          li = document.createElement("li");
          li.dataset.tipId = tip.id;
        }
        li.className = "debt-tip debt-tip--" + tip.tone;
        var key = tip.text + (tip.action ? tip.action.label : "");
        if (li._key !== key) {
          li._key = key;
          li.textContent = "";
          var p = document.createElement("span");
          p.textContent = tip.text;
          li.appendChild(p);
          if (tip.action) {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "debt-link";
            btn.textContent = tip.action.label;
            if (tip.action.target) btn.setAttribute("data-goto", tip.action.target);
            if (tip.action.add) btn.setAttribute("data-add-type", tip.action.add);
            li.appendChild(btn);
          }
        }
        var ref = ul.children[index];
        if (ref !== li) ul.insertBefore(li, ref || null);
        if (isNew && !reduceMotion) restartAnimation(li, "is-new");
      });
      existing.forEach(function (li, id) {
        if (keep.has(id)) return;
        if (reduceMotion) {
          li.remove();
          return;
        }
        li.classList.add("is-leaving");
        setTimeout(function () { li.remove(); }, 260);
      });
    }

    /* ---------------------------- Résultat ----------------------------- */

    var GAUGE_MAX = 0.6;
    var gaugeFill = root.querySelector("[data-gauge-fill]");
    var needle = root.querySelector("[data-gauge-needle]");
    var ghost = root.querySelector("[data-gauge-ghost]");
    var gauge = root.querySelector(".debt-gauge");
    var dock = root.querySelector("[data-dock]");

    (function placeTick() {
      var share = lib.DEBT_LIMIT / GAUGE_MAX;
      var angle = Math.PI * (1 - share);
      function at(r) {
        return [100 + r * Math.cos(angle), 100 - r * Math.sin(angle)];
      }
      var outer = at(92);
      var inner = at(68);
      var label = at(104);
      var tick = root.querySelector("[data-gauge-tick]");
      tick.setAttribute("x1", outer[0]);
      tick.setAttribute("y1", outer[1]);
      tick.setAttribute("x2", inner[0]);
      tick.setAttribute("y2", inner[1]);
      var text = root.querySelector("[data-gauge-tick-label]");
      text.setAttribute("x", label[0] + 6);
      text.setAttribute("y", label[1] + 2);
      text.textContent = pct(lib.DEBT_LIMIT, 0);
      root.querySelector('[data-out="limit"]').textContent = pct(lib.DEBT_LIMIT, 0);
      var zones = {
        ok: [0, lib.DEBT_COMFORT],
        warn: [lib.DEBT_COMFORT, lib.DEBT_LIMIT],
        over: [lib.DEBT_LIMIT, GAUGE_MAX],
      };
      Object.keys(zones).forEach(function (name) {
        var z = zones[name];
        var path = root.querySelector(".debt-gauge__zone--" + name);
        var from = (z[0] / GAUGE_MAX) * 100;
        var len = ((z[1] - z[0]) / GAUGE_MAX) * 100;
        path.style.strokeDasharray = len + " 100";
        path.style.strokeDashoffset = String(-from);
      });
    })();

    function zoneOf(ratio) {
      if (ratio == null) return "none";
      if (ratio <= lib.DEBT_COMFORT) return "ok";
      if (ratio <= lib.DEBT_LIMIT) return "warn";
      return "over";
    }

    function gaugeAngle(ratio) {
      return (Math.min(Math.max(ratio, 0), GAUGE_MAX) / GAUGE_MAX) * 180 - 90;
    }

    var verdictTimer = null;
    function setVerdict(text) {
      var el = root.querySelector("[data-verdict]");
      clearTimeout(verdictTimer);
      verdictTimer = setTimeout(function () {
        if (el.textContent !== text) {
          el.textContent = text;
          if (!reduceMotion) restartAnimation(el, "is-new");
        }
      }, 250);
    }

    function renderGauge(result, fromUser) {
      var withProject = result.ratioWithProject != null;
      var ratio = withProject ? result.ratioWithProject : result.ratioCurrent;
      var zone = zoneOf(ratio);
      gauge.dataset.zone = zone;
      root.querySelector("[data-result]").dataset.zone = zone;
      root.querySelector('[data-out="caption"]').textContent = withProject
        ? "Avec votre projet"
        : "Aujourd'hui";

      var ratioEl = root.querySelector('[data-out="ratio"]');
      if (ratio == null) {
        ratioEl._value = null;
        ratioEl.textContent = "—";
        gaugeFill.style.strokeDasharray = "0 100";
        needle.style.transform = "rotate(-90deg)";
      } else {
        animateNumber(ratioEl, ratio * 100, function (v) {
          return v.toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " %";
        });
        gaugeFill.style.strokeDasharray = (Math.min(ratio, GAUGE_MAX) / GAUGE_MAX) * 100 + " 100";
        needle.style.transform = "rotate(" + gaugeAngle(ratio) + "deg)";
      }

      ghost.classList.toggle("is-visible", withProject && result.ratioCurrent != null);
      var nowEl = root.querySelector('[data-out="ratio-now"]');
      nowEl.hidden = !(withProject && result.ratioCurrent != null);
      if (!nowEl.hidden) nowEl.textContent = "┆ aujourd'hui : " + pct(result.ratioCurrent);
      if (result.ratioCurrent != null) {
        ghost.style.transform = "rotate(" + gaugeAngle(result.ratioCurrent) + "deg)";
      }

      var delta = root.querySelector("[data-delta]");
      if (fromUser && ratio != null && lastShownRatio != null && Math.abs(ratio - lastShownRatio) >= 0.0005) {
        var diff = ratio - lastShownRatio;
        delta.hidden = false;
        delta.textContent = points(diff);
        delta.dataset.dir = diff > 0 ? "up" : "down";
        if (!reduceMotion) restartAnimation(delta, "is-shown");
        clearTimeout(delta._timer);
        delta._timer = setTimeout(function () { delta.hidden = true; }, 2600);
      }
      lastShownRatio = ratio;

      var limitPct = pct(result.limit, 0);
      if (ratio == null) setVerdict("Ajoutez un revenu pour voir votre taux.");
      else if (zone === "ok") setVerdict("Confortable : vous êtes bien sous le plafond de " + limitPct + ".");
      else if (zone === "warn") setVerdict("Proche du plafond de " + limitPct + " : la marge est étroite.");
      else setVerdict("Au-dessus de " + limitPct + " : la plupart des banques refuseront en l'état.");

      dock.dataset.zone = zone;
      root.querySelector("[data-dock-ratio]").textContent = ratio == null ? "—" : pct(ratio);
      root.querySelector("[data-dock-text]").textContent =
        ratio == null
          ? "Ajoutez un revenu"
          : zone === "ok"
            ? "Confortable"
            : zone === "warn"
              ? "Proche du plafond"
              : "Au-dessus du plafond";
    }

    function renderStats(result) {
      function out(name, value, format) {
        var el = root.querySelector('[data-out="' + name + '"]');
        if (value == null) {
          el._value = null;
          el.textContent = "—";
        } else {
          animateNumber(el, value, format);
        }
      }
      var hasIncome = result.income > 0;
      out("income", hasIncome ? result.income : null, perMonth);
      out("charges", result.currentCharges, perMonth);
      root.querySelector('[data-out-row="project"]').hidden = !result.projectMonthly;
      out("project", result.projectMonthly || null, perMonth);

      var roomLabel = root.querySelector('[data-out="room-label"]');
      var roomEl = root.querySelector('[data-out="room"]');
      if (result.projectMonthly) {
        roomLabel.textContent = result.roomAfterProject >= 0 ? "Marge restante" : "Dépassement";
        out("room", hasIncome ? Math.abs(result.roomAfterProject) : null, perMonth);
        roomEl.dataset.tone = result.roomAfterProject >= 0 ? "ok" : "over";
      } else {
        roomLabel.textContent = "Mensualité possible";
        out("room", hasIncome ? result.room : null, perMonth);
        roomEl.dataset.tone = hasIncome && result.room <= 0 ? "over" : "";
      }

      out("capacity", hasIncome ? Math.round(result.capacity / 1000) * 1000 : null, euro);
      root.querySelector('[data-out="capacity-sub"]').textContent =
        "sur " + state.project.years + " ans à " + pct(state.project.rate, 2) + ", assurance comprise";
      out("rest", hasIncome ? result.restToLive : null, perMonth);
    }

    var PALETTE = ["#2e8b6b", "#e0a21f", "#2563eb", "#b45be0", "#e0541f", "#1f9bb4", "#8a6d3b"];

    function renderBudget(result) {
      var bar = root.querySelector("[data-budget-bar]");
      var legend = root.querySelector("[data-budget-legend]");
      var limitMark = root.querySelector("[data-budget-limit]");
      var segments = [];
      state.charges.forEach(function (item, i) {
        var ev = result.charges[i];
        if (ev.monthly > 0) {
          segments.push({ id: item.id, label: nameOf("charges", item), value: ev.monthly, color: PALETTE[i % PALETTE.length] });
        }
      });
      if (result.projectMonthly) {
        segments.push({ id: "project", label: "Futur crédit", value: result.projectMonthly, color: "var(--green-900)", project: true });
      }
      var total = segments.reduce(function (s, seg) { return s + seg.value; }, 0);
      var scale = Math.max(result.maxCharges, total) || 1;
      bar.classList.toggle("is-empty", !(result.income > 0));
      bar.classList.toggle("is-over", total > result.maxCharges && result.income > 0);
      limitMark.style.left = (result.income > 0 ? (result.maxCharges / scale) * 100 : 100) + "%";

      var existing = new Map();
      bar.querySelectorAll("[data-seg-id]").forEach(function (node) { existing.set(node.dataset.segId, node); });
      var offset = 0;
      segments.forEach(function (seg) {
        var node = existing.get(seg.id);
        var isNew = !node;
        if (isNew) {
          node = document.createElement("button");
          node.type = "button";
          node.className = "debt-budget__seg";
          node.dataset.segId = seg.id;
          node.style.left = (offset / scale) * 100 + "%";
          node.style.width = "0%";
          bar.appendChild(node);
        }
        existing.delete(seg.id);
        node.classList.toggle("is-project", Boolean(seg.project));
        node.style.background = seg.project ? "" : seg.color;
        node.title = seg.label + " : " + perMonth(seg.value);
        node.setAttribute("aria-label", seg.label + " : " + perMonth(seg.value) + ". Afficher la ligne.");
        node.setAttribute("data-goto", seg.id === "project" ? "debt-project" : seg.id);
        var left = (offset / scale) * 100 + "%";
        var width = (seg.value / scale) * 100 + "%";
        if (isNew && !reduceMotion) {
          void node.offsetWidth;
        }
        node.style.left = left;
        node.style.width = width;
        offset += seg.value;
      });
      existing.forEach(function (node) {
        node.style.width = "0%";
        setTimeout(function () { node.remove(); }, reduceMotion ? 0 : 400);
      });

      legend.textContent = "";
      if (!(result.income > 0)) {
        var li = document.createElement("li");
        li.className = "debt-budget__empty";
        li.textContent = "Ajoutez un revenu pour voir comment se répartit votre budget.";
        legend.appendChild(li);
        return;
      }
      segments.forEach(function (seg) {
        var item = document.createElement("li");
        var dot = document.createElement("span");
        dot.className = "debt-budget__dot" + (seg.project ? " is-project" : "");
        if (!seg.project) dot.style.background = seg.color;
        var label = document.createElement("span");
        label.className = "debt-budget__name";
        label.textContent = seg.label;
        var value = document.createElement("span");
        value.className = "debt-budget__val";
        value.textContent = pct(seg.value / result.income);
        item.append(dot, label, value);
        legend.appendChild(item);
      });
      var free = result.maxCharges - total;
      var rest = document.createElement("li");
      rest.className = "debt-budget__free";
      rest.innerHTML = '<span class="debt-budget__dot is-free"></span>';
      var restLabel = document.createElement("span");
      restLabel.className = "debt-budget__name";
      restLabel.textContent = free >= 0 ? "Encore disponible" : "Dépassement";
      var restVal = document.createElement("span");
      restVal.className = "debt-budget__val";
      restVal.textContent = perMonth(Math.abs(free));
      rest.append(restLabel, restVal);
      if (free < 0) rest.classList.add("is-over");
      legend.appendChild(rest);
    }

    function renderPrecision(result) {
      var el = root.querySelector("[data-precision]");
      var approx = result.charges.filter(function (ev) { return ev.estimated || ev.insuranceMissing; }).length;
      var missing =
        result.charges.filter(function (ev) { return ev.missing; }).length +
        result.incomes.filter(function (ev) { return ev.missing; }).length;
      if (!(result.income > 0)) {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      if (missing) {
        el.dataset.level = "low";
        el.textContent = "À compléter";
      } else if (approx) {
        el.dataset.level = "mid";
        el.textContent = "Approché";
      } else {
        el.dataset.level = "high";
        el.textContent = "Précis";
      }
    }

    function renderSections(result) {
      function setTotal(list, text) {
        var el = root.querySelector('[data-total="' + list + '"]');
        if (el.textContent !== text) {
          el.textContent = text;
          if (text && !reduceMotion) restartAnimation(el, "is-bumped");
        }
      }
      setTotal("incomes", result.income > 0 ? perMonth(result.income) : "");
      setTotal("charges", result.currentCharges > 0 ? perMonth(result.currentCharges) : "");
      root.querySelector('[data-empty="incomes"]').hidden = state.incomes.length > 0;
      root.querySelector('[data-empty="charges"]').hidden = state.charges.length > 0;
    }

    function update(options) {
      var result = lib.computeDebt(state);
      state.incomes.forEach(function (item, i) {
        var el = rows.get(item.id);
        var ev = result.incomes[i];
        if (!el) return;
        if (ev.missing) renderRowValue(el, "", "muted");
        else if (!item.counted) renderRowValue(el, "Non compté", "muted");
        else renderRowValue(el, perMonth(ev.monthly), "ok");
        renderNotes(el.querySelector("[data-notes]"), rowNotes("incomes", item, ev));
      });
      state.charges.forEach(function (item, i) {
        var el = rows.get(item.id);
        var ev = result.charges[i];
        if (!el) return;
        el.classList.toggle("is-excluded", Boolean(ev.excluded));
        if (ev.excluded) renderRowValue(el, "Non compté", "muted");
        else if (ev.missing) renderRowValue(el, "", "muted");
        else renderRowValue(el, (ev.estimated ? "≈ " : "") + perMonth(ev.monthly), ev.estimated ? "estimate" : "charge");
        renderNotes(el.querySelector("[data-notes]"), rowNotes("charges", item, ev));
      });

      renderSections(result);
      renderGauge(result, Boolean(options && options.save));
      renderStats(result);
      renderBudget(result);
      renderPrecision(result);
      renderTips(globalTips(result));
      lastResult = result;
      if (options && options.save) scheduleSave();
    }

    /* -------------------------- Enregistrement ------------------------- */

    var saveTimer = null;
    var saving = false;
    var pending = false;
    var saveStatus = root.querySelector("[data-save-status]");
    var saveText = root.querySelector("[data-save-text]");

    function setSaveState(name, text) {
      saveStatus.dataset.state = name;
      saveText.textContent = text;
    }

    function scheduleSave() {
      pending = true;
      setSaveState("pending", "Modifications en cours…");
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 700);
    }

    function save(keepalive) {
      clearTimeout(saveTimer);
      if (saving && !keepalive) {
        saveTimer = setTimeout(save, 400);
        return;
      }
      saving = true;
      pending = false;
      setSaveState("saving", "Enregistrement…");
      fetch("/endettement", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf, Accept: "application/json" },
        body: JSON.stringify({ state: state }),
        credentials: "same-origin",
        keepalive: Boolean(keepalive),
      })
        .then(function (res) {
          if (res.status === 401) throw new Error("auth");
          if (!res.ok) throw new Error("http");
          if (!pending) setSaveState("saved", "Enregistré");
        })
        .catch(function (err) {
          if (err && err.message === "auth") {
            setSaveState("error", "Session expirée : reconnectez-vous pour enregistrer");
            return;
          }
          pending = true;
          setSaveState("error", "Non enregistré, nouvel essai…");
          saveTimer = setTimeout(save, 5000);
        })
        .finally(function () {
          saving = false;
        });
    }

    window.addEventListener("pagehide", function () {
      if (pending) save(true);
    });

    /* ------------------------------ Toast ------------------------------ */

    var toast = root.querySelector("[data-toast]");
    var toastUndo = null;
    var toastTimer = null;

    toast.inert = true;

    function showToast(text, undo) {
      toast.querySelector("[data-toast-text]").textContent = text;
      toastUndo = undo;
      toast.inert = false;
      toast.classList.add("is-visible");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(hideToast, 7000);
    }
    function hideToast() {
      toast.inert = true;
      toast.classList.remove("is-visible");
      toastUndo = null;
    }
    toast.querySelector("[data-toast-undo]").addEventListener("click", function () {
      var undo = toastUndo;
      hideToast();
      if (undo) undo();
    });

    /* ------------------------------ Projet ----------------------------- */

    var projectMonthly = root.querySelector('[data-project-field="monthly"]');
    var projectRate = root.querySelector('[data-project-field="rate"]');

    function fillProject() {
      projectMonthly.value = amountInput(state.project.monthly);
      projectRate.value = rateInput(state.project.rate);
      root.querySelectorAll('[data-project-field="years"]').forEach(function (radio) {
        radio.checked = Number(radio.value) === state.project.years;
      });
    }

    function onProjectInput(input) {
      var field = input.getAttribute("data-project-field");
      if (field === "monthly") {
        state.project.monthly = parseAmount(input.value);
        if (state.project.monthly == null) state.project.source = "";
      } else if (field === "years") {
        if (!input.checked) return;
        state.project.years = Number(input.value);
      } else if (field === "rate") {
        var r = parseAmount(input.value);
        state.project.rate = r == null ? defaults.interestRate : Math.min(r, 20) / 100;
      }
      update({ save: true });
    }

    var prefill = initial.prefill;
    var banner = root.querySelector("[data-prefill-banner]");
    if (prefill && prefill.monthly) {
      var previous = { monthly: state.project.monthly, source: state.project.source };
      var changed = state.project.monthly !== prefill.monthly;
      state.project.monthly = prefill.monthly;
      state.project.source = prefill.source;
      banner.querySelector("[data-prefill-text]").textContent =
        "Mensualité reprise de « " + (prefill.source || "l'annonce") + " » : " + perMonth(prefill.monthly) + ".";
      banner.hidden = false;
      banner.querySelector("[data-prefill-undo]").addEventListener("click", function () {
        state.project.monthly = previous.monthly;
        state.project.source = previous.source;
        fillProject();
        banner.classList.add("is-leaving");
        setTimeout(function () { banner.hidden = true; }, reduceMotion ? 0 : 250);
        update({ save: true });
      });
      if (changed) scheduleSave();
      if (window.history.replaceState) window.history.replaceState(null, "", "/endettement");
    }

    /* ----------------------------- Événements -------------------------- */

    root.addEventListener("input", function (event) {
      var t = event.target;
      if (t.matches("[data-field]") && t.type !== "radio" && t.type !== "checkbox") onRowInput(t);
      else if (t.matches("[data-project-field]") && t.type !== "radio") onProjectInput(t);
    });

    root.addEventListener("change", function (event) {
      var t = event.target;
      if (t.matches("[data-field]") && (t.type === "radio" || t.type === "checkbox" || t.type === "hidden")) onRowInput(t);
      else if (t.matches("[data-project-field]") && t.type === "radio") onProjectInput(t);
    });

    root.addEventListener("focusout", function (event) {
      var t = event.target;
      if (t.matches('[data-project-field="rate"]')) projectRate.value = rateInput(state.project.rate);
    });

    root.addEventListener("click", function (event) {
      var t = event.target;
      var add = t.closest("[data-add]");
      if (add) {
        addItem(add.getAttribute("data-add"), add.getAttribute("data-type"));
        return;
      }
      var addType = t.closest("[data-add-type]");
      if (addType) {
        addItem("incomes", addType.getAttribute("data-add-type"));
        return;
      }
      var remove = t.closest("[data-remove]");
      if (remove) {
        removeItem(remove.closest("[data-row]").dataset.id);
        return;
      }
      var goto = t.closest("[data-goto]");
      if (goto) {
        var id = goto.getAttribute("data-goto");
        pulse(rows.get(id) || document.getElementById(id));
        var focusable = (rows.get(id) || document.getElementById(id) || document).querySelector(
          ".debt-reveal.is-open input[data-amount], .debt-row__body input[data-amount], input[data-amount]"
        );
        if (focusable && !focusable.value) setTimeout(function () { focusable.focus({ preventScroll: true }); }, 350);
        return;
      }
      var setMode = t.closest("[data-set-mode]");
      if (setMode) {
        var row = setMode.closest("[data-row]");
        var radio = row.querySelector('[data-field="mode"][value="' + setMode.getAttribute("data-set-mode") + '"]');
        if (radio) {
          radio.checked = true;
          radio.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return;
      }
      var endUnknown = t.closest("[data-end-unknown]");
      if (endUnknown) {
        clearDebtDayPicker(endUnknown.closest(".debt-end").querySelector("[data-debt-day-picker]"));
        return;
      }
      if (t.closest("[data-dock]")) {
        root.querySelector("[data-result]").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      }
    });

    /* Le résumé mobile n'apparaît que lorsque le résultat est hors de l'écran. */
    if ("IntersectionObserver" in window) {
      var observer = new IntersectionObserver(function (entries) {
        var visible = entries[0].isIntersecting;
        dock.classList.toggle("is-visible", !visible);
      }, { threshold: 0.15 });
      observer.observe(root.querySelector("[data-result]"));
    }

    /* ------------------------------ Démarrage -------------------------- */

    function renderAllRows(animate) {
      ["incomes", "charges"].forEach(function (list) {
        state[list].forEach(function (item, index) {
          insertRow(list, item, index, { animate: animate });
        });
      });
    }

    renderAllRows(false);
    fillProject();
    update();
    lastShownRatio = lastResult && (lastResult.ratioWithProject != null ? lastResult.ratioWithProject : lastResult.ratioCurrent);

    if (!state.incomes.length) {
      var fine = window.matchMedia("(pointer: fine)").matches;
      state.incomes.push({ id: newId(), type: "salary", label: "", amount: null, frequency: "month", counted: true });
      insertRow("incomes", state.incomes[0], 0, { animate: true, focus: fine });
      update();
    }
    requestAnimationFrame(function () {
      root.classList.add("is-ready");
    });
  }
})();
