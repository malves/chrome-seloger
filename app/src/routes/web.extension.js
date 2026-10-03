/**
 * Page de consentement « Connecter l'extension ».
 *
 * Point d'entrée du bouton « S'authentifier » de l'extension : l'utilisateur
 * se connecte au site s'il ne l'est pas, autorise l'extension, et Chrome
 * referme la fenêtre d'autorisation sur la redirection `chromiumapp.org`.
 * Aucun secret n'est affiché ni saisi.
 */

import express from "express";
import config from "../config.js";
import HttpError from "../lib/http-error.js";
import { requireUser } from "../middlewares/auth.session.js";
import {
  MAX_STATE_LENGTH,
  browserLabel,
  buildRedirect,
  parseRedirectUri,
} from "../services/extension-auth.service.js";
import { logActivity } from "../lib/activity.js";

/** base64url(sha256(verifier)) : 43 caractères, sans remplissage. */
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export default function createExtensionRouter({ repositories, logger }) {
  const router = express.Router();

  /**
   * Lit et valide la demande d'autorisation, qu'elle vienne de la query
   * (affichage) ou du corps du formulaire (consentement).
   */
  function readRequest(source) {
    const redirect = parseRedirectUri(source.redirect_uri, config.extensionIds);
    if (!redirect) {
      throw HttpError.badRequest(
        "Demande d'autorisation invalide : l'adresse de retour n'est pas celle d'une extension autorisée."
      );
    }

    const method = String(source.code_challenge_method || "S256");
    const codeChallenge = String(source.code_challenge || "");
    if (method !== "S256" || !CHALLENGE_RE.test(codeChallenge)) {
      throw HttpError.badRequest(
        "Demande d'autorisation invalide : vérificateur PKCE (S256) attendu."
      );
    }

    const state = String(source.state || "").slice(0, MAX_STATE_LENGTH);
    return { redirectUri: redirect.url.toString(), codeChallenge, state };
  }

  router.get("/extension/connect", requireUser, (req, res, next) => {
    try {
      const authorization = readRequest(req.query);
      return res.render("extension/connect", {
        title: "Connecter l'extension",
        authorization,
        browser: browserLabel(req.get("user-agent")),
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post("/extension/connect", requireUser, (req, res, next) => {
    try {
      const { redirectUri, codeChallenge, state } = readRequest(req.body);

      if (String(req.body.decision || "") !== "allow") {
        logActivity(logger, req, "connexion de l'extension refusée");
        return res.redirect(
          buildRedirect(redirectUri, { error: "access_denied", state })
        );
      }

      const { code } = repositories.extension.createAuthCode({
        userId: req.user.id,
        codeChallenge,
        label: browserLabel(req.get("user-agent")),
      });
      logActivity(logger, req, "extension autorisée");

      return res.redirect(buildRedirect(redirectUri, { code, state }));
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
