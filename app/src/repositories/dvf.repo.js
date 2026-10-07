/**
 * Accès à la base DVF importée : mutations géolocalisées, statistiques
 * communales précalculées et suivi des jobs d'import.
 */

import { nowIso } from "../lib/time.js";
import { median } from "../lib/dvf-stats.js";

/** Taille des lots d'insertion des statistiques communales / départementales. */
const STATS_BATCH = 500;

/**
 * Médiane en flux : parcourt un itérateur déjà trié par les clés de groupe,
 * accumule les prix, puis renvoie une ligne agrégée par groupe. Aucune
 * écriture SQLite ici — better-sqlite3 interdit d'écrire tant qu'un
 * itérateur de lecture est ouvert sur la même connexion.
 */
function aggregateMedianGroups(iterator, sameGroup, toRow) {
  const aggregated = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    aggregated.push(toRow(current));
  };

  for (const row of iterator) {
    if (!current || !sameGroup(current, row)) {
      flush();
      current = { ...row, values: [] };
    }
    current.values.push(row.price_per_m2);
  }
  flush();
  return aggregated;
}

function insertInBatches(insertMany, rows, onProgress) {
  let total = 0;
  for (let i = 0; i < rows.length; i += STATS_BATCH) {
    total += insertMany(rows.slice(i, STATS_BATCH + i));
    if (onProgress) onProgress(total, rows.length);
  }
  return total;
}

