import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyImportDay,
  splitImportCalendarDays,
} from "../src/lib/dpe-import-calendar.js";

test("classifyImportDay : terminé quand le job done couvre le total ADEME", () => {
  assert.equal(
    classifyImportDay({
      day: "2026-06-23",
      row_count: 20923,
      job_status: "done",
      day_rows_total: 20923,
      day_rows_done: 20923,
      rows_imported: 20923,
    }),
    "complete"
  );
});

test("classifyImportDay : partiel si données en base sans assez de lignes", () => {
  assert.equal(
    classifyImportDay({
      day: "2025-12-18",
      row_count: 5_980_001,
      job_status: "error",
      day_rows_total: 10_815_006,
      day_rows_done: 0,
      rows_imported: 0,
    }),
    "partial"
  );
});

test("classifyImportDay : partiel si job done mais base vide (données obsolètes)", () => {
  assert.equal(
    classifyImportDay({
      day: "2026-09-02",
      row_count: 0,
      job_status: "done",
      day_rows_total: 9429,
      day_rows_done: 9429,
      rows_imported: 9429,
    }),
    "partial"
  );
});

test("classifyImportDay : en cours compte comme incomplet", () => {
  assert.equal(
    classifyImportDay({
      day: "2026-06-25",
      row_count: 14000,
      job_status: "running",
      day_rows_total: 21739,
      day_rows_done: 14000,
      rows_imported: 14000,
    }),
    "partial"
  );
});

test("splitImportCalendarDays répartit les jours", () => {
  const out = splitImportCalendarDays([
    {
      day: "2026-06-23",
      row_count: 100,
      job_status: "done",
      day_rows_total: 100,
      day_rows_done: 100,
      rows_imported: 100,
    },
    {
      day: "2025-12-18",
      row_count: 50,
      job_status: "error",
      day_rows_total: 100,
      day_rows_done: 50,
      rows_imported: 50,
    },
  ]);
  assert.deepEqual(out.complete, ["2026-06-23"]);
  assert.deepEqual(out.partial, ["2025-12-18"]);
});
