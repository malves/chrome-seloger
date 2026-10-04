/**
 * Accès à la base SSMSI importée (commune + département).
 */

import { nowIso } from "../lib/time.js";
import { SSMSI_INDICATOR_LIST, SSMSI_EXPECTED_COMMUNE_ROWS } from "../lib/ssmsi-csv.js";

const INDICATOR_KEYS = SSMSI_INDICATOR_LIST.map((item) => item.key);

export default function createSsmsiRepository(db) {
  const statements = {
    clearCommune: db.prepare("DELETE FROM ssmsi_commune"),
    clearDepartment: db.prepare("DELETE FROM ssmsi_department"),
    clearNational: db.prepare("DELETE FROM ssmsi_national"),
    insertCommune: db.prepare(
      `INSERT INTO ssmsi_commune (insee_code, year, indicator, label, volume, rate_per_1000)
       VALUES (@insee_code, @year, @indicator, @label, @volume, @rate_per_1000)`
    ),
    insertDepartment: db.prepare(
      `INSERT INTO ssmsi_department (dept_code, year, indicator, label, volume, rate_per_1000)
       VALUES (@dept_code, @year, @indicator, @label, @volume, @rate_per_1000)`
    ),
    insertNational: db.prepare(
      `INSERT INTO ssmsi_national (year, indicator, label, volume, population, rate_per_1000)
       VALUES (@year, @indicator, @label, @volume, @population, @rate_per_1000)`
    ),
    countCommune: db.prepare("SELECT COUNT(*) AS n FROM ssmsi_commune"),
    countDepartment: db.prepare("SELECT COUNT(*) AS n FROM ssmsi_department"),
    countNational: db.prepare("SELECT COUNT(*) AS n FROM ssmsi_national"),
    countDistinctIndicators: db.prepare(
      "SELECT COUNT(DISTINCT indicator) AS n FROM ssmsi_commune"
    ),
    countDistinctNationalIndicators: db.prepare(
      "SELECT COUNT(DISTINCT indicator) AS n FROM ssmsi_national"
    ),
    nationalForYear: db.prepare(
      "SELECT indicator, label, rate_per_1000 FROM ssmsi_national WHERE year = ?"
    ),
    maxYearCommune: db.prepare(
      "SELECT MAX(year) AS y FROM ssmsi_commune WHERE insee_code = ?"
    ),
    communeRows: db.prepare(
      `SELECT year, indicator, label, volume, rate_per_1000
       FROM ssmsi_commune
       WHERE insee_code = ? AND indicator = ? AND year <= ?
       ORDER BY year DESC
       LIMIT ?`
    ),
    departmentRows: db.prepare(
      `SELECT year, indicator, label, volume, rate_per_1000
       FROM ssmsi_department
       WHERE dept_code = ? AND indicator = ? AND year <= ?
       ORDER BY year DESC
       LIMIT ?`
    ),
    createJob: db.prepare(
      `INSERT INTO ssmsi_import_jobs (status, source_label, source_url, rows_commune, rows_dep, error, created_at, updated_at)
       VALUES (@status, @source_label, @source_url, 0, 0, NULL, @created_at, @updated_at)`
    ),
    updateJob: db.prepare(
      `UPDATE ssmsi_import_jobs SET
         status = COALESCE(@status, status),
         rows_commune = COALESCE(@rows_commune, rows_commune),
         rows_dep = COALESCE(@rows_dep, rows_dep),
         error = @error,
         updated_at = @updated_at
       WHERE id = @id`
    ),
    getJob: db.prepare("SELECT * FROM ssmsi_import_jobs WHERE id = ?"),
    latestJob: db.prepare(
      "SELECT * FROM ssmsi_import_jobs ORDER BY created_at DESC LIMIT 1"
    ),
    runningJob: db.prepare(
      "SELECT * FROM ssmsi_import_jobs WHERE status = 'running' ORDER BY created_at DESC LIMIT 1"
    ),
  };

  const insertCommuneMany = db.transaction((rows) => {
    for (const row of rows) statements.insertCommune.run(row);
    return rows.length;
  });

  const insertDepartmentMany = db.transaction((rows) => {
    for (const row of rows) statements.insertDepartment.run(row);
    return rows.length;
  });

  const insertNationalMany = db.transaction((rows) => {
    for (const row of rows) statements.insertNational.run(row);
    return rows.length;
  });

  return {
    hasData() {
      return statements.countCommune.get().n > 0;
    },

    countCommuneRows() {
      return statements.countCommune.get().n;
    },

    countDepartmentRows() {
      return statements.countDepartment.get().n;
    },

    countDistinctIndicators() {
      return statements.countDistinctIndicators.get().n;
    },

    countDistinctNationalIndicators() {
      return statements.countDistinctNationalIndicators.get().n;
    },

    expectedIndicatorCount() {
      return INDICATOR_KEYS.length;
    },

    needsFullReimport() {
      if (!this.hasData()) return false;
      // Ancien import (5 indicateurs « biens » uniquement).
      if (this.countDistinctIndicators() <= 5) return true;
      return this.countDistinctNationalIndicators() < INDICATOR_KEYS.length;
    },

    clearCommune() {
      statements.clearCommune.run();
    },

    clearDepartment() {
      statements.clearDepartment.run();
    },

    clearNational() {
      statements.clearNational.run();
    },

    insertCommuneBatch(rows) {
      if (!rows.length) return 0;
      return insertCommuneMany(rows);
    },

    insertDepartmentBatch(rows) {
      if (!rows.length) return 0;
      return insertDepartmentMany(rows);
    },

    insertNationalBatch(rows) {
      if (!rows.length) return 0;
      return insertNationalMany(rows);
    },

    countNationalRows() {
      return statements.countNational.get().n;
    },

    /** Taux national (France) par indicateur pour une année : { key: rate }. */
    findNationalForYear(year) {
      const map = {};
      for (const row of statements.nationalForYear.all(year)) {
        map[row.indicator] = row.rate_per_1000;
      }
      return map;
    },

    maxYearForCommune(inseeCode) {
      return statements.maxYearCommune.get(inseeCode)?.y ?? null;
    },

    /**
     * Séries par indicateur pour une commune (années décroissantes, max `yearLimit` par indicateur).
     */
    findCommuneSeries(inseeCode, { yearLimit = null, yearsPerIndicator = 5 } = {}) {
      const capYear = yearLimit ?? new Date().getFullYear();
      const result = {};
      for (const key of INDICATOR_KEYS) {
        const rows = statements.communeRows.all(
          inseeCode,
          key,
          capYear,
          yearsPerIndicator
        );
        if (rows.length) result[key] = rows;
      }
      return result;
    },

    findDepartmentSeries(deptCode, { yearLimit = null, yearsPerIndicator = 1 } = {}) {
      const capYear = yearLimit ?? new Date().getFullYear();
      const result = {};
      for (const key of INDICATOR_KEYS) {
        const rows = statements.departmentRows.all(
          deptCode,
          key,
          capYear,
          yearsPerIndicator
        );
        if (rows.length) result[key] = rows[0];
      }
      return result;
    },

    createJob({ sourceLabel, sourceUrl }) {
      const at = nowIso();
      const info = statements.createJob.run({
        status: "pending",
        source_label: sourceLabel || null,
        source_url: sourceUrl || null,
        created_at: at,
        updated_at: at,
      });
      return info.lastInsertRowid;
    },

    updateJob(id, patch) {
      statements.updateJob.run({
        id,
        status: patch.status ?? null,
        rows_commune: patch.rows_commune ?? null,
        rows_dep: patch.rows_dep ?? null,
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

    importMeta() {
      const job = statements.latestJob.get();
      if (!job || job.status !== "done") return null;
      return {
        job_id: job.id,
        source_label: job.source_label,
        imported_at: job.updated_at,
        rows_commune: job.rows_commune,
        rows_dep: job.rows_dep,
        indicator_count: this.countDistinctIndicators(),
        indicator_expected: INDICATOR_KEYS.length,
        needs_reimport: this.needsFullReimport(),
      };
    },
  };
}
