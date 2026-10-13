/**
 * Jours du calendrier d'import DPE : terminé (données complètes) vs incomplet.
 */

/** @typedef {{ day: string, row_count: number, job_status: string|null, day_rows_total: number|null, day_rows_done: number|null, rows_imported: number|null }} ImportDaySummary */

/**
 * @param {ImportDaySummary} row
 * @returns {"complete" | "partial" | "none"}
 */
export function classifyImportDay(row) {
  const rowCount = Number(row.row_count) || 0;
  const status = row.job_status || null;
  const expected = Number(row.day_rows_total) || 0;
  const rowsImported = Number(row.rows_imported) || 0;

  if (status === "running" || status === "pending") {
    return "partial";
  }

  if (status === "done") {
    if (expected > 0) {
      return rowCount >= expected ? "complete" : "partial";
    }
    if (rowsImported > 0) {
      return rowCount >= rowsImported ? "complete" : "partial";
    }
    return "complete";
  }

  if (status === "error") {
    if (rowCount > 0) return "partial";
    if (expected > 0 && (Number(row.day_rows_done) || 0) < expected) return "partial";
    return "none";
  }

  if (rowCount > 0) return "partial";

  return "none";
}

/**
 * @param {ImportDaySummary[]} rows
 * @returns {{ complete: string[], partial: string[] }}
 */
export function splitImportCalendarDays(rows) {
  const complete = [];
  const partial = [];
  for (const row of rows) {
    if (!row?.day) continue;
    const kind = classifyImportDay(row);
    if (kind === "complete") complete.push(row.day);
    else if (kind === "partial") partial.push(row.day);
  }
  return { complete, partial };
}
