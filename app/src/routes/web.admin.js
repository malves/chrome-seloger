/**
 * Espace d'administration, réservé au compte `config.adminEmail`.
 *
 * Première section : base DPE open data (ADEME). Elle permet de lancer un
 * import jour par jour (une journée ou une plage) et de rechercher dans les
 * DPE enregistrés. L'import tourne en arrière-plan ; la progression et le
 * tableau de résultats sont rafraîchis via htmx.
 */

import express from "express";
import config from "../config.js";
import { requireAdmin, isAdmin } from "../middlewares/auth.session.js";
import { DPE_BUILDING_TYPES, DPE_LABELS } from "../repositories/dpe.repo.js";
import { hashPassword } from "../services/password.service.js";
import createDpeOpendataService from "../services/dpe-opendata.service.js";
import createSsmsiImportService from "../services/ssmsi-import.service.js";
import createDvfImportService from "../services/dvf-import.service.js";
import { buildImportDashboard, buildJobView } from "../lib/dpe-import-job.js";
import { logActivity } from "../lib/activity.js";
import { buildDetailView } from "../lib/dpe-detail.js";
import {
  financingRatesSnapshot,
  readAdminFinancingForm,
  saveFinancingRates,
} from "../services/financing-config.service.js";

/** Nombre de lignes DPE affichées par page du tableau. */
const PER_PAGE = 25;
const USERS_PER_PAGE = 20;


const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanDay(value) {
  return DATE_RE.test(String(value || "")) ? String(value) : null;
}

function cleanText(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 120) : null;
}

/** URL d'import open data (ne pas passer par cleanText : les liens data.gouv dépassent 120 car.). */
function cleanImportUrl(value, fallback) {
  const text = String(value || "").trim();
  if (!text || text.length < 80 || !/^https:\/\//i.test(text)) {
    return fallback;
  }
  return text.slice(0, 2048);
}

/** Surface habitable en m² (borne incluse), plafonnée pour éviter les abus. */
function cleanSurface(value) {
  const raw = String(value ?? "").trim().replace(",", ".");
  if (!raw) return null;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, 100_000);
}

/** Année de construction (entier), plage réaliste pour le parc immobilier. */
function cleanConstructionYear(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const year = Number.parseInt(raw, 10);
  if (!Number.isFinite(year) || year < 1000 || year > 2100) return null;
  return year;
}

/** Normalise la query string de recherche en filtres sûrs. */
function readSearchFilters(query) {
  const etiquette = DPE_LABELS.includes(query.etiquette) ? query.etiquette : null;
  const etiquetteGes = DPE_LABELS.includes(query.etiquette_ges)
    ? query.etiquette_ges
    : null;
  const surfaceMin = cleanSurface(query.surface_min);
  const surfaceMax = cleanSurface(query.surface_max);
  const anneeMin = cleanConstructionYear(query.annee_min);
  const anneeMax = cleanConstructionYear(query.annee_max);
  const typeBatiment = DPE_BUILDING_TYPES.some(
    (entry) => entry.value === query.type_batiment
  )
    ? query.type_batiment
    : null;
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  return {
    codePostal: cleanText(query.code_postal),
    typeBatiment,
    etiquette,
    etiquetteGes,
    surfaceMin,
    surfaceMax:
      surfaceMax != null && surfaceMin != null && surfaceMax < surfaceMin
        ? surfaceMin
        : surfaceMax,
    anneeMin,
    anneeMax:
      anneeMax != null && anneeMin != null && anneeMax < anneeMin
        ? anneeMin
        : anneeMax,
    page,
  };
}

function readUserFilters(query) {
  const q = String(query.user_q || "").trim().slice(0, 120);
  const page = Math.max(1, Number.parseInt(query.user_page, 10) || 1);
  return { q: q || null, page };
}

