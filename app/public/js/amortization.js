/**
 * Tableau d'amortissement (page admin). Le calcul fait autorité côté serveur
 * (`POST /admin/amortissement`) ; cette page se contente de collecter les
 * paramètres, d'appeler le serveur en debounce et de rendre le résultat.
 */
(function () {
  "use strict";

  var root = document.querySelector("[data-amort]");
  if (!root) return;

  var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || "";
  var form = root.querySelector("[data-amort-form]");
  var startPickerEl = form && form.querySelector("[data-amort-start-picker]");
  if (startPickerEl && window.CalendarPicker) {
    window.CalendarPicker.mountSingleDay(startPickerEl, {
      storeAsMonth: false,
      placeholder: "Choisir une date de début",
    });
  }
  var summaryEmpty = root.querySelector("[data-amort-empty]");
  var summaryBody = root.querySelector("[data-amort-body]");
  var tableWrap = root.querySelector("[data-amort-table-wrap]");
  var rowsBody = root.querySelector("[data-amort-rows]");
  var countEl = root.querySelector("[data-amort-count]");
  var tableTotalsEl = root.querySelector("[data-amort-table-totals]");

  var euro = new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  });
  var euroCents = new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  var dateFmt = new Intl.DateTimeFormat("fr-FR", { month: "short", year: "numeric" });

  function parseNumber(value) {
    var raw = String(value || "").replace(/\s/g, "").replace(",", ".").replace(/[^0-9.\-]/g, "");
    var n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  function formatDate(iso) {
    if (!iso) return "—";
    var t = Date.parse(iso + "T12:00:00Z");
    if (Number.isNaN(t)) return "—";
    return dateFmt.format(new Date(t));
  }

  function readParams() {
    var data = new FormData(form);
    return {
      amount: parseNumber(data.get("amount")),
      years: parseNumber(data.get("years")),
      interestRate: parseNumber(data.get("interestRate")) / 100,
      insuranceRate: parseNumber(data.get("insuranceRate")) / 100,
      deferredMonths: parseNumber(data.get("deferredMonths")),
      startDate: String(data.get("startDate") || "") || null,
    };
  }

  function setText(container, key, value) {
    if (!container) return;
    var el = container.querySelector('[data-k="' + key + '"]');
    if (el) el.textContent = value;
  }

  function renderSummary(summary) {
    var hasDeferral = summary.deferredMonths > 0;

    setText(summaryBody, "amortizingMonthlyTotal", euroCents.format(summary.amortizingMonthlyTotal));
    setText(
      summaryBody,
      "amortizingMonthlyTotalSub",
      "dont " +
        euroCents.format(summary.amortizingPayment) +
        " de crédit" +
        (summary.monthlyInsurance > 0
          ? " + " + euroCents.format(summary.monthlyInsurance) + " d'assurance"
          : "")
    );
    setText(summaryBody, "firstMonthlyTotal", euroCents.format(summary.firstMonthlyTotal));
    setText(summaryBody, "totalCreditCost", euro.format(summary.totalCreditCost));
    setText(summaryBody, "totalInterest", euro.format(summary.totalInterest));
    setText(summaryBody, "totalInsurance", euro.format(summary.totalInsurance));
    setText(summaryBody, "totalRepaid", euro.format(summary.totalRepaid));
    setText(summaryBody, "endDate", formatDate(summary.endDate));

    setText(tableTotalsEl, "tableTotalInterest", euro.format(summary.totalInterest));
    setText(tableTotalsEl, "tableTotalInsurance", euro.format(summary.totalInsurance));
    setText(tableTotalsEl, "tableTotalRepaid", euro.format(summary.totalRepaid));

    var deferredRow = summaryBody.querySelector("[data-row-deferred]");
    if (deferredRow) deferredRow.hidden = !hasDeferral;
    var endRow = summaryBody.querySelector("[data-row-end]");
    if (endRow) endRow.hidden = !summary.endDate;
  }

  function renderRows(rows) {
    var html = "";
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i];
      html +=
        '<tr class="amort__row' +
        (r.deferred ? " amort__row--deferred" : "") +
        '">' +
        "<td>" + r.index + "</td>" +
        "<td>" + formatDate(r.date) + "</td>" +
        '<td class="amort__num">' + euroCents.format(r.total) + "</td>" +
        '<td class="amort__num">' + euroCents.format(r.principal) + "</td>" +
        '<td class="amort__num">' + euroCents.format(r.interest) + "</td>" +
        '<td class="amort__num">' + euroCents.format(r.insurance) + "</td>" +
        '<td class="amort__num">' + euroCents.format(r.balance) + "</td>" +
        "</tr>";
    }
    rowsBody.innerHTML = html;
  }

  function render(result) {
    if (!result || !result.rows || !result.rows.length) {
      summaryEmpty.hidden = false;
      summaryBody.hidden = true;
      tableWrap.hidden = true;
      return;
    }
    summaryEmpty.hidden = true;
    summaryBody.hidden = false;
    tableWrap.hidden = false;
    renderSummary(result.summary);
    renderRows(result.rows);
    countEl.textContent =
      result.rows.length + " échéance" + (result.rows.length > 1 ? "s" : "");
  }

  var controller = null;
  function compute() {
    var params = readParams();
    if (!(params.amount > 0) || !(params.years > 0)) {
      render(null);
      return;
    }
    if (controller) controller.abort();
    controller = new AbortController();
    fetch("/admin/amortissement", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
        Accept: "application/json",
      },
      body: JSON.stringify(params),
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        if (data) render(data);
      })
      .catch(function (err) {
        if (err && err.name !== "AbortError") render(null);
      });
  }

  var timer = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(compute, 250);
  }

  form.addEventListener("input", schedule);
  form.addEventListener("change", schedule);
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    compute();
  });

  compute();
})();
