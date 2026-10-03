/**
 * Page Paramètres : navigateurs où l'extension est connectée, mot de passe,
 * suppression du compte.
 */

import express from "express";
import config from "../config.js";
import { requireUser } from "../middlewares/auth.session.js";
import { hashPassword, verifyPassword } from "../services/password.service.js";
import createAddressbookService from "../services/addressbook.service.js";
import createTravelService from "../services/travel.service.js";
import { logActivity } from "../lib/activity.js";

export default function createSettingsRouter({ repositories, logger }) {
  const router = express.Router();
  const travel = createTravelService({ logger });
  const addressbook = createAddressbookService({ repositories, travel });

  router.use("/settings", requireUser);

  function render(req, res, extra = {}) {
    return res.render("settings", {
      title: "Paramètres",
      extensionSessions: repositories.extension.listSessions(req.user.id),
      listingCount: repositories.listings.countByUser(req.user.id),
      addresses: addressbook.list(req.user.id),
      travelEnabled: travel.configured(),
      errors: [],
      ...extra,
    });
  }

  router.get("/settings", (req, res) => render(req, res));

  /**
   * Répond à une action sur le carnet d'adresses. En htmx, on ne renvoie que le
   * bloc `#address-book` ré-rendu (avec un retour inline), ce qui garde
   * l'utilisateur sur l'onglet et évite de recharger toute la page. Sans htmx,
   * on retombe sur le flash en session + redirection (fonctionne sans JS).
   */
  function respondAddressbook(req, res, flash) {
    if (req.get("hx-request")) {
      return res.render("partials/address-book", {
        layout: false,
        addresses: addressbook.list(req.user.id),
        travelEnabled: travel.configured(),
        addressFlash: flash,
      });
    }
    req.session.flash = flash;
    return res.redirect("/settings");
  }

  /* ---------------------- Carnet d'adresses ------------------------- */

  router.post("/settings/addresses", async (req, res, next) => {
    try {
      const { error } = await addressbook.create(req.user.id, {
        label: req.body.label,
        address: req.body.address,
      });
      if (!error) logActivity(logger, req, "adresse ajoutée au carnet");
      return respondAddressbook(
        req,
        res,
        error
          ? { type: "error", message: error }
          : { type: "success", message: "Adresse ajoutée au carnet." }
      );
    } catch (err) {
      return next(err);
    }
  });

  router.post("/settings/addresses/:id", async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const { error } = await addressbook.update(req.user.id, id, {
        label: req.body.label,
        address: req.body.address,
      });
      if (!error) {
        logActivity(logger, req, "adresse du carnet modifiée", { addressId: id });
      }
      return respondAddressbook(
        req,
        res,
        error
          ? { type: "error", message: error }
          : { type: "success", message: "Adresse modifiée." }
      );
    } catch (err) {
      return next(err);
    }
  });

  router.post("/settings/addresses/:id/delete", (req, res) => {
    const id = Number(req.params.id);
    const { error } = addressbook.remove(req.user.id, id);
    if (!error) {
      logActivity(logger, req, "adresse supprimée du carnet", { addressId: id });
    }
    return respondAddressbook(
      req,
      res,
      error
        ? { type: "error", message: error }
        : {
            type: "success",
            message: "Adresse supprimée du carnet (et de tous les projets).",
          }
    );
  });

  /* --------------------- Extension : navigateurs -------------------- */

  router.post("/settings/extension/:id/disconnect", (req, res) => {
    const id = Number(req.params.id);
    const revoked = Number.isInteger(id)
      ? repositories.extension.revokeSession(id, req.user.id)
      : false;
    if (revoked) {
      logActivity(logger, req, "navigateur déconnecté", { sessionId: id });
    }
    req.session.flash = revoked
      ? {
          type: "success",
          message:
            "Navigateur déconnecté. L'extension y redemandera une autorisation.",
        }
      : { type: "error", message: "Ce navigateur n'est plus connecté." };
    return res.redirect("/settings");
  });

  /* -------------------------- Mot de passe -------------------------- */

  router.post("/settings/password", async (req, res, next) => {
    try {
      const currentPassword = String(req.body.current_password || "");
      const password = String(req.body.password || "");
      const passwordConfirm = String(req.body.password_confirm || "");
      const errors = [];

      if (!(await verifyPassword(req.user.password_hash, currentPassword))) {
        errors.push("Mot de passe actuel incorrect.");
      }
      if (password.length < config.passwordMinLength) {
        errors.push(
          `Le nouveau mot de passe doit contenir au moins ${config.passwordMinLength} caractères.`
        );
      }
      if (password !== passwordConfirm) {
        errors.push("Les deux mots de passe ne correspondent pas.");
      }

      if (errors.length) {
        return res.status(422).render("settings", {
          title: "Paramètres",
          extensionSessions: repositories.extension.listSessions(req.user.id),
          listingCount: repositories.listings.countByUser(req.user.id),
          addresses: addressbook.list(req.user.id),
          travelEnabled: travel.configured(),
          errors,
        });
      }

      repositories.users.updatePassword(
        req.user.id,
        await hashPassword(password)
      );
      logActivity(logger, req, "mot de passe modifié");
      req.session.flash = {
        type: "success",
        message: "Mot de passe modifié.",
      };
      return res.redirect("/settings");
    } catch (err) {
      return next(err);
    }
  });

  /* ---------------------- Suppression du compte --------------------- */

  router.post("/settings/delete", (req, res, next) => {
    if (String(req.body.confirm || "").trim().toUpperCase() !== "SUPPRIMER") {
      req.session.flash = {
        type: "error",
        message: "Saisissez SUPPRIMER pour confirmer la suppression.",
      };
      return res.redirect("/settings");
    }

    // Annonces, photos, historiques, sessions et enrichissements partent en cascade.
    logActivity(logger, req, "compte supprimé");
    repositories.users.remove(req.user.id);
    return req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie("carnet.sid");
      return res.redirect("/");
    });
  });

  return router;
}
