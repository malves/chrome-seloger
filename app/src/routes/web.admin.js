/**
 * Espace d'administration, réservé aux comptes `config.adminEmails`.
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
import createHexasmalImportService from "../services/hexasmal-import.service.js";
import createAddressInsightService from "../services/address-insight.service.js";
import { buildAmortization } from "../lib/amortization.js";
import { cleanPostalInseeQuery } from "../repositories/postal-insee.repo.js";
import {
  buildImportDashboard,
  buildJobView,
} from "../lib/dpe-import-job.js";
import { buildJsonViewHtml, jsonForClipboard } from "../lib/json-view.js";
import { logActivity } from "../lib/activity.js";
import { buildDetailView } from "../lib/dpe-detail.js";
import {
  COLOR_GROUPS,
  FONT_TOKENS,
  LAYOUT_TOKENS,
  RADIUS_TOKENS,
  SHADOW_TOKENS,
  SPACE_TOKENS,
} from "../lib/design-system.js";
import { ICON_GROUPS } from "../lib/icons.js";
import { DESIGN_PATTERNS, patternAnchor } from "../lib/design-system-patterns.js";
import {
  financingRatesSnapshot,
  readAdminFinancingForm,
  saveFinancingRates,
} from "../services/financing-config.service.js";
import createVisitQuestionsConfigService from "../services/visit-questions-config.service.js";
import { readQuestionLevelsForm } from "../lib/visit/visit-question-levels.js";
import { buildQuestionsAdminView } from "../lib/visit/visit-question-catalog.js";
import { draftFromQuestion, readQuestionForm } from "../lib/visit/visit-question-validate.js";
import { buildQuestionEditorView, emptyQuestionDraft } from "../lib/visit/visit-question-editor-view.js";
import {
  visitQuestionFormSchema,
  visitQuestionIdSchema,
  visitQuestionsAdminSchema,
} from "../schemas/visit.js";
import HttpError from "../lib/http-error.js";

/** Nombre de lignes DPE affichées par page du tableau. */
const PER_PAGE = 25;
const USERS_PER_PAGE = 20;
const HEXASMAL_PER_PAGE = 25;
const ENRICHMENT_CACHE_PER_PAGE = 25;


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
    adresse: cleanText(query.adresse),
    codePostal: cleanText(query.code_postal),
    dateModif: cleanDay(query.date_modif),
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

/** Au moins un filtre actif (évite COUNT/SELECT sur toute la base au chargement). */
function hasDpeSearchFilters(filters) {
  return Boolean(
    filters.codePostal ||
      filters.dateModif ||
      filters.typeBatiment ||
      filters.etiquette ||
      filters.etiquetteGes ||
      filters.surfaceMin != null ||
      filters.surfaceMax != null ||
      filters.anneeMin != null ||
      filters.anneeMax != null ||
      (filters.adresse && filters.codePostal)
  );
}

function emptyDpeSearchResults(filters, searchState) {
  return {
    records: [],
    filters,
    searchState,
    pagination: {
      page: 1,
      pageCount: 1,
      total: 0,
      from: 0,
      to: 0,
    },
  };
}

function readUserFilters(query) {
  const q = String(query.user_q || "").trim().slice(0, 120);
  const page = Math.max(1, Number.parseInt(query.user_page, 10) || 1);
  return { q: q || null, page };
}

function readHexasmalBrowseFilters(query) {
  const q = cleanPostalInseeQuery(query.hexasmal_q);
  const page = Math.max(1, Number.parseInt(query.hexasmal_page, 10) || 1);
  return { q, page };
}

function cleanCacheProvider(value) {
  const text = String(value || "").trim();
  if (!text || !/^[a-z0-9-]{1,40}$/i.test(text)) return null;
  return text.toLowerCase();
}

function cleanCacheScope(value) {
  if (value === "listing") return "listing";
  if (value === "department") return "department";
  return "commune";
}

/** Code département : 2 chiffres, 2A/2B, ou 3 chiffres (DOM). */
function cleanDeptCode(value) {
  const text = String(value || "").trim().toUpperCase();
  if (!text || text.length > 3 || !/^(2[AB]|[0-9]{2,3})$/.test(text)) return null;
  return text;
}

function cleanCacheQuery(value) {
  const text = String(value || "").trim().slice(0, 80);
  return text || null;
}

