/**
 * Gestion des projets de recherche : création, paramétrage (nom + adresses de
 * référence pour le temps de trajet), projet par défaut, suppression. Les
 * annonces ne sont jamais supprimées avec un projet.
 */

import express from "express";
import { requireUser } from "../middlewares/auth.session.js";
import createProjectsService from "../services/projects.service.js";
import createTravelService from "../services/travel.service.js";
import { logActivity } from "../lib/activity.js";

export default function createProjectsRouter({ repositories, logger }) {
  const router = express.Router();
  const projects = createProjectsService({ repositories });
  const travel = createTravelService({ logger });

  router.use("/projects", requireUser);

  /* ------------------------------ Liste ------------------------------ */

  router.get("/projects", (req, res) => {
    projects.ensureDefault(req.user.id);
    res.render("projects", {
      title: "Projets",
      projects: projects.list(req.user.id).map((project) => ({
        ...project,
        address_count: repositories.projects.countAddresses(project.id),
      })),
      totalListings: repositories.listings.countByUser(req.user.id),
    });
  });

  router.post("/projects", (req, res) => {
    const { project, error } = projects.create(req.user.id, req.body.name);
    if (!error) {
      logActivity(logger, req, "projet créé", {
        projectId: project.id,
        name: project.name,
      });
    }
    req.session.flash = error
      ? { type: "error", message: error }
      : { type: "success", message: `Projet « ${project.name} » créé.` };
    return res.redirect(error ? "/projects" : `/projects/${project.id}`);
  });

  /* --------------------------- Réorganisation ------------------------- */

  // Glisser-déposer sur la liste : enregistre l'ordre choisi à la main.
  // Appel asynchrone (fetch), réponse JSON — pas de redirection ni de flash.
  router.post("/projects/reorder", (req, res) => {
    const raw = req.body.order;
    const references = Array.isArray(raw)
      ? raw
      : String(raw || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);

    const { order } = projects.reorder(req.user.id, references);
    logActivity(logger, req, "projets réordonnés", { count: order.length });
    return res.json({ ok: true, order });
  });

  /* ---------------------------- Paramétrage --------------------------- */

  router.get("/projects/:id", (req, res, next) => {
    const id = Number(req.params.id);
    const project = Number.isInteger(id)
      ? repositories.projects.findById(req.user.id, id)
      : null;
    if (!project) return next();

    return res.render("project", {
      title: project.name,
      project,
      addresses: projects.listAddresses(req.user.id, project.id),
      // Carnet du compte, moins les adresses déjà reliées à ce projet.
      suggestions: projects.listAddressSuggestions(req.user.id, project.id),
      travelEnabled: travel.configured(),
    });
  });

  router.post("/projects/:id", (req, res) => {
    const id = Number(req.params.id);
    const action = String(req.body.action || "rename");

    const fromList = req.body.from === "list";
    const { error } =
      action === "default"
        ? projects.setDefault(req.user.id, id)
        : projects.rename(req.user.id, id, req.body.name);

    if (!error) {
      logActivity(
        logger,
        req,
        action === "default" ? "projet par défaut modifié" : "projet renommé",
        { projectId: id, ...(action === "default" ? {} : { name: req.body.name }) }
      );
    }
    req.session.flash = error
      ? { type: "error", message: error }
      : {
          type: "success",
          message:
            action === "default"
              ? "Projet par défaut modifié."
              : "Projet renommé.",
        };
    return res.redirect(error || fromList ? "/projects" : `/projects/${id}`);
  });

  router.post("/projects/:id/delete", (req, res) => {
    const id = Number(req.params.id);
    const { removed, error, reassigned } = projects.remove(req.user.id, id);
    if (removed) {
      logActivity(logger, req, "projet supprimé", {
        projectId: id,
        reassigned: reassigned || undefined,
      });
    }

    req.session.flash = removed
      ? {
          type: "success",
          message: reassigned
            ? `Projet supprimé. ${reassigned} annonce${reassigned > 1 ? "s" : ""} replacée${reassigned > 1 ? "s" : ""} dans le projet par défaut.`
            : "Projet supprimé.",
        }
      : { type: "error", message: error };
    return res.redirect(removed ? "/projects" : `/projects/${id}`);
  });

  /* --------------------- Adresses de référence ---------------------- */

  router.post("/projects/:id/addresses", async (req, res, next) => {
    const id = Number(req.params.id);
    try {
      // Réutilise un géocodage déjà connu si l'adresse correspond exactement à
      // une adresse déjà localisée du compte (comparaison serveur) : évite un
      // appel ORS redondant quand on resaisit une adresse via l'autocomplétion.
      const { error, address } = await projects.addAddress(
        req.user.id,
        id,
        { label: req.body.label, address: req.body.address },
        travel
      );
      if (!error) {
        logActivity(logger, req, "adresse de référence ajoutée", { projectId: id });
      }
      const localized = address?.lat != null && address?.lng != null;
      req.session.flash = error
        ? { type: "error", message: error }
        : {
            type: "success",
            message: localized
              ? "Adresse de référence ajoutée."
              : "Adresse ajoutée (coordonnées à confirmer : géocodage indisponible).",
          };
      return res.redirect(`/projects/${id}`);
    } catch (err) {
      return next(err);
    }
  });

  router.post("/projects/:id/addresses/:addressId/delete", (req, res) => {
    const id = Number(req.params.id);
    const addressId = Number(req.params.addressId);
    // « Retirer » détache l'adresse du projet ; elle reste dans le carnet.
    const { error } = projects.unlinkAddress(req.user.id, id, addressId);
    if (!error) {
      logActivity(logger, req, "adresse retirée du projet", {
        projectId: id,
        addressId,
      });
    }
    req.session.flash = error
      ? { type: "error", message: error }
      : {
          type: "success",
          message: "Adresse retirée du projet (conservée dans le carnet).",
        };
    return res.redirect(`/projects/${id}`);
  });

  return router;
}
