/*
 * Page « Préparer la visite ».
 *
 * La structure (étapes, cartes, bilan) est rendue par le serveur ; ce script
 * pose les contrôles de réponse dans chaque carte, tient le bilan à jour à
 * chaque geste (anneau, verdict, levier de négociation, coûts, travaux,
 * alertes, points à demander, corrections) et enregistre en continu.
 *
 * Pensé pour le téléphone pendant une visite : gros OUI / NON, clavier
 * numérique pour les chiffres, « conseil du pro » dépliable, filtre par thème,
 * résumé flottant quand le bilan sort de l'écran.
 *
 * Le moteur de bilan (/public/js/visit-insights.js) est partagé avec le
 * serveur : mêmes règles, mêmes chiffres.
 */
(function () {
  "use strict";

  var root = document.querySelector("[data-visit]");
  if (!root) return;

  var initialNode = document.getElementById("visit-initial");
  if (!initialNode) return;

  import("/public/js/visit-insights.js").then(function (lib) {
    start(lib);
  });

  /** Glisser horizontalement la rangée de filtres (souris / stylet ; le tactile garde le scroll natif). */
  function bindFilterStripDragScroll(el) {
    var DRAG_THRESHOLD = 6;
    var active = false;
    var moved = false;
    var startX = 0;
    var scrollStart = 0;
    var pointerId = null;

    el.addEventListener(
      "click",
      function (e) {
        if (el.getAttribute("data-drag-suppress") === "1") {
          e.preventDefault();
          e.stopPropagation();
          el.removeAttribute("data-drag-suppress");
        }
      },
      true,
    );

    el.addEventListener("pointerdown", function (e) {
      if (e.button !== 0 || e.pointerType === "touch") return;
      active = true;
      moved = false;
      startX = e.clientX;
      scrollStart = el.scrollLeft;
      pointerId = e.pointerId;
      try {
        el.setPointerCapture(pointerId);
      } catch (_err) {
        /* capture optionnelle */
      }
    });

    el.addEventListener("pointermove", function (e) {
      if (!active || e.pointerId !== pointerId) return;
      var dx = e.clientX - startX;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD) return;
      if (!moved) {
        moved = true;
        el.classList.add("is-dragging");
      }
      el.scrollLeft = scrollStart - dx;
    });

    function endPointer(e) {
      if (!active || e.pointerId !== pointerId) return;
      active = false;
      el.classList.remove("is-dragging");
      if (moved) el.setAttribute("data-drag-suppress", "1");
      moved = false;
      pointerId = null;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch (_err) {
        /* ignore */
      }
    }

    el.addEventListener("pointerup", endPointer);
    el.addEventListener("pointercancel", endPointer);
  }

  function start(lib) {
    var initial = JSON.parse(initialNode.textContent);
    var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || "";
    var saveUrl = root.getAttribute("data-visit-url");
    var reduceMotion =
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    var items = initial.items || [];
    var byId = {};
    items.forEach(function (it) {
      byId[it.id] = it;
    });

    var listingPrice =
      initial.listing && initial.listing.price != null ? Number(initial.listing.price) : null;
    if (!Number.isFinite(listingPrice)) listingPrice = null;

    var validationCtx = { listingPrice: listingPrice };

    var state = {
      answers: initial.answers || {},
      applyToSheet: typeof initial.applyToSheet === "boolean" ? initial.applyToSheet : null,
      filter: "all",
      hideAnswered: false,
    };

    var cards = {};
    root.querySelectorAll("[data-q]").forEach(function (li) {
      cards[li.getAttribute("data-q")] = li;
    });
    var sections = Array.prototype.slice.call(root.querySelectorAll("section[data-section]"));

    /* ----------------------------- Formats ----------------------------- */

    var euroFmt = new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: "EUR",
      maximumFractionDigits: 0,
    });
    var numFmt = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });
    var intFmt = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });

    function euro(n) {
      return euroFmt.format(Math.round(Number(n) || 0));
    }
    function num(n) {
      return numFmt.format(Number(n) || 0);
    }
    function withUnit(value, unit) {
      if (value === null || value === undefined || value === "") return "—";
      var v = typeof value === "number" ? num(value) : String(value);
      return unit ? v + " " + unit : v;
    }
    function parseNumber(text) {
      if (text === null || text === undefined) return null;
      var s = String(text).replace(/\s/g, "").replace(",", ".");
      if (!s) return null;
      var n = Number(s);
      return Number.isFinite(n) ? n : null;
    }
    function numericValidationMessage(inputMeta, value, ctx) {
      if (value === null || value === undefined || value === "" || !inputMeta || !inputMeta.validate) {
        return null;
      }
      var v = Number(value);
      if (!Number.isFinite(v)) return null;
      var rules = inputMeta.validate;
      var context = ctx || validationCtx;
      if (rules.min != null && v < rules.min) return rules.minMessage || "Valeur trop basse.";
      var max = rules.max === "currentYear" ? new Date().getFullYear() : rules.max;
      if (max != null && v > max) return rules.maxMessage || "Valeur trop élevée.";
      if (rules.maxExclusive != null) {
        var cap =
          rules.maxExclusive === "listingPrice"
            ? context.listingPrice
            : rules.maxExclusive === "currentYear"
              ? new Date().getFullYear()
              : rules.maxExclusive;
        if (cap != null && Number.isFinite(Number(cap)) && v >= Number(cap)) {
          return rules.maxExclusiveMessage || "Valeur trop élevée.";
        }
      }
      return null;
    }

    function numericValueForValidation(item, answer) {
      if (!answer || answer.response === "unknown") return null;
      if (
        item.input &&
        (item.input.type === "confirm_number" || item.input.type === "confirm_yesno") &&
        answer.response === "yes" &&
        item.known
      ) {
        return item.value != null ? Number(item.value) : null;
      }
      if (answer.response === "yes") return answer.value != null ? Number(answer.value) : null;
      return parseNumber(answer.value);
    }

    function applyNumericFieldValidation(item, answer, inputEl, errorEl, card) {
      if (!item.input || !item.input.validate) return;
      var msg = numericValidationMessage(item.input, numericValueForValidation(item, answer), validationCtx);
      var confirmedKnown =
        (item.input.type === "confirm_number" || item.input.type === "confirm_yesno") &&
        item.known &&
        answer &&
        answer.response === "yes";
      if (inputEl) {
        inputEl.classList.toggle("visit-input--danger", Boolean(msg) && !confirmedKnown);
      }
      if (errorEl) {
        errorEl.hidden = !msg || confirmedKnown;
        errorEl.textContent = msg && !confirmedKnown ? msg : "";
      }
      var cardEl = card && card.querySelector(".visit-q__card");
      if (cardEl) cardEl.classList.toggle("visit-q__card--danger", Boolean(msg) && confirmedKnown);
    }

    function attachNumericFieldValidation(fieldWrap, item) {
      if (!item.input || !item.input.validate) {
        return { root: fieldWrap, error: null, input: fieldWrap.querySelector(".input") };
      }
      var errorEl = el("p", "field-error");
      errorEl.hidden = true;
      var delta = fieldWrap.querySelector(".visit-num__delta");
      fieldWrap.insertBefore(errorEl, delta);
      return { root: fieldWrap, error: errorEl, input: fieldWrap.querySelector(".input") };
    }

    function shouldGroupThousands(inputMeta) {
      if (!inputMeta || inputMeta.groupThousands === false) return false;
      if (inputMeta.type === "yesno_number") return true;
      if (Number(inputMeta.decimals) > 0) return false;
      return true;
    }

    function numberInputValue(value, decimals, inputMeta) {
      if (value === null || value === undefined || value === "") return "";
      var n = Number(value);
      if (!Number.isFinite(n)) return "";
      if (!decimals) {
        var rounded = Math.round(n);
        if (inputMeta && !shouldGroupThousands(inputMeta)) return String(rounded);
        return intFmt.format(rounded);
      }
      var maxDec = typeof decimals === "number" ? decimals : 2;
      return new Intl.NumberFormat("fr-FR", {
        minimumFractionDigits: 0,
        maximumFractionDigits: maxDec,
      }).format(n);
    }

    /** Ne garde que chiffres (et séparateurs autorisés) — affichage clavier numérique sur mobile. */
    function sanitizeNumericText(raw, decimals) {
      var s = String(raw);
      if (decimals) {
        s = s.replace(/[^\d\s,.]/g, "");
        var sep = s.search(/[,.]/);
        if (sep !== -1) {
          var head = s.slice(0, sep + 1);
          var tail = s.slice(sep + 1).replace(/[,.]/g, "");
          s = head + tail;
        }
        return s;
      }
      return s.replace(/[^\d\s]/g, "");
    }

    /** Milliers en direct pendant la saisie (même logique que les montants du financement). */
    function formatIntegerField(input) {
      var caret = input.selectionStart;
      var digitsBefore =
        caret == null ? null : input.value.slice(0, caret).replace(/\D/g, "").length;
      var digits = input.value.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
      var formatted = digits ? intFmt.format(Number(digits)) : "";
      if (input.value === formatted) return;
      input.value = formatted;
      if (caret == null || typeof input.setSelectionRange !== "function") return;
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

    function isIntegerNumericInput(inputMeta) {
      if (!inputMeta) return true;
      if (inputMeta.type === "yesno_number") return true;
      return Number(inputMeta.decimals) <= 0;
    }

    function scheduleIntegerFormat(input) {
      queueMicrotask(function () {
        if (document.activeElement === input) formatIntegerField(input);
      });
    }

    function bindNumericInput(input, inputMeta) {
      var allowDecimals = !isIntegerNumericInput(inputMeta);
      input.setAttribute("autocapitalize", "off");
      input.setAttribute("autocorrect", "off");
      input.setAttribute("spellcheck", "false");
      var groupThousands = shouldGroupThousands(inputMeta);
      if (!allowDecimals) {
        input.setAttribute("pattern", groupThousands ? "[0-9\\s]*" : "[0-9]*");
        if (groupThousands) input.setAttribute("data-amount", "");
      }
      input.addEventListener("input", function () {
        var cleaned = sanitizeNumericText(input.value, allowDecimals);
        if (cleaned !== input.value) input.value = cleaned;
        if (groupThousands) scheduleIntegerFormat(input);
      });
      input.addEventListener("paste", function (e) {
        e.preventDefault();
        var text = (e.clipboardData || window.clipboardData).getData("text");
        var cleaned = sanitizeNumericText(text, allowDecimals);
        if (!cleaned) return;
        var start = input.selectionStart != null ? input.selectionStart : input.value.length;
        var end = input.selectionEnd != null ? input.selectionEnd : start;
        input.value = input.value.slice(0, start) + cleaned + input.value.slice(end);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }

    var FIELD_LABELS = {
      surface: "Surface",
      land_surface: "Terrain",
      rooms: "Pièces",
      bedrooms: "Chambres",
      floor: "Étage",
      year_built: "Année",
      dpe: "DPE",
      ges: "GES",
      charges_copro: "Charges copro",
      taxe_fonciere: "Taxe foncière",
      heating_system: "Chauffage",
      property_condition: "État",
      energy_source: "Énergie",
      price: "Prix",
    };

    function icon(name) {
      return '<svg class="wi" aria-hidden="true"><use href="#wi-' + name + '"></use></svg>';
    }

    function el(tag, className, html) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      if (html !== undefined) node.innerHTML = html;
      return node;
    }

    function restart(node, className) {
      if (!node) return;
      node.classList.remove(className);
      void node.offsetWidth;
      node.classList.add(className);
    }

    function bumpText(node, text) {
      if (!node) return;
      if (node.textContent !== text) {
        node.textContent = text;
        if (!reduceMotion) restart(node, "is-bumped");
      }
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

    /* ---------------------------- Contrôles ---------------------------- */

    function segControl(name, options, extraClass) {
      var seg = el("div", "visit-seg " + (extraClass || ""));
      seg.setAttribute("role", "radiogroup");
      options.forEach(function (opt) {
        var label = el("label", "visit-seg__opt");
        var input = document.createElement("input");
        input.type = "radio";
        input.name = name;
        input.value = opt.value;
        var span = el("span", null, opt.label);
        label.appendChild(input);
        label.appendChild(span);
        seg.appendChild(label);
      });
      seg.appendChild(el("span", "visit-seg__thumb"));
      return seg;
    }

    function setSeg(seg, value) {
      seg.querySelectorAll("input").forEach(function (input) {
        input.checked = value !== null && value !== undefined && input.value === String(value);
      });
    }

    /** Oui / Non : un second clic sur l'option déjà choisie efface la réponse. */
    function bindSegDeselect(seg, onPick) {
      seg.querySelectorAll(".visit-seg__opt").forEach(function (label) {
        var input = label.querySelector("input");
        if (!input) return;
        label.addEventListener("pointerdown", function () {
          input._visitWasChecked = input.checked;
        });
        label.addEventListener("click", function (e) {
          if (input._visitWasChecked) {
            e.preventDefault();
            setSeg(seg, null);
            onPick(null);
            return;
          }
          onPick(input.value);
        });
      });
    }

    function numberField(item, opts) {
      var wrap = el("div", "visit-field");
      if (opts && opts.label) wrap.appendChild(el("span", "visit-field__label", opts.label));
      var box = el("div", "visit-num");
      var input = document.createElement("input");
      input.type = "text";
      input.className = "input";
      input.autocomplete = "off";
      var allowDecimals = !isIntegerNumericInput(item.input);
      input.inputMode = allowDecimals ? "decimal" : "numeric";
      input.placeholder = item.input.placeholder || (item.known && item.value != null ? String(item.value) : "–");
      input.setAttribute("aria-label", (opts && opts.label) || item.question);
      bindNumericInput(input, item.input);
      box.appendChild(input);
      if (item.unit) box.appendChild(el("span", "visit-num__unit", item.unit));
      wrap.appendChild(box);
      var delta = el("p", "visit-num__delta");
      delta.hidden = true;
      wrap.appendChild(delta);
      return { wrap: wrap, input: input, delta: delta };
    }

    function updateDelta(item, field, value) {
      if (!item.known || value === null || item.value === null) {
        field.delta.hidden = true;
        return;
      }
      var known = Number(item.value);
      if (!Number.isFinite(known) || known === 0) {
        field.delta.hidden = true;
        return;
      }
      var diff = value - known;
      if (Math.abs(diff) < 0.001) {
        field.delta.textContent = "Identique à l'annonce";
        field.delta.removeAttribute("data-dir");
      } else {
        var pct = Math.round((Math.abs(diff) / known) * 100);
        field.delta.textContent =
          (diff < 0 ? "−" : "+") + withUnit(Math.abs(diff), item.unit) + " par rapport à l'annonce (" + pct + " %)";
        field.delta.setAttribute("data-dir", diff < 0 ? "down" : "up");
      }
      field.delta.hidden = false;
    }

    function renderControl(item, card) {
      var host = card.querySelector("[data-control]");
      var type = item.input && item.input.type;
      var answer = state.answers[item.id] || null;
      host.textContent = "";

      if (type === "yesno") {
        var yesnoOpts = [
          { value: "yes", label: "Oui" },
          { value: "no", label: "Non" },
        ];
        if (item.input.unknownOption) {
          yesnoOpts.push({
            value: "unknown",
            label: item.input.unknownLabel || "Je ne sais pas",
          });
        }
        var seg = segControl("q-" + item.id, yesnoOpts, "visit-seg--yesno");
        function yesnoSegValue(a) {
          if (!a) return null;
          if (a.response === "unknown") return item.input.unknownOption ? "unknown" : null;
          return a.response;
        }
        setSeg(seg, yesnoSegValue(answer));
        bindSegDeselect(seg, function (value) {
          if (value === null) setAnswer(item.id, null);
          else setAnswer(item.id, { response: value, value: null });
        });
        host.appendChild(seg);
        card._sync = function () {
          setSeg(seg, yesnoSegValue(state.answers[item.id]));
        };
        return;
      }

      if (type === "yesno_number") {
        var ynSeg = segControl(
          "q-" + item.id,
          [
            { value: "yes", label: "Oui" },
            { value: "no", label: "Non" },
          ],
          "visit-seg--yesno"
        );
        var ynReveal = el("div", "visit-reveal");
        var ynInner = el("div", "visit-reveal__inner");
        var ynField = numberField(item, { label: item.input.detailLabel || "Montant" });
        attachNumericFieldValidation(ynField.wrap, item);
        var ynValidationInput = ynField.input;
        var ynValidationErr = ynField.wrap.querySelector(".field-error");
        ynInner.appendChild(ynField.wrap);
        ynReveal.appendChild(ynInner);
        host.appendChild(ynSeg);
        host.appendChild(ynReveal);

        function refreshYnValidation(answer) {
          applyNumericFieldValidation(item, answer || null, ynValidationInput, ynValidationErr, card);
        }

        function pickYesNo(value) {
          if (value === null) {
            setAnswer(item.id, null);
            return;
          }
          if (value === "no") {
            setReveal(ynReveal, false, card._ready);
            setAnswer(item.id, { response: "no", value: null });
            refreshYnValidation({ response: "no", value: null });
            return;
          }
          setReveal(ynReveal, true, card._ready);
          var a = state.answers[item.id];
          var existing = a && a.response === "yes" ? a.value : null;
          var draft = { response: "yes", value: existing };
          refreshYnValidation(draft);
          setAnswer(item.id, draft, { silentIfEmpty: true });
          setTimeout(function () {
            ynField.input.focus({ preventScroll: true });
          }, card._ready ? 0 : 320);
        }

        setSeg(ynSeg, answer && answer.response !== "unknown" ? answer.response : null);
        bindSegDeselect(ynSeg, pickYesNo);

        ynField.input.addEventListener("input", function () {
          var v = parseNumber(ynField.input.value);
          var draft = { response: "yes", value: v };
          refreshYnValidation(draft);
          setAnswer(item.id, draft, { silentIfEmpty: true });
          if (shouldGroupThousands(item.input)) scheduleIntegerFormat(ynField.input);
        });
        ynField.input.addEventListener("blur", function () {
          var v = parseNumber(ynField.input.value);
          ynField.input.value = numberInputValue(v, item.input.decimals, item.input);
        });

        card._sync = function () {
          var a = state.answers[item.id];
          var r = a && a.response !== "unknown" ? a.response : null;
          setSeg(ynSeg, r);
          setReveal(ynReveal, r === "yes", card._ready);
          if (r === "yes" && document.activeElement !== ynField.input) {
            ynField.input.value = numberInputValue(a && a.value != null ? a.value : null, item.input.decimals, item.input);
          }
          refreshYnValidation(a || null);
        };
        card._sync();
        return;
      }

      if (type === "confirm_number" || type === "confirm_yesno" || type === "number") {
        var field = numberField(item, null);
        var reveal = null;
        var confirmSeg = null;
        var wrapped = attachNumericFieldValidation(field.wrap, item);
        var validationErr = wrapped.error;
        var validationInput = wrapped.input;
        var confirmValidationErr = null;
        var showConfirmSeg =
          type === "confirm_yesno" || (type === "confirm_number" && item.known);
        if (showConfirmSeg) {
          confirmSeg = segControl(
            "q-" + item.id,
            type === "confirm_yesno"
              ? [
                  { value: "yes", label: "Oui" },
                  { value: "no", label: "Non" },
                ]
              : [
                  { value: "yes", label: "C'est exact" },
                  { value: "no", label: "À corriger" },
                ],
            type === "confirm_yesno" ? "visit-seg--yesno" : "visit-seg--confirm"
          );
          host.appendChild(confirmSeg);
          if (item.input.validate) {
            confirmValidationErr = el("p", "field-error");
            confirmValidationErr.hidden = true;
            host.appendChild(confirmValidationErr);
          }
          reveal = el("div", "visit-reveal");
          var inner = el("div", "visit-reveal__inner");
          field.wrap.querySelector(".visit-num").insertAdjacentElement(
            "beforebegin",
            el(
              "span",
              "visit-field__label",
              type === "confirm_yesno"
                ? item.field === "bedrooms"
                  ? "Nombre de chambres constaté"
                  : "Nombre de pièces constaté"
                : "Valeur relevée sur place"
            )
          );
          inner.appendChild(field.wrap);
          reveal.appendChild(inner);
          host.appendChild(reveal);

          function pickConfirm(value) {
            if (value === null) {
              setAnswer(item.id, null);
              return;
            }
            if (value === "yes") {
              setReveal(reveal, false, card._ready);
              setAnswer(item.id, {
                response: "yes",
                value: item.known ? item.value : null,
              });
              return;
            }
            setReveal(reveal, true, card._ready);
            var current = parseNumber(field.input.value);
            setAnswer(item.id, { response: "no", value: current }, { silentIfEmpty: true });
            setTimeout(function () {
              field.input.focus({ preventScroll: true });
            }, card._ready ? 0 : 320);
          }

          if (type === "confirm_yesno") {
            bindSegDeselect(confirmSeg, pickConfirm);
          } else {
            confirmSeg.addEventListener("change", function (e) {
              pickConfirm(e.target.value);
            });
          }
        } else {
          host.appendChild(field.wrap);
        }

        function refreshValidation(answer) {
          applyNumericFieldValidation(item, answer || null, validationInput, validationErr, card);
          if (confirmValidationErr) {
            var msg = numericValidationMessage(item.input, numericValueForValidation(item, answer), validationCtx);
            var confirmed = answer && answer.response === "yes";
            confirmValidationErr.hidden = !(msg && confirmed);
            confirmValidationErr.textContent = msg && confirmed ? msg : "";
          }
        }

        field.input.addEventListener("input", function () {
          var v = parseNumber(field.input.value);
          updateDelta(item, field, v);
          var draft = {
            response: type === "confirm_number" || type === "confirm_yesno" ? "no" : null,
            value: v,
          };
          refreshValidation(draft);
          setAnswer(
            item.id,
            draft,
            type === "confirm_number" || type === "confirm_yesno" ? { silentIfEmpty: true } : undefined
          );
          if (shouldGroupThousands(item.input)) scheduleIntegerFormat(field.input);
        });
        field.input.addEventListener("blur", function () {
          var v = parseNumber(field.input.value);
          field.input.value = numberInputValue(v, item.input.decimals, item.input);
        });

        card._sync = function () {
          var a = state.answers[item.id];
          var r = a && a.response !== "unknown" ? a.response : null;
          if (confirmSeg) {
            setSeg(confirmSeg, r);
            setReveal(reveal, r === "no", card._ready);
          }
          var v = a && r !== "yes" ? a.value : null;
          if (document.activeElement !== field.input) {
            field.input.value = numberInputValue(v, item.input.decimals, item.input);
          }
          updateDelta(item, field, v);
          refreshValidation(a || null);
        };
        card._sync();
        return;
      }

      if (type === "confirm_letter") {
        var letters = el("div", "visit-letters");
        letters.setAttribute("role", "group");
        var knownLetter = item.known ? String(item.value).toUpperCase() : null;
        (item.input.options || ["A", "B", "C", "D", "E", "F", "G"]).forEach(function (letter) {
          var b = el("button", "visit-letter", letter);
          b.type = "button";
          b.setAttribute("data-letter", letter);
          if (letter === knownLetter) {
            b.classList.add("is-known");
            b.title = "Valeur de l'annonce";
          }
          b.addEventListener("click", function () {
            var a = state.answers[item.id];
            var current = a && a.response !== "unknown" ? a.value : null;
            if (current === letter) {
              setAnswer(item.id, null);
              return;
            }
            setAnswer(item.id, { response: letter === knownLetter ? "yes" : "no", value: letter });
          });
          letters.appendChild(b);
        });
        host.appendChild(letters);
        card._sync = function () {
          var a = state.answers[item.id];
          var current = a && a.response !== "unknown" ? a.value : null;
          letters.querySelectorAll(".visit-letter").forEach(function (b) {
            var on = b.getAttribute("data-letter") === current;
            b.classList.toggle("is-selected", on);
            b.setAttribute("aria-pressed", on ? "true" : "false");
          });
        };
        card._sync();
        return;
      }

      if (type === "count_pair") {
        var rows = item.input.rows || [];
        var pairWrap = el("div", "visit-count-pair");
        var inputsByKey = {};

        function defaultPairValue() {
          var o = {};
          rows.forEach(function (row) {
            o[row.key] = 0;
          });
          return o;
        }

        function readPairValue(a) {
          if (!a || a.response === "unknown" || !a.value || typeof a.value !== "object") {
            return null;
          }
          var o = {};
          var ok = true;
          rows.forEach(function (row) {
            var n = parseNumber(a.value[row.key]);
            if (n === null || n < 0) ok = false;
            else o[row.key] = n;
          });
          return ok ? o : null;
        }

        function emitPairValue() {
          var o = {};
          rows.forEach(function (row) {
            o[row.key] = parseNumber(inputsByKey[row.key].value);
            if (o[row.key] === null || o[row.key] < 0) o[row.key] = 0;
          });
          setAnswer(item.id, { response: null, value: o });
        }

        rows.forEach(function (row) {
          var block = el("div", "visit-field visit-count-pair__row");
          block.appendChild(el("span", "visit-field__label", row.label));
          var numBox = el("div", "visit-num visit-num--compact");
          var input = document.createElement("input");
          input.type = "text";
          input.className = "input";
          input.autocomplete = "off";
          input.inputMode = "numeric";
          input.placeholder = "0";
          input.setAttribute("aria-label", row.label);
          bindNumericInput(input, item.input);
          numBox.appendChild(input);
          block.appendChild(numBox);
          pairWrap.appendChild(block);
          inputsByKey[row.key] = input;
          input.addEventListener("input", function () {
            emitPairValue();
          });
          input.addEventListener("blur", function () {
            var v = parseNumber(input.value);
            input.value = v === null ? "" : numberInputValue(v, 0, item.input);
          });
        });

        host.appendChild(pairWrap);
        card._sync = function () {
          var a = state.answers[item.id];
          var pair = readPairValue(a);
          rows.forEach(function (row) {
            var input = inputsByKey[row.key];
            if (document.activeElement === input) return;
            var n = pair ? pair[row.key] : null;
            input.value = n === null ? "" : numberInputValue(n, 0, item.input);
          });
        };
        card._sync();
        return;
      }

      if (type === "choice") {
        var options = item.input.options || [];
        var presetValues = options.filter(function (o) { return !o.other; }).map(function (o) { return o.value; });
        var otherOpt = options.find(function (o) { return o.other; }) || null;
        var choices = el("div", "visit-choices" + (item.input.layout === "list" ? " visit-choices--list" : ""));
        choices.setAttribute("role", "group");
        var otherReveal = null;
        var otherInput = null;
        var knownLabel = item.known && item.value != null ? String(item.value).toLowerCase() : null;

        function isOtherAnswer(a) {
          if (!a || a.response === "unknown") return false;
          if (a.response === "other") return true;
          if (a.value === null || a.value === undefined || a.value === "") return false;
          return presetValues.indexOf(String(a.value)) === -1;
        }

        function pickChoice(opt) {
          var a = state.answers[item.id];
          if (opt.other) {
            if (isOtherAnswer(a)) {
              setAnswer(item.id, null);
              return;
            }
            setAnswer(item.id, { response: "other", value: null }, { silentIfEmpty: true });
            setReveal(otherReveal, true, card._ready);
            setTimeout(function () {
              if (otherInput) otherInput.focus({ preventScroll: true });
            }, card._ready ? 0 : 320);
            return;
          }
          if (a && a.response !== "unknown" && a.value === opt.value && a.response !== "other") {
            setAnswer(item.id, null);
            return;
          }
          setReveal(otherReveal, false, card._ready);
          setAnswer(item.id, { response: null, value: opt.value });
        }

        options.forEach(function (opt) {
          var b = el("button", "visit-choice", opt.label);
          b.type = "button";
          b.setAttribute("data-value", opt.value);
          if (opt.other) b.setAttribute("data-choice-other", "true");
          if (knownLabel && (opt.label.toLowerCase() === knownLabel || opt.value === knownLabel)) {
            b.classList.add("is-known");
            b.title = "Valeur de l'annonce";
          }
          b.addEventListener("click", function () {
            pickChoice(opt);
          });
          choices.appendChild(b);
        });

        if (otherOpt) {
          otherReveal = el("div", "visit-reveal visit-choice-other");
          var otherInner = el("div", "visit-reveal__inner");
          var otherField = el("div", "visit-field");
          otherField.appendChild(el("span", "visit-field__label", "Précisez"));
          otherInput = document.createElement("input");
          otherInput.type = "text";
          otherInput.className = "input";
          otherInput.autocomplete = "off";
          otherInput.placeholder = item.input.otherPlaceholder || "Autre raison…";
          otherInput.setAttribute("aria-label", item.question + " — précision");
          otherField.appendChild(otherInput);
          otherInner.appendChild(otherField);
          otherReveal.appendChild(otherInner);
          otherInput.addEventListener("input", function () {
            var text = otherInput.value.trim();
            setAnswer(item.id, { response: "other", value: text || null }, { silentIfEmpty: true });
          });
          otherInput.addEventListener("blur", function () {
            otherInput.value = otherInput.value.trim();
          });
        }

        host.appendChild(choices);
        if (otherReveal) host.appendChild(otherReveal);

        card._sync = function () {
          var a = state.answers[item.id];
          var other = isOtherAnswer(a);
          var current = a && a.response !== "unknown" && !other ? a.value : null;
          choices.querySelectorAll(".visit-choice").forEach(function (b) {
            var val = b.getAttribute("data-value");
            var on = b.hasAttribute("data-choice-other") ? other : val === current;
            b.classList.toggle("is-selected", on);
            b.setAttribute("aria-pressed", on ? "true" : "false");
          });
          if (otherReveal) {
            setReveal(otherReveal, other, card._ready);
            if (otherInput && document.activeElement !== otherInput) {
              otherInput.value = other && a.value != null ? String(a.value) : "";
            }
          }
        };
        card._sync();
        return;
      }

      if (type === "scale") {
        var scale = el("div", "visit-scale");
        scale.setAttribute("role", "group");
        var min = item.input.min || 1;
        var max = item.input.max || 5;
        var labels = item.input.labels || [];
        for (var n = min; n <= max; n += 1) {
          (function (value, i) {
            var b = el("button", "visit-scale__opt", icon("star") + (labels[i] ? "<small>" + labels[i] + "</small>" : ""));
            b.type = "button";
            b.setAttribute("data-value", String(value));
            b.setAttribute("aria-label", labels[i] ? value + " · " + labels[i] : String(value));
            b.addEventListener("click", function () {
              var a = state.answers[item.id];
              if (a && a.value === value && a.response !== "unknown") {
                setAnswer(item.id, null);
                return;
              }
              setAnswer(item.id, { response: null, value: value });
            });
            scale.appendChild(b);
          })(n, n - min);
        }
        host.appendChild(scale);
        card._sync = function () {
          var a = state.answers[item.id];
          var current = a && a.response !== "unknown" ? Number(a.value) : null;
          scale.querySelectorAll(".visit-scale__opt").forEach(function (b) {
            var v = Number(b.getAttribute("data-value"));
            b.classList.toggle("is-selected", current === v);
            b.classList.toggle("is-lit", current !== null && v <= current);
            b.setAttribute("aria-pressed", current === v ? "true" : "false");
          });
        };
        card._sync();
        return;
      }

      /* texte libre */
      var ta = document.createElement("textarea");
      ta.className = "visit-text";
      ta.rows = 2;
      ta.maxLength = 600;
      ta.placeholder = item.input.placeholder || "Vos notes…";
      ta.setAttribute("aria-label", item.question);
      var textTimer = null;
      ta.addEventListener("input", function () {
        clearTimeout(textTimer);
        textTimer = setTimeout(function () {
          var v = ta.value.trim();
          setAnswer(item.id, v ? { response: null, value: v } : null);
        }, 350);
      });
      host.appendChild(ta);
      card._sync = function () {
        var a = state.answers[item.id];
        var v = a && a.response !== "unknown" && typeof a.value === "string" ? a.value : "";
        if (document.activeElement !== ta) ta.value = v;
      };
      card._sync();
    }

    /* ------------------------------ Cartes ------------------------------ */

    function cardState(item, answer) {
      if (lib.isUnknown(answer)) return "unknown";
      if (lib.isAnswered(item, answer)) return "answered";
      return "idle";
    }

    function renderNote(item, card, animate) {
      var notes = card.querySelector("[data-notes]");
      var answer = state.answers[item.id] || null;
      var note = lib.noteFor(item, answer);
      var key = note ? note.tone + "|" + note.text : "";
      if (card._noteKey === key) return;
      card._noteKey = key;
      notes.textContent = "";
      if (!note) return;
      var li = el("div", "visit-note visit-note--" + (note.tone || "info"));
      li.textContent = note.text;
      if (Array.isArray(note.cost) && note.cost.length === 2) {
        var cost = el("span", "visit-note__cost", "Budget probable : " + euro(note.cost[0]) + " – " + euro(note.cost[1]));
        li.appendChild(cost);
      }
      if (animate && !reduceMotion) li.classList.add("is-new");
      notes.appendChild(li);
    }

    function refreshCard(qid, animate) {
      var card = cards[qid];
      var item = byId[qid];
      if (!card || !item) return;
      var answer = state.answers[qid] || null;
      card.setAttribute("data-state", cardState(item, answer));
      var ask = card.querySelector("[data-ask]");
      if (ask) {
        var unknown = lib.isUnknown(answer);
        ask.setAttribute("aria-pressed", unknown ? "true" : "false");
        ask.querySelector("[data-ask-label]").textContent = unknown ? "Noté : à demander" : "Je demanderai sur place";
      }
      if (card._sync) card._sync();
      renderNote(item, card, animate);
      card._ready = true;
    }

    function pruneHiddenAnswers() {
      Object.keys(state.answers).forEach(function (id) {
        var it = byId[id];
        if (it && it.showWhen && !lib.questionVisible(it, state.answers)) {
          delete state.answers[id];
        }
      });
    }

    function setAnswer(qid, answer, opts) {
      var item = byId[qid];
      if (!item) return;
      if (!answer || (answer.response == null && (answer.value === null || answer.value === undefined || answer.value === ""))) {
        if (opts && opts.silentIfEmpty && answer) {
          state.answers[qid] = { response: answer.response, value: null, answeredAt: new Date().toISOString() };
        } else {
          delete state.answers[qid];
        }
      } else {
        state.answers[qid] = {
          response: answer.response || null,
          value: answer.value === undefined ? null : answer.value,
          answeredAt: new Date().toISOString(),
        };
      }
      pruneHiddenAnswers();
      refreshCard(qid, true);
      update({ save: true });
    }

    /* Délégation : « je demanderai », conseil du pro, aller à une question. */
    root.addEventListener("click", function (e) {
      var t = e.target;
      var ask = t.closest("[data-ask]");
      if (ask) {
        var li = ask.closest("[data-q]");
        var qid = li.getAttribute("data-q");
        var a = state.answers[qid];
        if (lib.isUnknown(a)) setAnswer(qid, null);
        else setAnswer(qid, { response: "unknown", value: null });
        return;
      }
      var tipToggle = t.closest("[data-tip-toggle]");
      if (tipToggle) {
        var tip = tipToggle.closest(".visit-q__card").querySelector("[data-tip]");
        var open = tipToggle.getAttribute("aria-expanded") !== "true";
        tipToggle.setAttribute("aria-expanded", open ? "true" : "false");
        setReveal(tip, open, true);
        return;
      }
      var go = t.closest("[data-goto]");
      if (go) {
        gotoQuestion(go.getAttribute("data-goto"));
        return;
      }
      var consent = t.closest("[data-consent-choice]");
      if (consent) {
        setApply(consent.getAttribute("data-consent-choice") === "yes", true);
        return;
      }
      var filter = t.closest("[data-filter]");
      if (filter) {
        state.filter = filter.getAttribute("data-filter");
        root.querySelectorAll("[data-filter]").forEach(function (b) {
          var on = b === filter;
          b.classList.toggle("is-active", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        });
        applyFilters();
        return;
      }
      if (t.closest("[data-reset]")) {
        resetAll();
        return;
      }
      if (t.closest("[data-dock]")) {
        result.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      }
    });

    function gotoQuestion(qid) {
      var card = cards[qid];
      if (!card) return;
      if (card.hidden) {
        state.filter = "all";
        state.hideAnswered = false;
        hideAnswered.checked = false;
        root.querySelectorAll("[data-filter]").forEach(function (b) {
          var on = b.getAttribute("data-filter") === "all";
          b.classList.toggle("is-active", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        });
        applyFilters();
      }
      card.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
      restart(card, "is-pulsing");
      var focusable = card.querySelector("input, button.visit-letter, button.visit-choice, textarea");
      if (focusable) setTimeout(function () { focusable.focus({ preventScroll: true }); }, 350);
    }

    /* ------------------------------ Filtres ----------------------------- */

    var hideAnswered = root.querySelector("[data-hide-answered]");
    hideAnswered.addEventListener("change", function () {
      state.hideAnswered = hideAnswered.checked;
      applyFilters();
    });

    var filterScroll = root.querySelector(".visit-filters__scroll");
    if (filterScroll) bindFilterStripDragScroll(filterScroll);

    function matchesFilter(item) {
      if (state.filter === "all") return true;
      if (state.filter === "essential") return Boolean(item.essential);
      return item.theme === state.filter;
    }

    function applyFilters() {
      sections.forEach(function (section) {
        var visible = 0;
        var pendingDivider = null;
        var dividerHasAfter = false;
        var hasBefore = false;
        section.querySelectorAll(".visit-list > li").forEach(function (li) {
          if (li.classList.contains("visit-divider")) {
            pendingDivider = li;
            return;
          }
          var qid = li.getAttribute("data-q");
          var item = byId[qid];
          var answer = state.answers[qid] || null;
          var treated = lib.isAnswered(item, answer) || lib.isUnknown(answer);
          var show =
            matchesFilter(item) &&
            lib.questionVisible(item, state.answers) &&
            !(state.hideAnswered && treated);
          li.hidden = !show;
          if (show) {
            visible += 1;
            if (pendingDivider) dividerHasAfter = true;
            else hasBefore = true;
          }
        });
        if (pendingDivider) pendingDivider.hidden = !(dividerHasAfter && hasBefore);
        var empty = section.querySelector("[data-section-empty]");
        var all = section.querySelectorAll("[data-q]").length;
        var anyMatch = Array.prototype.some.call(section.querySelectorAll("[data-q]"), function (li) {
          var it = byId[li.getAttribute("data-q")];
          return matchesFilter(it) && lib.questionVisible(it, state.answers);
        });
        section.hidden = all > 0 && !anyMatch;
        if (empty) empty.hidden = !(anyMatch && visible === 0);
      });
    }

    /* ------------------------------- Bilan ------------------------------ */

    var result = root.querySelector("[data-result]");
    var out = {};
    root.querySelectorAll("[data-out]").forEach(function (node) {
      out[node.getAttribute("data-out")] = node;
    });
    var ringFill = root.querySelector("[data-ring-fill]");
    var phaseEl = root.querySelector("[data-phase-label]");
    var verdictEl = root.querySelector("[data-verdict]");
    var verdictTitle = root.querySelector("[data-verdict-title]");
    var verdictText = root.querySelector("[data-verdict-text]");
    var leverBox = root.querySelector("[data-lever]");
    var leverBar = root.querySelector("[data-lever-bar]");
    var leverReasons = root.querySelector("[data-lever-reasons]");
    var leverEmpty = root.querySelector("[data-lever-empty]");
    var costsBox = root.querySelector("[data-costs]");
    var costsList = root.querySelector("[data-costs-list]");
    var worksBox = root.querySelector("[data-works]");
    var worksList = root.querySelector("[data-works-list]");
    var alertsList = root.querySelector("[data-alerts]");
    var todoBox = root.querySelector("[data-todo]");
    var todoList = root.querySelector("[data-todo-list]");
    var fixesBox = root.querySelector("[data-fixes]");
    var fixesList = root.querySelector("[data-fixes-list]");
    var dock = root.querySelector("[data-dock]");
    var dockCount = root.querySelector("[data-dock-count]");
    var dockText = root.querySelector("[data-dock-text]");
    var facts = {
      surface: root.querySelector('[data-fact="surface"]'),
      rooms: root.querySelector('[data-fact="rooms"]'),
      dpe: root.querySelector('[data-fact="dpe"]'),
    };

    var PHASE_LABELS = { preparation: "Préparation", visite: "Visite en cours", terminee: "Visite terminée" };
    var lastVerdictKey = null;
    var lastLevel = null;

    function renderList(ul, entries, build, keyOf) {
      var existing = {};
      Array.prototype.forEach.call(ul.children, function (li) {
        existing[li.getAttribute("data-key")] = li;
      });
      ul.textContent = "";
      entries.forEach(function (entry) {
        var key = keyOf(entry);
        var li = existing[key];
        if (!li) {
          li = build(entry);
          li.setAttribute("data-key", key);
          if (ul._ready && !reduceMotion) li.classList.add("is-new");
        }
        ul.appendChild(li);
      });
      ul._ready = true;
    }

    function questionLink(qid, text, className) {
      var b = el("button", "visit-link " + (className || ""), text);
      b.type = "button";
      b.setAttribute("data-goto", qid);
      return b;
    }

    function correctionLabel(c) {
      var item = byId[c.qid];
      var label = FIELD_LABELS[c.field] || (item ? item.question : c.field);
      return label;
    }

    /* Valeur lisible : libellé d'un choix, lettre en capitale, nombre + unité. */
    function displayValue(item, value, unit) {
      if (value === null || value === undefined || value === "") return "—";
      if (item && item.input && item.input.type === "choice") {
        var opt = (item.input.options || []).find(function (o) {
          return o.value === value || o.label === value;
        });
        return opt ? opt.label : String(value);
      }
      if (item && item.input && item.input.type === "confirm_letter") return String(value).toUpperCase();
      return withUnit(value, unit);
    }

    function renderBilan(ins) {
      var tone = ins.verdict.tone;
      result.setAttribute("data-tone", tone);
      dock.setAttribute("data-tone", tone);

      ringFill.style.strokeDashoffset = String(100 - ins.counts.progress);
      bumpText(out.answered, String(ins.counts.answered));
      out.total.textContent = String(ins.counts.total);

      phaseEl.textContent = PHASE_LABELS[ins.phase] || "Préparation";
      phaseEl.setAttribute("data-phase", ins.phase);

      var vkey = ins.verdict.title + "|" + ins.verdict.text;
      if (vkey !== lastVerdictKey) {
        verdictTitle.textContent = ins.verdict.title;
        verdictText.textContent = ins.verdict.text;
        if (lastVerdictKey !== null && !reduceMotion) restart(verdictEl, "is-new");
        lastVerdictKey = vkey;
      }

      bumpText(out["essentials-done"], String(ins.counts.essentialsAnswered));
      out.essentials.textContent = String(ins.counts.essentials);
      bumpText(out.alerts, String(ins.counts.alerts));
      out.alerts.setAttribute("data-tone", ins.counts.dangers ? "danger" : ins.counts.alerts ? "warn" : "");
      bumpText(out.corrections, String(ins.counts.corrections));
      bumpText(out.todo, String(ins.counts.todo));

      /* Levier */
      leverBox.setAttribute("data-level", String(ins.lever.level));
      leverBar.setAttribute("data-level", String(ins.lever.level));
      out["lever-label"].textContent = ins.lever.label;
      if (lastLevel !== null && ins.lever.level > lastLevel && !reduceMotion) {
        restart(leverBar.children[ins.lever.level], "is-lit");
      }
      lastLevel = ins.lever.level;
      renderList(
        leverReasons,
        ins.lever.reasons,
        function (r) {
          var li = el("li");
          var text = el("span", null, r.text);
          li.appendChild(text);
          li.appendChild(el("span", "visit-lever__pts", "+" + r.points));
          return li;
        },
        function (r) {
          return (r.qid || "market") + "|" + r.text;
        }
      );
      leverEmpty.hidden = ins.lever.reasons.length > 0;

      /* Coûts fixes */
      costsBox.hidden = !ins.costs.known;
      if (ins.costs.known) {
        bumpText(out.monthly, euro(ins.costs.monthly));
        var rows = [];
        if (ins.costs.charges) rows.push(["Charges de copropriété", euro(ins.costs.charges) + " / an"]);
        if (ins.costs.taxe) rows.push(["Taxe foncière", euro(ins.costs.taxe) + " / an"]);
        if (ins.costs.energy) rows.push(["Énergie", euro(ins.costs.energy) + " / an"]);
        costsList.textContent = "";
        rows.forEach(function (r) {
          var li = el("li");
          li.appendChild(el("span", null, r[0]));
          li.appendChild(el("span", null, r[1]));
          costsList.appendChild(li);
        });
      }

      /* Travaux */
      worksBox.hidden = !ins.works.items.length;
      if (ins.works.items.length) {
        bumpText(out.works, euro(ins.works.min) + " – " + euro(ins.works.max));
        renderList(
          worksList,
          ins.works.items,
          function (w) {
            var li = el("li");
            li.appendChild(questionLink(w.qid, shortQuestion(w.question)));
            li.appendChild(el("span", null, euro(w.min) + " – " + euro(w.max)));
            return li;
          },
          function (w) {
            return w.qid;
          }
        );
      }

      /* Alertes */
      renderList(
        alertsList,
        ins.alerts,
        function (a) {
          var li = el("li", "visit-tipcard visit-tipcard--" + a.tone);
          li.appendChild(el("small", null, a.tone === "danger" ? "Bloquant" : "À négocier"));
          li.appendChild(el("span", null, a.text));
          li.appendChild(questionLink(a.qid, "Voir la question"));
          return li;
        },
        function (a) {
          return a.qid + "|" + a.text;
        }
      );

      /* À demander */
      todoBox.hidden = !ins.todo.length;
      renderList(
        todoList,
        ins.todo,
        function (t) {
          var li = el("li");
          li.appendChild(questionLink(t.qid, t.question));
          return li;
        },
        function (t) {
          return t.qid;
        }
      );

      /* Corrections */
      fixesBox.hidden = !ins.corrections.length;
      renderList(
        fixesList,
        ins.corrections,
        function (c) {
          var li = el("li");
          li.appendChild(questionLink(c.qid, correctionLabel(c)));
          var val = el("span", "visit-fixes__val");
          var fixItem = byId[c.qid];
          if (c.from !== null && c.from !== undefined) {
            var s = el("s", null, displayValue(fixItem, c.from, c.unit));
            val.appendChild(s);
          }
          val.appendChild(document.createTextNode(displayValue(fixItem, c.to, c.unit)));
          li.appendChild(val);
          return li;
        },
        function (c) {
          return c.qid + "|" + c.to;
        }
      );

      /* Repères de l'en-tête */
      var eff = ins.effective || {};
      if (facts.surface && eff.surface != null) bumpText(facts.surface, num(eff.surface) + " m²");
      if (facts.rooms && eff.rooms != null) bumpText(facts.rooms, String(eff.rooms));
      if (facts.dpe && eff.dpe != null) bumpText(facts.dpe, String(eff.dpe).toUpperCase());

      /* Dock mobile */
      dockCount.textContent = ins.counts.answered + "/" + ins.counts.total;
      dockText.textContent =
        ins.counts.alerts > 0
          ? ins.counts.alerts + (ins.counts.alerts > 1 ? " alertes · " : " alerte · ") + ins.verdict.title
          : ins.verdict.title;
    }

    function shortQuestion(q) {
      var s = String(q).replace(/\s*\?$/, "");
      return s.length > 48 ? s.slice(0, 46).trim() + "…" : s;
    }

    function renderSections() {
      sections.forEach(function (section) {
        var total = 0;
        var done = 0;
        section.querySelectorAll("[data-q]").forEach(function (li) {
          var qid = li.getAttribute("data-q");
          var a = state.answers[qid] || null;
          total += 1;
          if (lib.isAnswered(byId[qid], a) || lib.isUnknown(a)) done += 1;
        });
        var doneEl = section.querySelector("[data-section-done]");
        var bar = section.querySelector("[data-section-bar]");
        if (doneEl) bumpText(doneEl, String(done));
        if (bar) bar.style.width = (total ? Math.round((done / total) * 100) : 0) + "%";
        section.classList.toggle("is-complete", total > 0 && done === total);
      });
    }

    function update(options) {
      var ins = lib.computeInsights({
        items: items,
        answers: state.answers,
        market: initial.market || {},
        listing: initial.listing || {},
      });
      renderBilan(ins);
      renderSections();
      applyFilters();
      if (options && options.save) scheduleSave();
    }

    /* ------------------------ Mise à jour de la fiche ------------------- */

    var consentModal = document.getElementById("visit-consent-modal");
    var applyToggle = root.querySelector("[data-apply-toggle]");
    var applyHint = root.querySelector("[data-apply-hint]");

    function openConsentModal() {
      if (!consentModal || consentModal.hidden) return;
      consentModal.hidden = false;
      document.body.classList.add("is-modal-open");
      var focusBtn = consentModal.querySelector('[data-consent-choice="yes"]');
      if (focusBtn) focusBtn.focus({ preventScroll: true });
    }

    function closeConsentModal() {
      if (!consentModal) return;
      consentModal.hidden = true;
      document.body.classList.remove("is-modal-open");
    }

    function setApply(value, fromConsent) {
      state.applyToSheet = value;
      applyToggle.checked = value === true;
      applyHint.textContent =
        value === true
          ? "Vos corrections remplacent les valeurs de l'annonce et réajustent le dossier technique."
          : "Vos réponses restent dans cette fiche : l'annonce et le chiffrage ne changent pas.";
      if (fromConsent) closeConsentModal();
      scheduleSave();
      if (fromConsent) {
        showToast(
          value ? "Vos réponses mettront la fiche à jour." : "Vos réponses restent dans la fiche de visite.",
          null
        );
      }
    }

    if (state.applyToSheet === null) openConsentModal();

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (consentModal && !consentModal.hidden) e.preventDefault();
    });

    applyToggle.addEventListener("change", function () {
      setApply(applyToggle.checked, false);
    });

    /* ------------------------------ Reset ------------------------------- */

    function resetAll() {
      if (!Object.keys(state.answers).length) return;
      var snapshot = JSON.parse(JSON.stringify(state.answers));
      state.answers = {};
      Object.keys(cards).forEach(function (qid) {
        refreshCard(qid, false);
      });
      update({ save: true });
      showToast("Toutes les réponses ont été effacées", function () {
        state.answers = snapshot;
        Object.keys(cards).forEach(function (qid) {
          refreshCard(qid, false);
        });
        update({ save: true });
      });
    }

    /* ---------------------------- Sauvegarde ---------------------------- */

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
      fetch(saveUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf, Accept: "application/json" },
        body: JSON.stringify({ visit: { applyToSheet: state.applyToSheet, answers: state.answers } }),
        credentials: "same-origin",
        keepalive: Boolean(keepalive),
      })
        .then(function (res) {
          // Session expirée : 401, ou redirection vers la page de connexion (HTML).
          var type = res.headers.get("content-type") || "";
          if (res.status === 401 || res.redirected || (res.ok && type.indexOf("json") === -1)) {
            throw new Error("auth");
          }
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

    /* ------------------------------ Toast ------------------------------- */

    var toast = root.querySelector("[data-toast]");
    var toastUndoBtn = toast.querySelector("[data-toast-undo]");
    var toastUndo = null;
    var toastTimer = null;
    toast.inert = true;

    function showToast(text, undo) {
      toast.querySelector("[data-toast-text]").textContent = text;
      toastUndo = undo;
      toastUndoBtn.hidden = !undo;
      toast.inert = false;
      toast.classList.add("is-visible");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(hideToast, undo ? 7000 : 3500);
    }
    function hideToast() {
      toast.inert = true;
      toast.classList.remove("is-visible");
      toastUndo = null;
    }
    toastUndoBtn.addEventListener("click", function () {
      var undo = toastUndo;
      hideToast();
      if (undo) undo();
    });

    /* Le résumé mobile n'apparaît que lorsque le bilan est hors de l'écran. */
    if ("IntersectionObserver" in window) {
      var observer = new IntersectionObserver(
        function (entries) {
          dock.classList.toggle("is-visible", !entries[0].isIntersecting);
        },
        { threshold: 0.1 }
      );
      observer.observe(result);
    }

    /* ----------------------------- Démarrage ---------------------------- */

    Object.keys(cards).forEach(function (qid) {
      var item = byId[qid];
      if (!item) return;
      renderControl(item, cards[qid]);
      refreshCard(qid, false);
    });
    applyFilters();
    update();
    requestAnimationFrame(function () {
      root.classList.add("is-ready");
    });
  }
})();
