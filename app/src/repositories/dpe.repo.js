/**
 * Accès à la base DPE open data (ADEME) et au suivi des imports.
 *
 * `dpe_records` : une ligne par DPE, identifiée par `numero_dpe`. On conserve
 * des colonnes clés typées (recherche/affichage) et la ligne brute complète en
 * JSON. `dpe_import_jobs` : suivi de l'import en cours (progression).
 */

import { nowIso } from "../lib/time.js";
import { fromJson, toJson } from "../lib/json.js";

/** Colonnes clés extraites de chaque ligne pour la recherche et l'affichage. */
const KEY_COLUMNS = [
  "numero_dpe",
  "date_etablissement_dpe",
  "date_derniere_modification_dpe",
  "etiquette_dpe",
  "etiquette_ges",
  "type_batiment",
  "annee_construction",
  "surface_habitable_logement",
  "adresse_ban",
  "adresse_brut",
  "nom_commune_ban",
  "code_postal_ban",
  "code_insee_ban",
  "code_departement_ban",
];

/** Étiquettes DPE/GES acceptées comme filtre (aucune valeur libre vers le SQL). */
export const DPE_LABELS = ["A", "B", "C", "D", "E", "F", "G"];

/** Types de bâtiment ADEME utilisables comme filtre de recherche admin. */
export const DPE_BUILDING_TYPES = [
  { value: "immeuble", label: "Immeuble" },
  { value: "appartement", label: "Appartement" },
  { value: "maison", label: "Maison" },
];

function hydrate(row) {
  if (!row) return null;
  return { ...row, raw: fromJson(row.raw, null) };
}

/**
 * Index secondaires retirés le temps d'un import massif, puis recréés.
 * Le nom et l'expression doivent rester identiques aux migrations : une
 * recherche `COLLATE NOCASE` n'utilise l'index commune que s'il est recréé tel quel.
 */
const SECONDARY_INDEXES = [
  {
    name: "idx_dpe_records_date",
    sql: "CREATE INDEX IF NOT EXISTS idx_dpe_records_date ON dpe_records(date_etablissement_dpe)",
  },
  {
    name: "idx_dpe_records_cp",
    sql: "CREATE INDEX IF NOT EXISTS idx_dpe_records_cp ON dpe_records(code_postal_ban)",
  },
  {
    name: "idx_dpe_records_insee",
    sql: "CREATE INDEX IF NOT EXISTS idx_dpe_records_insee ON dpe_records(code_insee_ban)",
  },
  {
    name: "idx_dpe_records_dept",
    sql: "CREATE INDEX IF NOT EXISTS idx_dpe_records_dept ON dpe_records(code_departement_ban)",
  },
  {
    name: "idx_dpe_records_commune",
    sql: "CREATE INDEX IF NOT EXISTS idx_dpe_records_commune ON dpe_records(nom_commune_ban COLLATE NOCASE)",
  },
  {
    name: "idx_dpe_records_etiquette",
    sql: "CREATE INDEX IF NOT EXISTS idx_dpe_records_etiquette ON dpe_records(etiquette_dpe)",
  },
  {
    name: "idx_dpe_records_date_mod",
    sql: "CREATE INDEX IF NOT EXISTS idx_dpe_records_date_mod ON dpe_records(date_derniere_modification_dpe)",
  },
  {
    name: "idx_dpe_records_date_mod_numero",
    sql: "CREATE INDEX IF NOT EXISTS idx_dpe_records_date_mod_numero ON dpe_records(date_derniere_modification_dpe, numero_dpe)",
  },
];

/** Transforme une ligne de l'API en jeu de valeurs pour l'upsert. */
function toRecordValues(line, importedAt) {
  const values = { raw: toJson(line), imported_at: importedAt };
  for (const column of KEY_COLUMNS) {
    const value = line[column];
    values[column] = value === undefined ? null : value;
  }
  return values;
}

