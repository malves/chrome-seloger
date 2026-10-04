/**
 * Inscription, connexion, déconnexion et page d'accueil publique.
 */

import express from "express";
import rateLimit from "express-rate-limit";
import config from "../config.js";
import { hashPassword, verifyPassword } from "../services/password.service.js";
import { defaultUserSettings } from "../services/settings.service.js";
import createProjectsService from "../services/projects.service.js";
import { logActivity } from "../lib/activity.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

/** Redirection post-connexion restreinte aux chemins internes. */
function safeNext(value) {
  const target = String(value || "");
  if (!target.startsWith("/") || target.startsWith("//")) return "/listings";
  return target;
}

const HOME_DESCRIPTION =
  "Extension Chrome gratuite : prix au m² réel du quartier, adresse probable, " +
  "temps de trajet, DPE, sécurité et financement sur chaque annonce SeLoger et Leboncoin.";

function homeSeo() {
  const url = `${config.baseUrl}/`;
  return {
    title: "Carnet de Visites · Tout savoir sur chaque annonce immobilière",
    description: HOME_DESCRIPTION,
    url,
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "WebSite",
          "@id": `${url}#website`,
          url,
          name: "Carnet de Visites",
          inLanguage: "fr-FR",
        },
        {
          "@type": "SoftwareApplication",
          name: "Carnet de Visites",
          url,
          description: HOME_DESCRIPTION,
          applicationCategory: "LifestyleApplication",
          operatingSystem: "Google Chrome",
          inLanguage: "fr-FR",
          offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
        },
      ],
    },
  };
}

export default function createAuthRouter({ repositories, logger }) {
  const router = express.Router();
  const projectsService = createProjectsService({ repositories });

  const loginLimiter = rateLimit({
    windowMs: config.rateLimits.login.windowMs,
    limit: config.rateLimits.login.max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: "Trop de tentatives de connexion. Réessayez dans 15 minutes.",
  });

  router.get("/", (req, res) => {
    if (req.user) return res.redirect("/listings");
    return res.render("home", {
      title: "Accueil",
      seo: homeSeo(),
      mainClass: "home",
      styles: ["/public/css/home.css"],
      scripts: ["/public/js/home.js"],
      preloadFonts: ["/public/fonts/fraunces-latin-wght-normal.woff2"],
    });
  });

  /* ------------------------------ Inscription ------------------------------ */

  router.get("/signup", (req, res) => {
    if (req.user) return res.redirect("/listings");
    return res.render("auth/signup", {
      title: "Créer un compte",
      values: {},
      errors: [],
      next: safeNext(req.query.next),
    });
  });

  router.post("/signup", async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body.email);
      const password = String(req.body.password || "");
      const passwordConfirm = String(req.body.password_confirm || "");
      // Préserve la destination : une inscription lancée depuis l'extension
      // revient sur la page de consentement.
      const target = safeNext(req.body.next);
      const errors = [];

      if (!EMAIL_RE.test(email)) errors.push("Adresse e-mail invalide.");
      if (password.length < config.passwordMinLength) {
        errors.push(
          `Le mot de passe doit contenir au moins ${config.passwordMinLength} caractères.`
        );
      }
      if (password !== passwordConfirm) {
        errors.push("Les deux mots de passe ne correspondent pas.");
      }
      if (!errors.length && repositories.users.findByEmail(email)) {
        errors.push("Un compte existe déjà avec cette adresse e-mail.");
      }

      if (errors.length) {
        return res.status(422).render("auth/signup", {
          title: "Créer un compte",
          values: { email },
          errors,
          next: target,
        });
      }

      const user = repositories.users.create({
        email,
        passwordHash: await hashPassword(password),
        settings: defaultUserSettings(),
      });

      // Destination des annonces reçues sans projet précisé.
      projectsService.ensureDefault(user.id);
      logActivity(logger, req, "compte créé", { userId: user.id });

      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.userId = user.id;
        req.session.flash = {
          type: "success",
          message:
            "Compte créé. Dans l'extension, « S'authentifier » suffit à la connecter.",
        };
        return req.session.save((saveErr) =>
          saveErr ? next(saveErr) : res.redirect(target)
        );
      });
      return undefined;
    } catch (err) {
      return next(err);
    }
  });

  /* ------------------------------- Connexion ------------------------------- */

  router.get("/login", (req, res) => {
    if (req.user) return res.redirect("/listings");
    return res.render("auth/login", {
      title: "Connexion",
      values: {},
      errors: [],
      next: safeNext(req.query.next),
    });
  });

  router.post("/login", loginLimiter, async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body.email);
      const password = String(req.body.password || "");
      const target = safeNext(req.body.next);

      const user = repositories.users.findByEmail(email);
      const valid = user
        ? await verifyPassword(user.password_hash, password)
        : false;

      if (!valid) {
        return res.status(401).render("auth/login", {
          title: "Connexion",
          values: { email },
          errors: ["E-mail ou mot de passe incorrect."],
          next: target,
        });
      }

      logActivity(logger, req, "connexion", { userId: user.id });

      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.userId = user.id;
        return req.session.save((saveErr) =>
          saveErr ? next(saveErr) : res.redirect(target)
        );
      });
      return undefined;
    } catch (err) {
      return next(err);
    }
  });

  /* ------------------------------ Déconnexion ------------------------------ */

  router.post("/logout", (req, res, next) => {
    if (req.user) logActivity(logger, req, "déconnexion");
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie("carnet.sid");
      return res.redirect("/");
    });
  });

  return router;
}