function cleanInseeCode(value) {
  const text = String(value || "").trim().toUpperCase();
  if (!text || text.length > 5 || !/^[0-9AB]+$/.test(text)) return null;
  return text;
}

function readCacheBrowseFilters(query) {
  const scope = cleanCacheScope(query.cache_scope);
  const provider = cleanCacheProvider(query.cache_provider);
  const q = cleanCacheQuery(query.cache_q);
  const page = Math.max(1, Number.parseInt(query.cache_page, 10) || 1);
  return { scope, provider, q, page };
}

export default function createAdminRouter({ repositories, enrichment, logger }) {
  const router = express.Router();
  const dpe = createDpeOpendataService({ repositories, logger });
  const ssmsiImport = createSsmsiImportService({ repositories, logger });
  const dvfImport = createDvfImportService({ repositories, logger });
  const hexasmalImport = createHexasmalImportService({ repositories });
  const addressInsight = createAddressInsightService({
    repositories,
    config,
    logger,
  });
  const visitQuestionsConfig = createVisitQuestionsConfigService({ repositories });
  router.use("/admin", requireAdmin);
  router.use("/admin", (req, res, next) => {
    res.locals.adminEmails = config.adminEmails;
    next();
  });

  /** Résultats de recherche paginés pour les filtres donnés. */
  function searchResults(filters) {
    if (filters.adresse && !filters.codePostal) {
      return emptyDpeSearchResults(filters, "adresse-needs-postal");
    }
    if (!hasDpeSearchFilters(filters)) {
      return emptyDpeSearchResults(filters, "needs-filters");
    }

    const offset = (filters.page - 1) * PER_PAGE;
    const total = repositories.dpe.countSearch(filters);
    const records = repositories.dpe.search({
      ...filters,
      listOnly: true,
      limit: PER_PAGE,
      offset,
    });
    const pageCount = Math.max(1, Math.ceil(total / PER_PAGE));
    return {
      records,
      filters,
      searchState: null,
      pagination: {
        page: filters.page,
        pageCount,
        total,
        from: total ? offset + 1 : 0,
        to: Math.min(offset + PER_PAGE, total),
      },
    };
  }

  function hexasmalBrowseResults(filters) {
    const total = repositories.postalInsee.countBrowse({ q: filters.q });
    const pageCount = Math.max(1, Math.ceil(total / HEXASMAL_PER_PAGE));
    const page = Math.min(Math.max(1, filters.page), pageCount);
    const offset = (page - 1) * HEXASMAL_PER_PAGE;
    const records = repositories.postalInsee.listBrowse({
      q: filters.q,
      limit: HEXASMAL_PER_PAGE,
      offset,
    });
    return {
      records,
      filters: { ...filters, page },
      pagination: {
        page,
        pageCount,
        total,
        from: total ? offset + 1 : 0,
        to: Math.min(offset + HEXASMAL_PER_PAGE, total),
      },
    };
  }

  /** Clés des providers réellement de portée annonce (pour filtrer la 3e vue). */
  async function listingScopeKeys() {
    const providers = await enrichment.listProviders();
    return providers
      .filter((provider) => provider.scope === "listing")
      .map((provider) => provider.key);
  }

  async function cacheProvidersFor(scope) {
    const keys = repositories.enrichments.listCacheProviders(scope);
    if (scope !== "listing") return keys;
    const listingKeys = new Set(await listingScopeKeys());
    return keys.filter((key) => listingKeys.has(key));
  }

  async function enrichmentCacheBrowseResults(requested) {
    const repo = repositories.enrichments;
    const providers = await cacheProvidersFor(requested.scope);
    const filters = providers.includes(requested.provider)
      ? requested
      : { ...requested, provider: null };
    const { scope, provider, q } = filters;

    let total;
    if (scope === "commune") {
      total = repo.countCommuneBrowse({ provider, q });
    } else if (scope === "department") {
      total = repo.countDepartmentBrowse({ provider, q });
    } else {
      total = repo.countListingBrowse({
        provider,
        q,
        providers: provider ? null : await listingScopeKeys(),
      });
    }

    const pageCount = Math.max(1, Math.ceil(total / ENRICHMENT_CACHE_PER_PAGE));
    const page = Math.min(Math.max(1, filters.page), pageCount);
    const offset = (page - 1) * ENRICHMENT_CACHE_PER_PAGE;

    let records;
    if (scope === "commune") {
      records = repo.listCommuneCache({
        provider,
        q,
        limit: ENRICHMENT_CACHE_PER_PAGE,
        offset,
      });
    } else if (scope === "department") {
      records = repo.listDepartmentCache({
        provider,
        q,
        limit: ENRICHMENT_CACHE_PER_PAGE,
        offset,
      });
    } else {
      records = repo.listListingCache({
        provider,
        q,
        providers: provider ? null : await listingScopeKeys(),
        limit: ENRICHMENT_CACHE_PER_PAGE,
        offset,
      });
    }

    return {
      records,
      providers,
      filters: { ...filters, page },
      pagination: {
        page,
        pageCount,
        total,
        from: total ? offset + 1 : 0,
        to: Math.min(offset + ENRICHMENT_CACHE_PER_PAGE, total),
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
      adminEmails: config.adminEmails,
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

  function hexasmalStatusView({
    hexasmalImportError = null,
    hexasmalImportNotice = null,
  } = {}) {
    return {
      hexasmalMeta: hexasmalImport.meta(),
      hexasmalImportError,
      hexasmalImportNotice,
    };
  }

  function adminSidebarLocals() {
    return {
      userCount: repositories.users.count(),
      enrichmentCacheStats: repositories.enrichments.cacheStats(),
    };
  }

  function readDpeTab(query) {
    return query.tab === "search" ? "search" : "import";
  }

  function redirectAdmin(res, section) {
    return res.redirect(`/admin/${section}`);
  }

  router.get("/admin", (req, res) => res.redirect("/admin/dpe"));

  router.get("/admin/dpe", (req, res) => {
    const filters = readSearchFilters(req.query);
    const dpeTab = readDpeTab(req.query);
    const status =
      dpeTab === "search"
        ? {
            activeJobs: [],
            importDashboard: { blockNewImport: false },
            jobView: { blockNewImport: false },
            recentJobs: [],
          }
        : importStatusView();
    res.render("admin/dpe", {
      title: "Administration — DPE",
      adminSection: "dpe",
      dpeTab,
      ...adminSidebarLocals(),
      activeJobs: status.activeJobs,
      importDashboard: status.importDashboard,
      jobView: status.jobView ?? status.importDashboard,
      recentJobs: status.recentJobs,
      dpeImportCalendar:
        dpeTab === "search"
          ? { complete: [], partial: [] }
          : repositories.dpe.listImportCalendarDays(),
      labels: DPE_LABELS,
      buildingTypes: DPE_BUILDING_TYPES,
      search: searchResults(filters),
    });
  });

  router.get("/admin/ssmsi", (req, res) => {
    res.render("admin/ssmsi", {
      title: "Administration — SSMSI",
      adminSection: "ssmsi",
      ...adminSidebarLocals(),
      ...ssmsiStatusView(),
      ssmsiDefaultCommuneUrl: config.ssmsi.communeUrl,
      ssmsiDefaultDepUrl: config.ssmsi.depUrl,
    });
  });

  router.get("/admin/hexasmal", (req, res) => {
    const hexasmalBrowse = hexasmalBrowseResults(readHexasmalBrowseFilters(req.query));
    res.render("admin/hexasmal", {
      title: "Administration — HexaSmal",
      adminSection: "hexasmal",
      ...adminSidebarLocals(),
      ...hexasmalStatusView(),
      hexasmalBrowse,
    });
  });

  router.get("/admin/dvf", (req, res) => {
    res.render("admin/dvf", {
      title: "Administration — DVF",
      adminSection: "dvf",
      ...adminSidebarLocals(),
      ...dvfStatusView(),
    });
  });

  router.get("/admin/users", (req, res) => {
    const userFilters = readUserFilters(req.query);
    res.render("admin/users", {
      title: "Administration — Utilisateurs",
      adminSection: "users",
      ...adminSidebarLocals(),
      users: userListResults(userFilters),
      adminEmails: config.adminEmails,
      currentUserId: req.user.id,
    });
  });

  router.get("/admin/enrichment-cache", async (req, res) => {
    const enrichmentCacheBrowse = await enrichmentCacheBrowseResults(
      readCacheBrowseFilters(req.query)
    );
    res.render("admin/enrichment-cache", {
      title: "Administration — Cache enrichissements",
      adminSection: "enrichment-cache",
      ...adminSidebarLocals(),
      enrichmentCacheBrowse,
    });
  });

  router.get("/admin/financing", (req, res) => {
    res.render("admin/financing", {
      title: "Administration — Financement",
      adminSection: "financing",
      ...adminSidebarLocals(),
      financing: financingRatesSnapshot(),
    });
  });

  router.get("/admin/design-system", (req, res) => {
    res.render("admin/design-system", {
      title: "Design system",
      styles: ["/public/css/design-system.css"],
      scripts: ["/public/js/calendar-picker.js", "/public/js/design-system-admin.js"],
      colorGroups: COLOR_GROUPS,
      spaceTokens: SPACE_TOKENS,
      radiusTokens: RADIUS_TOKENS,
      shadowTokens: SHADOW_TOKENS,
      fontTokens: FONT_TOKENS,
      layoutTokens: LAYOUT_TOKENS,
      iconGroups: ICON_GROUPS,
      designPatterns: DESIGN_PATTERNS,
      patternAnchor,
    });
  });

  /* ------------------------- Questions de visite ---------------------- */

  router.get("/admin/visite", (req, res) => {
    res.render("admin/visit-questions", {
      title: "Administration — Questions de visite",
      adminSection: "visit-questions",
      ...adminSidebarLocals(),
      styles: ["/public/css/admin-visit-questions.css"],
      view: buildQuestionsAdminView(visitQuestionsConfig.getCatalog()),
    });
  });

  router.post("/admin/visite", (req, res, next) => {
    const parsed = visitQuestionsAdminSchema.safeParse(readQuestionLevelsForm(req.body));
    if (!parsed.success) {
      return next(HttpError.badRequest("Classement des questions invalide."));
    }
    visitQuestionsConfig.saveLevelsAndOrder(parsed.data);
    logActivity(logger, req, "questions de visite reclassées");
    req.session.flash = { type: "success", message: "Classement des questions enregistré." };
    return redirectAdmin(res, "visite");
  });

  router.post("/admin/visite/reset", (req, res) => {
    visitQuestionsConfig.reset();
    logActivity(logger, req, "questions de visite réinitialisées");
    req.session.flash = { type: "success", message: "Classement du catalogue rétabli." };
    return redirectAdmin(res, "visite");
  });

  function renderQuestionEditor(res, { status = 200, question = null, draft, errors = {} }) {
    return res.status(status).render("admin/visit-question-edit", {
      title: question
        ? "Administration — Modifier une question de visite"
        : "Administration — Nouvelle question de visite",
      adminSection: "visit-questions",
      ...adminSidebarLocals(),
      styles: ["/public/css/admin-visit-questions.css"],
      scripts: ["/public/js/visit-question-editor.js"],
      view: buildQuestionEditorView({ question, draft, errors }),
    });
  }

  /** Question de l'URL (archivée comprise), sinon 404. */
  function questionFromParams(req) {
    const id = visitQuestionIdSchema.safeParse(req.params.id);
    const question = id.success ? visitQuestionsConfig.question(id.data) : null;
    if (!question) throw HttpError.notFound("Question introuvable.");
    return question;
  }

  /** Brouillon du formulaire validé (forme) ou null. */
  function readDraft(req) {
    const parsed = visitQuestionFormSchema.safeParse(readQuestionForm(req.body));
    return parsed.success ? parsed.data : null;
  }

  router.get("/admin/visite/questions/nouvelle", (req, res) => {
    renderQuestionEditor(res, { draft: emptyQuestionDraft() });
  });

  router.post("/admin/visite/questions", (req, res, next) => {
    const draft = readDraft(req);
    if (!draft) return next(HttpError.unprocessable("Formulaire de question invalide."));
    const result = visitQuestionsConfig.create(draft);
    if (!result.ok) {
      return renderQuestionEditor(res, { status: 422, draft, errors: result.errors });
    }
    logActivity(logger, req, "question de visite créée", { questionId: result.question.id });
    req.session.flash = { type: "success", message: "Question ajoutée." };
    return redirectAdmin(res, "visite");
  });

  router.get("/admin/visite/questions/:id", (req, res) => {
    const question = questionFromParams(req);
    renderQuestionEditor(res, { question, draft: draftFromQuestion(question) });
  });

  router.post("/admin/visite/questions/:id", (req, res, next) => {
    const question = questionFromParams(req);
    const draft = readDraft(req);
    if (!draft) return next(HttpError.unprocessable("Formulaire de question invalide."));
    const result = visitQuestionsConfig.update(question.id, draft);
    if (!result.ok) {
      return renderQuestionEditor(res, { status: 422, question, draft, errors: result.errors });
    }
    logActivity(logger, req, "question de visite modifiée", { questionId: question.id });
    req.session.flash = { type: "success", message: "Question enregistrée." };
    return redirectAdmin(res, "visite");
  });

  router.post("/admin/visite/questions/:id/archiver", (req, res) => {
    const question = questionFromParams(req);
    visitQuestionsConfig.archive(question.id);
    logActivity(logger, req, "question de visite archivée", { questionId: question.id });
    req.session.flash = {
      type: "success",
      message: "Question supprimée de la fiche de visite. Vous pouvez la restaurer depuis les questions archivées.",
    };
    return redirectAdmin(res, "visite");
  });

  router.post("/admin/visite/questions/:id/restaurer", (req, res) => {
    const question = questionFromParams(req);
    visitQuestionsConfig.restore(question.id);
    logActivity(logger, req, "question de visite restaurée", { questionId: question.id });
    req.session.flash = { type: "success", message: "Question restaurée en fin d'étape." };
    return redirectAdmin(res, "visite");
  });

  router.post("/admin/visite/questions/:id/catalogue", (req, res, next) => {
    const question = questionFromParams(req);
    if (!visitQuestionsConfig.resetToBuiltin(question.id)) {
      return next(HttpError.unprocessable("Cette question ne vient pas du catalogue d'origine."));
    }
    logActivity(logger, req, "question de visite rétablie", { questionId: question.id });
    req.session.flash = { type: "success", message: "Version du catalogue rétablie." };
    return res.redirect(`/admin/visite/questions/${question.id}`);
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
    return redirectAdmin(res, "financing");
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
    return redirectAdmin(res, "dpe");
  });

  router.get("/admin/dpe/import/status", (req, res) => {
    res.render("partials/admin/dpe-import-status", {
      layout: false,
      ...importStatusView(),
    });
  });

  router.get("/admin/dpe/imported-days", (req, res) => {
    res.json(repositories.dpe.listImportCalendarDays());
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
    return redirectAdmin(res, "ssmsi");
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
    return redirectAdmin(res, "dvf");
  });

  router.get("/admin/dvf/import/status", (req, res) => {
    res.render("partials/admin/dvf-import-status", {
      layout: false,
      ...dvfStatusView(),
    });
  });

  router.get("/admin/hexasmal/browse", (req, res) => {
    const filters = readHexasmalBrowseFilters(req.query);
    res.render("partials/admin/hexasmal-table", {
      layout: false,
      ...hexasmalBrowseResults(filters),
    });
  });

  router.get("/admin/enrichment-cache/browse", async (req, res) => {
    const filters = readCacheBrowseFilters(req.query);
    res.render("partials/admin/enrichment-cache-table", {
      layout: false,
      ...(await enrichmentCacheBrowseResults(filters)),
      providersOob: true,
    });
  });

  router.get("/admin/enrichment-cache/detail", (req, res) => {
    const scope = cleanCacheScope(req.query.scope);
    const provider = cleanCacheProvider(req.query.provider);
    if (!provider) {
      return res.status(400).type("text").send("Provider invalide.");
    }

    let payload = null;
    if (scope === "commune") {
      const inseeCode = cleanInseeCode(req.query.insee_code);
      if (!inseeCode) {
        return res.status(400).type("text").send("Code INSEE invalide.");
      }
      payload = repositories.enrichments.adminCommunePayload(inseeCode, provider);
    } else if (scope === "department") {
      const deptCode = cleanDeptCode(req.query.dept_code);
      if (!deptCode) {
        return res.status(400).type("text").send("Code département invalide.");
      }
      payload = repositories.enrichments.adminDepartmentPayload(deptCode, provider);
    } else {
      const listingId = Number.parseInt(req.query.listing_id, 10);
      if (!Number.isFinite(listingId) || listingId < 1) {
        return res.status(400).type("text").send("Annonce invalide.");
      }
      payload = repositories.enrichments.adminListingPayload(listingId, provider);
    }

    if (!payload) {
      return res.status(404).type("text").send("Entrée introuvable.");
    }

    const jsonViewHtml =
      payload.data != null ? buildJsonViewHtml(payload.data) : "";
    const jsonClipboard =
      payload.data != null
        ? jsonForClipboard(payload.data).replace(/<\//g, "<\\/")
        : "";

    return res.render("partials/admin/enrichment-cache-modal", {
      layout: false,
      payload,
      jsonViewHtml,
      jsonClipboard,
    });
  });

  router.post("/admin/enrichment-cache/clear-all", async (req, res) => {
    const result = repositories.enrichments.clearAllCaches();
    logActivity(logger, req, "cache enrichissement entièrement vidé", result);

    const filters = readCacheBrowseFilters({
      cache_scope: req.body.cache_scope,
      cache_provider: req.body.cache_provider,
      cache_q: req.body.cache_q,
      cache_page: req.body.cache_page,
    });

    if (req.get("hx-request")) {
      return res.render("partials/admin/enrichment-cache-table", {
        layout: false,
        ...(await enrichmentCacheBrowseResults(filters)),
        cacheRevokeNotice: "Tous les caches enrichissement ont été vidés.",
        cacheStatsOob: repositories.enrichments.cacheStats(),
        providersOob: true,
      });
    }

    req.session.flash = {
      type: "success",
      message: "Cache enrichissement vidé.",
    };
    return redirectAdmin(res, "enrichment-cache");
  });

  router.post("/admin/enrichment-cache/revoke", async (req, res) => {
    const scope = cleanCacheScope(req.body.scope);
    const provider = cleanCacheProvider(req.body.provider);
    if (!provider) {
      if (req.get("hx-request")) {
        return res.status(400).type("text").send("Provider invalide.");
      }
      req.session.flash = { type: "error", message: "Provider invalide." };
      return redirectAdmin(res, "enrichment-cache");
    }

    if (scope === "commune") {
      const inseeCode = cleanInseeCode(req.body.insee_code);
      if (!inseeCode) {
        if (req.get("hx-request")) {
          return res.status(400).type("text").send("Code INSEE invalide.");
        }
        req.session.flash = { type: "error", message: "Code INSEE invalide." };
        return redirectAdmin(res, "enrichment-cache");
      }
      const result = repositories.enrichments.revokeCommune(inseeCode, provider);
      logActivity(logger, req, "cache enrichissement révoqué (commune)", {
        inseeCode,
        provider,
        ...result,
      });
    } else if (scope === "department") {
      const deptCode = cleanDeptCode(req.body.dept_code);
      if (!deptCode) {
        if (req.get("hx-request")) {
          return res.status(400).type("text").send("Code département invalide.");
        }
        req.session.flash = { type: "error", message: "Code département invalide." };
        return redirectAdmin(res, "enrichment-cache");
      }
      const result = repositories.enrichments.revokeDepartment(deptCode, provider);
      logActivity(logger, req, "cache enrichissement révoqué (département)", {
        deptCode,
        provider,
        ...result,
      });
    } else {
      const listingId = Number.parseInt(req.body.listing_id, 10);
      if (!Number.isFinite(listingId) || listingId < 1) {
        if (req.get("hx-request")) {
          return res.status(400).type("text").send("Annonce invalide.");
        }
        req.session.flash = { type: "error", message: "Annonce invalide." };
        return redirectAdmin(res, "enrichment-cache");
      }
      repositories.enrichments.revokeListing(listingId, provider);
      logActivity(logger, req, "cache enrichissement révoqué (annonce)", {
        listingId,
        provider,
      });
    }

    const filters = readCacheBrowseFilters({
      cache_scope: req.body.cache_scope,
      cache_provider: req.body.cache_provider,
      cache_q: req.body.cache_q,
      cache_page: req.body.cache_page,
    });

    if (req.get("hx-request")) {
      return res.render("partials/admin/enrichment-cache-table", {
        layout: false,
        ...(await enrichmentCacheBrowseResults(filters)),
        cacheRevokeNotice: "Entrée révoquée.",
        providersOob: true,
      });
    }

    req.session.flash = {
      type: "success",
      message: "Entrée de cache révoquée.",
    };
    return redirectAdmin(res, "enrichment-cache");
  });

  router.post("/admin/hexasmal/import", (req, res) => {
    const file = req.file;
    const result = hexasmalImport.importBuffer(file?.buffer);
    if (result.ok) {
      logActivity(logger, req, "import HexaSmal terminé", {
        rowCount: result.rowCount,
      });
    }
    const view = hexasmalStatusView({
      hexasmalImportError: result.error || null,
      hexasmalImportNotice: result.ok
        ? `${result.rowCount.toLocaleString("fr-FR")} associations code postal / INSEE enregistrées.`
        : null,
    });
    if (req.get("hx-request")) {
      return res.render("partials/admin/hexasmal-import-status", {
        layout: false,
        ...view,
      });
    }
    req.session.flash = result.error
      ? { type: "error", message: result.error }
      : {
          type: "success",
          message: view.hexasmalImportNotice,
        };
    return redirectAdmin(res, "hexasmal");
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
    return redirectAdmin(res, "dpe");
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
    return redirectAdmin(res, "dpe");
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
      adminEmails: config.adminEmails,
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
          adminEmails: config.adminEmails,
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
          adminEmails: config.adminEmails,
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
      return redirectAdmin(res, "users");
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
      return redirectAdmin(res, "users");
    }

    if (user.id === req.user.id) {
      const message = "Vous ne pouvez pas supprimer votre propre compte.";
      if (req.get("hx-request")) {
        return renderUsersTable(res, filters, { listError: message });
      }
      req.session.flash = { type: "error", message };
      return redirectAdmin(res, "users");
    }

    if (isAdmin(user)) {
      const message = "Le compte administrateur ne peut pas être supprimé.";
      if (req.get("hx-request")) {
        return renderUsersTable(res, filters, { listError: message });
      }
      req.session.flash = { type: "error", message };
      return redirectAdmin(res, "users");
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
    return redirectAdmin(res, "users");
  });

  /* ----------------------- Infos adresse (marché) ---------------------- */

  router.get("/admin/adresse", (req, res) => {
    res.render("admin/address-insight", {
      title: "Administration — Infos adresse",
      adminSection: "address-insight",
      styles: ["/public/css/address-insight.css"],
      scripts: ["/public/js/address-insight.js"],
      ...adminSidebarLocals(),
      dvfAvailable: repositories.dvf.hasData(),
    });
  });

  /** Autocomplétion d'adresse (proxy BAN), limitée aux administrateurs. */
  router.get("/admin/adresse/autocomplete", async (req, res, next) => {
    try {
      const suggestions = await addressInsight.suggest(req.query.q, {
        limit: 6,
      });
      return res.json({ suggestions });
    } catch (err) {
      return next(err);
    }
  });

  /** Analyse d'une adresse : prix m², évolution, ventes, DPE. */
  router.post(
    "/admin/adresse",
    express.json({ limit: "16kb" }),
    async (req, res, next) => {
      const address = String(req.body?.address || "").trim();
      if (address.length < 3 || address.length > 240) {
        return res.status(422).json({ error: "Adresse invalide." });
      }
      try {
        const result = await addressInsight.analyze(address);
        logActivity(logger, req, "analyse d'adresse (admin)", {
          status: result.status,
        });
        return res.json(result);
      } catch (err) {
        return next(err);
      }
    }
  );

  /* ------------------------ Tableau d'amortissement -------------------- */

  router.get("/admin/amortissement", (req, res) => {
    const rates = financingRatesSnapshot();
    res.render("admin/amortization", {
      title: "Administration — Tableau d'amortissement",
      adminSection: "amortization",
      styles: ["/public/css/amortization.css"],
      scripts: ["/public/js/calendar-picker.js", "/public/js/amortization.js"],
      ...adminSidebarLocals(),
      amortDefaults: {
        interestRate: rates.interestRate,
        insuranceRate: rates.insuranceRate,
        years: rates.years,
      },
    });
  });

  /** Calcule le tableau d'amortissement (différé partiel optionnel). */
  router.post(
    "/admin/amortissement",
    express.json({ limit: "16kb" }),
    (req, res) => {
      const body = req.body || {};
      const result = buildAmortization({
        amount: Number(body.amount),
        years: Number(body.years),
        interestRate: Number(body.interestRate),
        insuranceRate: Number(body.insuranceRate),
        deferredMonths: Number(body.deferredMonths),
        startDate: body.startDate,
      });
      return res.json(result);
    }
  );

  return router;
}
