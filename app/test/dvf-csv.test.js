import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseDvfCsvLine,
  dvfHeaderIndex,
  parseDvfRow,
  buildMutation,
} from "../src/lib/dvf-csv.js";

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));

/** Charge le fixture 2023 et regroupe les lignes par id_mutation. */
function loadGroups(file) {
  const lines = fs
    .readFileSync(path.join(fixturesDir, file), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const header = dvfHeaderIndex(parseDvfCsvLine(lines[0]));
  const groups = new Map();
  for (const line of lines.slice(1)) {
    const row = parseDvfRow(parseDvfCsvLine(line), header);
    if (!row) continue;
    if (!groups.has(row.id_mutation)) groups.set(row.id_mutation, []);
    groups.get(row.id_mutation).push(row);
  }
  return groups;
}

test("buildMutation retient une maison vendue seule", () => {
  const groups = loadGroups("fixtures/dvf-2023-sample.csv");
  const m = buildMutation(groups.get("2023-1"));
  assert.ok(m);
  assert.equal(m.type_local, "house");
  assert.equal(m.insee_code, "33063");
  assert.equal(m.dept_code, "33");
  assert.equal(m.year, 2023);
  assert.equal(m.price, 300000);
  assert.equal(m.surface, 100);
  assert.equal(m.price_per_m2, 3000);
  assert.match(m.mutation_date, /^\d{4}-\d{2}-\d{2}$/);
});

test("buildMutation ignore une mutation multi-biens (maison + appartement)", () => {
  const groups = loadGroups("fixtures/dvf-2023-sample.csv");
  assert.equal(buildMutation(groups.get("2023-3")), null);
});

test("buildMutation ignore les natures hors vente", () => {
  const groups = loadGroups("fixtures/dvf-2023-sample.csv");
  assert.equal(buildMutation(groups.get("2023-4")), null);
});

test("buildMutation écarte les prix au m² aberrants", () => {
  const groups = loadGroups("fixtures/dvf-2023-sample.csv");
  assert.equal(buildMutation(groups.get("2023-5")), null);
});

test("buildMutation tolère une dépendance accompagnant la maison", () => {
  const groups = loadGroups("fixtures/dvf-2023-sample.csv");
  const m = buildMutation(groups.get("2023-6"));
  assert.ok(m);
  assert.equal(m.type_local, "house");
  assert.equal(m.price_per_m2, 3125);
});
