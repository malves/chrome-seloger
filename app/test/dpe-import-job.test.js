import test from "node:test";
import assert from "node:assert/strict";
import {
  STALE_QUIET_MS,
  STALE_ACTIVE_MS,
  isJobStale,
  shouldAutoReconcileStale,
  buildJobView,
  buildImportDashboard,
  jobProgressPercent,
} from "../src/lib/dpe-import-job.js";

function job(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: 1,
    status: "running",
    date_from: "2026-09-04",
    date_to: "2026-09-04",
    current_day: "2026-09-04",
    days_total: 1,
    days_done: 0,
    day_rows_total: 0,
    day_rows_done: 0,
    rows_imported: 0,
    updated_at: now,
    created_at: now,
    ...overrides,
  };
}

test("un job sans aucune ligne devient stale après STALE_QUIET_MS", () => {
  const old = new Date(Date.now() - STALE_QUIET_MS - 1000).toISOString();
  assert.equal(isJobStale(job({ updated_at: old })), true);
  assert.equal(shouldAutoReconcileStale(job({ updated_at: old })), true);
});

test("un job actif avec progression utilise STALE_ACTIVE_MS", () => {
  const recent = new Date(Date.now() - STALE_QUIET_MS - 1000).toISOString();
  const active = job({
    updated_at: recent,
    day_rows_total: 9000,
    day_rows_done: 4000,
    rows_imported: 4000,
  });
  assert.equal(isJobStale(active), false);

  const old = new Date(Date.now() - STALE_ACTIVE_MS - 1000).toISOString();
  assert.equal(isJobStale(active, Date.now()), false);
  assert.equal(isJobStale({ ...active, updated_at: old }), true);
});

test("buildJobView signale blocage et désactive l'animation", () => {
  const old = new Date(Date.now() - STALE_QUIET_MS - 5000).toISOString();
  const view = buildJobView(job({ updated_at: old }));
  assert.equal(view.stale, true);
  assert.equal(view.animateProgress, false);
  assert.equal(view.blockNewImport, false);
  assert.equal(view.showCancel, true);
  assert.equal(view.showCurrentPanel, true);
  assert.match(view.staleMessage, /interrompu|Aucune donnée/);

  const failed = buildJobView(
    job({ status: "error", error: "timeout", updated_at: old })
  );
  assert.equal(failed.showCurrentPanel, false);
  assert.equal(failed.showRetry, true);
});

test("buildImportDashboard agrège plusieurs workers actifs", () => {
  const dash = buildImportDashboard([
    job({ id: 1, date_from: "2026-09-04", date_to: "2026-09-04" }),
    job({ id: 2, date_from: "2026-09-05", date_to: "2026-09-05" }),
  ]);
  assert.equal(dash.activeJobViews.length, 2);
  assert.equal(dash.poll, true);
  assert.equal(dash.blockNewImport, true);
  assert.equal(dash.showActivePanel, true);
});

test("jobProgressPercent inclut la fraction du jour en cours", () => {
  const pct = jobProgressPercent(
    job({
      days_total: 2,
      days_done: 1,
      day_rows_total: 100,
      day_rows_done: 50,
    })
  );
  assert.equal(pct, 75);
});
