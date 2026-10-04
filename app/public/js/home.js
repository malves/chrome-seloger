/**
 * Page d'accueil :
 *  - apparition des sections au défilement ;
 *  - bouton « Rejouer » de la démo du hero (l'animation elle-même est en CSS).
 */

(function () {
  "use strict";

  var home = document.querySelector(".home");
  if (!home) return;

  if ("IntersectionObserver" in window) {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -12% 0px" }
    );
    home.classList.add("reveal-on");
    home.querySelectorAll("[data-reveal]").forEach(function (el) {
      observer.observe(el);
    });
  }

  var demo = home.querySelector("[data-demo]");
  var replay = demo && demo.querySelector("[data-demo-replay]");
  if (!replay) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  var note = demo.querySelector(".demo__note");
  var save = demo.querySelector(".demo__save-done");
  function showReplay(event) {
    if (event.animationName === "h-note" || event.animationName === "h-fade") {
      replay.hidden = false;
    }
  }
  if (note) note.addEventListener("animationend", showReplay);
  if (save) save.addEventListener("animationend", showReplay);

  replay.addEventListener("click", function () {
    replay.hidden = true;
    demo.classList.remove("demo--animate");
    void demo.offsetWidth;
    demo.classList.add("demo--animate");
  });
})();
