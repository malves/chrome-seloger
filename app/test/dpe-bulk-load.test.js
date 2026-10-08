import test from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "./helpers.js";
import createDpeOpendataService from "../src/services/dpe-opendata.service.js";
import {
  BULK_PAGE_SIZE,
  BULK_ROW_THRESHOLD,
  INDEX_REBUILD_THRESHOLD,
  pageSizeForTotal,
  shouldRebuildIndexes,
} from "../src/services/dpe-opendata.service.js";

function indexNames(db) {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'dpe_records'"
    )
    .all()
    .map((row) => row.name);
}

test("la taille de page bascule à 10 000 au-delà du seuil massif", () => {
  assert.equal(pageSizeForTotal(BULK_ROW_THRESHOLD - 1), 2000);
  assert.equal(pageSizeForTotal(BULK_ROW_THRESHOLD), BULK_PAGE_SIZE);
  assert.equal(pageSizeForTotal(10_839_089), BULK_PAGE_SIZE);
  assert.equal(shouldRebuildIndexes(INDEX_REBUILD_THRESHOLD - 1), false);
  assert.equal(shouldRebuildIndexes(10_839_089), true);
});

test("un import massif retire les index secondaires puis les recrée", () => {
  const { db, repositories, close } = createTestApp();
  try {
    const before = indexNames(db);
    assert.ok(before.includes("idx_dpe_records_cp"));
    assert.ok(before.includes("idx_dpe_records_date_mod"));

    repositories.dpe.beginBulkLoad();
    const during = indexNames(db);
    assert.equal(during.includes("idx_dpe_records_cp"), false);
    assert.equal(during.includes("idx_dpe_records_commune"), false);
    assert.equal(during.includes("idx_dpe_records_date_mod"), false);

    repositories.dpe.upsertMany([
      {
        numero_dpe: "DPE-BULK-1",
        date_derniere_modification_dpe: "2025-12-18",
        etiquette_dpe: "D",
        code_postal_ban: "75011",
        nom_commune_ban: "Paris",
      },
    ]);

    repositories.dpe.endBulkLoad();
    const after = indexNames(db);
    assert.ok(after.includes("idx_dpe_records_cp"));
    assert.ok(after.includes("idx_dpe_records_commune"));
    assert.ok(after.includes("idx_dpe_records_date_mod"));

    const found = repositories.dpe.search({ codePostal: "75011" });
    assert.equal(found.length, 1);
    assert.equal(found[0].numero_dpe, "DPE-BULK-1");

    const onDay = repositories.dpe.search({ dateModif: "2025-12-18" });
    assert.equal(onDay.length, 1);
    assert.equal(onDay[0].numero_dpe, "DPE-BULK-1");
    assert.equal(repositories.dpe.countSearch({ dateModif: "2025-12-18" }), 1);

    assert.equal(repositories.dpe.getLatestJob(), null);
  } finally {
    close();
  }
});

test("le ré-import par paquets n'efface que le jour demandé", () => {
  const { repositories, close } = createTestApp();
  try {
    repositories.dpe.upsertMany([
      { numero_dpe: "DPE-A", date_derniere_modification_dpe: "2025-12-18" },
      { numero_dpe: "DPE-B", date_derniere_modification_dpe: "2025-12-18" },
      { numero_dpe: "DPE-C", date_derniere_modification_dpe: "2026-01-15" },
    ]);

    const first = repositories.dpe.deleteByModificationDayBatch("2025-12-18", 1);
    assert.equal(first, 1);
    assert.equal(repositories.dpe.count(), 2);

    const second = repositories.dpe.deleteByModificationDayBatch("2025-12-18", 10);
    assert.equal(second, 1);
    assert.equal(repositories.dpe.findByNumero("DPE-C").numero_dpe, "DPE-C");
    assert.equal(repositories.dpe.deleteByModificationDayBatch("2025-12-18", 10), 0);
  } finally {
    close();
  }
});

test("startImportBlocking refuse des dates invalides", () => {
  const { repositories, close } = createTestApp();
  try {
    const dpe = createDpeOpendataService({ repositories, logger: null });
    const bad = dpe.startImportBlocking({
      dateFrom: "pas-une-date",
      dateTo: "2025-12-18",
    });
    assert.match(bad.error, /invalides/i);
    assert.equal(bad.run, undefined);
  } finally {
    close();
  }
});
