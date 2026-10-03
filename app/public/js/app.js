/**
 * Interactions qui ne passent pas par htmx.
 *  - jeton CSRF ajouté automatiquement aux requêtes htmx ;
 *  - confirmation avant suppression ;
 *  - image de remplacement quand une photo distante ne charge plus.
 */

(function () {
  "use strict";

  document.addEventListener("htmx:configRequest", function (event) {
    var meta = document.querySelector('meta[name="csrf-token"]');
    if (meta) event.detail.headers["X-CSRF-Token"] = meta.content;
  });

  // Carnet d'adresses : le retour inline (succès / erreur) s'efface tout seul
  // après quelques secondes, pour ne pas encombrer le panneau.
  document.body.addEventListener("htmx:afterSwap", function (event) {
    var target = event.target;
    if (!target || !target.querySelector) return;
    var flash = target.querySelector("[data-address-flash]");
    if (!flash) return;
    window.setTimeout(function () {
      flash.classList.add("address-book__flash--out");
      window.setTimeout(function () {
        if (flash.parentNode) flash.parentNode.removeChild(flash);
      }, 400);
    }, 3500);
  });

  // Formulaires de filtres : soumission dès qu'un contrôle change.
  // En écouteur délégué plutôt qu'en attribut `onchange`, interdit par la CSP.
  document.addEventListener("change", function (event) {
    var form = event.target.closest("form[data-autosubmit]");
    if (form && event.target.tagName === "SELECT") form.requestSubmit();
  });

  // Confirmation avant une action destructrice, via une modale maison.
  // Les formulaires concernés portent un attribut `data-confirm` (message),
  // et, en option, `data-confirm-title` et `data-confirm-label`.
  var modal = document.getElementById("confirm-modal");
  var modalTitle = modal && modal.querySelector("[data-modal-title]");
  var modalMessage = modal && modal.querySelector("[data-modal-message]");
  var modalConfirm = modal && modal.querySelector("[data-modal-confirm]");
  var pendingForm = null;
  var pendingIssue = null; // callback htmx (issueRequest) quand c'est une requête htmx
  var lastFocused = null;

  function openModal(form, message) {
    pendingForm = form;
    lastFocused = document.activeElement;
    if (modalMessage) modalMessage.textContent = message;
    if (modalTitle) {
      modalTitle.textContent =
        form.getAttribute("data-confirm-title") || "Confirmer la suppression";
    }
    if (modalConfirm) {
      modalConfirm.textContent =
        form.getAttribute("data-confirm-label") || "Supprimer";
    }
    modal.hidden = false;
    document.body.classList.add("is-modal-open");
    if (modalConfirm) modalConfirm.focus();
  }

  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove("is-modal-open");
    pendingForm = null;
    pendingIssue = null;
    if (lastFocused && typeof lastFocused.focus === "function") {
      lastFocused.focus();
    }
    lastFocused = null;
  }

  function confirmPending() {
    var form = pendingForm;
    var issue = pendingIssue;
    closeModal();
    // Requête htmx : on relance celle que htmx:confirm avait mise en pause.
    if (typeof issue === "function") {
      issue();
      return;
    }
    if (!form) return;
    // Marqueur pour laisser passer la soumission au second tour.
    form.dataset.confirmed = "1";
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
  }

  document.addEventListener("submit", function (event) {
    var form = event.target;
    var message = form.getAttribute("data-confirm");
    if (!message) return;

    // Formulaires htmx : la confirmation passe par l'évènement `htmx:confirm`
    // (voir plus bas), pas par ce gestionnaire, pour éviter une double modale.
    if (
      form.hasAttribute("hx-post") ||
      form.hasAttribute("hx-get") ||
      form.hasAttribute("hx-put") ||
      form.hasAttribute("hx-delete")
    ) {
      return;
    }

    // Soumission déjà confirmée : on laisse faire.
    if (form.dataset.confirmed === "1") {
      delete form.dataset.confirmed;
      return;
    }

    event.preventDefault();

    if (modal) {
      openModal(form, message);
    } else if (window.confirm(message)) {
      // Repli si la modale est absente du DOM.
      form.dataset.confirmed = "1";
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
    }
  });

  // Confirmation des requêtes htmx : htmx déclenche `htmx:confirm` avant chaque
  // requête. Pour les éléments portant `data-confirm`, on met la requête en
  // pause et on ouvre la modale maison ; on la relance seulement si l'utilisateur
  // confirme. Sans `data-confirm`, htmx poursuit normalement.
  document.body.addEventListener("htmx:confirm", function (event) {
    var elt = event.detail && event.detail.elt;
    var message = elt && elt.getAttribute && elt.getAttribute("data-confirm");
    if (!message || !modal) return;
    event.preventDefault();
    pendingIssue = event.detail.issueRequest;
    openModal(elt, message);
  });

  if (modal) {
    modal.addEventListener("click", function (event) {
      if (event.target.closest("[data-modal-confirm]")) confirmPending();
      else if (event.target.closest("[data-modal-dismiss]")) closeModal();
    });

    document.addEventListener("keydown", function (event) {
      if (modal.hidden || event.key !== "Escape") return;
      closeModal();
    });
  }

  // Renommage (projets, carnet d'adresses) : le crayon ou un double-clic
  // sur le libellé ou l'adresse ouvre un champ. Quitter le champ enregistre
  // (Entrée aussi), Échap annule.
  function renameRoot(node) {
    return node && node.closest ? node.closest("[data-rename]") : null;
  }

  function renameLabel(root) {
    return root.querySelector("[data-rename-label], [data-project-label]");
  }

  function renameValue(label) {
    if (!label) return "";
    if (label.hasAttribute("data-rename-value")) {
      return label.getAttribute("data-rename-value");
    }
    return label.textContent.trim();
  }

  function closeRename(root) {
    var label = renameLabel(root);
    var button = root.querySelector("[data-rename-open]");
    var form = root.querySelector("[data-rename-form]");
    if (label) label.hidden = false;
    if (button) button.hidden = false;
    if (form) form.hidden = true;
  }

  function commitRename(input) {
    if (input.dataset.skipCommit === "1") {
      delete input.dataset.skipCommit;
      return;
    }
    if (input.dataset.committing === "1") return;

    var root = renameRoot(input);
    if (!root) return;
    var label = renameLabel(root);
    var current = renameValue(label);
    var next = input.value.trim();
    var allowEmpty = input.dataset.renameAllowEmpty === "1";

    if ((!next && !allowEmpty) || next === current) {
      input.value = current;
      closeRename(root);
      return;
    }

    input.value = next;
    input.dataset.committing = "1";
    var form = input.form;
    if (form && typeof form.requestSubmit === "function") form.requestSubmit();
    else if (form) form.submit();
  }

  function openRename(root) {
    if (!root) return;
    var label = renameLabel(root);
    var button = root.querySelector("[data-rename-open]");
    var form = root.querySelector("[data-rename-form]");
    var input = form && form.querySelector("[data-rename-input]");
    if (!label || !form || !input) return;

    input.value = renameValue(label);
    label.hidden = true;
    if (button) button.hidden = true;
    form.hidden = false;
    input.focus();
    input.select();
  }

  document.addEventListener("click", function (event) {
    var button = event.target.closest("[data-rename-open]");
    if (!button) return;
    openRename(renameRoot(button));
  });

  document.addEventListener("dblclick", function (event) {
    var label = event.target.closest
      ? event.target.closest("[data-rename-label]")
      : null;
    if (!label) return;
    event.preventDefault();
    openRename(renameRoot(label));
  });

  document.addEventListener("focusout", function (event) {
    var input = event.target.closest
      ? event.target.closest("[data-rename-input]")
      : null;
    if (!input) return;
    commitRename(input);
  });

  document.addEventListener("keydown", function (event) {
    var input = event.target.closest
      ? event.target.closest("[data-rename-input]")
      : null;
    if (!input) return;

    if (event.key === "Escape") {
      event.preventDefault();
      var root = renameRoot(input);
      var label = root && renameLabel(root);
      var button = root && root.querySelector("[data-rename-open]");
      input.dataset.skipCommit = "1";
      if (label) input.value = renameValue(label);
      if (root) closeRename(root);
      if (button) button.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    }
  });

  // Réorganisation des projets par glisser-déposer, via la poignée (burger).
  // L'ordre choisi est enregistré côté serveur et réutilisé pour l'affichage.
  (function initProjectReorder() {
    var list = document.querySelector("[data-project-reorder]");
    if (!list) return;

    var dragging = null;

    function items() {
      return Array.prototype.slice.call(
        list.querySelectorAll(".project-list__item")
      );
    }

    function clearDraggable() {
      items().forEach(function (item) {
        item.setAttribute("draggable", "false");
      });
    }

    // On n'active le glisser que depuis la poignée : les liens, le crayon et la
    // sélection de texte dans le reste de l'item restent utilisables.
    list.addEventListener("pointerdown", function (event) {
      var handle = event.target.closest("[data-drag-handle]");
      var item = handle && handle.closest(".project-list__item");
      if (item) item.setAttribute("draggable", "true");
    });
    list.addEventListener("pointerup", clearDraggable);
    list.addEventListener("pointercancel", clearDraggable);

    list.addEventListener("dragstart", function (event) {
      var item = event.target.closest(".project-list__item");
      if (!item || item.getAttribute("draggable") !== "true") {
        event.preventDefault();
        return;
      }
      dragging = item;
      item.classList.add("is-dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(
          "text/plain",
          item.getAttribute("data-project-id") || ""
        );
      }
    });

    function itemAfter(y) {
      var closest = null;
      var closestOffset = Number.NEGATIVE_INFINITY;
      items().forEach(function (item) {
        if (item === dragging) return;
        var box = item.getBoundingClientRect();
        var offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closestOffset) {
          closestOffset = offset;
          closest = item;
        }
      });
      return closest;
    }

    list.addEventListener("dragover", function (event) {
      if (!dragging) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      var after = itemAfter(event.clientY);
      if (after == null) list.appendChild(dragging);
      else if (after !== dragging) list.insertBefore(dragging, after);
    });

    list.addEventListener("drop", function (event) {
      if (dragging) event.preventDefault();
    });

    list.addEventListener("dragend", function () {
      if (!dragging) return;
      dragging.classList.remove("is-dragging");
      dragging = null;
      clearDraggable();
      persist();
    });

    function persist() {
      var order = items()
        .map(function (item) {
          return item.getAttribute("data-project-id");
        })
        .filter(Boolean);
      if (!order.length) return;

      var meta = document.querySelector('meta[name="csrf-token"]');
      var token = meta ? meta.content : "";
      var body =
        "order=" +
        encodeURIComponent(order.join(",")) +
        "&_csrf=" +
        encodeURIComponent(token);

      fetch("/projects/reorder", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-CSRF-Token": token,
          "X-Requested-With": "XMLHttpRequest"
        },
        body: body
      }).catch(function () {
        // En cas d'échec réseau, l'ordre affiché reste celui qu'on vient de
        // poser ; il sera resynchronisé au prochain chargement de la page.
      });
    }
  })();

  // Autocomplétion des adresses de référence : libellé ou adresse, menu partagé.
  // La sélection remplit toujours les deux champs.
  (function initAddressSuggest() {
    var root = document.querySelector("[data-address-suggest]");
    if (!root) return;

    var addressInput = root.querySelector("[data-address-input]");
    var labelInput = root.querySelector("[data-label-input]");
    var menu = root.querySelector("[data-address-menu]");
    if (!addressInput || !labelInput || !menu) return;

    var comboboxInputs = [labelInput, addressInput];
    var activeInput = null;
    var options = Array.prototype.slice.call(
      menu.querySelectorAll("[data-address-option]")
    );
    var activeIndex = -1;

    function normalize(value) {
      return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();
    }

    function visibleOptions() {
      return options.filter(function (opt) {
        return !opt.parentElement.hidden;
      });
    }

    function setExpanded(expanded) {
      comboboxInputs.forEach(function (el) {
        el.setAttribute("aria-expanded", expanded ? "true" : "false");
      });
    }

    function positionMenu() {
      // Ancre le menu juste sous le champ actif (libellé ou adresse), plutôt
      // qu'en bas du bloc qui contient les deux champs.
      var anchor = activeInput || addressInput;
      menu.style.top = anchor.offsetTop + anchor.offsetHeight + 4 + "px";
    }

    function openMenu() {
      if (!visibleOptions().length) return;
      positionMenu();
      menu.hidden = false;
      setExpanded(true);
    }

    function closeMenu() {
      menu.hidden = true;
      setExpanded(false);
      setActive(-1);
    }

    function setActive(index) {
      var shown = visibleOptions();
      activeIndex = index;
      options.forEach(function (opt) {
        opt.classList.remove("is-active");
        opt.setAttribute("aria-selected", "false");
      });
      if (index >= 0 && index < shown.length) {
        var opt = shown[index];
        opt.classList.add("is-active");
        opt.setAttribute("aria-selected", "true");
        if (typeof opt.scrollIntoView === "function") {
          opt.scrollIntoView({ block: "nearest" });
        }
      }
    }

    function filterOptions(fromInput) {
      var source = fromInput || activeInput || addressInput;
      var needle = normalize(source.value);
      options.forEach(function (opt) {
        var hay = normalize(
          (opt.getAttribute("data-label") || "") +
            " " +
            (opt.getAttribute("data-address") || "")
        );
        opt.parentElement.hidden = needle !== "" && hay.indexOf(needle) === -1;
      });
      setActive(-1);
      if (visibleOptions().length) openMenu();
      else closeMenu();
    }

    function choose(opt) {
      if (!opt) return;
      var address = opt.getAttribute("data-address") || "";
      var label = opt.getAttribute("data-label") || "";
      addressInput.value = address;
      labelInput.value = label;
      closeMenu();
      var focusTarget = activeInput || addressInput;
      focusTarget.focus();
    }

    function onComboboxFocus(event) {
      activeInput = event.target;
      filterOptions(activeInput);
    }

    function onComboboxInput(event) {
      activeInput = event.target;
      filterOptions(activeInput);
    }

    function onComboboxKeydown(event) {
      activeInput = event.target;
      var shown = visibleOptions();
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (menu.hidden) openMenu();
        if (shown.length) setActive((activeIndex + 1) % shown.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        if (shown.length) {
          setActive(activeIndex <= 0 ? shown.length - 1 : activeIndex - 1);
        }
      } else if (event.key === "Enter") {
        if (!menu.hidden && activeIndex >= 0 && shown[activeIndex]) {
          event.preventDefault();
          choose(shown[activeIndex]);
        }
      } else if (event.key === "Escape") {
        if (!menu.hidden) {
          event.preventDefault();
          closeMenu();
        }
      }
    }

    comboboxInputs.forEach(function (el) {
      el.addEventListener("focus", onComboboxFocus);
      el.addEventListener("input", onComboboxInput);
      el.addEventListener("keydown", onComboboxKeydown);
    });

    menu.addEventListener("mousedown", function (event) {
      // mousedown plutôt que click : évite le blur de l'input avant la sélection.
      var opt = event.target.closest("[data-address-option]");
      if (!opt) return;
      event.preventDefault();
      choose(opt);
    });

    document.addEventListener("click", function (event) {
      if (!root.contains(event.target)) closeMenu();
    });
  })();

  // Paramètres : menu à gauche, contenu à droite. Un clic sur un item du menu
  // affiche le panneau correspondant et masque les autres.
  (function initSettingsTabs() {
    var menu = document.querySelector(".settings-menu__nav");
    var content = document.querySelector(".settings-content");
    if (!menu || !content) return;

    var items = Array.prototype.slice.call(
      menu.querySelectorAll("[data-settings-tab]")
    );
    var panels = Array.prototype.slice.call(
      content.querySelectorAll("[data-settings-panel]")
    );

    function activate(name) {
      items.forEach(function (item) {
        var active = item.getAttribute("data-settings-tab") === name;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-selected", active ? "true" : "false");
      });
      panels.forEach(function (panel) {
        panel.hidden = panel.getAttribute("data-settings-panel") !== name;
      });
    }

    menu.addEventListener("click", function (event) {
      var item = event.target.closest("[data-settings-tab]");
      if (!item) return;
      activate(item.getAttribute("data-settings-tab"));
    });
  })();

  // Listes à options-liens (projet, tri). Tout fonctionne sans JS ; ici on
  // ajoute l'ouverture, la fermeture et la navigation au clavier.
  function bindLinkMenu(root, triggerName, menuName) {
    var trigger = root.querySelector(triggerName);
    var menu = root.querySelector(menuName);
    if (!trigger || !menu) return;

    var options = Array.prototype.slice.call(
      menu.querySelectorAll(".project-select__option")
    );
    var focusIndex = -1;

    function setFocus(index) {
      focusIndex = index;
      options.forEach(function (opt, i) {
        opt.classList.toggle("is-focused", i === index);
      });
      if (index >= 0 && options[index]) options[index].focus();
    }

    function isOpen() {
      return !menu.hidden;
    }

    function openMenu() {
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      // On démarre sur l'option active, sinon la première.
      var active = options.findIndex(function (opt) {
        return opt.classList.contains("is-active");
      });
      setFocus(active >= 0 ? active : 0);
    }

    function closeMenu(refocusTrigger) {
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      options.forEach(function (opt) {
        opt.classList.remove("is-focused");
      });
      focusIndex = -1;
      if (refocusTrigger) trigger.focus();
    }

    trigger.addEventListener("click", function () {
      if (isOpen()) closeMenu(false);
      else openMenu();
    });

    trigger.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (!isOpen()) openMenu();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        if (!isOpen()) openMenu();
      }
    });

    menu.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setFocus((focusIndex + 1) % options.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setFocus(focusIndex <= 0 ? options.length - 1 : focusIndex - 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        setFocus(0);
      } else if (event.key === "End") {
        event.preventDefault();
        setFocus(options.length - 1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeMenu(true);
      } else if (event.key === "Tab") {
        closeMenu(false);
      }
    });

    document.addEventListener("click", function (event) {
      if (isOpen() && !root.contains(event.target)) closeMenu(false);
    });
  }

  (function initProjectSelect() {
    var root = document.querySelector("[data-project-select]");
    if (root) bindLinkMenu(root, "[data-project-trigger]", "[data-project-menu]");
  })();

  (function initSortSelect() {
    var root = document.querySelector("[data-sort-select]");
    if (root) bindLinkMenu(root, "[data-sort-trigger]", "[data-sort-menu]");
  })();

  // Menus de l'en-tête de fiche (projets, statut). L'enregistrement passe par
  // htmx ; ici on ne gère que l'ouverture et la fermeture. La délégation sur
  // `document` survit aux swaps htmx.
  (function initHeaderDropdowns() {
    var menus = [
      {
        root: "[data-project-dropdown]",
        trigger: "[data-project-dropdown-trigger]",
        menu: "[data-project-dropdown-menu]",
      },
      {
        root: "[data-status-dropdown]",
        trigger: "[data-status-dropdown-trigger]",
        menu: "[data-status-dropdown-menu]",
      },
    ];

    function parts(config) {
      var root = document.querySelector(config.root);
      if (!root) return null;
      var trigger = root.querySelector(config.trigger);
      var menu = root.querySelector(config.menu);
      if (!trigger || !menu) return null;
      return { root: root, trigger: trigger, menu: menu, config: config };
    }

    function open(p) {
      p.menu.hidden = false;
      p.trigger.setAttribute("aria-expanded", "true");
    }

    function close(p) {
      p.menu.hidden = true;
      p.trigger.setAttribute("aria-expanded", "false");
    }

    document.addEventListener("click", function (event) {
      menus.forEach(function (config) {
        var p = parts(config);
        if (!p) return;

        if (event.target.closest(config.trigger)) {
          if (p.menu.hidden) open(p);
          else close(p);
          return;
        }

        if (!p.menu.hidden && !p.root.contains(event.target)) close(p);
      });
    });

    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      menus.forEach(function (config) {
        var p = parts(config);
        if (!p || p.menu.hidden) return;
        close(p);
        p.trigger.focus();
      });
    });
  })();

  // Statut de suivi dans les cartes de la liste : dropdown maison, même allure
  // que « Tous les projets ». Plusieurs cartes coexistent et sont remplacées par
  // htmx à chaque changement, donc on gère l'ouverture/fermeture par délégation
  // sur le document plutôt que par instance.
  (function initCardStatusDropdowns() {
    function closeAll(except) {
      var roots = document.querySelectorAll("[data-card-status]");
      Array.prototype.forEach.call(roots, function (root) {
        if (root === except) return;
        var trigger = root.querySelector("[data-card-status-trigger]");
        var menu = root.querySelector("[data-card-status-menu]");
        if (menu) menu.hidden = true;
        if (trigger) trigger.setAttribute("aria-expanded", "false");
      });
    }

    document.addEventListener("click", function (event) {
      var trigger = event.target.closest("[data-card-status-trigger]");
      if (trigger) {
        var root = trigger.closest("[data-card-status]");
        var menu = root && root.querySelector("[data-card-status-menu]");
        if (!menu) return;
        var willOpen = menu.hidden;
        closeAll(root);
        menu.hidden = !willOpen;
        trigger.setAttribute("aria-expanded", willOpen ? "true" : "false");
        return;
      }
      // Clic en dehors de toute dropdown de carte : on ferme tout.
      if (!event.target.closest("[data-card-status]")) closeAll(null);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeAll(null);
    });
  })();

  // Carrousel photos : flèches, miniatures, compteur, clavier et glissement.
  (function initCarousels() {
    var carousels = Array.prototype.slice.call(
      document.querySelectorAll("[data-carousel]")
    );

    carousels.forEach(function (root) {
      var track = root.querySelector("[data-carousel-track]");
      if (!track) return;

      var slides = Array.prototype.slice.call(
        track.querySelectorAll(".carousel__slide")
      );
      if (slides.length <= 1) return;

      var prev = root.querySelector("[data-carousel-prev]");
      var next = root.querySelector("[data-carousel-next]");
      var counter = root.querySelector("[data-carousel-counter]");
      var viewport = root.querySelector(".carousel__viewport");
      var thumbs = Array.prototype.slice.call(
        root.querySelectorAll("[data-carousel-thumb]")
      );
      var total = slides.length;
      var index = 0;

      function render() {
        track.style.transform = "translateX(" + -index * 100 + "%)";
        if (counter) counter.textContent = index + 1 + " / " + total;
        thumbs.forEach(function (thumb, i) {
          var active = i === index;
          thumb.classList.toggle("is-active", active);
          if (active && typeof thumb.scrollIntoView === "function") {
            thumb.scrollIntoView({ block: "nearest", inline: "nearest" });
          }
        });
      }

      // Navigation circulaire : les flèches restent toujours actives.
      function go(target) {
        index = (target % total + total) % total;
        render();
      }

      if (prev) {
        prev.addEventListener("click", function () {
          go(index - 1);
        });
      }
      if (next) {
        next.addEventListener("click", function () {
          go(index + 1);
        });
      }

      thumbs.forEach(function (thumb) {
        thumb.addEventListener("click", function () {
          var i = parseInt(thumb.getAttribute("data-carousel-thumb"), 10);
          if (!isNaN(i)) go(i);
        });
      });

      if (viewport) {
        viewport.addEventListener("keydown", function (event) {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            go(index - 1);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            go(index + 1);
          }
        });

        // Glissement tactile / souris : on suit l'axe horizontal dominant.
        var startX = null;
        var startY = null;
        viewport.addEventListener(
          "pointerdown",
          function (event) {
            startX = event.clientX;
            startY = event.clientY;
          },
          { passive: true }
        );
        viewport.addEventListener("pointerup", function (event) {
          if (startX === null) return;
          var dx = event.clientX - startX;
          var dy = event.clientY - startY;
          startX = null;
          startY = null;
          if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
            go(index + (dx < 0 ? 1 : -1));
          }
        });
      }

      render();
    });
  })();

  // Montants du financement : espace des milliers pendant la saisie.
  // Les champs sont en texte pour pouvoir afficher « 20 000 » ; le serveur
  // ignore les séparateurs.
  (function initAmountFields() {
    var grouped = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });

    function formatAmount(value) {
      var digits = String(value).replace(/\D/g, "").replace(/^0+(?=\d)/, "");
      if (!digits) return "";
      return grouped.format(Number(digits));
    }

    function formatField(input) {
      var caret = input.selectionStart;
      var digitsBefore =
        caret == null
          ? null
          : input.value.slice(0, caret).replace(/\D/g, "").length;
      var formatted = formatAmount(input.value);
      if (input.value === formatted) return;
      input.value = formatted;
      if (digitsBefore == null) return;
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

    document.addEventListener("input", function (event) {
      var input = event.target.closest
        ? event.target.closest("[data-amount]")
        : null;
      if (input) formatField(input);
    });

    var commits = new WeakMap();
    var repeat = null;
    var pendingInput = null;
    var steppedByPointer = false;

    function amountInputFrom(target) {
      var stepper = target.closest ? target.closest(".amount-stepper") : null;
      return stepper ? stepper.querySelector("[data-amount]") : null;
    }

    function scheduleCommit(input) {
      var prev = commits.get(input);
      if (prev) clearTimeout(prev);
      commits.set(
        input,
        setTimeout(function () {
          commits.delete(input);
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }, 400)
      );
    }

    function stepAmount(input, direction, deferCommit) {
      var step = Number(input.getAttribute("data-step")) || 1000;
      if (!step || !direction) return;
      var digits = String(input.value).replace(/\D/g, "");
      var current = digits ? Number(digits) : 0;
      var next = current + direction * step;
      if (next < 0) next = 0;
      if (next === current) return;
      input.value = formatAmount(next);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      if (deferCommit) pendingInput = input;
      else scheduleCommit(input);
    }

    function stopRepeat() {
      if (repeat) {
        clearTimeout(repeat);
        repeat = null;
      }
      if (!pendingInput) return;
      var input = pendingInput;
      pendingInput = null;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function startRepeat(input, direction) {
      if (repeat) {
        clearTimeout(repeat);
        repeat = null;
      }
      stepAmount(input, direction, true);
      var wait = 380;
      function tick() {
        stepAmount(input, direction, true);
        wait = Math.max(60, Math.floor(wait * 0.72));
        repeat = setTimeout(tick, wait);
      }
      repeat = setTimeout(tick, wait);
    }

    document.addEventListener("pointerdown", function (event) {
      var btn = event.target.closest
        ? event.target.closest("[data-amount-step]")
        : null;
      if (!btn || event.button !== 0) return;
      var input = amountInputFrom(btn);
      if (!input) return;
      event.preventDefault();
      steppedByPointer = true;
      startRepeat(input, Number(btn.getAttribute("data-amount-step")) || 0);
    });

    document.addEventListener("pointerup", function () {
      stopRepeat();
      setTimeout(function () {
        steppedByPointer = false;
      }, 0);
    });
    document.addEventListener("pointercancel", stopRepeat);

    document.addEventListener("click", function (event) {
      var btn = event.target.closest
        ? event.target.closest("[data-amount-step]")
        : null;
      if (!btn) return;
      if (steppedByPointer) {
        steppedByPointer = false;
        return;
      }
      var input = amountInputFrom(btn);
      if (input) stepAmount(input, Number(btn.getAttribute("data-amount-step")) || 0);
    });

    document.addEventListener("keydown", function (event) {
      var input = event.target.closest
        ? event.target.closest("[data-amount]")
        : null;
      if (!input) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      stepAmount(input, event.key === "ArrowUp" ? 1 : -1);
    });
  })();

  // Financement : écart en % entre le prix négocié et le prix officiel, mis à
  // jour en direct pendant la saisie (avant même de recalculer). Délégué sur le
  // document pour survivre aux échanges htmx du bloc de financement.
  (function initPriceGap() {
    var nf = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
    var euro = new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: "EUR",
      maximumFractionDigits: 0,
    });

    function parseAmount(value) {
      var digits = String(value).replace(/\D/g, "");
      if (!digits) return NaN;
      return Number(digits);
    }

    function renderGap(input) {
      var official = Number(input.getAttribute("data-official-price"));
      var field = input.closest(".field");
      var gap = field && field.querySelector("[data-price-gap]");
      if (!gap || !(official > 0)) return;

      var negotiated = parseAmount(input.value);
      if (!Number.isFinite(negotiated)) {
        gap.textContent = "";
        return;
      }

      var pct = Math.round(((negotiated - official) / official) * 1000) / 10;
      var suffix = " le prix officiel (" + euro.format(official) + ")";

      if (pct < 0) {
        gap.innerHTML =
          '<span class="price-gap__value price-gap__value--down">\u2212' +
          nf.format(Math.abs(pct)) +
          " %</span> sous" +
          suffix;
      } else if (pct > 0) {
        gap.innerHTML =
          '<span class="price-gap__value price-gap__value--up">+' +
          nf.format(pct) +
          " %</span> au-dessus" +
          suffix;
      } else {
        gap.textContent = "Au prix officiel (" + euro.format(official) + ")";
      }
    }

    document.addEventListener("input", function (event) {
      var input = event.target.closest
        ? event.target.closest("[data-negotiated-price]")
        : null;
      if (input) renderGap(input);
    });
  })();

  // Description longue : repliée par défaut ; clic sur le bloc ou sur le bouton.
  document.addEventListener("click", function (event) {
    var toggle = event.target.closest("[data-description-toggle]");
    var box = toggle
      ? toggle.closest("[data-description]")
      : event.target.closest("[data-description]");
    if (!box) return;

    function setExpanded(expanded) {
      box.classList.toggle("is-collapsed", !expanded);
      var btn = box.querySelector("[data-description-toggle]");
      if (btn) btn.setAttribute("aria-expanded", expanded ? "true" : "false");
    }

    if (toggle) {
      setExpanded(box.classList.contains("is-collapsed"));
      return;
    }

    if (box.classList.contains("is-collapsed")) {
      setExpanded(true);
    }
  });

  // Les photos sont servies par les sites d'origine : une URL peut expirer.
  document.addEventListener(
    "error",
    function (event) {
      var img = event.target;
      if (!(img instanceof HTMLImageElement)) return;
      if (img.dataset.fallbackApplied) return;
      img.dataset.fallbackApplied = "1";
      img.removeAttribute("src");
      var holder = img.parentElement;
      if (holder) holder.classList.add("is-image-missing");
    },
    true
  );
})();
