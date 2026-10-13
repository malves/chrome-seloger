/**
 * Interrupteur jour/nuit « ours grincheux » du header : quand on passe en
 * nuit, un ours vient remettre le jour, de plus en plus visible et énervé.
 * Les durées d'attente suivent les transitions CSS de .bear-toggle.
 */

(function () {
  "use strict";

  var root = document.querySelector("[data-bear-toggle]");
  if (!root) return;
  var input = root.querySelector("[data-bear-input]");

  function randInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  var headLimit = randInt(2, 4);
  var angerLimit = randInt(headLimit + 1, headLimit + 3);
  var count = 1;
  var busy = false;

  function setBear(y) {
    root.style.setProperty("--bear-y", y);
  }

  function setArm(x) {
    root.style.setProperty("--arm-x", x);
  }

  async function switchOff() {
    await wait(250 + Math.random() * 1000);
    setBear(count >= headLimit ? "0%" : "40%");
    await wait(250);
    if (count > angerLimit && Math.random() > 0.5) {
      root.classList.add("is-swearing");
    }
    await wait(Math.random() * 1000);
    setArm("-16px");
    await wait(300);
    root.classList.remove("is-on");
    input.checked = false;
    setArm("-39px");
    await wait(300);
    root.classList.remove("is-swearing");
    setArm("0px");
    setBear("100%");
    await wait(300);
    count += 1;
    root.classList.toggle("is-angry", count >= angerLimit);
    busy = false;
  }

  root.addEventListener("mouseenter", function () {
    if (!busy && Math.random() > 0.5) setBear("40%");
  });

  root.addEventListener("mouseleave", function () {
    if (!busy) setBear("100%");
  });

  input.addEventListener("change", function () {
    if (busy) {
      input.checked = root.classList.contains("is-on");
      return;
    }
    busy = true;
    root.classList.add("is-on", "was-on");
    switchOff();
  });
})();