export default function createAdminRouter({ repositories, logger }) {
  const router = express.Router();
  const dpe = createDpeOpendataService({ repositories, logger });
  const ssmsiImport = createSsmsiImportService({ repositories, logger });
  const dvfImport = createDvfImportService({ repositories, logger });
  router.use("/admin", requireAdmin);

  /** Résultats de recherche paginés pour les filtres donnés. */
  function searchResults(filters) {
    const offset = (filters.page - 1) * PER_PAGE;
    const total = repositories.dpe.countSearch(filters);
    const records = repositories.dpe.search({
      ...filters,
      limit: PER_PAGE,
      offset,
    });
    const pageCount = Math.max(1, Math.ceil(total / PER_PAGE));
    return {
      records,
      filters,
      pagination: {
        page: filters.page,
        pageCount,
        total,
        from: total ? offset + 1 : 0,
        to: Math.min(offset + PER_PAGE, total),
      },
    };
  }

  function userListResults(filters) {
    const offset = (filters.page - 1) * USERS_PER_PAGE;
    const total = repositories.users.countAdminSearch({ query: filters.q });
    const records = repositories.users.listAdmin({
      query: filters.q,
      limit: USERS_PER_PAGE,
      offset,
    });
    const pageCount = Math.max(1, Math.ceil(total / USERS_PER_PAGE));
    return {
      records,
      filters,
      pagination: {
        page: filters.page,
        pageCount,
        total,
        from: total ? offset + 1 : 0,
        to: Math.min(offset + USERS_PER_PAGE, total),
      },
    };
  }

  function renderUsersTable(res, filters, extra = {}) {
    return res.render("partials/admin/users-table", {
      layout: false,
      adminEmail: config.adminEmail,
      currentUserId: res.locals.user?.id,
      ...userListResults(filters),
      ...extra,
    });
  }

  /* --------------------------- Page principale ------------------------- */

  function importStatusView({ importError = null, importNotice = null } = {}) {
    // Attache à chaque job les requêtes ADEME équivalentes (URL + commande wget).
    const decorate = (job) => ({ ...job, requests: dpe.jobRequests(job) });
    const activeJobs = dpe.refreshRunningJobs().map(decorate);
    const dashboard = buildImportDashboard(activeJobs);
    const activeIds = new Set(activeJobs.map((j) => j.id));
    const recentJobs = dpe
      .getRecentJobs(20)
      .filter((j) => !activeIds.has(j.id))
      .slice(0, 10)
      .map(decorate);
    return {
      activeJobs,
      importDashboard: dashboard,
      jobView: dashboard,
      recentJobs,
      importError,
      importNotice,
    };
  }

  function ssmsiStatusView({ ssmsiImportError = null, ssmsiImportNotice = null } = {}) {
    ssmsiImport.refreshRunningJob();
    return {
      ssmsiDashboard: ssmsiImport.dashboard(),
      ssmsiImportError,
      ssmsiImportNotice,
    };
  }

  function dvfStatusView({ dvfImportError = null, dvfImportNotice = null } = {}) {
    dvfImport.refreshRunningJob();
    return {
      dvfDashboard: dvfImport.dashboard(),
      dvfImportError,
      dvfImportNotice,
    };
  }

  router.get("/admin", (req, res) => {
    const filters = readSearchFilters(req.query);
    const userFilters = readUserFilters(req.query);
    const status = importStatusView();
    const ssmsiStatus = ssmsiStatusView();
    const dvfStatus = dvfStatusView();
    res.render("admin", {
      title: "Administration",
      activeJobs: status.activeJobs,
      importDashboard: status.importDashboard,
      jobView: status.importDashboard,
      recentJobs: status.recentJobs,
      ...ssmsiStatus,
      ...dvfStatus,
      ssmsiDefaultCommuneUrl: config.ssmsi.communeUrl,
      ssmsiDefaultDepUrl: config.ssmsi.depUrl,
      recordCount: repositories.dpe.count(),
      dpeImportedDays: repositories.dpe.listImportedDays(),
      userCount: repositories.users.count(),
      labels: DPE_LABELS,
      buildingTypes: DPE_BUILDING_TYPES,
      search: searchResults(filters),
      users: userListResults(userFilters),
      adminEmail: config.adminEmail,
      currentUserId: req.user.id,
      financing: financingRatesSnapshot(),
    });
  });

  /* ------------------------ Paramétrage financement ------------------- */

  router.post("/admin/financing", (req, res) => {
    const current = financingRatesSnapshot();
    const rates = readAdminFinancingForm(req.body, current);
    saveFinancingRates(repositories, rates);
    logActivity(logger, req, "paramètres financement mis à jour");
    req.session.flash = {
      type: "success",
      message: "Paramètres de financement enregistrés.",
    };
    return res.redirect("/admin");
  });

  /* ------------------------------- Import ------------------------------ */

  // Une plage de dates est toujours attendue (choisie dans le calendrier).
  // Même jour en début et fin = une seule journée ; sinon, une requête par jour.
  router.post("/admin/dpe/import", (req, res) => {
    const dateFrom = cleanDay(req.body.date_from);
    const dateTo = cleanDay(req.body.date_to) || dateFrom;

    const result =
      dateFrom && dateTo
        ? dpe.startImport({ dateFrom, dateTo })
        : { error: "Choisissez au moins une date dans le calendrier." };

    if (!result.error) {
      logActivity(logger, req, "import DPE lancé", {
        dateFrom,
        dateTo,
        jobIds: (result.jobs || []).map((j) => j.id),
        skippedDays: result.skippedDays || 0,
      });
    }

    if (req.get("hx-request")) {
      let notice = null;
      if (!result.error) {
        const n = (result.jobs || []).length;
        notice =
          n === 1
            ? "Import lancé pour 1 jour. Vous pouvez quitter cette page : le traitement continue côté serveur."
            : `Import lancé pour ${n} jours en parallèle. Vous pouvez quitter cette page : le traitement continue côté serveur.`;
        if (result.skippedDays > 0) {
          notice += ` ${result.skippedDays} jour(s) déjà en cours, ignoré(s).`;
        }
      }
      return res.render("partials/admin/dpe-import-status", {
        layout: false,
        ...importStatusView({
          importError: result.error || null,
          importNotice: notice,
        }),
      });
    }

    req.session.flash = result.error
      ? { type: "error", message: result.error }
      : { type: "success", message: "Import DPE lancé." };
    return res.redirect("/admin");
  });

  router.get("/admin/dpe/import/status", (req, res) => {
    res.render("partials/admin/dpe-import-status", {
      layout: false,
      ...importStatusView(),
    });
  });

  router.get("/admin/dpe/imported-days", (req, res) => {
    res.json(repositories.dpe.listImportedDays());
  });

  router.post("/admin/ssmsi/import", (req, res) => {
    const communeUrl = cleanImportUrl(req.body.commune_url, config.ssmsi.communeUrl);
    const depUrl = cleanImportUrl(req.body.dep_url, config.ssmsi.depUrl);
    const result = ssmsiImport.startImport({
      communeUrl,
      depUrl,
    });
    if (req.get("hx-request")) {
      return res.render("partials/admin/ssmsi-import-status", {
        layout: false,
        ...ssmsiStatusView({
          ssmsiImportError: result.error || null,
          ssmsiImportNotice: result.ok ? "Import SSMSI lancé." : null,
        }),
      });
    }
    req.session.flash = result.error
      ? { type: "error", message: result.error }
      : { type: "success", message: "Import SSMSI lancé." };
    return res.redirect("/admin");
  });

  router.get("/admin/ssmsi/import/status", (req, res) => {
    res.render("partials/admin/ssmsi-import-status", {
      layout: false,
      ...ssmsiStatusView(),
    });
  });

  router.post("/admin/dvf/import", (req, res) => {
    const yearFrom = Number.parseInt(req.body.year_from, 10) || config.dvf.yearFrom;
    const yearTo = Number.parseInt(req.body.year_to, 10) || config.dvf.yearTo;
    const result = dvfImport.startImport({ yearFrom, yearTo });
    if (!result.error && result.ok) {
      logActivity(logger, req, "import DVF lancé", { yearFrom, yearTo });
    }
    if (req.get("hx-request")) {
      return res.render("partials/admin/dvf-import-status", {
        layout: false,
        ...dvfStatusView({
          dvfImportError: result.error || null,
          dvfImportNotice: result.ok
            ? "Import DVF lancé. Vous pouvez quitter cette page : le traitement continue côté serveur."
            : null,
        }),
      });
    }
    req.session.flash = result.error
      ? { type: "error", message: result.error }
      : { type: "success", message: "Import DVF lancé." };
    return res.redirect("/admin");
  });

  router.get("/admin/dvf/import/status", (req, res) => {
    res.render("partials/admin/dvf-import-status", {
      layout: false,
      ...dvfStatusView(),
    });
  });

  router.post("/admin/dpe/import/cancel", (req, res) => {
    const result = dpe.cancelRunningImport({ jobId: req.body.job_id });
    if (!result.error) {
      logActivity(logger, req, "import DPE interrompu", {
        jobIds: (result.jobs || []).map((j) => j.id),
      });
    }

    if (req.get("hx-request")) {
      return res.render("partials/admin/dpe-import-status", {
        layout: false,
        ...importStatusView({
          importError: result.error || null,
          importNotice: result.error
            ? null
            : "Import interrompu. Vous pouvez en lancer un nouveau.",
        }),
      });
    }

    req.session.flash = result.error
      ? { type: "error", message: result.error }
      : { type: "success", message: "Import DPE interrompu." };
    return res.redirect("/admin");
  });

  router.post("/admin/dpe/import/retry", (req, res) => {
    const result = dpe.retryImport(req.body.job_id);

    if (!result.error) {
      logActivity(logger, req, "import DPE relancé", {
        previousJobId: req.body.job_id,
        jobIds: (result.jobs || []).map((j) => j.id),
        dateFrom: result.jobs?.[0]?.date_from,
        dateTo: result.jobs?.[result.jobs.length - 1]?.date_to,
      });
    }

    if (req.get("hx-request")) {
      let retryNotice = null;
      if (!result.error) {
        const n = (result.jobs || []).length;
        retryNotice =
          n > 1
            ? `Import relancé pour ${n} jours en parallèle. Vous pouvez quitter cette page.`
            : "Import relancé. Vous pouvez quitter cette page : le traitement continue côté serveur.";
      }
      return res.render("partials/admin/dpe-import-status", {
        layout: false,
        ...importStatusView({
          importError: result.error || null,
          importNotice: retryNotice,
        }),
      });
    }

    req.session.flash = result.error
      ? { type: "error", message: result.error }
      : { type: "success", message: "Import DPE relancé." };
    return res.redirect("/admin");
  });

  /* ------------------------------ Recherche ---------------------------- */

  router.get("/admin/dpe/search", (req, res) => {
    const filters = readSearchFilters(req.query);
    res.render("partials/admin/dpe-table", {
      layout: false,
      ...searchResults(filters),
    });
  });

  router.get("/admin/dpe/record/:numero", (req, res) => {
    const numero = String(req.params.numero || "").trim();
    const record = numero ? repositories.dpe.findByNumero(numero) : null;
    if (!record) {
      return res.status(404).send("DPE introuvable.");
    }
    const detail = buildDetailView(record, res.locals.fmt);
    return res.render("partials/admin/dpe-detail", {
      layout: false,
      detail,
    });
  });

  /* ------------------------------ Utilisateurs ------------------------- */

  router.get("/admin/users/list", (req, res) => {
    const filters = readUserFilters(req.query);
    return renderUsersTable(res, filters);
  });

  router.get("/admin/users/:id", (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const user = Number.isFinite(id) ? repositories.users.findById(id) : null;
    if (!user) return res.status(404).send("Compte introuvable.");
    const listingCount = repositories.listings.countByUser(user.id);
    const projectCount = repositories.projects.countByUser(user.id);
    const extensionSessions = repositories.extension.listSessions(user.id);
    return res.render("partials/admin/user-detail", {
      layout: false,
      user,
      listingCount,
      projectCount,
      extensionSessions,
      adminEmail: config.adminEmail,
      currentUserId: req.user.id,
      errors: [],
      notice: null,
    });
  });

  router.post("/admin/users/:id/password", async (req, res, next) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      const user = Number.isFinite(id) ? repositories.users.findById(id) : null;
      if (!user) return res.status(404).send("Compte introuvable.");

      const password = String(req.body.password || "");
      const passwordConfirm = String(req.body.password_confirm || "");
      const errors = [];

      if (password.length < config.passwordMinLength) {
        errors.push(
          `Le mot de passe doit contenir au moins ${config.passwordMinLength} caractères.`
        );
      }
      if (password !== passwordConfirm) {
        errors.push("Les deux mots de passe ne correspondent pas.");
      }

      const listingCount = repositories.listings.countByUser(user.id);
      const projectCount = repositories.projects.countByUser(user.id);
      const extensionSessions = repositories.extension.listSessions(user.id);

      if (errors.length) {
        return res.status(422).render("partials/admin/user-detail", {
          layout: false,
          user,
          listingCount,
          projectCount,
          extensionSessions,
          adminEmail: config.adminEmail,
          currentUserId: req.user.id,
          errors,
          notice: null,
        });
      }

      repositories.users.updatePassword(user.id, await hashPassword(password));
      repositories.extension.revokeAllSessionsForUser(user.id);
      logActivity(logger, req, "mot de passe réinitialisé (admin)", {
        userId: user.id,
      });

      if (req.get("hx-request")) {
        return res.render("partials/admin/user-detail", {
          layout: false,
          user,
          listingCount,
          projectCount,
          extensionSessions: [],
          adminEmail: config.adminEmail,
          currentUserId: req.user.id,
          errors: [],
          notice:
            "Mot de passe mis à jour. Les navigateurs connectés devront se réauthentifier.",
        });
      }
      req.session.flash = {
        type: "success",
        message: "Mot de passe mis à jour.",
      };
      return res.redirect("/admin");
    } catch (err) {
      return next(err);
    }
  });

  router.post("/admin/users/:id/delete", (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const user = Number.isFinite(id) ? repositories.users.findById(id) : null;
    const filters = readUserFilters(req.query);

    if (!user) {
      if (req.get("hx-request")) {
        return renderUsersTable(res, filters, {
          listError: "Ce compte n'existe plus.",
        });
      }
      req.session.flash = { type: "error", message: "Compte introuvable." };
      return res.redirect("/admin");
    }

    if (user.id === req.user.id) {
      const message = "Vous ne pouvez pas supprimer votre propre compte.";
      if (req.get("hx-request")) {
        return renderUsersTable(res, filters, { listError: message });
      }
      req.session.flash = { type: "error", message };
      return res.redirect("/admin");
    }

    if (isAdmin(user)) {
      const message = "Le compte administrateur ne peut pas être supprimé.";
      if (req.get("hx-request")) {
        return renderUsersTable(res, filters, { listError: message });
      }
      req.session.flash = { type: "error", message };
      return res.redirect("/admin");
    }

    repositories.users.remove(user.id);
    logActivity(logger, req, "compte supprimé (admin)", {
      userId: user.id,
      email: user.email,
    });

    if (req.get("hx-request")) {
      const total = repositories.users.countAdminSearch({ query: filters.q });
      const pageCount = Math.max(1, Math.ceil(total / USERS_PER_PAGE));
      const page = Math.min(filters.page, pageCount);
      return renderUsersTable(res, { ...filters, page }, {
        listNotice: `Compte ${user.email} supprimé.`,
        closeUserModal: true,
      });
    }
    req.session.flash = {
      type: "success",
      message: `Compte ${user.email} supprimé.`,
    };
    return res.redirect("/admin");
  });

  return router;
}