export default function createDpeRepository(db) {
  const upsertSql = `INSERT INTO dpe_records (
      ${KEY_COLUMNS.join(", ")}, raw, imported_at
    ) VALUES (
      ${KEY_COLUMNS.map((c) => `@${c}`).join(", ")}, @raw, @imported_at
    )
    ON CONFLICT(numero_dpe) DO UPDATE SET
      ${KEY_COLUMNS.filter((c) => c !== "numero_dpe")
        .map((c) => `${c} = excluded.${c}`)
        .join(",\n      ")},
      raw = excluded.raw,
      imported_at = excluded.imported_at`;

  const statements = {
    upsert: db.prepare(upsertSql),
    count: db.prepare("SELECT COUNT(*) AS n FROM dpe_records"),
    byNumero: db.prepare("SELECT * FROM dpe_records WHERE numero_dpe = ?"),

    insertJob: db.prepare(
      `INSERT INTO dpe_import_jobs
         (date_from, date_to, status, days_total, created_at, updated_at)
       VALUES (@date_from, @date_to, @status, @days_total, @created_at, @updated_at)`
    ),
    latestJob: db.prepare(
      "SELECT * FROM dpe_import_jobs ORDER BY id DESC LIMIT 1"
    ),
    recentJobs: db.prepare(
      "SELECT * FROM dpe_import_jobs ORDER BY id DESC LIMIT ?"
    ),
    jobById: db.prepare("SELECT * FROM dpe_import_jobs WHERE id = ?"),
    runningJob: db.prepare(
      "SELECT * FROM dpe_import_jobs WHERE status IN ('pending', 'running') ORDER BY id DESC LIMIT 1"
    ),
    runningJobs: db.prepare(
      "SELECT * FROM dpe_import_jobs WHERE status IN ('pending', 'running') ORDER BY date_from ASC, id ASC"
    ),
    deleteByModificationDay: db.prepare(
      "DELETE FROM dpe_records WHERE date_derniere_modification_dpe = ?"
    ),
    deleteByModificationDayBatch: db.prepare(
      `DELETE FROM dpe_records WHERE rowid IN (
         SELECT rowid FROM dpe_records
         WHERE date_derniere_modification_dpe = ? LIMIT ?
       )`
    ),
    /** Jours (YYYY-MM-DD) déjà importés au moins une fois (jobs terminés ou données en base). */
    importedDays: db.prepare(
      `SELECT day FROM (
         SELECT date_from AS day FROM dpe_import_jobs
           WHERE status = 'done' AND date_from IS NOT NULL
         UNION
         SELECT DISTINCT date_derniere_modification_dpe AS day FROM dpe_records
           WHERE date_derniere_modification_dpe IS NOT NULL
       )
       ORDER BY day`
    ),
  };

  /** Upsert d'un lot de lignes dans une seule transaction. */
  const upsertMany = db.transaction((lines) => {
    const importedAt = nowIso();
    let n = 0;
    for (const line of lines) {
      if (!line || !line.numero_dpe) continue;
      statements.upsert.run(toRecordValues(line, importedAt));
      n += 1;
    }
    return n;
  });

  function indexNames() {
    return new Set(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'dpe_records'"
        )
        .all()
        .map((row) => row.name)
    );
  }

  /** Recrée les index manquants (fin d'import massif, ou redémarrage après un plantage). */
  function ensureSecondaryIndexes() {
    const existing = indexNames();
    for (const index of SECONDARY_INDEXES) {
      if (!existing.has(index.name)) db.exec(index.sql);
    }
  }

  /**
   * Imports massifs en cours sur cette connexion. Les index ne sont retirés
   * qu'une fois, puis recréés quand le dernier import massif se termine.
   */
  let bulkDepth = 0;
  let savedPragmas = null;

  function beginBulkLoad() {
    bulkDepth += 1;
    if (bulkDepth > 1) return;
    savedPragmas = {
      synchronous: db.pragma("synchronous", { simple: true }),
      cache_size: db.pragma("cache_size", { simple: true }),
      temp_store: db.pragma("temp_store", { simple: true }),
      wal_autocheckpoint: db.pragma("wal_autocheckpoint", { simple: true }),
    };
    // NORMAL en mode WAL évite un fsync à chaque lot, sans perdre la base
    // en cas de crash applicatif.
    db.pragma("synchronous = NORMAL");
    db.pragma("cache_size = -524288");
    db.pragma("temp_store = MEMORY");
    db.pragma("wal_autocheckpoint = 20000");
    for (const index of SECONDARY_INDEXES) {
      db.exec(`DROP INDEX IF EXISTS ${index.name}`);
    }
  }

  function endBulkLoad() {
    if (bulkDepth === 0) return;
    bulkDepth -= 1;
    if (bulkDepth > 0) return;
    try {
      ensureSecondaryIndexes();
    } finally {
      const saved = savedPragmas;
      savedPragmas = null;
      if (!saved) return;
      db.pragma(`synchronous = ${Number(saved.synchronous)}`);
      db.pragma(`cache_size = ${Number(saved.cache_size)}`);
      db.pragma(`temp_store = ${Number(saved.temp_store)}`);
      db.pragma(`wal_autocheckpoint = ${Number(saved.wal_autocheckpoint)}`);
    }
  }

  ensureSecondaryIndexes();

  return {
    upsertMany,

    /** Supprime toutes les lignes dont la date de dernière modification DPE est ce jour. */
    deleteByModificationDay(day) {
      return statements.deleteByModificationDay.run(day).changes;
    },

    /**
     * Supprime au plus `limit` lignes de ce jour. Permet de découper un
     * ré-import de plusieurs millions de lignes sans bloquer le process
     * d'une traite.
     */
    deleteByModificationDayBatch(day, limit) {
      return statements.deleteByModificationDayBatch.run(day, limit).changes;
    },

    /**
     * Prépare une écriture massive : index secondaires retirés, fsync relâchés.
     * À apparier avec `endBulkLoad`, y compris en cas d'erreur.
     */
    beginBulkLoad,
    endBulkLoad,

    count() {
      return statements.count.get().n;
    },

    listImportedDays() {
      return statements.importedDays.all().map((row) => row.day);
    },

    findByNumero(numeroDpe) {
      return hydrate(statements.byNumero.get(numeroDpe));
    },

    /**
     * Recherche filtrée et paginée. Les fragments SQL proviennent uniquement de
     * constantes ; seules les valeurs passent par des paramètres liés.
     *
     * Filtres : `codePostal`, `commune`, `typeBatiment`, `etiquette` (DPE),
     * `etiquetteGes`, `surfaceMin`, `surfaceMax` (m²), `anneeMin`, `anneeMax`,
     * `dateModif` (YYYY-MM-DD, égalité sur `date_derniere_modification_dpe`, indexée).
     */
    search(filters = {}) {
      const { where, params } = buildSearchClause(filters);
      const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";

      const orderBy = filters.dateModif
        ? "numero_dpe DESC"
        : "date_derniere_modification_dpe DESC, numero_dpe DESC";

      let sql = `SELECT * FROM dpe_records${whereSql}
        ORDER BY ${orderBy}`;

      if (Number.isFinite(filters.limit)) {
        sql += " LIMIT @limit";
        params.limit = Math.max(0, Math.trunc(filters.limit));
        if (Number.isFinite(filters.offset)) {
          sql += " OFFSET @offset";
          params.offset = Math.max(0, Math.trunc(filters.offset));
        }
      }

      return db.prepare(sql).all(params).map(hydrate);
    },

    countSearch(filters = {}) {
      const { where, params } = buildSearchClause(filters);
      const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
      return db.prepare(`SELECT COUNT(*) AS n FROM dpe_records${whereSql}`).get(params).n;
    },

    /**
     * Recherche pour déterminer l'adresse d'une annonce.
     *
     * Filtres stricts : code postal **ou** département (`code_departement_ban`),
     * type(s) de bâtiment et fenêtre de surface ±marge.
     * conservés même hors fenêtre de surface : ils serviront de repli et seront
     * simplement moins bien notés. Renvoie des lignes hydratées (avec `raw`)
     * pour que le service lise les champs additionnels (étage, complément…).
     */
    searchAddressCandidates({
      codePostal,
      departement,
      typeBatiments,
      surfaceMin,
      surfaceMax,
      limit = 500,
    } = {}) {
      const types = Array.isArray(typeBatiments)
        ? typeBatiments.filter((t) => DPE_BUILDING_TYPES.some((b) => b.value === t))
        : [];
      if (!types.length) return [];

      const where = [];
      const params = {};

      if (codePostal) {
        where.push("code_postal_ban = @code_postal");
        params.code_postal = String(codePostal);
      } else if (departement) {
        where.push("code_departement_ban = @departement");
        params.departement = String(departement);
      } else {
        return [];
      }

      const typeKeys = types.map((t, i) => {
        params[`type_${i}`] = t;
        return `@type_${i}`;
      });
      where.push(`type_batiment IN (${typeKeys.join(", ")})`);

      if (surfaceMin != null && surfaceMax != null) {
        const surfaceClause =
          "surface_habitable_logement BETWEEN @surface_min AND @surface_max";
        if (types.includes("immeuble")) {
          where.push(`(${surfaceClause} OR type_batiment = 'immeuble')`);
        } else {
          where.push(surfaceClause);
        }
        params.surface_min = surfaceMin;
        params.surface_max = surfaceMax;
      }

      params.limit = Math.max(1, Math.trunc(limit));

      const sql = `SELECT * FROM dpe_records
        WHERE ${where.join(" AND ")}
        ORDER BY date_derniere_modification_dpe DESC, numero_dpe DESC
        LIMIT @limit`;

      return db.prepare(sql).all(params).map(hydrate);
    },

    /* --------------------------- Jobs d'import --------------------------- */

    createJob({ dateFrom, dateTo, daysTotal }) {
      const at = nowIso();
      const info = statements.insertJob.run({
        date_from: dateFrom,
        date_to: dateTo,
        status: "pending",
        days_total: daysTotal,
        created_at: at,
        updated_at: at,
      });
      return Number(info.lastInsertRowid);
    },

    /** Met à jour la progression d'un job (champs partiels autorisés). */
    updateJob(id, fields = {}) {
      const allowed = [
        "status",
        "current_day",
        "days_total",
        "days_done",
        "rows_imported",
        "day_rows_total",
        "day_rows_done",
        "error",
      ];
      const sets = [];
      const params = { id, updated_at: nowIso() };
      for (const key of allowed) {
        if (key in fields) {
          sets.push(`${key} = @${key}`);
          params[key] = fields[key];
        }
      }
      if (!sets.length) return;
      sets.push("updated_at = @updated_at");
      db.prepare(`UPDATE dpe_import_jobs SET ${sets.join(", ")} WHERE id = @id`).run(
        params
      );
    },

    getJob(id) {
      return statements.jobById.get(id) || null;
    },

    getLatestJob() {
      return statements.latestJob.get() || null;
    },

    listRecentJobs(limit = 10) {
      return statements.recentJobs.all(Math.max(1, Math.trunc(limit)));
    },

    getRunningJob() {
      return statements.runningJob.get() || null;
    },

    listRunningJobs() {
      return statements.runningJobs.all();
    },

    /** Jours (YYYY-MM-DD) déjà couverts par un import pending ou running. */
    runningDays() {
      const days = new Set();
      for (const job of statements.runningJobs.all()) {
        if (job.date_from === job.date_to) {
          days.add(job.date_from);
          continue;
        }
        const from = job.date_from;
        const to = job.date_to;
        if (!from || !to || from > to) continue;
        const current = new Date(`${from}T00:00:00Z`);
        const last = new Date(`${to}T00:00:00Z`);
        while (current.getTime() <= last.getTime()) {
          days.add(current.toISOString().slice(0, 10));
          current.setUTCDate(current.getUTCDate() + 1);
        }
      }
      return days;
    },
  };

  function buildSearchClause(filters) {
    const where = [];
    const params = {};

    if (filters.codePostal) {
      where.push("code_postal_ban = @code_postal");
      params.code_postal = filters.codePostal;
    }
    if (filters.commune) {
      where.push("nom_commune_ban = @commune COLLATE NOCASE");
      params.commune = filters.commune;
    }
    if (filters.typeBatiment) {
      where.push("type_batiment = @type_batiment");
      params.type_batiment = filters.typeBatiment;
    }
    if (filters.etiquette) {
      where.push("etiquette_dpe = @etiquette");
      params.etiquette = filters.etiquette;
    }
    if (filters.etiquetteGes) {
      where.push("etiquette_ges = @etiquette_ges");
      params.etiquette_ges = filters.etiquetteGes;
    }
    if (filters.surfaceMin != null) {
      where.push("surface_habitable_logement >= @surface_min");
      params.surface_min = filters.surfaceMin;
    }
    if (filters.surfaceMax != null) {
      where.push("surface_habitable_logement <= @surface_max");
      params.surface_max = filters.surfaceMax;
    }
    if (filters.anneeMin != null) {
      where.push("annee_construction >= @annee_min");
      params.annee_min = filters.anneeMin;
    }
    if (filters.anneeMax != null) {
      where.push("annee_construction <= @annee_max");
      params.annee_max = filters.anneeMax;
    }
    if (filters.dateModif) {
      where.push("date_derniere_modification_dpe = @date_modif");
      params.date_modif = filters.dateModif;
    }

    return { where, params };
  }
}
