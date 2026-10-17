/**
 * Démos interactives de la page /admin/design-system (calendrier jour unique).
 */
(function () {
  "use strict";

  if (!window.CalendarPicker) return;

  document.querySelectorAll("[data-ds-cal-demo]").forEach(function (picker) {
    window.CalendarPicker.mountSingleDay(picker, {
      storeAsMonth: false,
      placeholder: picker.getAttribute("data-date-placeholder") || "Choisir une date",
    });
  });
})();
