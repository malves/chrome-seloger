/*
 * Assistant « Faire une offre » : guide l'utilisateur en quelques étapes pour
 * rédiger un email d'offre d'achat juridiquement prudent.
 *
 * Tout se passe côté client : aucune donnée n'est enregistrée sur le serveur.
 * Les montants ajustés ici (prix proposé, travaux retenus, apport) ne modifient NI
 * l'onglet travaux NI le bloc financement de la fiche.
 */
(function () {
  "use strict";

  var modal = document.querySelector("[data-offer-modal]");
  if (!modal) return;

  var dialog = modal.querySelector(".offer-modal__dialog");
  var body = modal.querySelector("[data-offer-body]");
  var stepsNav = modal.querySelector("[data-offer-steps]");
  var toastEl = modal.querySelector("[data-offer-toast]");
  var prevBtn = modal.querySelector("[data-offer-prev]");
  var nextBtn = modal.querySelector("[data-offer-next]");
  var skipBtn = modal.querySelector("[data-offer-skip]");
  var closeBtn = modal.querySelector("[data-offer-close]");

  var reducedMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** Heure limite d'acceptation dans l'email (non réglable dans l'assistant). */
  var OFFER_ACCEPTANCE_DEADLINE_HOUR = "12 h 00";
  /** Plafond de quote-part travaux votés (copropriété) dans l'email. */
  var OFFER_COPRO_WORKS_QUOTE_CAP = 2000;

  /* ------------------------------ Données ------------------------------ */

  var DATA = readData();
  if (!DATA) return;

  function readData() {
    var holder = modal.querySelector("[data-offer-data]");
    if (!holder) return null;
    try {
      return JSON.parse(holder.textContent);
    } catch (err) {
      return null;
    }
  }

  /* ------------------------------ Utilitaires ------------------------------ */

  var euroFmt = window.Intl
    ? new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 })
    : null;

  function fmtNumber(n) {
    var v = Math.round(Number(n) || 0);
    return euroFmt ? euroFmt.format(v) : String(v);
  }

  function euro(n) {
    return fmtNumber(n) + "\u00a0\u20ac";
  }

  function pct(rate, decimals) {
    var v = (Number(rate) || 0) * 100;
    return v.toLocaleString("fr-FR", {
      minimumFractionDigits: decimals == null ? 0 : decimals,
      maximumFractionDigits: decimals == null ? 1 : decimals,
    });
  }

  function parseAmount(value) {
    var n = Number(String(value == null ? "" : value).replace(/[^\d]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }

  function parseDecimal(value) {
    var s = String(value == null ? "" : value)
      .replace(/\s/g, "")
      .replace(",", ".")
      .replace(/[^\d.]/g, "");
    var n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  }

  function fmtDecimal(n, decimals) {
    return (Number(n) || 0).toLocaleString("fr-FR", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  function phoneDigits(value) {
    return String(value == null ? "" : value).replace(/\D/g, "");
  }

  /** Groupes 2 par 2 : 0610936557 → 06 10 93 65 57 */
  function formatNationalPhoneDigits(digits) {
    digits = digits.slice(0, 10);
    if (!digits) return "";
    var parts = [];
    for (var i = 0; i < digits.length; i += 2) {
      parts.push(digits.slice(i, i + 2));
    }
    return parts.join(" ");
  }

  /** Neuf chiffres après indicatif : 610936557 → 6 10 93 65 57 */
  function formatIntlNationalDigits(digits) {
    digits = digits.slice(0, 9);
    if (!digits) return "";
    var head = digits.charAt(0);
    var tail = digits.slice(1);
    if (!tail) return head;
    var pairs = [];
    for (var j = 0; j < tail.length; j += 2) {
      pairs.push(tail.slice(j, j + 2));
    }
    return head + " " + pairs.join(" ");
  }

  /**
   * Espaces pour 06…, 00 33… ou +33… (saisie progressive incluse).
   */
  function formatPhone(value) {
    var raw = String(value == null ? "" : value);
    if (!raw.trim()) return "";

    var digits = phoneDigits(raw);
    var leadPlus = /^\s*\+/.test(raw);

    if (leadPlus) {
      if (!digits) return "+";
      if (digits.indexOf("33") !== 0) {
        return "+" + digits;
      }
      var intlNat = digits.slice(2);
      while (intlNat.charAt(0) === "0") intlNat = intlNat.slice(1);
      if (digits.length <= 2) return "+" + digits;
      var intlBody = formatIntlNationalDigits(intlNat);
      return "+33" + (intlBody ? " " + intlBody : "");
    }

    if (digits.indexOf("0033") === 0) {
      var nat00 = digits.slice(4);
      while (nat00.charAt(0) === "0") nat00 = nat00.slice(1);
      if (digits.length <= 2) return digits;
      if (digits.length === 3) return digits.slice(0, 2) + " " + digits.charAt(2);
      if (digits.length === 4) return "00 " + digits.charAt(2) + digits.charAt(3);
      var body00 = formatIntlNationalDigits(nat00);
      return "00 33" + (body00 ? " " + body00 : "");
    }

    if (digits.indexOf("00") === 0 && digits.indexOf("0033") !== 0) {
      if (digits.length <= 2) return digits;
      return digits.slice(0, 2) + " " + digits.slice(2);
    }

    return formatNationalPhoneDigits(digits);
  }

  var UNITS = [
    "z\u00e9ro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf",
    "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize",
    "dix-sept", "dix-huit", "dix-neuf",
  ];
  var TENS = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante"];

  /** 0..99 en toutes lettres (orthographe 1990, traits d'union). */
  function wordsBelow100(n) {
    if (n < 20) return UNITS[n];
    if (n < 70) {
      var t = Math.floor(n / 10);
      var u = n % 10;
      if (u === 0) return TENS[t];
      return TENS[t] + (u === 1 ? "-et-un" : "-" + UNITS[u]);
    }
    if (n < 80) return n === 71 ? "soixante-et-onze" : "soixante-" + UNITS[n - 60];
    if (n === 80) return "quatre-vingts";
    return "quatre-vingt-" + UNITS[n - 80];
  }

  function wordsBelow1000(n) {
    var h = Math.floor(n / 100);
    var rest = n % 100;
    var head = "";
    if (h === 1) head = "cent";
    else if (h > 1) head = UNITS[h] + "-cent" + (rest === 0 ? "s" : "");
    if (rest === 0) return head;
    return (head ? head + "-" : "") + wordsBelow100(rest);
  }

  function numberToWords(value) {
    var n = Math.floor(Math.abs(Number(value) || 0));
    if (n === 0) return UNITS[0];
    var millions = Math.floor(n / 1000000);
    var thousands = Math.floor((n % 1000000) / 1000);
    var rest = n % 1000;
    var parts = [];
    if (millions) {
      parts.push(
        (millions === 1 ? "un" : wordsBelow1000(millions)) +
          "-million" +
          (millions > 1 ? "s" : "")
      );
    }
    if (thousands) {
      var th = thousands === 1 ? "mille" : wordsBelow1000(thousands).replace(/s$/, "") + "-mille";
      parts.push(th);
    }
    if (rest) parts.push(wordsBelow1000(rest));
    return parts.join("-");
  }

  function isApartment() {
    return DATA.listing.property_type === "apartment";
  }

  function propertyAddressLine() {
    var card = document.querySelector("[data-listing-address-open]");
    if (card) {
      var street = String(card.getAttribute("data-street") || "").trim();
      var complement = String(card.getAttribute("data-complement") || "").trim();
      var postal = String(card.getAttribute("data-postal-code") || "").trim();
      var city = String(card.getAttribute("data-city") || "").trim();
      if (street || postal || city) {
        var line = [street, complement].filter(Boolean).join(", ");
        var locality = [postal, city].filter(Boolean).join(" ");
        return [line, locality].filter(Boolean).join(", ");
      }
    }
    var stored = DATA.listing && DATA.listing.user_address;
    return stored ? String(stored).trim() : "";
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function icon(name, cls) {
    return (
      '<svg class="wi' +
      (cls ? " " + cls : "") +
      '" aria-hidden="true"><use href="#wi-' +
      name +
      '"></use></svg>'
    );
  }

  function roundCost(n) {
    var v = Number(n) || 0;
    var step = v >= 20000 ? 1000 : v >= 5000 ? 500 : v >= 1000 ? 100 : 50;
    return Math.round(v / step) * step;
  }

  function midpointWorks(range) {
    if (!range || !(Number(range.max) > 0)) return 0;
    var lo = Math.max(0, Number(range.min) || 0);
    var hi = Math.max(lo, Number(range.max) || 0);
    return roundCost((lo + hi) / 2);
  }

  function monthlyPayment(principal, annualRate, years) {
    var months = Math.round((Number(years) || 0) * 12);
    if (!(principal > 0) || months <= 0) return 0;
    var monthlyRate = (Number(annualRate) || 0) / 12;
    if (monthlyRate === 0) return principal / months;
    return (principal * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -months));
  }

  function addDays(days) {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + (Number(days) || 0));
    return d;
  }

  function longDate(date) {
    try {
      return date.toLocaleDateString("fr-FR", {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
    } catch (err) {
      return date.toISOString().slice(0, 10);
    }
  }

  /* -------------------------- Récapitulatif financier -------------------------- */

  /**
   * Recalcule le tableau à partir du prix proposé dans le widget ; les travaux
   * et les autres paramètres (apport, taux, durée) viennent du bloc financement
   * de la fiche. Mêmes formules que financing.service.js, mais purement locales.
   */
  function computeFinance() {
    var fin = DATA.financing;
    if (!fin) {
      return null;
    }
    var p = fin.params;
    var r = fin.result;
    var price = Math.max(0, S.offerPrice);
    var works = Math.max(0, S.works);

    var notaryFees = price * (Number(r.notaryRate) || 0);
    var agencyRatio =
      !fin.agencyFeesIncluded && r.price > 0 ? r.agencyFees / r.price : 0;
    var agencyFees = price * agencyRatio;
    var totalCost = price + notaryFees + agencyFees + works;

    var downPayment = Math.max(0, S.downPayment);
    var baseAmount = Math.max(0, totalCost - downPayment);
    var guaranteeFees = baseAmount * (Number(r.guaranteeRate) || 0);
    var loanAmount = baseAmount > 0 ? baseAmount + guaranteeFees : 0;

    var paymentExcl = monthlyPayment(loanAmount, p.interestRate, p.years);
    var monthlyInsurance = (loanAmount * (Number(p.insuranceRate) || 0)) / 12;
    var totalMonthly = paymentExcl + monthlyInsurance;

    return {
      price: price,
      notaryRate: Number(r.notaryRate) || 0,
      notaryFees: notaryFees,
      agencyFees: agencyFees,
      agencyFeesIncluded: fin.agencyFeesIncluded,
      works: works,
      totalCost: totalCost,
      downPayment: downPayment,
      guaranteeFees: guaranteeFees,
      loanAmount: loanAmount,
      years: Number(p.years) || 0,
      interestRate: Number(p.interestRate) || 0,
      totalMonthly: totalMonthly,
      isFullyFunded: loanAmount === 0,
    };
  }

  /* -------------------------------- État -------------------------------- */

  var fin0 = DATA.financing;

  function financingWorksAmount() {
    if (fin0) return Math.max(0, Number(fin0.params.works) || 0);
    return Math.max(0, midpointWorks(DATA.worksRange));
  }

  /** Prix retenu du tableau financement (prix négocié ou prix affiché). */
  function financingPriceBasis() {
    if (fin0) {
      var negotiated = Number(fin0.params.negotiatedPrice) || 0;
      if (negotiated > 0) return negotiated;
      var retained = Number(fin0.result.price) || 0;
      if (retained > 0) return retained;
    }
    return Math.max(0, Number(DATA.listing.price) || 0);
  }

  /** Proposition initiale : prix retenu − travaux (comme sur la fiche). */
  function initialOfferPrice() {
    return Math.max(0, financingPriceBasis() - financingWorksAmount());
  }

  var S = {
    step: 0,
    offerPrice: initialOfferPrice(),
    works: financingWorksAmount(),
    downPayment: fin0 ? Number(fin0.params.downPayment) || 0 : 0,
    buyer: {
      name: (DATA.user && DATA.user.profileName) || "",
      email: (DATA.user && DATA.user.email) || "",
      phone: (DATA.user && DATA.user.profilePhone) || "",
    },
    identitySkipped: false,
    validityDays: 7,
    netVendeur: false,
    loanYears: fin0 ? Number(fin0.params.years) || 25 : 25,
    loanRateMax: fin0
      ? Math.round(((Number(fin0.params.interestRate) || 0) * 100 + 0.5) * 100) / 100
      : 0,
    clauses: {
      loan: Boolean(fin0),
      surface: Boolean(DATA.listing.surface),
      docs: true,
    },
    emailEdited: false,
    emailText: "",
    lastFocus: null,
  };

  /* ------------------------------- Étapes ------------------------------- */

  var STEPS = [
    { id: "amounts", label: "Montants", render: renderAmounts },
    { id: "identity", label: "Vous", render: renderIdentity },
    { id: "conditions", label: "Conditions", render: renderConditions },
    { id: "email", label: "Email", render: renderEmail, last: true },
  ];

  function stepIndex(id) {
    for (var i = 0; i < STEPS.length; i++) if (STEPS[i].id === id) return i;
    return -1;
  }

  /* ------------------------------- Rendu ------------------------------- */

  function renderSteps() {
    var html = "";
    for (var i = 0; i < STEPS.length; i++) {
      var state =
        i < S.step ? "done" : i === S.step ? "current" : "todo";
      html +=
        '<button type="button" class="offer-step offer-step--' +
        state +
        '" data-offer-goto="' +
        i +
        '"' +
        (i > S.step ? " disabled" : "") +
        (state === "current" ? ' aria-current="step"' : "") +
        ">" +
        '<span class="offer-step__dot">' +
        (state === "done" ? icon("check") : i + 1) +
        "</span>" +
        '<span class="offer-step__label">' +
        esc(STEPS[i].label) +
        "</span></button>";
      if (i < STEPS.length - 1) {
        html += '<span class="offer-step__sep" aria-hidden="true"></span>';
      }
    }
    stepsNav.innerHTML = html;
  }

  function field(labelHtml, inputHtml, hintHtml) {
    return (
      '<label class="offer-field">' +
      '<span class="offer-field__label">' +
      labelHtml +
      "</span>" +
      inputHtml +
      (hintHtml ? '<span class="offer-field__hint">' + hintHtml + "</span>" : "") +
      "</label>"
    );
  }

  function amountInput(name, value, aria) {
    return (
      '<span class="offer-amount">' +
      '<input class="input offer-amount__input" type="text" inputmode="numeric" autocomplete="off" ' +
      'data-offer-field="' +
      name +
      '" value="' +
      fmtNumber(value) +
      '" aria-label="' +
      esc(aria) +
      '" />' +
      '<span class="offer-amount__unit">\u20ac</span>' +
      "</span>"
    );
  }

  function stepHead(eyebrow, title, lead) {
    return (
      '<div class="offer-view__head">' +
      '<p class="offer-view__eyebrow">' +
      esc(eyebrow) +
      "</p>" +
      '<h3 class="offer-view__title">' +
      esc(title) +
      "</h3>" +
      (lead ? '<p class="offer-view__lead">' + lead + "</p>" : "") +
      "</div>"
    );
  }

  function priceGapHtml() {
    var official = Number(DATA.listing.price) || 0;
    if (!(official > 0)) return "";
    var gap = Math.round(((S.offerPrice - official) / official) * 1000) / 10;
    if (gap < 0) {
      return (
        '<span class="offer-gap offer-gap--down">\u2212' +
        Math.abs(gap).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) +
        "\u00a0%</span> VS le prix affich\u00e9 (" +
        euro(official) +
        ")"
      );
    }
    if (gap > 0) {
      return (
        '<span class="offer-gap offer-gap--up">+' +
        gap.toLocaleString("fr-FR", { maximumFractionDigits: 1 }) +
        "\u00a0%</span> VS le prix affich\u00e9 (" +
        euro(official) +
        ")"
      );
    }
    return "";
  }

  function recapRow(label, value, opts) {
    opts = opts || {};
    return (
      '<div class="offer-recap__row' +
      (opts.strong ? " offer-recap__row--strong" : "") +
      (opts.total ? " offer-recap__row--total" : "") +
      '">' +
      "<span>" +
      label +
      "</span><span>" +
      value +
      "</span></div>"
    );
  }

  function financeRecapInner() {
    var f = computeFinance();
    if (!f) {
      return (
        '<p class="offer-view__lead">Votre offre porte sur un prix de <strong>' +
        euro(S.offerPrice) +
        "</strong> et un budget travaux de <strong>" +
        euro(S.works) +
        "</strong>.</p>"
      );
    }
    return (
      recapRow("Prix propos\u00e9", euro(f.price)) +
      recapRow(
        "Frais de notaire <span class=\"offer-recap__hint\">(" +
          pct(f.notaryRate) +
          "\u00a0%)</span>",
        euro(f.notaryFees)
      ) +
      (f.agencyFeesIncluded
        ? recapRow(
            "Frais d'agence <span class=\"offer-recap__hint\">(inclus dans le prix)</span>",
            euro(0)
          )
        : recapRow("Frais d'agence", euro(f.agencyFees))) +
      recapRow("Travaux retenus", euro(f.works)) +
      recapRow("Co\u00fbt total du projet", euro(f.totalCost), { total: true }) +
      recapRow("Apport", "\u2212 " + euro(f.downPayment)) +
      (f.isFullyFunded
        ? recapRow("Montant \u00e0 emprunter", euro(0), { strong: true })
        : recapRow("Montant emprunt\u00e9", euro(f.loanAmount), { strong: true }))
    );
  }

  function renderAmounts() {
    return (
      '<div class="offer-view" data-step-anim>' +
      stepHead(
        "\u00c9tape 1",
        "Prix, travaux et budget",
        "Reprenez les chiffres de votre simulation, ajustez-les si besoin et v\u00e9rifiez le r\u00e9capitulatif." +
          (S.works > 0
            ? " Le prix propos\u00e9 part du prix retenu du financement, travaux d\u00e9duits (" +
              euro(S.works) +
              ")."
            : "") +
          " Rien n'est enregistr\u00e9 sur la fiche."
      ) +
      '<div class="offer-card offer-amounts-fields">' +
      '<div class="offer-amounts-fields__row">' +
      field(
        "Prix que je propose",
        amountInput("offerPrice", S.offerPrice, "Prix propos\u00e9 en euros"),
        '<span data-offer-price-gap>' + priceGapHtml() + "</span>"
      ) +
      field(
        "Apport personnel",
        amountInput("downPayment", S.downPayment, "Montant de votre apport en euros")
      ) +
      "</div>" +
      (fin0
        ? '<div class="offer-amounts-fields__row">' +
          field(
            "Dur\u00e9e du pr\u00eat",
            unitInput("loanYears", S.loanYears, "ans", "Dur\u00e9e maximale du pr\u00eat en ann\u00e9es"),
            "Pour la condition suspensive de pr\u00eat dans l'email."
          ) +
          field(
            "Taux nominal maximal",
            unitInput("loanRateMax", fmtDecimal(S.loanRateMax, 2), "%", "Taux nominal maximal hors assurance", {
              decimal: true,
            }),
            "Hors assurance."
          ) +
          "</div>"
        : "") +
      "</div>" +
      '<p class="offer-view__note">' +
      icon("shield") +
      " Ces montants ne modifient que l'email, pas l'onglet travaux ni le bloc financement." +
      "</p>" +
      '<h4 class="offer-amounts__recap-title">R\u00e9capitulatif</h4>' +
      '<div class="offer-card offer-recap" data-offer-recap>' +
      financeRecapInner() +
      "</div>" +
      "</div>"
    );
  }

  function renderIdentity() {
    var disabled = S.identitySkipped;
    return (
      '<div class="offer-view" data-step-anim>' +
      stepHead(
        "\u00c9tape 2",
        "Vos coordonn\u00e9es",
        "Elles personnalisent l'email et permettent \u00e0 l'agence de vous recontacter. Vous pouvez ignorer cette \u00e9tape\u00a0: des champs \u00e0 compl\u00e9ter resteront dans l'email."
      ) +
      '<div class="offer-card' +
      (disabled ? " is-disabled" : "") +
      '" data-offer-identity>' +
      field(
        "Nom et pr\u00e9nom",
        '<input class="input" type="text" autocomplete="name" data-offer-field="buyer.name" value="' +
          esc(S.buyer.name) +
          '"' +
          (disabled ? " disabled" : "") +
          ' placeholder="Votre nom" />'
      ) +
      field(
        "Email",
        '<input class="input" type="email" autocomplete="email" data-offer-field="buyer.email" value="' +
          esc(S.buyer.email) +
          '"' +
          (disabled ? " disabled" : "") +
          ' placeholder="vous@exemple.fr" />'
      ) +
      field(
        "T\u00e9l\u00e9phone",
        '<input class="input" type="tel" autocomplete="tel" data-offer-field="buyer.phone" value="' +
          esc(formatPhone(S.buyer.phone)) +
          '"' +
          (disabled ? " disabled" : "") +
          ' placeholder="06\u00a0\u2026" />'
      ) +
      "</div>" +
      (disabled
        ? '<p class="offer-view__note offer-view__note--warn">' +
          icon("alert") +
          " \u00c9tape ignor\u00e9e\u00a0: pensez \u00e0 compl\u00e9ter les champs entre crochets (nom, email, t\u00e9l\u00e9phone) dans l'email avant de l'envoyer. " +
          '<button type="button" class="offer-link" data-offer-action="identity-resume">Finalement, les renseigner</button></p>'
        : "") +
      "</div>"
    );
  }

  function clauseToggle(key, title, desc) {
    var on = S.clauses[key];
    return (
      '<label class="offer-clause' +
      (on ? " is-on" : "") +
      '">' +
      '<input type="checkbox" data-offer-field="clauses.' +
      key +
      '"' +
      (on ? " checked" : "") +
      ' class="offer-clause__check" />' +
      '<span class="offer-clause__body">' +
      '<span class="offer-clause__title">' +
      esc(title) +
      "</span>" +
      '<span class="offer-clause__desc">' +
      desc +
      "</span></span></label>"
    );
  }

  function unitInput(name, value, unit, aria, opts) {
    opts = opts || {};
    return (
      '<span class="offer-amount">' +
      '<input class="input offer-amount__input" type="text" inputmode="' +
      (opts.decimal ? "decimal" : "numeric") +
      '" autocomplete="off" data-offer-field="' +
      name +
      '" value="' +
      esc(value) +
      '" aria-label="' +
      esc(aria) +
      '" />' +
      '<span class="offer-amount__unit">' +
      unit +
      "</span></span>"
    );
  }

  function roundUp(n, step) {
    return Math.ceil((Number(n) || 0) / step) * step;
  }

  function loanAmountForEmail() {
    var f = computeFinance();
    return f && f.loanAmount > 0 ? roundUp(f.loanAmount, 1000) : 0;
  }

  function validityDate() {
    return longDate(addDays(S.validityDays));
  }

  /** Résumé court des étiquettes annoncées pour la case « DPE ». */
  function dpeLabelsHint() {
    var dpe = DATA.listing.dpe;
    var ges = DATA.listing.ges;
    if (!dpe && !ges) return "";
    var parts = [];
    if (dpe) parts.push("\u00e9nergie " + classAtLeast(dpe));
    if (ges) parts.push("climat " + classAtLeast(ges));
    return "DPE conforme \u00e0 l'annonce (" + parts.join(", ") + ")";
  }

  function renderConditions() {
    var hasSurface = Boolean(DATA.listing.surface);
    var copro = isApartment();

    return (
      '<div class="offer-view" data-step-anim>' +
      stepHead(
        "\u00c9tape 3",
        "Prot\u00e9gez votre offre",
        "Une condition ne vous prot\u00e8ge que si elle porte sur un \u00e9v\u00e9nement pr\u00e9cis et chiffr\u00e9. On s'en tient donc \u00e0 l'essentiel\u00a0: le pr\u00eat, la surface et les documents du bien."
      ) +
      '<div class="offer-card">' +
      field(
        "Validit\u00e9 de l'offre",
        unitInput("validityDays", S.validityDays, "jours", "Dur\u00e9e de validit\u00e9 en jours"),
        '<span data-offer-validity-hint>Jusqu\'au <strong>' +
          esc(validityDate()) +
          "</strong> \u00e0 " +
          OFFER_ACCEPTANCE_DEADLINE_HOUR +
          ", heure de Paris.</span>"
      ) +
      "</div>" +
      '<div class="offer-clauses-head">' +
      '<h4 class="offer-clauses__title">Conditions dans l\u2019email</h4>' +
      '<p class="offer-clauses__lead">Cochez les \u00e9l\u00e9ments \u00e0 faire figurer dans le corps de votre offre\u00a0; les cases d\u00e9coch\u00e9es n\u2019y seront pas reprises.</p>' +
      "</div>" +
      '<div class="offer-clauses">' +
      (DATA.financing
        ? clauseToggle(
            "loan",
            "Condition suspensive de pr\u00eat",
            "Montant \u00e0 emprunter (r\u00e9capitulatif), dur\u00e9e et taux maximal\u00a0: ceux de l'\u00e9tape Montants."
          )
        : "") +
      (hasSurface
        ? clauseToggle(
            "surface",
            "Surface d\u00e9terminante",
            "Surface habitable de " +
              fmtNumber(DATA.listing.surface) +
              " m\u00b2, confirm\u00e9e par un professionnel, sans tol\u00e9rance \u00e0 la baisse."
          )
        : "") +
      (copro || dpeLabelsHint()
        ? clauseToggle(
            "docs",
            copro ? "DPE, copropri\u00e9t\u00e9 et travaux vot\u00e9s" : "DPE annonc\u00e9",
            (dpeLabelsHint() ? dpeLabelsHint() + (copro ? ", " : ".") : "") +
              (copro
                ? (dpeLabelsHint() ? "absence" : "Absence") +
                  " de proc\u00e9dure en cours, quote-part travaux vot\u00e9s plafonn\u00e9e \u00e0 " +
                  euro(OFFER_COPRO_WORKS_QUOTE_CAP) +
                  " (appels de fonds post-vente \u00e0 la charge du vendeur)."
                : "")
          )
        : "") +
      "</div>" +
      '<p class="offer-view__note">' +
      icon("shield") +
      " Urbanisme, servitudes et diagnostics ne sont pas pos\u00e9s comme conditions g\u00e9n\u00e9rales\u00a0: des formules comme \u00ab\u00a0sans anomalie majeure\u00a0\u00bb sont trop vagues pour vous prot\u00e9ger. Le notaire les v\u00e9rifie en pr\u00e9parant l'avant-contrat." +
      "</p>" +
      "</div>"
    );
  }

  function renderEmail() {
    if (!S.emailEdited) S.emailText = buildEmail();
    var subject = emailSubject();
    return (
      '<div class="offer-view offer-view--email" data-step-anim>' +
      stepHead(
        "\u00c9tape 4",
        "Votre email est pr\u00eat",
        "Relisez-le, ajustez si besoin, puis copiez-le ou ouvrez-le dans votre messagerie."
      ) +
      '<div class="offer-email">' +
      '<div class="offer-email__subject"><span class="offer-field__label">Objet</span><span>' +
      esc(subject) +
      "</span></div>" +
      '<textarea class="textarea offer-email__text" data-offer-field="emailText" rows="16" aria-label="Texte de l\'email">' +
      esc(S.emailText) +
      "</textarea>" +
      "</div>" +
      '<div class="offer-email__actions">' +
      '<button type="button" class="btn btn--ghost btn--sm" data-offer-action="reset-email">' +
      icon("reset") +
      " R\u00e9initialiser</button>" +
      '<div class="offer-email__actions-right">' +
      '<button type="button" class="btn btn--ghost btn--sm" data-offer-action="copy">' +
      icon("copy") +
      " Copier</button>" +
      '<button type="button" class="btn btn--green btn--sm" data-offer-action="mailto">' +
      icon("message") +
      " Ouvrir dans ma messagerie</button>" +
      "</div></div>" +
      '<p class="offer-view__note offer-view__note--warn">' +
      icon("alert") +
      " R\u00e9daction de travail, pas un avis juridique. Une offre accept\u00e9e sans r\u00e9serve peut vous engager\u00a0: faites valider par le notaire la formulation de la condition de surface et compl\u00e9tez les champs entre crochets avant l'envoi." +
      "</p>" +
      "</div>"
    );
  }

  /* ----------------------------- Email (modèle) ----------------------------- */

  function propertyTypeLabel() {
    return (DATA.listing.property_type_label || "bien").toLowerCase();
  }

  function propertyWithArticle() {
    var label = propertyTypeLabel();
    if (label === "appartement") return "l'appartement";
    if (label === "maison") return "la maison";
    if (label.charAt(0) === "a" || label.charAt(0) === "e" || label.charAt(0) === "i" || label.charAt(0) === "o" || label.charAt(0) === "u" || label.charAt(0) === "h") {
      return "l'" + label;
    }
    return "le " + label;
  }

  function propertyLocationForSubject() {
    var addr = propertyAddressLine();
    if (addr) return addr;
    var l = DATA.listing;
    if (l.city) {
      return l.city + (l.postal_code ? " (" + l.postal_code + ")" : "");
    }
    return "[adresse]";
  }

  function propertyLocationInline() {
    var addr = propertyAddressLine();
    if (addr) return addr;
    var l = DATA.listing;
    if (l.city) {
      return l.city + (l.postal_code ? " (" + l.postal_code + ")" : "");
    }
    return "[adresse]";
  }

  function emailSubject() {
    return (
      "Offre d'achat sous conditions \u2013 " +
      propertyTypeLabel() +
      " situ\u00e9 \u00e0 " +
      propertyLocationForSubject()
    );
  }

  function buyerValue(key, placeholder) {
    var v = S.identitySkipped ? "" : String(S.buyer[key] || "").trim();
    return v || placeholder;
  }

  /** « D ou mieux » ; « G » seul (rien de pire). */
  function classAtLeast(letter) {
    return letter === "G" ? "G" : letter + " ou mieux";
  }

  /** Condition DPE bâtie sur les étiquettes annoncées ; null si l'annonce n'en donne aucune. */
  function dpeConditionText() {
    var dpe = DATA.listing.dpe;
    var ges = DATA.listing.ges;
    if (!dpe && !ges) return null;
    var parts = [];
    if (dpe) parts.push(classAtLeast(dpe) + " en classe \u00e9nergie");
    if (ges) parts.push(classAtLeast(ges) + " en classe climat");
    return (
      "le DPE valide confirme " +
      (parts.length > 1 ? "les classes annonc\u00e9es" : "la classe annonc\u00e9e") +
      " et classe le logement " +
      parts.join(" et ")
    );
  }

  /** Écart sous lequel l'offre est considérée « au prix » : aucune justification. */
  var PRICE_JUSTIFY_MIN_GAP = 0.01;
  /** Au-delà, la baisse est jugée significative et le ton plus explicatif. */
  var PRICE_JUSTIFY_STRONG_GAP = 0.07;

  function marketScopePhrase(m) {
    var what = m.type_plural || "biens";
    var ofWhat = /^[aeiouh]/i.test(what) ? "d'" + what : "de " + what;
    if (m.key === "radius") {
      return (
        "les ventes " +
        ofWhat +
        " comparables enregistr\u00e9es dans la base DVF" +
        (m.meters ? " \u00e0 moins de " + fmtNumber(m.meters) + " m du bien" : " autour du bien")
      );
    }
    if (m.key === "quartier") {
      return "les prix de vente des " + what + " du quartier (base DVF)";
    }
    return "les prix de vente des " + what + " de la commune (base DVF)";
  }

  /**
   * Paragraphe de négociation sous le prix : travaux et référence DVF, sur un
   * ton mesuré. Vide si l'offre est au prix (ou au-dessus).
   */
  function priceJustification() {
    var l = DATA.listing;
    var listed = Number(l.price) || 0;
    if (!(listed > 0) || !(S.offerPrice > 0)) return "";
    var gap = (listed - S.offerPrice) / listed;
    if (gap < PRICE_JUSTIFY_MIN_GAP) return "";

    var strong = gap >= PRICE_JUSTIFY_STRONG_GAP;
    var surface = Number(l.surface) || 0;
    var m = DATA.market;
    var listedM2 = surface > 0 ? listed / surface : 0;
    var marketLower = Boolean(m && m.price_m2 > 0 && listedM2 > 0 && m.price_m2 < listedM2);
    var marketEstimate = marketLower && surface > 0 ? roundCost(m.price_m2 * surface) : 0;
    var hasWorks = S.works > 0;

    var parts = [];
    parts.push(
      strong
        ? "Je mesure que ce montant s'\u00e9carte du prix affich\u00e9, et je tiens \u00e0 vous en expliquer les raisons en toute transparence, sans rien enlever aux qualit\u00e9s du bien, qui nous a beaucoup plu."
        : "Le bien nous a beaucoup plu, et ma proposition, l\u00e9g\u00e8rement en de\u00e7\u00e0 du prix affich\u00e9, tient compte de quelques \u00e9l\u00e9ments que je pr\u00e9f\u00e8re vous exposer simplement."
    );

    if (hasWorks) {
      parts.push(
        (marketLower ? "D'une part, l" : "L") +
          "e logement n\u00e9cessite des travaux de r\u00e9novation que j'estime, \u00e0 ce stade, \u00e0 environ " +
          euro(S.works) +
          "\u00a0; c'est un budget important que je dois int\u00e9grer \u00e0 mon projet d\u00e8s aujourd'hui."
      );
    }

    if (marketLower) {
      parts.push(
        (hasWorks ? "D'autre part, " : "En effet, ") +
          marketScopePhrase(m) +
          " font ressortir un prix m\u00e9dian d'environ " +
          fmtNumber(m.price_m2) +
          "\u00a0\u20ac/m\u00b2" +
          (marketEstimate
            ? ", soit de l'ordre de " + euro(marketEstimate) + " pour " + fmtNumber(surface) + "\u00a0m\u00b2"
            : "") +
          ", contre " +
          fmtNumber(Math.round(listedM2)) +
          "\u00a0\u20ac/m\u00b2 pour le prix affich\u00e9."
      );
      if (hasWorks && marketEstimate && S.offerPrice + S.works <= marketEstimate * 1.05) {
        parts.push(
          "Travaux compris, mon offre me para\u00eet ainsi coh\u00e9rente avec la valeur constat\u00e9e sur le secteur."
        );
      }
    }

    if (!hasWorks && !marketLower) {
      parts.push(
        "Ce montant correspond au budget global que je peux raisonnablement consacrer \u00e0 cette acquisition, frais compris."
      );
    }

    parts.push(
      strong
        ? "J'esp\u00e8re que vous et le vendeur y verrez une proposition r\u00e9fl\u00e9chie et s\u00e9rieuse, et je reste bien s\u00fbr ouvert \u00e0 en \u00e9changer."
        : "Je reste naturellement ouvert \u00e0 en \u00e9changer avec vous."
    );

    return parts.join(" ");
  }

  function buildEmail() {
    var l = DATA.listing;
    var copro = isApartment();
    var lines = [];
    var surfaceOn = S.clauses.surface && l.surface;
    var loanOn = S.clauses.loan;
    var loanCap = loanAmountForEmail();

    lines.push("Madame, Monsieur,");
    lines.push("");
    lines.push(
      "Je vous propose d'acqu\u00e9rir " +
        propertyWithArticle() +
        " que nous avons visit\u00e9, situ\u00e9 " +
        propertyLocationInline() +
        ", au prix de " +
        euro(S.offerPrice) +
        "."
    );
    lines.push("");
    var justification = priceJustification();
    if (justification) {
      lines.push(justification);
      lines.push("");
    }

    if (surfaceOn) {
      lines.push(
        "Mon offre est fond\u00e9e sur une surface habitable de " +
          fmtNumber(l.surface) +
          " m\u00b2, qui constitue une condition d\u00e9terminante\u00a0: un mesurage effectu\u00e9 par un professionnel devra confirmer une surface d'au moins " +
          fmtNumber(l.surface) +
          " m\u00b2, sans tol\u00e9rance \u00e0 la baisse. \u00c0 d\u00e9faut, mon engagement deviendra caduc sans indemnit\u00e9."
      );
      lines.push("");
    }

    var dpeCondition = dpeConditionText();
    if (S.clauses.docs && (dpeCondition || copro)) {
      lines.push("Mon offre est \u00e9galement soumise aux conditions suivantes\u00a0:");
      if (dpeCondition) lines.push("- " + dpeCondition + "\u00a0;");
      if (copro) {
        lines.push(
          "- aucune proc\u00e9dure judiciaire n'est en cours concernant le syndicat des copropri\u00e9taires ou une d\u00e9cision d'assembl\u00e9e g\u00e9n\u00e9rale\u00a0;"
        );
        lines.push(
          "- aucun travail vot\u00e9 ou mentionn\u00e9 comme projet dans les proc\u00e8s-verbaux des assembl\u00e9es g\u00e9n\u00e9rales des trois derni\u00e8res ann\u00e9es, le plan pluriannuel de travaux ou un devis communiqu\u00e9 n'entra\u00eene pour moi une quote-part sup\u00e9rieure \u00e0 " +
            euro(OFFER_COPRO_WORKS_QUOTE_CAP) +
            ". La quote-part inclura les appels de fonds exigibles apr\u00e8s la vente\u00a0; ceux-ci seront pris en charge par le vendeur, selon une stipulation expresse dans l'acte de vente."
        );
      }
      lines.push("");
    }

    if (loanOn) {
      lines.push(
        "Pour financer l'acquisition, je pr\u00e9vois un apport personnel de " +
          (S.downPayment > 0 ? euro(S.downPayment) : "[XXX \u20ac]") +
          " et un pr\u00eat de " +
          (loanCap > 0 ? euro(loanCap) : "[XXX \u20ac]") +
          ", sur " +
          (S.loanYears > 0 ? S.loanYears : "[dur\u00e9e]") +
          " ans, \u00e0 un taux nominal maximal de " +
          (S.loanRateMax > 0 ? fmtDecimal(S.loanRateMax, 2) : "[XX %]") +
          " hors assurance."
      );
      lines.push("");
    }

    lines.push(
      "La pr\u00e9sente offre est valable jusqu'au " +
        validityDate() +
        " \u00e0 " +
        OFFER_ACCEPTANCE_DEADLINE_HOUR +
        ". Elle devra \u00eatre accept\u00e9e par \u00e9crit, sans r\u00e9serve et avec l'ensemble de ces conditions, avant cette \u00e9ch\u00e9ance."
    );
    lines.push("");
    lines.push("Cordialement,");
    lines.push("");
    lines.push(buyerValue("name", "[Nom, pr\u00e9nom]"));
    lines.push(buyerValue("phone", "[T\u00e9l\u00e9phone]"));

    return lines.join("\n");
  }

  /* ----------------------------- Actions email ----------------------------- */

  function copyEmail() {
    var text = S.emailText;
    function done() {
      toast("Email copi\u00e9 dans le presse-papiers.");
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        fallbackCopy(text);
        done();
      });
    } else {
      fallbackCopy(text);
      done();
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "absolute";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (err) {
      /* ignore */
    }
    document.body.removeChild(ta);
  }

  function openMailto() {
    var to = (DATA.listing.agency && DATA.listing.agency.email) || "";
    var href =
      "mailto:" +
      encodeURIComponent(to) +
      "?subject=" +
      encodeURIComponent(emailSubject()) +
      "&body=" +
      encodeURIComponent(S.emailText);
    window.location.href = href;
  }

  /* ----------------------------- Toast ----------------------------- */

  var toastTimer = null;
  function toast(message) {
    if (!toastEl) return;
    window.clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.hidden = false;
    toastEl.classList.remove("is-leaving");
    toastTimer = window.setTimeout(function () {
      toastEl.classList.add("is-leaving");
      window.setTimeout(
        function () {
          toastEl.hidden = true;
          toastEl.classList.remove("is-leaving");
        },
        reducedMotion ? 0 : 200
      );
    }, 3200);
  }

  /* ----------------------------- Navigation ----------------------------- */

  function render() {
    renderSteps();
    var def = STEPS[S.step];
    body.innerHTML = def.render();
    updateFooter();
    var firstInput = body.querySelector("input, textarea");
    if (firstInput && def.id !== "email") {
      firstInput.focus({ preventScroll: true });
    }
    body.scrollTop = 0;
  }

  function updateFooter() {
    var def = STEPS[S.step];
    prevBtn.hidden = S.step === 0;
    skipBtn.hidden = def.id !== "identity" || S.identitySkipped;
    if (def.last) {
      nextBtn.hidden = true;
      if (closeBtn) closeBtn.hidden = false;
    } else {
      nextBtn.hidden = false;
      if (closeBtn) closeBtn.hidden = true;
      nextBtn.innerHTML =
        "Continuer " + icon("chevron-right");
    }
  }

  function goTo(index) {
    if (index < 0 || index >= STEPS.length) return;
    if (index > S.step) return; // on ne saute pas en avant via l'indicateur
    S.step = index;
    render();
  }

  function next() {
    if (S.step >= STEPS.length - 1) return;
    S.step += 1;
    render();
  }

  function prev() {
    if (S.step <= 0) return;
    S.step -= 1;
    render();
  }

  function skip() {
    if (STEPS[S.step].id !== "identity") return;
    S.identitySkipped = true;
    S.emailEdited = false; // régénère l'email avec les placeholders
    next();
  }

  /* ----------------------------- Événements ----------------------------- */

  modal.addEventListener("input", function (event) {
    var fieldName = event.target.getAttribute("data-offer-field");
    if (!fieldName) return;
    var value = event.target.value;
    if (fieldName === "offerPrice") {
      S.offerPrice = parseAmount(value);
      updatePriceGap();
      updateOfferRecap();
      S.emailEdited = false;
    } else if (fieldName === "downPayment") {
      S.downPayment = parseAmount(value);
      updateOfferRecap();
      S.emailEdited = false;
    } else if (fieldName === "validityDays") {
      var days = parseAmount(value);
      S.validityDays = Math.min(Math.max(days, 1), 90);
      updateValidityHint();
      S.emailEdited = false;
    } else if (fieldName === "loanRateMax") {
      S.loanRateMax = parseDecimal(value);
      S.emailEdited = false;
    } else if (fieldName === "loanYears") {
      S.loanYears = parseAmount(value);
      S.emailEdited = false;
    } else if (fieldName === "buyer.phone") {
      var formattedPhone = formatPhone(value);
      S.buyer.phone = formattedPhone;
      S.emailEdited = false;
      if (event.target.value !== formattedPhone) {
        event.target.value = formattedPhone;
      }
    } else if (fieldName.indexOf("buyer.") === 0) {
      S.buyer[fieldName.slice(6)] = value;
      S.emailEdited = false;
    } else if (fieldName === "emailText") {
      S.emailText = value;
      S.emailEdited = true;
    }
  });

  modal.addEventListener("change", function (event) {
    var fieldName = event.target.getAttribute("data-offer-field");
    if (!fieldName) return;
    if (fieldName.indexOf("clauses.") !== 0) return;
    S.clauses[fieldName.slice(8)] = event.target.checked;
    S.emailEdited = false;
    var label = event.target.closest(".offer-clause");
    if (label) label.classList.toggle("is-on", event.target.checked);
  });

  modal.addEventListener("click", function (event) {
    var t = event.target;
    if (t.closest("[data-offer-dismiss]") || t.closest("[data-offer-close]")) return close();

    var gotoEl = t.closest("[data-offer-goto]");
    if (gotoEl && !gotoEl.disabled) return goTo(Number(gotoEl.getAttribute("data-offer-goto")));

    var actionEl = t.closest("[data-offer-action]");
    if (actionEl) {
      var action = actionEl.getAttribute("data-offer-action");
      if (action === "identity-resume") {
        S.identitySkipped = false;
        S.emailEdited = false;
        render();
        return;
      }
      if (action === "reset-email") {
        S.emailEdited = false;
        render();
        return;
      }
      if (action === "copy") return copyEmail();
      if (action === "mailto") return openMailto();
    }

    if (t.closest("[data-offer-prev]")) return prev();
    if (t.closest("[data-offer-skip]")) return skip();
    if (t.closest("[data-offer-next]")) return next();
  });

  function updatePriceGap() {
    var holder = body.querySelector("[data-offer-price-gap]");
    if (!holder) return;
    holder.innerHTML = priceGapHtml();
  }

  function updateOfferRecap() {
    var block = body.querySelector("[data-offer-recap]");
    if (!block) return;
    block.innerHTML = financeRecapInner();
  }

  function updateValidityHint() {
    var holder = body.querySelector("[data-offer-validity-hint]");
    if (!holder) return;
    holder.innerHTML =
      "Jusqu'au <strong>" +
      esc(validityDate()) +
      "</strong> \u00e0 " +
      OFFER_ACCEPTANCE_DEADLINE_HOUR +
      ", heure de Paris.";
  }

  modal.addEventListener("keydown", function (event) {
    if (modal.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      return close();
    }
    if (event.key === "Tab") return trapFocus(event);
  });

  function trapFocus(event) {
    var focusables = Array.prototype.filter.call(
      dialog.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ),
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
    } else if (!dialog.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    }
  }

  /* ----------------------------- Ouverture ----------------------------- */

  function open() {
    S.lastFocus = document.activeElement;
    S.step = 0;
    modal.hidden = false;
    document.body.classList.add("is-modal-open");
    render();
  }

  function close() {
    if (modal.hidden) return;
    modal.hidden = true;
    document.body.classList.remove("is-modal-open");
    if (S.lastFocus && S.lastFocus.isConnected) {
      S.lastFocus.focus({ preventScroll: true });
    }
  }

  // Ouverture déléguée : le bouton vit dans un fragment re-rendu au changement
  // de statut (#listing-lead), la modale reste dans la page.
  document.addEventListener("click", function (event) {
    var trigger = event.target.closest
      ? event.target.closest("[data-offer-open]")
      : null;
    if (!trigger || modal.contains(trigger)) return;
    event.preventDefault();
    open();
  });
})();
