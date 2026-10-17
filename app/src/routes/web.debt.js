/**
 * Page « Mon endettement » : revenus, crédits et charges du compte, calcul du
 * taux d'endettement et de la capacité d'emprunt dans le navigateur.
 *
 * La saisie est enregistrée au fil de l'eau dans `users.settings.debt` pour
 * pouvoir être complétée plus tard, papiers en main.
 */

import express from "express";
import config from "../config.js";
import { requireUser } from "../middlewares/auth.session.js";
import { logActivity } from "../lib/activity.js";
import { emptyDebtState, sanitizeDebtState } from "../lib/debt-ratio.js";

function financingDefaults() {
  const { years, interestRate, insuranceRate } = config.financing;
  return { years, interestRate, insuranceRate };
}

/** Mensualité transmise depuis une fiche (`?mensualite=1234&source=…`). */
function prefillFromQuery(query) {
  const monthly = Math.round(Number(String(query.mensualite ?? "").replace(",", ".")));
  if (!Number.isFinite(monthly) || monthly <= 0 || monthly > 100_000) return null;
  return {
    monthly,
    source: String(query.source ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
  };
}

export default function createDebtRouter({ repositories, logger }) {
  const router = express.Router();

  router.get("/endettement", requireUser, (req, res) => {
    const defaults = financingDefaults();
    const stored = req.user.settings?.debt;
    const state = stored
      ? sanitizeDebtState(stored, defaults)
      : emptyDebtState(defaults);

    res.render("debt", {
      title: "Mon endettement",
      styles: ["/public/css/debt.css"],
      scripts: ["/public/js/calendar-picker.js", "/public/js/debt-planner.js"],
      debtState: state,
      debtDefaults: defaults,
      debtPrefill: prefillFromQuery(req.query),
      debtIsNew: !stored,
    });
  });

  router.post(
    "/endettement",
    express.json({ limit: "64kb" }),
    (req, res) => {
      if (!req.user) {
        return res.status(401).json({
          error: { code: "unauthorized", message: "Session expirée. Reconnectez-vous." },
        });
      }
      const state = sanitizeDebtState(req.body?.state, financingDefaults());
      repositories.users.updateSettings(req.user.id, {
        ...req.user.settings,
        debt: state,
      });
      if (!req.user.settings?.debt) {
        logActivity(logger, req, "calcul d'endettement enregistré");
      }
      return res.json({ ok: true });
    }
  );

  return router;
}
