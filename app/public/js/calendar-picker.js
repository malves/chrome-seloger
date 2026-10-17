/**
 * Calendrier en grille (même UI que l'import DPE admin).
 * Mode « single » : un clic choisit un jour ; la valeur peut être stockée en AAAA-MM.
 */
(function (global) {
  var MONTHS = [
    "janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre",
  ];
  var SHORT_MONTHS = [
    "janv.", "févr.", "mars", "avr.", "mai", "juin",
    "juil.", "août", "sept.", "oct.", "nov.", "déc.",
  ];

  function isoDate(d) {
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  function isoMonth(d) {
    return isoDate(d).slice(0, 7);
  }

  function parseMonth(value) {
    if (!value || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null;
    var parts = value.split("-");
    return new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
  }

  function sameDay(a, b) {
    return a && b && a.getTime() === b.getTime();
  }

  /**
   * @param {HTMLElement} picker — conteneur `.date-range-picker`
   * @param {{ storeAsMonth?: boolean, disableFuture?: boolean, placeholder?: string, onChange?: function }} options
   */
  function mountSingleDayPicker(picker, options) {
    options = options || {};
    var storeAsMonth = options.storeAsMonth !== false;
    var disableFuture = options.disableFuture === true;
    var placeholder =
      options.placeholder ||
      picker.getAttribute("data-debt-day-placeholder") ||
      "Choisir une date";

    var root = picker.querySelector("[data-calendar]");
    var grid = root && root.querySelector("[data-cal-grid]");
    var title = root && root.querySelector("[data-cal-title]");
    var prev = root && root.querySelector("[data-cal-prev]");
    var next = root && root.querySelector("[data-cal-next]");
    var hidden = picker.querySelector('input[type="hidden"][data-field]');
    var trigger = picker.querySelector("[data-cal-trigger]");
    var triggerLabel = picker.querySelector("[data-cal-trigger-label]");
    var popover = picker.querySelector("[data-cal-popover]");
    var hint = picker.querySelector("[data-cal-hint]");
    var weekdays = root && root.querySelector(".calendar__weekdays");
    var mode = "days";

    if (!root || !grid || !hidden || !trigger || !popover) return null;

    var monthFmt = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" });
    var longFmt = new Intl.DateTimeFormat("fr-FR", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    var today = new Date();
    today.setHours(0, 0, 0, 0);

    var selected = null;
    var view = new Date(today.getFullYear(), today.getMonth(), 1);
    var popoverOpen = false;
    var cells = [];

    function readHidden() {
      var raw = String(hidden.value || "").trim();
      if (storeAsMonth) return parseMonth(raw);
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        var p = raw.split("-").map(Number);
        return new Date(p[0], p[1] - 1, p[2]);
      }
      return null;
    }

    function writeHidden(date) {
      if (!date) {
        hidden.value = "";
      } else {
        hidden.value = storeAsMonth ? isoMonth(date) : isoDate(date);
      }
    }

    function formatLabel(date) {
      if (!date) return placeholder;
      return storeAsMonth ? monthFmt.format(date) : longFmt.format(date);
    }

    function syncTrigger() {
      if (triggerLabel) triggerLabel.textContent = formatLabel(selected);
      if (hint) {
        if (storeAsMonth) {
          hint.textContent = selected
            ? monthFmt.format(selected) + " — titre pour changer d'année."
            : "Un jour du mois suffit. Titre = choix de l'année.";
        } else {
          hint.textContent = selected
            ? "Date enregistrée. Vous pouvez fermer ou en choisir une autre."
            : "Cliquez un jour.";
        }
      }
    }

    function setPopoverOpen(open) {
      popoverOpen = open;
      popover.hidden = !open;
      trigger.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) {
        mode = "days";
        if (selected) {
          view = new Date(selected.getFullYear(), selected.getMonth(), 1);
        }
        render();
      }
    }

    function paintSelection() {
      cells.forEach(function (cell) {
        var btn = cell.btn;
        var date = cell.date;
        btn.classList.remove("is-in-range", "is-start", "is-end", "is-preview");
        if (!selected) return;
        if (storeAsMonth) {
          var sameMonth =
            date.getFullYear() === selected.getFullYear() &&
            date.getMonth() === selected.getMonth();
          if (sameMonth) btn.classList.add("is-in-range");
          return;
        }
        if (sameDay(date, selected)) {
          btn.classList.add("is-in-range", "is-start", "is-end");
        }
      });
    }

    function commit(date) {
      selected = date;
      writeHidden(date);
      syncTrigger();
      paintSelection();
      hidden.dispatchEvent(new Event("change", { bubbles: true }));
      if (typeof options.onChange === "function") options.onChange();
      setPopoverOpen(false);
    }

    function renderMonths() {
      var year = view.getFullYear();
      if (title) title.textContent = String(year);
      grid.classList.add("calendar__grid--months");
      if (weekdays) weekdays.style.display = "none";

      MONTHS.forEach(function (name, index) {
        var date = new Date(year, index, 1);
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "calendar__cell calendar__cell--month";
        btn.textContent = SHORT_MONTHS[index];
        btn.setAttribute("aria-label", name + " " + year);
        if (year === today.getFullYear() && index === today.getMonth()) btn.classList.add("is-today");
        if (selected && selected.getFullYear() === year && selected.getMonth() === index) {
          btn.classList.add("is-in-range", "is-start", "is-end");
        }
        btn.addEventListener("click", function (event) {
          event.stopPropagation();
          if (storeAsMonth) {
            commit(date);
          } else {
            view = date;
            mode = "days";
            render();
          }
        });
        grid.appendChild(btn);
      });
    }

    function render() {
      grid.textContent = "";
      cells = [];
      if (mode === "months") {
        renderMonths();
        return;
      }
      grid.classList.remove("calendar__grid--months");
      if (weekdays) weekdays.style.display = "";
      if (title) title.textContent = MONTHS[view.getMonth()] + " " + view.getFullYear();

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

        var disabled = disableFuture && date.getTime() > today.getTime();
        if (disabled) {
          btn.disabled = true;
          btn.classList.add("is-disabled");
        }
        if (sameDay(date, today)) btn.classList.add("is-today");

        (function (d, isDisabled) {
          btn.addEventListener("click", function (event) {
            event.stopPropagation();
            if (isDisabled) return;
            commit(d);
          });
        })(date, disabled);

        cells.push({ btn: btn, date: date });
        grid.appendChild(btn);
      }

      paintSelection();
    }

    trigger.addEventListener("click", function () {
      setPopoverOpen(!popoverOpen);
    });

    document.addEventListener("click", function (event) {
      if (!popoverOpen || picker.contains(event.target)) return;
      setPopoverOpen(false);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && popoverOpen) {
        event.preventDefault();
        setPopoverOpen(false);
        trigger.focus();
      }
    });

    function shiftView(step) {
      view =
        mode === "months"
          ? new Date(view.getFullYear() + step, view.getMonth(), 1)
          : new Date(view.getFullYear(), view.getMonth() + step, 1);
      render();
    }

    if (prev) {
      prev.addEventListener("click", function (event) {
        event.stopPropagation();
        shiftView(-1);
      });
    }
    if (next) {
      next.addEventListener("click", function (event) {
        event.stopPropagation();
        shiftView(1);
      });
    }
    if (title) {
      title.classList.add("calendar__title--toggle");
      title.setAttribute("role", "button");
      title.setAttribute("tabindex", "0");
      title.title = "Changer de mois ou d'année";
      var toggleMode = function (event) {
        event.stopPropagation();
        mode = mode === "months" ? "days" : "months";
        render();
      };
      title.addEventListener("click", toggleMode);
      title.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleMode(event);
        }
      });
    }

    selected = readHidden();
    syncTrigger();
    render();

    return {
      syncFromHidden: function () {
        selected = readHidden();
        syncTrigger();
        render();
      },
      clear: function () {
        selected = null;
        writeHidden(null);
        syncTrigger();
        render();
        hidden.dispatchEvent(new Event("change", { bubbles: true }));
      },
    };
  }

  global.CalendarPicker = {
    mountSingleDay: mountSingleDayPicker,
  };
})(typeof window !== "undefined" ? window : globalThis);
