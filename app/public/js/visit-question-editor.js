/**
 * Admin « Questions de visite » : formulaire d'édition d'une question.
 *
 * - blocs du formulaire affichés selon le type de réponse ;
 * - options et notes au bilan : ajout, retrait, ordre (monter / descendre) ;
 *   les champs sont renumérotés à chaque changement (`opt_label_0`, …) pour
 *   que l'ordre envoyé soit l'ordre affiché ;
 * - valeur de la condition masquée quand la condition n'en attend pas.
 */
(function () {
  "use strict";

  var form = document.querySelector("[data-question-editor]");
  if (!form) return;

  var ARG_HINTS = {
    values: "Identifiants des options, séparés par des virgules",
    number: "Nombre",
    count: "clé:nombre (ex. refaire:1)",
  };

  var typeInput = form.querySelector("[data-input-type]");
  var optionsBlock = form.querySelector("[data-options-block]");

  function currentType() {
    return typeInput ? typeInput.value : "";
  }

  function syncTypeBlocks() {
    var type = currentType();
    form.querySelectorAll("[data-type-block]").forEach(function (block) {
      var types = (block.getAttribute("data-types") || "").split(" ");
      block.hidden = types.indexOf(type) === -1;
    });
    if (optionsBlock) optionsBlock.classList.toggle("is-scale", type === "scale");
    var placeholderLabel = form.querySelector("[data-placeholder-label]");
    if (placeholderLabel) {
      placeholderLabel.textContent = placeholderLabel.getAttribute(
        type === "yesno_number" ? "data-label-amount" : "data-label-text"
      );
    }
  }

  /** Renumérote name / id / for des lignes d'une liste. */
  function renumber(list) {
    var rows = Array.prototype.slice.call(list.children);
    rows.forEach(function (row, index) {
      row.querySelectorAll("[data-name]").forEach(function (el) {
        var base = el.getAttribute("data-name");
        el.name = base + "_" + index;
        if (el.id) el.id = base + "_" + index;
      });
      row.querySelectorAll("[data-for]").forEach(function (label) {
        label.setAttribute("for", label.getAttribute("data-for") + "_" + index);
      });
      var up = row.querySelector('[data-row-move="-1"]');
      var down = row.querySelector('[data-row-move="1"]');
      if (up) up.disabled = index === 0;
      if (down) down.disabled = index === rows.length - 1;
    });
    var empty = list.parentElement.querySelector("[data-option-empty], [data-signal-empty]");
    if (empty) empty.hidden = rows.length > 0;
  }

  function syncSignalArg(row) {
    var select = row.querySelector("[data-signal-kind]");
    var field = row.querySelector("[data-signal-arg]");
    if (!select || !field) return;
    var option = select.options[select.selectedIndex];
    var arg = option ? option.getAttribute("data-arg") : "";
    field.hidden = !arg;
    var hint = field.querySelector("[data-signal-arg-hint]");
    if (hint) hint.textContent = ARG_HINTS[arg] || "";
  }

  function addRow(list, template) {
    if (!list || !template) return;
    var fragment = template.content.cloneNode(true);
    var row = fragment.firstElementChild;
    list.appendChild(fragment);
    renumber(list);
    if (row) {
      if (row.matches("[data-signal-row]")) syncSignalArg(row);
      var first = row.querySelector("input:not([type=hidden]), select, textarea");
      if (first) first.focus();
    }
  }

  var optionList = form.querySelector("[data-option-list]");
  var signalList = form.querySelector("[data-signal-list]");
  var optionTemplate = form.querySelector("[data-option-template]");
  var signalTemplate = form.querySelector("[data-signal-template]");

  form.addEventListener("click", function (event) {
    var target = event.target;
    if (target.closest("[data-option-add]")) {
      addRow(optionList, optionTemplate);
      return;
    }
    if (target.closest("[data-signal-add]")) {
      addRow(signalList, signalTemplate);
      return;
    }
    var move = target.closest("[data-row-move]");
    if (move) {
      var row = move.closest("[data-option-row], [data-signal-row]");
      var list = row && row.parentElement;
      if (!list) return;
      if (move.getAttribute("data-row-move") === "-1" && row.previousElementSibling) {
        list.insertBefore(row, row.previousElementSibling);
      } else if (move.getAttribute("data-row-move") === "1" && row.nextElementSibling) {
        list.insertBefore(row.nextElementSibling, row);
      }
      renumber(list);
      if (!move.disabled) move.focus();
      return;
    }
    var remove = target.closest("[data-row-remove]");
    if (remove) {
      var gone = remove.closest("[data-option-row], [data-signal-row]");
      var parent = gone && gone.parentElement;
      if (!parent) return;
      var next = gone.nextElementSibling || gone.previousElementSibling;
      gone.remove();
      renumber(parent);
      var focusTarget = next
        ? next.querySelector("input:not([type=hidden]), select, textarea")
        : form.querySelector(parent === optionList ? "[data-option-add]" : "[data-signal-add]");
      if (focusTarget) focusTarget.focus();
    }
  });

  form.addEventListener("change", function (event) {
    if (event.target === typeInput) syncTypeBlocks();
    if (event.target.matches("[data-signal-kind]")) {
      syncSignalArg(event.target.closest("[data-signal-row]"));
    }
  });

  if (optionList) renumber(optionList);
  if (signalList) {
    renumber(signalList);
    signalList.querySelectorAll("[data-signal-row]").forEach(syncSignalArg);
  }
  syncTypeBlocks();
})();