export default function createDvfRepository(db) {
  const statements = {
    clearMutations: db.prepare("DELETE FROM dvf_mutation"),
    clearStats: db.prepare("DELETE FROM dvf_commune_stats"),
    clearDeptStats: db.prepare("DELETE FROM dvf_department_stats"),
    insertMutation: db.prepare(
      `INSERT INTO dvf_mutation
         (insee_code, dept_code, year, mutation_date, type_local, price, surface, price_per_m2, lat, lng)
       VALUES
         (@insee_code, @dept_code, @year, @mutation_date, @type_local, @price, @surface, @price_per_m2, @lat, @lng)`
    ),
    insertStat: db.prepare(
      `INSERT INTO dvf_commune_stats (insee_code, type_local, year, count, median_price_m2)
       VALUES (@insee_code, @type_local, @year, @count, @median_price_m2)
       ON CONFLICT(insee_code, type_local, year) DO UPDATE SET
         count = excluded.count,
         median_price_m2 = excluded.median_price_m2`
    ),
    insertDeptStat: db.prepare(
      `INSERT INTO dvf_department_stats (dept_code, type_local, year, count, median_price_m2)
       VALUES (@dept_code, @type_local, @year, @count, @median_price_m2)
       ON CONFLICT(dept_code, type_local, year) DO UPDATE SET
         count = excluded.count,
         median_price_m2 = excluded.median_price_m2`
    ),
    countMutations: db.prepare("SELECT COUNT(*) AS n FROM dvf_mutation"),
    countStats: db.prepare("SELECT COUNT(*) AS n FROM dvf_commune_stats"),
    countDeptStats: db.prepare("SELECT COUNT(*) AS n FROM dvf_department_stats"),
    // Parcours ordonné (insee, type, année, prix) pour médiane en flux.
    mutationsForStats: db.prepare(
      `SELECT insee_code, type_local, year, price_per_m2
       FROM dvf_mutation
       ORDER BY insee_code, type_local, year, price_per_m2`
    ),
    mutationsForDeptStats: db.prepare(
      `SELECT dept_code, type_local, year, price_per_m2
       FROM dvf_mutation
       WHERE dept_code IS NOT NULL AND dept_code != ''
       ORDER BY dept_code, type_local, year, price_per_m2`
    ),
    communeStats: db.prepare(
      `SELECT year, count, median_price_m2
       FROM dvf_commune_stats
       WHERE insee_code = ? AND type_local = ?
       ORDER BY year`
    ),
    departmentStats: db.prepare(
      `SELECT year, count, median_price_m2
       FROM dvf_department_stats
       WHERE dept_code = ? AND type_local = ?
       ORDER BY year`
    ),
    // Pré-filtre bbox : la distance exacte est affinée en JS côté provider.
    radiusBbox: db.prepare(
      `SELECT lat, lng, price, surface, price_per_m2, year, mutation_date, insee_code
       FROM dvf_mutation
       WHERE type_local = ?
         AND year >= ?
         AND lat BETWEEN ? AND ?
         AND lng BETWEEN ? AND ?`
    ),
    createJob: db.prepare(
      `INSERT INTO dvf_import_jobs
         (status, source_label, source_url, year_from, year_to, current_year, rows_imported, error, created_at, updated_at)
       VALUES
         (@status, @source_label, @source_url, @year_from, @year_to, NULL, 0, NULL, @created_at, @updated_at)`
    ),
    updateJob: db.prepare(
      `UPDATE dvf_import_jobs SET
         status = COALESCE(@status, status),
         current_year = @current_year,
         rows_imported = COALESCE(@rows_imported, rows_imported),
         error = @error,
         updated_at = @updated_at
       WHERE id = @id`
    ),
    getJob: db.prepare("SELECT * FROM dvf_import_jobs WHERE id = ?"),
    latestJob: db.prepare(
      "SELECT * FROM dvf_import_jobs ORDER BY created_at DESC LIMIT 1"
    ),
    runningJob: db.prepare(
      "SELECT * FROM dvf_import_jobs WHERE status IN ('running', 'pending') ORDER BY created_at DESC LIMIT 1"
    ),
    recentJobs: db.prepare(
      "SELECT * FROM dvf_import_jobs ORDER BY id DESC LIMIT ?"
    ),
  };

  const insertMutationMany = db.transaction((rows) => {
    for (const row of rows) statements.insertMutation.run(row);
    return rows.length;
  });

  const insertStatMany = db.transaction((rows) => {
    for (const row of rows) statements.insertStat.run(row);
    return rows.length;
  });

  const insertDeptStatMany = db.transaction((rows) => {
    for (const row of rows) statements.insertDeptStat.run(row);
    return rows.length;
  });

  function rebuildDepartmentStats({ onProgress } = {}) {
    statements.clearDeptStats.run();

    const aggregated = aggregateMedianGroups(
      statements.mutationsForDeptStats.iterate(),
      (current, row) =>
        current.dept_code === row.dept_code &&
        current.type_local === row.type_local &&
        current.year === row.year,
      (current) => ({
        dept_code: current.dept_code,
        type_local: current.type_local,
        year: current.year,
        count: current.values.length,
        median_price_m2: Math.round((median(current.values) || 0) * 100) / 100,
      })
    );

    return insertInBatches(insertDeptStatMany, aggregated, onProgress);
  }

  return {
    hasData() {
      return statements.countMutations.get().n > 0;
    },

    countMutations() {
      return statements.countMutations.get().n;
    },

    countStats() {
      return statements.countStats.get().n;
    },

    countDepartmentStats() {
      return statements.countDeptStats.get().n;
    },

    clearMutations() {
      statements.clearMutations.run();
    },

    clearStats() {
      statements.clearStats.run();
      statements.clearDeptStats.run();
    },

    insertMutationBatch(rows) {
      if (!rows.length) return 0;
      return insertMutationMany(rows);
    },

    /**
     * Recalcule `dvf_commune_stats` et `dvf_department_stats` à partir des
     * mutations. Deux parcours ordonnés (commune puis département) : médiane
     * groupe par groupe, écritures uniquement après épuisement de chaque
     * itérateur (contrainte better-sqlite3).
     */
    rebuildCommuneStats({ onProgress } = {}) {
      statements.clearStats.run();

      const aggregated = aggregateMedianGroups(
        statements.mutationsForStats.iterate(),
        (current, row) =>
          current.insee_code === row.insee_code &&
          current.type_local === row.type_local &&
          current.year === row.year,
        (current) => ({
          insee_code: current.insee_code,
          type_local: current.type_local,
          year: current.year,
          count: current.values.length,
          median_price_m2:
            Math.round((median(current.values) || 0) * 100) / 100,
        })
      );

      const total = insertInBatches(insertStatMany, aggregated, onProgress);
      rebuildDepartmentStats({ onProgress });
      return total;
    },

    rebuildDepartmentStats,

    /**
     * Base déjà importée avant la table départementale : on reconstruit les
     * stats départementales une fois, sans relancer l'import CSV.
     */
    ensureDepartmentStats() {
      if (statements.countDeptStats.get().n > 0) return 0;
      if (statements.countMutations.get().n === 0) return 0;
      return rebuildDepartmentStats();
    },

    /** Statistiques annuelles d'une commune pour un type de bien. */
    communeSeries(inseeCode, typeLocal) {
      if (!inseeCode || !typeLocal) return [];
      return statements.communeStats.all(inseeCode, typeLocal);
    },

    /** Statistiques annuelles d'un département pour un type de bien. */
    departmentSeries(deptCode, typeLocal) {
      if (!deptCode || !typeLocal) return [];
      return statements.departmentStats.all(deptCode, typeLocal);
    },

    /** Mutations d'un type dans une boîte englobante (pré-filtre du rayon). */
    radiusCandidates(typeLocal, bbox, { yearFrom = 0 } = {}) {
      if (!typeLocal || !bbox) return [];
      return statements.radiusBbox.all(
        typeLocal,
        yearFrom,
        bbox.minLat,
        bbox.maxLat,
        bbox.minLng,
        bbox.maxLng
      );
    },

    createJob({ sourceLabel, sourceUrl, yearFrom, yearTo }) {
      const at = nowIso();
      const info = statements.createJob.run({
        status: "pending",
        source_label: sourceLabel || null,
        source_url: sourceUrl || null,
        year_from: yearFrom ?? null,
        year_to: yearTo ?? null,
        created_at: at,
        updated_at: at,
      });
      return info.lastInsertRowid;
    },

    updateJob(id, patch) {
      statements.updateJob.run({
        id,
        status: patch.status ?? null,
        current_year:
          patch.current_year !== undefined ? patch.current_year : null,
        rows_imported: patch.rows_imported ?? null,
        error: patch.error !== undefined ? patch.error : null,
        updated_at: nowIso(),
      });
    },

    getJob(id) {
      return statements.getJob.get(id);
    },

    getLatestJob() {
      return statements.latestJob.get();
    },

    getRunningJob() {
      return statements.runningJob.get();
    },

    listRecentJobs(limit = 10) {
      return statements.recentJobs.all(Math.max(1, Math.trunc(limit)));
    },

    importMeta() {
      const job = statements.latestJob.get();
      if (!job || job.status !== "done") return null;
      return {
        job_id: job.id,
        source_label: job.source_label,
        imported_at: job.updated_at,
        year_from: job.year_from,
        year_to: job.year_to,
        rows_imported: job.rows_imported,
      };
    },
  };
}
